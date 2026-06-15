import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Body,
  Param,
  Res,
  UseGuards,
  Req,
  Query,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger'
import { Response } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { diskStorage } from 'multer'
import { RagService } from './rag.service'
import { JwtAuthGuard } from '../../common/guards/auth.guard'
import { AllowNoPerm } from '../../common/decorators/perm.decorator'
import { UserType } from '../../common/enums/common.enum'
import { ResultData } from '../../common/utils/result'

import { Keep } from '../../common/decorators/keep.decorator'
import * as yaml from 'js-yaml'

/**
 * 解析 app.file.location → 绝对路径
 * 必须在 @UseInterceptors 装饰器求值时可用，所以提到模块顶层懒加载。
 * 注意：ConfigService 还没初始化，只能直接读 yml 文件兜底，失败就用 ../upload
 */
function resolveUploadRoot(): string {
  try {
    const env = process.env.NODE_ENV || 'development'
    const cfgPath = path.join(process.cwd(), 'src', 'config', `${env}.yml`)
    if (fs.existsSync(cfgPath)) {
      const doc: any = yaml.load(fs.readFileSync(cfgPath, 'utf8'))
      const loc = doc?.app?.file?.location || '../upload'
      return path.isAbsolute(loc) ? loc : path.normalize(path.join(process.cwd(), loc))
    }
  } catch {
    /* fallthrough */
  }
  return path.normalize(path.join(process.cwd(), '../upload'))
}

const RAG_UPLOAD_DIR = path.join(resolveUploadRoot(), 'rag')
// 启动时确保目录存在
try {
  fs.mkdirSync(RAG_UPLOAD_DIR, { recursive: true })
} catch {
  /* ignore */
}

@ApiTags('企业级双轨制核心知识库 RAG')
@ApiBearerAuth()
@Controller('rag')
@UseGuards(JwtAuthGuard)
export class RagController {
  // 上传根目录用模块顶层 RAG_UPLOAD_DIR 常量（@UseInterceptors 装饰器先于构造函数求值，必须顶层可用）
  private readonly serveRoot: string
  private readonly fileDomain: string

  constructor(
    private readonly ragService: RagService,
    private readonly config: ConfigService,
  ) {
    this.serveRoot = this.config.get<string>('app.file.serveRoot') || ''
    this.fileDomain = this.config.get<string>('app.file.domain') || ''
  }

  // ============================================================================
  // 🔐 鉴权辅助：UserEntity.id 是 bigint（JS 端是 string），但 RAG 模块的 userId 字段是 int
  // 所有 controller 统一在这里转 Number()，避免在 service 层做 === 比较时 string vs number 永远不等
  // ============================================================================
  private resolveUserId(req: any): number | null {
    const raw = req.user?.id
    if (raw === undefined || raw === null || raw === '') return null
    const num = Number(raw)
    return Number.isFinite(num) ? num : null
  }

  // ============================================================================
  // 📂 知识库资产 CRUD
  // ============================================================================

  @Get('files/list')
  @AllowNoPerm()
  @ApiOperation({ summary: '查询虚拟隔离仓 file 列表' })
  async getFileList(@Query('parentId') parentId: string) {
    const files = await this.ragService.getKnowledgeFileList(Number(parentId) || 0)
    // 🔧 后端 size 字段是 bigint，TypeORM 默认以 string 返回 JS 端避免精度丢失；
    // 前端 RagAssetItem.size 类型是 number（formatSize 内部走 Math.log 字符串隐式转 number 不可靠），
    // 这里显式转 number 一次，让前端格式化逻辑稳。
    const normalized = files.map((f) => ({ ...f, size: Number(f.size) || 0 }))
    return ResultData.ok(normalized)
  }

  @Post('folder/create')
  @ApiOperation({ summary: '创建虚拟知识文件夹' })
  async createFolder(@Req() req: any, @Body() dto: { name: string; parentId: number }) {
    if (!req.user || req.user.type !== UserType.SUPER_ADMIN) {
      return ResultData.fail(HttpStatus.FORBIDDEN, '权限不足：仅管理员可创建目录')
    }
    const result = await this.ragService.createFolder(dto.name, Number(dto.parentId) || 0)
    return ResultData.ok(result)
  }

  @Post('file/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // 🔧 用 diskStorage 真存到磁盘（之前默认 memoryStorage，fileUrl 是骗人的）
      // 注意：@UseInterceptors 装饰器先于构造函数求值，this.uploadRoot 此时是 undefined，
      // 用模块顶层懒加载的 RAG_UPLOAD_DIR 常量，避免装饰器先于构造函数求值时 this 不可用
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, RAG_UPLOAD_DIR),
        filename: (_req, file, cb) => {
          // 🔧 multer 2.x 拿到 multipart header 里的 UTF-8 字节流后，**永远**按 latin1 字符串存到
          // file.originalname（iconv-lite 的 UTF-8 自动识别只对 RFC 5987 头 `filename*=UTF-8''...` 生效，
          // 而浏览器 / axios 不会发这种头）。所以这里无条件做一次 latin1→utf8 反向解码，
          // 把 "å¬å¸..." 还原成正确的 "公司人事部..."。后续转码用 try/catch 兜底 latin1 不丢。
          const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8')
          // 时间戳前缀避免重名
          const finalName = `${Date.now()}_${safeName}`
          cb(null, finalName)
        },
      }),
    }),
  )
  @ApiOperation({ summary: '上传并注册语料文件资产' })
  async uploadAndRegisterFile(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('parentId') parentId: string,
  ) {
    if (!req.user || req.user.type !== UserType.SUPER_ADMIN) {
      return ResultData.fail(HttpStatus.FORBIDDEN, '权限不足：仅管理员可上传')
    }
    if (!file) {
      return ResultData.fail(HttpStatus.BAD_REQUEST, '未检测到上传文件流')
    }
    // 🐛 DEBUG：multer 给的 file.originalname 到底是什么？打印 raw bytes + 各种 decode 尝试
    const rawBytes = Buffer.from(file.originalname, 'latin1')
    // eslint-disable-next-line no-console
    console.warn(
      `[RAG upload 探针] file.originalname = ${JSON.stringify(file.originalname)} | ` +
        `rawBytes(${rawBytes.length}B) = ${rawBytes.toString('hex').slice(0, 80)}... | ` +
        `decode_latin1 = ${rawBytes.toString('utf8')} | ` +
        `file.filename (磁盘) = ${file.filename}`,
    )
    // diskStorage 下 file.path 才是真实物理路径；file.filename 是 dest 里磁盘上的文件名（含时间戳前缀）
    // 把物理路径 + 真实访问 URL 一起传给 service，让它写到数据库
    const record = await this.ragService.registerPhysicalFile(
      file,
      Number(parentId) || 0,
      this.serveRoot,
      this.fileDomain,
    )
    // ETL 管道从磁盘读（不依赖 buffer）
    this.ragService.asyncProcessEtlPipeline(file.path, record.id, file.originalname)
    return ResultData.ok(record, '文件接收成功，异步清洗任务已激活')
  }

  @Delete('file/delete')
  @ApiOperation({ summary: '物理擦除知识库资产' })
  async deleteFile(@Req() req: any, @Query('id') id: string) {
    if (!req.user || req.user.type !== UserType.SUPER_ADMIN) {
      return ResultData.fail(HttpStatus.FORBIDDEN, '核心资产仅限管理员销毁')
    }
    await this.ragService.deleteFileEntity(Number(id))
    return ResultData.ok(null, '该项语料资产已完成安全下线与销毁')
  }

  // ============================================================================
  // 💬【P1-2】会话与消息
  // ============================================================================

  @Get('sessions')
  @AllowNoPerm()
  @ApiOperation({ summary: '获取当前用户的会话列表（按更新时间倒序）' })
  async listSessions(@Req() req: any) {
    const userId = this.resolveUserId(req)
    if (userId === null) return ResultData.fail(HttpStatus.UNAUTHORIZED, '未识别到用户身份')
    const list = await this.ragService.listSessions(userId)
    return ResultData.ok(list)
  }

  @Post('sessions')
  @AllowNoPerm()
  @ApiOperation({ summary: '新建一个空会话' })
  async createSession(@Req() req: any, @Body() dto: { title?: string }) {
    const userId = this.resolveUserId(req)
    if (userId === null) return ResultData.fail(HttpStatus.UNAUTHORIZED, '未识别到用户身份')
    const session = await this.ragService.createSession(userId, dto?.title)
    return ResultData.ok(session)
  }

  @Get('sessions/:id/messages')
  @AllowNoPerm()
  @ApiOperation({ summary: '获取某个会话的全部消息' })
  async listMessages(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    const userId = this.resolveUserId(req)
    if (userId === null) return ResultData.fail(HttpStatus.UNAUTHORIZED, '未识别到用户身份')
    const owned = await this.ragService.getOwnedSession(id, userId)
    if (!owned) return ResultData.fail(HttpStatus.FORBIDDEN, '会话不存在或无权访问')
    const messages = await this.ragService.listMessages(id)
    return ResultData.ok(messages)
  }

  @Patch('sessions/:id')
  @AllowNoPerm()
  @ApiOperation({ summary: '重命名会话' })
  async renameSession(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() dto: { title: string }) {
    const userId = this.resolveUserId(req)
    if (userId === null) return ResultData.fail(HttpStatus.UNAUTHORIZED, '未识别到用户身份')
    const ok = await this.ragService.renameSession(id, userId, dto?.title || '')
    return ok ? ResultData.ok(null, '会话已重命名') : ResultData.fail(HttpStatus.FORBIDDEN, '会话不存在或无权访问')
  }

  @Delete('sessions/:id')
  @AllowNoPerm()
  @ApiOperation({ summary: '删除会话（级联删除消息）' })
  async deleteSession(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    const userId = this.resolveUserId(req)
    if (userId === null) return ResultData.fail(HttpStatus.UNAUTHORIZED, '未识别到用户身份')
    const ok = await this.ragService.deleteSession(id, userId)
    return ok ? ResultData.ok(null, '会话已安全下线') : ResultData.fail(HttpStatus.FORBIDDEN, '会话不存在或无权访问')
  }

  // ============================================================================
  // 🔥【P1-2】流式问答（带会话持久化 + 多轮上下文）
  // ============================================================================

  @Post('ask-stream')
  @AllowNoPerm()
  @Keep()
  @ApiOperation({ summary: '首页流式对话问答（自动会话管理 + 多轮记忆）' })
  async askStream(
    @Req() req: any,
    @Body() dto: { question: string; sessionId?: number | string; sources?: number[] },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    const userId = this.resolveUserId(req)
    const question = dto.question || ''
    const sessionId = dto.sessionId ?? null
    const sources = dto.sources || []

    try {
      if (userId === null) {
        res.write(`data: ${JSON.stringify(ResultData.fail(401, '未识别到用户身份，请重新登录'))}\n\n`)
        return
      }
      await this.ragService.executeDualTrackQuery(question, sessionId, sources, res, userId)
    } catch (error) {
      console.error('[RAG Controller 顶层防线捕捉]', error)
      const errorMessage = error instanceof Error ? error.message : '服务器内部发生决策性阻断'
      res.write(`data: ${JSON.stringify(ResultData.fail(500, errorMessage))}\n\n`)
    } finally {
      res.write(`data: ${JSON.stringify(ResultData.ok(null, 'stream_ended'))}\n\n`)
      res.end()
    }
  }
}

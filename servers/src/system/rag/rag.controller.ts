import {
  Controller,
  Post,
  Get,
  UploadedFile,
  UseInterceptors,
  Body,
  Res,
  UseGuards,
  HttpStatus,
  Req,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger'
import { Response } from 'express'
import { RagService } from './rag.service'

import { JwtAuthGuard } from '../../common/guards/auth.guard'
import { ResultData } from '../../common/utils/result'

@ApiTags('企业级双轨制核心知识库 RAG')
@Controller('rag')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class RagController {
  constructor(private readonly ragService: RagService) {}

  /**
   * 【仅限 Admin 登录可用】创建虚拟知识库网盘文件夹
   */
  @Post('folder/create')
  @ApiOperation({ summary: '创建虚拟知识文件夹（仅限Admin）' })
  async createFolder(@Req() req: any, @Body() dto: { name: string; parentId: number }) {
    // 权限校验：通过 nest-admin 注入的 req.user 来验证角色
    if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
      return ResultData.fail(HttpStatus.FORBIDDEN, '权限不足：只有管理员可管理知识库目录')
    }

    const result = await this.ragService.createFolder(dto.name, dto.parentId)
    return ResultData.ok(result, '目录创建成功')
  }

  /**
   * 【仅限 Admin 登录可用】双轨制知识语料上传
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: '上传知识库文件并触发异步清洗（仅限Admin）' })
  async uploadKnowledge(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('parentId') parentId: number = 0,
  ) {
    if (!req.user || !req.user.roles || !req.user.roles.includes('admin')) {
      return ResultData.fail(HttpStatus.FORBIDDEN, '权限不足：只有管理员可上传知识物料')
    }

    // 注册 sys_oss 记录，计算是走 VECTOR 还是 SQL 轨道
    const ossRecord = await this.ragService.registerOssMeta(file, Number(parentId))

    // 异步拉起清洗管道（非阻塞，防止大文件导致 HTTP 超时）
    this.ragService.asyncProcessEtlPipeline(file, ossRecord.id).catch((err) => {
      console.error(`[RAG ETL 故障] 文件ID: ${ossRecord.id}`, err)
    })

    return ResultData.ok(
      {
        ossId: ossRecord.id,
        track: ossRecord.rag_track,
      },
      '文件上传成功，后台清洗加工中...',
    )
  }

  /**
   * 获取可用于知识库过滤的文件列表
   */
  @Get('files')
  @ApiOperation({ summary: '获取企业知识库已解析成功的文件语料列表' })
  async getKnowledgeFiles() {
    // 借用底层的 EntityManager 从 sys_oss 表中筛选出所有成功构建索引的资产
    const files = await this.ragService['entityManager']
      .createQueryBuilder()
      .select('oss.id', 'id')
      .addSelect('oss.file_name', 'fileName')
      .addSelect('oss.size', 'size')
      .addSelect('oss.rag_track', 'rag_track')
      .from('sys_oss', 'oss')
      .where('oss.is_dir = 0')
      .andWhere('oss.vector_status = :status', { status: 'success' })
      .orderBy('oss.create_date', 'DESC')
      .getRawMany()

    // 使用项目自带的 ResultData.ok() 方法进行标准格式包装返回
    return ResultData.ok(files, '知识库语料列表获取成功')
  }

  /**
   * 清空或销毁指定会话的上下文历史
   */
  @Post('session/clear')
  @ApiOperation({ summary: '安全释放清空指定的会话历史记录' })
  async clearSession(@Body() body: { sessionId: string }) {
    // 提示：此处上下文本地释放由于不涉及持久化强物理删除，可以直接返回成功状态，让前端清理自身的 message 数组
    return ResultData.ok(null, '会话上下文释放成功')
  }

  /**
   * 【全员普适：任何用户类型登录后均可访问】企业级 POST 异步流式问答
   */
  @Post('ask-stream')
  @ApiOperation({ summary: '首页流式对话问答（所有登录用户均可用）' })
  async askStream(@Body() dto: { question: string; sessionId?: string; sources?: number[] }, @Res() res: Response) {
    // 设定 SSE 生产级响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // 禁用反向代理缓存（如Nginx），实现顺畅蹦字

    try {
      // 调用 Service 层执行双轨制复杂计算与实时 res.write() 泵字
      await this.ragService.executeDualTrackQuery(dto.question, dto.sessionId, dto.sources, res)
    } catch (error) {
      console.error('[RAG Controller 顶层防线捕捉]', error)
      const errorMessage = error instanceof Error ? error.message : '服务器内部发生决策性阻断'
      res.write(`data: ${JSON.stringify({ code: 500, msg: errorMessage })}\n\n`)
    } finally {
      // 物理断开 Express 连接
      res.end()
    }
    
    return ResultData.ok(null, 'stream_ended')
  }
}

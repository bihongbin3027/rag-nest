import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Res,
  UseGuards,
  Req,
  Query,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { Response } from 'express'
import { RagService } from './rag.service'
import { JwtAuthGuard } from '../../common/guards/auth.guard'
import { AllowNoPerm } from '../../common/decorators/perm.decorator'
import { UserType } from '../../common/enums/common.enum'
import { ResultData } from '../../common/utils/result'

import { Keep } from '../../common/decorators/keep.decorator'

@ApiTags('企业级双轨制核心知识库 RAG')
@Controller('rag')
@UseGuards(JwtAuthGuard)
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Get('files/list')
  @AllowNoPerm()
  @ApiOperation({ summary: '查询虚拟隔离仓 file 列表' })
  async getFileList(@Query('parentId') parentId: string) {
    const files = await this.ragService.getKnowledgeFileList(Number(parentId) || 0)
    return ResultData.ok(files)
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
  @UseInterceptors(FileInterceptor('file'))
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

    const record = await this.ragService.registerPhysicalFile(file, Number(parentId) || 0)
    this.ragService.asyncProcessEtlPipeline(file, record.id)

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

  @Post('ask-stream')
  @AllowNoPerm()
  @Keep()
  @ApiOperation({ summary: '首页流式对话问答' })
  async askStream(
    @Body() dto: { question: string; sessionId?: string; sources?: number[] },
    @Res() res: Response,
  ) {
    // 初始化标准 SSE 响应头，禁用 Nginx 缓存，确保打字机秒回
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    const question = dto.question || ''
    const sessionId = dto.sessionId || `session_${Date.now()}`
    const sources = dto.sources || []

    try {
      // 异步等待 Service 层执行完毕
      await this.ragService.executeDualTrackQuery(question, sessionId, sources, res)
    } catch (error) {
      console.error('[RAG Controller 顶层防线捕捉]', error)
      const errorMessage = error instanceof Error ? error.message : '服务器内部发生决策性阻断'
      // 一旦中间崩溃，以标准 ResultData 的格式推给前端
      res.write(`data: ${JSON.stringify(ResultData.fail(500, errorMessage))}\n\n`)
    } finally {
      // 发送一个 stream_ended 的标准 ResultData 结构，让前端拦截器闭环
      res.write(`data: ${JSON.stringify(ResultData.ok(null, 'stream_ended'))}\n\n`)
      // 物理断开长连接
      res.end()
    }
  }
}

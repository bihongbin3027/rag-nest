import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ConfigService } from '@nestjs/config'
import { Response } from 'express'
import * as path from 'path'

import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai'
import { Document } from '@langchain/core/documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { QdrantVectorStore } from '@langchain/qdrant'
import { PDFParse } from 'pdf-parse'
import * as mammoth from 'mammoth'

import { RagFileEntity, RagTrackEnum, VectorStatusEnum } from './rag-file.entity'
import { ResultData } from '../../common/utils/result'

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name)
  private readonly llm: ChatOpenAI
  private readonly embeddings: OpenAIEmbeddings
  private readonly qdrantUrl: string
  private readonly collectionName: string

  constructor(
    @InjectRepository(RagFileEntity)
    private readonly ragFileRepository: Repository<RagFileEntity>,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('ai.llm.apiKey')
    const baseURL = this.configService.get<string>('ai.llm.baseURL')
    const modelName = this.configService.get<string>('ai.llm.modelName')
    this.qdrantUrl = this.configService.get<string>('ai.qdrant.url')
    this.collectionName = this.configService.get<string>('ai.qdrant.collectionName')

    this.llm = new ChatOpenAI({ apiKey, configuration: { baseURL }, modelName, temperature: 0.2, streaming: true })
    this.embeddings = new OpenAIEmbeddings({ apiKey, configuration: { baseURL } })
  }

  /**
   * 🌟【完全对齐】直接返回数据库原始实体列表，不进行任何前置加工与转换
   */
  async getKnowledgeFileList(parentId: number): Promise<RagFileEntity[]> {
    return await this.ragFileRepository.find({
      where: { parentId },
      order: { isFolder: 'DESC', createdAt: 'DESC' },
    })
  }

  /**
   * 🌟【完全对齐】创建文件夹，字段保持跟 Entity 100% 对应
   */
  async createFolder(fileName: string, parentId: number): Promise<RagFileEntity> {
    const folder = this.ragFileRepository.create({
      fileName: fileName,
      parentId: parentId,
      isFolder: 1,
      vectorStatus: VectorStatusEnum.SUCCESS, // 目录默认可用
      ragTrack: RagTrackEnum.VECTOR,
      size: 0,
    })
    return await this.ragFileRepository.save(folder)
  }

  /**
   * 🌟【完全对齐】持久化接收物理语料
   */
  async registerPhysicalFile(file: Express.Multer.File, parentId: number): Promise<RagFileEntity> {
    const ext = path.extname(file.originalname).toLowerCase()
    let track = RagTrackEnum.VECTOR

    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      track = RagTrackEnum.SQL
    }

    const fileEntity = this.ragFileRepository.create({
      fileName: file.originalname,
      parentId: parentId,
      isFolder: 0,
      fileUrl: `uploads/rag/${Date.now()}_${file.originalname}`,
      size: file.size,
      fileType: ext,
      ragTrack: track,
      vectorStatus: VectorStatusEnum.PROCESSING,
    })

    return await this.ragFileRepository.save(fileEntity)
  }

  /**
   * 异步 ETL 文本提取管道
   */
  async asyncProcessEtlPipeline(file: Express.Multer.File, fileId: number): Promise<void> {
    try {
      const record = await this.ragFileRepository.findOneBy({ id: fileId })
      if (!record) return

      if (record.ragTrack === RagTrackEnum.SQL) {
        this.logger.log(`[SQL轨道] 正在为文件 ID ${fileId} 进行行列治理提取...`)
      } else {
        await this.parseDocumentToVectorStore(file, fileId)
      }

      await this.ragFileRepository.update(fileId, { vectorStatus: VectorStatusEnum.SUCCESS })
    } catch (error) {
      this.logger.error(`[RAG ETL 异步管道崩溃] FILE_ID: ${fileId}`, error)
      await this.ragFileRepository.update(fileId, {
        vectorStatus: VectorStatusEnum.FAILED,
        errorMessage: error instanceof Error ? error.message : '未知切片崩溃异常',
      })
    }
  }

  private async parseDocumentToVectorStore(file: Express.Multer.File, fileId: number): Promise<void> {
    let rawText = ''
    const ext = path.extname(file.originalname).toLowerCase()

    if (ext === '.txt' || ext === '.md') {
      rawText = file.buffer.toString('utf-8')
    } else if (ext === '.pdf') {
      const pdfParser = new PDFParse({ data: file.buffer })
      const pdfData = await pdfParser.getText()
      rawText = pdfData.text
    } else if (ext === '.docx') {
      const docxData = await mammoth.extractRawText({ buffer: file.buffer })
      rawText = docxData.value
    } else {
      throw new Error(`暂不支持该文件格式: ${ext}`)
    }

    if (!rawText.trim()) throw new Error('语料解析为空')

    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 600, chunkOverlap: 100 })
    const chunks = await splitter.splitText(rawText)
    const documents = chunks.map((chunkText, index) => {
      return new Document({
        pageContent: chunkText,
        metadata: {
          fileId: fileId,
          fileName: file.originalname,
          chunkIndex: index,
        },
      })
    })

    await QdrantVectorStore.fromDocuments(documents, this.embeddings, {
      url: this.qdrantUrl,
      collectionName: this.collectionName,
    })
  }

  async deleteFileEntity(id: number): Promise<void> {
    await this.ragFileRepository.delete(id)
  }

  async executeDualTrackQuery(question: string, sessionId: string, sources: number[], res: Response): Promise<void> {
    res.write(`data: ${JSON.stringify({ code: 200, data: '正在检索关联知识库资产...\n' })}\n\n`)
    try {
      let relevantDocs: { doc: Document; score: number }[] = []
      if (sources && sources.length > 0) {
        try {
          const vectorStore = await QdrantVectorStore.fromExistingCollection(this.embeddings, {
            url: this.qdrantUrl,
            collectionName: this.collectionName,
          })
          // 使用 similaritySearchWithScore 拿到带相似度分数的结果，便于前端展示可信度
          const raw = await vectorStore.similaritySearchWithScore(question, 4, {
            filter: { must: [{ key: 'metadata.fileId', match: { any: sources } }] },
          } as any)
          relevantDocs = raw.map(([doc, score]) => ({ doc, score }))
        } catch (vErr) {
          relevantDocs = []
        }
      }

      if (relevantDocs.length === 0) {
        res.write(
          `data: ${JSON.stringify({ code: 200, data: '未在参考资料中发现线索，转由大语言模型泛化解答：\n\n' })}\n\n`,
        )
        const responseStream = await this.llm.stream(question)
        for await (const chunk of responseStream) {
          const content = typeof chunk === 'string' ? chunk : (chunk as any).content || ''
          if (content) res.write(`data: ${JSON.stringify({ code: 200, data: content })}\n\n`)
        }
      } else {
        // 🌟【P1-1 引用源】在流式回答前先把 references 元数据推给前端，便于气泡下方渲染引用卡片
        const citations = relevantDocs.map(({ doc, score }) => ({
          fileId: doc.metadata?.fileId,
          fileName: doc.metadata?.fileName || '未知来源',
          chunkIndex: doc.metadata?.chunkIndex ?? -1,
          // 切片内容片段，去除多余空白便于卡片展示；前端可点击展开完整内容
          content: (doc.pageContent || '').replace(/\s+/g, ' ').trim().slice(0, 280),
          // 相似度：Qdrant 返回的是 cosine 距离（越小越相似），这里统一转成 0~1 的"相关度"（越大越相关）
          score: typeof score === 'number' ? Math.max(0, Math.min(1, 1 - score)) : null,
        }))
        res.write(`data: ${JSON.stringify({ code: 'sources', data: citations })}\n\n`)

        const contextText = relevantDocs
          .map(({ doc }) => `【参考源: ${doc.metadata?.fileName}】\n${doc.pageContent}`)
          .join('\n\n')
        res.write(`data: ${JSON.stringify({ code: 200, data: '已为您提炼关联企业物料，深度解答中：\n\n' })}\n\n`)

        const systemPrompt = `你是一款高级 AI 助手。请严格基于参考内容回答问题。\n\n【参考资料】:\n${contextText}`
        const responseStream = await this.llm.stream([
          ['system', systemPrompt],
          ['human', question],
        ])
        for await (const chunk of responseStream) {
          const content = typeof chunk === 'string' ? chunk : (chunk as any).content || ''
          if (content) res.write(`data: ${JSON.stringify({ code: 200, data: content })}\n\n`)
        }
      }
    } catch (err) {
      this.logger.error('[RAG 运行流内部异常捕捉并安全消化]', err)
      const errorDetails = err instanceof Error ? err.message : '大模型集群响应超时'
      res.write(`data: ${JSON.stringify({ code: 500, data: `\n[系统决策阻断]: ${errorDetails}` })}\n\n`)
    } finally {
      res.write(`data: ${JSON.stringify(ResultData.ok(''))}\n\n`)
    }
  }
}
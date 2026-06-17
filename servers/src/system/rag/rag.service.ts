import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, In } from 'typeorm'
import { ConfigService } from '@nestjs/config'
import { Response } from 'express'
import * as path from 'path'

import { ChatOpenAI } from '@langchain/openai'
import { Document } from '@langchain/core/documents'
import { Embeddings, type EmbeddingsParams } from '@langchain/core/embeddings'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { QdrantVectorStore } from '@langchain/qdrant'
import { PDFParse } from 'pdf-parse'
import * as mammoth from 'mammoth'
import * as ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'

import { RagFileEntity, RagTrackEnum, VectorStatusEnum } from './rag-file.entity'
import { RagSessionEntity } from './rag-session.entity'
import { RagMessageEntity } from './rag-message.entity'
import { ResultData } from '../../common/utils/result'
import { RAG_UPLOAD_DIR } from './rag-upload.util'
import { RagMetricsService } from '../../common/metrics/rag-metrics.service'
import { limitAndBreaker } from '../../common/utils/circuit-breaker.util'
import { RerankProvider } from './rerank.provider'

/**
 * 【P1-2 / P1-3】引用源条目
 * - ragTrack='vector'（长文本）：chunkIndex 是文本切片号
 * - ragTrack='sql'（结构化表格）：chunkIndex 是 row 聚合块号，rowIndices/columns/sheetName 标记行级来源
 */
export interface CitationDto {
  fileId: number
  fileName: string
  chunkIndex: number
  content: string
  score: number | null
  // 【P1-3】SQL 轨道扩展字段
  ragTrack?: 'vector' | 'sql' | null
  sheetName?: string | null
  rowIndices?: number[] | null
  columns?: string[] | null
}

/**
 * 【P1-2】历史消息（用于多轮对话上下文拼装）
 */
interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 【P1-3】MiniMax 兼容协议的 Embeddings 适配器
 *
 * 为什么不直接用 OpenAIEmbeddings：
 *   1) MiniMax（api.minimaxi.com）的 /v1/embeddings 接口字段名是 MiniMax 私有的：
 *      - 请求体用 `texts: [...]` + `type: 'db'|'query'`，不接受 OpenAI 标准的 `input: [...]`
 *      - 响应体用 `vectors: number[][]`，不是 OpenAI 标准的 `data: [...]`
 *   2) 直接套 OpenAIEmbeddings 会让服务端返回 200 + 业务错误 `{vectors: null, base_resp: {status_code: 2013, ...}}`，
 *      OpenAI SDK 把这种"业务错"解析成 `data: undefined`，再被 langchain 内部
 *      `batchResponse[j].embedding` 访问 → 抛 `Cannot read properties of undefined (reading '0')`。
 *
 * 这里直接 fetch 走 MiniMax 私有协议，避开 OpenAI SDK 的字段假设。
 * model 名字从 `ai.llm.modelName` yml 里读（推荐用 'embo-01'）。
 */
interface MiniMaxEmbeddingsParams extends EmbeddingsParams {
  apiKey: string
  baseURL: string
  modelName: string
  batchSize?: number
}

class MiniMaxEmbeddings extends Embeddings {
  private readonly apiKey: string
  private readonly baseURL: string
  private readonly modelName: string
  private readonly batchSize: number
  // 【P1-3】embedding API 调用：限流（并发≤5）+ 熔断（错误率>50% 触发 30s 短路）
  // 熔断器状态通过 metrics service 回调上报到 Prometheus
  private readonly safeCall: (texts: string[], type: 'db' | 'query') => Promise<number[][]>

  constructor(params: MiniMaxEmbeddingsParams) {
    super(params)
    this.apiKey = params.apiKey
    this.baseURL = params.baseURL.replace(/\/$/, '')
    this.modelName = params.modelName
    this.batchSize = params.batchSize ?? 16
    // 实例化时构造熔断包装（需要在 RagService 注入 RagMetricsService 后初始化）
    // 实际初始化在 RagService 构造时通过 setMetrics() 完成
    this.safeCall = async () => {
      throw new Error('MiniMaxEmbeddings.safeCall not initialized; call setMetrics() first')
    }
  }

  /**
   * 由 RagService 在构造时调用，注入 RagMetricsService + 构造限流熔断包装
   */
  setMetrics(metrics: RagMetricsService): void {
    // 用类型断言绕过 readonly 限制（setMetrics 是初始化专用入口）
    ;(this as any).safeCall = limitAndBreaker(
      async (texts: string[], type: 'db' | 'query') => this.rawCall(texts, type),
      { concurrency: 5 }, // 最多 5 个并发 embedding 调用（MiniMax API 默认 rate limit 通常 10+）
      {
        name: 'embedding',
        errorThresholdPercentage: 50, // 错误率 > 50% 触发熔断
        resetTimeout: 30000, // 熔断 30s 后半开探测
        timeout: 30000, // 单次调用 30s 超时
        onStateChange: (state) => metrics.setCircuitBreakerState('embedding', state),
      },
    )
  }

  /**
   * 原始 fetch 调用（被熔断包装）
   */
  private async rawCall(texts: string[], type: 'db' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return []
    const r = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model: this.modelName, type, texts })
    })
    if (!r.ok) {
      throw new Error(`[MiniMaxEmbeddings] HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
    }
    const body: any = await r.json()
    if (body?.base_resp?.status_code !== 0 || !Array.isArray(body?.vectors)) {
      throw new Error(
        `[MiniMaxEmbeddings] 业务错误 status_code=${body?.base_resp?.status_code} msg=${body?.base_resp?.status_msg} raw=${JSON.stringify(body).slice(0, 300)}`,
      )
    }
    return body.vectors as number[][]
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const vecs = await this.safeCall(batch, 'db')
      out.push(...vecs)
    }
    return out
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.safeCall([text], 'query')
    return v
  }
}

// ============================================================================
// 🔁【P3-5】ETL 重试占位（实际方法在 RagService 类内）
// ============================================================================

/**
 * 简单信号量：维护"已占用 / 最大允许"两个计数 + 等待队列。
 * - acquire() 立即返回 if 计数 < max，否则 await 直到 release
 * - release() 唤醒队列头部
 *
 * 用在 ETL 入口做"最多同时跑 N 个 ETL"控制，防止单实例被打挂。
 * 进程级而非集群级（多实例部署需要替换成 Redis 信号量；单实例够用）。
 */
class SimpleSemaphore {
  private current = 0
  private queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }
    return new Promise<void>((resolve) => this.queue.push(resolve))
  }

  release(): void {
    this.current--
    const next = this.queue.shift()
    if (next) {
      this.current++
      next()
    }
  }

  get active(): number {
    return this.current
  }

  get waiting(): number {
    return this.queue.length
  }
}

@Injectable()
export class RagService {
  // 【P1-3】LLM 调用熔断包装：错误率 > 50% 触发 30s 短路
  // 生成摘要 / sheet 摘要 / FAQ 都是 LLM.invoke 调用，统一熔断
  private readonly safeLlmInvoke: (prompt: string) => Promise<any>

  // 【P0-2】上传白名单：只允许已知安全的扩展名（防可执行文件/宏文档绕过）
  // 与 parseDocumentToVectorStore / parseStructuredToVectorStore 实际处理的扩展名保持一致
  // 同步在 multer fileFilter（controller 层）和 ragTrack 判定（service 层）
  static readonly ALLOWED_UPLOAD_EXTS: readonly string[] = [
    '.txt',
    '.md',
    '.pdf',
    '.docx',
    '.xlsx',
    '.xls',
    '.csv',
  ]
  private readonly logger = new Logger(RagService.name)
  private readonly llm: ChatOpenAI
  private readonly embeddings: MiniMaxEmbeddings
  private readonly qdrantUrl: string
  private readonly collectionName: string

  constructor(
    @InjectRepository(RagFileEntity)
    private readonly ragFileRepository: Repository<RagFileEntity>,
    @InjectRepository(RagSessionEntity)
    private readonly ragSessionRepository: Repository<RagSessionEntity>,
    @InjectRepository(RagMessageEntity)
    private readonly ragMessageRepository: Repository<RagMessageEntity>,
    private readonly configService: ConfigService,
    private readonly metrics: RagMetricsService, // 【P1-1】Prometheus 指标
    private readonly reranker: RerankProvider, // 【P2-1】Cross-encoder Rerank
  ) {
    const apiKey = this.configService.get<string>('ai.llm.apiKey')
    const baseURL = this.configService.get<string>('ai.llm.baseURL')
    const chatModel = this.configService.get<string>('ai.llm.chatModel') || 'MiniMax-Text-01'
    const embeddingModel = this.configService.get<string>('ai.llm.embeddingModel') || 'embo-01'
    this.qdrantUrl = this.configService.get<string>('ai.qdrant.url')
    this.collectionName = this.configService.get<string>('ai.qdrant.collectionName')

    this.llm = new ChatOpenAI({ apiKey, configuration: { baseURL }, modelName: chatModel, temperature: 0.2, streaming: true })
    // 🔧 用 MiniMax 兼容协议专用适配器（见上方 MiniMaxEmbeddings 类注释）
    this.embeddings = new MiniMaxEmbeddings({ apiKey, baseURL, modelName: embeddingModel })
    // 【P1-3】注入 RagMetricsService 到 MiniMaxEmbeddings，让 embedding 调用走限流 + 熔断
    this.embeddings.setMetrics(this.metrics)

    // 【P1-3】LLM.invoke 熔断包装：与 embedding 独立熔断（错误率/超时分开统计）
    this.safeLlmInvoke = limitAndBreaker(
      async (prompt: string) => this.llm.invoke(prompt),
      { concurrency: 8 }, // LLM 并发稍高（流式响应内部已经节流）
      {
        name: 'llm',
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
        timeout: 60000, // LLM 摘要生成可长一点（默认 60s 超时）
        onStateChange: (state) => this.metrics.setCircuitBreakerState('llm', state),
      },
    )
  }

  // ============================================================================
  // 📂 知识库语料 CRUD
  // ============================================================================

  async getKnowledgeFileList(parentId: number, userId: number, isSuperAdmin: boolean): Promise<RagFileEntity[]> {
    // 【P0-1】超管看所有，普通用户只看自己的；复合索引 (userId, parentId) O(log n)
    const where: any = { parentId }
    if (!isSuperAdmin) where.userId = userId
    return await this.ragFileRepository.find({
      where,
      order: { isFolder: 'DESC', createdAt: 'DESC' },
    })
  }

  /**
   * 【P1-4】资产 ID 列表（可能含文件夹 + 文件）→ 纯文件 ID 列表（递归展开文件夹）
   *
   * 场景：dashboard 树形选择器允许用户勾选"外层文件夹"代表"该文件夹下所有文件"。
   * Qdrant 检索只认 metadata.fileId，所以后端在 similaritySearch 前必须把
   * 混合的"文件 id + 文件夹 id"列表展开成纯文件 id。
   *
   * 算法：BFS 一次性查所有直系子节点；目录深度通常 ≤ 3 层，最坏 O(N)。
   * 防御：visited Set 防止 folder 间循环引用导致死循环。
   *
   * 【P0-1】加 userId 过滤：用户只能展开"自己的"资产 id，避免跨用户拉取
   */
  async expandAssetIdsToFileIds(assetIds: number[], userId: number, isSuperAdmin: boolean): Promise<number[]> {
    if (!Array.isArray(assetIds) || assetIds.length === 0) return []

    // 第一步：先分桶（哪些是文件夹，哪些是文件）—— 超管跳过过滤
    const itemsWhere: any = { id: In(assetIds) }
    if (!isSuperAdmin) itemsWhere.userId = userId
    const items = await this.ragFileRepository.find({
      where: itemsWhere,
      select: ['id', 'isFolder'],
    })
    const fileIdSet = new Set<number>()
    const folderIds: number[] = []
    for (const item of items) {
      if (item.isFolder === 1) folderIds.push(item.id)
      else fileIdSet.add(item.id)
    }
    if (folderIds.length === 0) return Array.from(fileIdSet)

    // 第二步：BFS 展开所有文件夹的子孙文件 —— 子节点也要按 userId 过滤
    const visited = new Set<number>()
    const queue: number[] = [...folderIds]
    while (queue.length > 0) {
      const currentId = queue.shift()!
      if (visited.has(currentId)) continue
      visited.add(currentId)
      const childWhere: any = { parentId: currentId }
      if (!isSuperAdmin) childWhere.userId = userId
      const children = await this.ragFileRepository.find({
        where: childWhere,
        select: ['id', 'isFolder'],
      })
      for (const c of children) {
        if (c.isFolder === 1) queue.push(c.id)
        else fileIdSet.add(c.id)
      }
    }
    return Array.from(fileIdSet)
  }

  async createFolder(fileName: string, parentId: number, userId: number): Promise<RagFileEntity> {
    const folder = this.ragFileRepository.create({
      fileName: fileName,
      parentId: parentId,
      isFolder: 1,
      vectorStatus: VectorStatusEnum.SUCCESS,
      ragTrack: RagTrackEnum.VECTOR,
      size: 0,
      userId, // 【P0-1】文件夹归属当前用户
    })
    return await this.ragFileRepository.save(folder)
  }

  /**
   * multer 2.x 给的 file.originalname 永远是 latin1 字符串（不论是否装 iconv-lite），
   * 这里独立做一次 latin1→utf8 反向解码，把 "å¬å¸..." 还原成 "公司人事部..."。
   * controller 那边已经修过一次磁盘文件名 (file.filename)，但 originalname 是只读属性，
   * service 必须自己再修一次才能保证数据库存的 fileName 是正确中文。
   */
  private decodeMojibakeName(raw: string): string {
    try {
      return Buffer.from(raw, 'latin1').toString('utf8')
    } catch {
      return raw
    }
  }

  /**
   * 注册一条物理文件资产
   * @param file       multer 解析后的文件（含 buffer/filename/path）
   * @param parentId   父目录 id（0 = 根）
   * @param serveRoot  Express static 暴露的虚拟路径前缀，如 '/static'
   * @param fileDomain 文件服务域名，如 'http://localhost:8081'
   */
  async registerPhysicalFile(
    file: Express.Multer.File,
    parentId: number,
    userId: number, // 【P0-1】文件归属当前用户
    serveRoot?: string,
    fileDomain?: string,
  ): Promise<RagFileEntity> {
    // 🔧 关键：必须对 originalname 独立做 latin1→utf8 反向解码，否则存到 DB 的 fileName 是乱码
    const originalName = this.decodeMojibakeName(file.originalname)
    const ext = path.extname(originalName).toLowerCase()
    let track = RagTrackEnum.VECTOR

    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      track = RagTrackEnum.SQL
    }

    // 物理磁盘上由 multer diskStorage 写出的最终文件名（已含时间戳前缀 + 解码后的中文）
    // 真实可访问 URL：分两种情况拼接
    //   - fileDomain 非空：${fileDomain}${serveRoot}/rag/${diskFilename}，如 http://localhost:8081/static/rag/xxx
    //   - fileDomain 为空：${serveRoot}/rag/${diskFilename}，前端拼域名访问
    const diskFilename = file.filename || `${Date.now()}_${originalName}`
    const root = fileDomain ? `${fileDomain.replace(/\/$/, '')}${serveRoot || ''}` : `${serveRoot || ''}`
    const fileUrl = `${root}/rag/${diskFilename}`

    const fileEntity = this.ragFileRepository.create({
      fileName: originalName,
      parentId: parentId,
      isFolder: 0,
      fileUrl,
      size: file.size,
      fileType: ext,
      ragTrack: track,
      vectorStatus: VectorStatusEnum.PROCESSING,
      userId, // 【P0-1】文件归属当前用户
    })

    return await this.ragFileRepository.save(fileEntity)
  }

  /**
   * 从磁盘读文件 buffer（用于 diskStorage 上传后的异步 ETL 管道）
   */
  private async readFileFromDisk(filePath: string): Promise<Buffer> {
    const fs = await import('fs')
    return await fs.promises.readFile(filePath)
  }

  /**
   * 异步 ETL 管道
   * @param filePath     multer diskStorage 写出的物理文件绝对路径
   * @param fileId       数据库中的文件 id
   * @param originalName 原始文件名（用于在 metadata 保留）
   */
  async runEtlJob(
    filePath: string,
    fileId: number,
    originalName: string,
    userId: number,
  ): Promise<void> {
    // 【P1-2】BullMQ 队列已处理并发控制（concurrency=3）
    // 【P1-1】ETL 计时埋点
    const t0 = Date.now()
    let hasError = false
    this.logger.log(`[P1-2 ETL 启动] fileId=${fileId} userId=${userId}`)
    try {
      const record = await this.ragFileRepository.findOneBy({ id: fileId })
      if (!record) return

      // 🔧 关键：multer 给的 originalName 是 latin1 字符串，必须独立做一次 latin1→utf8 解码，
      // 否则 Qdrant metadata.fileName（以及后续任何按文件名做的引用/检索）会全是乱码。
      const safeOriginalName = this.decodeMojibakeName(originalName)

      // 从磁盘读 buffer 再交给解析器（不依赖 multer 的内存 buffer）
      const file: Express.Multer.File = {
        path: filePath,
        originalname: safeOriginalName,
        buffer: await this.readFileFromDisk(filePath),
        size: 0,
      } as any
      // size 用 stat 补全
      try {
        const stat = await import('fs').then((m) => m.promises.stat(filePath))
        ;(file as any).size = stat.size
      } catch {
        /* ignore */
      }

      if (record.ragTrack === RagTrackEnum.SQL) {
        await this.parseStructuredToVectorStore(file, fileId, safeOriginalName, userId)
      } else {
        await this.parseDocumentToVectorStore(file, fileId, userId)
      }

      await this.ragFileRepository.update(fileId, { vectorStatus: VectorStatusEnum.SUCCESS })
    } catch (error: any) {
      hasError = true
      this.logger.error(`[RAG ETL 异步管道崩溃] FILE_ID: ${fileId}\n${error?.stack || error}`)
      // 把堆栈首行也存到 errorMessage，方便页面直接看到崩溃位置
      const stackFirstLine =
        (error?.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 500) || ''
      const msg = error instanceof Error ? error.message : '未知切片崩溃异常'
      await this.ragFileRepository.update(fileId, {
        vectorStatus: VectorStatusEnum.FAILED,
        errorMessage: stackFirstLine ? `${msg} | ${stackFirstLine}` : msg,
      })
    } finally {
      // 【P1-1】无论成功/失败/异常，上报 Prometheus 指标
      const durationMs = Date.now() - t0
      this.logger.log(`[P1-2 ETL 完成] fileId=${fileId} 耗时=${durationMs}ms`)
      this.metrics.recordEtlComplete(hasError ? 'failed' : 'success', durationMs / 1000)
    }
  }

  /**
   * 【P3-5】触发指定 fileId 的 ETL 重跑。
   * 仅当 status='failed' 或 'pending' 时允许（避免覆盖正在 processing 的任务）。
   * 重置 status='processing' 后调用 asyncProcessEtlPipeline（fire-and-forget）。
   * 文件物理路径仍存在于磁盘（RAG_UPLOAD_DIR），不需要重新上传。
   */
  async retryFailedEtl(
    fileId: number,
    userId: number,
    isSuperAdmin: boolean,
  ): Promise<{ ok: boolean; reason?: string; filePath?: string; fileName?: string }> {
    // 【P0-1】先用 getOwnedFile 校验归属（超管跳过）
    const record = await this.getOwnedFile(fileId, userId, isSuperAdmin)
    if (!record) return { ok: false, reason: '文件不存在或无权访问' }
    if (record.isFolder === 1) return { ok: false, reason: '目录不能触发 ETL' }
    if (record.vectorStatus === VectorStatusEnum.PROCESSING) {
      return { ok: false, reason: '该文件 ETL 正在处理中，请等待完成后再试' }
    }
    if (record.vectorStatus === VectorStatusEnum.SUCCESS) {
      return { ok: false, reason: '该文件 ETL 已成功，无需重试' }
    }
    // 从 fileUrl 反推物理路径：fileUrl 形如 /static/rag/{ts}_{name}
    const fileName = (record.fileUrl || '').split('/').pop()
    if (!fileName) return { ok: false, reason: '文件 URL 异常，无法定位物理文件' }
    const filePath = path.join(RAG_UPLOAD_DIR, fileName)
    // 检查物理文件是否还在
    try {
      await import('fs').then((m) => m.promises.access(filePath))
    } catch {
      return { ok: false, reason: '物理文件已丢失，请重新上传' }
    }
    // 重置状态为 processing + 清空 errorMessage
    await this.ragFileRepository.update(fileId, {
      vectorStatus: VectorStatusEnum.PROCESSING,
      errorMessage: null,
    })
    // 【P0-1 收尾】retry 前先清旧 chunks：避免新旧向量叠加导致重复召回
    // 失败不阻断 ETL（清不掉就让 ETL 跑完，重复召回是次要问题）
    try {
      await this.deleteQdrantPointsByFileId(fileId, record.userId)
      this.logger.log(`[P0-1 重试清理] 已清旧 chunks fileId=${fileId} userId=${record.userId}`)
    } catch (err: any) {
      this.logger.warn(`[P0-1 重试清理] 清旧 chunks 失败（不阻断重跑）fileId=${fileId} ${err?.message || err}`)
    }
    // 【P1-2】不再 fire-and-forget 直接调 ETL —— 由 controller 推 BullMQ 队列
    return { ok: true, filePath, fileName: record.fileName }
  }

  /**
   * 🔧 确保 Qdrant collection 存在且向量维度匹配当前 embedding 模型。
   * - collection 不存在：等 fromDocuments 内部自动建（dim 由第一次插入的向量决定）
   * - collection 存在但 dim 不匹配：DELETE 重建（兜底，避免历史脏数据 / 旧 model 残留导致 dim 冲突）
   * - dim 匹配：不动
   *
   * 实际生产建议加一个 "schema migration" 步骤，但当前项目还在 P1 阶段，删重建成本最低。
   */
  private async ensureQdrantCollection(expectedDim: number): Promise<void> {
    const url = `${this.qdrantUrl.replace(/\/$/, '')}/collections/${this.collectionName}`
    const r = await fetch(url)
    if (r.status === 404) {
      this.logger.log(`[Qdrant] collection ${this.collectionName} 不存在，将在首次写入时自动创建 (dim=${expectedDim})`)
      return
    }
    if (!r.ok) {
      throw new Error(`[Qdrant] 查询 collection 失败: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    }
    const info: any = await r.json()
    const currentDim: number | undefined = info?.result?.config?.params?.vectors?.size
    if (currentDim === expectedDim) {
      this.logger.log(`[Qdrant] collection ${this.collectionName} 维度 OK (dim=${currentDim})`)
      return
    }
    // dim 不匹配 → 删重建
    this.logger.warn(
      `[Qdrant] collection ${this.collectionName} 维度不匹配 (existing=${currentDim}, expected=${expectedDim})，DELETE 重建`,
    )
    const del = await fetch(url, { method: 'DELETE' })
    if (!del.ok && del.status !== 404) {
      throw new Error(`[Qdrant] 删 collection 失败: HTTP ${del.status} ${(await del.text()).slice(0, 200)}`)
    }
  }

  private async parseDocumentToVectorStore(
    file: Express.Multer.File,
    fileId: number,
    userId: number, // 【P0-1】写入 Qdrant metadata
  ): Promise<void> {
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

    // 【P3-1】md 文档按 markdown 结构切分（标题/段落/代码块边界优先），其余格式保持原 RCTS 行为
    // 痛点：之前 md 走 RCTS 字符切，"## 二级标题" 这种半截会被切断，导致 chunk 嵌入向量偏向"残缺文本"
    // 解决：md 用 RCTS 自定义 separators 列表，按 # ## ### 标题层级优先切，段落/代码块次之
    let chunks: string[]
    if (ext === '.md') {
      const mdSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 600,
        chunkOverlap: 100,
        separators: [
          '\n# ',     // 一级标题
          '\n## ',    // 二级标题
          '\n### ',   // 三级标题
          '\n#### ',  // 四级标题
          '\n```\n',  // 代码块结束边界（独立 chunk）
          '\n\n',     // 段落
          '\n',       // 行
          ' ',        // 词
          '',         // 字符
        ],
      })
      chunks = await mdSplitter.splitText(rawText)
    } else {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 600, chunkOverlap: 100 })
      chunks = await splitter.splitText(rawText)
    }
    // ⚠️ file.originalname 已经被 asyncProcessEtlPipeline 在上游做过 latin1→utf8 解码，
    // 这里不要再解！直接用 file.originalname，否则会被"二次解码"重新打回乱码。
    // 用户报告过的乱码现象 l�����,��6�.xlsx 就是这行 double-decode 造成的。
    const documents = chunks.map((chunkText, index) => {
      return new Document({
        pageContent: chunkText,
        metadata: {
          fileId: fileId,
          fileName: file.originalname,
          chunkIndex: index,
          userId, // 【P0-1】Qdrant metadata 硬隔离
        },
      })
    })

    // 【P3-3】调用 LLM 生成整文档摘要，作为额外首 chunk 写入，提升跨段落召回率
    // chunkType='summary' 标识，让前端 references 可以按类型区分展示
    const summary = await this.generateDocumentSummary(rawText, file.originalname)
    if (summary) {
      documents.unshift(
        new Document({
          pageContent: `【文档摘要】${summary}`,
          metadata: {
            fileId: fileId,
            fileName: file.originalname,
            chunkIndex: -1, // 摘要固定 chunkIndex=-1，方便识别
            chunkType: 'summary',
            userId, // 【P0-1】Qdrant metadata 写 userId（硬隔离）
          },
        }),
      )
    }

    // 【P3-4】为每个"普通段落 chunk"调 LLM 生成 3-5 个"用户可能问的问题"
    // 这些 FAQ 作为辅助 chunk 写入，召回时"用户问题 ↔ FAQ 问题"匹配比"用户问题 ↔ 原文"更精准
    // 超短 chunk (<100 字符) 跳过；summary chunk 也跳过（FAQ 不适合给整文档生成）
    // 数量限制：每个文档最多 5 个 FAQ（避免长文档 LLM 调用爆炸，ETL 延迟失控）
    const originalDocCount = documents.length
    let faqCount = 0
    const MAX_FAQ_PER_DOC = 5
    for (let i = 0; i < documents.length; i++) {
      if (faqCount >= MAX_FAQ_PER_DOC) break
      const doc = documents[i]
      const chunkType = (doc.metadata as any)?.chunkType
      if (chunkType === 'summary') continue // 跳过摘要
      const faqs = await this.generateChunkFAQs(doc.pageContent, file.originalname)
      if (faqs.length === 0) continue
      documents.push(
        new Document({
          pageContent: `【FAQ】${faqs.join('\n')}`,
          metadata: {
            fileId: fileId,
            fileName: file.originalname,
            chunkIndex: doc.metadata?.chunkIndex ?? i, // 关联到原 chunk
            chunkType: 'faq',
            userId, // 【P0-1】Qdrant metadata 硬隔离
          },
        }),
      )
      faqCount++
    }
    this.logger.log(
      `[P3-4 FAQ] fileId=${fileId} 生成 ${documents.length - originalDocCount} 条 FAQ 辅助 chunks`,
    )

    // 🔧 先用一个 dummy 文本探测当前 embedding 模型的真实维度（1536 for embo-01）
    const probeVec = await this.embeddings.embedQuery('__dim_probe__')
    await this.ensureQdrantCollection(probeVec.length)

    await QdrantVectorStore.fromDocuments(documents, this.embeddings, {
      url: this.qdrantUrl,
      collectionName: this.collectionName,
    })
  }

  // ============================================================================
  // ============================================================================

  /**
   * 【P2-1】HyDE prompt：让 LLM 生成"假设性回答"
   * 用于在向量库中检索相关文档（行业标准做法）
   */
  private buildHydePrompt(question: string): string {
    return `你是企业知识库问答助手。请基于以下用户问题，写一段 200-400 字的"假设性回答"，用于在向量库中检索相关文档。

要求：
- 用陈述句，模拟你"已经知道答案"的语气
- 包含问题中提到的关键实体、概念、可能涉及的上下文
- 不要写"我不知道"、"无法回答"等回避语
- 不要包含"问题"、"回答"等元描述

用户问题：${question}
假设性回答：`
  }
  // 📝【P3-3】LLM 文档摘要生成
  // ============================================================================

  /**
   * 整文档摘要：把 rawText 喂给 LLM 生成 300-500 字中文摘要。
   * 用于 ETL 阶段追加一个"全文摘要" chunk，提升跨段落召回率。
   *
   * 失败兜底：返回 null（不写入 summary chunk，不影响主流程）
   * 输入过长处理：截断到 4000 字符（MiniMax 输入上限安全值）
   */
  private async generateDocumentSummary(
    rawText: string,
    fileName: string,
  ): Promise<string | null> {
    try {
      // 截断到 4000 字符，避免超出 LLM 输入上限或浪费 token
      const textForSummary = rawText.length > 4000 ? rawText.slice(0, 4000) + '...' : rawText
      const prompt = `你是文档摘要助手。请用 300-500 字中文总结以下文档的核心内容，包括主题、关键概念、覆盖范围。
不要逐字复述，要让读者通过摘要能大致了解文档讲什么、适合回答哪类问题。
直接输出摘要内容，不要用"本文..."等开头，不要带标题。

文件名：${fileName}
文档内容：
${textForSummary}`
      // 非流式调用：ChatOpenAI.invoke() 会等完整响应返回
      const response: any = await this.safeLlmInvoke(prompt)
      const summary = (typeof response?.content === 'string' ? response.content : String(response?.content || '')).trim()
      if (!summary) return null
      this.logger.log(`[P3-3 摘要] 文档摘要生成成功: ${fileName} → ${summary.length} 字`)
      return summary
    } catch (err: any) {
      this.logger.warn(`[P3-3 摘要] LLM 调用失败: ${err?.message || err}（跳过摘要写入）`)
      return null
    }
  }

  /**
   * Sheet 摘要：把 sheet 的列名 + 前 5 行数据喂给 LLM，生成 200-300 字中文摘要。
   * 用于 SQL 轨道每个 sheet 的"全局视图"，跨段落/跨行召回。
   *
   * 失败兜底：返回 null
   */
  private async generateSheetSummary(
    sheetName: string,
    columns: string[],
    rowObjects: Record<string, unknown>[],
  ): Promise<string | null> {
    try {
      // 取前 5 行作为样本（更多行超出 LLM 输入限制）
      const sampleRows = rowObjects.slice(0, 5)
      const sampleText = sampleRows
        .map((row, i) => {
          const kvs = Object.entries(row)
            .filter(([_, v]) => v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== ''))
            .map(([k, v]) => `${k}=${v}`)
            .join('；')
          return `行${i + 1}: ${kvs}`
        })
        .join('\n')
      const prompt = `你是表格摘要助手。请用 200-300 字中文总结以下 Excel/CSV sheet 的核心信息，包括：
- 这个 sheet 主要记录什么类型的数据
- 列名含义（用中文解释每个列名是关于什么的）
- 数据范围或示例（前 5 行示例即可）
直接输出摘要内容，不要用"本表..."等开头。

Sheet 名：${sheetName}
列名：${columns.join('、')}
前 5 行示例：
${sampleText}`
      const response: any = await this.safeLlmInvoke(prompt)
      const summary = (typeof response?.content === 'string' ? response.content : String(response?.content || '')).trim()
      if (!summary) return null
      this.logger.log(`[P3-3 摘要] sheet 摘要生成成功: ${sheetName} → ${summary.length} 字`)
      return summary
    } catch (err: any) {
      this.logger.warn(`[P3-3 摘要] sheet LLM 调用失败: ${err?.message || err}（跳过摘要写入）`)
      return null
    }
  }

  // ============================================================================
  // ❓【P3-4】LLM 为每个 chunk 生成"用户可能问的问题"作为辅助检索点
  // ============================================================================

  /**
   * 给定一个文本 chunk，调 LLM 生成 3-5 个"用户可能问的问题"。
   * 这些问题作为辅助 chunk 写入 Qdrant，召回时"用户问题 ↔ 辅助问题"匹配
   * 比"用户问题 ↔ 原文文本"匹配更精准。
   *
   * 失败兜底：返回 []（不写入 FAQ chunk，不影响主流程）
   * 超短 chunk：直接返回 []（chunk 太短，没有 FAQ 价值）
   * 超时控制：单次 LLM 调用 > 20s 自动 abort，避免 ETL 整体 hang
   */
  private async generateChunkFAQs(chunkText: string, contextHint: string = ''): Promise<string[]> {
    // 超短 chunk（如摘要）跳过 FAQ 生成
    if (chunkText.length < 100) return []
    try {
      const hintPart = contextHint ? `\n（上下文：${contextHint}）` : ''
      const prompt = `你是 RAG 检索优化助手。以下是一段知识库文档片段${hintPart}，请基于它的内容生成 3-5 个"用户最可能问的问题"。
要求：
1. 问题必须能从该片段直接找到答案，不要问片段外的扩展内容
2. 问题表述要自然，符合真实用户提问习惯（不要机械的"什么是 X"句式）
3. 每行一个问题，不要编号，不要其他解释

文档片段：
${chunkText.slice(0, 1500)}`
      // 单次 LLM 调用限时 20s
      const response: any = await Promise.race([
        this.llm.invoke(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('FAQ 生成超时 20s')), 20000)),
      ])
      const raw = (typeof response?.content === 'string' ? response.content : String(response?.content || '')).trim()
      if (!raw) return []
      // 按行拆分，去空 + 去编号（如"1." "1、"）
      const faqs = raw
        .split('\n')
        .map((q: string) => q.replace(/^\s*\d+[.、)]\s*/, '').trim())
        .filter((q: string) => q.length > 0 && q.length < 200 && !q.startsWith('问题'))
      return faqs.slice(0, 5) // 最多 5 个
    } catch (err: any) {
      this.logger.warn(`[P3-4 FAQ] LLM 调用失败: ${err?.message || err}（跳过该 chunk 的 FAQ）`)
      return []
    }
  }

  // ============================================================================
  // 📊【P1-3】SQL 轨道：结构化表格 (Excel/CSV) → 行级向量化
  // ============================================================================

  /**
   * 行级文本化模板：
   * 把一行 Excel/CSV 数据序列化成"自然语言友好"的描述。
   * - 例：{ 部门: '研发', 人数: 42, 月份: '2025-03' }
   *   → "部门: 研发; 人数: 42; 月份: 2025-03"
   *
   * 关键：ExcelJS 对 Date 单元格返回 `Date` 对象，String() 会输出
   *   "Sat Mar 15 2025 08:00:00 GMT+0800 (中国标准时间)"，LLM 检索"2025年3月"根本匹配不到。
   * 这里统一转成 `YYYY-MM-DD`（带时间的转成 `YYYY-MM-DD HH:mm`）。
   * 对 Excel 数字时间戳（1899-12-30 起的天数）也做识别。
   *
   * 跳过的内容：
   *   - 空值（null / undefined / 空字符串 / 空白）
   *   - 列名缺失（空标题自动 fallback col_N）
   */
  private serializeRowAsText(row: Record<string, unknown>): string {
    const parts: string[] = []
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue
      if (typeof value === 'string' && value.trim() === '') continue
      // ⚠️ Date / Excel 数字时间戳 → YYYY-MM-DD，否则 LLM 检索日期相关问题会全 miss
      parts.push(`${key}: ${this.stringifyCellValue(value)}`)
    }
    return parts.join('; ')
  }

  /**
   * 【P3-2】行级自然语言化：把单行 Excel/CSV 转成"带语义上下文的完整段落"。
   *
   * 输入示例：
   *   row = { 部门: '研发', 人数: 42, 月份: '2025-03' }
   *   sheetName = '员工统计'
   *   rowIndex = 3
   *
   * 输出：
   *   【员工统计】第 3 行：部门 = 研发；人数 = 42；月份 = 2025-03
   *
   * 与旧版 serializeRowAsText 区别：
   *   - 加了 sheet 标题前缀 + 行号定位
   *   - 用 " = " 分隔键值（vs 旧的 ": "），让 LLM 更明确"键值对"语义
   *   - 整行一句话，便于客户端提问"研发部门多少人"时直接命中整段
   */
  private serializeRowAsNaturalLanguage(
    row: Record<string, unknown>,
    sheetName: string,
    rowIndex: number,
  ): string {
    const parts: string[] = []
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue
      if (typeof value === 'string' && value.trim() === '') continue
      parts.push(`${key} = ${this.stringifyCellValue(value)}`)
    }
    const kv = parts.join('；')
    return `【${sheetName}】第 ${rowIndex} 行：${kv}`
  }

  /**
   * 单个单元格值 → 字符串。
   * 处理顺序：Date 对象 → 数字（带 Excel 时间戳识别） → 富文本 → 其他
   */
  private stringifyCellValue(value: unknown): string {
    if (value instanceof Date) {
      return this.formatDate(value)
    }
    if (typeof value === 'number' && this.looksLikeExcelDateSerial(value)) {
      // Excel 时间戳：1900-01-01 起的天数（实际偏移 1899-12-30，含 1900 闰年 bug）
      const ms = (value - 25569) * 86400 * 1000 // 25569 = 1970-01-01 的 Excel 序列号
      const d = new Date(ms)
      if (!isNaN(d.getTime())) return this.formatDate(d)
    }
    if (typeof value === 'object' && value !== null) {
      // 富文本 { richText: [{ text, font? }, ...] }
      const rich = (value as any).richText
      if (Array.isArray(rich)) {
        return rich.map((p: any) => String(p.text ?? '')).join('')
      }
      // 公式 { formula, result } —— 已在外层 .result 提取，这里兜底
      if ('result' in (value as any)) {
        return this.stringifyCellValue((value as any).result)
      }
    }
    return String(value)
  }

  /**
   * Excel 时间戳范围：约 1（1900-01-01）到 100000+（2173 年以后）
   * 排除明显不是日期的小整数（如 1-31 可能被误识为日期）
   * 策略：只在数字 ≥ 10000（约 1927 年）时认为是日期
   */
  private looksLikeExcelDateSerial(n: number): boolean {
    return Number.isFinite(n) && n >= 10000 && n < 200000
  }

  /**
   * Date → "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"（带非零时间）
   */
  private formatDate(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0')
    const y = d.getFullYear()
    const m = pad(d.getMonth() + 1)
    const day = pad(d.getDate())
    const hh = pad(d.getHours())
    const mm = pad(d.getMinutes())
    // 0 点整不带时间，避免噪音
    if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
      return `${y}-${m}-${day}`
    }
    return `${y}-${m}-${day} ${hh}:${mm}`
  }

  /**
   * 解析 Excel（多 sheet）→ 行级 Document[]
   * 走 ExcelJS（流式 + 保留单元格类型 + 多 sheet 友好）
   *
   * 【P3-2】返回值改为 rowObjects（原始对象数组），不再预序列化为 KV 字符串；
   * 自然语言化在 parseStructuredToVectorStore 里做（带 sheet 标题 + 行号上下文）
   */
  private async parseExcelRows(
    file: Express.Multer.File,
  ): Promise<{ sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[] }[]> {
    const workbook = new ExcelJS.Workbook()
    // multer 的 buffer 是 Buffer<ArrayBufferLike>，ExcelJS 期望 Node 旧版 Buffer，转 any 绕过 TS 5.7+ 泛型差异
    await workbook.xlsx.load(file.buffer as any)
    const result: { sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[] }[] = []

    workbook.eachSheet((worksheet) => {
      const sheetName = worksheet.name || 'Sheet'
      // ExcelJS 第 1 行默认当表头；空 sheet 直接跳过
      if (worksheet.rowCount < 2) return

      // 取第 1 行做 header
      const headerRow = worksheet.getRow(1)
      const rawColumns: string[] = []
      for (let c = 1; c <= headerRow.cellCount; c++) {
        const cell = headerRow.getCell(c)
        const v = cell.value
        let colName: string
        if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
          colName = `col_${c}`
        } else {
          colName = String(v).trim()
        }
        rawColumns.push(colName)
      }

      // 遍历 data row（第 2 行起）→ rowObjects[i] 对应 sheet 的第 i+2 行
      const rowObjects: Record<string, unknown>[] = []
      for (let r = 2; r <= worksheet.rowCount; r++) {
        const dataRow = worksheet.getRow(r)
        const obj: Record<string, unknown> = {}
        let hasAnyValue = false
        for (let c = 1; c <= rawColumns.length; c++) {
          const cell = dataRow.getCell(c)
          let v: unknown = cell.value
          // ExcelJS 对 formula 单元格返回 { formula, result }，解出 result
          if (v && typeof v === 'object' && 'result' in (v as any)) {
            v = (v as any).result
          }
          // 跳过空 cell 保持稀疏行
          if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
            obj[rawColumns[c - 1]] = null
          } else {
            obj[rawColumns[c - 1]] = v
            hasAnyValue = true
          }
        }
        if (hasAnyValue) rowObjects.push(obj)
      }

      if (rowObjects.length > 0) {
        result.push({ sheetName, columns: rawColumns, rowObjects })
      }
    })

    if (result.length === 0) {
      throw new Error('Excel 文件未解析到任何有效行（无表头或全部为空）')
    }
    return result
  }

  /**
   * 解析 CSV（xlsx 库同样支持）→ 行级 Document[]
   * 只取第一个 sheet（CSV 本就是单表）
   */
  private parseCsvRows(
    file: Express.Multer.File,
  ): { sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[] }[] {
    // file.buffer 是 Buffer<ArrayBufferLike>，而 xlsx 期望 Node 旧版 Buffer。
    // multer 的 buffer 本质是同一段 ArrayBuffer，转一道 any 绕过 TS 5.7+ Buffer 泛型差异。
    const wb = XLSX.read(file.buffer as any, { type: 'buffer' })
    const firstSheetName = wb.SheetNames[0]
    if (!firstSheetName) throw new Error('CSV 文件无有效内容')
    const sheet = wb.Sheets[firstSheetName]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null })
    if (rows.length === 0) throw new Error('CSV 文件未解析到任何有效行')

    // 列名从第一行 keys 取，空名 fallback col_N
    const firstRow = rows[0] || {}
    const columns = Object.keys(firstRow).map((k, i) => (k && k.trim() ? k.trim() : `col_${i + 1}`))
    // 【P3-2】保留原始对象数组，不再预序列化为 KV 字符串；自然语言化在 parseStructuredToVectorStore 里做
    const rowObjects = rows.filter((r) => {
      // 过滤全空行
      return Object.values(r).some((v) => v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== ''))
    })
    if (rowObjects.length === 0) throw new Error('CSV 文件未解析到任何有效行（全部为空）')
    return [{ sheetName: firstSheetName, columns, rowObjects }]
  }

  /**
   * 结构化文件 → 行级 chunk → Embedding → Qdrant
   *
   * 【P3-2】每行一个 chunk，不再用 splitter 跨越行边界切：
   *   - 每个 chunk 是"【Sheet名】第 N 行：列1 = 值1；列2 = 值2..." 完整自然语言段落
   *   - metadata.rowIndices 精确到该行（不再是全 sheet 行号列表）
   *   - 召回后 LLM 看到的不是"列名:列名"重复，而是完整的行级描述
   *
   * 行内容过长（> 800 字符）的兜底：用 splitter 按句号/分号切多段，每段继承 rowIndices
   */
  private async parseStructuredToVectorStore(
    file: Express.Multer.File,
    fileId: number,
    originalName: string,
    userId: number, // 【P0-1】写入 Qdrant metadata
  ): Promise<void> {
    const ext = path.extname(originalName).toLowerCase()
    let sheets: { sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[] }[]

    if (ext === '.csv') {
      sheets = this.parseCsvRows(file)
    } else {
      // .xlsx / .xls 一律走 ExcelJS
      sheets = await this.parseExcelRows(file)
    }

    const documents: Document[] = []
    let globalChunkIdx = 0
    // 兜底 splitter：单行内容 > 800 字符时按句号/分号切，避免超长 chunk 拉低 embedding 质量
    const longRowSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 800,
      chunkOverlap: 0,
      separators: ['。', '；', '\n', ' ', ''],
    })

    for (const { sheetName, columns, rowObjects } of sheets) {
      // 【P3-3】先调 LLM 生成该 sheet 摘要，作为额外首 chunk
      const sheetSummary = await this.generateSheetSummary(sheetName, columns, rowObjects)
      if (sheetSummary) {
        documents.push(
          new Document({
            pageContent: `【${sheetName} 摘要】${sheetSummary}`,
            metadata: {
              fileId,
              fileName: originalName,
              chunkIndex: globalChunkIdx++,
              ragTrack: 'sql',
              sheetName,
              columns,
              rowIndices: [], // 摘要不绑具体行号
              chunkType: 'summary',
              userId, // 【P0-1】Qdrant metadata 硬隔离
            },
          }),
        )
      }
      // rowObjects[i] 对应原始 sheet 的"第 i + 2 行"（第 1 行是表头）
      const rowChunkIndices: number[] = [] // 记录每个 row 的 chunkIndex，供 FAQ 反向引用
      for (let i = 0; i < rowObjects.length; i++) {
        const rowIndex = i + 2
        const rowText = this.serializeRowAsNaturalLanguage(rowObjects[i], sheetName, rowIndex)
        // 短行直接 1 chunk；超长行兜底切
        const subChunks =
          rowText.length <= 800 ? [rowText] : await longRowSplitter.splitText(rowText)
        for (const sub of subChunks) {
          const thisIdx = globalChunkIdx++
          documents.push(
            new Document({
              pageContent: sub,
              metadata: {
                fileId,
                fileName: originalName,
                chunkIndex: thisIdx,
                ragTrack: 'sql',
                sheetName,
                columns,
                // 【P3-2】精确行号（单行；超长行兜底切时所有 sub-chunk 都属于该行）
                rowIndices: [rowIndex],
                userId, // 【P0-1】Qdrant metadata 硬隔离
              },
            }),
          )
          if (subChunks.length === 1) rowChunkIndices.push(thisIdx) // 仅"1 行 = 1 chunk"时记录
        }
      }

      // 【P3-4】为每个"行级 chunk"生成 FAQ 辅助检索点
      // SQL 轨道每行都是结构化事实，FAQ 问题可以更具体（如"研发部门多少人"）
      // 每行生成 FAQ 让用户能用自然语言问题精准命中
      // 数量限制：每个 sheet 最多 5 个 FAQ（覆盖核心行）
      const sqlOriginalCount = documents.length
      let sqlFaqCount = 0
      const MAX_FAQ_PER_SHEET = 5
      for (const doc of documents) {
        if (sqlFaqCount >= MAX_FAQ_PER_SHEET) break
        if ((doc.metadata as any)?.chunkType) continue // 跳过已有 chunkType 的（如 summary）
        const faqs = await this.generateChunkFAQs(
          doc.pageContent,
          `${originalName} / ${(doc.metadata as any)?.sheetName}`,
        )
        if (faqs.length === 0) continue
        documents.push(
          new Document({
            pageContent: `【FAQ】${faqs.join('\n')}`,
            metadata: {
              fileId,
              fileName: originalName,
              chunkIndex: (doc.metadata as any)?.chunkIndex ?? globalChunkIdx++,
              ragTrack: 'sql',
              sheetName: (doc.metadata as any)?.sheetName,
              columns: (doc.metadata as any)?.columns,
              rowIndices: (doc.metadata as any)?.rowIndices ?? [],
              chunkType: 'faq',
              userId, // 【P0-1】Qdrant metadata 硬隔离
            },
          }),
        )
        sqlFaqCount++
      }
      this.logger.log(
        `[P3-4 FAQ] fileId=${fileId} sheet=${sheetName} 生成 ${documents.length - sqlOriginalCount} 条 FAQ 辅助 chunks`,
      )
    }

    if (documents.length === 0) {
      throw new Error('结构化文件解析后未产出可向量化文档')
    }

    // 🔧 先用一个 dummy 文本探测当前 embedding 模型的真实维度
    const probeVec = await this.embeddings.embedQuery('__dim_probe__')
    await this.ensureQdrantCollection(probeVec.length)

    await QdrantVectorStore.fromDocuments(documents, this.embeddings, {
      url: this.qdrantUrl,
      collectionName: this.collectionName,
    })

    this.logger.log(
      `[SQL轨道] fileId=${fileId} 完成行级向量化：${sheets.length} sheet / ${sheets.reduce((acc, s) => acc + s.rowObjects.length, 0)} 行 / ${documents.length} chunk`,
    )
  }

  /**
   * 删除一个语料资产：必须保证 DB 行 / Qdrant 向量 / 磁盘文件三处一致。
   *
   * 顺序：先 Qdrant → 再磁盘 → 最后 DB 行（DB 是真源，删了 DB 后 Qdrant/disk 的孤儿无法回追）
   * 容忍：Qdrant 与磁盘任一步失败时记录日志但继续往下走（避免一处失败让用户数据卡在"半删除"状态）
   *
   * 注意：仅对 isFolder=0 的文件节点生效。目录删除由调用方保证不传目录 id。
   */
  async deleteFileEntity(
    id: number,
    userId: number,
    isSuperAdmin: boolean,
  ): Promise<{ ok: boolean; reason?: string }> {
    // 【P0-1】先按 userId 校验归属（超管跳过），防止越权删除
    const record = await this.getOwnedFile(id, userId, isSuperAdmin)
    if (!record) return { ok: false, reason: '文件不存在或无权访问' }
    if (record.isFolder === 1) return { ok: false, reason: '不能删除文件夹' }

    // 2) 删 Qdrant 向量（按 metadata.fileId 过滤）
    try {
      await this.deleteQdrantPointsByFileId(id)
      this.logger.log(`[RAG 删除] Qdrant 清理完成 fileId=${id}`)
    } catch (err) {
      this.logger.error(`[RAG 删除] Qdrant 清理失败 fileId=${id}`, err as any)
      // 不阻断后续清理
    }

    // 3) 删磁盘文件
    if (record.fileUrl) {
      const m = record.fileUrl.match(/\/rag\/([^/?#]+)$/)
      if (m) {
        const diskFilename = m[1]
        const absPath = path.join(RAG_UPLOAD_DIR, diskFilename)
        try {
          const fs = await import('fs')
          await fs.promises.unlink(absPath)
          this.logger.log(`[RAG 删除] 磁盘文件清理完成 fileId=${id} path=${absPath}`)
        } catch (err: any) {
          if (err?.code === 'ENOENT') {
            // 文件本来就不在了，记一行 info 即可
            this.logger.log(`[RAG 删除] 磁盘文件已不存在 fileId=${id} path=${absPath}`)
          } else {
            this.logger.error(`[RAG 删除] 磁盘清理失败 fileId=${id} path=${absPath}`, err as any)
          }
        }
      } else {
        this.logger.warn(`[RAG 删除] fileUrl 无法解析 /rag/ 段 fileId=${id} fileUrl=${record.fileUrl}`)
      }
    }

    // 4) 最后删 DB 行（DB 是真源）
    await this.ragFileRepository.delete(id)
    this.logger.log(`[RAG 删除] DB 行清理完成 fileId=${id}`)
    return { ok: true }
  }

  /**
   * 按 metadata.fileId 删除 Qdrant 中的所有相关点
   * 端点：POST {qdrantUrl}/collections/{collectionName}/points/delete
   */
  private async deleteQdrantPointsByFileId(fileId: number, userId?: number): Promise<void> {
    const url = `${this.qdrantUrl.replace(/\/$/, '')}/collections/${this.collectionName}/points/delete`
    // 【P0-1】filter 同时含 fileId + userId（双重保险）：
    //   - fileId：定位具体文件
    //   - userId：防止越权误删他人文件（极端 case：fileId 跨用户复用或请求错位）
    const filter: any = { must: [{ key: 'metadata.fileId', match: { value: fileId } }] }
    if (typeof userId === 'number') {
      filter.must.push({ key: 'metadata.userId', match: { value: userId } })
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter })
    })
    if (r.ok) return
    // 404 通常意味着 collection 不存在（首次清理场景），忽略
    if (r.status === 404) {
      this.logger.log(`[Qdrant] collection ${this.collectionName} 不存在，跳过向量清理`)
      return
    }
    const txt = await r.text()
    throw new Error(`Qdrant delete failed: HTTP ${r.status} ${txt.slice(0, 300)}`)
  }

  /**
   * 【P1-3】拉取 SQL 轨道引用的真实行数据
   * 用于前端引用预览弹窗渲染"迷你表格"：
   *   - 入参: fileId, sheetName, rowIndices (1-based，与 Excel 行号一致)
   *   - 出参: { columns: string[], rows: Array<Record<string, string | number | null>> }
   *
   * 实现：从磁盘重读 xlsx（不重做向量化，只取单元格值）→ 找到 sheet → 按 rowIndex 抽取。
   * Date 单元格友好化（YYYY-MM-DD）与 ETL 阶段保持一致，确保引用预览与召回文案对得上。
   *
   * 注意：只在 ragTrack='sql' 且扩展名是 .xlsx/.xls/.csv 时有意义；其他类型返回空结构。
   */
  async getStructuredRows(
    fileId: number,
    sheetName: string,
    rowIndices: number[],
    userId: number, // 【P0-1】归属校验（防越权引用预览）
    isSuperAdmin: boolean,
  ): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; sheetName: string }> {
    const empty = { columns: [] as string[], rows: [] as Array<Record<string, unknown>>, sheetName }
    if (!Array.isArray(rowIndices) || rowIndices.length === 0) return empty

    // 【P0-1】先校验归属，避免用户 A 通过引用预览拿用户 B 的 Excel 行数据
    const record = await this.getOwnedFile(fileId, userId, isSuperAdmin)
    if (!record) throw new Error('文件不存在或无权访问')
    if (record.ragTrack !== RagTrackEnum.SQL) {
      return empty // 非 SQL 轨道没"行"概念
    }

    // 从 DB 记录的 fileUrl 提取物理路径（fileUrl = `${serveRoot}/rag/${diskFilename}`）
    // 不能依赖 controller 的 in-memory state（this.serveRoot 私有），
    // 反查 fileUrl → 取 /rag/ 之后的文件名 → 拼成绝对路径
    const fileUrl = record.fileUrl || ''
    const m = fileUrl.match(/\/rag\/([^/?#]+)$/)
    if (!m) {
      // 退化：fileUrl 找不到 rag segment，按 record.fileName 路径试
      return empty
    }
    const diskFilename = m[1]
    const absPath = path.join(RAG_UPLOAD_DIR, diskFilename)
    const ext = path.extname(record.fileName || '').toLowerCase()

    // 读 buffer
    const fs = await import('fs')
    let buffer: Buffer
    try {
      buffer = await fs.promises.readFile(absPath)
    } catch {
      throw new Error(`文件已离线：${absPath}`)
    }

    let columns: string[] = []
    const rows: Array<Record<string, unknown>> = []

    if (ext === '.csv') {
      const wb = XLSX.read(buffer as any, { type: 'buffer' })
      const target = wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0]
      if (!target) return empty
      const sheet = wb.Sheets[target]
      const arr = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null })
      if (arr.length === 0) return empty
      // 列名：第一行 keys
      const first = arr[0] || {}
      columns = Object.keys(first).map((k, i) => (k && k.trim() ? k.trim() : `col_${i + 1}`))
      // 唯一列名（去重）
      columns = this.dedupeColumns(columns)
      // rowIndices 1-based → arr 是 0-based
      for (const r of rowIndices) {
        const idx = r - 2 // 第 1 行是表头 → 数据从 index 0 开始；r=2 对应 arr[0]
        if (idx >= 0 && idx < arr.length) {
          const obj: Record<string, unknown> = {}
          columns.forEach((c, i) => {
            const origKey = Object.keys(first)[i]
            obj[c] = this.stringifyCellValue(arr[idx]?.[origKey])
          })
          rows.push(obj)
        }
      }
    } else {
      // .xlsx / .xls
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buffer as any)
      const ws = wb.getWorksheet(sheetName)
      if (!ws) return empty
      // 表头（第 1 行）
      const headerRow = ws.getRow(1)
      const rawCols: string[] = []
      for (let c = 1; c <= headerRow.cellCount; c++) {
        const v = headerRow.getCell(c).value
        const col = v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
          ? `col_${c}`
          : String(v).trim()
        rawCols.push(col)
      }
      columns = this.dedupeColumns(rawCols)
      // 按 rowIndices 取行
      for (const r of rowIndices) {
        if (r < 1) continue
        const row = ws.getRow(r)
        if (!row) continue
        const obj: Record<string, unknown> = {}
        for (let c = 1; c <= columns.length; c++) {
          let v: unknown = row.getCell(c).value
          // 公式 → result
          if (v && typeof v === 'object' && 'result' in (v as any)) v = (v as any).result
          // 复对象：富文本提取
          obj[columns[c - 1]] = this.stringifyCellValue(v)
        }
        rows.push(obj)
      }
    }

    return { columns, rows, sheetName }
  }

  /**
   * ExcelJS 解析时如果表头有重名列，Qdrant metadata.columns 是直接保留重名。
   * 预览时为了 el-table 能 v-for，需要把重名列改名 col_2 / col_3 ...
   * 注意：这只是"展示用"的去重，不影响 ETL 召回的 metadata.columns。
   */
  private dedupeColumns(cols: string[]): string[] {
    const seen = new Map<string, number>()
    return cols.map((c) => {
      const count = seen.get(c) || 0
      seen.set(c, count + 1)
      return count === 0 ? c : `${c}_${count + 1}`
    })
  }

  // ============================================================================
  // 💬【P1-2】会话 & 消息 CRUD
  // ============================================================================

  /**
   * 列出当前用户的会话（按更新时间倒序）
   */
  async listSessions(userId: number): Promise<RagSessionEntity[]> {
    return await this.ragSessionRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
      take: 50,
    })
  }

  /**
   * 创建一个空会话
   */
  async createSession(userId: number, title?: string): Promise<RagSessionEntity> {
    const session = this.ragSessionRepository.create({
      userId,
      title: title?.trim() || '新会话',
    })
    return await this.ragSessionRepository.save(session)
  }

  /**
   * 校验会话归属当前用户，返回会话或 null
   */
  async getOwnedSession(sessionId: number, userId: number): Promise<RagSessionEntity | null> {
    const s = await this.ragSessionRepository.findOne({ where: { id: sessionId } })
    if (!s || s.userId !== userId) return null
    return s
  }

  /**
   * 【P0-1】按 userId 校验文件归属，超管跳过过滤
   * 样板来自 getOwnedSession；区别是会处理 SUPER_ADMIN 旁路
   */
  private async getOwnedFile(
    fileId: number,
    userId: number,
    isSuperAdmin: boolean,
  ): Promise<RagFileEntity | null> {
    if (isSuperAdmin) {
      return this.ragFileRepository.findOneBy({ id: fileId })
    }
    return this.ragFileRepository.findOne({ where: { id: fileId, userId } })
  }

  /**
   * 拉取一个会话的全部消息（按时间正序）
   */
  async listMessages(sessionId: number): Promise<RagMessageEntity[]> {
    return await this.ragMessageRepository.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    })
  }

  /**
   * 重命名会话
   */
  async renameSession(sessionId: number, userId: number, title: string): Promise<boolean> {
    const owned = await this.getOwnedSession(sessionId, userId)
    if (!owned) return false
    await this.ragSessionRepository.update(sessionId, { title: title.trim() || '新会话' })
    return true
  }

  /**
   * 删除会话（级联删消息）
   */
  async deleteSession(sessionId: number, userId: number): Promise<boolean> {
    const owned = await this.getOwnedSession(sessionId, userId)
    if (!owned) return false
    await this.ragSessionRepository.delete(sessionId)
    return true
  }

  /**
   * 把一轮对话（user + assistant + citations）写库
   */
  private async appendTurn(
    sessionId: number,
    userContent: string,
    assistantContent: string,
    citations: CitationDto[] | null,
  ): Promise<void> {
    // user 消息
    await this.ragMessageRepository.save(
      this.ragMessageRepository.create({
        sessionId,
        role: 'user',
        content: userContent,
        citations: null,
      }),
    )
    // assistant 消息
    await this.ragMessageRepository.save(
      this.ragMessageRepository.create({
        sessionId,
        role: 'assistant',
        content: assistantContent,
        citations,
      }),
    )
    // 刷新会话 updated_at
    await this.ragSessionRepository.update(sessionId, { updatedAt: new Date() })

    // 若标题仍是默认 "新会话"，用首条用户消息前 24 字自动命名
    const session = await this.ragSessionRepository.findOne({ where: { id: sessionId } })
    if (session && session.title === '新会话') {
      const auto = userContent.replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话'
      await this.ragSessionRepository.update(sessionId, { title: auto })
    }
  }

  /**
   * 拼装多轮对话上下文（取最近 N 轮）
   */
  private async buildHistoryContext(sessionId: number, limit = 6): Promise<HistoryTurn[]> {
    const all = await this.listMessages(sessionId)
    const tail = all.slice(-limit)
    return tail.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  }

  // ============================================================================
  // 🔥【P1-2】流式问答（接入会话持久化 + 多轮上下文）
  // ============================================================================

  /**
   * Qdrant 相似度检索助手
   * @param question  用户问题
   * @param fileIds   限定检索的文件 id 列表。
   *                  - null = 全库检索（不应用 fileId 过滤）—— P1-6 新增
   *                  - []   = 不检索（外部应跳过调用）
   *                  - [n1, n2, ...] = 仅检索这些文件下的 chunk
   */
  private async vectorSearch(
    question: string,
    fileIds: number[] | null,
    userId: number, // 【P0-1】硬隔离：所有 Qdrant 检索必须按 userId 过滤
    topK: number = 4, // 【P2-1】默认 4；executeDualTrackQuery 调 20 再 rerank 截到 4
  ): Promise<{ doc: Document; score: number }[]> {
    try {
      const vectorStore = await QdrantVectorStore.fromExistingCollection(this.embeddings, {
        url: this.qdrantUrl,
        collectionName: this.collectionName,
      })
      // 【P0-1】filter 必须含 metadata.userId（企业 SaaS 硬隔离）：
      //   - 即便 fileIds 为 null（全库检索 P1-6 模式），userId 仍然过滤当前用户的数据
      //   - 多 fileId 用 should（"或"），单 fileId 用 match.value
      const userIdClause = { key: 'metadata.userId', match: { value: userId } }
      const filter: any = { must: [userIdClause] }
      if (Array.isArray(fileIds) && fileIds.length > 0) {
        if (fileIds.length === 1) {
          filter.must.push({ key: 'metadata.fileId', match: { value: fileIds[0] } })
        } else {
          // 多 fileId：should 包在 must 里——"userId 是 X 且 fileId 是列表里任意一个"
          filter.must.push({
            should: fileIds.map((id) => ({ key: 'metadata.fileId', match: { value: id } })),
          })
        }
      }
      const raw = await vectorStore.similaritySearchWithScore(question, topK, filter as any)
      // 【P1-1】上报向量检索指标 + top-1 相似度
      const topScore = raw.length > 0 ? raw[0][1] : null
      this.metrics.recordVectorSearch(topScore)
      return raw.map(([doc, score]) => ({ doc, score }))
    } catch (vErr) {
      this.logger.error('[Qdrant 相似度检索失败]', vErr as any)
      this.metrics.recordEmbeddingError('embedQuery') // Qdrant 失败一并记入
      return []
    }
  }

  async executeDualTrackQuery(
    question: string,
    sessionId: string | number | null,
    sources: number[],
    res: Response,
    userId: number,
    isSuperAdmin: boolean, // 【P0-1】超管跳过 userId 过滤
    signal?: AbortSignal,
  ): Promise<void> {
    // 1) 解析/创建会话
    let ownedSession: RagSessionEntity | null = null
    if (sessionId) {
      const sid = Number(sessionId)
      if (!Number.isNaN(sid)) {
        ownedSession = await this.getOwnedSession(sid, userId)
      }
    }
    if (!ownedSession) {
      ownedSession = await this.createSession(userId, question.slice(0, 24))
      // 把新会话 ID 通过 SSE 第一帧推给前端
      res.write(
        `data: ${JSON.stringify({ code: 'session', data: { id: ownedSession.id, title: ownedSession.title } })}\n\n`,
      )
    }

    // 2) 拼装多轮上下文
    const history = await this.buildHistoryContext(ownedSession.id, 6)

    res.write(`data: ${JSON.stringify({ code: 200, data: '正在检索关联知识库资产...\n' })}\n\n`)
    let citations: CitationDto[] = []
    let fullAnswer = ''

    try {
      // 【P2-1】HyDE：用 LLM 生成假设性回答喂给向量检索（提升召回率）
      let retrievalQuery = question
      const hydeT0 = Date.now()
      try {
        const hydeAnswer = (await this.safeLlmInvoke(this.buildHydePrompt(question))) as any
        const hydeText = (typeof hydeAnswer?.content === 'string' ? hydeAnswer.content : '').trim()
        if (hydeText) {
          // 拼接原问题 + 假设性回答（业界标准做法：检索方向从"问题 ↔ 答案"变成"假设答案 ↔ 真答案"）
          retrievalQuery = `${question}

${hydeText}`
          this.metrics.recordHyde('success', (Date.now() - hydeT0) / 1000)
        }
      } catch (err: any) {
        this.logger.warn(`[P2-1 HyDE] LLM 调用失败，使用原 query: ${err?.message || err}`)
        this.metrics.recordHyde('failed', 0)
      }

      // 【P2-1】召回 topK=20（多召回给 rerank 留余量）
      const RECALL_TOPK = 20
      const FINAL_TOPK = 4
      let relevantDocs: { doc: Document; score: number }[] = []
      if (sources && sources.length > 0) {
        const effectiveFileIds = await this.expandAssetIdsToFileIds(sources, userId, isSuperAdmin)
        if (effectiveFileIds.length > 0) {
          relevantDocs = await this.vectorSearch(retrievalQuery, effectiveFileIds, userId, RECALL_TOPK)
        }
      } else {
        relevantDocs = await this.vectorSearch(retrievalQuery, null, userId, RECALL_TOPK)
      }

      // 【P2-1】cross-encoder 重排：取相关度 top FINAL_TOPK
      if (relevantDocs.length > FINAL_TOPK) {
        const rT0 = Date.now()
        try {
          // rerank 需要 { pageContent: string }[]，从 doc.pageContent 提取
          const candidates = relevantDocs.map((d) => ({ pageContent: d.doc.pageContent }))
          const reranked = await this.reranker.rerank(question, candidates, FINAL_TOPK)
          relevantDocs = reranked.map((r) => relevantDocs[r.idx])
          this.metrics.recordRerank('success', (Date.now() - rT0) / 1000)
        } catch (err: any) {
          this.logger.warn(`[P2-1 Rerank] 失败，回退到 top-${FINAL_TOPK}: ${err?.message || err}`)
          relevantDocs = relevantDocs.slice(0, FINAL_TOPK)
          this.metrics.recordRerank('skipped', 0)
        }
      }

      if (relevantDocs.length === 0) {
        res.write(
          `data: ${JSON.stringify({ code: 200, data: '未在参考资料中发现线索，转由大语言模型泛化解答：\n\n' })}\n\n`,
        )
        fullAnswer = await this.streamLlmWithHistory(history, question, null, res, signal)
      } else {
        citations = relevantDocs.map(({ doc, score }) => ({
          fileId: doc.metadata?.fileId,
          fileName: doc.metadata?.fileName || '未知来源',
          chunkIndex: doc.metadata?.chunkIndex ?? -1,
          content: (doc.pageContent || '').replace(/\s+/g, ' ').trim().slice(0, 280),
          score: typeof score === 'number' ? Math.max(0, Math.min(1, 1 - score)) : null,
          // 【P1-3】SQL 轨道扩展字段透传给前端
          ragTrack: doc.metadata?.ragTrack || 'vector',
          sheetName: doc.metadata?.sheetName ?? null,
          rowIndices: doc.metadata?.rowIndices ?? null,
          columns: doc.metadata?.columns ?? null,
        }))
        res.write(`data: ${JSON.stringify({ code: 'sources', data: citations })}\n\n`)

        // 【P1-3】SQL 轨道走"行级上下文"格式，长文本维持原样
        // 关键升级：SQL 轨道除了 pageContent，还把 rowIndices + columns 结构化元信息塞进 prompt
        // —— LLM 知道"第几行"、列名是什么，能精准引用（如"华东 A 产品的销量（第 2 行）是 120"）
        const hasSqlTrack = relevantDocs.some((d) => d.doc.metadata?.ragTrack === 'sql')
        const contextText = hasSqlTrack
          ? relevantDocs
              .map(({ doc }) => {
                const m = doc.metadata || {}
                if (!m.sheetName) {
                  return `【参考源: ${m.fileName}】\n${doc.pageContent}`
                }
                // 🔧 关键：把列名 + 行号范围 + 行级内容一起拼，LLM 才知道"哪个单元格在第几行"
                const cols = Array.isArray(m.columns) && m.columns.length > 0 ? m.columns.join(' | ') : '(无列名)'
                const rowList = Array.isArray(m.rowIndices) && m.rowIndices.length > 0
                  ? m.rowIndices.length <= 20
                    ? m.rowIndices.join(', ')
                    : `${m.rowIndices.slice(0, 8).join(', ')} … ${m.rowIndices.slice(-3).join(', ')} (共 ${m.rowIndices.length} 行)`
                  : '(无行号)'
                return `【表格行级参考: ${m.fileName} / ${m.sheetName}】
  - 列名: ${cols}
  - 涉及行号 (Excel 1-based): ${rowList}
  - 行级数据:
${doc.pageContent}`
              })
              .join('\n\n')
          : relevantDocs.map(({ doc }) => `【参考源: ${doc.metadata?.fileName}】\n${doc.pageContent}`).join('\n\n')

        const systemPrompt = hasSqlTrack
          ? `你是一款高级 AI 助手，专精于结构化表格的精准问答。回答规范：
1) 严格基于下方"表格行级参考"中的字段值与行号进行精确计算，不要凭空捏造数字。
2) 涉及具体单元格时，引用形式形如「{列名}={值}（第 {行号} 行 / {sheetName}）」，让用户能精准回溯。
3) 涉及统计/求和/比较时，先列出你引用的行号，再给出计算过程，最后给结论。
4) 若问题无法在参考表格中找到答案，明确告知"在所引用的表格行中未找到依据"，禁止臆测。

【参考资料】:
${contextText}`
          : `你是一款高级 AI 助手。请严格基于参考内容回答问题。

【参考资料】:
${contextText}`

        res.write(
          `data: ${JSON.stringify({
            code: 200,
            data: hasSqlTrack
              ? '已定位到结构化表格行级数据，深度运算中：\n\n'
              : '已为您提炼关联企业物料，深度解答中：\n\n',
          })}\n\n`,
        )
        fullAnswer = await this.streamLlmWithHistory(history, question, systemPrompt, res, signal)
      }
    } catch (err) {
      // 【P2-1】客户端主动 abort 不视作错误，安静退出即可
      const aborted = (err as any)?.name === 'AbortError' || signal?.aborted === true
      if (aborted) {
        this.logger.log(`[RAG] 流式被客户端中止，未返回完整内容 sessionId=${ownedSession.id} partialLen=${fullAnswer.length}`)
      } else {
        this.logger.error('[RAG 运行流内部异常捕捉并安全消化]', err)
        const errorDetails = err instanceof Error ? err.message : '大模型集群响应超时'
        // 客户端已断开就别再 write 了（会抛 ERR_STREAM_DESTROYED）
        if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify({ code: 500, data: `\n[系统决策阻断]: ${errorDetails}` })}\n\n`)
          } catch { /* ignore */ }
        }
      }
    } finally {
      // 【P2-1】abort 场景：user 消息永远要存（用户确实问过这个问题，要保留历史），
      // assistant 只在有内容时才存（避免历史里出现"问了但没答"的幽灵空气泡）
      const abortedEmpty = signal?.aborted && fullAnswer.length === 0
      try {
        if (abortedEmpty) {
          await this.ragMessageRepository.save(
            this.ragMessageRepository.create({
              sessionId: ownedSession.id,
              role: 'user',
              content: question,
              citations: null,
            }),
          )
          await this.ragSessionRepository.update(ownedSession.id, { updatedAt: new Date() })
          this.logger.log(`[RAG] abort+空内容：仅持久化 user 消息 sessionId=${ownedSession.id}`)
        } else {
          await this.appendTurn(ownedSession.id, question, fullAnswer, citations)
        }
      } catch (persistErr) {
        this.logger.error(`[RAG 会话持久化失败] sessionId=${ownedSession.id}`, persistErr as any)
      }
      // 【P2-1】res 已 end 时不要重复写
      if (!res.writableEnded) {
        try {
          res.write(`data: ${JSON.stringify(ResultData.ok(''))}\n\n`)
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * 【P2-1】把历史 + 当前问题拼成 LangChain messages，调用 LLM 流式输出并拼接完整文本
   *
   * 接受可选的 AbortSignal：客户端断开连接时 controller 触发 abort，LangChain 的
   * `llm.stream(messages, { signal })` 会抛 AbortError 终止上游 token 拉取，避免
   * 浪费 LLM 配额（继续推完的 token 会被 res.write 失败吞掉，纯亏钱）。
   *
   * 同时循环内主动 check `signal.aborted` 兜底：某些 LangChain 版本不一定把
   * signal 传到所有底层 SDK，遇到 chunk 写入 res 失败时立刻退出。
   */
  private async streamLlmWithHistory(
    history: HistoryTurn[],
    question: string,
    systemPrompt: string | null,
    res: Response,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) return ''
    const messages: Array<['system' | 'human' | 'assistant', string]> = []
    if (systemPrompt) messages.push(['system', systemPrompt])
    for (const turn of history) {
      messages.push([turn.role === 'user' ? 'human' : 'assistant', turn.content])
    }
    messages.push(['human', question])

    const responseStream = await this.llm.stream(messages as any, { signal } as any)
    let full = ''
    for await (const chunk of responseStream) {
      if (signal?.aborted) {
        this.logger.log(`[RAG] 流式 chunk 循环中检测到 abort，停止读取 LLM 后续 token（已累积 ${full.length} 字符）`)
        break
      }
      const content = typeof chunk === 'string' ? chunk : (chunk as any).content || ''
      if (content) {
        full += content
        try {
          res.write(`data: ${JSON.stringify({ code: 200, data: content })}\n\n`)
        } catch (writeErr) {
          // res 已被对端关闭（abort 后内核会触发 close 事件），res.write 抛错直接退出
          this.logger.warn(`[RAG] res.write 失败（客户端可能已断开），提前终止流: ${(writeErr as any)?.message}`)
          break
        }
      }
    }
    return full
  }
}

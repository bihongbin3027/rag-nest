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
import { QdrantHybridProvider } from './qdrant-hybrid.provider'
import {
  detectHeaderRow,
  buildHeaderColumns,
  dedupeColumns,
  preprocessMarkdownTables,
} from './parse-header.util'

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
    private readonly hybridProvider: QdrantHybridProvider, // 【P1-3】BM25 + Dense + RRF 混合检索
  ) {
    const apiKey = this.configService.get<string>('ai.llm.apiKey')
    const baseURL = this.configService.get<string>('ai.llm.baseURL')
    const chatModel = this.configService.get<string>('ai.llm.chatModel') || 'MiniMax-Text-01'
    const embeddingModel = this.configService.get<string>('ai.llm.embeddingModel') || 'embo-01'
    this.qdrantUrl = this.configService.get<string>('ai.qdrant.url')
    this.collectionName = this.configService.get<string>('ai.qdrant.collectionName')

    this.llm = new ChatOpenAI({
      apiKey,
      configuration: { baseURL },
      modelName: chatModel,
      // 【P0-5】温度从配置读取（默认 0）
      // - RAG 严谨场景必须用 0，否则关键数字会"自由发挥"5%
      // - dev.yml 默认 0；如需调高（如生成摘要），显式覆盖 yml
      temperature: this.configService.get<number>('ai.llm.temperature') ?? 0,
      streaming: true,
    })
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
      let fileMtime: Date | null = null
      try {
        const stat = await import('fs').then((m) => m.promises.stat(filePath))
        ;(file as any).size = stat.size
        fileMtime = stat.mtime
      } catch {
        /* ignore */
      }

      // 【P1-5】计算文件 sha256 用于重传去重 / 缓存命中
      const crypto = await import('crypto')
      const contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex')

      let etlMeta: { headerRow?: number } = {}
      if (record.ragTrack === RagTrackEnum.SQL) {
        etlMeta = await this.parseStructuredToVectorStore(file, fileId, safeOriginalName, userId)
      } else {
        await this.parseDocumentToVectorStore(file, fileId, userId)
      }

      // 【P1-5】ETL 成功后回写 status + metadata 到 RagFileEntity
      await this.ragFileRepository.update(fileId, {
        vectorStatus: VectorStatusEnum.SUCCESS,
        headerRow: etlMeta.headerRow ?? null,
        contentHash,
        fileMtime,
      })
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

  /**
   * 【P2-1】Contextual Retrieval（Anthropic 2024 风格）
   * 给定整篇文档 + 单个 chunk，用 LLM 生成 50-100 token 的"上下文注释"
   * 然后把 chunk content 改造为 `【上下文】{ctx}\n\n{chunk}`，再入库。
   *
   * 论文数据：可降 49% 检索失败；加 rerank 后降 67%。
   * 成本：每个 chunk 一次 LLM 调用 → ETL 慢 5-10x；建议灰度开启。
   *
   * 失败兜底：返回 null（不改造 chunk，行为等同 P0/P1）
   */
  private async generateChunkContext(
    fullDocText: string,
    chunkText: string,
    fileName: string,
  ): Promise<string | null> {
    if (!chunkText || chunkText.length < 20) return null
    try {
      const prompt = `你是文档上下文标注助手。请基于以下文档全文和当前片段，生成 50-100 字的"上下文注释"，说明该片段在文档中的位置、作用和与全文的关系。注释应让独立看片段的读者能理解它在说什么。

文件：${fileName}
文档全文：
${fullDocText.slice(0, 6000)}${fullDocText.length > 6000 ? '...(截断)' : ''}

当前片段：
${chunkText.slice(0, 1500)}${chunkText.length > 1500 ? '...(截断)' : ''}

直接输出注释内容（中文，50-100 字），不要带"本片段..."等开头、不要用"。"以外的标点结尾。`
      const response: any = await Promise.race([
        this.safeLlmInvoke(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('context 生成超时 10s')), 10000)),
      ])
      const ctx = (typeof response?.content === 'string' ? response.content : String(response?.content || '')).trim()
      if (!ctx || ctx.length < 10) return null
      return ctx.slice(0, 200) // 上限 200 字防 LLM 啰嗦
    } catch (err: any) {
      this.logger.warn(`[P2-1] context 生成失败（跳过）: ${err?.message || err}`)
      return null
    }
  }

  /**
   * 【P2-1】批量给 chunks 加上下文注释（带并发限制 + 灰度开关）
   * @returns 改造后的 chunks（in place 修改 pageContent）
   */
  private async applyContextualRetrieval(
    documents: Document[],
    fullDocText: string,
    fileName: string,
    isSqlTrack: boolean,
  ): Promise<void> {
    const enabled = this.configService.get<boolean>('ai.rag.p2.contextualRetrieval') === true
    if (!enabled) return
    // 限制每次最多 30 个 chunk（避免 LLM 调用爆炸）
    const limit = this.configService.get<number>('ai.rag.p2.contextualRetrievalMaxChunks') ?? 30
    const targets = documents.slice(0, limit)
    this.logger.log(
      `[P2-1] Contextual Retrieval 开启，对 ${targets.length}/${documents.length} 个 chunk 生成上下文`,
    )
    // 并发限制：p-limit 4 避免 LLM API 限流
    const pLimit = (await import('p-limit')).default
    const limitFn = pLimit(4)
    await Promise.all(
      targets.map((doc) =>
        limitFn(async () => {
          const ctx = await this.generateChunkContext(fullDocText, doc.pageContent, fileName)
          if (ctx) {
            // 在 metadata 里也存 ctx，便于引用预览展示
            ;(doc.metadata as any).context = ctx
            doc.pageContent = `<ctx>${ctx}</ctx>\n${doc.pageContent}`
          }
        }),
      ),
    )
  }

  private async parseDocumentToVectorStore(
    file: Express.Multer.File,
    fileId: number,
    userId: number, // 【P0-1】写入 Qdrant metadata
  ): Promise<void> {
    let rawText = ''
    // 【P0-2】PDF 按页保留（用 \f form feed 分隔，pdf-parse 内部约定）
    // 输出形如："【第 1 页】...页 1 内容...\f【第 2 页】...页 2 内容..."
    // 这样 RCTS 切分时仍能保留页码上下文，metadata 也可写入 pageNumber
    let pdfPages: string[] | null = null
    const ext = path.extname(file.originalname).toLowerCase()

    if (ext === '.txt' || ext === '.md') {
      rawText = file.buffer.toString('utf-8')
    } else if (ext === '.pdf') {
      const pdfParser = new PDFParse({ data: file.buffer })
      const pdfData = await pdfParser.getText()
      rawText = pdfData.text
      // 【P0-2】pdf-parse 用 \f (form feed) 分隔页；每页加前缀后重组 rawText
      // 这样 RCTS 切分时每页内容自带 "【第 N 页】" 前缀，LLM 召回后知道是哪一页
      if (rawText.includes('\f')) {
        const pages = rawText.split('\f').map((p) => p.trim()).filter((p) => p.length > 0)
        if (pages.length > 1) {
          pdfPages = pages
          rawText = pages.map((p, i) => `【第 ${i + 1} 页】\n${p}`).join('\n\n')
        }
      }
    } else if (ext === '.docx') {
      const docxData = await mammoth.extractRawText({ buffer: file.buffer })
      rawText = docxData.value
    } else {
      throw new Error(`暂不支持该文件格式: ${ext}`)
    }

    if (!rawText.trim()) throw new Error('语料解析为空')

    // 【P0-2】Markdown 表格预处理：在 RCTS 切分前先解析表格为结构化文本
    // 否则 `| col1 | col2 |` 这种表格会被 `|` 切碎，列名上下文丢失
    if (ext === '.md') {
      rawText = preprocessMarkdownTables(rawText)
    }

    // 【P1-7】chunkSize 配置化（ai.rag.chunk.vectorSize / vectorOverlap）
    // 默认 800/150（VECTOR 通用），旧硬编码 600/100 对中文偏小
    const vectorChunkSize = this.configService.get<number>('ai.rag.chunk.vectorSize') ?? 800
    const vectorOverlap = this.configService.get<number>('ai.rag.chunk.vectorOverlap') ?? 150
    // 【P3-1】md 文档按 markdown 结构切分（标题/段落/代码块边界优先），其余格式保持原 RCTS 行为
    // 痛点：之前 md 走 RCTS 字符切，"## 二级标题" 这种半截会被切断，导致 chunk 嵌入向量偏向"残缺文本"
    // 解决：md 用 RCTS 自定义 separators 列表，按 # ## ### 标题层级优先切，段落/代码块次之
    let chunks: string[]
    if (ext === '.md') {
      const mdSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: vectorChunkSize,
        chunkOverlap: vectorOverlap,
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
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: vectorChunkSize, chunkOverlap: vectorOverlap })
      chunks = await splitter.splitText(rawText)
    }
    // ⚠️ file.originalname 已经被 asyncProcessEtlPipeline 在上游做过 latin1→utf8 解码，
    // 这里不要再解！直接用 file.originalname，否则会被"二次解码"重新打回乱码。
    // 用户报告过的乱码现象 l�����,��6�.xlsx 就是这行 double-decode 造成的。
    // 【P0-2】PDF 反推页码：扫描 chunk 文本中是否含 "【第 N 页】"，命中则把 N 写入 metadata.pageNumber
    const documents = chunks.map((chunkText, index) => {
      const pageMatch = chunkText.match(/【第\s*(\d+)\s*页】/)
      const pageNumber = pageMatch ? Number(pageMatch[1]) : undefined
      return new Document({
        pageContent: chunkText,
        metadata: {
          fileId: fileId,
          fileName: file.originalname,
          chunkIndex: index,
          userId, // 【P0-1】Qdrant metadata 硬隔离
          ...(pageNumber ? { pageNumber } : {}), // 【P0-2】仅 PDF 才有 pageNumber
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

    // 【P2-1】Contextual Retrieval：给每个 chunk 加 LLM 生成的上下文注释
    await this.applyContextualRetrieval(documents, rawText, file.originalname, false)

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

  /**
   * 【P2-2】Multi-Query：将用户问题改写为多个不同视角的检索查询
   * 例：用户问"试用期多久" → ["新员工试用期时长", "劳动合同试用期规定", "公司试用期期限"]
   * 提升长尾 query 召回率（多路 retrieve + RRF 合并）
   */
  private async buildMultiQueries(question: string): Promise<string[]> {
    const count = this.configService.get<number>('ai.rag.p2.multiQueryCount') ?? 3
    try {
      const prompt = `你是检索查询改写助手。请将以下用户问题改写为 ${count} 个不同视角的检索查询，每个查询应：
1. 从不同角度表达相同信息需求（如正式表述、口语表述、关键词表述）
2. 保留核心实体（人名、产品名、术语）
3. 长度 5-20 字
4. 每行一个查询，不要编号

用户问题：${question}

直接输出 ${count} 行查询，不要其他解释。`
      const response: any = await Promise.race([
        this.safeLlmInvoke(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('multi-query 超时 8s')), 8000)),
      ])
      const text = (typeof response?.content === 'string' ? response.content : String(response?.content || '')).trim()
      if (!text) return [question]
      const queries = text
        .split('\n')
        .map((q) => q.replace(/^[\d]+[.、)]\s*/, '').trim())
        .filter((q) => q.length > 0 && q.length <= 50)
        .slice(0, count)
      return queries.length > 0 ? [question, ...queries] : [question]
    } catch (err: any) {
      this.logger.warn(`[P2-2] multi-query 改写失败，使用原 query: ${err?.message || err}`)
      return [question]
    }
  }

  /**
   * 【P3-1 CRAG】Document Grader：LLM 评估每个召回 chunk 的相关性
   * 论文：Corrective Retrieval Augmented Generation (Yan et al. 2024)
   *
   * 单次 LLM 调用评估 N 个文档，输出格式：每行一个标签（RELEVANT/PARTIAL/IRRELEVANT）
   * 比 hard check（关键词重叠率）更精准：能识别"语义相关但字面不重叠"
   *
   * 失败兜底：返回 null（视为全部 RELEVANT，不影响主流程）
   */
  private async gradeDocuments(
    question: string,
    documents: Document[],
  ): Promise<('RELEVANT' | 'PARTIAL' | 'IRRELEVANT')[] | null> {
    if (!documents.length) return null
    try {
      // 截断每个文档到 500 字符（节省 token）
      const docList = documents
        .map((d, i) => `【文档${i + 1}】\n${(d.pageContent || '').slice(0, 500)}`)
        .join('\n\n')
      const prompt = `你是文档相关性评估助手。请评估以下每个文档与用户问题的相关性，每个文档输出一个标签：

- RELEVANT：文档直接包含问题的答案或关键信息
- PARTIAL：文档与问题主题相关但只包含部分信息
- IRRELEVANT：文档与问题无关或主题明显不符

用户问题：${question}

${docList}

请按文档顺序输出 ${documents.length} 行标签，每行只输出一个标签（RELEVANT/PARTIAL/IRRELEVANT），不要其他解释。
例如：
RELEVANT
PARTIAL
IRRELEVANT
RELEVANT`
      const response: any = await Promise.race([
        this.safeLlmInvoke(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('grade 超时 12s')), 12000)),
      ])
      const text = (typeof response?.content === 'string' ? response.content : String(response?.content || '')).trim()
      if (!text) return null
      // 解析每行标签
      const labels = text
        .split('\n')
        .map((l) => l.trim().toUpperCase())
        .filter((l) => l === 'RELEVANT' || l === 'PARTIAL' || l === 'IRRELEVANT')
      if (labels.length === 0) return null
      // 对齐长度：不足补 IRRELEVANT，过多截断
      while (labels.length < documents.length) labels.push('IRRELEVANT')
      return labels.slice(0, documents.length) as ('RELEVANT' | 'PARTIAL' | 'IRRELEVANT')[]
    } catch (err: any) {
      this.logger.warn(`[P3-1 CRAG] grade 失败（跳过）: ${err?.message || err}`)
      return null
    }
  }

  /**
   * 【P2-2】多路 RRF 合并
   * Reciprocal Rank Fusion：对每个 query 的 topK 文档按 1/(k+rank) 加权求和，取 topN
   * @param resultLists 每路 query 的 [{doc, score}] 数组
   * @param topN 最终返回 topN
   * @param k RRF 参数（默认 60，Qdrant 默认）
   */
  private rrfFusion(
    resultLists: { doc: Document; score: number }[][],
    topN: number,
    k: number = 60,
  ): { doc: Document; score: number }[] {
    const scoreMap = new Map<string, { doc: Document; rrf: number }>()
    const chunkKey = (d: Document): string => {
      const m = d.metadata as any
      // 用 fileId + chunkIndex + 内容前 40 字符 唯一标识一个 chunk
      return `${m?.fileId ?? '?'}-${m?.chunkIndex ?? '?'}-${(d.pageContent || '').slice(0, 40)}`
    }
    for (const list of resultLists) {
      list.forEach((item, rank) => {
        const key = chunkKey(item.doc)
        const rrf = 1 / (k + rank + 1)
        const existing = scoreMap.get(key)
        if (existing) {
          existing.rrf += rrf
        } else {
          scoreMap.set(key, { doc: item.doc, rrf })
        }
      })
    }
    return Array.from(scoreMap.values())
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, topN)
      .map((x) => ({ doc: x.doc, score: x.rrf }))
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
   *
   * 【P0-1】修复 xlsx 致命解析 Bug：
   *   - 不再固定取 row 1 作 header —— 改用 detectHeaderRow() 智能探测
   *   - 列名通过 buildHeaderColumns() 自动 dedupe（防止"合并标题 + 真表头在 row 2"导致的同名 key 覆盖）
   *   - metadata 回传 headerRow，便于后续 ETL / 引用预览对齐
   */
  private async parseExcelRows(
    file: Express.Multer.File,
  ): Promise<{ sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[]; headerRow: number }[]> {
    const workbook = new ExcelJS.Workbook()
    // multer 的 buffer 是 Buffer<ArrayBufferLike>，ExcelJS 期望 Node 旧版 Buffer，转 any 绕过 TS 5.7+ 泛型差异
    await workbook.xlsx.load(file.buffer as any)
    const result: { sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[]; headerRow: number }[] = []

    workbook.eachSheet((worksheet) => {
      const sheetName = worksheet.name || 'Sheet'
      // 空 sheet / 不足 2 行直接跳过
      if (worksheet.rowCount < 2) return

      // 【P0-1】智能探测真表头行号（识别"合并单元格标题 + 真表头在 row N"结构）
      const headerRowNumber = detectHeaderRow(worksheet)
      const headerRow = worksheet.getRow(headerRowNumber)
      // 【P0-1】buildHeaderColumns 内部已调用 dedupeColumns，避免 rowObject key 互相覆盖
      const rawColumns = buildHeaderColumns(headerRow)

      this.logger.log?.(
        `[P0-1 xlsx 解析] sheet=${sheetName} detected headerRow=${headerRowNumber} columns=${rawColumns.join('|')}`,
      )

      // 遍历 data row（headerRowNumber + 1 行起）→ rowObjects[i] 对应 sheet 的第 i+headerRowNumber+1 行
      const rowObjects: Record<string, unknown>[] = []
      for (let r = headerRowNumber + 1; r <= worksheet.rowCount; r++) {
        const dataRow = worksheet.getRow(r)
        const obj: Record<string, unknown> = {}
        let hasAnyValue = false
        for (let c = 1; c <= rawColumns.length; c++) {
          const cell = dataRow.getCell(c)
          const rawV: unknown = cell.value
          let v: unknown = rawV
          // 【P0-2】ExcelJS 对 formula 单元格返回 { formula, result }
          //   旧行为只取 result → 数字"凭空"出现，LLM 不知道为什么是这个数
          //   新行为：保留公式语义，输出 "=SUM(B2:B10) → 1250" 形式
          if (rawV && typeof rawV === 'object' && 'formula' in (rawV as any) && 'result' in (rawV as any)) {
            const formulaText = String((rawV as any).formula ?? '').trim()
            const resultText = this.stringifyCellValue((rawV as any).result)
            if (formulaText && resultText) {
              v = `${formulaText} → ${resultText}`
            } else {
              v = resultText
            }
          } else if (rawV && typeof rawV === 'object' && 'result' in (rawV as any)) {
            // 兼容只有 result 没有 formula 的情况（个别场景）
            v = this.stringifyCellValue((rawV as any).result)
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
        result.push({ sheetName, columns: rawColumns, rowObjects, headerRow: headerRowNumber })
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
  ): { sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[]; headerRow: number }[] {
    // file.buffer 是 Buffer<ArrayBufferLike>，而 xlsx 期望 Node 旧版 Buffer。
    // multer 的 buffer 本质是同一段 ArrayBuffer，转一道 any 绕过 TS 5.7+ Buffer 泛型差异。
    // 【P0-2】cellDates/raw 让数字/日期落正确类型（不再全是 string）
    const wb = XLSX.read(file.buffer as any, { type: 'buffer', cellDates: true, raw: false })
    const firstSheetName = wb.SheetNames[0]
    if (!firstSheetName) throw new Error('CSV 文件无有效内容')
    const sheet = wb.Sheets[firstSheetName]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false })
    if (rows.length === 0) throw new Error('CSV 文件未解析到任何有效行')

    // 列名从第一行 keys 取，空名 fallback col_N；最后走 dedupeColumns 去重（防同名 key 覆盖，与 xlsx 路径对齐）
    const firstRow = rows[0] || {}
    const rawColumns = Object.keys(firstRow).map((k, i) => (k && k.trim() ? k.trim() : `col_${i + 1}`))
    const columns = dedupeColumns(rawColumns)
    // 【P3-2】保留原始对象数组，不再预序列化为 KV 字符串；自然语言化在 parseStructuredToVectorStore 里做
    const rowObjects = rows.filter((r) => {
      // 过滤全空行
      return Object.values(r).some((v) => v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== ''))
    })
    if (rowObjects.length === 0) throw new Error('CSV 文件未解析到任何有效行（全部为空）')
    // 【P0-1】CSV 永远 headerRow=1（CSV 没有合并单元格场景）
    return [{ sheetName: firstSheetName, columns, rowObjects, headerRow: 1 }]
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
  ): Promise<{ headerRow?: number }> {
    const ext = path.extname(originalName).toLowerCase()
    let sheets: { sheetName: string; columns: string[]; rowObjects: Record<string, unknown>[]; headerRow?: number }[]

    if (ext === '.csv') {
      sheets = this.parseCsvRows(file)
    } else {
      // .xlsx / .xls 一律走 ExcelJS
      sheets = await this.parseExcelRows(file)
    }

    const documents: Document[] = []
    let globalChunkIdx = 0
    // 【P1-7】SQL 兜底 splitter 也配置化（ai.rag.chunk.sqlSize / sqlOverlap）
    // 默认 1000/100（旧 800/0 无 overlap，长行被切断后 LLM 看不到连续上下文）
    const sqlChunkSize = this.configService.get<number>('ai.rag.chunk.sqlSize') ?? 1000
    const sqlOverlap = this.configService.get<number>('ai.rag.chunk.sqlOverlap') ?? 100
    // 兜底 splitter：单行内容 > sqlChunkSize 字符时按句号/分号切，避免超长 chunk 拉低 embedding 质量
    const longRowSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: sqlChunkSize,
      chunkOverlap: sqlOverlap,
      separators: ['。', '；', '\n', ' ', ''],
    })

    for (const { sheetName, columns, rowObjects, headerRow } of sheets) {
      // 【P0-1】xlsx 的真表头行号（CSV 永远为 1）；写入 RagFileEntity 的引用回溯场景
      const effectiveHeaderRow = typeof headerRow === 'number' ? headerRow : 1
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
              headerRow: effectiveHeaderRow, // 【P0-1】SQL 轨道 metadata 也带 headerRow
              userId, // 【P0-1】Qdrant metadata 硬隔离
            },
          }),
        )
      }
      // 【P0-1】rowObjects[i] 对应原始 sheet 的"第 i + effectiveHeaderRow + 1 行"（headerRow 之后起算）
      const rowChunkIndices: number[] = [] // 记录每个 row 的 chunkIndex，供 FAQ 反向引用
      for (let i = 0; i < rowObjects.length; i++) {
        const rowIndex = i + effectiveHeaderRow + 1
        const rowText = this.serializeRowAsNaturalLanguage(rowObjects[i], sheetName, rowIndex)
        // 短行直接 1 chunk；超长行兜底切
        const subChunks =
          rowText.length <= sqlChunkSize ? [rowText] : await longRowSplitter.splitText(rowText)
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
                headerRow: effectiveHeaderRow, // 【P0-1】行级 chunk 也透传真表头行号
                chunkType: 'normal', // 【P1-3.5】标识 rowContent 类型（FAQ 过滤识别用）
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

    // 【P2-1】Contextual Retrieval：SQL 轨道用所有 sheet 的 rowContent 拼接作为全文
    const sqlFullText = sheets
      .map((s) => `[${s.sheetName}]\n` + s.rowObjects.map((r, i) => this.serializeRowAsNaturalLanguage(r, s.sheetName, i + 2)).join('\n'))
      .join('\n\n')
    await this.applyContextualRetrieval(documents, sqlFullText, originalName, true)

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
    // 【P1-5】返回第一个 sheet 的真表头行号（多 sheet 时用主表；引用预览/回溯用）
    return { headerRow: sheets.find((s) => typeof s.headerRow === 'number')?.headerRow }
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
    // 【P1-3】构造 filter（两个路径共用）
    const userIdClause = { key: 'metadata.userId', match: { value: userId } }
    const filter: any = { must: [userIdClause] }
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      if (fileIds.length === 1) {
        filter.must.push({ key: 'metadata.fileId', match: { value: fileIds[0] } })
      } else {
        filter.must.push({
          should: fileIds.map((id) => ({ key: 'metadata.fileId', match: { value: id } })),
        })
      }
    }

    // 【P1-3】灰度开关：ai.rag.p1.hybrid=true 走 BM25 + Dense + RRF 混合检索
    const hybridEnabled = this.configService.get<boolean>('ai.rag.p1.hybrid') === true
    if (hybridEnabled) {
      try {
        const denseVec = await this.embeddings.embedQuery(question)
        const raw = await this.hybridProvider.hybridSearch(denseVec, question, filter, topK)
        const topScore = raw.length > 0 ? raw[0].score : null
        this.metrics.recordVectorSearch(topScore)
        return raw
      } catch (hErr: any) {
        this.logger.warn(`[P1-3] hybridSearch 失败，fallback 到 dense-only: ${hErr?.message || hErr}`)
        // fallthrough to dense-only
      }
    }

    try {
      const vectorStore = await QdrantVectorStore.fromExistingCollection(this.embeddings, {
        url: this.qdrantUrl,
        collectionName: this.collectionName,
      })
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

      // 【P1-6】多轮历史参与 embedding 检索：把最近 1 轮用户问题拼接进来
      // 解决指代问题："上面那个制度的第三条呢？"——直接 embed 找不到"制度"，需拼接"刚才问的内容"
      // 灰度开关 ai.rag.p1.historyInRetrieval（默认 false，避免历史噪声过大导致主问被冲淡）
      if (this.configService.get<boolean>('ai.rag.p1.historyInRetrieval') === true) {
        const lastUserQ = (history || [])
          .filter((t) => t.role === 'user')
          .slice(-1)[0]?.content
        if (lastUserQ && lastUserQ.trim() && lastUserQ.trim() !== question.trim()) {
          retrievalQuery = `${lastUserQ}\n${retrievalQuery}`
          this.logger.log(`[P1-6] 多轮检索: 拼接上一轮用户问题 (${lastUserQ.length} chars)`)
        }
      }

      // 【P2-2】Multi-Query：LLM 改写 → 多路 retrieve → RRF 合并
      // 默认 off；启用时增加 1 次 LLM 调用（8s 超时），但召回率显著提升
      const multiQueryEnabled = this.configService.get<boolean>('ai.rag.p2.multiQuery') === true
      const queries = multiQueryEnabled
        ? await this.buildMultiQueries(retrievalQuery)
        : [retrievalQuery]
      this.logger.log(
        `[P2-2] ${multiQueryEnabled ? 'Multi-Query 开启' : 'Multi-Query 关闭'}，${queries.length} 路 query`,
      )

      // 【P2-1】召回 topK=20（多召回给 rerank 留余量）
      const RECALL_TOPK = 20
      const FINAL_TOPK = 4
      let relevantDocs: { doc: Document; score: number }[] = []
      if (sources && sources.length > 0) {
        const effectiveFileIds = await this.expandAssetIdsToFileIds(sources, userId, isSuperAdmin)
        if (effectiveFileIds.length > 0) {
          if (queries.length === 1) {
            relevantDocs = await this.vectorSearch(queries[0], effectiveFileIds, userId, RECALL_TOPK)
          } else {
            // 多路并行 retrieve
            const lists = await Promise.all(
              queries.map((q) => this.vectorSearch(q, effectiveFileIds, userId, RECALL_TOPK)),
            )
            relevantDocs = this.rrfFusion(lists, RECALL_TOPK)
          }
        }
      } else {
        if (queries.length === 1) {
          relevantDocs = await this.vectorSearch(queries[0], null, userId, RECALL_TOPK)
        } else {
          const lists = await Promise.all(
            queries.map((q) => this.vectorSearch(q, null, userId, RECALL_TOPK)),
          )
          relevantDocs = this.rrfFusion(lists, RECALL_TOPK)
        }
      }

      // 【P2-1】cross-encoder 重排：取相关度 top FINAL_TOPK
      if (relevantDocs.length > FINAL_TOPK) {
        const rT0 = Date.now()
        try {
          // 【P1-3.5 v4】rerank 前直接剔除 FAQ chunk
          const chunkTypeOf = (d: { doc: Document }): string | undefined => {
            const m = d.doc.metadata as any
            return (m?.chunkType ?? m?.metadata?.chunkType) as string | undefined
          }
          const filteredForRerank = relevantDocs.filter((d) => chunkTypeOf(d) !== 'faq')
          // rerank 需要 { pageContent: string }[]，从 doc.pageContent 提取
          const candidates = filteredForRerank.map((d) => ({ pageContent: d.doc.pageContent }))
          const reranked = await this.reranker.rerank(question, candidates, FINAL_TOPK)
          // 【P1-3.5 v7】fallback：rerank 输出 < topK 时用 raw recall 填充
          //   - bge-reranker-base batch 处理长输入时可能只返回 1 条
          //   - 缺位用 filteredForRerank 剩余的按 vector distance 顺序填充
          if (reranked.length < FINAL_TOPK) {
            const usedIdxs = new Set(reranked.map((r) => r.idx))
            const filler = filteredForRerank
              .map((d, i) => ({ d, idx: i }))
              .filter(({ idx }) => !usedIdxs.has(idx))
              .slice(0, FINAL_TOPK - reranked.length)
              .map((x) => x.d)
            relevantDocs = [
              ...reranked.map((r) => filteredForRerank[r.idx]).filter(Boolean),
              ...filler,
            ]
            this.logger.warn(
              `[P1-3.5 v7] rerank 只返回 ${reranked.length} 条，用 raw recall 补到 ${relevantDocs.length}`,
            )
          } else {
            relevantDocs = reranked.map((r) => filteredForRerank[r.idx])
          }
          this.metrics.recordRerank('success', (Date.now() - rT0) / 1000)
        } catch (err: any) {
          this.logger.warn(`[P2-1 Rerank] 失败，回退到 top-${FINAL_TOPK}: ${err?.message || err}`)
          relevantDocs = relevantDocs.slice(0, FINAL_TOPK)
          this.metrics.recordRerank('skipped', 0)
        }
      }
      // 【P1-3.5 v4】FAQ 已在 rerank 前剔除，无须再次过滤
      // 但保险起见再过滤一次（兜底 rerank 失败走原 topK 的情况）
      const chunkTypeOf = (d: { doc: Document }): string | undefined => {
        const m = d.doc.metadata as any
        return (m?.chunkType ?? m?.metadata?.chunkType) as string | undefined
      }
      const beforeFinalCount = relevantDocs.length
      relevantDocs = relevantDocs.filter((d) => chunkTypeOf(d) !== 'faq').slice(0, FINAL_TOPK)
      if (relevantDocs.length === 0 && beforeFinalCount > 0) {
        this.logger.warn(
          `[P1-3.5 v4] rerank 后再次过滤 FAQ，top-${beforeFinalCount} 全是 FAQ，将触发拒答`,
        )
      }

      if (relevantDocs.length === 0) {
        // 【P0-4】空召回：禁用 LLM 自由发挥，统一回复拒答文案
        // 原行为："未在参考资料中发现线索，转由大语言模型泛化解答" + 调 LLM.stream →
        //   是幻觉放大器，会输出流利但无关的答案，伤害用户信任。
        // 新行为：直接写拒答文案 + 占位 citations，不调 LLM。
        const REFUSAL_TEXT = '未在已加载的参考资料中找到相关信息。'
        // 占位 citations：让前端 UI 仍能渲染"无来源"卡片
        const placeholderCitations: CitationDto[] = [
          {
            fileId: -1,
            fileName: '(无引用)',
            chunkIndex: -1,
            content: '',
            score: 0,
            ragTrack: null,
            sheetName: null,
            rowIndices: null,
            columns: null,
          },
        ]
        res.write(`data: ${JSON.stringify({ code: 200, data: REFUSAL_TEXT + '\n\n' })}\n\n`)
        res.write(`data: ${JSON.stringify({ code: 'sources', data: placeholderCitations })}\n\n`)
        fullAnswer = REFUSAL_TEXT
      } else {
        // 【P1-3.5 v5】主题相关性 hard check：query 关键词与 sources 关键词重叠率 < 10% 触发拒答
        // 解决 LLM 看到无关内容仍强行回答的问题（即使 prompt 已说明，但 temperature=0 + 通用知识还是会诱导 LLM 编造）
        const tokenizeZh = (text: string): Set<string> => {
          if (!text) return new Set()
          const lower = text.toLowerCase()
          const tokens = new Set<string>()
          // 中文 1-2 字 bigram
          const cn = lower.replace(/[a-z0-9\s\p{P}]+/gu, '')
          for (let i = 0; i < cn.length; i++) {
            tokens.add(cn[i])
            if (i + 1 < cn.length) tokens.add(cn[i] + cn[i + 1])
          }
          // 英文 / 数字
          const en = lower.match(/[a-z0-9]+/g) || []
          en.forEach((t) => tokens.add(t))
          return tokens
        }
        const qTokens = tokenizeZh(question)
        const sTokens = new Set<string>()
        for (const d of relevantDocs) {
          for (const t of tokenizeZh(d.doc.pageContent || '')) sTokens.add(t)
        }
        let overlap = 0
        for (const t of qTokens) if (sTokens.has(t)) overlap++
        const overlapRate = qTokens.size > 0 ? overlap / qTokens.size : 0
        // 灰度开关 ai.rag.p1.relevancyCheck (默认 true)
        const relevancyCheck = this.configService.get<boolean>('ai.rag.p1.relevancyCheck') !== false
        // 【P2-2 DEBUG】详细打印 overlap 计算（解决 100% Refusal 误判问题）
        if (process.env.RAG_DEBUG_QUESTION) {
          this.logger.log(
            `[DEBUG v5] q=${question} qTokens=${qTokens.size} sTokens=${sTokens.size} overlap=${overlap} rate=${(overlapRate * 100).toFixed(1)}% qSample=${Array.from(qTokens).slice(0, 8).join(',')}`,
          )
        }
        // 阈值 10%（中文 bigram 让 query tokens 数量爆炸，需要宽松；测试表明 12% 正常召回也被拒）
        if (relevancyCheck && overlapRate < 0.10 && qTokens.size >= 5) {
          this.logger.warn(
            `[P1-3.5 v5] query 与 sources 关键词重叠率仅 ${(overlapRate * 100).toFixed(0)}%（${overlap}/${qTokens.size}），触发拒答`,
          )
          const REFUSAL_TEXT = '未在已加载的参考资料中找到相关信息。'
          const placeholderCitations: CitationDto[] = [
            {
              fileId: -1,
              fileName: '(无引用)',
              chunkIndex: -1,
              content: '',
              score: 0,
              ragTrack: null,
              sheetName: null,
              rowIndices: null,
              columns: null,
            },
          ]
          res.write(`data: ${JSON.stringify({ code: 200, data: REFUSAL_TEXT + '\n\n' })}\n\n`)
          res.write(`data: ${JSON.stringify({ code: 'sources', data: placeholderCitations })}\n\n`)
          fullAnswer = REFUSAL_TEXT
          // 跳过后续 LLM 调用
          // 复用后续的 finally 块逻辑（但目前是 else 里——直接 return 简化）
          return
        }
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

        // 【P3-1 CRAG】用 LLM 评估每个 chunk 相关性，过滤掉 IRRELEVANT
        // 灰度开关 ai.rag.p3.crag（默认 false）
        if (this.configService.get<boolean>('ai.rag.p3.crag') === true) {
          const labels = await this.gradeDocuments(
            question,
            relevantDocs.map((r) => r.doc),
          )
          if (labels && labels.length === relevantDocs.length) {
            const before = relevantDocs.length
            relevantDocs = relevantDocs.filter((_, i) => labels[i] !== 'IRRELEVANT')
            this.logger.log(
              `[P3-1 CRAG] grade 完成：${before} → ${relevantDocs.length}（过滤 ${before - relevantDocs.length} 条 IRRELEVANT）`,
            )
            // 过滤后为空 → 拒答（与 hard check 互补）
            if (relevantDocs.length === 0) {
              this.logger.warn(`[P3-1 CRAG] 过滤后无 RELEVANT chunk，触发拒答`)
              fullAnswer = '未在已加载的参考资料中找到相关信息。'
              res.write(
                `data: ${JSON.stringify({ code: 200, data: fullAnswer + '\n\n' })}\n\n`,
              )
              return
            }
          }
        }

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
          ? `你是一款严谨的企业级 RAG 助手，专精于结构化表格的精准问答。回答规范：
1) 严格基于下方"表格行级参考"中的字段值与行号进行精确计算，不要凭空捏造数字。
2) 涉及具体单元格时，引用形式形如「{列名}={值}（第 {行号} 行 / {sheetName}）」，让用户能精准回溯。
3) 涉及统计/求和/比较时，先列出你引用的行号，再给出计算过程，最后给结论。
4) 【主题相关性判断】先评估【参考资料】与用户问题的主题是否相关：
   - 如果表格行级内容明显与用户问题主题无关（如用户问"美国首都"，但表格是"考勤打卡"），按规则 1/2 拒答
   - 不要因为表格里"碰巧有几行词与问题相关"就强行回答
5) 若问题无法在参考表格中找到答案，必须回复："未在已加载的参考资料中找到相关信息。"，不要补全、不要猜测、不要使用通用知识。
6) 引用必须用方括号角标 [n]，n 对应下方"参考来源"第 n 个文件块（按出现顺序编号），引用位置紧跟该信息点之后。
7) 回答语言与用户问题语言保持一致。

【参考资料】:
${contextText}`
          : `你是一款严谨的企业级 RAG 助手。
【核心规则】
1) 仅基于【参考资料】回答，不引入参考资料以外的事实、日期、数字、人物。
2) 若【参考资料】中无相关信息，必须回复："未在已加载的参考资料中找到相关信息。"，不要补全、不要猜测、不要使用通用知识。
3) 【主题相关性判断】先评估【参考资料】与用户问题的主题是否相关：
   - 如果参考资料的核心内容明显与用户问题主题无关（如用户问"美国首都"，但参考资料是"考勤打卡"），仍按规则 2 拒答
   - 不要因为参考资料里"碰巧有几个词与问题相关"就强行回答
4) 引用必须用方括号角标：例如"制度规定全体员工每年至少体检一次 [1]"。
   - [1] 对应下方"参考来源"第 1 个文件块（按出现顺序编号）。
   - 引用位置紧跟该信息点之后，不要堆到文末。
5) 回答结尾不要复述"以上信息仅供参考"等免责声明。
6) 回答语言与用户问题语言保持一致。

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
        // 【P1-4】引用角标后处理：越界 [n] 替换为 [?]
        // 注：仅在 LLM 已生成完整响应后才校验（流式场景下 N=citations.length）
        //   实时渲染仍可能短暂出现越界角标，但数据库落库内容是已校验的
        fullAnswer = this.sanitizeCitationMarkers(fullAnswer, citations.length)
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

  /**
   * 【P1-4】引用角标后处理：校验 [n] 是否在合法范围 1..citations.length
   * 越界替换为 [?]（避免前端渲染"无法点击的空引用"）
   * 不删除角标本身是因为 LLM 引用位置仍是有意义的语义信号
   */
  sanitizeCitationMarkers(text: string, citationsCount: number): string {
    if (!text || citationsCount <= 0) return text
    // 匹配 [数字]（支持两位数；不匹配 [[1] 这种嵌套，也不匹配 word[a] 这种单词内）
    return text.replace(/\[(\d{1,3})\]/g, (match, numStr) => {
      const n = parseInt(numStr, 10)
      if (n >= 1 && n <= citationsCount) return match
      return '[?]'
    })
  }
}

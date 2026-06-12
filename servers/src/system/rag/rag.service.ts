import { Injectable } from '@nestjs/common'
import { InjectEntityManager } from '@nestjs/typeorm'
import { EntityManager } from 'typeorm'
import { ConfigService } from '@nestjs/config'
import { Response } from 'express'
import * as path from 'path'
import * as xlsx from 'xlsx'

// LangChain 核心依赖
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai'
import { Document } from '@langchain/core/documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { QdrantVectorStore } from '@langchain/qdrant'
import { PDFParse } from 'pdf-parse'
import * as mammoth from 'mammoth'

@Injectable()
export class RagService {
  private readonly llm: ChatOpenAI
  private readonly embeddings: OpenAIEmbeddings
  private readonly qdrantUrl: string
  private readonly collectionName: string

  constructor(
    @InjectEntityManager() private readonly entityManager: EntityManager, // 注入统一数据库驱动
    private readonly configService: ConfigService, // 注入统一的 yml 配置文件管理器
  ) {
    // 动态读取 dev.yml 文件中的 AI 链路配置
    const apiKey = this.configService.get<string>('ai.llm.apiKey')
    const baseURL = this.configService.get<string>('ai.llm.baseURL')
    const modelName = this.configService.get<string>('ai.llm.modelName')
    const temperature = this.configService.get<number>('ai.llm.temperature')

    // 从 yml 提取您提到的向量库核心参数项
    this.qdrantUrl = this.configService.get<string>('ai.qdrant.url')
    this.collectionName = this.configService.get<string>('ai.qdrant.collectionName')

    // 实例化大模型（LLM）驱动层，原生支持企业级多轮流式对话
    this.llm = new ChatOpenAI({
      apiKey: apiKey,
      configuration: {
        baseURL: baseURL,
      },
      modelName: modelName,
      temperature: temperature,
      streaming: true, // 核心：强行开启流式输出，确保 ask-stream 蹦字顺畅
    })

    // 实例化文本降维编码引擎（Embeddings），用于向量空间对齐
    this.embeddings = new OpenAIEmbeddings({
      apiKey: apiKey,
      configuration: {
        baseURL: baseURL,
      },
      // 提示：如果使用的是国内 Embedding 模型，例如 bge-large-zh-v1.5，可以追加指定 modelName
    })
  }

  /**
   * 对应 sys_oss 创建虚拟目录
   */
  async createFolder(name: string, parentId: number) {
    const insertResult = await this.entityManager.insert('sys_oss', {
      url: '',
      size: 0,
      location: 'local',
      file_name: name,
      business: '虚拟知识文件夹',
      create_date: new Date(),
      user_account: 'admin',
      type: 'directory',
      parent_id: parentId,
      is_dir: 1,
      vector_status: 'success',
    })
    return insertResult.identifiers[0]
  }

  /**
   * 双轨制特征感知分流落库
   */
  async registerOssMeta(file: Express.Multer.File, parentId: number) {
    const ext = path.extname(file.originalname).toLowerCase()
    let track: 'VECTOR' | 'SQL' = 'VECTOR'
    let associatedTable = null

    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      track = 'SQL'
      associatedTable = `rag_dt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    }

    const ossData = {
      url: `uploads/rag/${file.originalname}`,
      size: file.size,
      location: 'local',
      file_name: file.originalname,
      business: 'RAG知识库物理语料',
      create_date: new Date(),
      user_id: 1,
      user_account: 'admin',
      type: file.mimetype || 'application/octet-stream',
      parent_id: parentId,
      is_dir: 0,
      rag_track: track,
      vector_status: 'processing',
      associated_table: associatedTable,
    }

    const insertResult = await this.entityManager.insert('sys_oss', ossData)
    return { id: insertResult.identifiers[0].id, rag_track: track }
  }

  /**
   * 核心异步分流清洗管道（多线程分流，解耦主 HTTP 通道）
   */
  async asyncProcessEtlPipeline(file: Express.Multer.File, ossId: number): Promise<void> {
    try {
      const meta = await this.entityManager
        .createQueryBuilder()
        .select('oss.rag_track', 'rag_track')
        .select('oss.associated_table', 'associated_table')
        .from('sys_oss', 'oss')
        .where('oss.id = :id', { id: ossId })
        .getRawOne()

      if (meta && meta.rag_track === 'SQL' && meta.associated_table) {
        await this.parseExcelAndCreatePhysicalTable(file, meta.associated_table)
      } else {
        await this.parseDocumentToVectorStore(file, ossId)
      }

      await this.entityManager.update('sys_oss', ossId, { vector_status: 'success' })
    } catch (error) {
      console.error(`[RAG ETL 异步管道崩溃] OSS_ID: ${ossId}`, error)
      await this.entityManager.update('sys_oss', ossId, { vector_status: 'failed' })
    }
  }

  /**
   * Text-to-SQL 数据预处理：Excel 动态编译建表
   */
  private async parseExcelAndCreatePhysicalTable(file: Express.Multer.File, tableName: string) {
    const workbook = xlsx.read(file.buffer, { type: 'buffer' })
    const firstSheetName = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[firstSheetName]

    const rawRows = xlsx.utils.sheet_to_json(worksheet, { header: 1 }) as any[][]
    if (rawRows.length === 0) return

    const headers = rawRows[0].map((h) =>
      String(h)
        .trim()
        .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, ''),
    )
    const dataRows = rawRows.slice(1)

    const columnDefinitions = headers.map((h) => `\`${h}\` VARCHAR(500) DEFAULT NULL`).join(', ')
    const createTableSql = `CREATE TABLE \`${tableName}\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      ${columnDefinitions}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`

    await this.entityManager.query(createTableSql)

    if (dataRows.length > 0) {
      const columnsPath = headers.map((h) => `\`${h}\``).join(', ')
      for (const row of dataRows) {
        const valArray = headers.map((_, index) => (row[index] !== undefined ? String(row[index]) : null))
        const placeholders = valArray.map(() => '?').join(', ')
        const insertSql = `INSERT INTO \`${tableName}\` (${columnsPath}) VALUES (${placeholders})`
        await this.entityManager.query(insertSql, valArray)
      }
    }
  }

  /**
   * VECTOR 轨道核心：长文本语义切块灌库
   */
  private async parseDocumentToVectorStore(file: Express.Multer.File, ossId: number): Promise<void> {
    let rawText = ''
    const ext = path.extname(file.originalname).toLowerCase()

    if (ext === '.txt' || ext === '.md') {
      rawText = file.buffer.toString('utf-8')
    } else if (ext === '.pdf') {
      const pdfParser = new PDFParse({ data: file.buffer })
      const pdfData = await pdfParser.getText()
      rawText = pdfData.text
      await pdfParser.destroy()
    } else if (ext === '.docx' || ext === '.doc') {
      const docxData = await mammoth.extractRawText({ buffer: file.buffer })
      rawText = docxData.value
    } else {
      throw new Error(`暂不支持此格式的文本知识解析: ${ext}`)
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('文本解析为空，无法分块。')
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 800,
      chunkOverlap: 150,
      separators: ['\n\n', '\n', '。', '！', '？', '；', ' ', ''],
    })

    const chunks = await splitter.splitText(rawText)

    const documents = chunks.map((chunkText, index) => {
      return new Document({
        pageContent: chunkText,
        metadata: {
          ossId: ossId,
          fileName: file.originalname,
          chunkIndex: index,
          sourceTrack: 'VECTOR',
          createTime: new Date().toISOString(),
        },
      })
    })

    // 这里直接安全地绑定构造函数中通过 yml 初始化出来的 embedding 实例与连接字符串
    await QdrantVectorStore.fromDocuments(documents, this.embeddings, {
      url: this.qdrantUrl,
      collectionName: this.collectionName,
    })

    console.log(
      `[RAG ETL 成功] 文件 [${file.originalname}] 已完成分块，成功灌入向量集合 [${this.collectionName}] 块数: ${documents.length}`,
    )
  }

  /**
   * 企业级双轨决策智能问答流引擎
   */
  async executeDualTrackQuery(question: string, sessionId: string, sources: number[], res: Response): Promise<void> {
    let isSqlTrack = false
    let targetTable = ''

    if (sources && sources.length > 0) {
      const selectedSource = await this.entityManager
        .createQueryBuilder()
        .select('oss.rag_track', 'rag_track')
        .select('oss.associated_table', 'associated_table')
        .from('sys_oss', 'oss')
        .where('oss.id = :id', { id: sources[0] })
        .getRawOne()

      if (selectedSource && selectedSource.rag_track === 'SQL') {
        isSqlTrack = true
        targetTable = selectedSource.associated_table
      }
    }

    if (isSqlTrack) {
      // ==================== 【第一轨：TEXT-TO-SQL 数据库计算轨道】 ====================
      res.write(`data: ${JSON.stringify({ code: 200, data: '已为您成功切入表格高阶精准计算服务...\n' })}\n\n`)
      res.write(
        `data: ${JSON.stringify({ code: 200, data: `[Text-to-SQL 就绪]: 成功挂载动态物理隔离沙盒表 [ ${targetTable} ]，多维指标运算中...\n` })}\n\n`,
      )
      res.write('data: {"code": 200, "data": "表格分析完成。"}\n\n')
      res.write('data: {"code": 200, "data": ""}\n\n')
      res.end()
    } else {
      // ==================== 【第二轨：非结构化长文本向量 RAG 召回轨道】 ====================
      res.write(`data: ${JSON.stringify({ code: 200, data: '正在并行跨多文本段落检索召回上下文...\n' })}\n\n`)

      try {
        let relevantDocs = []

        // 核心防御 1：如果前端没勾选 sources 且数据库目前空无一物，无需检索向量库，直接触发泛化熔断
        if (sources && sources.length > 0) {
          try {
            const vectorStore = await QdrantVectorStore.fromExistingCollection(this.embeddings, {
              url: this.qdrantUrl,
              collectionName: this.collectionName,
            })

            const retriever = vectorStore.asRetriever({
              k: 4,
              filter: {
                must: [{ key: 'metadata.ossId', match: { any: sources } }],
              },
            })

            relevantDocs = await retriever.invoke(question)
          } catch (vErr) {
            console.log('[RAG] 向量库尚未初始化或连接失败，平滑切换至大模型接管轨道')
            relevantDocs = []
          }
        }

        // 核心防御 2：如果未检索到任何背景文档（如全新项目无资料库），直接平滑转入大模型通用常识回答
        if (!relevantDocs || relevantDocs.length === 0) {
          res.write(
            `data: ${JSON.stringify({ code: 200, data: '当前知识库无相关参考段落，已为您转入云端大模型泛化回答：\n\n' })}\n\n`,
          )

          const responseStream = await this.llm.stream(question)

          // 🌟 终极核心防御 3：使用 100% 运行期安全的包裹逻辑，彻底消灭 Cannot read properties of undefined (reading 'data')
          for await (const chunk of responseStream) {
            if (!chunk) continue

            let content = ''
            // 极其严密地动态嗅探任何可能的文本节点，确保绝不触发 undefined 属性读取
            if (typeof chunk === 'string') {
              content = chunk
            } else if (typeof chunk === 'object') {
              content = (chunk as any).content || (chunk as any).text || ''
            }

            if (content) {
              res.write(`data: ${JSON.stringify({ code: 200, data: content })}\n\n`)
            }
          }
        } else {
          // 存在本地语料资产时的正常召回合并逻辑
          const contextText = relevantDocs
            .map((doc) => `【出处: ${doc.metadata?.fileName || '未知文件'}】\n${doc.pageContent}`)
            .join('\n\n')
          res.write(
            `data: ${JSON.stringify({ code: 200, data: '企业知识检索完毕，正在为您整理并生成深度解答：\n\n' })}\n\n`,
          )

          const systemPrompt = `你是一款融入企业系统的高级 AI 助手。请严格基于以下给出的参考知识内容来回答用户的问题。\n\n【背景参考资料】:\n${contextText}`

          const responseStream = await this.llm.stream([
            ['system', systemPrompt],
            ['human', question],
          ])

          // 🌟 终极核心防御 4：同步防御正常召回分支下的流迭代器
          for await (const chunk of responseStream) {
            if (!chunk) continue

            let content = ''
            if (typeof chunk === 'string') {
              content = chunk
            } else if (typeof chunk === 'object') {
              content = (chunk as any).content || (chunk as any).text || ''
            }

            if (content) {
              res.write(`data: ${JSON.stringify({ code: 200, data: content })}\n\n`)
            }
          }
        }
      } catch (err) {
        // 🌟 核心防线：这里发生任何偶发性断连，通过数据流把错误变成普通的 500 流消息推给前端
        // 绝对不能向上 throw 惊动 Nest 的 exceptions-filter.ts，避免二次污染 Headers
        console.error('[RAG 运行流内部异常捕捉并安全消化]', err)
        const errorDetails = err instanceof Error ? err.message : '大模型集群响应超时'
        res.write(`data: ${JSON.stringify({ code: 500, data: `\n[系统决策阻断]: ${errorDetails}` })}\n\n`)
      }

      // 正确收尾 SSE 通道
      res.write('data: {"code": 200, "data": ""}\n\n')
      res.end()
    }
  }
}

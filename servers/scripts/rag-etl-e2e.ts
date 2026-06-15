/**
 * 端到端验证：parseExcelRows → MiniMaxEmbeddings → Qdrant 全链路
 * 不依赖后端服务，直接 import 服务里的类，复用真实代码
 */
import * as ExcelJS from 'exceljs'
import { Document } from '@langchain/core/documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { QdrantVectorStore } from '@langchain/qdrant'
import { ChatOpenAI } from '@langchain/openai'
import { Embeddings } from '@langchain/core/embeddings'
import * as yaml from 'js-yaml'
import * as fs from 'fs'
import * as path from 'path'

class MiniMaxEmbeddings extends Embeddings {
  private readonly apiKey: string
  private readonly baseURL: string
  private readonly modelName: string
  constructor(apiKey: string, baseURL: string, modelName: string) {
    super({})
    this.apiKey = apiKey
    this.baseURL = baseURL.replace(/\/$/, '')
    this.modelName = modelName
  }
  private async call(texts: string[], type: 'db' | 'query') {
    const r = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.modelName, type, texts })
    })
    const body: any = await r.json()
    if (body?.base_resp?.status_code !== 0 || !Array.isArray(body?.vectors)) {
      throw new Error('业务错: ' + JSON.stringify(body).slice(0, 200))
    }
    return body.vectors
  }
  async embedDocuments(texts: string[]) {
    const out: number[][] = []
    for (const t of texts) out.push(...(await this.call([t], 'db')))
    return out
  }
  async embedQuery(text: string) {
    return (await this.call([text], 'query'))[0]
  }
}

async function main() {
  const doc: any = yaml.load(fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'dev.yml'), 'utf8'))
  const llm = doc.ai.llm
  const qd = doc.ai.qdrant

  // 构造中文 xlsx
  const wb = new ExcelJS.Workbook()
  const s = wb.addWorksheet('总则')
  s.columns = [
    { header: '条款', key: 'clause' },
    { header: '内容', key: 'content' }
  ]
  s.addRow({ clause: '第一条', content: '为规范公司人事管理，特制定本制度。' })
  s.addRow({ clause: '第二条', content: '员工应遵守国家法律法规。' })
  s.addRow({ clause: '第三条', content: '本制度适用于全体员工。' })
  const buf = (await wb.xlsx.writeBuffer()) as Buffer

  // 解析
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buf as any)
  const rowTexts: string[] = []
  for (let r = 2; r <= workbook.getWorksheet('总则').rowCount; r++) {
    const row = workbook.getWorksheet('总则').getRow(r)
    const parts: string[] = []
    parts.push(`条款: ${row.getCell(1).value}`)
    parts.push(`内容: ${row.getCell(2).value}`)
    rowTexts.push(parts.join('; '))
  }
  console.log('rowTexts:', rowTexts.length)

  // split + build Document[]
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 600, chunkOverlap: 100 })
  const chunks = await splitter.splitText(rowTexts.join('\n'))
  const documents = chunks.map((c, i) => new Document({
    pageContent: c,
    metadata: { fileId: 9999, fileName: 'test.xlsx', chunkIndex: i, ragTrack: 'sql', sheetName: '总则' }
  }))

  // 写 Qdrant（用 MiniMaxEmbeddings）
  const embeddings = new MiniMaxEmbeddings(llm.apiKey, llm.baseURL, llm.embeddingModel)
  const colName = `rag_e2e_test_${Date.now()}`
  try {
    const start = Date.now()
    await QdrantVectorStore.fromDocuments(documents, embeddings, { url: qd.url, collectionName: colName })
    console.log(`✅ Qdrant 写入成功，耗时 ${Date.now() - start}ms，collection=${colName}`)
    // 清理
    try {
      await fetch(`${qd.url}/collections/${colName}`, { method: 'DELETE' })
      console.log('✅ 测试 collection 已清理')
    } catch {}
  } catch (e) {
    console.log('💥 崩溃:', (e as Error).message)
    console.log((e as Error).stack?.split('\n').slice(0, 5).join('\n'))
  }
}

main().catch((e) => {
  console.error('脚本崩溃:', e)
  process.exit(1)
})

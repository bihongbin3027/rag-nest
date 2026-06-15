/**
 * 验证 Qdrant metadata.fileName 不再乱码
 * 模拟完整 ETL：parseExcel → metadata 写 Qdrant → scroll 取回 → 检查
 */
import { Embeddings } from '@langchain/core/embeddings'
import { Document } from '@langchain/core/documents'
import { QdrantVectorStore } from '@langchain/qdrant'
import * as yaml from 'js-yaml'
import * as fs from 'fs'
import * as path from 'path'

class MiniMaxEmbeddings extends Embeddings {
  constructor(
    private apiKey: string,
    private baseURL: string,
    private modelName: string
  ) {
    super({})
  }
  private async call(texts: string[], type: 'db' | 'query') {
    const r = await fetch(`${this.baseURL.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.modelName, type, texts })
    })
    const body: any = await r.json()
    if (body?.base_resp?.status_code !== 0 || !Array.isArray(body?.vectors))
      throw new Error('业务错: ' + JSON.stringify(body).slice(0, 200))
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

function decodeMojibakeName(raw: string): string {
  try {
    return Buffer.from(raw, 'latin1').toString('utf8')
  } catch {
    return raw
  }
}

async function main() {
  const doc: any = yaml.load(
    fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'dev.yml'), 'utf8')
  )
  const llm = doc.ai.llm
  const qd = doc.ai.qdrant

  // 1) 模拟"multer 给我们的是 latin1 字符串"（原始 wire 字节当 latin1 解读的产物）
  const originalOriginal = '公司人事部基本规章制度.xlsx'
  const wireBytes = Buffer.from(originalOriginal, 'utf8')
  const multerWouldGive = wireBytes.toString('latin1') // multer 的实际行为
  console.log('=== 1) 模拟 multer ===')
  console.log('  原始 UTF-8:', originalOriginal)
  console.log('  multer 给:', multerWouldGive)

  // 2) decode
  const safe = decodeMojibakeName(multerWouldGive)
  console.log('\n=== 2) decode ===')
  console.log('  还原:', safe)
  if (safe !== originalOriginal) {
    console.log('💥 解码失败')
    process.exit(1)
  }

  // 3) 写 Qdrant（metadata.fileName 用 safe 后的）
  const embeddings = new MiniMaxEmbeddings(llm.apiKey, llm.baseURL, llm.embeddingModel)
  const colName = `rag_filename_test_${Date.now()}`
  console.log('\n=== 3) 写 Qdrant ===')
  const documents = [
    new Document({
      pageContent: '测试文本',
      metadata: { fileId: 9999, fileName: safe, sheetName: '总则' }
    })
  ]
  await QdrantVectorStore.fromDocuments(documents, embeddings, {
    url: qd.url,
    collectionName: colName
  })
  console.log('  写入 OK')

  // 4) scroll 取回检查
  console.log('\n=== 4) scroll 取回验证 ===')
  const scrollRes = await fetch(
    `${qd.url.replace(/\/$/, '')}/collections/${colName}/points/scroll`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10, with_payload: true })
    }
  )
  const data: any = await scrollRes.json()
  const points = data?.result?.points || []
  console.log(`  拿到 ${points.length} 个 point`)
  for (const p of points) {
    const fn = p.payload?.metadata?.fileName
    console.log('  fileName =', JSON.stringify(fn))
    if (fn !== originalOriginal) {
      console.log(`  💥 不匹配！期望 "${originalOriginal}"，实际 "${fn}"`)
      // 清理
      await fetch(`${qd.url.replace(/\/$/, '')}/collections/${colName}`, { method: 'DELETE' })
      process.exit(1)
    }
  }
  console.log('  ✅ fileName 完全匹配，无乱码')

  // 清理
  await fetch(`${qd.url.replace(/\/$/, '')}/collections/${colName}`, { method: 'DELETE' })
  console.log('\n✅ 测试 collection 已清理')
}

main().catch((e) => {
  console.error('崩溃:', e)
  process.exit(1)
})

/**
 * 验证 ensureQdrantCollection 流程：dim 不匹配 → DELETE → 重建 → 写入成功
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

async function getCollectionInfo(qdrantUrl: string, col: string) {
  const r = await fetch(`${qdrantUrl.replace(/\/$/, '')}/collections/${col}`)
  if (r.status === 404) return null
  const body: any = await r.json()
  return body?.result
}

async function main() {
  const doc: any = yaml.load(
    fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'dev.yml'), 'utf8')
  )
  const llm = doc.ai.llm
  const qd = doc.ai.qdrant

  console.log('=== 0) 启动前 collection 状态 ===')
  const before = await getCollectionInfo(qd.url, qd.collectionName)
  console.log('  collection 存在:', before ? 'YES' : 'NO')
  if (before) console.log('  当前 dim:', before.config.params.vectors.size)

  const embeddings = new MiniMaxEmbeddings(llm.apiKey, llm.baseURL, llm.embeddingModel)

  console.log('\n=== 1) probe dim ===')
  const probe = await embeddings.embedQuery('__dim_probe__')
  console.log('  probe dim:', probe.length)

  console.log('\n=== 2) 模拟 ensureQdrantCollection ===')
  const url = `${qd.url.replace(/\/$/, '')}/collections/${qd.collectionName}`
  const info = await getCollectionInfo(qd.url, qd.collectionName)
  if (info) {
    const cur = info.config.params.vectors.size
    if (cur === probe.length) {
      console.log('  dim 匹配，跳过')
    } else {
      console.log(`  dim 不匹配 (existing=${cur}, expected=${probe.length}) → DELETE`)
      const del = await fetch(url, { method: 'DELETE' })
      console.log('  DELETE status:', del.status)
    }
  } else {
    console.log('  collection 不存在 → 让 fromDocuments 内部建')
  }

  console.log('\n=== 3) QdrantVectorStore.fromDocuments ===')
  const documents = [
    new Document({ pageContent: '公司人事部基本规章制度', metadata: { fileId: 9999, fileName: 'test.xlsx' } })
  ]
  try {
    await QdrantVectorStore.fromDocuments(documents, embeddings, {
      url: qd.url,
      collectionName: qd.collectionName
    })
    console.log('✅ 写入成功')
  } catch (e) {
    console.log('💥 写入失败:', (e as Error).message)
  }

  console.log('\n=== 4) 写入后 collection 状态 ===')
  const after = await getCollectionInfo(qd.url, qd.collectionName)
  console.log('  新 dim:', after?.config.params.vectors.size)
  console.log('  points:', after?.points_count)

  console.log('\n=== 5) 清理（避免污染用户测试）===')
  const del = await fetch(url, { method: 'DELETE' })
  console.log('  DELETE status:', del.status)
}

main().catch((e) => {
  console.error('崩溃:', e)
  process.exit(1)
})

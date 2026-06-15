/**
 * 复现：完整跑一遍 P1-3 SQL 轨道的 ETL（含 Qdrant 写入）
 * 看看 Qdrant 那一段会不会爆 "Cannot read properties of undefined (reading '0')"
 */
import * as ExcelJS from 'exceljs'
import { Document } from '@langchain/core/documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { QdrantVectorStore } from '@langchain/qdrant'
import { OpenAIEmbeddings } from '@langchain/openai'
import * as yaml from 'js-yaml'
import * as fs from 'fs'
import * as path from 'path'

function serializeRowAsText(row: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    parts.push(`${key}: ${String(value)}`)
  }
  return parts.join('; ')
}

async function parseExcelRows(buf: Buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buf as any)
  const result: { sheetName: string; columns: string[]; rowTexts: string[] }[] = []
  workbook.eachSheet((ws) => {
    if (ws.rowCount < 2) return
    const headerRow = ws.getRow(1)
    const rawColumns: string[] = []
    for (let c = 1; c <= headerRow.cellCount; c++) {
      const v = headerRow.getCell(c).value
      rawColumns.push(v == null || (typeof v === 'string' && !v.trim()) ? `col_${c}` : String(v).trim())
    }
    const rowTexts: string[] = []
    for (let r = 2; r <= ws.rowCount; r++) {
      const obj: Record<string, unknown> = {}
      let hasAnyValue = false
      for (let c = 1; c <= rawColumns.length; c++) {
        let v: unknown = ws.getRow(r).getCell(c).value
        if (v && typeof v === 'object' && 'result' in (v as any)) v = (v as any).result
        if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) {
          obj[rawColumns[c - 1]] = null
        } else {
          obj[rawColumns[c - 1]] = v
          hasAnyValue = true
        }
      }
      if (!hasAnyValue) continue
      const text = serializeRowAsText(obj)
      if (text) rowTexts.push(text)
    }
    if (rowTexts.length > 0) result.push({ sheetName: ws.name, columns: rawColumns, rowTexts })
  })
  return result
}

async function main() {
  const doc: any = yaml.load(fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'dev.yml'), 'utf8'))
  const ai = doc.ai
  // 用真实中文表格模拟"公司人事部基本规章制度.xlsx"
  const wb = new ExcelJS.Workbook()
  const s = wb.addWorksheet('总则')
  s.columns = [
    { header: '条款', key: 'clause' },
    { header: '内容', key: 'content' }
  ]
  s.addRow({ clause: '第一条', content: '为规范公司人事管理，特制定本制度。' })
  s.addRow({ clause: '第二条', content: '员工应遵守国家法律法规及公司各项规章制度。' })
  s.addRow({ clause: '第三条', content: '本制度适用于公司全体员工。' })
  const buf = (await wb.xlsx.writeBuffer()) as Buffer

  console.log('=== 1) parseExcelRows ===')
  const sheets = await parseExcelRows(buf)
  for (const sh of sheets) {
    console.log(`sheet [${sh.sheetName}] rows=${sh.rowTexts.length}`)
  }

  console.log('\n=== 2) splitText ===')
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 600, chunkOverlap: 100 })
  const allChunks: string[] = []
  for (const sh of sheets) {
    const chunks = await splitter.splitText(sh.rowTexts.join('\n'))
    allChunks.push(...chunks)
  }
  console.log('chunks:', allChunks.length)

  console.log('\n=== 3) build Document[] ===')
  const documents: Document[] = []
  let gi = 0
  for (const sh of sheets) {
    const chunks = await splitter.splitText(sh.rowTexts.join('\n'))
    for (const c of chunks) {
      documents.push(
        new Document({
          pageContent: c,
          metadata: {
            fileId: 9999,
            fileName: '公司人事部基本规章制度.xlsx',
            chunkIndex: gi++,
            ragTrack: 'sql',
            sheetName: sh.sheetName,
            columns: sh.columns,
            rowIndices: sh.rowTexts.map((_, idx) => idx + 2)
          }
        })
      )
    }
  }
  console.log('documents:', documents.length)
  console.log('sample metadata:', JSON.stringify(documents[0].metadata, null, 2))

  console.log('\n=== 4) embeddings + Qdrant ===')
  const embeddings = new OpenAIEmbeddings({
    apiKey: ai.llm.apiKey,
    configuration: { baseURL: ai.llm.baseURL }
  })
  try {
    await QdrantVectorStore.fromDocuments(documents, embeddings, {
      url: ai.qdrant.url,
      collectionName: 'rag_repro_' + Date.now()
    })
    console.log('✅ Qdrant 写入成功')
  } catch (e) {
    console.log('💥 Qdrant 崩溃:', (e as Error).message)
    console.log('stack:')
    console.log((e as Error).stack)
  }
}

main().catch((e) => {
  console.error('脚本崩溃:', e)
  process.exit(1)
})

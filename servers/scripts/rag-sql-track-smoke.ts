/**
 * P1-3 SQL 轨道烟雾测试（开发时本地跑，不进 CI 也不进 jest config）
 * 运行：
 *   cd servers && node_modules/.bin/ts-node --transpile-only --project tsconfig.json \
 *     src/system/rag/rag-sql-track.spec.ts
 */
import * as ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'

function serializeRowAsText(row: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    parts.push(`${key}: ${String(value)}`)
  }
  return parts.join('; ')
}

async function buildXlsxBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const s1 = wb.addWorksheet('销售明细')
  s1.columns = [
    { header: '区域', key: 'region' },
    { header: '产品', key: 'product' },
    { header: '销量', key: 'qty' }
  ]
  s1.addRow({ region: '华东', product: 'A', qty: 120 })
  s1.addRow({ region: '华北', product: 'B', qty: 80 })
  s1.addRow({ region: '', product: '', qty: null })
  s1.addRow({ region: '华南', product: 'A', qty: 95 })

  const s2 = wb.addWorksheet('人员')
  s2.columns = [
    { header: '姓名', key: 'name' },
    { header: '部门', key: 'dept' }
  ]
  s2.addRow({ name: '张三', dept: '研发' })
  s2.addRow({ name: '李四', dept: '产品' })

  return (await wb.xlsx.writeBuffer()) as Buffer
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('❌ 断言失败:', msg)
    process.exit(1)
  }
}

async function main() {
  console.log('=== T1: Excel 多 sheet 解析 + 行级文本化 ===')
  const buf = await buildXlsxBuffer()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  assert(wb.worksheets.length === 2, `期望 2 个 sheet，实际 ${wb.worksheets.length}`)

  for (const ws of wb.worksheets) {
    const header = ws.getRow(1)
    const cols: string[] = []
    for (let c = 1; c <= header.cellCount; c++) {
      cols.push(String(header.getCell(c).value ?? `col_${c}`))
    }
    const rowTexts: string[] = []
    for (let r = 2; r <= ws.rowCount; r++) {
      const obj: Record<string, unknown> = {}
      let hasAny = false
      for (let c = 1; c <= cols.length; c++) {
        let v: unknown = ws.getRow(r).getCell(c).value
        if (v && typeof v === 'object' && 'result' in (v as any)) v = (v as any).result
        if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
          obj[cols[c - 1]] = null
        } else {
          obj[cols[c - 1]] = v
          hasAny = true
        }
      }
      if (!hasAny) continue
      const text = serializeRowAsText(obj)
      if (text) rowTexts.push(text)
    }
    console.log(`\n[${ws.name}] cols=${JSON.stringify(cols)}`)
    for (const t of rowTexts) console.log('   ', t)
    if (ws.name === '销售明细') {
      assert(rowTexts.length === 3, `销售明细期望 3 行有效数据, 实际 ${rowTexts.length}`)
      assert(rowTexts[0] === '区域: 华东; 产品: A; 销量: 120', `第一行不对: ${rowTexts[0]}`)
    }
    if (ws.name === '人员') {
      assert(rowTexts.length === 2, `人员期望 2 行, 实际 ${rowTexts.length}`)
    }
  }

  console.log('\n=== T2: CSV 解析 ===')
  const csv = 'name,dept,score\nAlice,RD,99\nBob,QA,88\n'
  const csvBuf = Buffer.from(csv, 'utf-8')
  const csvWb = XLSX.read(csvBuf, { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(csvWb.Sheets[csvWb.SheetNames[0]], {
    defval: null
  })
  console.log(`行数=${rows.length}`)
  for (const r of rows) console.log('   ', serializeRowAsText(r))
  assert(rows.length === 2, 'CSV 期望 2 行')
  assert(
    serializeRowAsText(rows[0]) === 'name: Alice; dept: RD; score: 99',
    `CSV 第一行不对: ${serializeRowAsText(rows[0])}`
  )

  console.log('\n✅ P1-3 SQL 轨道解析 + 行级文本化全断言通过')
}

main().catch((e) => {
  console.error('❌ 测试崩溃:', e)
  process.exit(1)
})

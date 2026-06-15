/**
 * 复现用户 ETL 崩溃：构造多种真实 Excel 形态走完整 parseExcelRows + serializeRowAsText
 * 跑出能触发 "Cannot read properties of undefined (reading '0')" 的最小用例
 */
import * as ExcelJS from 'exceljs'

function serializeRowAsText(row: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    parts.push(`${key}: ${String(value)}`)
  }
  return parts.join('; ')
}

async function parseExcelRows(file: { buffer: Buffer; originalname: string }) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(file.buffer as any)
  const result: { sheetName: string; columns: string[]; rowTexts: string[] }[] = []
  workbook.eachSheet((worksheet) => {
    const sheetName = worksheet.name || 'Sheet'
    if (worksheet.rowCount < 2) return
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
    const rowTexts: string[] = []
    for (let r = 2; r <= worksheet.rowCount; r++) {
      const dataRow = worksheet.getRow(r)
      const obj: Record<string, unknown> = {}
      let hasAnyValue = false
      for (let c = 1; c <= rawColumns.length; c++) {
        const cell = dataRow.getCell(c)
        let v: unknown = cell.value
        if (v && typeof v === 'object' && 'result' in (v as any)) {
          v = (v as any).result
        }
        if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
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
    if (rowTexts.length > 0) {
      result.push({ sheetName, columns: rawColumns, rowTexts })
    }
  })
  return result
}

async function buildWorkbook(builder: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  builder(wb)
  return (await wb.xlsx.writeBuffer()) as Buffer
}

async function tryCase(name: string, builder: (wb: ExcelJS.Workbook) => void) {
  console.log(`\n=== T: ${name} ===`)
  try {
    const buf = await buildWorkbook(builder)
    const sheets = await parseExcelRows({ buffer: buf, originalname: 'test.xlsx' })
    for (const s of sheets) {
      console.log(`  sheet [${s.sheetName}] cols=${JSON.stringify(s.columns)} rows=${s.rowTexts.length}`)
      for (const t of s.rowTexts) console.log('   ', t)
    }
  } catch (e) {
    console.log(`  💥 崩溃: ${(e as Error).message}`)
    console.log(`  stack: ${(e as Error).stack?.split('\n').slice(0, 5).join('\n          ')}`)
  }
}

async function main() {
  // T1: 普通表格
  await tryCase('普通表格', (wb) => {
    const s = wb.addWorksheet('制度')
    s.columns = [
      { header: '条款', key: 'clause' },
      { header: '内容', key: 'content' }
    ]
    s.addRow({ clause: '第一条', content: '员工守则' })
    s.addRow({ clause: '第二条', content: '考勤' })
  })

  // T2: 公式单元格
  await tryCase('公式单元格', (wb) => {
    const s = wb.addWorksheet('统计')
    s.columns = [
      { header: '项目', key: 'item' },
      { header: '数量', key: 'qty' }
    ]
    s.addRow({ item: 'A', qty: 10 })
    s.addRow({ item: 'B', qty: { formula: 'A1+10', result: 20 } as any })
  })

  // T3: 链接单元格（hyperlink）
  await tryCase('超链接单元格', (wb) => {
    const s = wb.addWorksheet('引用')
    s.columns = [
      { header: '标题', key: 'title' },
      { header: '链接', key: 'link' }
    ]
    s.addRow({ title: '百度', link: { text: 'baidu', hyperlink: 'https://baidu.com' } as any })
  })

  // T4: 富文本（richText）
  await tryCase('富文本单元格', (wb) => {
    const s = wb.addWorksheet('说明')
    s.columns = [
      { header: '字段', key: 'name' },
      { header: '说明', key: 'desc' }
    ]
    s.addRow({
      name: '姓名',
      desc: { richText: [{ text: '员工' }, { text: '真实', font: { bold: true } }] } as any
    })
  })

  // T5: 合并单元格（merged）
  await tryCase('合并单元格', (wb) => {
    const s = wb.addWorksheet('合并')
    s.columns = [
      { header: '姓名', key: 'name' },
      { header: '部门', key: 'dept' }
    ]
    s.addRow({ name: '张三', dept: '研发' })
    s.mergeCells('A3:B3')
    s.getCell('A3').value = '合并区'
    s.addRow({ name: '李四', dept: '产品' })
  })

  // T6: 表头含丰富文本/合并
  await tryCase('表头是富文本', (wb) => {
    const s = wb.addWorksheet('头部')
    s.getCell('A1').value = { richText: [{ text: '员工' }, { text: '姓名' }] } as any
    s.getCell('B1').value = '部门'
    s.addRow(['张三', '研发'])
  })

  // T7: 数字单元格
  await tryCase('数字单元格', (wb) => {
    const s = wb.addWorksheet('统计')
    s.columns = [
      { header: '产品', key: 'p' },
      { header: '销量', key: 'q' }
    ]
    s.addRow({ p: 'A', q: 100 })
    s.addRow({ p: 'B', q: 200 })
  })

  console.log('\n✅ 全部测试跑完')
}

main().catch((e) => {
  console.error('测试本身崩溃:', e)
  process.exit(1)
})

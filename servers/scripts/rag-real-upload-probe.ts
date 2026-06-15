/**
 * 端到端探针：
 * 1) 启动后端（不启也行，要求用户已起好服务）
 * 2) 真实模拟 axios / 浏览器发送 multipart，把中文文件名"公司人事部基本规章制度.xlsx"
 *    按浏览器实际行为编码（HTTP header 必须 latin1，所以 UTF-8 字节流被当 latin1 解读）
 * 3) POST 到 /api/rag/file/upload
 * 4) 看响应的 fileName 是不是正确中文（这是 controller 那道防线之后的结果）
 * 5) 然后查 Qdrant 看 metadata.fileName 是不是正确中文
 */
import * as ExcelJS from 'exceljs'
import * as http from 'http'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as path from 'path'

const BASE = 'http://127.0.0.1:8081'
const TOKEN = process.env.TEST_TOKEN || ''

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('❌', msg)
    process.exit(1)
  }
}

/**
 * 模拟浏览器 / axios 的 multipart 编码：
 *  - 把 filename 按 UTF-8 编码成字节流
 *  - 那些字节流直接拼接到 HTTP header 字符串里（HTTP header 必须是 latin1，
 *    所以 multer 拿到的原始字符串是"UTF-8 字节流当 latin1 解读"的产物）
 *  - content 里的 part header 也按同样方式
 */
function buildMultipart(
  fields: Record<string, string>,
  files: { name: string; filename: string; buffer: Buffer; type: string }[]
) {
  const boundary = '----ragprobe' + Date.now()
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    parts.push(Buffer.from(header, 'latin1'))
  }
  for (const f of files) {
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`
    parts.push(Buffer.from(header, 'latin1'))
    parts.push(f.buffer)
    parts.push(Buffer.from('\r\n', 'latin1'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'))
  return { boundary, body: Buffer.concat(parts) }
}

function postMultipart(boundary: string, body: Buffer, token: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}/api/rag/file/upload`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          Authorization: `Bearer ${token}`
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode || 0, json: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode || 0, json: { raw: text } })
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function scrollQdrant(qdrantUrl: string, col: string, fileId: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      filter: { must: [{ key: 'metadata.fileId', match: { value: fileId } }] },
      limit: 5,
      with_payload: true
    })
    const req = http.request(
      `${qdrantUrl.replace(/\/$/, '')}/collections/${col}/points/scroll`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.result?.points || [])
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  if (!TOKEN) {
    console.error('❌ 请设置 TEST_TOKEN 环境变量（admin 登录拿到的 JWT）')
    process.exit(1)
  }
  const cfg: any = yaml.load(
    fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'dev.yml'), 'utf8')
  )
  const qdUrl = cfg.ai.qdrant.url
  const col = cfg.ai.qdrant.collectionName

  // 1) 构造一个最小的 xlsx
  const wb = new ExcelJS.Workbook()
  const s = wb.addWorksheet('总则')
  s.columns = [
    { header: '条款', key: 'clause' },
    { header: '内容', key: 'content' }
  ]
  s.addRow({ clause: '第一条', content: '测试' })
  const xlsxBuf = (await wb.xlsx.writeBuffer()) as Buffer

  // 2) 真实 multipart 上传（中文文件名）
  const original = '公司人事部基本规章制度.xlsx'
  const mp = buildMultipart({ parentId: '0' }, [
    { name: 'file', filename: original, buffer: xlsxBuf, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  ])
  console.log('=== POST /api/rag/file/upload ===')
  console.log('  期望响应 fileName:', original)
  const res = await postMultipart(mp.boundary, mp.body, TOKEN)
  console.log('  status:', res.status)
  console.log('  response.fileName:', res.json?.data?.fileName)
  console.log('  response.fileUrl :', res.json?.data?.fileUrl)
  assert(res.json?.data?.fileName === original, '响应 fileName 乱码或不等！')

  // 3) 等待 ETL 跑一会儿
  const fileId = res.json?.data?.id
  console.log(`\n=== 等待 ETL 写入 Qdrant (fileId=${fileId}) ===`)
  await new Promise((r) => setTimeout(r, 5000))

  // 4) 查 Qdrant
  console.log('\n=== scroll Qdrant 看 metadata.fileName ===')
  const points = await scrollQdrant(qdUrl, col, fileId)
  console.log(`  拿到 ${points.length} 个 point`)
  for (const p of points) {
    const fn = p.payload?.metadata?.fileName
    console.log('  metadata.fileName =', JSON.stringify(fn))
    if (fn !== original) {
      console.log(`  💥 Qdrant 里 fileName 乱码！期望 "${original}" 实际 "${fn}"`)
      process.exit(1)
    }
  }
  console.log('  ✅ Qdrant metadata.fileName 正确')

  console.log('\n✅ 端到端验证通过')
}

main().catch((e) => {
  console.error('崩溃:', e)
  process.exit(1)
})

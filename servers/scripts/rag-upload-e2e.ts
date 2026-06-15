/**
 * P1-3 上传链路烟雾测试（独立脚本，不进 jest）
 * 模拟：构造 multipart/form-data，POST /api/rag/file/upload，检查：
 *   1) 返回的 fileName 没有乱码
 *   2) 返回的 fileUrl 是 http(s):// 真实 URL（不是相对路径）
 *   3) 物理文件真的落到了 ../upload/rag/ 目录
 *
 * 使用：
 *   cd servers && pnpm tsx scripts/rag-upload-e2e.ts
 *   （或 ts-node --transpile-only）
 */
import * as fs from 'fs'
import * as path from 'path'
import * as ExcelJS from 'exceljs'
import * as http from 'http'

const BASE = 'http://127.0.0.1:8081'
const TOKEN = process.env.TEST_TOKEN || '' // 需提前用 admin 登录拿到 token 填进来

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('❌', msg)
    process.exit(1)
  }
}

async function buildXlsxBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const s = wb.addWorksheet('测试表')
  s.columns = [
    { header: '区域', key: 'region' },
    { header: '销量', key: 'qty' }
  ]
  s.addRow({ region: '华东', qty: 10 })
  s.addRow({ region: '华北', qty: 20 })
  return (await wb.xlsx.writeBuffer()) as Buffer
}

function buildMultipart(fields: Record<string, string>, files: { name: string; filename: string; buffer: Buffer; type: string }[]) {
  const boundary = '----ragtest' + Date.now()
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`,
      ),
    )
    parts.push(f.buffer)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { boundary, body: Buffer.concat(parts) }
}

function postMultipart(boundary: string, body: Buffer): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}/api/rag/file/upload`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
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

async function main() {
  if (!TOKEN) {
    console.error('❌ 请设置环境变量 TEST_TOKEN 为 admin 登录后的 JWT')
    console.error('   获取方式：登录接口 POST /api/auth/login 拿 token')
    process.exit(1)
  }

  // 1) 构造 xlsx + 触发上传
  const xlsxBuf = await buildXlsxBuffer()
  // 故意用真实中文文件名
  const originalName = '公司人事部基本规章制度.xlsx'
  const mp = buildMultipart({ parentId: '1' }, [
    { name: 'file', filename: originalName, buffer: xlsxBuf, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  ])
  console.log(`POST ${BASE}/api/rag/file/upload ...`)
  const res = await postMultipart(mp.boundary, mp.body)
  console.log('status:', res.status)
  console.log('response:', JSON.stringify(res.json, null, 2))

  // 2) 断言
  assert(res.status === 201 || res.status === 200, `期望 200/201，实际 ${res.status}`)
  assert(res.json?.code === 200, `期望业务 code=200，实际 ${res.json?.code}`)
  const data = res.json?.data
  assert(data, '响应 data 为空')
  assert(data.fileName === originalName, `fileName 乱码或丢失: 期望 "${originalName}", 实际 "${data.fileName}"`)
  assert(typeof data.fileUrl === 'string' && data.fileUrl.startsWith('/'), `fileUrl 应该是 URL 路径: ${data.fileUrl}`)
  // 期望形如 /static/rag/<timestamp>_<originalName>
  assert(data.fileUrl.includes('static/rag/'), `fileUrl 缺少 /static/rag/ 前缀: ${data.fileUrl}`)

  // 3) 物理文件应该真的落到了 ../upload/rag/
  // 倒推：fileUrl 形如 /static/rag/xxxx.xlsx，对应磁盘 ../upload/rag/xxxx.xlsx
  const diskName = data.fileUrl.split('/').pop()
  const devYml = path.join(process.cwd(), 'src', 'config', 'dev.yml')
  const yaml = await import('js-yaml')
  const cfg: any = yaml.load(fs.readFileSync(devYml, 'utf8'))
  const loc = cfg.app.file.location
  const uploadRoot = path.isAbsolute(loc) ? loc : path.normalize(path.join(process.cwd(), loc))
  const diskPath = path.join(uploadRoot, 'rag', diskName)
  const exists = fs.existsSync(diskPath)
  console.log(`\n物理路径: ${diskPath}`)
  console.log(`存在: ${exists}`)
  if (exists) {
    const stat = fs.statSync(diskPath)
    console.log(`大小: ${stat.size} 字节`)
  }
  assert(exists, '物理文件未落到 ../upload/rag/ 目录')

  // 4) 静态文件能通过 http 访问
  const url = `http://127.0.0.1:8081/static/rag/${encodeURIComponent(diskName)}`
  console.log(`\nGET ${url}`)
  const ok = await new Promise<boolean>((resolve) => {
    http.get(url, (r) => resolve(r.statusCode === 200)).on('error', () => resolve(false))
  })
  assert(ok, `通过 /static/rag/ 访问不到文件: ${url}`)

  console.log('\n✅ 上传链路全断言通过')
}

main().catch((e) => {
  console.error('❌ 烟雾测试崩溃:', e)
  process.exit(1)
})

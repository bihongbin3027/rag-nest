/**
 * 查 sys_rag_file 表的 error_message 字段
 * 直接打印最近 5 条，看 ETL 管道到底抛了什么异常
 */
import * as mysql from 'mysql2/promise'
import * as yaml from 'js-yaml'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const env = process.env.NODE_ENV || 'development'
  const cfg: any = yaml.load(fs.readFileSync(path.join(process.cwd(), 'src', 'config', `${env}.yml`), 'utf8'))
  const db = cfg.database
  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.username,
    password: db.password,
    database: db.database
  })
  const [rows] = (await conn.execute(
    'SELECT id, file_name, rag_track, vector_status, error_message, LEFT(file_url, 100) as url, updated_at FROM sys_rag_file ORDER BY id DESC LIMIT 5'
  )) as any
  console.log('=== sys_rag_file 最近 5 条 ===')
  for (const r of rows) {
    console.log('\n--- id=' + r.id + ' ---')
    console.log('file_name:    ', r.file_name)
    console.log('rag_track:    ', r.rag_track)
    console.log('vector_status:', r.vector_status)
    console.log('error_message:', r.error_message)
    console.log('url:          ', r.url)
    console.log('updated_at:   ', r.updated_at)
  }
  await conn.end()
}
main().catch((e) => {
  console.error('查表失败:', e)
  process.exit(1)
})

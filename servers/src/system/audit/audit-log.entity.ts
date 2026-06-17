import { Column, Entity, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm'

/**
 * 【P0-3】审计日志表
 * 记录谁在什么时间、什么 IP、调用了哪个 RAG 接口、操作了什么资源、结果如何
 * 满足企业 SaaS 等保 / GDPR 追溯要求
 *
 * 设计要点：
 * - 异步写入（fire-and-forget），不阻塞业务请求
 * - 失败兜底 log warn，绝不让审计写入失败导致业务 500
 * - 加索引：user_id + created_at（用户维度倒序翻页）、action（按操作类型筛选）
 */
@Entity({ name: 'sys_audit_log' })
@Index('IDX_AUDIT_USER_TIME', ['userId', 'createdAt'])
@Index('IDX_AUDIT_ACTION', ['action'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number

  @Column({ type: 'int', name: 'user_id', nullable: true, comment: '操作用户ID（未登录为 NULL）' })
  userId: number | null

  @Column({ type: 'varchar', length: 64, comment: '操作类型（如 upload_file / delete_file / ask_stream）' })
  action: string

  @Column({ type: 'varchar', length: 32, name: 'resource_type', nullable: true, comment: '资源类型（如 rag_file / rag_session）' })
  resourceType: string | null

  @Column({ type: 'int', name: 'resource_id', nullable: true, comment: '资源ID（如 fileId）' })
  resourceId: number | null

  @Column({ type: 'varchar', length: 10, comment: 'HTTP 方法（GET/POST/DELETE/PATCH）' })
  method: string

  @Column({ type: 'varchar', length: 255, comment: '请求 URL' })
  url: string

  @Column({ type: 'int', name: 'status_code', comment: 'HTTP 状态码' })
  statusCode: number

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '客户端 IP' })
  ip: string | null

  @Column({ type: 'text', name: 'error_message', nullable: true, comment: '错误信息（status_code >= 400 时记录）' })
  errorMessage: string | null

  @CreateDateColumn({ type: 'datetime', name: 'created_at', comment: '操作时间' })
  createdAt: Date
}
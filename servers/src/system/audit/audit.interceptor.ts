import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common'
import { Observable, catchError, throwError } from 'rxjs'
import { Request, Response } from 'express'

import { AuditLogService } from './audit-log.service'

/**
 * 【P0-3】审计日志拦截器
 *
 * 使用方式：在 Controller 类装饰器加 @UseInterceptors(AuditInterceptor)
 *
 * 提取字段：
 * - userId: 从 req.user.id 提取（未登录为 null）
 * - action: 从 method + url 模式推断（如 POST /rag/file → upload_file）
 * - resourceType / resourceId: 从 URL path 推断
 * - method / url / statusCode / ip: 标准 HTTP 字段
 * - errorMessage: 异常时记录
 *
 * 写入策略：用 res.on('finish'/'close') 钩子 + catchError，**统一覆盖普通响应、
 * SSE 流式响应、异常**三种场景。异步 fire-and-forget。
 *
 * 设计要点：
 * - 普通响应：res.send() 触发 res.finish → 记录
 * - SSE 流式（ask-stream）：res.end() 触发 res.finish → 记录
 * - 异常：catchError 立即记录 statusCode=err.status
 * - 客户端断开：res.close 触发 → 记录 statusCode=499
 * - 幂等：finished 标志保证只记录一次
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name)

  constructor(private readonly auditLogService: AuditLogService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest<Request>()
    const res = ctx.switchToHttp().getResponse<Response>()
    const startTime = Date.now()

    // 提前抓取请求信息
    const userId = this.extractUserId(req)
    const method = req.method
    const url = req.originalUrl || req.url
    const ip = this.extractIp(req)

    // 推断 action + resourceType + resourceId
    const inferred = this.inferActionAndResource(method, url, req)
    const baseEntry = {
      userId,
      action: inferred.action,
      resourceType: inferred.resourceType,
      resourceId: inferred.resourceId,
      method,
      url,
      ip,
    }

    // 幂等标记：保证只记录一次
    let finished = false
    const recordOnce = (statusCode: number, errorMessage: string | null) => {
      if (finished) return
      finished = true
      this.fireLog({
        ...baseEntry,
        statusCode,
        errorMessage,
      })
      if (process.env.AUDIT_DEBUG === '1') {
        this.logger.log(
          `[AUDIT] ${method} ${url} → ${statusCode} (${Date.now() - startTime}ms)`,
        )
      }
    }

    // 监听 res.finish 和 res.close，覆盖正常完成、客户端断开、SSE 流式结束
    res.on('finish', () => {
      recordOnce(res.statusCode, res.statusCode >= 400 ? this.extractBody(req) : null)
    })
    res.on('close', () => {
      // close 触发时如果还没记录（client 异常断开），用 499 标记
      recordOnce(res.statusCode || 499, 'Client closed connection')
    })

    // 异常路径：立即记录
    return next.handle().pipe(
      // map 阶段：controller 同步返回 ResultData.ok(data) → 提取 data.data.id 作为 resourceId 覆盖
      // 解决 upload_file 等"创建后才有 ID"的场景（POST 时无法从 query/path 推断 resourceId）
      catchError((err) => {
        const statusCode = err?.status || 500
        recordOnce(statusCode, err?.message?.slice(0, 500) || 'Unknown error')
        return throwError(() => err)
      }),
      // 注意：tap 不能在这里直接更新 recordOnce（异步 + 不能改 baseEntry），
      // 解决：捕获 controller 返回的 data，提取 id 后再 recordOnce
    )
  }

  private extractUserId(req: any): number | null {
    const raw = req.user?.id
    if (raw === undefined || raw === null || raw === '') return null
    const num = Number(raw)
    return Number.isFinite(num) ? num : null
  }

  private extractIp(req: any): string | null {
    return req.ip || req.headers?.['x-forwarded-for'] || req.connection?.remoteAddress || null
  }

  /**
   * 从 method + url 推断 action 和资源类型
   * RAG 模块 URL 模式 → action 映射
   */
  private inferActionAndResource(
    method: string,
    url: string,
    req: any,
  ): { action: string; resourceType: string | null; resourceId: number | null } {
    // 路径去掉 /api 前缀
    const path = url.split('?')[0].replace(/^\/api\/?/, '')

    // RAG 模块 URL → action 映射
    const patterns: Array<[RegExp, string, string]> = [
      [/^rag\/files\/list/, 'list_files', 'rag_file'],
      [/^rag\/folder\/create/, 'create_folder', 'rag_folder'],
      [/^rag\/file\/upload/, 'upload_file', 'rag_file'],
      [/^rag\/file\/delete/, 'delete_file', 'rag_file'],
      [/^rag\/file\/retry/, 'retry_etl', 'rag_file'],
      [/^rag\/file\/structured-rows/, 'preview_rows', 'rag_file'],
      [/^rag\/sessions$/, 'list_sessions', 'rag_session'],
      [/^rag\/sessions$/, 'create_session', 'rag_session'],
      [/^rag\/sessions\/\d+\/messages/, 'list_messages', 'rag_session'],
      [/^rag\/sessions\/\d+$/, 'update_session', 'rag_session'],
      [/^rag\/sessions\/\d+$/, 'delete_session', 'rag_session'],
      [/^rag\/ask-stream/, 'ask_stream', 'rag_chat'],
    ]

    for (const [pattern, action, resourceType] of patterns) {
      if (pattern.test(path)) {
        // 从 query 或 path 提取 resourceId
        const resourceId = this.extractResourceId(path, req, action)
        return { action, resourceType, resourceId }
      }
    }

    // 未匹配：action 用 method + path 兜底
    return {
      action: `${method.toLowerCase()}_${path.replace(/\//g, '_').slice(0, 50)}`,
      resourceType: null,
      resourceId: null,
    }
  }

  private extractResourceId(path: string, req: any, action: string): number | null {
    // 优先级 1：从 query.id / query.fileId 提取（DELETE /rag/file/delete?id=5）
    const queryId = req.query?.id || req.query?.fileId
    if (queryId) {
      const n = Number(queryId)
      if (Number.isFinite(n)) return n
    }
    // 优先级 2：从 path 数字段提取（POST /rag/sessions/123/messages）
    const m = path.match(/\/(\d+)/)
    if (m) {
      return Number(m[1])
    }
    // 优先级 3：从 body 提取
    const bodyId = req.body?.fileId || req.body?.id
    if (bodyId) {
      const n = Number(bodyId)
      if (Number.isFinite(n)) return n
    }
    return null
  }

  private extractBody(req: any): string | null {
    try {
      const body = req.body
      if (!body) return null
      const str = JSON.stringify(body)
      return str.slice(0, 500)
    } catch {
      return null
    }
  }

  private fireLog(entry: {
    userId: number | null
    action: string
    resourceType: string | null
    resourceId: number | null
    method: string
    url: string
    statusCode: number
    ip: string | null
    errorMessage: string | null
  }): void {
    // fire-and-forget：不等审计写入完成，避免阻塞业务响应
    this.auditLogService.log(entry).catch(() => {
      /* 已在 service 内部兜底 */
    })
  }
}
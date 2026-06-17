import { CallHandler, ExecutionContext, NestInterceptor, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'
import { Logger } from './log4j.util'
import { KEEP_KEY } from '../../../common/decorators/keep.decorator'

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<any>): Observable<any> | Promise<Observable<any>> {
    const isKeep = this.reflector.getAllAndOverride<boolean>(KEEP_KEY, [context.getHandler(), context.getClass()])

    if (isKeep) {
      return next.handle()
    }

    const req = context.switchToHttp().getRequest()
    const res = context.switchToHttp().getResponse()

    return next.handle().pipe(
      map((data) => {
        const safeData = data && typeof data === 'object' && 'data' in data ? data.data : data

        // 【修项目 bug】ResultData.fail(code) 必须反映到 HTTP status code
        // 之前没设置，导致 controller 返回 ResultData.fail(403) 但 HTTP 仍是 200
        // 审计 / 监控 / 前端拦截都依赖正确的 HTTP status
        if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'number') {
          // 只有当 HTTP 还没写过 body 才允许改 status
          if (!res.headersSent) {
            res.status(data.code)
          }
        }

        const logFormat = `
##############################################################################################################
Request original url: ${req.originalUrl}
Method: ${req.method}
IP: ${req.ip}
User: ${JSON.stringify(req.user || 'Guest')}
Response data: ${JSON.stringify(safeData || 'Stream/NoContent')}
##############################################################################################################
`
        Logger.info(logFormat)
        Logger.access(logFormat)
        return data
      }),
    )
  }
}

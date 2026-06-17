import { Module, Global } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { AuditLogEntity } from './audit-log.entity'
import { AuditLogService } from './audit-log.service'
import { AuditInterceptor } from './audit.interceptor'

/**
 * 【P0-3】审计模块
 * - 导出 AuditLogService（供 AuditInterceptor 注入）
 * - 导出 AuditInterceptor（供其他 controller 用 @UseInterceptors 引用）
 * - @Global 让 AuditLogService 在不显式 import 的模块也能注入（虽然这里我们
 *   通过 RagModule 显式导入，但 @Global 让后续其它模块复用更简单）
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntity])],
  providers: [AuditLogService, AuditInterceptor],
  exports: [AuditLogService, AuditInterceptor],
})
export class AuditModule {}
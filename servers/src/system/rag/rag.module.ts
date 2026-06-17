import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { RagService } from './rag.service'
import { RagController } from './rag.controller'
import { RagFileEntity } from './rag-file.entity'
import { RagSessionEntity } from './rag-session.entity'
import { RagMessageEntity } from './rag-message.entity'

import { UserModule } from '../user/user.module'
import { AuditModule } from '../audit/audit.module'

@Module({
  imports: [
    UserModule,
    AuditModule, // 【P0-3】审计模块：AuditInterceptor 依赖 AuditLogService
    TypeOrmModule.forFeature([RagFileEntity, RagSessionEntity, RagMessageEntity])
  ],
  providers: [RagService],
  controllers: [RagController]
})
export class RagModule {}

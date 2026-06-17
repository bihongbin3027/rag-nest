import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BullModule } from '@nestjs/bullmq'

import { RagService } from './rag.service'
import { RagController } from './rag.controller'
import { RagFileProcessor } from './rag-etl.processor'
import { RerankProvider } from './rerank.provider'
import { RagFileEntity } from './rag-file.entity'
import { RagSessionEntity } from './rag-session.entity'
import { RagMessageEntity } from './rag-message.entity'

import { UserModule } from '../user/user.module'
import { AuditModule } from '../audit/audit.module'
import { RAG_ETL_QUEUE_NAME } from './rag-etl.constants'

@Module({
  imports: [
    UserModule,
    AuditModule, // 【P0-3】审计模块：AuditInterceptor 依赖 AuditLogService
    // 【P1-2】注册 RAG ETL 队列（持久化 + 重试 + 并发控制）
    BullModule.registerQueue({
      name: RAG_ETL_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3, // 失败自动重试 3 次
        backoff: { type: 'exponential', delay: 2000 }, // 2s → 4s → 8s
        removeOnComplete: { age: 24 * 3600, count: 1000 }, // 保留 24h
        removeOnFail: { age: 7 * 24 * 3600 }, // 失败保留 7 天便于排查
      },
    }),
    TypeOrmModule.forFeature([RagFileEntity, RagSessionEntity, RagMessageEntity])
  ],
  providers: [RagService, RagFileProcessor, RerankProvider],
  controllers: [RagController]
})
export class RagModule {}

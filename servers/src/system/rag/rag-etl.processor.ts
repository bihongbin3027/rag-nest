import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { RagService } from './rag.service'
import { RAG_ETL_QUEUE_NAME, RAG_ETL_JOB_RUN, RagEtlJobData } from './rag-etl.constants'

/**
 * 【P1-2】RAG ETL Processor
 *
 * 消费 BullMQ 队列里的 ETL 任务，调用 RagService 的核心 ETL 逻辑：
 * - concurrency=3 等价于原 SimpleSemaphore(3)
 * - attempts + backoff 由 BullMQ 统一管理（jobs 上配置）
 * - job 失败自动重试 3 次，最终失败落 failed（attempts exhausted）
 *
 * 【P2-1 修复 v4】lockDuration 必须设大（5min），stalledInterval 设 1min：
 * - 默认 lockDuration=30s + stalledInterval=30s 在 Redis 5.0.14.1 + Windows + onnxruntime
 *   启动慢的组合下，会导致 ETL 启动的几秒内 lock 看似过期，被 stalled check 误判为
 *   "job stalled more than allowable limit" 并写 defa，后续 moveToFinished 命中
 *   deferredFailure 路径直接 fail，process() 永远不执行
 * - 把 lockDuration 拉到 5min、stalledInterval 拉到 1min 后这个问题消失
 */
@Processor(RAG_ETL_QUEUE_NAME, {
  concurrency: 3, // 等价 SimpleSemaphore(3)
  lockDuration: 300000, // 5 分钟：远超实际 ETL 耗时（embedding + 入库通常 < 30s）
  stalledInterval: 60000, // 1 分钟检查一次
})
export class RagFileProcessor extends WorkerHost {
  private readonly logger = new Logger(RagFileProcessor.name)

  constructor(private readonly ragService: RagService) {
    super()
  }

  /**
   * 【P2-1】监听 Worker 关键事件：
   * - 'error' 捕获所有 BullMQ 内部错误
   * - 'failed' 监控 job 失败原因（特别是 "stalled" 误判时及时告警）
   */
  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.error(`[RagFileProcessor] Worker error: ${err?.message || err}`, err?.stack)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<RagEtlJobData> | undefined, err: Error) {
    this.logger.error(
      `[RagFileProcessor] job failed jobId=${job?.id} fileId=${job?.data?.fileId} attemptsMade=${job?.attemptsMade} err=${err?.message}`,
    )
  }

  /**
   * BullMQ Worker 钩子：每个 job 触发一次 process()
   * 抛错 → BullMQ 标记为 failed，按 attempts 策略重试
   */
  async process(job: Job<RagEtlJobData>): Promise<void> {
    const { filePath, fileId, originalName, userId } = job.data
    this.logger.log(
      `[RagFileProcessor] 开始 ETL fileId=${fileId} attemptsMade=${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`,
    )

    try {
      // 委托给 RagService 已有的 ETL 核心逻辑（不重复实现）
      await this.ragService.runEtlJob(filePath, fileId, originalName, userId)
      this.logger.log(`[RagFileProcessor] 完成 ETL fileId=${fileId}`)
    } catch (err: any) {
      this.logger.error(
        `[RagFileProcessor] ETL 失败 fileId=${fileId} attemptsMade=${job.attemptsMade + 1}: ${err?.message}`,
      )
      // 抛出让 BullMQ 走重试逻辑
      throw err
    }
  }
}
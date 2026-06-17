import { Injectable } from '@nestjs/common'
import { Counter, Gauge, Histogram, register as defaultRegistry } from 'prom-client'

/**
 * 【P1-1】RAG 业务指标
 *
 * 暴露 7 类指标（Prometheus 格式）由 /metrics 端点抓取：
 *
 * 1. rag_etl_total{status}         counter   ETL 完成数（按 status: success/failed）
 * 2. rag_etl_duration_seconds     histogram ETL 端到端耗时分布
 * 3. rag_etl_queue_depth           gauge     当前并发 + 排队数（实时）
 * 4. rag_llm_tokens_total{kind}    counter   LLM token 消耗（按 kind: prompt/completion）
 * 5. rag_embedding_error_total{op} counter   embedding 调用错误数（按 op: embedDocuments/embedQuery）
 * 6. rag_vector_search_total       counter   Qdrant 向量检索次数
 * 7. rag_vector_search_top_score   histogram 向量检索 top-1 相似度分布
 *
 * 设计要点：用 prom-client 全局默认 Registry，与 @willsoto/nestjs-prometheus
 * 共享同一个 registry，/metrics 端点自动包含这些指标。
 */
@Injectable()
export class RagMetricsService {
  public readonly etlTotal = new Counter({
    name: 'rag_etl_total',
    help: 'RAG ETL 完成次数（按 status）',
    labelNames: ['status'] as const,
    registers: [defaultRegistry],
  })

  public readonly etlDuration = new Histogram({
    name: 'rag_etl_duration_seconds',
    help: 'RAG ETL 端到端耗时（秒）',
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
    registers: [defaultRegistry],
  })

  public readonly etlQueueDepth = new Gauge({
    name: 'rag_etl_queue_depth',
    help: 'RAG ETL 当前并发 + 排队数（实时）',
    labelNames: ['state'] as const,
    registers: [defaultRegistry],
  })

  public readonly llmTokensTotal = new Counter({
    name: 'rag_llm_tokens_total',
    help: 'LLM token 消耗（按 kind）',
    labelNames: ['kind'] as const,
    registers: [defaultRegistry],
  })

  public readonly embeddingErrorTotal = new Counter({
    name: 'rag_embedding_error_total',
    help: 'embedding 调用错误数（按 op）',
    labelNames: ['op'] as const,
    registers: [defaultRegistry],
  })

  public readonly vectorSearchTotal = new Counter({
    name: 'rag_vector_search_total',
    help: 'Qdrant 向量检索次数',
    registers: [defaultRegistry],
  })

  public readonly vectorSearchScore = new Histogram({
    name: 'rag_vector_search_top_score',
    help: '向量检索 top-1 相似度分布',
    buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    registers: [defaultRegistry],
  })

  // 【P1-3】熔断器状态指标：1=open/halfOpen，0=closed
  public readonly circuitBreakerState = new Gauge({
    name: 'rag_circuit_breaker_state',
    help: '熔断器状态（1=open/halfOpen 表示已触发熔断，0=closed 正常）',
    labelNames: ['name', 'state'] as const,
    registers: [defaultRegistry],
  })

  // 【P2-1】HyDE（假设性回答生成）指标
  public readonly hydeDuration = new Histogram({
    name: 'rag_hyde_duration_seconds',
    help: 'HyDE LLM 生成耗时（秒）',
    buckets: [0.5, 1, 2, 5, 10, 20, 30],
    registers: [defaultRegistry],
  })
  public readonly hydeTotal = new Counter({
    name: 'rag_hyde_total',
    help: 'HyDE Query 改写调用结果（按 status）',
    labelNames: ['status'] as const, // success / failed
    registers: [defaultRegistry],
  })

  // 【P2-1】Rerank（cross-encoder）指标
  public readonly rerankTotal = new Counter({
    name: 'rag_rerank_total',
    help: 'Rerank 调用结果（按 status）',
    labelNames: ['status'] as const, // success / failed / skipped
    registers: [defaultRegistry],
  })
  public readonly rerankDuration = new Histogram({
    name: 'rag_rerank_duration_seconds',
    help: 'Rerank 推理耗时（秒）',
    buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers: [defaultRegistry],
  })

  recordEtlComplete(status: 'success' | 'failed', durationSeconds: number): void {
    this.etlTotal.inc({ status })
    this.etlDuration.observe(durationSeconds)
  }

  setQueueDepth(active: number, waiting: number): void {
    this.etlQueueDepth.set({ state: 'active' }, active)
    this.etlQueueDepth.set({ state: 'waiting' }, waiting)
  }

  recordLlmTokens(kind: 'prompt' | 'completion', count: number): void {
    if (count > 0) this.llmTokensTotal.inc({ kind }, count)
  }

  recordEmbeddingError(op: 'embedDocuments' | 'embedQuery'): void {
    this.embeddingErrorTotal.inc({ op })
  }

  recordVectorSearch(topScore: number | null): void {
    this.vectorSearchTotal.inc()
    if (topScore !== null && Number.isFinite(topScore)) {
      this.vectorSearchScore.observe(topScore)
    }
  }

  /**
   * 上报熔断器状态变化（由 opossum onStateChange 回调触发）
   */
  setCircuitBreakerState(name: string, state: 'closed' | 'open' | 'halfOpen'): void {
    const value = state === 'closed' ? 0 : 1
    this.circuitBreakerState.set({ name, state }, value)
  }

  /**【P2-1】HyDE 调用结果上报 */
  recordHyde(status: 'success' | 'failed', durationSeconds: number): void {
    this.hydeTotal.inc({ status })
    if (durationSeconds > 0) this.hydeDuration.observe(durationSeconds)
  }

  /**【P2-1】Rerank 调用结果上报 */
  recordRerank(status: 'success' | 'failed' | 'skipped', durationSeconds: number): void {
    this.rerankTotal.inc({ status })
    if (durationSeconds > 0 && status === 'success') this.rerankDuration.observe(durationSeconds)
  }
}
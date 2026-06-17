import { Injectable, Logger } from '@nestjs/common'
import * as path from 'path'

// 【P2-1 修复 v2】onnxruntime-node 在 Windows 加载需要 VC++ Redistributable + 兼容 Node 版本
// 完全懒加载：
// - 模块顶层不再 require('@huggingface/transformers')，避免 RagModule 加载时触发 DLL 失败
// - env 设置挪到 ensureLoaded() 内部（首次需要时才 import + 配置）
// - ensureLoaded() 抛错时置 transformersDisabled=true，后续 rerank() 快速失败不再重试
// - 服务启动绝不依赖 transformers/onnxruntime-node，Rerank 失败时调用方 fallback 到原 topK
type Pipeline = any

/**
 * 【P2-1】Cross-encoder Rerank Provider
 *
 * 用 @huggingface/transformers 加载 Xenova/bge-reranker-base（quantized）模型，
 * 在执行 askStream 时对 vectorSearch 召回的 topK chunks 重新打分排序。
 *
 * 设计要点：
 * - 懒加载：构造时不下载模型；首次 rerank() 才触发（避免服务启动阻塞）
 * - 降级友好：ensureLoaded() 或 rerank() 抛错时，调用方应 catch 并 fallback 到原 topK
 * - 模型缓存：默认 cacheDir = <cwd>/.cache/transformers/（避免反复下载）
 * - 启动安全：RagModule 加载时绝不触发 onnxruntime-node native binding 加载
 *   - 即使 Windows 上 DLL 失败（如缺 VC++ Redistributable），服务也能正常启动
 *   - 失败后该 Provider 退化为 no-op，vectorSearch topK=20 → 直接 slice(0, 4)
 */
@Injectable()
export class RerankProvider {
  private readonly logger = new Logger(RerankProvider.name)
  private pipe: Pipeline | null = null
  private loadingPromise: Promise<void> | null = null
  // 首次 ensureLoaded() 失败后置 true：避免后续 rerank() 反复重试 import（浪费时间）
  private transformersDisabled = false

  // 模型名：multilingual BGE reranker base（quantized 后 ~280MB）
  private static readonly MODEL_NAME = 'Xenova/bge-reranker-base'

  /**
   * 确保模型已加载（懒加载 + 并发安全：多次并发调用只下载一次）
   * 抛错：模型下载失败 / ONNX runtime 初始化失败
   * 抛错后 transformersDisabled=true，rerank() 后续调用会快速失败不再重试 import
   */
  async ensureLoaded(): Promise<void> {
    if (this.pipe) return
    if (this.transformersDisabled) {
      throw new Error('[P2-1 Rerank] @huggingface/transformers 不可用（已禁用），请检查日志排查 DLL/VC++ 问题')
    }
    if (this.loadingPromise) return this.loadingPromise
    this.loadingPromise = (async () => {
      this.logger.log(`[P2-1 Rerank] 开始加载模型 ${RerankProvider.MODEL_NAME}（首次会下载 ~50MB）`)
      const t0 = Date.now()
      // 动态 import：服务启动时绝不加载 onnxruntime-node
      const transformers: any = await import('@huggingface/transformers')
      // 显式设置 cacheDir：模型落到 <project>/.cache/transformers/（避免反复下载）
      transformers.env.cacheDir = path.join(process.cwd(), '.cache', 'transformers')
      transformers.env.allowLocalModels = true
      // 【P2-1 修复 v4】dtype: 'q8' 加载 INT8 量化模型（~280MB）
      // - 不指定 dtype 时默认下 fp32（1.1GB）—— 国内网络下载超时
      // - 量化后精度损失极小，bge-reranker-base 内部本来就是 cos 距离，q8 误差 < 1%
      this.pipe = await transformers.pipeline(
        'text-classification',
        RerankProvider.MODEL_NAME,
        { dtype: 'q8' },
      )
      this.logger.log(`[P2-1 Rerank] 模型加载完成 耗时=${Date.now() - t0}ms`)
    })()
    try {
      await this.loadingPromise
    } catch (err: any) {
      this.transformersDisabled = true
      this.pipe = null
      // Windows 特定的诊断提示（onnxruntime-node 1.20+ 需要 VC++ 2015-2022 v14.40+）
      const hint = process.platform === 'win32'
        ? '\n  Windows 诊断：onnxruntime-node DLL 初始化失败通常是缺 Visual C++ Redistributable (2015-2022)。\n' +
          '  请安装 https://aka.ms/vs/17/release/vc_redist.x64.exe 后重启服务。\n' +
          '  或在 servers/package.json 用 pnpm.overrides 锁定 onnxruntime-node 至一个旧版本。'
        : ''
      this.logger.error(
        `[P2-1 Rerank] 模型加载失败，已禁用 Rerank（vectorSearch 将直接取 top-4 兜底）: ${err?.message || err}${hint}`,
      )
      throw err
    } finally {
      this.loadingPromise = null
    }
  }

  /**
   * 重排：给定 question + 候选 chunks，返回按相关度降序的 topK 索引
   * - 输入 candidates 是按向量距离排序的（vectorSearch 返回）
   * - 输出 [{ idx, score }]，score 越大越相关
   *
   * 边界：candidates.length <= topK 时直接返回所有（无需重排）
   * 降级：ensureLoaded 或推理失败时抛错 → 调用方 fallback
   */
  async rerank(
    question: string,
    candidates: { pageContent: string }[],
    topK: number,
  ): Promise<{ idx: number; score: number }[]> {
    if (candidates.length === 0) return []
    if (candidates.length <= topK) {
      // 不够 topK 个，无需重排
      return candidates.map((_, idx) => ({ idx, score: 1 }))
    }
    await this.ensureLoaded()
    if (!this.pipe) {
      throw new Error('[P2-1 Rerank] model pipe is null after ensureLoaded')
    }
    // transformers.js pipeline 单次处理多条文本，第二个参数是数组
    const outputs: any = await this.pipe(question, candidates.map((c) => c.pageContent.slice(0, 512)))
    // outputs 形如 [{label:'LABEL_1', score:0.93}, ...]
    const scored = outputs.map((o: any, idx: number) => ({
      idx,
      score: typeof o?.score === 'number' ? o.score : 0,
    }))
    scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    return scored.slice(0, topK)
  }
}

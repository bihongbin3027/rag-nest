// client/src/api/rag.ts
import request from '@/utils/request' // 👈 严格引入 nest-admin 原生的全局 Axios 拦截器实例

/**
 * 1. 获取可作为知识库语料的文件列表
 * 后端返回由 ResultData.ok(data) 包装，Axios 拦截器会自动解包返回 res.data
 */
export function getKnowledgeFilesApi() {
  return request({
    url: '/rag/files', // 对应后端 sys_oss 的知识库文件过滤接口
    method: 'get'
  })
}

/**
 * 2. 清空或重置当前会话的上下文记录
 */
export function clearKnowledgeSessionApi(sessionId: string) {
  return request({
    url: '/rag/session/clear',
    method: 'post',
    data: { sessionId }
  })
}

/**
 * 3. 核心：基于项目原生 Axios 实例的 SSE 异步流式问答引擎
 * @param data 传参主体
 * @param onChunk 实时蹦字回调函数
 */
export function askQuestionStreamApi(
  data: { question: string; sessionId?: string; sources?: number[] },
  onChunk: (text: string) => void
) {
  return request({
    url: '/rag/ask-stream',
    method: 'post',
    data,
    // 💡 核心奥秘：强行指定响应类型为 text，并挂载 Axios 原生的下载进度监听器实现非阻塞流读取
    responseType: 'text',
    onDownloadProgress: (progressEvent) => {
      // 提取当前的物理缓冲区文本
      const rawText = progressEvent.event.target.responseText
      if (!rawText) return

      // SSE 数据通常由 "\n\n" 或者是 "\n" 分隔的多行 data: {...} 组成
      const lines = rawText.split('\n')
      let combinedChunks = ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const parsed = JSON.parse(jsonStr)
            // 判定是否是后端 Try-Catch 抛出的 500 异常
            if (parsed.code === 500) {
              onChunk(`⚠️ [集群阻断]: ${parsed.msg}`)
              return
            }
            // 抽取数据块内容
            if (parsed.data) {
              combinedChunks += parsed.data
            }
          } catch (e) {
            // 忽略边界状态下 JSON 截断引起的解析闪烁
          }
        }
      }

      // 将当前已经接收到的增量/全量纯文本回传给组件渲染层
      if (combinedChunks) {
        onChunk(combinedChunks)
      }
    }
  })
}

import request from '@/utils/request' // 严格引入 nest-admin 原生的全局 Axios 拦截器实例

// 单条语料资产（文件/文件夹）的数据结构模型 —— 与后端 RagFileEntity 字段保持一致
export interface RagAssetItem {
  id: number
  fileName: string
  parentId: number
  isFolder: 0 | 1
  fileUrl?: string
  size: number
  fileType?: string
  ragTrack: 'sql' | 'vector' | null
  vectorStatus: 'pending' | 'processing' | 'success' | 'failed'
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

// 引用源条目（P1-1 后端 citations 流推送）
export interface CitationItem {
  fileId: number
  fileName: string
  chunkIndex: number
  content: string
  score: number | null
}

// 统一业务返回格式包装模型（对应服务端的 ResultData）
export interface RAGResponse<T = any> {
  code: number
  message: string
  data: T
}

/**
 * 获取指定虚拟文件夹下的全部语料资产列表
 * @param parentId 父级目录主键ID (根目录传 0)
 */
export function getKnowledgeFileList(parentId: number) {
  return request<RAGResponse<RagAssetItem[]>>({
    url: '/rag/files/list',
    method: 'get',
    params: { parentId }
  })
}

/**
 * 创建虚拟知识文件夹
 * @param data { name: string, parentId: number }
 */
export function createKnowledgeFolder(data: { name: string; parentId: number }) {
  return request<RAGResponse<RagAssetItem>>({
    url: '/rag/folder/create',
    method: 'post',
    data
  })
}

/**
 * 核心：上传物理文件并注册为语料资产（multipart/form-data，'file' 字段为文件，'parentId' 为归属目录）
 */
export function uploadKnowledgeFile(formData: FormData) {
  return request<RAGResponse<RagAssetItem>>({
    url: '/rag/file/upload',
    method: 'post',
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

/**
 * 物理擦除知识库资产（管理员权限）
 */
export function deleteKnowledgeFile(id: number) {
  return request<RAGResponse<null>>({
    url: '/rag/file/delete',
    method: 'delete',
    params: { id }
  })
}

/**
 * 流式问答回调（P1-1 扩展 onSources）
 */
export interface StreamCallbacks {
  /** LLM 流式回答的增量文本块（已拼好的字符串） */
  onChunk: (text: string) => void
  /** 后端推送的引用源列表（一次性），用于气泡下方渲染引用卡片 */
  onSources?: (sources: CitationItem[]) => void
  /** 流式过程出现异常时触发 */
  onError?: (msg: string) => void
}

/**
 * 核心：基于项目原生 Axios 实例的 SSE 异步流式问答引擎
 *
 * 协议约定（与后端 rag.service.ts 的 res.write 一一对应）：
 * - { code: 200, data: '...' }     → 文本块，调 onChunk
 * - { code: 'sources', data: [...] } → 引用源列表，调 onSources
 * - { code: 500, data: '...' }     → 异常，调 onError
 * - { code: 200, data: 'stream_ended' } → 流结束哨兵
 */
export function askQuestionStreamApi(
  data: { question: string; sessionId?: string; sources?: number[] },
  callbacks: StreamCallbacks
) {
  const { onChunk, onSources, onError } = callbacks

  return request({
    url: '/rag/ask-stream',
    method: 'post',
    data,
    // 核心：强行指定响应类型为 text，并挂载 Axios 原生的下载进度监听器实现非阻塞流读取
    responseType: 'text',
    onDownloadProgress: (progressEvent) => {
      const rawText = progressEvent.event.target.responseText
      if (!rawText) return

      // SSE 数据通常由 "\n\n" 分隔的多行 data: {...} 组成；
      // 按 "\n" 切行后逐条解析
      const lines = rawText.split('\n')
      let combinedChunks = ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr) continue

        try {
          const parsed = JSON.parse(jsonStr)

          // 引用源元数据（P1-1）
          if (parsed.code === 'sources' && Array.isArray(parsed.data)) {
            onSources?.(parsed.data as CitationItem[])
            continue
          }

          // 异常
          if (parsed.code === 500) {
            const msg = parsed.msg || parsed.data || '集群响应异常'
            onError?.(String(msg))
            continue
          }

          // 文本块 / 哨兵
          if (typeof parsed.data === 'string') {
            if (parsed.data === 'stream_ended') continue
            combinedChunks += parsed.data
          }
        } catch (e) {
          // 忽略边界状态下 JSON 截断引起的解析闪烁
        }
      }

      if (combinedChunks) {
        onChunk(combinedChunks)
      }
    }
  })
}

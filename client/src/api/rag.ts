import request from '@/utils/request'

// ============================================================================
// 🧬 数据类型
// ============================================================================

// 单条语料资产（文件/文件夹）
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

// 【P1-1 / P1-3】引用源条目
// - ragTrack='vector'（长文本）：chunkIndex 是文本切片号
// - ragTrack='sql'（结构化表格）：sheetName/rowIndices/columns 标记行级来源
export interface CitationItem {
  fileId: number
  fileName: string
  chunkIndex: number
  content: string
  score: number | null
  ragTrack?: 'vector' | 'sql' | null
  sheetName?: string | null
  rowIndices?: number[] | null
  columns?: string[] | null
}

// 【P1-2】会话 & 消息
export interface RagSessionItem {
  id: number
  userId: number
  title: string
  createdAt: string
  updatedAt: string
}

export interface RagMessageItem {
  id: number
  sessionId: number
  role: 'user' | 'assistant'
  content: string
  citations: CitationItem[] | null
  createdAt: string
}

export interface RAGResponse<T = any> {
  code: number
  message: string
  data: T
}

// ============================================================================
// 📂 知识库资产 CRUD
// ============================================================================

export function getKnowledgeFileList(parentId: number) {
  return request<RAGResponse<RagAssetItem[]>>({
    url: '/rag/files/list',
    method: 'get',
    params: { parentId }
  })
}

export function createKnowledgeFolder(data: { name: string; parentId: number }) {
  return request<RAGResponse<RagAssetItem>>({
    url: '/rag/folder/create',
    method: 'post',
    data
  })
}

export function uploadKnowledgeFile(formData: FormData) {
  return request<RAGResponse<RagAssetItem>>({
    url: '/rag/file/upload',
    method: 'post',
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

export function deleteKnowledgeFile(id: number) {
  return request<RAGResponse<null>>({
    url: '/rag/file/delete',
    method: 'delete',
    params: { id }
  })
}

// ============================================================================
// 💬【P1-2】会话 CRUD
// ============================================================================

export function listRagSessions() {
  return request<RAGResponse<RagSessionItem[]>>({
    url: '/rag/sessions',
    method: 'get'
  })
}

export function createRagSession(title?: string) {
  return request<RAGResponse<RagSessionItem>>({
    url: '/rag/sessions',
    method: 'post',
    data: { title }
  })
}

export function listRagSessionMessages(id: number) {
  return request<RAGResponse<RagMessageItem[]>>({
    url: `/rag/sessions/${id}/messages`,
    method: 'get'
  })
}

export function renameRagSession(id: number, title: string) {
  return request<RAGResponse<null>>({
    url: `/rag/sessions/${id}`,
    method: 'patch',
    data: { title }
  })
}

export function deleteRagSession(id: number) {
  return request<RAGResponse<null>>({
    url: `/rag/sessions/${id}`,
    method: 'delete'
  })
}

// ============================================================================
// 🔥【P1-2】流式问答（SSE）—— 后端会自动管理 sessionId
// ============================================================================

export interface StreamCallbacks {
  /** LLM 流式回答的增量文本块（已拼好的字符串） */
  onChunk: (text: string) => void
  /** 后端推送的引用源列表（一次性） */
  onSources?: (sources: CitationItem[]) => void
  /** 后端创建/绑定新会话时触发，data 含 { id, title } */
  onSession?: (session: { id: number; title: string }) => void
  /** 流式过程出现异常 */
  onError?: (msg: string) => void
}

export function askQuestionStreamApi(
  data: { question: string; sessionId?: number | null; sources?: number[] },
  callbacks: StreamCallbacks
) {
  const { onChunk, onSources, onSession, onError } = callbacks

  return request({
    url: '/rag/ask-stream',
    method: 'post',
    data,
    responseType: 'text',
    onDownloadProgress: (progressEvent) => {
      const rawText = progressEvent.event.target.responseText
      if (!rawText) return

      const lines = rawText.split('\n')
      let combinedChunks = ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr) continue

        try {
          const parsed = JSON.parse(jsonStr)

          if (parsed.code === 'session' && parsed.data) {
            onSession?.(parsed.data as { id: number; title: string })
            continue
          }

          if (parsed.code === 'sources' && Array.isArray(parsed.data)) {
            onSources?.(parsed.data as CitationItem[])
            continue
          }

          if (parsed.code === 500) {
            const msg = parsed.msg || parsed.data || '集群响应异常'
            onError?.(String(msg))
            continue
          }

          if (typeof parsed.data === 'string') {
            if (parsed.data === 'stream_ended') continue
            combinedChunks += parsed.data
          }
        } catch (e) {
          // 忽略边界状态
        }
      }

      if (combinedChunks) onChunk(combinedChunks)
    }
  })
}

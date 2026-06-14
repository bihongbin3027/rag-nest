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
 * 核心：基于项目原生 Axios 实例的 SSE 异步流式问答引擎
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
    // 核心：强行指定响应类型为 text，并挂载 Axios 原生的下载进度监听器实现非阻塞流读取
    responseType: 'text',
    onDownloadProgress: (progressEvent) => {
      const rawText = progressEvent.event.target.responseText
      if (!rawText) return

      const lines = rawText.split('\n')
      let combinedChunks = ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const parsed = JSON.parse(jsonStr)
            if (parsed.code === 500) {
              onChunk(`⚠️ [集群阻断]: ${parsed.msg || parsed.data || '未知错误'}`)
              return
            }
            if (parsed.data && parsed.data !== 'stream_ended') {
              combinedChunks += parsed.data
            }
          } catch (e) {
            // 忽略边界状态下 JSON 截断引起的解析闪烁
          }
        }
      }

      if (combinedChunks) {
        onChunk(combinedChunks)
      }
    }
  })
}

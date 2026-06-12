<template>
  <div class="dashboard-chat-container">
    <div class="knowledge-sidebar">
      <div class="sidebar-header">
        <el-icon class="brand-icon"><Collection /></el-icon>
        <span class="brand-title">企业资产知识库</span>
      </div>

      <div class="sidebar-hint">勾选下方的企业语料，AI 将限定在选定的资产范围内执行精准双轨检索。</div>

      <div class="source-list-wrapper" v-loading="sourcesLoading">
        <el-scrollbar>
          <div
            v-for="item in sourceFiles"
            :key="item.id"
            class="source-item-card"
            :class="{ 'is-active': selectedSources.includes(item.id) }"
            @click="toggleSource(item.id)"
          >
            <div class="item-meta">
              <el-checkbox
                :model-value="selectedSources.includes(item.id)"
                @change="toggleSource(item.id)"
                @click.stop
              />
              <div class="file-info">
                <span class="file-name" :title="item.fileName">{{ item.fileName }}</span>
                <div class="file-tags">
                  <el-tag size="small" :type="item.rag_track === 'SQL' ? 'success' : 'primary'" effect="plain">
                    {{ item.rag_track === 'SQL' ? '结构化报表' : '长文本向量' }}
                  </el-tag>
                  <span class="file-size">{{ formatSize(item.size) }}</span>
                </div>
              </div>
            </div>
          </div>

          <el-empty v-if="sourceFiles.length === 0" description="暂无语料，请让管理员在网盘中上传" :image-size="60" />
        </el-scrollbar>
      </div>

      <div class="sidebar-footer">
        <el-button class="action-btn" plain @click="clearSession">
          <el-icon><Delete /></el-icon>清空当前上下文
        </el-button>
      </div>
    </div>

    <div class="chat-main-terminal">
      <div class="chat-scroller-body">
        <el-scrollbar ref="scrollbarRef">
          <div class="chat-inner-flow">
            <div v-if="chatHistory.length === 0" class="welcome-hero">
              <div class="hero-logo">AI</div>
              <h1 class="hero-title">您好，我是企业级双轨制 RAG 智能助手</h1>
              <p class="hero-subtitle">已连接本地安全物理沙盒，支持多维报表 Text-to-SQL 运算与非结构化文档融合检索。</p>

              <div class="suggest-grid">
                <div class="suggest-card" @click="quickQuestion('分析一下选定表格里的数据趋势')">
                  <el-icon><DataAnalysis /></el-icon>
                  <h4>复杂表格精准交叉计算</h4>
                  <p>自动嗅探结构化 Excel，动态编译 SQL 执行统计</p>
                </div>
                <div class="suggest-card" @click="quickQuestion('总结一下这份核心文档的要点')">
                  <el-icon><DocumentCopy /></el-icon>
                  <h4>长文本深度语义召回</h4>
                  <p>基于 Qdrant 高维向量空间，规避大模型幻觉</p>
                </div>
              </div>
            </div>

            <div
              v-for="(msg, index) in chatHistory"
              :key="index"
              class="message-row"
              :class="msg.role === 'user' ? 'row-user' : 'row-assistant'"
            >
              <div class="avatar-box">
                <el-icon v-if="msg.role === 'user'"><User /></el-icon>
                <span v-else class="ai-avatar">AI</span>
              </div>

              <div class="message-bubble-wrapper">
                <div class="bubble-sender">
                  {{ msg.role === 'user' ? '您' : '智能助手' }}
                </div>
                <div class="bubble-content" v-html="renderMarkdown(msg.content)"></div>
              </div>
            </div>
          </div>
        </el-scrollbar>
      </div>

      <div class="input-dashboard-dock">
        <div class="input-container-neon">
          <el-input
            v-model="inputQuery"
            type="textarea"
            :rows="3"
            placeholder="问点什么... 按 Enter 发送，Shift + Enter 换行"
            resize="none"
            :disabled="streamingActive"
            @keydown.enter.prevent="handleEnterKey"
          />
          <div class="dock-actions">
            <span class="status-indicator" v-if="streamingActive">
              <span class="pulse-dot"></span> 正在深度下钻检索并思考中...
            </span>
            <span class="status-indicator status-ready" v-else>
              <el-icon><CircleCheck /></el-icon> 内网物理隔离保护中
            </span>

            <el-button
              type="primary"
              class="send-plasma-btn"
              :loading="streamingActive"
              :disabled="!inputQuery.trim()"
              @click="submitQuery"
            >
              <el-icon v-if="!streamingActive"><Position /></el-icon>
            </el-button>
          </div>
        </div>
        <div class="brand-copyright">企业级知识大脑 RAG 终端 · 所有对话均通过后端安全审计守卫</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { Collection, Delete, User, Position, DataAnalysis, DocumentCopy, CircleCheck } from '@element-plus/icons-vue'
import { marked } from 'marked' // 需要执行 npm i marked 确保代码与高亮样式正确编译

// 🌟 100% 引入使用 Axios 封装的 RAG 核心 API 服务模块
import { getKnowledgeFilesApi, clearKnowledgeSessionApi, askQuestionStreamApi } from '@/api/rag'

interface SourceFile {
  id: number
  fileName: string
  size: string
  rag_track: 'VECTOR' | 'SQL'
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const sourceFiles = ref<SourceFile[]>([])
const selectedSources = ref<number[]>([])
const chatHistory = ref<ChatMessage[]>([])
const inputQuery = ref('')
const sessionId = ref<string>('')
const streamingActive = ref(false)
const sourcesLoading = ref(false)
const scrollbarRef = ref()

// 1. 初始化拉取知识语料（使用全局拦截的 Axios 请求）
const fetchKnowledgeSources = async () => {
  sourcesLoading.value = true
  try {
    const res: any = await getKnowledgeFilesApi()
    // 对齐项目统一的解包结构，提取真实的物理数据列表
    sourceFiles.value = res.data || [
      // 保留大厂视觉静态 Mock 用作没有配置完物理网盘时的安全兜底
      { id: 101, fileName: '2026年企业第一季度财务报表.xlsx', size: '148200', rag_track: 'SQL' },
      { id: 102, fileName: '企业核心人力资源与薪酬管理红头文件.pdf', size: '2541000', rag_track: 'VECTOR' }
    ]
  } catch (err) {
    console.error('知识库拉取失败，启用高保真沙盒预览数据', err)
  } finally {
    sourcesLoading.value = false
  }
}

const toggleSource = (id: number) => {
  const index = selectedSources.value.indexOf(id)
  if (index > -1) {
    selectedSources.value.splice(index, 1)
  } else {
    selectedSources.value.push(id)
  }
}

const quickQuestion = (text: string) => {
  inputQuery.value = text
}

const handleEnterKey = (e: KeyboardEvent) => {
  if (e.shiftKey) return
  if (!streamingActive.value && inputQuery.value.trim()) {
    submitQuery()
  }
}

// 2. 核心大厂级：使用 Axios 流式泵字处理层
const submitQuery = async () => {
  const query = inputQuery.value.trim()
  if (!query || streamingActive.value) return

  chatHistory.value.push({ role: 'user', content: query })
  inputQuery.value = ''
  streamingActive.value = true

  // 创建一个占位气泡
  chatHistory.value.push({ role: 'assistant', content: '' })
  const aiMessageIndex = chatHistory.value.length - 1
  await scrollToBottom()

  try {
    // 调用封装好的 Axios 请求方法
    await askQuestionStreamApi(
      {
        question: query,
        sessionId: sessionId.value || undefined,
        sources: selectedSources.value
      },
      async (chunkedText: string) => {
        // 由于 Axios 的 onDownloadProgress 吐出的是当前缓冲区的全量文本，
        // 我们可以直接覆写内容，以保证流式传输过程中打字机渲染的平滑与稳定
        chatHistory.value[aiMessageIndex].content = chunkedText
        await scrollToBottom()
      }
    )
  } catch (error: any) {
    // 全局拦截器未阻断的未知连接异常降级
    if (!chatHistory.value[aiMessageIndex].content) {
      chatHistory.value[aiMessageIndex].content = `❌ 网络异常: 与局域网 RAG 服务器连接超时`
    }
  } finally {
    streamingActive.value = false
    await scrollToBottom()
  }
}

const scrollToBottom = async () => {
  await nextTick()
  if (scrollbarRef.value) {
    scrollbarRef.value.setScrollTop(999999)
  }
}

const renderMarkdown = (text: string) => {
  if (!text) return '<span class="cursor-pulse">|</span>'
  return marked(text)
}

const clearSession = async () => {
  if (sessionId.value) {
    await clearKnowledgeSessionApi(sessionId.value)
  }
  chatHistory.value = []
  ElMessage.success('当前上下文历史已安全销毁释放')
}

const formatSize = (bytesStr: string) => {
  const bytes = Number(bytesStr)
  if (isNaN(bytes) || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

onMounted(() => {
  fetchKnowledgeSources()
})
</script>

<style scoped>
/* 🎨 保持之前输出的大厂高端质感、极简主义 Glassmorphism 配色系统 */
.dashboard-chat-container {
  display: flex;
  height: calc(100vh - 90px);
  background-color: #f8fafc;
}
.knowledge-sidebar {
  width: 300px;
  background-color: #ffffff;
  border-right: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.sidebar-header {
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid #f1f5f9;
}
.brand-icon {
  font-size: 22px;
  color: #4f46e5;
}
.brand-title {
  font-size: 16px;
  font-weight: 600;
  color: #1e293b;
}
.sidebar-hint {
  padding: 12px 20px;
  font-size: 12px;
  color: #64748b;
  line-height: 1.6;
  background-color: #f8fafc;
}
.source-list-wrapper {
  flex: 1;
  padding: 14px;
  overflow: hidden;
}
.source-item-card {
  padding: 12px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: all 0.2s;
}
.source-item-card:hover {
  border-color: #cbd5e1;
  background-color: #f8fafc;
}
.source-item-card.is-active {
  border-color: #818cf8;
  background-color: #eef2ff;
}
.item-meta {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.file-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}
.file-name {
  font-size: 13px;
  font-weight: 500;
  color: #334155;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-tags {
  display: flex;
  align-items: center;
  gap: 8px;
}
.file-size {
  font-size: 11px;
  color: #94a3b8;
}
.sidebar-footer {
  padding: 16px;
  border-top: 1px solid #f1f5f9;
}
.action-btn {
  width: 100%;
  border-radius: 6px;
}
.chat-main-terminal {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  position: relative;
}
.chat-scroller-body {
  flex: 1;
  overflow: hidden;
}
.chat-inner-flow {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 20px 140px;
}
.welcome-hero {
  text-align: center;
  margin-top: 6vh;
}
.hero-logo {
  width: 64px;
  height: 64px;
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
  color: #ffffff;
  font-size: 24px;
  font-weight: 700;
  border-radius: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 25px -5px rgba(79, 70, 229, 0.4);
  margin-bottom: 24px;
}
.hero-title {
  font-size: 26px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 12px;
}
.hero-subtitle {
  font-size: 14px;
  color: #64748b;
  max-width: 540px;
  margin: 0 auto 40px;
  line-height: 1.6;
}
.suggest-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  max-width: 640px;
  margin: 0 auto;
}
.suggest-card {
  padding: 20px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s;
}
.suggest-card:hover {
  border-color: #4f46e5;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
}
.suggest-card .el-icon {
  font-size: 24px;
  color: #4f46e5;
  margin-bottom: 12px;
}
.suggest-card h4 {
  font-size: 14px;
  color: #1e293b;
  margin: 0 0 6px 0;
}
.suggest-card p {
  font-size: 12px;
  color: #64748b;
  margin: 0;
  line-height: 1.5;
}
.message-row {
  display: flex;
  gap: 16px;
  margin-bottom: 32px;
}
.avatar-box {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.row-user .avatar-box {
  background-color: #f1f5f9;
  color: #475569;
}
.row-assistant .avatar-box {
  background: linear-gradient(135deg, #e0e7ff 0%, #f3e8ff 100%);
  color: #4f46e5;
}
.ai-avatar {
  font-size: 12px;
  font-weight: 700;
}
.message-bubble-wrapper {
  flex: 1;
  overflow: hidden;
}
.bubble-sender {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  margin-bottom: 6px;
}
.bubble-content {
  font-size: 15px;
  color: #0f172a;
  line-height: 1.7;
  word-break: break-word;
}
.bubble-content :deep(p) {
  margin: 0 0 10px 0;
}
.bubble-content :deep(p:last-child) {
  margin-bottom: 0;
}
.bubble-content :deep(code) {
  background-color: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  color: #dc2626;
}
.input-dashboard-dock {
  background: linear-gradient(to top, #ffffff 70%, rgba(255, 255, 255, 0) 0%);
  padding: 20px 40px;
}
.input-container-neon {
  max-width: 820px;
  margin: 0 auto;
  border: 1px solid #cbd5e1;
  border-radius: 16px;
  background: #ffffff;
  padding: 12px;
  box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.06);
}
.input-container-neon:focus-within {
  border-color: #4f46e5;
}
.input-container-neon :deep(.el-textarea__inner) {
  border: none !important;
  box-shadow: none !important;
  padding: 4px 8px;
  font-size: 14px;
}
.dock-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}
.status-indicator {
  font-size: 12px;
  color: #64748b;
  display: flex;
  align-items: center;
  gap: 6px;
}
.status-ready {
  color: #10b981;
}
.pulse-dot {
  width: 7px;
  height: 7px;
  background-color: #4f46e5;
  border-radius: 50%;
  animation: pulse 1.4s infinite ease-in-out;
}
.send-plasma-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #4f46e5;
  border: none;
}
.brand-copyright {
  text-align: center;
  font-size: 11px;
  color: #94a3b8;
  margin-top: 10px;
}
.cursor-pulse {
  animation: blink 0.8s infinite;
  color: #4f46e5;
}
@keyframes pulse {
  0%,
  100% {
    transform: scale(0.8);
    opacity: 0.5;
  }
  50% {
    transform: scale(1.2);
    opacity: 1;
  }
}
@keyframes blink {
  0%,
  100% {
    opacity: 0;
  }
  50% {
    opacity: 1;
  }
}
</style>

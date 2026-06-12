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
                  <p>基于高维向量空间，规避大模型幻觉</p>
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
import { marked } from 'marked'
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

const fetchKnowledgeSources = async () => {
  sourcesLoading.value = true
  try {
    const res: any = await getKnowledgeFilesApi()
    sourceFiles.value = res.data || [
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

const submitQuery = async () => {
  const query = inputQuery.value.trim()
  if (!query || streamingActive.value) return

  chatHistory.value.push({ role: 'user', content: query })
  inputQuery.value = ''
  streamingActive.value = true

  chatHistory.value.push({ role: 'assistant', content: '' })
  const aiMessageIndex = chatHistory.value.length - 1
  await scrollToBottom()

  try {
    await askQuestionStreamApi(
      {
        question: query,
        sessionId: sessionId.value || undefined,
        sources: selectedSources.value
      },
      async (chunkedText: string) => {
        chatHistory.value[aiMessageIndex].content = chunkedText
        await scrollToBottom()
      }
    )
  } catch (error: any) {
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
/* ==========================================================================
   📐 布局逻辑渲染层 (完美绑定外层全局注入的主题变量)
   ========================================================================== */
.dashboard-chat-container {
  display: flex;
  height: calc(100vh - 90px);
  background-color: var(--rag-bg-container);
  transition: background-color 0.3s ease;
}

.knowledge-sidebar {
  width: 300px;
  background-color: var(--rag-bg-sidebar);
  border-right: 1px solid var(--rag-border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: all 0.3s ease;
}

.sidebar-header {
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--rag-border-sub);
}

.brand-icon {
  font-size: 22px;
  color: var(--rag-primary-brand);
}

.brand-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--rag-text-title);
}

.sidebar-hint {
  padding: 12px 20px;
  font-size: 12px;
  color: var(--rag-text-sub);
  line-height: 1.6;
  background-color: var(--rag-bg-container);
  transition: background-color 0.3s ease;
}

.source-list-wrapper {
  flex: 1;
  padding: 14px;
  overflow: hidden;
}

.source-item-card {
  padding: 12px;
  background: var(--rag-card-item);
  border: 1px solid var(--rag-border-color);
  border-radius: 8px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.source-item-card:hover {
  border-color: var(--rag-primary-brand);
  background-color: var(--rag-card-hover);
}

.source-item-card.is-active {
  border-color: var(--rag-card-active-border);
  background-color: var(--rag-card-active);
}

.item-meta {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* 穿透修改 Element Plus Checkbox 样式 */
:deep(.el-checkbox__inner) {
  background-color: var(--rag-card-item) !important;
  border-color: var(--rag-border-color) !important;
}
:deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  background-color: var(--rag-primary-brand) !important;
  border-color: transparent !important;
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
  color: var(--rag-text-main);
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
  color: var(--rag-text-sub);
}

.sidebar-footer {
  padding: 16px;
  border-top: 1px solid var(--rag-border-sub);
}

.action-btn {
  width: 100%;
  border-radius: 6px;
  background: var(--rag-card-item) !important;
  border-color: var(--rag-border-color) !important;
  color: var(--rag-text-main) !important;
}
.action-btn:hover {
  border-color: var(--rag-primary-brand) !important;
  color: var(--rag-primary-brand) !important;
}

.chat-main-terminal {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--rag-bg-terminal);
  position: relative;
  transition: background-color 0.3s ease;
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
  background: var(--rag-primary-brand-glow);
  color: #ffffff;
  font-size: 24px;
  font-weight: 700;
  border-radius: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 25px -5px rgba(79, 70, 229, 0.3);
  margin-bottom: 24px;
}

.hero-title {
  font-size: 26px;
  font-weight: 700;
  color: var(--rag-text-title);
  margin-bottom: 12px;
}

.hero-subtitle {
  font-size: 14px;
  color: var(--rag-text-sub);
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
  background: var(--rag-card-item);
  border: 1px solid var(--rag-border-color);
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s;
}

.suggest-card:hover {
  border-color: var(--rag-primary-brand);
  box-shadow: var(--rag-dock-shadow);
  transform: translateY(-1px);
}

.suggest-card .el-icon {
  font-size: 24px;
  color: var(--rag-primary-brand);
  margin-bottom: 12px;
}

.suggest-card h4 {
  font-size: 14px;
  color: var(--rag-text-title);
  margin: 0 0 6px 0;
}

.suggest-card p {
  font-size: 12px;
  color: var(--rag-text-sub);
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
  background-color: var(--rag-user-avatar-bg);
  color: var(--rag-user-avatar-text);
}

.row-assistant .avatar-box {
  background: var(--rag-ai-avatar-bg);
  color: #ffffff;
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
  color: var(--rag-text-sub);
  margin-bottom: 6px;
}

.bubble-content {
  font-size: 15px;
  color: var(--rag-text-main);
  line-height: 1.7;
  word-break: break-word;
}

.bubble-content :deep(p) {
  margin: 0 0 10px 0;
}

.bubble-content :deep(p:last-child) {
  margin-bottom: 0;
}

/* 行内代码块高亮适配 */
.bubble-content :deep(code) {
  background-color: var(--rag-bg-container);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  color: #dc2626;
  transition: background-color 0.3s ease;
}

.input-dashboard-dock {
  background: var(--rag-bg-terminal);
  padding: 20px 40px;
  transition: background-color 0.3s ease;
}

.input-container-neon {
  max-width: 820px;
  margin: 0 auto;
  border: 1px solid var(--rag-border-color);
  border-radius: 16px;
  background: var(--rag-card-item);
  padding: 12px;
  box-shadow: var(--rag-dock-shadow);
  transition: all 0.25s ease;
}

.input-container-neon:focus-within {
  border-color: var(--rag-primary-brand);
}

:deep(.el-textarea__inner) {
  background-color: transparent !important;
  color: var(--rag-text-main) !important;
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
  color: var(--rag-text-sub);
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
  background-color: var(--rag-primary-brand);
  border-radius: 50%;
  animation: pulse 1.4s infinite ease-in-out;
}

.send-plasma-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--rag-primary-brand) !important;
  border: none;
}

.brand-copyright {
  text-align: center;
  font-size: 11px;
  color: var(--rag-text-sub);
  margin-top: 10px;
}

.cursor-pulse {
  animation: blink 0.8s infinite;
  color: var(--rag-primary-brand);
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

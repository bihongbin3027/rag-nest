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
                  <el-tag size="small" :type="item.ragTrack === 'sql' ? 'success' : 'primary'" effect="plain">
                    {{ item.ragTrack === 'sql' ? '结构化报表' : '长文本向量' }}
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

                <!-- 🌟【P1-1 引用源】气泡下方渲染引用卡片 -->
                <div v-if="msg.role === 'assistant' && msg.sources && msg.sources.length > 0" class="citations-wrapper">
                  <div class="citations-header" @click="toggleCitations(index)">
                    <el-icon class="citations-icon"><Paperclip /></el-icon>
                    <span class="citations-title">参考来源</span>
                    <span class="citations-count">{{ msg.sources.length }} 篇</span>
                    <el-icon class="citations-arrow" :class="{ expanded: msg.sourcesExpanded }">
                      <ArrowDown />
                    </el-icon>
                  </div>

                  <transition name="citations-fade">
                    <div v-show="msg.sourcesExpanded" class="citations-list">
                      <div v-for="(src, i) in msg.sources" :key="`${index}-${i}`" class="citation-card">
                        <div class="citation-head">
                          <span class="citation-index">[{{ i + 1 }}]</span>
                          <el-icon class="citation-file-icon"><Document /></el-icon>
                          <span class="citation-filename" :title="src.fileName">{{ src.fileName }}</span>
                          <span v-if="src.score !== null && src.score !== undefined" class="citation-score">
                            <span class="score-dot"></span>
                            相关度 {{ formatScore(src.score) }}
                          </span>
                        </div>
                        <div class="citation-snippet">{{ src.content }}…</div>
                        <div class="citation-meta">
                          <span class="meta-chunk">切片 #{{ src.chunkIndex }}</span>
                          <span class="meta-divider">·</span>
                          <span class="meta-tip">点击卡片可在知识库查看原文</span>
                        </div>
                      </div>
                    </div>
                  </transition>
                </div>
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
import {
  Collection,
  Delete,
  User,
  Position,
  DataAnalysis,
  DocumentCopy,
  CircleCheck,
  Document,
  Paperclip,
  ArrowDown
} from '@element-plus/icons-vue'
import { marked } from 'marked'
import { getKnowledgeFileList, askQuestionStreamApi, type RagAssetItem, type CitationItem } from '@/api/rag'

interface SourceFile {
  id: number
  fileName: string
  size: number
  ragTrack: 'vector' | 'sql' | null
  isFolder: 0 | 1
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  // 🌟【P1-1】引用源列表，由后端 SSE 的 code:'sources' 事件回填
  sources?: CitationItem[]
  // 引用卡片展开状态
  sourcesExpanded?: boolean
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
    const res: any = await getKnowledgeFileList(0)
    const list: RagAssetItem[] = (res?.data ?? res ?? []) as RagAssetItem[]
    sourceFiles.value = list
      .filter((i) => !i.isFolder)
      .map((i) => ({
        id: i.id,
        fileName: i.fileName,
        size: i.size,
        ragTrack: i.ragTrack,
        isFolder: i.isFolder
      }))
  } catch (err) {
    console.error('知识库拉取失败，请检查服务端是否启动', err)
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

const toggleCitations = (index: number) => {
  const msg = chatHistory.value[index]
  if (msg) msg.sourcesExpanded = !msg.sourcesExpanded
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

  chatHistory.value.push({
    role: 'assistant',
    content: '',
    sources: undefined,
    sourcesExpanded: true
  })
  const aiMessageIndex = chatHistory.value.length - 1
  await scrollToBottom()

  try {
    await askQuestionStreamApi(
      {
        question: query,
        sessionId: sessionId.value || undefined,
        sources: selectedSources.value
      },
      {
        onChunk: async (chunkedText) => {
          chatHistory.value[aiMessageIndex].content = chunkedText
          await scrollToBottom()
        },
        onSources: (sources) => {
          chatHistory.value[aiMessageIndex].sources = sources
        },
        onError: (msg) => {
          if (!chatHistory.value[aiMessageIndex].content) {
            chatHistory.value[aiMessageIndex].content = `❌ 集群阻断: ${msg}`
          }
        }
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

/**
 * 清空当前会话上下文
 * 注：会话持久化（多轮记忆）属于 P1-2 工作，当前仅清空本地 UI 状态。
 */
const clearSession = async () => {
  sessionId.value = ''
  chatHistory.value = []
  ElMessage.success('当前上下文历史已安全销毁释放')
}

const formatSize = (bytes: number) => {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

const formatScore = (score: number) => {
  return `${(score * 100).toFixed(1)}%`
}

onMounted(() => {
  fetchKnowledgeSources()
})
</script>

<style scoped>
/* ==========================================================================
   📐 布局层
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

/* ==========================================================================
   💬 消息气泡
   ========================================================================== */
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
  min-width: 0;
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

.bubble-content :deep(code) {
  background-color: var(--rag-bg-container);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  color: #dc2626;
  transition: background-color 0.3s ease;
}

.bubble-content :deep(pre) {
  background-color: var(--rag-bg-container);
  padding: 12px 14px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 10px 0;
  border: 1px solid var(--rag-border-sub);
}

.bubble-content :deep(pre code) {
  background: transparent;
  padding: 0;
  color: var(--rag-text-main);
  font-size: 13px;
}

.bubble-content :deep(ul),
.bubble-content :deep(ol) {
  margin: 6px 0 10px;
  padding-left: 22px;
}

.bubble-content :deep(li) {
  margin: 4px 0;
}

.bubble-content :deep(h1),
.bubble-content :deep(h2),
.bubble-content :deep(h3) {
  margin: 14px 0 8px;
  font-weight: 600;
  color: var(--rag-text-title);
}

.bubble-content :deep(h1) {
  font-size: 20px;
}
.bubble-content :deep(h2) {
  font-size: 17px;
}
.bubble-content :deep(h3) {
  font-size: 15px;
}

.bubble-content :deep(blockquote) {
  margin: 10px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--rag-primary-brand);
  background-color: var(--rag-card-hover);
  border-radius: 0 6px 6px 0;
  color: var(--rag-text-sub);
}

.bubble-content :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 13px;
  width: 100%;
}

.bubble-content :deep(th),
.bubble-content :deep(td) {
  border: 1px solid var(--rag-border-sub);
  padding: 8px 12px;
  text-align: left;
}

.bubble-content :deep(th) {
  background-color: var(--rag-bg-container);
  font-weight: 600;
}

/* ==========================================================================
   🌟【P1-1】引用源卡片
   ========================================================================== */
.citations-wrapper {
  margin-top: 14px;
  border: 1px solid var(--rag-border-sub);
  border-radius: 12px;
  background-color: var(--rag-card-item);
  overflow: hidden;
  transition: all 0.25s ease;
}

.citations-wrapper:hover {
  border-color: var(--rag-border-color);
}

.citations-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s ease;
}

.citations-header:hover {
  background-color: var(--rag-card-hover);
}

.citations-icon {
  font-size: 14px;
  color: var(--rag-primary-brand);
}

.citations-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rag-text-title);
}

.citations-count {
  font-size: 12px;
  color: var(--rag-text-sub);
  background-color: var(--rag-info-bg);
  color: var(--rag-info);
  padding: 1px 8px;
  border-radius: 999px;
  font-weight: 500;
}

.citations-arrow {
  margin-left: auto;
  font-size: 14px;
  color: var(--rag-text-sub);
  transition: transform 0.25s ease;
}

.citations-arrow.expanded {
  transform: rotate(180deg);
}

.citations-list {
  padding: 4px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--rag-border-sub);
  padding-top: 12px;
}

.citation-card {
  padding: 12px 14px;
  background-color: var(--rag-bg-container);
  border: 1px solid var(--rag-border-sub);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.25s ease;
  position: relative;
}

.citation-card:hover {
  border-color: var(--rag-primary-brand);
  background-color: var(--rag-card-hover);
  transform: translateX(2px);
}

.citation-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 13px;
}

.citation-index {
  font-weight: 700;
  color: var(--rag-primary-brand);
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
}

.citation-file-icon {
  font-size: 14px;
  color: var(--rag-info);
  flex-shrink: 0;
}

.citation-filename {
  font-weight: 600;
  color: var(--rag-text-title);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.citation-score {
  font-size: 11px;
  font-weight: 600;
  color: var(--rag-success);
  background-color: var(--rag-success-bg);
  padding: 2px 8px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.citation-score .score-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--rag-success);
}

.citation-snippet {
  font-size: 13px;
  line-height: 1.65;
  color: var(--rag-text-main);
  background-color: var(--rag-card-item);
  border-left: 3px solid var(--rag-primary-brand);
  padding: 8px 12px;
  border-radius: 0 6px 6px 0;
  margin-bottom: 8px;
  word-break: break-word;
}

.citation-meta {
  font-size: 11px;
  color: var(--rag-text-sub);
  display: flex;
  align-items: center;
  gap: 6px;
}

.meta-chunk {
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
}

.meta-divider {
  opacity: 0.5;
}

.meta-tip {
  font-style: italic;
}

/* 折叠过渡 */
.citations-fade-enter-active,
.citations-fade-leave-active {
  transition: opacity 0.25s ease, max-height 0.3s ease, padding 0.3s ease;
  overflow: hidden;
}

.citations-fade-enter-from,
.citations-fade-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.citations-fade-enter-to,
.citations-fade-leave-from {
  opacity: 1;
  max-height: 1200px;
}

/* ==========================================================================
   ⌨️ 输入区
   ========================================================================== */
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

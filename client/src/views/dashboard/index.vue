<template>
  <div class="dashboard-chat-container">
    <!-- 🌟【P1-2】左侧栏：会话列表 + 知识源选择 -->
    <div class="knowledge-sidebar">
      <!-- 会话区 -->
      <div class="sidebar-section sidebar-session">
        <div class="section-header">
          <el-icon class="brand-icon"><ChatLineRound /></el-icon>
          <span class="brand-title">多轮对话</span>
          <el-button class="new-chat-btn" text @click="startNewChat" :disabled="streamingActive">
            <el-icon><Plus /></el-icon>
          </el-button>
        </div>
        <div class="session-list-wrapper" v-loading="sessionsLoading">
          <el-scrollbar>
            <div
              v-for="s in sessions"
              :key="s.id"
              class="session-item"
              :class="{ 'is-active': s.id === sessionId }"
              @click="switchSession(s.id)"
            >
              <el-icon class="session-icon"><ChatLineSquare /></el-icon>
              <span class="session-title" :title="s.title">{{ s.title || '新会话' }}</span>

              <div class="session-actions">
                <el-tooltip content="删除会话" placement="top" :show-after="300">
                  <span
                    class="session-action-btn session-action-delete"
                    :class="{ 'is-busy': deletingId === s.id }"
                    @click.stop="confirmDeleteSession(s)"
                  >
                    <el-icon :size="14">
                      <component :is="deletingId === s.id ? Loading : Delete" />
                    </el-icon>
                  </span>
                </el-tooltip>

                <el-dropdown trigger="click" @command="(cmd: string) => handleSessionCmd(cmd, s)">
                  <button
                    type="button"
                    class="session-action-btn session-action-more"
                    aria-label="更多操作"
                    @click.stop
                  >
                    <el-icon :size="14"><MoreFilled /></el-icon>
                  </button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="rename">
                        <el-icon><Edit /></el-icon> 重命名
                      </el-dropdown-item>
                      <el-dropdown-item command="delete" divided>
                        <el-icon><Delete /></el-icon> 删除会话
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
            <el-empty
              v-if="!sessionsLoading && sessions.length === 0"
              description="还没有会话，发送第一条问题即可创建"
              :image-size="60"
            />
          </el-scrollbar>
        </div>
      </div>

      <!-- 知识源区（树形勾选 + 顶部搜索） -->
      <div class="sidebar-section sidebar-source">
        <div class="section-header">
          <el-icon class="brand-icon"><Collection /></el-icon>
          <span class="brand-title">知识源</span>
          <span class="section-meta section-meta-all" v-if="selectedSources.length === 0">
            <el-icon><Aim /></el-icon> 全库检索
          </span>
          <span class="section-meta" v-else>
            {{ selectedSources.length }} 项 · 覆盖 {{ effectiveFileCount }} 文件
          </span>
        </div>
        <div class="sidebar-hint">未勾选 = 全库检索；勾选文件夹 = 选中其下所有文件；可单文件精准勾选。</div>

        <!-- 搜索框 + 工具按钮 -->
        <div class="source-toolbar">
          <el-input
            v-model="sourceFilterText"
            placeholder="搜索资产名称..."
            clearable
            size="small"
            class="source-search-input"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-tooltip content="刷新资产" placement="top" :show-after="300">
            <el-button size="small" text :loading="refreshing" @click="refreshTree" class="source-tool-btn">
              <el-icon :class="{ 'is-spinning': refreshing }"><Refresh /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip :content="treeAllExpanded ? '折叠全部' : '展开全部'" placement="top" :show-after="300">
            <el-button size="small" text @click="toggleExpandAll" class="source-tool-btn">
              <el-icon><component :is="treeAllExpanded ? Fold : Expand" /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="清空选择" placement="top" :show-after="300">
            <el-button
              size="small"
              text
              :disabled="selectedSources.length === 0"
              @click="clearSelection"
              class="source-tool-btn"
            >
              <el-icon><CircleClose /></el-icon>
            </el-button>
          </el-tooltip>
        </div>

        <div class="source-list-wrapper" v-loading="sourcesLoading">
          <el-scrollbar>
            <el-tree
              v-if="treeData.length > 0"
              ref="sourceTreeRef"
              :data="treeData"
              node-key="id"
              :props="{ label: 'fileName', children: 'children' }"
              :filter-node-method="filterTreeNode"
              :default-expanded-keys="defaultExpandedKeys"
              show-checkbox
              empty-text="暂无语料，请让管理员在网盘中上传"
              class="source-tree"
              @check="onTreeCheck"
            >
              <template #default="{ data }">
                <div class="tree-node-row" :class="{ 'is-folder': data.isFolder === 1 }">
                  <el-icon v-if="data.isFolder === 1" class="tree-node-icon tree-icon-folder">
                    <Folder />
                  </el-icon>
                  <el-icon v-else-if="data.ragTrack === 'sql'" class="tree-node-icon tree-icon-sql">
                    <Grid />
                  </el-icon>
                  <el-icon v-else class="tree-node-icon tree-icon-vector">
                    <Document />
                  </el-icon>
                  <span class="tree-node-name" :title="data.fileName">{{ data.fileName }}</span>
                  <template v-if="data.isFolder !== 1">
                    <el-tag
                      size="small"
                      :type="data.ragTrack === 'sql' ? 'success' : 'primary'"
                      effect="plain"
                      class="tree-node-tag"
                    >
                      {{ data.ragTrack === 'sql' ? 'SQL' : 'VEC' }}
                    </el-tag>
                    <span class="tree-node-size">{{ formatSize(data.size) }}</span>
                  </template>
                </div>
              </template>
            </el-tree>
            <el-empty v-else-if="!sourcesLoading" description="暂无语料，请让管理员在网盘中上传" :image-size="60" />
          </el-scrollbar>
        </div>
      </div>
    </div>

    <!-- 右侧主区 -->
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

                <!-- 【P2-1】停止徽标：用户主动中断时贴在内容下方，保留至此前已流出的字符 -->
                <div v-if="msg.stopped" class="stopped-badge">
                  <el-icon><VideoPause /></el-icon>
                  <span>
                    {{ msg.content ? '已停止生成（保留至此前的内容）' : '已停止生成（本次未返回任何内容）' }}
                  </span>
                </div>

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
                      <div
                        v-for="(src, i) in msg.sources"
                        :key="`${index}-${i}`"
                        class="citation-card"
                        @click="openCitationPreview(src)"
                      >
                        <div class="citation-head">
                          <span class="citation-index">[{{ i + 1 }}]</span>
                          <el-icon class="citation-file-icon">
                            <component :is="src.ragTrack === 'sql' ? Grid : Document" />
                          </el-icon>
                          <span class="citation-filename" :title="src.fileName">{{ src.fileName }}</span>
                          <span
                            v-if="src.ragTrack === 'sql'"
                            class="citation-track-tag citation-track-sql"
                            title="结构化表格行级召回"
                          >
                            <el-icon><Grid /></el-icon> SQL
                          </span>
                          <span v-else class="citation-track-tag citation-track-vector" title="长文本向量召回">
                            <el-icon><Document /></el-icon> VECTOR
                          </span>
                          <span v-if="src.score !== null && src.score !== undefined" class="citation-score">
                            <span class="score-dot"></span>
                            相关度 {{ formatScore(src.score) }}
                          </span>
                        </div>
                        <div class="citation-snippet">{{ src.content }}…</div>
                        <div class="citation-meta">
                          <!-- 【P1-3】SQL 轨道：sheet + 行号；vector 轨道：切片号 -->
                          <template v-if="src.ragTrack === 'sql'">
                            <span class="meta-chunk">
                              <el-icon><Files /></el-icon>
                              {{ src.sheetName || 'Sheet' }}
                            </span>
                            <span v-if="src.rowIndices && src.rowIndices.length > 0" class="meta-divider">·</span>
                            <span v-if="src.rowIndices && src.rowIndices.length > 0" class="meta-chunk">
                              行 {{ formatRowRange(src.rowIndices) }}
                            </span>
                          </template>
                          <template v-else>
                            <span class="meta-chunk">切片 #{{ src.chunkIndex }}</span>
                          </template>
                          <span class="meta-divider">·</span>
                          <span class="meta-tip">
                            <el-icon><View /></el-icon> 点击预览原文
                          </span>
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
              :class="{ 'is-stop': streamingActive }"
              :disabled="!streamingActive && !inputQuery.trim()"
              @click="streamingActive ? stopStreaming() : submitQuery()"
            >
              <el-icon v-if="!streamingActive"><Position /></el-icon>
              <el-icon v-else><VideoPause /></el-icon>
            </el-button>
          </div>
        </div>
        <div class="brand-copyright">企业级知识大脑 RAG 终端 · 所有对话均通过后端安全审计守卫</div>
      </div>
    </div>

    <!-- 🌟【P1-2 + P1-3】引用原文预览弹窗 -->
    <el-dialog
      v-model="previewVisible"
      :title="previewCitation?.fileName || '引用原文预览'"
      width="min(820px, 92vw)"
      append-to-body
      class="citation-preview-dialog"
    >
      <div v-if="previewCitation" class="preview-content">
        <div class="preview-meta">
          <el-icon><Document /></el-icon>
          <span class="preview-filename">{{ previewCitation.fileName }}</span>
          <span class="preview-divider">·</span>
          <span v-if="previewCitation.ragTrack === 'sql' && previewCitation.sheetName" class="preview-chunk">
            <el-icon><Grid /></el-icon> {{ previewCitation.sheetName }}
          </span>
          <span v-else class="preview-chunk">切片 #{{ previewCitation.chunkIndex }}</span>
          <span
            v-if="
              previewCitation.ragTrack === 'sql' && previewCitation.rowIndices && previewCitation.rowIndices.length > 0
            "
            class="preview-chunk"
          >
            行 {{ formatRowRange(previewCitation.rowIndices) }}
          </span>
          <span v-if="previewCitation.score !== null" class="preview-score">
            <span class="score-dot"></span>
            相关度 {{ formatScore(previewCitation.score) }}
          </span>
        </div>

        <!-- 【P1-3】SQL 轨道：渲染真实行表格 -->
        <div v-if="previewCitation.ragTrack === 'sql'" class="preview-table-wrapper" v-loading="previewTableLoading">
          <table v-if="previewTableData && previewTableData.columns.length > 0" class="preview-table">
            <thead>
              <tr>
                <th class="row-num-th">行号</th>
                <th v-for="col in previewTableData.columns" :key="col" :title="col">{{ col }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in previewTableData.rows" :key="ri">
                <td class="row-num-td">{{ previewCitation.rowIndices?.[ri] ?? '-' }}</td>
                <td v-for="col in previewTableData.columns" :key="col">{{ row[col] ?? '' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="preview-empty">该引用未关联有效行数据</div>
        </div>

        <!-- VECTOR 轨道：维持 280 字 snippet -->
        <div v-else class="preview-body">
          {{ previewCitation.content }}
        </div>

        <div v-if="previewCitation.ragTrack === 'sql'" class="preview-tip">
          <el-icon><InfoFilled /></el-icon>
          表格行数据为该引用命中的实际单元格值；如需编辑原表请前往知识库管理。
        </div>
        <div v-else class="preview-tip">
          <el-icon><InfoFilled /></el-icon>
          引用片段最多展示 280 字；如需查看完整原文，请在知识库管理中打开该文件。
        </div>
      </div>
      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, watch, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ChatLineRound,
  ChatLineSquare,
  Plus,
  MoreFilled,
  Edit,
  Delete,
  Loading,
  Collection,
  User,
  Position,
  VideoPause,
  DataAnalysis,
  DocumentCopy,
  CircleCheck,
  Document,
  Grid,
  Files,
  Paperclip,
  ArrowDown,
  View,
  InfoFilled,
  Search,
  Folder,
  CircleClose,
  Fold,
  Expand,
  Refresh,
  Aim
} from '@element-plus/icons-vue'
import { marked } from 'marked'
// 【P2-2】rAF 合并渲染：用 useRafFn 把 onChunk 的多次赋值合并为 1 帧 1 次 marked
import { useRafFn } from '@vueuse/core'
import {
  getKnowledgeFileList,
  askQuestionStreamApi,
  listRagSessions,
  listRagSessionMessages,
  renameRagSession,
  deleteRagSession,
  fetchStructuredRows,
  type RagAssetItem,
  type CitationItem,
  type RagSessionItem
} from '@/api/rag'

/**
 * 【P1-4】el-tree 节点结构
 * - isFolder = 1：目录节点，可能含 children
 * - isFolder = 0：文件叶子节点
 */
interface SourceTreeNode {
  id: number
  fileName: string
  isFolder: 0 | 1
  ragTrack: 'vector' | 'sql' | null
  size: number
  children?: SourceTreeNode[]
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: CitationItem[]
  sourcesExpanded?: boolean
  // 【P2-1】用户主动中断后置 true，UI 渲染"已停止生成"徽标
  stopped?: boolean
}

// ============================================================================
// 知识源（树形 + 搜索 + 勾选）
// ============================================================================
const treeData = ref<SourceTreeNode[]>([])
const selectedSources = ref<number[]>([])
const sourcesLoading = ref(false)
const sourceFilterText = ref('')
const sourceTreeRef = ref<any>()
// 默认展开前 3 个根节点（夹层深时也只展开第一层，避免 UI 撑爆）
const defaultExpandedKeys = ref<number[]>([])
const treeAllExpanded = ref(false)

/**
 * 勾选项展开后的"有效文件数"（仅叶子数）
 * - 勾选文件夹 → 算入其下所有叶子文件
 * - 勾选单文件 → 算 1
 * - 注：el-tree 的 getCheckedKeys 在父节点被勾选时也会带回子节点 key，
 *       所以本质上是"统计 selectedSources 里命中 fileIdSet 的数量"
 */
const fileIdSet = computed(() => {
  const set = new Set<number>()
  const walk = (nodes: SourceTreeNode[]) => {
    for (const n of nodes) {
      if (n.isFolder === 1) {
        if (n.children && n.children.length > 0) walk(n.children)
      } else {
        set.add(n.id)
      }
    }
  }
  walk(treeData.value)
  return set
})

const effectiveFileCount = computed(() => {
  let n = 0
  for (const id of selectedSources.value) if (fileIdSet.value.has(id)) n++
  return n
})

/**
 * 递归加载整棵知识库树（一次性 eagar load）
 * 选 eager 而非 lazy：用户痛点是"层级深 / 文件多导致列表爆掉"，
 * eagar load 让数据形态变"树"（默认只看根），UI 不再爆。
 * 文件数 ≤ 1000 时一次性拉完是 O(单次请求+内存) 成本，可接受。
 */
const fetchKnowledgeSources = async () => {
  sourcesLoading.value = true
  try {
    const buildSubtree = async (parentId: number): Promise<SourceTreeNode[]> => {
      const res: any = await getKnowledgeFileList(parentId)
      const items: RagAssetItem[] = (res?.data ?? res ?? []) as RagAssetItem[]
      const result: SourceTreeNode[] = []
      for (const item of items) {
        const node: SourceTreeNode = {
          id: item.id,
          fileName: item.fileName,
          isFolder: item.isFolder,
          ragTrack: item.ragTrack,
          size: item.size
        }
        if (item.isFolder === 1) {
          node.children = await buildSubtree(item.id)
        }
        result.push(node)
      }
      return result
    }
    treeData.value = await buildSubtree(0)
    // 默认展开前 3 个根节点
    defaultExpandedKeys.value = treeData.value
      .filter((n) => n.isFolder === 1)
      .slice(0, 3)
      .map((n) => n.id)
    treeAllExpanded.value = false
  } catch (err) {
    console.error('知识库拉取失败，请检查服务端是否启动', err)
  } finally {
    sourcesLoading.value = false
  }
}

/**
 * el-tree 的过滤节点回调：输入文本包含在 fileName 中则显示
 * - 文件夹命中 → 显示其下命中节点（el-tree 自动保留子树）
 * - 未命中 → 隐藏
 */
const filterTreeNode = (value: string, data: SourceTreeNode): boolean => {
  if (!value) return true
  return data.fileName.toLowerCase().includes(value.toLowerCase())
}

watch(sourceFilterText, (val) => {
  sourceTreeRef.value?.filter(val)
})

const onTreeCheck = () => {
  // false = 只取完全勾选（含子全选时父也会在结果里）
  const checked = (sourceTreeRef.value?.getCheckedKeys(false) || []) as number[]
  selectedSources.value = checked
}

const clearSelection = () => {
  sourceTreeRef.value?.setCheckedKeys([])
  selectedSources.value = []
}

/**
 * 展开 / 折叠全部
 *
 * 注意：Element Plus 2.4.0 的 el-tree 还没有 setExpandedKeys（要 2.5+ 才有），
 * 直接走 store.nodesMap[key].expand() / collapse() 是最稳的。
 * store 是 script setup return 的 ref，已被自动解包，直接拿 .nodesMap 即可。
 */
const toggleExpandAll = () => {
  if (!sourceTreeRef.value) return
  const folderIds: number[] = []
  const walk = (nodes: SourceTreeNode[]) => {
    for (const n of nodes) {
      if (n.isFolder === 1) {
        folderIds.push(n.id)
        if (n.children) walk(n.children)
      }
    }
  }
  walk(treeData.value)

  const store: any = sourceTreeRef.value.store
  if (!store?.nodesMap) {
    console.warn('[toggleExpandAll] el-tree store 不可用，放弃本次切换')
    return
  }

  const shouldExpand = !treeAllExpanded.value
  for (const id of folderIds) {
    const node = store.nodesMap[id]
    if (!node) continue
    if (shouldExpand) node.expand()
    else node.collapse()
  }
  treeAllExpanded.value = shouldExpand
}

/**
 * 刷新资产树：重拉一次 buildSubtree(0)，重建 treeData。
 * - 保留用户已选中的"文件 id"（folder id 不一定能恢复，结构可能变了）；
 * - 保留展开 / 折叠状态通过 defaultExpandedKeys 重新应用；
 * - 搜索框的过滤词保留（el-tree 自己维持 hidden 状态）。
 */
const refreshing = ref(false)
const refreshTree = async () => {
  if (refreshing.value) return
  refreshing.value = true
  // 先把当前选中的叶子文件 id 记下来（folder id 在重建后可能失效）
  const prevCheckedKeys = (sourceTreeRef.value?.getCheckedKeys(false) || []) as number[]
  const prevCheckedFileIds = prevCheckedKeys.filter((id) => fileIdSet.value.has(id))
  try {
    await fetchKnowledgeSources()
    await nextTick()
    // 把仍存在的文件 id 重新勾上
    if (sourceTreeRef.value?.setCheckedKeys) {
      sourceTreeRef.value.setCheckedKeys(prevCheckedFileIds, false)
    }
    selectedSources.value = prevCheckedFileIds
  } catch (err) {
    console.error('刷新资产树失败', err)
  } finally {
    refreshing.value = false
  }
}

// 会话
const sessions = ref<RagSessionItem[]>([])
const sessionId = ref<number | null>(null)
const sessionsLoading = ref(false)
const deletingId = ref<number | null>(null)

// 对话
const chatHistory = ref<ChatMessage[]>([])
const inputQuery = ref('')
const streamingActive = ref(false)
const scrollbarRef = ref()

// 🌟【P2-2】流式 markdown rAF 节流开关：true 走 rAF 合并（1 帧最多 1 次 marked）
// false 一键回退到旧版"每 chunk 一次 marked + 一次 v-html"行为
const USE_STREAM_RENDER_THROTTLE = ref(true)
// rAF 帧间通讯：故意用普通 let 而非 ref —— 这两个变量不应该进入响应式系统，
// 否则 rAF 回调内对它们的"读 + 写"会被 Vue 当成依赖、触发额外 patch，抵消节流收益
let streamingPendingText = ''
let streamingMsgIndex = -1
// useRafFn 构造时不启动，需要时 resume()，流收敛时 pause()。
// 一帧最多执行一次回调，浏览器后台标签页 rAF 自然停。
const streamingRaf = useRafFn(
  () => {
    if (streamingMsgIndex < 0) return
    const msg = chatHistory.value[streamingMsgIndex]
    if (msg && msg.content !== streamingPendingText) {
      msg.content = streamingPendingText
      scrollToBottom()
    }
  },
  { immediate: false }
)

// 🌟【P2-1】当前流式请求的 AbortController，停止按钮触发 abort
// 旧值在 finally 里清理，保证下一次 submit 能拿到全新 controller
const abortControllerRef = ref<AbortController | null>(null)

// 🌟【P1-2 + P1-3】引用预览弹窗
const previewVisible = ref(false)
const previewCitation = ref<CitationItem | null>(null)
// 【P1-3】SQL 引用预览的迷你表格数据
const previewTableLoading = ref(false)
const previewTableData = ref<{
  sheetName: string
  columns: string[]
  rows: Array<Record<string, string | number | null>>
} | null>(null)

const fetchSessions = async () => {
  sessionsLoading.value = true
  try {
    const res: any = await listRagSessions()
    sessions.value = (res?.data ?? res ?? []) as RagSessionItem[]
  } catch (err) {
    console.error('会话列表拉取失败', err)
  } finally {
    sessionsLoading.value = false
  }
}

const switchSession = async (id: number) => {
  if (id === sessionId.value) return
  if (streamingActive.value) {
    ElMessage.warning('流式输出中，请等待本次回答完成')
    return
  }
  sessionId.value = id
  await loadSessionMessages(id)
}

const loadSessionMessages = async (id: number) => {
  try {
    const res: any = await listRagSessionMessages(id)
    const list: any[] = (res?.data ?? res ?? []) as any[]
    chatHistory.value = list.map((m) => ({
      role: m.role,
      content: m.content,
      sources: m.citations || undefined,
      sourcesExpanded: true
    }))
    await nextTick()
    await scrollToBottom()
  } catch (err) {
    console.error('加载会话消息失败', err)
    ElMessage.error('加载历史消息失败')
  }
}

const startNewChat = () => {
  if (streamingActive.value) {
    ElMessage.warning('流式输出中，请等待完成')
    return
  }
  sessionId.value = null
  chatHistory.value = []
  inputQuery.value = ''
}

const handleSessionCmd = async (cmd: string, s: RagSessionItem) => {
  if (cmd === 'rename') {
    try {
      const { value } = await ElMessageBox.prompt('重命名会话', '会话管理', {
        inputValue: s.title,
        confirmButtonText: '保存',
        cancelButtonText: '取消'
      })
      if (value && value.trim() && value !== s.title) {
        await renameRagSession(s.id, value.trim())
        s.title = value.trim()
        ElMessage.success('已重命名')
      }
    } catch {
      /* 用户取消 */
    }
  } else if (cmd === 'delete') {
    await confirmDeleteSession(s)
  }
}

const confirmDeleteSession = async (s: RagSessionItem) => {
  if (streamingActive.value) {
    ElMessage.warning('流式输出中，请等待本次回答完成')
    return
  }
  if (deletingId.value !== null) return
  try {
    await ElMessageBox.confirm(`确定删除会话 [${s.title || '新会话'}] 吗？该操作不可恢复。`, '安全警告', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  deletingId.value = s.id
  try {
    await deleteRagSession(s.id)
    ElMessage.success('会话已删除')
    if (sessionId.value === s.id) {
      sessionId.value = null
      chatHistory.value = []
    }
    await fetchSessions()
  } catch (err: any) {
    ElMessage.error(err?.message || '删除失败，请稍后重试')
  } finally {
    deletingId.value = null
  }
}

const toggleCitations = (index: number) => {
  const msg = chatHistory.value[index]
  if (msg) msg.sourcesExpanded = !msg.sourcesExpanded
}

const openCitationPreview = async (src: CitationItem) => {
  previewCitation.value = src
  previewVisible.value = true
  previewTableData.value = null
  // 【P1-3】SQL 引用 → 拉真实行数据渲染迷你表格
  if (src.ragTrack === 'sql' && src.sheetName && src.rowIndices && src.rowIndices.length > 0) {
    previewTableLoading.value = true
    try {
      const res: any = await fetchStructuredRows({
        fileId: src.fileId,
        sheetName: src.sheetName,
        rowIndices: src.rowIndices
      })
      previewTableData.value = res?.data || null
    } catch (err) {
      console.error('拉取结构化行数据失败', err)
      ElMessage.warning('无法加载行数据预览')
      previewTableData.value = null
    } finally {
      previewTableLoading.value = false
    }
  }
}

const quickQuestion = (text: string) => {
  inputQuery.value = text
}

const handleEnterKey = (e: KeyboardEvent) => {
  if (e.shiftKey) return
  if (!streamingActive.value && inputQuery.value.trim()) submitQuery()
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

  // 【P2-1】为本次请求创建独立 AbortController，停止按钮 abort 它
  const ac = new AbortController()
  abortControllerRef.value = ac

  try {
    await askQuestionStreamApi(
      {
        question: query,
        sessionId: sessionId.value,
        sources: selectedSources.value
      },
      {
        onChunk: (chunkedText) => {
          // 【P2-2】不再每 chunk 同步写 msg.content（会触发 1 次 marked + 1 次 v-html 重排）；
          // 改为只更新"帧间变量"，rAF 下一帧把最新的 pendingText 一次性推到 msg.content
          streamingMsgIndex = aiMessageIndex
          streamingPendingText = chunkedText
          if (USE_STREAM_RENDER_THROTTLE.value) {
            if (!streamingRaf.isActive.value) streamingRaf.resume()
          } else {
            // 旧版回退路径：出问题时改 USE_STREAM_RENDER_THROTTLE=false 即可回到这里
            chatHistory.value[aiMessageIndex].content = chunkedText
            scrollToBottom()
          }
        },
        onSession: (s) => {
          // 后端为本次创建了新会话，绑到本地
          sessionId.value = s.id
          // 插入到会话列表顶部
          if (!sessions.value.find((x) => x.id === s.id)) {
            sessions.value.unshift({
              id: s.id,
              userId: 0,
              title: s.title,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            })
          }
        },
        onSources: (sources) => {
          chatHistory.value[aiMessageIndex].sources = sources
        },
        onError: (msg) => {
          if (!chatHistory.value[aiMessageIndex].content) {
            chatHistory.value[aiMessageIndex].content = `❌ 集群阻断: ${msg}`
          }
        }
      },
      { signal: ac.signal }
    )
    // 流结束后刷新会话列表（标题可能自动改写了）
    await fetchSessions()
  } catch (error: any) {
    // 【P2-1】用户主动中止：axios 抛 CanceledError，不当作错误处理，
    // stopStreaming 已经在 abort 前把最后一条 AI 消息标了 stopped=true
    const isCanceled = error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED'
    if (isCanceled) {
      // 正常退出，保持 partial content
    } else if (!chatHistory.value[aiMessageIndex].content) {
      chatHistory.value[aiMessageIndex].content = `❌ 网络异常: 与局域网 RAG 服务器连接超时`
    }
  } finally {
    // 【P2-2】finally 是流收敛的总闸：无论成功/异常/被 abort，都走 flushStreamingRender
    // 把 rAF 队列里"最后一段文本"同步落到 msg.content，再关 rAF、清状态
    flushStreamingRender()
    streamingActive.value = false
    abortControllerRef.value = null
    await scrollToBottom()
  }
}

/**
 * 【P2-1】主动停止当前流式问答
 * 1) 给最后一条 AI 消息打 `stopped: true` 标（保留 partial content）
 * 2) 触发 AbortController → axios 立即 reject → 后端 req close → service 退出 LLM 循环
 * 3) finally 里 streamingActive 翻回 false，按钮自动切回"发送"
 */
const stopStreaming = () => {
  const ac = abortControllerRef.value
  const lastMsg = chatHistory.value[chatHistory.value.length - 1]
  if (lastMsg && lastMsg.role === 'assistant') {
    lastMsg.stopped = true
  }
  // 【P2-2】主动停止：同步把 rAF 还没来得及推的最后一段文本落到 content，
  // 否则 v-html 上一次 marked 的结果可能停留在"rAF 上一帧"的状态，最后几个字符丢失
  flushStreamingRender()
  if (ac) {
    try {
      ac.abort()
    } catch {
      /* ignore */
    }
  }
}

// 【P2-2】流收敛：流结束（finally）/ 主动停止 / 网络错误 三条路径都要走这里
// 把 streamingPendingText 最后一次写进 msg.content、关 rAF、清状态。
// 幂等：streamingMsgIndex === -1 时直接 return，可被多次调用。
const flushStreamingRender = () => {
  if (streamingMsgIndex < 0) return
  const msg = chatHistory.value[streamingMsgIndex]
  if (msg && streamingPendingText) {
    msg.content = streamingPendingText
  }
  streamingRaf.pause()
  streamingMsgIndex = -1
  streamingPendingText = ''
}

const scrollToBottom = async () => {
  await nextTick()
  if (scrollbarRef.value) scrollbarRef.value.setScrollTop(999999)
}

const renderMarkdown = (text: string) => {
  if (!text) return '<span class="cursor-pulse">|</span>'
  return marked(text)
}

const formatSize = (bytes: number) => {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

const formatScore = (score: number) => `${(score * 100).toFixed(1)}%`

/**
 * 【P1-3】把行号数组压缩成"2-5, 8, 11-13"形式
 * 避免一次性把上百行塞 UI。超 6 个连续段时只显示首尾。
 */
const formatRowRange = (rows: number[]): string => {
  if (!rows || rows.length === 0) return '-'
  if (rows.length === 1) return `${rows[0]}`
  const sorted = [...rows].sort((a, b) => a - b)
  const groups: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i]
      continue
    }
    groups.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = sorted[i]
    prev = sorted[i]
  }
  groups.push(start === prev ? `${start}` : `${start}-${prev}`)
  // 行号过多时只展示首尾两个区间
  if (groups.length > 4) {
    return `${groups[0]}, ${groups[1]}, … , ${groups[groups.length - 1]}`
  }
  return groups.join(', ')
}

onMounted(async () => {
  await Promise.all([fetchKnowledgeSources(), fetchSessions()])
})
</script>

<style scoped>
/* ==========================================================================
   📐 布局
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

.sidebar-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.sidebar-session {
  max-height: 42%;
  border-bottom: 1px solid var(--rag-border-sub);
}

.sidebar-source {
  flex: 1;
  min-height: 0;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 18px 10px;
}

.brand-icon {
  font-size: 18px;
  color: var(--rag-primary-brand);
}

.brand-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--rag-text-title);
  letter-spacing: 0.2px;
}

.section-meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--rag-text-sub);
  background-color: var(--rag-bg-container);
  padding: 2px 8px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}

.section-meta.section-meta-all {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--rag-primary-brand);
  background-color: var(--rag-info-bg);
  font-weight: 600;
}

.section-meta.section-meta-all .el-icon {
  font-size: 12px;
}

.new-chat-btn {
  margin-left: auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 8px;
  background: var(--rag-card-active) !important;
  color: var(--rag-primary-brand) !important;
}

.new-chat-btn:hover {
  background: var(--rag-primary-brand) !important;
  color: #fff !important;
}

.session-list-wrapper {
  flex: 1;
  padding: 4px 12px 12px;
  overflow: hidden;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--rag-text-main);
  transition: all 0.2s ease;
  margin-bottom: 4px;
  border: 1px solid transparent;
}

.session-item:hover {
  background-color: var(--rag-card-hover);
}

.session-item.is-active {
  background-color: var(--rag-card-active);
  border-color: var(--rag-card-active-border);
  color: var(--rag-text-title);
  font-weight: 600;
}

.session-icon {
  font-size: 14px;
  color: var(--rag-info);
  flex-shrink: 0;
}

.session-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.session-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transform: translateX(4px);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.session-item:hover .session-actions,
.session-item.is-active .session-actions {
  opacity: 1;
  transform: translateX(0);
}

.session-action-btn {
  font-size: 13px;
  color: var(--rag-text-sub);
  padding: 4px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  user-select: none;
  background: transparent;
  border: none;
  outline: none;
  font-family: inherit;
}

.session-action-btn:focus-visible {
  outline: 2px solid var(--rag-primary-brand);
  outline-offset: 1px;
}

.session-action-btn:hover {
  background-color: var(--rag-bg-container);
  color: var(--rag-text-title);
}

.session-action-delete:hover {
  color: var(--el-color-danger) !important;
  background-color: var(--rag-danger-bg) !important;
}

.session-action-btn.is-busy {
  color: var(--rag-primary-brand) !important;
  cursor: wait;
}

.session-action-btn.is-busy svg,
.session-action-btn.is-busy .el-icon {
  animation: spin 0.8s linear infinite;
}

.sidebar-hint {
  padding: 4px 18px 10px;
  font-size: 12px;
  color: var(--rag-text-sub);
  line-height: 1.6;
}

.source-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px 8px;
}

.source-search-input {
  flex: 1;
}

.source-search-input :deep(.el-input__wrapper) {
  background-color: var(--rag-card-item);
  border-radius: 8px;
  box-shadow: 0 0 0 1px var(--rag-border-sub) inset !important;
  padding: 2px 8px;
}

.source-search-input :deep(.el-input__wrapper):hover {
  box-shadow: 0 0 0 1px var(--rag-primary-brand) inset !important;
}

.source-search-input :deep(.el-input__inner) {
  font-size: 12px;
  color: var(--rag-text-main);
}

.source-tool-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  margin-left: 0;
  color: var(--rag-text-sub);
  background-color: var(--rag-card-item) !important;
  border: 1px solid var(--rag-border-sub);
}

.source-tool-btn:hover {
  color: var(--rag-primary-brand);
  border-color: var(--rag-primary-brand);
}

.source-tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.source-tool-btn .is-spinning {
  animation: spin 0.8s linear infinite;
}

.source-list-wrapper {
  flex: 1;
  padding: 4px 12px 12px;
  overflow: hidden;
}

/* ==========================================================================
   🌲【P1-4】知识源 el-tree 自定义样式
   ========================================================================== */
.source-tree {
  background: transparent;
  --el-color-primary: var(--rag-primary-brand);
}

.source-tree :deep(.el-tree-node__content) {
  height: 32px;
  border-radius: 6px;
  margin: 1px 0;
  transition: background-color 0.18s ease;
}

.source-tree :deep(.el-tree-node__content:hover) {
  background-color: var(--rag-card-hover);
}

.source-tree :deep(.el-tree-node.is-current > .el-tree-node__content) {
  background-color: var(--rag-card-active) !important;
}

/* 复选框颜色统一主题色 */
.source-tree :deep(.el-checkbox__inner) {
  background-color: var(--rag-card-item);
  border-color: var(--rag-border-color);
}
.source-tree :deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  background-color: var(--rag-primary-brand);
  border-color: var(--rag-primary-brand);
}
.source-tree :deep(.el-checkbox__input.is-indeterminate .el-checkbox__inner) {
  background-color: var(--rag-primary-brand);
  border-color: var(--rag-primary-brand);
}

/* 缩进导轨虚化，文件夹层级不抢眼 */
.source-tree :deep(.el-tree-node__expand-icon) {
  color: var(--rag-text-sub);
  font-size: 12px;
}
.source-tree :deep(.el-tree-node__expand-icon.is-leaf) {
  color: transparent;
}

/* 节点行布局：图标 + 名称 + tag + size */
.tree-node-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding-right: 8px;
  font-size: 13px;
  line-height: 1.2;
}

.tree-node-row.is-folder {
  font-weight: 600;
  color: var(--rag-text-title);
}

.tree-node-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.tree-icon-folder {
  color: var(--el-color-warning, #e6a23c);
}

.tree-icon-sql {
  color: var(--el-color-success, #67c23a);
}

.tree-icon-vector {
  color: var(--rag-info, #909399);
}

.tree-node-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  color: inherit;
}

.tree-node-tag {
  flex-shrink: 0;
  font-size: 10px !important;
  height: 18px !important;
  padding: 0 5px !important;
  line-height: 16px !important;
  border-radius: 3px !important;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.tree-node-size {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--rag-text-sub);
  font-variant-numeric: tabular-nums;
  min-width: 38px;
  text-align: right;
}

/* 滚动条靠内，让树节点有完整边距 */
.source-list-wrapper :deep(.el-scrollbar__wrap) {
  overflow-x: hidden;
}

/* ==========================================================================
   🗨️ 聊天区
   ========================================================================== */
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
  padding: 40px 20px 0;
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

/* 消息气泡 */
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
}

/* 【P2-1】用户主动中断后的徽标 —— flex + center 强制图标和文本中线对齐 */
.stopped-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1;
  color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 4px;
}
.stopped-badge .el-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  /* icon 自身高度 = 行高，避免和文字 baseline 错位 */
  height: 1em;
  line-height: 1;
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
  border-top: 1px solid var(--rag-border-sub);
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  box-shadow: var(--rag-shadow-sm);
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

/* 【P1-3】轨道标签 */
.citation-track-tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  padding: 2px 6px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.citation-track-tag .el-icon {
  font-size: 11px;
}

.citation-track-sql {
  color: var(--el-color-warning-dark, #b88230);
  background-color: var(--rag-warning-bg);
  border: 1px solid color-mix(in srgb, var(--el-color-warning) 30%, transparent);
}

.citation-track-vector {
  color: var(--rag-info);
  background-color: var(--rag-info-bg);
  border: 1px solid color-mix(in srgb, var(--rag-info) 25%, transparent);
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
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

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
   🌟【P1-2】引用原文预览弹窗
   ========================================================================== */
.preview-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.preview-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rag-text-sub);
  flex-wrap: wrap;
}

.preview-filename {
  font-weight: 600;
  color: var(--rag-text-title);
  font-size: 13px;
}

.preview-divider {
  opacity: 0.5;
}

.preview-chunk {
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
}

.preview-score {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--rag-success);
  background-color: var(--rag-success-bg);
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 11px;
}

.preview-score .score-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--rag-success);
}

.preview-body {
  font-size: 14px;
  line-height: 1.85;
  color: var(--rag-text-main);
  background-color: var(--rag-bg-container);
  border: 1px solid var(--rag-border-sub);
  border-left: 3px solid var(--rag-primary-brand);
  border-radius: 0 10px 10px 0;
  padding: 16px 18px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 360px;
  overflow-y: auto;
}

/* 【P1-3】SQL 引用预览迷你表格 */
.preview-table-wrapper {
  background-color: var(--rag-bg-container);
  border: 1px solid var(--rag-border-sub);
  border-left: 3px solid var(--el-color-warning);
  border-radius: 0 10px 10px 0;
  max-height: 360px;
  overflow: auto;
  padding: 4px 0;
}

.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.preview-table thead th {
  position: sticky;
  top: 0;
  background-color: var(--rag-card-hover);
  font-weight: 600;
  color: var(--rag-text-title);
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--rag-border-color);
  white-space: nowrap;
  z-index: 1;
}

.preview-table tbody td {
  padding: 9px 14px;
  border-bottom: 1px solid var(--rag-border-sub);
  color: var(--rag-text-main);
  vertical-align: top;
  word-break: break-word;
}

.preview-table tbody tr:hover {
  background-color: var(--rag-card-hover);
}

.preview-table .row-num-th,
.preview-table .row-num-td {
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  color: var(--rag-text-sub);
  text-align: right;
  background-color: var(--rag-card-item);
  font-size: 11px;
  font-weight: 600;
  width: 48px;
  flex-shrink: 0;
  position: sticky;
  left: 0;
}

.preview-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--rag-text-sub);
  font-size: 13px;
}

.preview-tip {
  font-size: 12px;
  color: var(--rag-text-sub);
  display: flex;
  align-items: center;
  gap: 4px;
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

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>

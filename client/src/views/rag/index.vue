<template>
  <div class="rag-container animate-fade-in">
    <el-row :gutter="20" class="metrics-row">
      <el-col :span="6" v-for="(metric, index) in metricsData" :key="index">
        <el-card class="metric-card" shadow="hover">
          <div class="card-content">
            <div class="metric-info">
              <span class="metric-label">{{ metric.title }}</span>
              <h2 class="metric-value">
                {{ metric.value }}<span class="unit">{{ metric.unit }}</span>
              </h2>
            </div>
            <div class="metric-icon-box" :style="{ background: metric.bg, color: metric.color }">
              <el-icon :size="22"><component :is="metric.icon" /></el-icon>
            </div>
          </div>
          <div class="card-footer">
            <span class="trend-text" :class="metric.trendType">{{ metric.trend }}</span>
            <span class="footer-desc">较上周</span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="workbench-card" shadow="never">
      <div class="toolbar-wrapper">
        <div class="left-actions">
          <el-button type="primary" class="action-btn" @click="openRegisterDialog">
            <el-icon class="mr-1"><Plus /></el-icon> 上传并注册
          </el-button>
          <el-button type="default" class="action-btn" @click="openFolderDialog">
            <el-icon class="mr-1"><FolderAdd /></el-icon> 新建知识库
          </el-button>
          <el-button-group class="ml-3">
            <el-button :type="viewMode === 'list' ? 'primary' : 'default'" @click="viewMode = 'list'">
              <el-icon><List /></el-icon>
            </el-button>
            <el-button :type="viewMode === 'grid' ? 'primary' : 'default'" @click="viewMode = 'grid'">
              <el-icon><Grid /></el-icon>
            </el-button>
          </el-button-group>
        </div>

        <div class="right-filters">
          <el-input
            v-model="queryParams.name"
            placeholder="输入资源名称进行过滤..."
            class="search-input"
            clearable
            @clear="fetchData"
            @keyup.enter="fetchData"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-button type="primary" plain @click="fetchData">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </div>

      <!-- 🔧 面包屑：根目录 > 子目录 > ... -->
      <div class="breadcrumb-bar">
        <el-breadcrumb separator=">">
          <el-breadcrumb-item v-for="(crumb, i) in breadcrumb" :key="crumb.id" @click="gotoBreadcrumb(i)">
            <span :class="{ 'crumb-current': i === breadcrumb.length - 1 }">
              <el-icon v-if="i === 0" class="crumb-icon"><HomeFilled /></el-icon>
              {{ crumb.name }}
            </span>
          </el-breadcrumb-item>
        </el-breadcrumb>
      </div>

      <div v-loading="loading" class="data-display-area">
        <el-table
          v-if="viewMode === 'list' && tableData.length > 0"
          :data="tableData"
          row-key="id"
          class="custom-table"
          :row-class-name="(row: any) => (row.row.isFolder ? 'row-clickable' : '')"
          @row-click="(row: any) => enterFolder(row)"
        >
          <el-table-column prop="fileName" label="资源名称" min-width="240">
            <template #default="{ row }">
              <div class="file-name-cell">
                <el-icon :size="20" class="file-icon" :class="row.isFolder ? 'folder-clr' : 'file-clr'">
                  <component :is="row.isFolder ? 'Folder' : 'Document'" />
                </el-icon>
                <div class="file-info-text">
                  <span class="main-name">{{ row.fileName }}</span>
                  <span class="sub-code">RAG-UUID-{{ row.id }}</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column prop="size" label="数据大小" width="120">
            <template #default="{ row }">
              <span class="text-slate-500">{{ row.isFolder ? '-' : formatSize(row.size) }}</span>
            </template>
          </el-table-column>

          <el-table-column prop="vectorStatus" label="解析状态" width="140">
            <template #default="{ row }">
              <span class="status-indicator" :class="'status-' + getStatusTag(row.vectorStatus)">
                <span class="pulse-dot"></span>
                {{ getStatusText(row.vectorStatus) }}
              </span>
            </template>
          </el-table-column>

          <el-table-column prop="updatedAt" label="最后更新时间" width="180">
            <template #default="{ row }">
              <span class="time-text">{{ row.updatedAt || row.createdAt }}</span>
            </template>
          </el-table-column>

          <el-table-column label="快捷管理操作" width="120" fixed="right" align="center">
            <template #default="{ row }">
              <div class="table-ops">
                <el-button link type="danger" :disabled="row.isFolder" @click="handleDelete(row)">
                  <el-icon><Delete /></el-icon> 移除
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <el-row v-else-if="viewMode === 'grid' && tableData.length > 0" :gutter="20" class="grid-layout">
          <el-col :span="6" v-for="item in tableData" :key="item.id" class="grid-col">
            <el-card
              class="grid-item-card"
              shadow="hover"
              :class="{ 'row-clickable': item.isFolder }"
              @click="enterFolder(item)"
            >
              <div class="grid-card-main">
                <div class="grid-header">
                  <el-icon :size="36" :class="item.isFolder ? 'folder-clr' : 'file-clr'">
                    <component :is="item.isFolder ? 'FolderOpened' : 'Document'" />
                  </el-icon>
                  <span class="status-indicator-mini" :class="'status-' + getStatusTag(item.vectorStatus)"></span>
                </div>
                <h4 class="grid-title">{{ item.fileName }}</h4>
                <p class="grid-code">RAG-UUID-{{ item.id }}</p>
                <div class="grid-meta">
                  <span>{{ item.isFolder ? '知识库目录' : formatSize(item.size) }}</span>
                  <span>{{ (item.updatedAt || item.createdAt || '').split(' ')[0] }}</span>
                </div>
              </div>
              <div class="grid-card-actions">
                <span class="del-action" @click="handleDelete(item)">
                  <el-icon class="mr-1"><Delete /></el-icon> 移除资产
                </span>
              </div>
            </el-card>
          </el-col>
        </el-row>

        <el-empty v-else description="暂无符合检索条件的知识库资产" class="custom-empty">
          <template #image>
            <el-icon :size="64" class="empty-icon"><FolderDelete /></el-icon>
          </template>
          <el-button type="primary" plain @click="openRegisterDialog">立即上传资产</el-button>
        </el-empty>
      </div>
    </el-card>

    <!-- 新建文件夹弹窗 -->
    <el-dialog v-model="folderDialogVisible" title="新建高维向量隔离知识库" width="500px" append-to-body>
      <el-form :model="folderForm" ref="folderFormRef" :rules="folderRules" label-width="100px">
        <el-form-item label="目录名称" prop="name">
          <el-input v-model="folderForm.name" placeholder="请输入知识库分类目录名称" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="folderDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitLoading" @click="submitFolder">确认创建</el-button>
      </template>
    </el-dialog>

    <!-- 上传并注册弹窗 -->
    <el-dialog v-model="registerDialogVisible" title="上传并注册语料文件" width="560px" append-to-body>
      <el-form :model="registerForm" ref="registerFormRef" :rules="registerRules" label-width="100px">
        <el-form-item label="归属知识库" prop="parentId">
          <el-select v-model="registerForm.parentId" placeholder="请选择归属的父级知识库目录" style="width: 100%">
            <el-option label="根目录 (不归属任何知识库)" :value="0" />
            <el-option
              v-for="folder in folderOptions"
              :key="folder.id"
              :label="folder.isCurrent ? `${folder.name} (当前位置)` : folder.name"
              :value="folder.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="语料文件" prop="file">
          <el-upload
            ref="uploadRef"
            :auto-upload="false"
            :limit="1"
            :on-change="handleFileChange"
            :on-exceed="handleExceed"
            drag
          >
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">将文件拖到此处，或<em>点击选择</em></div>
            <template #tip>
              <div class="el-upload__tip">支持 txt / md / pdf / docx / xlsx / xls / csv；超过 50MB 建议先做切片</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="registerDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitLoading" @click="submitRegister">确认上传并注册</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import type { UploadInstance, UploadFile, UploadRawFile, UploadFiles, FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Plus,
  FolderAdd,
  List,
  Grid,
  Search,
  Refresh,
  Delete,
  FolderDelete,
  UploadFilled,
  HomeFilled
} from '@element-plus/icons-vue'

import {
  getKnowledgeFileList,
  createKnowledgeFolder,
  uploadKnowledgeFile,
  deleteKnowledgeFile,
  type RagAssetItem
} from '@/api/rag'

// 视图、加载控制
const loading = ref(false)
const submitLoading = ref(false)
const viewMode = ref<'list' | 'grid'>('list')
const tableData = ref<RagAssetItem[]>([])
// 🔧 面包屑路径：[{id:0, name:'根目录'}, {id:1, name:'人事部'}, ...]
const breadcrumb = ref<{ id: number; name: string }[]>([{ id: 0, name: '根目录' }])
const currentParentId = computed(() => breadcrumb.value[breadcrumb.value.length - 1].id)

// 对接后端检索参数
const queryParams = reactive({
  name: ''
})

// 大厂风顶层 Insight 数据看板计算属性
const metricsData = computed(() => {
  const files = tableData.value.filter((i) => !i.isFolder)
  const ready = files.filter((i) => i.vectorStatus === 'success').length
  return [
    {
      title: '知识库资产总量',
      value: tableData.value.length.toString(),
      unit: '个',
      icon: 'Files',
      trend: '实时同步',
      trendType: 'stable',
      bg: 'rgba(59, 130, 246, 0.1)',
      color: '#3b82f6'
    },
    {
      title: '多维关联分类',
      value: tableData.value.filter((i) => i.isFolder).length.toString(),
      unit: '个目录',
      icon: 'Connection',
      trend: '结构化',
      trendType: 'up',
      bg: 'rgba(16, 185, 129, 0.1)',
      color: '#10b981'
    },
    {
      title: 'Embedding 就绪率',
      value: files.length ? ((ready / files.length) * 100).toFixed(1) : '100',
      unit: '%',
      icon: 'Cpu',
      trend: '高可用',
      trendType: 'up',
      bg: 'rgba(139, 92, 246, 0.1)',
      color: '#8b5cf6'
    },
    {
      title: '集群托管算力空间',
      value: '14.8',
      unit: 'GB',
      icon: 'PieChart',
      trend: '配额充足',
      trendType: 'stable',
      bg: 'rgba(245, 158, 11, 0.1)',
      color: '#f59e0b'
    }
  ]
})

/* ======================================================================
   🔌 后端服务 API 桥接核心逻辑
   ====================================================================== */

// 🌐 读取列表（GET /api/rag/files/list）
// 根目录(parentId=0) 时同时拉"目录(parentId=0)" + "顶层未归属文件(parentId=0)" —— 这两个 SQL 完全一致，
// 后端 parentId 过滤一次性带回来，无需两次请求。
const fetchData = async () => {
  loading.value = true
  try {
    const res: any = await getKnowledgeFileList(currentParentId.value)
    const list: RagAssetItem[] = (res?.data ?? res ?? []) as RagAssetItem[]
    tableData.value = Array.isArray(list) ? list : []
  } catch (error) {
    ElMessage.error('获取知识库资产列表失败')
    console.error(error)
  } finally {
    loading.value = false
  }
}

// 📂 进入子目录：往面包屑 push 一节，重新拉数据
const enterFolder = (row: RagAssetItem) => {
  if (!row.isFolder) return
  breadcrumb.value.push({ id: row.id, name: row.fileName })
  fetchData()
}

// 🍞 点击面包屑某节：截断到那一节，重新拉数据（点第一节 = 回到根目录）
const gotoBreadcrumb = (index: number) => {
  if (index < 0 || index >= breadcrumb.value.length) return
  breadcrumb.value = breadcrumb.value.slice(0, index + 1)
  fetchData()
}

// 📂 新建文件夹弹窗与提交（POST /api/rag/folder/create）
const folderDialogVisible = ref(false)
const folderFormRef = ref<FormInstance>()
const folderForm = reactive({ name: '' })
const folderRules = reactive<FormRules>({
  name: [{ required: true, message: '请填写目录名称', trigger: 'blur' }]
})

const openFolderDialog = () => {
  folderForm.name = ''
  folderDialogVisible.value = true
}

const submitFolder = async () => {
  if (!folderFormRef.value) return
  await folderFormRef.value.validate(async (valid: boolean) => {
    if (!valid) return
    submitLoading.value = true
    try {
      await createKnowledgeFolder({ name: folderForm.name, parentId: currentParentId.value })
      ElMessage.success('成功创建高维向量隔离知识库目录')
      folderDialogVisible.value = false
      fetchData()
    } catch (error) {
      ElMessage.error('知识库目录创建失败')
    } finally {
      submitLoading.value = false
    }
  })
}

// 📄 上传并注册文件（POST /api/rag/file/upload，multipart/form-data）
const registerDialogVisible = ref(false)
const registerFormRef = ref<FormInstance>()
const uploadRef = ref<UploadInstance>()
const registerForm = reactive({
  parentId: 0,
  file: null as UploadRawFile | null
})
const registerRules = reactive<FormRules>({
  parentId: [{ required: true, message: '请选择归属节点', trigger: 'change' }],
  file: [{ required: true, message: '请选择要上传的语料文件', trigger: 'change' }]
})

// 🔧 "归属知识库"下拉选项 = 面包屑路径上的所有父级 + 当前目录本身
// 之前从 tableData.filter(isFolder) 取：进入子目录后子目录空时就没选项了。
// 改成从 breadcrumb 推：用户在哪个位置，能选的"归属"就是整条路径上每一级。
const folderOptions = computed(() =>
  breadcrumb.value
    .filter((c) => c.id !== 0) // 根目录单独用硬编码 option 表达
    .map((c) => ({ id: c.id, name: c.name, isCurrent: c.id === currentParentId.value }))
)

const openRegisterDialog = () => {
  // 🔧 默认归属 = 当前所在目录（在人事部里点上传，就直接传到人事部，不用再选）
  registerForm.parentId = currentParentId.value
  registerForm.file = null
  registerDialogVisible.value = true
}

const handleFileChange = (uploadFile: UploadFile) => {
  registerForm.file = uploadFile.raw as UploadRawFile
}

const handleExceed = (files: UploadFiles) => {
  ElMessage.warning('每次仅允许上传一个文件，已自动替换当前选择')
  uploadRef.value?.clearFiles()
  const first = files[0] as UploadFile
  uploadRef.value?.handleStart(first)
  registerForm.file = first.raw as UploadRawFile
}

const submitRegister = async () => {
  if (!registerFormRef.value || !uploadRef.value) return
  await registerFormRef.value.validate(async (valid: boolean) => {
    if (!valid) return
    if (!registerForm.file) {
      ElMessage.error('请选择要上传的语料文件')
      return
    }
    submitLoading.value = true
    try {
      const formData = new FormData()
      formData.append('file', registerForm.file)
      formData.append('parentId', String(registerForm.parentId ?? 0))
      await uploadKnowledgeFile(formData)
      ElMessage.success('语料文件已上传，异步清洗任务已激活')
      registerDialogVisible.value = false
      uploadRef.value.clearFiles()
      fetchData()
    } catch (error) {
      ElMessage.error('语料文件上传失败')
    } finally {
      submitLoading.value = false
    }
  })
}

// 🗑️ 删除资产（DELETE /api/rag/file/delete?id=X）
const handleDelete = (row: RagAssetItem) => {
  if (row.isFolder) {
    ElMessage.warning('目录请进入内部逐项删除')
    return
  }
  ElMessageBox.confirm(`确定从知识库物理擦除 [${row.fileName}] 吗？该操作不可恢复。`, '安全警告', {
    confirmButtonText: '确认擦除',
    cancelButtonText: '取消',
    type: 'warning'
  })
    .then(async () => {
      try {
        await deleteKnowledgeFile(row.id)
        ElMessage.success('资产已物理擦除并安全下线')
        fetchData()
      } catch (error) {
        ElMessage.error('资产擦除失败')
      }
    })
    .catch(() => {})
}

// 状态外观映射（与后端 vectorStatus 小写枚举对齐）
const getStatusTag = (status: RagAssetItem['vectorStatus']) => {
  const map: Record<RagAssetItem['vectorStatus'], string> = {
    success: 'success',
    processing: 'primary',
    failed: 'danger',
    pending: 'info'
  }
  return map[status] || 'info'
}

const getStatusText = (status: RagAssetItem['vectorStatus']) => {
  const map: Record<RagAssetItem['vectorStatus'], string> = {
    success: '已就绪',
    processing: '解析中',
    failed: '解析失败',
    pending: '排队中'
  }
  return map[status] || '排队中'
}

// 文件大小格式化（后端 size 字段单位：Byte；兼容后端 bigint → string 的情况）
const formatSize = (bytes: number | string) => {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

onMounted(() => {
  fetchData()
})
</script>

<style scoped>
/* ==========================================================================
   📐 整体容器
   ========================================================================== */
.rag-container {
  padding: 24px 28px 40px;
  background-color: var(--rag-bg-container);
  min-height: calc(100vh - 84px);
  transition: background-color 0.3s ease;
}

/* ==========================================================================
   📊 顶部指标卡片
   ========================================================================== */
.metrics-row {
  margin-bottom: 24px;
}

.metric-card {
  position: relative;
  border: 1px solid var(--rag-border-sub);
  border-radius: 14px;
  background-color: var(--rag-card-item);
  background-image: var(--rag-card-highlight);
  box-shadow: var(--rag-shadow-sm);
  overflow: hidden;
  transition: all 0.32s cubic-bezier(0.4, 0, 0.2, 1);
}

.metric-card:hover {
  transform: translateY(-4px);
  border-color: var(--rag-border-color);
  box-shadow: var(--rag-shadow-md);
}

:deep(.metric-card .el-card__body) {
  padding: 22px 22px 18px;
}

.card-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.metric-info {
  flex: 1;
  min-width: 0;
}

.metric-label {
  display: block;
  font-size: 13px;
  color: var(--rag-text-sub);
  margin-bottom: 8px;
  letter-spacing: 0.2px;
}

.metric-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--rag-text-title);
  line-height: 1.2;
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.metric-value .unit {
  font-size: 13px;
  font-weight: 500;
  color: var(--rag-text-sub);
  margin-left: 4px;
}

.metric-icon-box {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: transform 0.32s ease;
}

.metric-card:hover .metric-icon-box {
  transform: scale(1.08) rotate(-4deg);
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--rag-border-sub);
}

.trend-text {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
}

.trend-text.up {
  color: var(--rag-success);
  background-color: var(--rag-success-bg);
}

.trend-text.down {
  color: var(--rag-danger);
  background-color: var(--rag-danger-bg);
}

.trend-text.stable {
  color: var(--rag-info);
  background-color: var(--rag-info-bg);
}

.footer-desc {
  font-size: 11px;
  color: var(--rag-text-sub);
}

/* ==========================================================================
   🗂️ 工作台主卡片
   ========================================================================== */
.workbench-card {
  border: 1px solid var(--rag-border-sub);
  border-radius: 14px;
  background-color: var(--rag-card-item);
  box-shadow: var(--rag-shadow-sm);
  overflow: hidden;
  transition: all 0.3s ease;
}

:deep(.workbench-card .el-card__body) {
  padding: 0;
}

.toolbar-wrapper {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 22px;
  gap: 16px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--rag-border-sub);
  background-color: var(--rag-card-item);
}

.left-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.action-btn {
  border-radius: 8px;
  font-weight: 500;
  transition: all 0.25s ease;
}

:deep(.left-actions .el-button--primary.action-btn) {
  background: var(--rag-primary-brand-glow);
  border: none;
  box-shadow: 0 4px 12px -2px rgba(99, 102, 241, 0.32);
}

:deep(.left-actions .el-button--primary.action-btn:hover) {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px -2px rgba(99, 102, 241, 0.45);
}

.right-filters {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-input {
  width: 260px;
}

:deep(.search-input .el-input__wrapper) {
  border-radius: 8px;
  background-color: var(--rag-bg-container);
  box-shadow: 0 0 0 1px var(--rag-border-color) inset;
  transition: all 0.25s ease;
}

:deep(.search-input .el-input__wrapper:hover),
:deep(.search-input .el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--rag-primary-brand) inset;
}

:deep(.el-button-group .el-button) {
  border-radius: 8px;
}

.data-display-area {
  padding: 16px 22px 22px;
  min-height: 380px;
}

/* 🔧 面包屑 */
.breadcrumb-bar {
  padding: 12px 22px 0;
}

:deep(.breadcrumb-bar .el-breadcrumb__item) {
  cursor: pointer;
}

.crumb-current {
  color: var(--rag-text-title);
  font-weight: 600;
}

.crumb-icon {
  font-size: 14px;
  margin-right: 3px;
  color: var(--rag-primary-brand);
  vertical-align: top;
}

/* 🔧 目录行可点 + hover 高亮 */
:deep(.custom-table .row-clickable) {
  cursor: pointer;
}

:deep(.custom-table .row-clickable:hover td.el-table__cell) {
  background-color: var(--rag-card-hover) !important;
}

.row-clickable {
  cursor: pointer;
}

/* ==========================================================================
   📋 列表视图
   ========================================================================== */
.custom-table {
  --el-table-border-color: var(--rag-border-sub);
  --el-table-header-bg-color: var(--rag-bg-container);
  --el-table-row-hover-bg-color: var(--rag-card-hover);
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
}

:deep(.custom-table) {
  border-radius: 10px;
  overflow: hidden;
}

:deep(.custom-table .el-table__inner-wrapper::before) {
  display: none;
}

:deep(.custom-table th.el-table__cell) {
  background: var(--rag-bg-container);
  color: var(--rag-text-sub);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  padding: 14px 0;
}

:deep(.custom-table td.el-table__cell) {
  padding: 14px 0;
  border-bottom: 1px solid var(--rag-border-sub);
}

:deep(.custom-table tr:last-child td.el-table__cell) {
  border-bottom: none;
}

.file-name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 18px;
}

.file-icon.folder-clr {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.18) 0%, rgba(245, 158, 11, 0.06) 100%);
  color: var(--rag-warning);
}

.file-icon.file-clr {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.16) 0%, rgba(168, 85, 247, 0.06) 100%);
  color: var(--rag-primary-brand);
}

.file-info-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.main-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--rag-text-title);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

.sub-code {
  font-size: 11px;
  color: var(--rag-text-sub);
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  letter-spacing: 0.4px;
}

.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
  white-space: nowrap;
}

.status-indicator .pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-indicator.status-success {
  color: var(--rag-success);
  background-color: var(--rag-success-bg);
}
.status-indicator.status-success .pulse-dot {
  background-color: var(--rag-success);
  animation: dot-pulse 2s infinite;
}

.status-indicator.status-primary {
  color: var(--rag-info);
  background-color: var(--rag-info-bg);
}
.status-indicator.status-primary .pulse-dot {
  background-color: var(--rag-info);
  animation: dot-pulse 1.2s infinite;
}

.status-indicator.status-danger {
  color: var(--rag-danger);
  background-color: var(--rag-danger-bg);
}
.status-indicator.status-danger .pulse-dot {
  background-color: var(--rag-danger);
}

.status-indicator.status-info {
  color: var(--rag-text-sub);
  background-color: var(--rag-border-sub);
}
.status-indicator.status-info .pulse-dot {
  background-color: var(--rag-text-sub);
}

.time-text {
  font-size: 12px;
  color: var(--rag-text-sub);
  font-variant-numeric: tabular-nums;
}

.table-ops {
  display: flex;
  justify-content: center;
  gap: 4px;
}

/* ==========================================================================
   🟦 网格视图
   ========================================================================== */
.grid-layout {
  margin: 0 !important;
}

.grid-col {
  padding: 8px !important;
  margin-bottom: 8px;
}

.grid-item-card {
  position: relative;
  border: 1px solid var(--rag-border-sub);
  border-radius: 14px;
  background-color: var(--rag-card-item);
  box-shadow: var(--rag-shadow-sm);
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.grid-item-card:hover {
  transform: translateY(-3px);
  border-color: var(--rag-primary-brand);
  box-shadow: var(--rag-shadow-lg);
}

:deep(.grid-item-card .el-card__body) {
  padding: 0;
}

.grid-card-main {
  padding: 18px 18px 14px;
}

.grid-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.grid-header .el-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}

.grid-header .el-icon.folder-clr {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.2) 0%, rgba(245, 158, 11, 0.06) 100%);
  color: var(--rag-warning);
}

.grid-header .el-icon.file-clr {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.18) 0%, rgba(168, 85, 247, 0.06) 100%);
  color: var(--rag-primary-brand);
}

.status-indicator-mini {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-indicator-mini.status-success {
  background-color: var(--rag-success);
  box-shadow: 0 0 0 4px var(--rag-success-bg);
}
.status-indicator-mini.status-primary {
  background-color: var(--rag-info);
  box-shadow: 0 0 0 4px var(--rag-info-bg);
}
.status-indicator-mini.status-danger {
  background-color: var(--rag-danger);
  box-shadow: 0 0 0 4px var(--rag-danger-bg);
}
.status-indicator-mini.status-info {
  background-color: var(--rag-text-sub);
  box-shadow: 0 0 0 4px var(--rag-border-sub);
}

.grid-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--rag-text-title);
  margin: 0 0 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.grid-code {
  font-size: 11px;
  color: var(--rag-text-sub);
  margin: 0 0 14px;
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
}

.grid-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--rag-text-sub);
}

.grid-card-actions {
  display: flex;
  border-top: 1px solid var(--rag-border-sub);
  background-color: var(--rag-bg-container);
}

.del-action {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 11px 0;
  font-size: 12px;
  color: var(--rag-text-sub);
  cursor: pointer;
  transition: all 0.25s ease;
}

.del-action:hover {
  color: var(--rag-danger);
  background-color: var(--rag-danger-bg);
}

/* ==========================================================================
   📭 空状态
   ========================================================================== */
.custom-empty {
  padding: 60px 0;
}

:deep(.custom-empty .el-empty__description) {
  color: var(--rag-text-sub);
  margin-top: 12px;
}

:deep(.custom-empty .el-empty__image) {
  display: none;
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  border-radius: 20px;
  background: var(--rag-card-highlight);
  color: var(--rag-primary-brand);
  margin-bottom: 4px;
}

/* ==========================================================================
   📑 弹窗细节
   ========================================================================== */
:deep(.el-dialog) {
  border-radius: 16px;
  overflow: hidden;
}

:deep(.el-dialog__header) {
  padding: 20px 24px;
  margin: 0;
  border-bottom: 1px solid var(--rag-border-sub);
}

:deep(.el-dialog__title) {
  font-size: 16px;
  font-weight: 600;
  color: var(--rag-text-title);
}

:deep(.el-dialog__body) {
  padding: 24px;
}

:deep(.el-dialog__footer) {
  padding: 16px 24px 20px;
  border-top: 1px solid var(--rag-border-sub);
  background-color: var(--rag-bg-container);
}

:deep(.el-dialog__footer .el-button) {
  border-radius: 8px;
}

:deep(.el-dialog__footer .el-button--primary) {
  background: var(--rag-primary-brand-glow);
  border: none;
}

:deep(.el-upload-dragger) {
  border-radius: 12px;
  border: 1.5px dashed var(--rag-border-color);
  background-color: var(--rag-bg-container);
  padding: 32px 20px;
  transition: all 0.25s ease;
}

:deep(.el-upload-dragger:hover) {
  border-color: var(--rag-primary-brand);
  background-color: var(--rag-card-active);
}

:deep(.el-upload__text) {
  color: var(--rag-text-main);
  font-size: 13px;
  margin-top: 8px;
}

:deep(.el-upload__text em) {
  color: var(--rag-primary-brand);
  font-style: normal;
  font-weight: 600;
}

:deep(.el-upload__tip) {
  color: var(--rag-text-sub);
  font-size: 12px;
  margin-top: 8px;
}

:deep(.el-form-item__label) {
  color: var(--rag-text-main);
  font-weight: 500;
}

/* ==========================================================================
   🎬 动效
   ========================================================================== */
@keyframes dot-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 currentColor;
    opacity: 0.8;
  }
  50% {
    box-shadow: 0 0 0 4px transparent;
    opacity: 1;
  }
}

.animate-fade-in {
  animation: fade-in-up 0.4s ease-out;
}

@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ==========================================================================
   📱 响应式
   ========================================================================== */
@media screen and (max-width: 1280px) {
  .metric-value {
    font-size: 24px;
  }
  .search-input {
    width: 220px;
  }
}

@media screen and (max-width: 992px) {
  .toolbar-wrapper {
    flex-direction: column;
    align-items: stretch;
  }
  .right-filters {
    width: 100%;
  }
  .search-input {
    width: 100%;
  }
}
</style>

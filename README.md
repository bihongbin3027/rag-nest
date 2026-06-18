<div align="center">
<br/>
<br/>
  <h1 align="center">Nest Admin</h1>
  <p>企业级 RBAC 管理系统 + 双轨制 RAG 知识库</p>
</div>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/Nest%20Admin-v2.0.0-green"></a>
  <a href="#"><img src="https://img.shields.io/badge/nestjs-v11.x-green.svg"></a>
  <a href="#"><img src="https://img.shields.io/badge/vue-v3.x-green.svg"></a>
  <a href="#"><img src="https://img.shields.io/badge/typescript-v5.x-blue.svg"></a>
</p>

## 项目简介

`Nest Admin` 是基于 **NestJS 11 + Vue 3 + TypeScript** 的一站式企业级中后台平台。除了标准的 RBAC 权限管理（用户/角色/菜单/部门/岗位），还内置了**双轨制企业级 RAG 知识库** —— 长文本走 Qdrant 向量库，结构化表格走行级治理，让 LLM 能精准回答事实型问题（如"研发部门 3 月人数"）。

代码库分为两个独立的子项目：

- `client/` — Vue 3 前端（端口 `5173`，Vite 构建）
- `servers/` — NestJS 后端（端口 `8081`，API 前缀 `/api`，Swagger `/api/docs`）

在线预览：[http://nest-admin.shenyuan.xn--6qq986b3xl/](http://nest-admin.shenyuan.xn--6qq986b3xl/)

## 核心特性

### 权限与组织
- 用户 / 角色 / 菜单 / 部门 / 岗位 / 文件（OSS）CRUD
- JWT + RBAC 路由级权限（`path-to-regexp` 匹配）
- 全局 `JwtAuthGuard` + `RolesGuard` 双层鉴权
- 装饰器：`@AllowAnon()` / `@AllowNoPerm()` / `@Keep()`

### 企业级 RAG 知识库 ⭐
- **双轨制**：`ragTrack=VECTOR`（长文本）/ `ragTrack=SQL`（Excel/CSV 行治理）
- **文档解析**：`txt` / `md` / `pdf` / `docx` / `xlsx` / `xls` / `csv`
- **切片增强**：md 按标题层级切，表格按行级 chunk
- **LLM 增强**：
  - 整文档/整 sheet **摘要**（提升跨段落召回）
  - 每个 chunk 生成 3-5 个 **FAQ 辅助问题**（用户问题 ↔ FAQ 命中更精准）
- **检索增强**：
  - **HyDE** 假设性回答（缓解 query/doc 语义鸿沟）
  - **Cross-encoder Rerank**（`bge-reranker-base` q8 量化，向量召回 top-20 → 重排到 top-4）
- **流式问答**：SSE `text/event-stream`，前端用 `fetch + ReadableStream` 解析
- **多轮对话**：会话 + 消息持久化，历史上下文自动拼装
- **用户隔离硬隔离**：`metadata.userId` 写入 Qdrant filter

### 生产级弹性与可观测性
- **限流 + 熔断**：`p-limit` + `opossum`，LLM / embedding 独立熔断器
- **异步 ETL**：BullMQ 队列（`attempts=3` 指数退避，`concurrency=3`，自动重试）
- **审计日志**：`AuditInterceptor` 自动记录 RAG 控制器所有 endpoint
- **健康检查**：`/api/health` / `/health/live` / `/health/ready`（k8s 探针）
- **Prometheus**：`/api/metrics` 暴露业务指标（ETL 耗时、向量检索、HyDE、Rerank、熔断状态）
- **操作审计**：`sys_audit_log` 表记录 method/url/statusCode/ip

### 通用能力
- 文件上传（multer diskStorage，50MB 上限，7 种扩展名白名单）
- 限流（express-rate-limit 15min/1000）
- 安全（helmet、trust proxy 真实 IP）
- 日志（log4js 请求日志 + 响应包装）
- 国际化友好的乱码处理（multer latin1→utf8 修复中文）

## 技术栈

| 层 | 技术 |
| :--- | :--- |
| **前端** | Vue 3.3 / TypeScript 5 / Vite 4 / Element Plus 2.4 / Pinia 2 / Vue Router 4 / Axios / ECharts 5 |
| **后端** | NestJS 11 / TypeScript 5 / TypeORM 11 / Passport-JWT / class-validator |
| **数据库** | MySQL 5（库名 `kapok`）+ Redis 7 |
| **向量库** | Qdrant（外部依赖，默认 `http://localhost:6333`） |
| **LLM** | OpenAI 兼容协议（默认 `https://api.minimaxi.com/v1`）+ LangChain |
| **Rerank** | `@huggingface/transformers` + `Xenova/bge-reranker-base`（q8 量化，CPU 推理） |
| **队列** | BullMQ 5 |
| **监控** | Prometheus + `@willsoto/nestjs-prometheus` + `@nestjs/terminus` |
| **弹性** | `p-limit` + `opossum` |
| **部署** | Docker Compose（client/servers/mysql/redis/adminer） |

## 快速开始

### 环境要求

- Node.js 18+ / pnpm（**推荐**，npm 在某些场景下安装会失败）
- MySQL 5 / Redis（本地或 Docker）
- Qdrant 向量数据库（**外部依赖**，需自行启动）—— 见 [Qdrant 快速启动](https://qdrant.tech/documentation/quick-start/)

### 1. 初始化数据库

```sh
# 导入初始 SQL（库名 kapok）
mysql -u root -p < db/kapok.sql
```

### 2. 启动后端

```sh
cd servers
pnpm i

# 修改配置：servers/src/config/dev.yml 中的数据库连接 + ai.llm.* + ai.qdrant.*
cp src/config/dev.yml.example src/config/dev.yml  # 按需

pnpm start:dev        # watch 模式，http://localhost:8081
```

Swagger 文档：[http://localhost:8081/api/docs](http://localhost:8081/api/docs)

### 3. 启动前端

```sh
cd client
pnpm i
pnpm dev              # http://localhost:5173
```

### Docker 一键启动

```sh
docker compose up -d           # client(9540) / servers(8080) / mysql / redis / adminer(8088)
./docker-compose-restart.sh
```

> Docker 启动不包含 Qdrant，需单独运行（如 `docker run -p 6333:6333 qdrant/qdrant`）。

## 演示账号

| 账号 | 密码 | 权限 |
| :--- | :--- | :--- |
| `admin` | `admin` | 超级管理员 |
| `test` | `Q123456` | 测试用户 |

> 批量导入用户的默认密码也是 `Q123456`，可在 `servers/src/config/*.yml` 中通过 `user.initialPassword` 修改。

## 常用命令

### 前端 (`client/`)
```sh
pnpm i                    # 安装依赖
pnpm dev                  # 启动开发服务器
pnpm build                # 类型检查 + 生产构建
pnpm test:unit            # 单元测试 (vitest)
pnpm lint                 # eslint --fix
```

### 后端 (`servers/`)
```sh
pnpm i
pnpm start:dev            # 开发模式 (watch)
pnpm start:debug          # 带 --inspect-brk 调试
pnpm start:prod           # 生产模式
pnpm start:docker         # docker 模式
pnpm build                # nest build
pnpm test                 # 单元测试 (jest)
pnpm test:e2e             # e2e 测试
pnpm lint                 # eslint --fix
pnpm format               # prettier
```

## 架构概览

```
┌─────────────────────┐         ┌──────────────────────────────────┐
│   Vue 3 前端         │  HTTP   │  NestJS 后端                      │
│   (client/)         │ ◀────▶  │  (servers/)                      │
│                     │  SSE    │                                   │
│  • Pinia 状态        │         │  ┌──────────────────────────┐    │
│  • Vue Router       │         │  │ JwtAuthGuard + RolesGuard │    │
│  • Element Plus     │         │  │ AuditInterceptor (RAG)   │    │
│  • ECharts          │         │  └──────────────────────────┘    │
│  • KUI 自研组件     │         │                                   │
└─────────────────────┘         │  ┌──────────┐  ┌──────────┐     │
                                │  │ system/  │  │ common/  │     │
                                │  │  • auth  │  │  • redis │     │
                                │  │  • user  │  │  • health│     │
                                │  │  • menu  │  │  • metrics│    │
                                │  │  • role  │  │  • guards │    │
                                │  │  • perm  │  │  • log4js │    │
                                │  │  • dept  │  │  • utils │     │
                                │  │  • post  │  └──────────┘     │
                                │  │  • oss   │                     │
                                │  │  • rag ⭐│  ┌──────────┐      │
                                │  │  • audit│  │ BullMQ   │      │
                                │  └──────────┘  │ rag-etl  │      │
                                │                 └──────────┘      │
                                └──────────────────────────────────┘
                                          │         │         │
                                          ▼         ▼         ▼
                                    ┌─────────┐ ┌──────┐ ┌────────┐
                                    │ MySQL   │ │Redis │ │Qdrant  │
                                    │ (kapok) │ │      │ │ :6333  │
                                    └─────────┘ └──────┘ └────────┘
                                          ▲
                                          │ OpenAI 兼容协议
                                          ▼
                                    ┌─────────────┐
                                    │ LLM API     │
                                    │ + Embedding │
                                    │ + Rerank    │
                                    │ (本地 CPU)  │
                                    └─────────────┘
```

> 更详细的 RAG 流程图、双轨制架构、ETL 状态机见 [docs/rag/](docs/rag/)。

## 项目结构

```
nest-admin/
├── client/                      # Vue 3 前端
│   ├── src/
│   │   ├── api/                 # 业务域 API 封装（axios）
│   │   ├── views/               # 业务视图（dashboard / login / permission / rag / system）
│   │   ├── components/          # 公共组件
│   │   ├── plugins/k-ui/        # 自研 KUI 组件库
│   │   ├── store/modules/       # Pinia stores（user / permission / tags-view / app）
│   │   ├── router/              # constantRoutes + asyncRoutes
│   │   └── icons/               # 全局 SVG（vite-plugin-svg-icons）
│   └── package.json
│
├── servers/                     # NestJS 后端
│   ├── src/
│   │   ├── main.ts              # 入口（helmet/rate-limit/swagger/sse/审计）
│   │   ├── app.module.ts        # 装配 ConfigModule/TypeORM/Redis/Prometheus/BullMQ/Health
│   │   ├── common/              # 通用（guards/decorators/enums/libs/utils/health/metrics）
│   │   ├── system/              # 业务模块
│   │   │   ├── auth/ user/ menu/ role/ perm/ dept/ post/ oss/
│   │   │   ├── rag/             # ⭐ RAG 知识库
│   │   │   └── audit/           # 操作审计
│   │   └── config/              # YAML 配置（dev/test/prod/docker）
│   └── test/                    # e2e 测试
│
├── db/kapok.sql                 # MySQL 初始数据
├── upload/                      # 上传文件存储（运行时）
├── docs/                        # 项目文档
│   └── rag/                     # RAG 架构图、时序图、状态机
├── docker-compose.yaml          # 一键部署
└── CLAUDE.md                    # 给 Claude Code 的深度架构指南
```

## 文档

- [CLAUDE.md](CLAUDE.md) —— 深度架构说明（鉴权、装饰器、ETL 配置、限流熔断、ESLint 约定等）
- [docs/rag/](docs/rag/) —— RAG 模块可视化文档（架构图 + 时序图 + 状态机）
- [servers/README.md](servers/README.md) —— NestJS 七大概念（Controller/Provider/Filter/Pipe/Guard/Interceptor）中文入门

## 重要约定

- **依赖管理**：必须用 `pnpm`（npm 在某些场景下安装失败，详见 CLAUDE.md）
- **配置文件**：所有运行时配置走 YAML，**禁止硬编码**（如端口、JWT 密钥、LLM API Key）
- **ESLint**：后端 `semi: never` / 单引号 / 2 空格；前端 Vue3 essential + Standard + Prettier
- **JS/TS 统一识别为 TypeScript**（`.gitattributes` 标注，不被 GitHub 语言统计误导）
- **多租户隔离**：`RagFileEntity` / `RagMessageEntity` / Qdrant metadata 都带 `userId` 字段
- **流式响应必须加 `@Keep()`**：跳过全局 `TransformInterceptor` 的响应包装

## 许可证

UNLICENSED · 仅供学习与内部使用

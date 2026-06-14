# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**Nest Admin** 是一个一站式 RBAC 管理系统，基于 NestJS 10 + Vue 3 + TypeScript 构建。代码库分为两个独立的子项目：

- `client/` — Vue 3 前端（端口 `5173`，Vite 构建）
- `servers/` — NestJS 后端（端口 `8081`，API 前缀 `/api`，Swagger 文档 `/api/docs`）

数据库：MySQL 5（库名 `kapok`，SQL 初始文件 `db/kapok.sql`） + Redis。

外部依赖（不在 `docker-compose.yaml` 内，需自行启动）：Qdrant 向量数据库（RAG 模块使用，默认 `http://localhost:6333`）。LLM 通过 OpenAI 兼容协议接入，配置位于 `servers/src/config/*.yml` 的 `ai` 段（`ai.llm.apiKey` / `baseURL` / `modelName` / `ai.qdrant.*`）。

## 常用命令

> 强烈推荐使用 `pnpm` 安装依赖（README 中已注明 npm 在某些场景下可能安装失败）。

### 前端 (`client/`)
```sh
pnpm i                    # 安装依赖
pnpm dev                  # 启动开发服务器 (http://localhost:5173)
pnpm build                # 类型检查 + 生产构建
pnpm build-only           # 仅构建
pnpm type-check           # vue-tsc 类型检查
pnpm test:unit            # 单元测试 (vitest + jsdom)
pnpm lint                 # eslint --fix
```

### 后端 (`servers/`)
```sh
pnpm i
pnpm start:dev            # 开发模式 (watch, NODE_ENV=development)
pnpm start:debug          # 带 --inspect-brk 调试
pnpm start:prod           # 生产模式
pnpm start:docker         # docker 模式 (servers/Dockerfile 入口)
pnpm build                # nest build
pnpm test                 # 单元测试 (jest)
pnpm test:watch           # 监听模式
pnpm test:cov             # 带覆盖率
pnpm test:e2e             # e2e 测试 (test/jest-e2e.json)
pnpm lint                 # eslint --fix
pnpm format               # prettier
```

### 运行单个测试
- 前端：`pnpm test:unit <pattern>` （vitest 支持文件名匹配）
- 后端：`pnpm test -- <spec-file>` 或 `pnpm test -- -t "<test name>"`（jest）

### Docker 一键启动
```sh
docker compose up -d           # 启动 client(9540) / servers(8080) / mysql / redis / adminer(8088)
./docker-compose-restart.sh
```
client 通过 nginx 反代访问 `http://localhost:8080/api/...`；上传目录挂载到 `./upload`。

## 架构要点

### 后端架构（`servers/src`）

`main.ts` 启动时全局注册：helmet 安全头、`/api` 前缀、express-rate-limit（15 分钟/1000 次）、Swagger、log4js 请求日志、`ValidationPipe`、`TransformInterceptor`（统一响应包装）、两个全局 `ExceptionFilter`、跨域、真实 IP 解析。

`app.module.ts` 装配：
- `ConfigModule` 读取 YAML 配置（按 `NODE_ENV` 选择 `dev.yml` / `test.yml` / `prod.yml` / `docker.yml`，映射关系在 `config/index.ts`）
- `ServeStaticModule` 将 `app.file.location` 配置的上传目录以 `app.file.serveRoot` 路径对外暴露（默认 `/static`）
- `TypeOrmModule.forRootAsync` + `autoLoadEntities: true` —— 实体无需在 `entities` 中显式声明
- `@liaoliaots/nestjs-redis` Redis 客户端
- 两个全局 `APP_GUARD`：`JwtAuthGuard`（Token 解析）+ `RolesGuard`（接口级权限校验）
- 业务模块（见下）

业务模块按"系统"维度划分在 `servers/src/system/`：
`auth` / `user` / `menu` / `role` / `perm` / `dept` / `post` / `oss` / `rag`，每个模块为标准 NestJS 形态 `*.module.ts` + `*.controller.ts` + `*.service.ts` + `*.entity.ts` + `dto/`。

#### RAG 知识库模块（`servers/src/system/rag/`）
企业级双轨制 RAG（Retrieval-Augmented Generation）：
- 双轨制：`ragTrack` 字段决定文档走 **VECTOR**（Qdrant 向量库，默认）还是 **SQL**（Excel/CSV 行治理）轨道
- 实体：`RagFileEntity`（表 `sys_rag_file`）记录文件/文件夹树，含 `vectorStatus` 枚举（`pending` / `processing` / `success` / `failed`，**统一使用小写字符串值**与前端约定一致）
- 文档解析：`txt` / `md` / `pdf`（pdf-parse）/ `docx`（mammoth）走文本提取 → `RecursiveCharacterTextSplitter`（chunk 600 / overlap 100）→ OpenAI Embeddings → Qdrant
- 异步 ETL：`asyncProcessEtlPipeline` 后台跑切片与向量化，失败回写 `errorMessage` 不阻塞 HTTP 响应
- 流式问答：`/rag/ask-stream` 端点直写 SSE（`text/event-stream`，需加 `@Keep()` 装饰器跳过 `TransformInterceptor` 的响应包装），前端 `client/src/api/rag.ts` 用 `fetch` + `ReadableStream` 解析
- 权限：写入/上传/删除接口在 Controller 内做 `req.user.type === UserType.SUPER_ADMIN` 二次校验；查询接口用 `@AllowNoPerm()`
- 配置：`ai.llm.*`（apiKey / baseURL / modelName / temperature=0.2）+ `ai.qdrant.*`（url / collectionName），见 `servers/src/config/*.yml`

#### 权限系统
- 用户 JWT 由 `AuthStrategy`（passport-jwt）解析，Token 通过 `Authorization: Bearer` 头传递
- 路由白名单：`servers/src/config/*.yml` 的 `perm.router.whitelist`
- 装饰器位于 `common/decorators/`：
  - `@AllowAnon()` —— 无需 Token
  - `@AllowNoPerm()` —— 有 Token 但跳过接口权限校验
  - `@Keep()` —— 跳过全局 `TransformInterceptor` 响应包装（SSE 流式 / 文件下载等需要直写 `res` 时必须加）
- 接口权限模型：超级管理员直接放行；其他用户 `RolesGuard` 调用 `PermService.findUserPerms(userId)` 拿到该用户拥有的路由权限列表后用 `path-to-regexp` 匹配当前请求

#### 通用工具
- `common/libs/log4js/` —— 日志中间件 + 响应包装 + 异常过滤器
- `common/libs/redis/` —— RedisModule 封装
- `common/decorators/api-result.decorator.ts` —— Swagger 响应装饰器
- `common/enums/` —— 公共枚举（如 `UserType.SUPER_ADMIN`）

#### 实体命名约定
文件名 `<name>.entity.ts`，TypeORM 通过 `autoLoadEntities` 自动扫描。

### 前端架构（`client/src`）

`main.ts` 启动顺序：归一化样式 → 自定义全局样式 → 全局 SVG（`icons/`）→ 自定义指令（`directive/`）→ 引入 `perm.ts`（权限指令注册）→ `KUI`（自研 UI 库）→ Pinia → Vue Router → 挂载。

`vite.config.ts` 关键点：
- 路径别名：`@` → `src/`，`_c` → `components/`，`cm` → `common/`，`_hooks` → `hooks/`，`k-ui` → `plugins/k-ui/`
- `vite-plugin-svg-icons` 将 `src/icons/svg` 注册为 `icon-[dir]-[name]`，配合 `components/SvgIcon` 组件使用
- 生产环境通过 `vite-plugin-compression` gzip > 10KB 文件
- 开发代理 `/api → http://127.0.0.1:8081`
- 预设依赖预构建（`optimizeDeps.include`）

#### 状态管理（`store/modules/`，Pinia setup 风格）
- `user.ts` —— 登录态、Token、用户信息
- `permission.ts` —— 根据后端返回的菜单 (`MenuApiResult.code` 匹配 `route.name`) 通过 `filterAsyncRoutes` 过滤 `router/asyncRoutes`，与 `constantRoutes` 合并后 `router.addRoute`
- `tags-view.ts` —— 多页签
- `app.ts` —— 全局 UI 状态（侧边栏、主题等）

#### 路由
- `router/constantRoutes` —— 无需登录的路由（`/login`、`/redirect`）
- `router/asyncRoutes` —— 需根据用户菜单权限动态注入的业务路由
- 业务视图在 `views/`，按业务域分目录（`dashboard` / `login` / `permission` / `rag` / `redirect` / `system`）

#### API 约定
- `api/base.ts` 定义 `ResultData<T>` / `ListResultData<T>` 统一响应体（`{ code, msg, data }`，列表型 `data: { list, total }`）
- 每个业务域一个 `api/*.ts` 文件，使用 `axios`（封装见同名文件）
- 环境变量以 `VITE_APP_` 前缀，见 `client/.env`（基础 API 路径、下载路径、请求超时等）

#### KUI 自研组件库
- 入口 `client/src/plugins/k-ui/index.ts`，以 `app.use(KUI)` 形式注入
- 源码在 `client/src/plugins/k-ui/packages/`，按需以 `k-` 前缀引用（如 `k-table`、`k-form`、`k-badge`）

## 重要约定

- **JS/TS 统一识别为 TypeScript**（`.gitattributes` 中 `*.js`、`*.vue`、`*.scss` 都标记为 `linguist-language=typescript`），不要被 GitHub 语言统计误导
- `.gitignore` 整体忽略工作区根目录的子文件夹内容但保留 `.gitkeep` 占位，这是为了把每个子项目的 `node_modules` / 编译产物排除在仓库根跟踪外；根目录的 `logs/` 例外保留
- 后端 ESLint：`semi: never`、单引号、2 空格缩进、`eol-last` 必填
- 前端 ESLint：Vue3 essential + Standard + Prettier，行尾 `auto`
- 初始/重置密码（`user.initialPassword`）在 `servers/src/config/*.yml` 中配置
- 上传文件存储路径与 HTTP 暴露路径分别由 `app.file.location` 和 `app.file.serveRoot` 控制（开发环境分别默认 `../upload` 与 `/static`）

## 演示账号

| 账号 | 密码 | 权限 |
| :--- | :--- | :--- |
| admin | admin | 超级管理员 |
| test | Q123456 | 测试用户 |

## 文档与参考

- 项目文档站（已删除，本地不再随仓库分发）：原目录 `docs/`，内容包含前后端架构、Swagger、JWT、权限、菜单、设计等
- 后端 `servers/README.md` 详尽介绍了 NestJS 的 Controller / Provider / Middleware / Filter / Pipe / Guard / Interceptor 七大概念（中文），适合作为 NestJS 入门参考
- `upload/` 目录中保留了 `user.png`、`dept.png`、`role.png`、`menu.png`、`oss.png` 等界面截图与作者收款码（`pay.jpg`），仅作存档

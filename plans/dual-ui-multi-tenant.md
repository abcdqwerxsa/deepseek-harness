# 开发计划：双 UI 多租户部门模型平台（原版 dsh web 反代 + 管理控制台）

> 状态：**规划就绪**。供在新会话中直接按清单执行。
> 架构定位：基于 `feat/saas-platform` 分支已有成果（BFF、orchestrator、bwrap 隔离收敛、模型网关），推进部门/用户三层架构与双 UI 原版体验。

---

## Context

### 核心诉求与业务背景
1. **真实组织模型**：企业中「租户 = 部门」，每个部门下有多个「用户/员工」。
2. **私有性与隔离**：用户之间的会话、工作区代码、个人设置必须**各自私有**，互不可见（由 bwrap 沙箱强隔离保障）。
3. **共享与治理**：同部门共享部门级配额、平台代管的模型密钥；部门管理员可查看本部门用量与审计，平台管理员掌握全局。
4. **原版 UI 诉求**：用户侧需要 100% 完整的 DeepSeek Harness 原版 Web 体验（包括模型选择、思维链/深度思考档位调节、权限预设切换、插件管理与 General Settings 等全套能力）。
5. **双 UI 架构**：
   - **用户侧（User Portal）**：沙箱内按需启动的原版 `dsh web`，经网关子路径 `/u/<dept>/<user>/` 透明反代暴露，每人独立进程与配置。
   - **管理侧（Admin Console）**：自建的轻量级管理控制台，提供平台/部门双级治理能力。

---

## Approach

### 1. 身份与认证子层（Identity & 3-Role Auth）
- **三层角色体系**：
  - `member`（普通成员）：拥有独立的个人沙箱与 `dsh web`，仅可访问自身会话与数据。
  - `dept-admin`（部门管理员）：拥有个人沙箱，额外具备本部门成员管理、本部门用量与审计报表查看权限。
  - `platform-admin`（平台管理员）：拥有全实例最高权限（部门增删、全局配额、跨部门审计、平台升级与密钥管理）。
- **复合身份与 Token**：
  - 身份模型由 `tenantId` 升级为 `(deptId, userId)` 二元组，主路径标识为 `${deptId}/${userId}`。
  - `PLATFORM_TOKENS` 升级为 `[[token, deptId, userId, role]]`。
  - 独立平台管理员配置：`PLATFORM_ADMIN_TOKENS=[token1, token2]`。
  - 数据目录自动分层：`/data/tenants/<deptId>/<userId>/{home,workspace}`。
  - bwrap 占位符 `{tenantDir}` 自动解析为 `/data/tenants/<deptId>/<userId>`。

### 2. 模型网关透传（Model Gateway with User Tracking）
- 沿用已验证的模型网关机制（真实 API Key 严格锁在 BFF 内部，不进入任何子进程/沙箱）。
- 签名网关 Token payload 升级为 `{ tenant: deptId, user: userId, exp }`。
- 子进程无论跑 ACP 还是 `dsh web`，均通过内置的 `DEEPSEEK_BASE_URL=http://127.0.0.1:8080/internal/model/v1` 和签名 Token 访问模型。
- 模型调用审计精准记录 `user=${userId}`，用量报表支持按部门与按用户双维度聚合。

### 3. 用户侧原版 `dsh web` 子路径反代（Subpath-Aware Web Proxy）
#### A. 上游客户端 Base-Path 适配（最小上游改动，已验证完全向后兼容）
- **问题根因**：浏览器中 `fetch('/api/...')` 或 `new URL('/api/remote.mux', location.origin)` 带有前导斜杠，会无视 `<base href>` 强制打到网关根路径 `/api`。
- **改动方案**：
  - `packages/client/connection/src/api-path.ts`：将相对路由定义为 `api`（无前导斜杠），node 服务端路由注册保持 `/api` 绝对不变。
  - `packages/client/connection/src/client/rpc.ts` 与 `packages/api/gateway/src/client/stream-client.ts`：URL 构造统一采用 `new URL('api/...', document.baseURI)`。
  - **向后兼容性**：在独立运行的默认 `dsh web` 中，`<base href="/">` 使 `document.baseURI` 解析为根路径，解析结果仍为 `/api/...`，完全不破坏本地使用。
  - 在子路径挂载时，`<base href="/u/<dept>/<user>/">` 自动将 API 与 WebSocket 解析为 `/u/<dept>/<user>/api/...`。

#### B. 按需 Web 运行时管理（WebRuntimeManager）
- 为每个活跃的 `dept/user` 按需启动 `dsh web` 子进程：
  - 启动参数：`node apps/cli/lib/bin.js web --port <assigned_port> --no-open --trusted-host <gateway_authority>`。
  - 运行在与 ACP 相同的 bwrap 容器隔离沙箱内（无 `/proc`、独立 `{tenantDir}`）。
  - 动态分配端口（例如 18000–18999 环形池）。
  - 空闲回收机制：无请求连接后 10–15 分钟优雅退出（释放内存），再次访问时毫秒级冷启动。

#### C. 网关动态路由与 HTML Base 改写
- 网关接收 `/u/:dept/:user/*` 请求：
  - 认证请求中的 Cookie 或 Token。
  - 动态唤醒/获取该用户的 `dsh web` 本地端口。
  - **HTML 改写**：对于根页面 HTML 响应，动态将 `<base href="/">` 替换为 `<base href="/u/:dept/:user/">`。
  - **反向代理**：将后续的静态资源请求、HTTP API 请求及 WebSocket（`/u/:dept/:user/api/remote.mux`）去掉前缀后透明转发到对应端口。
  - **Authority 保留**：保持原始请求的 `Host` 头透传，确保 Cookie 签名和 Authority 校验一致通过。

### 4. 管理控制台（Admin Management Console）
- 现有自建轻门户（`packages/platform/bff/portal/`）改造为控制台：
  - 侧边栏根据用户角色动态显示菜单：
    - `member`：重定向至自己的原版 UI `/u/<dept>/<user>/`。
    - `dept-admin`：展示本部门人员列表、Token 停发、部门 Token 消耗统计、部门审计日志。
    - `platform-admin`：展示全实例部门概览、全局配额水位、系统服务健康度、全局审计日志。

### 5. 部署自动化（Bootstrap Auto-Secret）
- 吸收 MOVO 的体验亮点：在首次运行 `docker compose up` 时，若 `.env` 不存在或缺少敏感密钥，自动生成随机的高强度 `PLATFORM_MODEL_GATEWAY_SECRET` 与管理员初始 Token，避免手动填写的摩擦。

---

## Files to modify / create

| 文件路径 | 状态 | 变更目的 |
|---|---|---|
| `packages/client/connection/src/api-path.ts` | 修改 | 将客户端 API 相对路径由 `/api` 调整为支持 `document.baseURI` 解析 |
| `packages/client/connection/src/client/rpc.ts` | 修改 | `resolveBase()` 优先使用 `document.baseURI` |
| `packages/api/gateway/src/client/stream-client.ts` | 修改 | WebSocket URL 优先使用 `document.baseURI` 派生相对路径 |
| `packages/platform/bff/src/auth.ts` | 修改 | 扩展 `TenantPrincipal` 支持 `(deptId, userId, role)` 三角色 |
| `packages/platform/bff/src/index.ts` | 修改 | 挂载 `/u/:dept/:user/` 子路径路由，集成 HTML base 改写与反代 |
| `packages/platform/bff/src/web-proxy.ts` | 新增 | 流式反代中间件（HTTP 管道、WebSocket 隧道、HTML base 过滤器） |
| `packages/platform/orchestrator/src/web-runtime.ts` | 新增 | `WebRuntimeManager`：用户级 `dsh web` 沙箱进程生命周期与端口池管理 |
| `packages/platform/bff/src/compose.ts` | 修改 | 支持 `${dept}/${user}` 两级安全路径置备与 bwrap 解析 |
| `packages/platform/bff/portal/index.html` & `portal.js` | 修改 | 升级为平台/部门管理控制台视图 |
| `deploy/server.mjs` | 修改 | 接入三角色 Token 解析与自动 Secret 注入 |
| `deploy/.env.example` & `deploy/README.md` | 修改 | 更新组织模型配置说明与双 UI 架构部署指南 |

---

## Reuse

1. **已验证机制直接复用**：
   - `@deepseek-ai/dsh-tenant-profile`：多层级路径安全创建与遥测彻底关停 patch。
   - `@deepseek-ai/dsh-orchestrator`：并发控制、FIFO 队列、安全优雅销毁（EOF -> SIGTERM -> SIGKILL）。
   - `packages/platform/bff/src/model-token.ts`：HMAC 签名、防篡改校验。
   - `packages/platform/bff/src/transcript.ts`：SQLite 存储、审计表与用量聚合。
   - bwrap 隔离包装：已在生产环境实测通过的 `--dir /data/tenants` + 私有挂载配置。
2. **标准平台能力**：
   - 浏览器原生 `document.baseURI` 与 `node:http` 双向 pipe 流。
   - WebSocket 协议透明透传。

---

## Steps

### 里程碑 1：部门 / 用户复合身份与三级角色鉴权
- [x] 1.1 扩展 `auth.ts` 的 `TenantPrincipal`，支持 `deptId`, `userId`, `role: 'member' | 'dept-admin' | 'platform-admin'`。
- [x] 1.2 升级 `compose.ts` 与 `tenant-profile`，支持 `${deptId}/${userId}` 两级目录结构与 `{tenantDir}` 安全路径解析。
- [x] 1.3 升级用量与审计服务，支持按部门归集、按用户下钻查询；编写单元测试。（`transcript.deptUsage`/`deptAuditTrail` + `transcript.spec.ts`；模型网关 token 拆分 `tenant=deptId, user=userId`，审计落到复合键）

### 里程碑 2：客户端 Base-Path 相对化适配（支持子路径反代）
- [x] 2.1 调整 `packages/client/connection/src/client/rpc.ts` 与 `api-path.ts`，基于 `document.baseURI` 构建 API 请求。
- [x] 2.2 调整 `packages/api/gateway/src/client/stream-client.ts`，基于 `document.baseURI` 构建 `remote.mux` WebSocket 连接。
- [x] 2.3 验证单机默认 `dsh web` 本地体验不受影响（全量单测 + 回归检查）。（connection/gateway 共 467 测试全绿 + 新增 `base-path.client.spec.ts` 与 gateway 子路径用例）

### 里程碑 3：用户侧原版 `dsh web` 沙箱按需管理器与动态反代
- [x] 3.1 实现 `WebRuntimeManager`：为每个 `(deptId, userId)` 按需以 bwrap 隔离启动 `dsh web`，分配本地端口与空闲回收。（就绪信号 = Loader 沉淀后的 `dsh web:` 公告行，避免路由未挂载的 404 窗口）
- [x] 3.2 实现 `web-proxy.ts`：在 BFF 挂载 `/u/:dept/:user/`，实现 HTML `<base href>` 动态改写、静态资源透传、HTTP/WS 反代。（含平台会话 cookie、子进程 dsh-auth cookie 的 Path 收窄改写、Host 透传）
- [x] 3.3 注入平台模型网关配置（`DEEPSEEK_BASE_URL` 指向内部网关，注入签名 Model Token）。（与 ACP 工厂共享 `prepareTenantSandbox`，注入路径已被 bff.e2e 模型网关用例锁定）
- [x] 3.4 编写 E2E 测试：通过子路径访问原版 UI，完成设置变更、模型选择与完整会话交互。（`bff-web.e2e.ts`：真实 `dsh web` 子进程的 launch-token 舞蹈、base 改写、静态资产与 remote.mux 隧道；完整浏览器会话交互属远程验收 5.3）

### 里程碑 4：管理控制台（Admin Console）与部门管理
- [x] 4.1 改造现有的自建门户，增加按角色渲染逻辑（普通成员直接引导进入个人原版 UI）。（`/api/whoami` + 角色视图；成员视图直接给 `?ptoken=` 链接）
- [x] 4.2 实现部门管理员（`dept-admin`）专属视图：本部门成员查看、Token 查看、部门用量报表、审计流。（成员/用量/审计三段视图；Token 停发即从 `PLATFORM_TOKENS` 移除后重启，令牌本身不入库）
- [x] 4.3 实现平台管理员（`platform-admin`）全局视图：全量部门汇总、系统并发与健康状态。（`/api/admin/overview`：部门表 + ACP/Web 运行时水位，可下钻任意部门）

### 里程碑 5：部署自动化与远程构建验证
- [x] 5.1 在 `deploy/` 中增加首次启动自动生成密钥脚本（Bootstrap Secret Generation）。（`server.mjs` 首启生成并持久化 `platform-gateway-secret` 与管理员 token，日志公告一次）
- [ ] 5.2 使用构建服务器 `ssh -p 2225 root@192.168.28.165` 进行远程镜像构建，并就地部署升级。
- [ ] 5.3 远程真机验收：两个部门各两个用户的完整原版 UI 操作、权限预设设置、跨部门与跨用户隔离性实测。

---

## Verification

1. **身份与权限隔离验证**：
   - 租户 A 的成员访问 `/u/deptA/user1/` 成功；伪造请求访问 `/u/deptA/user2/` 或 `/u/deptB/user1/` 返回 403 Forbidden。
   - 部门管理员只能查询本部门的审计与用量，无权查阅其他部门。
2. **原版 UI 功能性验证**：
   - 浏览器打开 `https://<host>:8443/u/deptA/user1/`：原版 DeepSeek Harness Web 界面完整呈现。
   - 在原版设置面板中切换权限预设（如 `workspace-write`）、配置模型选项、查看插件面板均正常持久化在个人目录。
   - 发送 Prompt：由沙箱内 `dsh web` 调通平台内部模型网关，回复流式输出无卡顿。
3. **文件系统与沙箱隔离实测**：
   - 通过在 `user1` 的原版终端执行命令，验证仅可访问 `/data/tenants/deptA/user1`，无法查阅同部门 `user2` 或其他部门文件。
   - 验证无 `/proc` 泄漏，BFF 真实环境变量不外泄。
4. **资源占用与按需回收验证**：
   - 用户关闭网页后，`dsh web` 子进程在设定时间后优雅销毁；重新打开子路径时迅速冷启动恢复。

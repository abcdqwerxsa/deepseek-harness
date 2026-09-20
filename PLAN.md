# 平台前端重构：单租户内网版（feat/saas-platform）

## Context

- **现状底座已建成**（59 commits，经 3 轮对抗性评审）：`orchestrator`（按需 spawn/回收用户 ACP 运行时）、`tenant-profile`（每用户隔离 DSH_HOME）、model gateway（密钥不落租户）、BFF（auth / ACP 代理 / WS 扇出 / transcript / 审批 / 用量 / 审计 / workspace 文件与上传）。
- **痛点**：前端体验差、bug 多，**集中在流式与思考过程展示**。门户是 868 行零构建 vanilla JS（`packages/platform/bff/portal/portal.js`，DOM 手术式渲染），已历经多轮补丁（流式碎片、滚动顺序、思考生命周期）；原版 dsh web UI 是"功率用户驾驶舱"形态，与企业"任务对话"产品形态不匹配。
- **定位**：单租户、内网、多用户；部门保留为分组。
- **参照物**：agent-luoss 前端（React ~1.5k 行：气泡模型、思考折叠、工具卡片、流式渲染、会话列表）——只借鉴交互模式，不修改该项目、不复制代码。
- **运行时**：全部基于本仓库 dsh（仓库 build，走 `deploy/build-remote.sh`），无 pi、不换 runtime。

## 已拍板决策（2026-09-17）

1. **前端路线**：重写门户为正式 React SPA；不改原版 dsh web 的 client 包。
2. **部门**：保留为分组概念（用户归属、用量/审计聚合、目录置备 `${dept}/${user}` 不动）；**角色拍平**：`member | dept-admin | platform-admin` 三级 → `user | admin` 两级（去掉 dept-admin 层）。*（"部门保留 + 拍平"按此理解，评审时可纠正）*
3. **双 UI 线删除**：子路径反代原版 dsh web 整条线（`web-proxy.ts`、`web-runtime.ts`、client base-path 上游改动回退），在 SPA 可用之后执行。
4. **P0 bug 面**：流式 + 思考过程。
5. **模型切换**：对话轮次间切换（下一轮生效），不做流式中途硬切；走 ACP `session/setConfigOption`。

## Approach

### M1 Spike + 验收基线（先行，1 天）
- Spike：dsh ACP 实现（`packages/acp/acp/src/index.ts:400` `setConfigOption`）接受的配置键——模型路由键名/格式，确定前端模型切换器与 BFF 转发的对接方式。
- Phase 0：走查当前门户，把流式/思考的存量 bug 逐条记录为 React 版验收清单（乱序、碎片、思考跨轮泄漏、滚动跳动等）。

### M2 portal-web：React SPA 核心（P0 价值）
- 新建 `packages/platform/portal-web/`：vite + React + TS strict，构建产物由 BFF 同源服务（替换现 `portal/` 静态目录的 serving，BFF 静态服务代码不动）。
- 页面：登录 → 会话列表 → 聊天流。聊天流组件对齐 agent-luoss 交互模式：用户/助手气泡、**思考折叠卡**（流式展开、轮次结束收拢、多轮隔离）、**工具调用卡片**（进行中/完成/错误态）、流式光标与增量渲染。
- 复用 BFF 既有 WS 更新扇出与 `agent_thought_chunk` / `tool_call` / `tool_call_update` / message chunk 事件语义（portal.js 的处理逻辑作为行为规格）。
- 新包按仓库规范配 README + `README.i18n.yaml`。

### M3 portal-web：完整产品面
- 审批卡（permission request → BFF 转发）、工作区文件面板（`files|file|upload` 端点已存在）、**模型切换器**、用量视图、管理台视图（用户/部门/用量/审计——admin 角色）。
- BFF 小增量端点：模型列表（model gateway 配置）+ `session/setConfigOption` 转发。

### M4 单租户化 + 双 UI 线删除
- 角色拍平：`bff/src/auth.ts` TenantPrincipal、`deploy/server.mjs` token 解析、管理台视图收敛为 user/admin。
- 删除：`bff/src/web-proxy.ts`、`orchestrator/src/web-runtime.ts` 及其测试（`web-proxy.spec.ts`、`web-runtime.spec.ts`、`bff-web.e2e.ts`）、`compose.ts`/`index.ts` 中 web-runtime 接线；回退 client base-path 改动（`packages/client/connection/src/api-path.ts`、`client/rpc.ts`、`packages/api/gateway/src/client/stream-client.ts`）到上游形态，缩小 fork 差异。
- 部门相关（身份/置备/聚合）保留不动。

### M5 部署与验收
- `deploy/` 构建链接入 portal-web（build-remote.sh → compose → caddy 内网 TLS）。
- 既有测试迁移：`bff-portal.spec.ts`、`bff.e2e.ts` 改为驱动新 SPA（JSDOM 全页驱动模式保留）。

## Files to modify / create

| 路径 | 动作 |
|---|---|
| `packages/platform/portal-web/` | 新增：React SPA 源码 |
| `packages/platform/bff/portal/` | 替换：静态产物目录（SPA dist） |
| `packages/platform/bff/src/index.ts` | 小增：模型列表 + setConfigOption 转发端点；M4 删 `/u/` 路由 |
| `packages/platform/bff/src/auth.ts` | 角色拍平 user/admin |
| `packages/platform/bff/src/web-proxy.ts`、`packages/platform/orchestrator/src/web-runtime.ts` | M4 删除 |
| `packages/client/connection/src/api-path.ts`、`client/rpc.ts`、`packages/api/gateway/src/client/stream-client.ts` | M4 回退到上游 |
| `deploy/server.mjs`、`deploy/README.md` | 角色简化 + 部署文档更新 |

## Reuse（已验证存在）

- BFF 既有端点：`session/new|prompt|close|resume`、transcript、`sessions`、`files|file|upload`、usage/audit/admin、WS 实时扇出
- ACP `session/setConfigOption` 通道
- portal.js 的 thought/tool/message 事件处理语义（行为规格）
- agent-luoss `TaskDetail.tsx` 的事件→组件映射模式（交互参照）
- `deploy/build-remote.sh` + compose + caddy 部署链路
- 3 轮评审过的 orchestrator/tenant-profile/model-gateway——零改动

## Steps

- [x] Spike：dsh ACP `setConfigOption` 模型键支持。**结论**：通道全通——`configId:"model"`，value=`JSON.stringify([provider,model])`；`session/new`/`resume`/`setConfigOption` 响应均携带完整 `configOptions` 目录，变更推 `config_option_update` 更新（`packages/acp/acp/src/model-control.ts`、`index.ts:237/295/352`）。选择在 prompt 准入时快照、整轮固定 = 轮次间切换语义，与决策 5 吻合。BFF 只需薄转发，无需解析模型路由。
- [x] Phase 0：现存门户流式/思考 bug 清单 → React 版验收清单（`plans/portal-web-phase0-bugs.md`，15 项：P0×6 轮次边界/流式渲染/断线丢事件，P1×4，P2×5）
- [x] M2：portal-web 脚手架 + 登录/会话列表/聊天流（流式、思考折叠、工具卡片）——`packages/platform/portal-web/`（React 18 + vite 6 + TS strict；纯 reducer `src/events.ts` 修 6 项 P0；定长三文件产物 BFF 零改动；reducer spec 9 用例 + BFF 静态契约 spec 替换旧 776 行 JSDOM 套件）
- [x] M3a：审批卡 + 工作区文件面板 + 模型切换器（含 BFF `/api/session/:id/config` 转发端点，即原 M3c 一并完成）
- [x] M3b：管理台视图（用户/部门/用量/审计）迁移（对现有三级 API，非 member 即可见；M4 拍平时同步收敛）
- [ ] M4：角色拍平 + 双 UI 线删除 + base-path 回退
- [ ] M5：部署链接入 + 测试迁移 + 端到端验收

## Verification

- **P0 验收**：Phase 0 流式/思考 bug 清单逐项手动验收（真实模型多轮会话：流式不碎片不乱序、思考按轮折叠不跨轮泄漏、滚动稳定）
- 模型切换：会话中切模型 → 下一轮生效且 transcript 标记正确
- `pnpm vitest run`（platform 包）+ 迁移后的 e2e 全绿；双 UI 删除后 `git grep web-proxy` 无残留引用
- 构建服务器远程构建 + compose 起服，内网浏览器全流程走查
- GUI 行为变更 PR 附 GIF（record-browser-gif skill，仓库规范）
- 每迭代后 `/run reviewer --bg`（仓库强制流程）

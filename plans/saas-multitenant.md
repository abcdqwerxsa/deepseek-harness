# 开发计划：基于 DeepSeek Harness 的多租户平台（内网 SaaS）

> 状态：**可执行稿**。owner decisions 已全部拍板（见「决策记录」）。
> 依据：2026-09-16 council 备忘录（oracle[fork] + reviewer，2 轮交叉质询收敛）+ 代码接缝验证。

## Context

把 dsh（单用户本地 agent harness）演化为**内网**「前端平台统一托管的多租户 SaaS」：千级租户、按需冷启动、平台代管模型 key。Council 核心结论：dsh 只作「被托管的 agent 运行时」（`dsh --profile acp`），多租户层完全在进程之外自建；不可共享单后端、不可整包复用 `apps/web` SPA（Host API 进程内耦合）；per-tenant 隔离是唯一把信任边界对齐 OS 的方案。

## 决策记录（2026-09-16，用户拍板）

| # | 决策 | 值 |
|---|---|---|
| 1 | 产品形态 | 内网部署为主（后期同样），无公网暴露 |
| 2 | 规模 | 千级租户，**按需冷启动**（进程=租户，一连接多会话） |
| 3 | API key | 平台代管，spawn 时 launch-env 注入（不落租户 home） |
| 4 | v1 范围 | 审批 UI 进；**计费不做**（换用量报表）；配额做并发上限+队列 |
| 5 | 代码位置 | 本仓库新增 `apps/platform` 等 |
| 6 | 分支 | 新开 `feat/saas-platform`（执行第一步） |

## Approach

1. **进程 = 租户**：`dsh --profile acp`（stdio JSON-RPC），显式独立 `$DSH_HOME`，ACP 单连接多会话。按需 spawn、空闲超时 SIGTERM 回收（ACP 受控 drain 已验证）、并发上限 + 排队。
2. **隔离 wrapper**：每个子进程包 user-namespace 隔离（`bwrap --unshare-user` 或 `unshare -r` 级别）——平台 key 经 env 注入，同 UID 下 `/proc/<pid>/environ` 可读，跨租户必须 uid 隔离；容器运行时作为升级路径。内网≠同信任域。
3. **BFF/控制平面自建**（`apps/platform`）：内网 OIDC（对接既有 IdP）+ dev 口令降级 → ACP 代理（复用 `@deepseek-ai/dsh-subagent-acp` 客户端驱动子进程）→ 审批转发（`session/request_permission` 事件 ↔ WebSocket ↔ 浏览器）→ transcript 平台侧落库（ACP resume 不回放历史、不支持 transcript replay/deletion）。
4. **前端门户新建**：直接按 ACP 语义更新流（稳定契约）渲染；`packages/client/ui-*` 组件按 props 兼容度机会性复用（ui-chat/ui-conversation/markdown 渲染），**不**引入 `packages/client/connection`（其契约绑定 Host Remote 面）。
5. **租户 profile 模板**：telemetry 全关（OTel→`DISABLED`、session-log-deepseek 关停）+ dsh 版本锁定（上游 developer preview 破坏性变更）。
6. **存储**：SQLite（租户注册表 + transcript + 用量），内网千级够用；Postgres 为升级路径。

## Files to create（dsh 核心零修改）

| 路径 | 内容 |
|---|---|
| `apps/platform/` | BFF（HTTP+WS：OIDC、ACP 代理、审批转发、用量）+ 门户前端 |
| `packages/platform/orchestrator/` | 租户运行时管理：spawn（userns wrapper + env key 注入）、空闲回收、重启兜底、并发队列 |
| `packages/platform/tenant-profile/` | 租户 `DSH_HOME` 置备器：profile 模板 + telemetry-off patch + workspace root |
| `packages/platform/transcript-store/` | ACP 事件流 → SQLite transcript/会话索引/用量聚合 |
| `packages/platform/acp-gateway/` | BFF 与 orchestrator 间的 ACP 会话门面（基于 `dsh-subagent-acp`） |

## Reuse（已验证存在）

- `packages/subagent/subagent-acp/`（`@deepseek-ai/dsh-subagent-acp`）— 现成 ACP 客户端，spawn 并驱动 `dsh --profile acp`
- `packages/acp/acp/`（`@deepseek-ai/dsh-acp`）— 协议契约：session new/prompt/cancel/close/list/resume、`session/request_permission`、MCP 声明、stop reasons
- `packages/bundle/acp-app/` — ACP profile 运行时；SIGTERM/SIGINT/stdio EOF 受控关停
- `packages/session/session-query/` — persistence root 补读（transcript 校验/修复）
- `packages/client/ui-*` — 前端组件机会性复用
- `python/sdk/README.md` 启动模式 — 显式 `DSH_HOME`、`file:` 插件安装、无需系统 Node

## Steps

- [x] **M0 地基**：新分支 `feat/saas-platform`；`tenant-profile` 置备器（模板 + telemetry-off patch + 版本锁）；隔离 home 下 `dsh --profile acp --dump-config` 验证组合
- [x] **M1 单租户驱动验证**：`tenant-acp.e2e.ts`（3/3 过）：工具往返、跨进程 session/list 持久化、SIGKILL 中断后 resume、暖 home 冷启动 <5s。**审批 e2e 延后至 M2**：审批仅在沙箱升级重试（两段异参）时触发，单 toolArguments mock 无法剧本化；M2 的 BFF 审批转发必须打通此链路，届时补
- [x] **M2 编排器 + BFF**：orchestrator（c49796e79）+ BFF（ad3840ecfa：REST 透传/WS 更新扇出/审批转发 fail-closed/SQLite transcript/dev-token 认证+Authenticator 接口）全部落地，单测 28 + e2e 7 全绿。审批的 spawn 进程级 e2e仍延后（mock LLM 需按调用序 tool arguments）；OIDC 等部署方 IdP 确定后按 Authenticator 接口接入
- [x] **M3 门户前端**：零构建门户（`packages/platform/bff/portal/`，BFF 同源服务）：token 连接/会话列表/新建会话/chat（transcript+WS 实时）/审批卡；JSDOM 全页驱动 spec + 双观察者隔离用例 + e2e 同源服务断言（提交 28e656e8a5）。ui-* 富组件复用降为 M3+ 打磨项
- [ ] **M4 收尾**：用量报表（session 事件聚合，替代计费）、审计日志、部署文档（内网单机→多机预留）、内部安全评审（SAFETY.md 要求；公网审计不适用内网但保留隔离要求）

## Verification

- M1：脚本化全生命周期断言（含 SIGTERM 优雅关停、SIGKILL 后 resume、stdout 协议纯净性——租户插件不得污染 JSON-RPC 帧）
- M2：双租户集成测试——home/workspace/env 互不可读（跨 uid `/proc` 探测）、审批往返、transcript 与事件流一致、空闲回收后 resume
- M3：浏览器 E2E（登录→建会话→prompt→审批→断线重连→resume）；跨租户泄漏探测（会话列表、transcript、审批路由）
- M4：冷启动压测（并发 spawn 队列行为）、用量报表对账

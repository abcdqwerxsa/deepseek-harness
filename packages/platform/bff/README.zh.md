---
description: "多租户平台的薄 BFF：bearer-token 租户认证、经编排器的 ACP REST 透传、带浏览器审批转发的 WebSocket 会话更新扇出，以及 SQLite transcript 存储。"
kind: "package-library"
---

# @deepseek-ai/dsh-platform-bff

[English](README.md) | 中文

## 摘要

用 `@deepseek-ai/dsh-platform-bff` 作为租户门户与每租户 ACP 运行时之间的服务层。`startPlatformServer` 把 `Authenticator`、租户运行时工厂（由 `@deepseek-ai/dsh-tenant-profile` 与 `@deepseek-ai/dsh-orchestrator` 组装：置备 home + spawn 子进程）和 SQLite transcript 组装成一个 `node:http` + `ws` 服务。REST 调用经编排器获取该租户的运行时（在并发上限之后排队）；会话更新扇出到该租户的 WebSocket 并追加进 transcript——因为 ACP `session/resume` 不回放历史。`session/request_permission` 提示被转发到该租户的 socket，超时无人应答即 fail-closed（`cancelled`）。

## 使用本包

- 作为库导入并调用 `startPlatformServer(options)`；默认监听 127.0.0.1 的 OS 分配端口——内网部署在前面放自己的 TLS 网关。
- 认证用自带的 `devTokenAuthenticator`（静态 token→租户映射）或任意 `Authenticator` 实现；HTTP 用 `Authorization: Bearer`，WebSocket 升级用 `?token=`。
- REST：`GET /api/sessions`、`POST /api/session/new {cwd}`、`POST /api/session/:id/prompt {text}`（阻塞到回合结束）、`POST /api/session/:id/close`、`POST /api/session/:id/resume {cwd}`、`GET /api/session/:id/transcript`。
- WebSocket `/ws?token=` 接收 `{type:'session-update'}` 与 `{type:'permission-request'}`；发送 `{type:'permission-response', id, response}` 应答。
- 刻意尚未实现对接上游 IdP 的 OIDC：部署方有 IdP 时针对其 token 校验实现 `Authenticator` 即可。

## 零构建门户

`startPlatformServer` 同时在 `/` 与 `/portal.js` 服务租户门户：一个刻意无工具链的页面（`portal/`），含 token 连接、会话列表、按 workspace 路径新建会话、由 transcript 接口 + 实时 WebSocket 更新驱动的聊天视图，以及可点击的审批卡。把同样两个文件放到任意静态源即可复用；其消费的 API 面就是稳定契约。

每个 spawn 出的运行时由 BFF 包装一次：其更新流同时喂 transcript 表与该租户的 socket，其审批应答者带超时地路由到该租户的活跃 socket。服务刻意零框架（`node:http`、`ws`、`node:sqlite`）且单进程；跨主机扩展是同一接口之后的未来工作。

## 已知限制与延后工作

- 列会话会按需 spawn 该租户的运行时（`session/list` 经活进程读 profile 持久化根）；直读持久化可避免这次冷启动。
- 尚无 CORS、限流或请求体大小上限——由前置内网网关负责。
- spawn 进程级的 `request_permission` e2e 仍延后（需 mock LLM server 支持按调用序的 tool arguments）；BFF 转发逻辑已由 fake-runtime 测试与完整驱动门户的 JSDOM spec 锁定。
- 门户渲染 `agent_message_chunk` 文本与其他更新种类的单行摘要；富工具调用渲染与 ui-* 组件复用是 M3+ 打磨项。

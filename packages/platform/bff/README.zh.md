---
description: "多租户平台的薄 BFF：部门/用户三级角色的 bearer-token 认证、经编排器的 ACP REST 透传、按需沙箱化 dsh web 的每用户原版 UI 子路径反代、角色感知管理控制台，以及 SQLite transcript 存储。"
kind: "package-library"
---

# @deepseek-ai/dsh-platform-bff

[English](README.md) | 中文

## 摘要

用 `@deepseek-ai/dsh-platform-bff` 作为部门用户与其沙箱运行时之间的服务层。`startPlatformServer` 把 `Authenticator`（身份为 `(deptId, userId, role)` 三元组；复合键 `deptId/userId` 拥有每个 home、transcript 行与审计行）、租户运行时工厂（由 `@deepseek-ai/dsh-tenant-profile` 与 `@deepseek-ai/dsh-orchestrator` 组装：置备 home + spawn 子进程）、可选的 `/u/<dept>/<user>/` 每用户 web 运行时管理器，以及 SQLite transcript 组装成一个 `node:http` + `ws` 服务。REST 调用经编排器获取该用户的运行时（在并发上限之后排队）；会话更新扇出到该用户的 WebSocket 并追加进 transcript——因为 ACP `session/resume` 不回放历史。`session/request_permission` 提示被转发到该用户的 socket，超时无人应答即 fail-closed（`cancelled`）。

## 使用本包

- 作为库导入并调用 `startPlatformServer(options)`；默认监听 127.0.0.1 的 OS 分配端口——内网部署在前面放自己的 TLS 网关。
- 认证用自带的 `devTokenAuthenticator`（静态 token→`(deptId, userId, role)` 映射）或任意 `Authenticator` 实现；HTTP 用 `Authorization: Bearer`，WebSocket 升级用 `?token=`。角色：`member`（仅自己的沙箱与原版 UI）、`dept-admin`（本部门成员/用量/审计）、`platform-admin`（实例总览 + 任意部门）。
- REST：`GET /api/whoami`、`GET /api/sessions`、`POST /api/session/new {cwd}`、`POST /api/session/:id/prompt {text}`（阻塞到回合结束）、`POST /api/session/:id/close`、`POST /api/session/:id/resume {cwd}`、`GET /api/session/:id/transcript`、`GET /api/usage`（更新流聚合）、`GET /api/audit`（该用户轨迹）；治理面：`GET /api/dept/{members,usage,audit}?dept=`（dept-admin：本部门，`?dept=` 被忽略；platform-admin：任意安全段部门）与 `GET /api/admin/overview`（platform-admin）。
- 原版 UI：设置 `webRuntimes` 后，`/u/<dept>/<user>/` 反代到该用户按需启动的沙箱化 `dsh web`（平台会话 cookie 由 `?ptoken=` 一次性铸造；子进程 launch-token 舞蹈、`<base href>` 改写与 WebSocket 隧道均由代理处理）。
- WebSocket `/ws?token=` 接收 `{type:'session-update'}` 与 `{type:'permission-request'}`；发送 `{type:'permission-response', id, response}` 应答。
- 刻意尚未实现对接上游 IdP 的 OIDC：部署方有 IdP 时针对其 token 校验实现 `Authenticator` 即可。

## 零构建管理控制台

`startPlatformServer` 同时在 `/` 与 `/portal.js` 服务管理控制台：一个刻意无工具链的页面（`portal/`），令牌登录后按角色渲染——成员获得原版 UI 链接（`/u/<dept>/<user>/?ptoken=`），部门管理员获得本部门成员表、用量报表与审计流，平台管理员获得实例总览（部门、ACP/web 运行时水位）并可下钻任意部门。把它放在同源，或放在会代理 `/api`、`/ws` 与 `/u/` 的网关之后；其消费的面就是稳定契约。

每个 spawn 出的运行时由 BFF 包装一次：其更新流同时喂 transcript 表与该租户的 socket，其审批应答者带超时地路由到该租户的活跃 socket。服务刻意零框架（`node:http`、`ws`、`node:sqlite`）且单进程；跨主机扩展是同一接口之后的未来工作。

## 部署（内网单机）

在一个小入口脚本里组装运行时工厂、令牌与服务：

```js
import { composeTenantRuntimeFactory, composeWebRuntimeFactory, devTokenAuthenticator, startPlatformServer } from '@deepseek-ai/dsh-platform-bff'

const identities = new Map(JSON.parse(process.env.PLATFORM_TOKENS ?? '[]').map(
  ([token, deptId, userId, role]) => [token, { deptId, userId, role: role ?? 'member' }],
))
const platform = await startPlatformServer({
  authenticator: devTokenAuthenticator(identities),
  createRuntime: composeTenantRuntimeFactory({
    tenantsRoot: process.env.PLATFORM_TENANTS_ROOT ?? '/srv/platform/tenants',
    dshBin: process.env.PLATFORM_DSH_BIN ?? '/srv/platform/dsh/apps/cli/lib/bin.js',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
    baseUrl: process.env.DEEPSEEK_BASE_URL,
  }),
  ...(process.env.PLATFORM_WEB === '1' ? {
    webRuntimes: {
      factory: composeWebRuntimeFactory({
        tenantsRoot: process.env.PLATFORM_TENANTS_ROOT ?? '/srv/platform/tenants',
        dshBin: process.env.PLATFORM_DSH_BIN ?? '/srv/platform/dsh/apps/cli/lib/bin.js',
        apiKey: process.env.DEEPSEEK_API_KEY ?? '',
        dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
        baseUrl: process.env.DEEPSEEK_BASE_URL,
        trustedAuthority: process.env.PLATFORM_PUBLIC_AUTHORITY,
      }),
    },
  } : {}),
  dbPath: process.env.PLATFORM_DB ?? '/srv/platform/platform.sqlite',
  port: Number(process.env.PLATFORM_PORT ?? 8080),
})
console.log(`platform listening on ${platform.port}`)
```

`PLATFORM_TOKENS` 是 `[token, deptId, userId, role]` 元组的 JSON 数组（每个
id 为单段安全路径段；前导下划线为平台保留，如合成管理员的 `_platform`
部门）。服务默认绑定 127.0.0.1——前置内网 TLS 网关。审计表与业务同库；
全量运维访问走 SQL 直读。`deploy/server.mjs` 是完整的生产入口，含首启
密钥自动生成。

## 已知限制与延后工作

- 尚无 CORS、限流或请求体大小上限——由前置内网网关负责。
- spawn 进程级的 `request_permission` e2e 仍延后（需 mock LLM server 支持按调用序的 tool arguments）；BFF 转发逻辑已由 fake-runtime 测试锁定。
- 控制台的用量聚合与审计以纯表格渲染；图表与 CSV 导出是后续打磨项。
- 模型网关令牌按 spawn 一次性签发、固定 24 小时 TTL；持续活跃超期的运行时会被网关 401，直到空闲回收后重启换新令牌。

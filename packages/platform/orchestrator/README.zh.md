---
description: "多租户平台的租户运行时管理器：按需 ACP 子进程 spawn（同租户去重）、队列压力下主动驱逐的空闲回收、以及进程级并发上限。"
kind: "package-library"
---

# @deepseek-ai/dsh-orchestrator

[English](README.md) | 中文

## 摘要

用 `@deepseek-ai/dsh-orchestrator` 承担多租户平台的进程侧职责：每个用户一个 spawn 出来的 `dsh --profile acp` 子进程，首次使用时创建、被引用期间保活、空闲后回收。`TenantRuntimeManager.withTenant(tenantId, work)` 获取该用户的运行时（在 `maxConcurrent` 个存活进程上限之后排队），执行 `work`，然后释放引用。`spawnAcpStdioRuntime` 把一个真实子进程经 ndJson stdio 接成 `TenantRuntime` 接口：请求透传、`session/update` 扇出、至多一个 `session/request_permission` 应答者（缺省 fail-closed 返回 `cancelled`）。

## 使用本包

- 作为库导入；不能从 `cordis.yml` 挂载。
- 提供 `createRuntime` 工厂；自带的 stdio 适配器接收完整子进程规格（`command`、`args`、`cwd`、完整 `env`），模型 key 注入因此留在组装层。
- 同一用户的并发 `withTenant` 共享一次 spawn（按键的在途去重）；容量槽位同步预留，排队唤醒不会超限。
- 队列有压力时，空闲但仍存活的进程会被主动驱逐，而不是让等待者坐满整个空闲窗口；空闲缓存只在无人排队时才有意义。
- 真实 spawn 覆盖位于 `tests/orchestrator.e2e.ts`（双租户、上限排队、空闲回收）。

## 理解实现

销毁先走 stdin EOF（dsh 的主停机路径），在宽限预算内依次升级到 SIGTERM、SIGKILL。运行时身份跨进程死亡只通过 dsh 自身的会话持久化延续：被回收的租户在下次使用时重新 spawn，并对同一 `$DSH_HOME` 恢复会话。管理器设计为单进程；跨主机池化不在范围内。

## 已知限制与延后工作

- 尚无 user-namespace 隔离包装：子进程规格接受任意 `command`，`bwrap` 式包装无需改代码即可组合，但本包不强制。
- 无崩溃自动重启：被引用期间死掉的运行时把失败上抛给 `work`；失败后重新获取会全新 spawn。
- 审批转发假定 BFF 及时注册应答者；无人应答的请求 fail-closed。

---
description: "租户平台的 Docker Compose 部署：一个平台容器（BFF + 编排器 + 构建好的 dsh）、TLS 网关、持久数据卷，以及可选的每租户子进程 bwrap 隔离包装。"
kind: "package-deploy"
---

# 租户平台部署（Docker Compose）

[English](README.md) | 中文

## 摘要

内网两个容器：`platform`（BFF、编排器、门户与构建好的 dsh 树同镜像——这是刻意设计，见 `packages/platform/` 的架构记录）与 `gateway`（内置 CA 证书的 Caddy TLS 网关）。租户 home、SQLite transcript 与审计表持久化在 `platform-data` 卷。每个租户 ACP 子进程可经 bwrap 隔离包装（`PLATFORM_ISOLATION`）运行在私有 user/PID 命名空间、只读系统树下。

## 使用本部署

```sh
cd deploy
cp .env.example .env        # set PLATFORM_TOKENS and DEEPSEEK_API_KEY
docker compose up -d --build
# portal: https://<host>:8443/  (trust Caddy's CA from the caddy-data volume, or bring your own cert)
```

轮换令牌：编辑 `.env` 后重新 `docker compose up -d`。升级平台即重建镜像——`PLATFORM_DSH_VERSION` 会刻意重新锁定租户清单（版本漂移在无 `force` 时被拒绝；有意识地更新该标记）。

## 理解各部件

- `Dockerfile` — 多阶段：builder 编译整个工作区（官方 Node 镜像自带开发头文件；`gcc` 覆盖原生插件），slim 运行时携带构建产物、生产依赖与 `bwrap`。
- `server.mjs` — 容器入口：环境变量驱动的 `startPlatformServer` + `composeTenantRuntimeFactory`。
- `docker-compose.yml` — 服务、数据卷与内网；网关负责 TLS，以及限流与 body 上限。
- `Caddyfile` — TLS 终结与反向代理（WebSocket 升级透明透传）。
- 子进程环境是固定的最小集合（`PATH`、`HOME`、`DSH_HOME`、遥测关闭、模型 key）——BFF 自身的秘密绝不进入租户子进程；wrapper e2e 锁定了这一点。

## 已知限制与延后工作

- 刻意单机；横向扩展需先做租户亲和路由（`TenantRuntime` 接缝已就绪）。
- 示例 bwrap 行映射私有 `/tmp` 与只读 `/app`/`/usr`；启用需要更宽文件系统访问的工具前请先审查挂载。
- Caddy 内置 CA 是内网便利项；生产 PKI 应替换之。

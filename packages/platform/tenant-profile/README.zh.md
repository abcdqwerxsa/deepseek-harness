---
description: "为多租户平台置备相互隔离的租户 Harness home：遥测全关的 profile patch、workspace 根目录，以及版本锁定的租户清单。"
kind: "package-library"
---

# @deepseek-ai/dsh-tenant-profile

[English](README.md) | 中文

## 摘要

用 `@deepseek-ai/dsh-tenant-profile` 为多租户平台置备按租户隔离的 Harness home。对每个租户，它创建独立的 `$DSH_HOME` 与 workspace 根目录，写入平台持有的 `cordis.patch.yml`——卸载 `dsh-base` 自带的两个遥测贡献者（DeepSeek session-log 贡献者与 OTel 会话导出器），并记录 `tenant.json` 清单，把该 home 锁定到置备它的 dsh 版本。平台编排器在为租户启动 `dsh --profile acp` 之前调用本库。

## 使用本包

- 作为库导入；不能从 `cordis.yml` 挂载。
- `provisionTenantHome({ homeDir, workspaceDir, dshVersion })` 要求绝对路径，返回创建的路径与 `provisioned` 标志。
- 相同输入重复执行是无操作（`provisioned: false`）；`dshVersion` 漂移或第三方 patch 层会被拒绝，除非传入 `force: true`。
- patch 文件在 dsh 初始化 profile 之前写入：dsh 自身的 `initProfile` 永不触碰已存在的 `cordis.patch.yml`，平台层在首次启动后依然完好。

## 理解实现

patch 层禁用 `session-log-deepseek` 与 `session-telemetry-otel` 两行，而不是覆盖其配置：被卸载的行不会运行任何采集代码，因此即使租户 workspace 代码设置了遥测环境变量，会话记录也无法离开租户运行时。清单锁把租户 home 固定到单一 dsh 构建；平台升级时以 `force` 显式重新置备。

## 已知限制与延后工作

- 不做凭证落盘：平台通过启动环境（`launch-env`）注入模型 key，绝不写入 home。
- 不做 workspace 配额与清理；闲置 home 的回收是编排器的职责。

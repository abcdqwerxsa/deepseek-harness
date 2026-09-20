---
description: "企业平台门户的 React 单页应用：会话列表与流式聊天（思考折叠卡、工具调用卡、transcript 回放），构建产物为 BFF 静态映射所服务的固定三文件。"
kind: "package-app"
---

# @deepseek-ai/dsh-platform-portal-web

[English](README.md) | 中文

## 概述

`dsh-platform-portal-web` 是企业门户前端：由平台 BFF 同源服务的 React SPA。它把每个会话渲染为一组轮次流——可折叠思考卡、工具调用卡、流式 markdown 正文；transcript 回放与实时更新走同一个 reducer，保证两处渲染一致。管理控制台为整页界面（总览、成员、用量、审计），取代了原弹窗；界面基于 CSS 自定义属性提供浅色与深色两套主题，跟随存储偏好或系统配色。构建产物精确输出 `index.html`、`portal.js`、`portal.css` 到
[`../bff/portal`](../bff/portal)，与 BFF 的固定静态文件映射一一对应，BFF 服务代码零改动。

## 开发

```sh
pnpm --filter @deepseek-ai/dsh-platform-portal-web run dev
```

开发服务器把 `/api` 与 `/ws` 代理到 `127.0.0.1:8787` 的 BFF（在
`vite.config.ts` 中调整）。

## 构建

```sh
pnpm --filter @deepseek-ai/dsh-platform-portal-web run build
```

产物替换 BFF `portal/` 目录内容。事件 reducer 契约由
`tests/events.client.spec.tsx` 覆盖；整页 JSDOM 套件在 BFF 包中。

## 已知限制与延后工作

- 管理控制台用单个 `Promise.all` 拉取成员、用量与审计，任一端点失败会让整个控制台置空直至重试。按区块降级为部分数据（已删除的弹窗抽屉的行为）延后处理。

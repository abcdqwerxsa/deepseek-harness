---
description: "The React single-page portal for the enterprise platform: session list plus streaming chat with thought cards, tool calls, and transcript replay; builds to the fixed three-file set the BFF static map serves."
kind: "package-app"
---

# @deepseek-ai/dsh-platform-portal-web

English | [中文](README.zh.md)

## Summary

`dsh-platform-portal-web` is the enterprise portal frontend: a React SPA served
same-origin by the platform BFF. It renders each session as a stream of turns
with collapsible thought cards, tool-call cards, and streamed markdown bodies,
and replays transcripts through the same reducer as live updates. The build
emits exactly `index.html`, `portal.js`, and `portal.css` into
[`../bff/portal`](../bff/portal), matching the BFF's fixed static-file map, so
no BFF serving change is needed.

## Develop

```sh
pnpm --filter @deepseek-ai/dsh-platform-portal-web run dev
```

The dev server proxies `/api` and `/ws` to a BFF listening on
`127.0.0.1:8787` (adjust in `vite.config.ts`).

## Build

```sh
pnpm --filter @deepseek-ai/dsh-platform-portal-web run build
```

The output replaces the BFF `portal/` directory contents. The event-reducer
contract is covered by `tests/events.spec.ts`; the full-page JSDOM suite lives
with the BFF package.

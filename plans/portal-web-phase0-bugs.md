# Phase 0：门户流式/思考存量 bug 清单（React 版验收基线）

来源：`packages/platform/bff/portal/portal.js`（868 行 vanilla JS）静态走查 + 历史补丁脉络（流式碎片/滚动顺序/思考生命周期/上传状态/transcript 回放）。前缀 **[P0]** = 用户拍板的痛点面（流式+思考）；**[P1]** = 结构性缺陷，React 版顺带修复；**[P2]** = 增强。

## 轮次边界与事件关联

- [P0] **1. 回声匹配判轮**：`user_message_chunk` 靠 `text !== state.lastUserPrompt` 判断新轮次。用户连发两次相同文本（如"继续"）时旧轮不收尾，新轮 chunk 追加进旧气泡 → 碎片/串轮。React 版：按会话更新流的事件序 reducer 判轮（user 回显即开新轮），不做文本比较。
- [P0] **2. 全局可变状态配对**：`currentThoughtText/currentAgentText/.active-*` DOM 类名是唯一关联手段，事件乱序或交错即错配。React 版：reducer 按 toolCallId/事件序建不可变视图模型。
- [P0] **3. 思考卡单例**：`querySelector('.active-thought-container')` 全局唯一。一轮内"思考→正文→工具→再思考"时反复创建/销毁，用户手动展开状态被销毁；多思考段无法共存。React 版：每段思考独立成卡，归属轮次。
- [P1] **4. 回放复用流式渲染器**：`selectSession` 把 transcript 行灌进同一套流式状态；回放中工具卡停在"Running"（若 tool_call_update 缺失/错 id）、思考卡带脉冲动画。React 版：回放与实时走同一 reducer，天然一致。

## 流式渲染与滚动

- [P0] **5. 全量 innerHTML 重写**：每个 chunk 对整条消息 `formatMarkdown(fullText)` 重写 → O(n²)、选区丢失、代码块/图片重排引起滚动跳动。React 版：增量 append 到分块缓冲 + memo 渲染。
- [P0] **6. 滚动启发式不稳**：near-bottom 120px 判定在全量重写下失效；思考内容另有 40px 判定，两处不一致。React 版：统一"用户上滚即停跟随"单一策略 + rAF 节流。
- [P1] **7. Markdown 渲染器残缺**：正则 token 化，无标题/列表/表格/链接，长回答排版崩坏。React 版：marked + DOMPurify。

## 连接与生命周期

- [P0] **8. WS 断线丢事件**：3s 重连，重连窗口内的 session update 永久丢失，轮次"卡死"在半截。React 版：重连后按 transcript 全量重放当前会话对账。
- [P1] **9. 无取消/转向**：busy 锁死输入、会话切换、新建；无停止按钮（ACP `session/cancel` 未暴露）。React 版：流式中可停止、可切会话（切换仅本地视角，不断后端）。
- [P1] **10. 错误渲染进正文**：错误以 `⚠️` 文本追加进 agent 气泡。React 版：独立错误态 + 重试入口。

## 其他

- [P2] 11. 每次工具完成全量刷文件列表（`tool_call_update` → `loadWorkspaceFiles`），工具风暴时打爆 API。
- [P2] 12. 会话列表标题为裸 sessionId，无标题/时间。
- [P2] 13. 审批卡展示原始 JSON 且"允许"永远选 options[0]。
- [P2] 14. 上传后自动以固定话术 prompt 智能体；失败路径双 alert。
- [P2] 15. 无模型切换器、无 reasoning effort 选择（本次需求）。

## React 版验收（M2 完成时逐项过）

1. 同文本连发两轮：轮次正确切分，无串轮/碎片。
2. 长回答（>2000 字含代码块）：流式无整段重排、滚动不跳、可选中复制。
3. 一轮内 思考→正文→工具→思考→正文：两段思考独立折叠、用户展开状态保留。
4. 流式中杀 WS 5s 再恢复：内容对账完整，不卡死。
5. transcript 回放与实时流最终 DOM 一致（同 reducer 路径）。

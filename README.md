# dsh-plugin-dsh-continue

agent 会话的某一轮以**传输/连接错误**收尾（`turn/end` reason=`error`）、或被持久化后端关成**崩溃孤儿**（`interrupted`）、或工具调用中途断无结果时，本插件自动向**同一 session** 再投一次配置好的 prompt（默认 `继续`）续跑——免去你每次手敲「继续」。

## 设计要点

- **检测走 `session/event`**（hermes-loop 同款已验证路径）。`turn/end` 的 `reason.kind`：`error` = 传输失败（结构化 `LlmFailure`），`interrupted` = 崩溃孤儿轮。其余（`completed`/`aborted`/`blocked`/`max-tokens`）不触发续跑。
- **幂等性归 agent 自身，插件只管结构性护栏**。agent 自己的系统提示已在强制「中断的工具调用 → 只读/幂等才重试，有副作用先校验外部状态」。所以插件**不**做 per-tool 读写分类（bash 既可读又可写，allowlist 脆弱且与 agent 重复判断）。插件只投 `继续`，由 agent 决定是否重发某副作用工具。
- **反循环状态机**（per-session）：`completed` 归零计数；`error`/`interrupted` 在 attempt 上限内、过冷却、无挂起 timer 时按退避排一个 `继续`；`turn/start` 取消挂起（用户/agent 已自启动别双发）；达上限停止 + 投一行折叠通知。
- **续跑动作**：`ctx.agents.get(sessionId).followup({ role:'user', content:[{type:'text',text:prompt}], source:{kind:'plugin',plugin:'dsh-continue'} })`——scheduled-items 同款手搓消息形状。session 非活动（agent 句柄拿不到）则记 `skip` 跳过。
- **范围排除**：`origin==='subagent'` 不续（其 parent 管委派）；`hermes-loop-review-*` 后台复盘 agent 跳过。
- **审计账本**：`$DSH_HOME/dsh-continue/activity.jsonl`（512KB 滚动留 2000 行）。`ctx.logger` 被宿主过滤，不可作账本——同 hermes-loop `makeTracer` 模式。
- **零配置可用**：全部设置带默认值，装上即生效；用户编辑（settings.yaml / 设置页）只是后门。

## 设置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `prompt` | `继续` | 续跑投递的 prompt 文本 |
| `maxAttempts` | `3` | 同一 session 在一次失败簇内的续跑上限；`completed` 后归零 |
| `cooldownMs` | `5000` | 同 session 两次续跑间最小间隔 |
| `backoffBaseMs` | `2000` | 退避基数：`base * 2^(attempt-1)` |
| `backoffMaxMs` | `30000` | 退避上限 |
| `retryOnError` | `true` | 传输错误时续跑 |
| `retryOnInterrupted` | `true` | 崩溃孤儿轮时续跑 |
| `notifyOnCap` | `true` | 达上限时向来源 session 投一行折叠通知 |

## HTTP API（`/dsh-continue/api`）

- `GET /status` — `enabled`、`settings`(safe)、`armed`、`perSession`(每 session 计数摘要，截尾)、`activityTail`(账本尾 ~30 行)。
- `PUT /settings` — 更新 patch，回 `{settings:safe}`。

## 文件结构

```
dsh-continue/
├── package.json              # main: src/index.js, exports["./client"]: client/bundle.js
├── cordis.patch.yml          # host-plane insert (id: dsh-continue)
├── src/index.js              # 宿主：schemastery+settings+事件状态机+续跑+账本+HTTP API
├── client/index.js           # UI：设置节（开关/maxAttempts/prompt/退避/重试原因）+ 状态/活动尾部
├── client/bundle.js          # 由 scripts/build-client.mjs 生成
├── scripts/build-client.mjs
└── test/continue.test.mjs    # 纯函数 + 模拟事件序列
```

## 开发

```sh
npm run check          # node --check src + client
npm test               # node --test test/*.test.mjs
npm run build:client   # 重新生成 client/bundle.js
```

## 已知局限

- **非活动 session 不续**：`ctx.agents.get` 返回 `undefined`（session 不在本进程驱动）时记 `skip` 跳过。`ctx.agents.resume` 恢复持久化但非活动 session 的路径未被现有插件验证过，v0.1 不碰。
- **不替代 agent 的重试判断**：插件只投 `继续`；是否重发某副作用工具由 agent 自己的系统提示决定。
- **设置热生效需重启**：运行中的 dsh 不一定热读 settings.yaml，改完要重启 dsh 才生效（同 dsh-sync）。

## 复用的基础设施

schemastery 加载、settings register + `effective()` 合并、`ctx.effect` + `session/event` 订阅、`makeTracer` 审计账本、slots + settings.section + primitives shim + `--dsw-*` token 样式 + locale registry——全部沿用 dsh-sync / hermes-loop 已验收实现。

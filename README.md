# dsh-plugin-dsh-continue

agent 会话的某一轮以**传输/连接错误**收尾（`turn/end` reason=`error`）、或被持久化后端关成**崩溃孤儿**（`interrupted`）、或工具调用中途断无结果时，本插件自动向**同一 session** 再投一次配置好的 prompt（默认 `继续`）续跑——免去你每次手敲「继续」。

## 设计要点

- **检测走 `session/event`**（hermes-loop 同款已验证路径）。`turn/end` 的 `reason.kind`：`error` = 传输失败（结构化 `LlmFailure`），`interrupted` = 崩溃孤儿轮。其余（`completed`/`aborted`/`blocked`/`max-tokens`）不触发续跑。
- **规则表驱动（核心）**：续跑行为由**有序规则表**描述——每条规则 = 匹配条件 + 动作，从上到下第一条「命中且未用尽」的规则生效：
  - 条件（`when`）：`rate-limit`（429/限流）｜`quota`（额度耗尽）｜`auth`（鉴权失败）｜`context`（上下文超限）｜`server`（5xx）｜`transport`（传输/网络错误）｜`interrupted`（崩溃孤儿轮）｜`any`（兜底）；
  - 动作（`action`）：`continue`（按当前模型继续）｜`continue-with`（换到规则指定的 provider/model 继续）｜`compact`（先经宿主 `ctx.compaction.compactIfNeeded(agent, 'context-overflow')` 压缩上下文，成功后排一次续跑；无可压缩区间/压缩失败则停止并通知）｜`stop`（停止并通知会话）；
  - 每条规则可设 `maxAttempts`（本簇内该规则最多执行次数，0=不限）——用尽后自动落到下一条匹配规则，从而表达「429 原模型重试 5 次 → 仍失败换备用模型继续 → 额度耗尽直接停止」这类策略；
  - 所有规则都不适用/用尽时按达到全局上限处理（`maxAttempts` + `notifyOnCap`）。
  - 默认表：限流退避续跑（≤5 次）｜额度耗尽停止｜鉴权失败停止｜上下文超限压缩后继续（≤2 次）｜崩溃孤儿继续｜任意失败继续。
- **失败分类（classifyFailure）**：`reason.error` 是宿主归一化的 `LlmFailure`（`code`/`status`/`providerRetryAfterMs`），插件归一为上表条件：QUOTA（或 402、或 429+额度文案）→ `quota`；RATE_LIMIT（或 429 非额度文案）→ `rate-limit`，且退避尊重 `providerRetryAfterMs`；CONTEXT_WINDOW_EXCEEDED → `context`；401/403/凭证类 → `auth`；5xx → `server`；其余 → `transport`。
- **换模型执行机制**：命中 `continue-with` 的续跑轮，通过 `agent/request` 瀑布（同 dsh-llm-retry 的注册方式）把该轮次模型请求替换为规则指定 provider/model。归属：成功投递后续跑轮记入 `overrideTurn`；用户手敲消息先启动的轮次不会被覆盖。审计链：`detect.ruleId` → `scheduled.modelPlan` → `model-overridden.via`。设置页 provider/model 一律下拉（实时目录 `GET /models`），不提供手填。
- **幂等性归 agent 自身，插件只管结构性护栏**。agent 自己的系统提示已在强制「中断的工具调用 → 只读/幂等才重试，有副作用先校验外部状态」。所以插件**不**做 per-tool 读写分类（bash 既可读又可写，allowlist 脆弱且与 agent 重复判断）。插件只投 `继续`，由 agent 决定是否重发某副作用工具。
- **反循环状态机**（per-session）：`completed` 归零计数；`error`/`interrupted` 在 attempt 上限内、过冷却、无挂起 timer 时按退避排一个 `继续`；`turn/start` 取消挂起（用户/agent 已自启动别双发）；达上限停止 + 投一行折叠通知。
- **续跑动作**：`ctx.agents.get(sessionId).followup({ role:'user', content:[{type:'text',text:prompt}], source:{kind:'plugin',plugin:'dsh-continue'} })`——scheduled-items 同款手搓消息形状。session 非活动（agent 句柄拿不到）则记 `skip` 跳过。
- **范围排除**：`origin==='subagent'` 不续（其 parent 管委派）；`hermes-loop-review-*` 后台复盘 agent 跳过。
- **审计账本**：`$DSH_HOME/dsh-continue/activity.jsonl`（512KB 滚动留 2000 行）。`ctx.logger` 被宿主过滤，不可作账本——同 hermes-loop `makeTracer` 模式。`detect`/`abort-notify`/`model-overridden` 事件均带失败分类（`failureClass`/`code`/`status`）。
- **零配置可用**：全部设置带默认值，装上即生效；用户编辑（settings.yaml / 设置页）只是后门。
- **压缩依赖随装启用**：插件 bundle patch 会同时重新启用宿主的 `compaction-basic`（web bundle 默认禁用它），否则静态注入的 `compaction` 服务会让宿主 boot 失败。不想要压缩：删除插件 patch 里该段，并把 compact 规则动作换掉。

## 设置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `prompt` | `继续` | 续跑投递的 prompt 文本 |
| `maxAttempts` | `50` | 同一 session 在一次失败簇内的续跑全局上限；`completed` 后归零 |
| `cooldownMs` | `5000` | 同 session 两次续跑间最小间隔 |
| `backoffBaseMs` | `2000` | 退避基数：`base * 2^(attempt-1)` |
| `backoffMaxMs` | `30000` | 退避上限 |
| `rules` | 见下 | 有序规则表，先命中先用；每条 `{ id, when, action, provider, model, maxAttempts }` |
| `notifyOnCap` | `true` | 达上限时向来源 session 投一行折叠通知 |

默认规则表（自上而下）：

| # | when | action | maxAttempts |
|---|---|---|---|
| 1 | rate-limit | continue（原模型退避续跑，尊重 `providerRetryAfterMs`） | 5 |
| 2 | quota | stop | - |
| 3 | auth | stop | - |
| 4 | context | compact（压缩后继续） | 2 |
| 5 | interrupted | continue | - |
| 6 | any | continue | - |

## HTTP API（`/dsh-continue/api`）

- `GET /status` — `enabled`、`settings`(safe)、`armed`、`perSession`(每 session 计数摘要，截尾)、`activityTail`(账本尾 ~30 行)。
- `GET /models` — 续跑模型下拉的数据源：`default`(`agentDefaultModel.currentSelection()`) + `providers`(经 `llm.listProviders()`/`listModels()` 的实时目录)。设置页据此渲染 provider/model 下拉；目录为空时回退手填。
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

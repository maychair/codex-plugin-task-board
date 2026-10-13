# 本地任务状态机

规则实现：`server/local-task-state.mjs`。拖动入口、依赖扫描与仓库合入监听共用事件目标；原始状态别名 `todo / queued / backlog` 对应待开始，`in_progress` 对应进行中，`in_review` 对应待确认。

| 状态 | 含义 |
| --- | --- |
| ready | 待开始 |
| running | 绑定 session 已接收启动指令 |
| blocked | 依赖、实质门槛或启动回执阻塞 |
| review | 等待审查或确认 |
| completed | 执行完成，不等于验收 |
| failed | 执行失败 |
| done | 用户验收，或用户授权的 PR / MR 合入验收 |

| 事件 | 转换条件 | 结果 |
| --- | --- | --- |
| 拖到进行中 | 保存用户授权；检查依赖及合同门槛 | 阻塞则 blocked；可执行则发起启动 |
| dependencies-blocked | 依赖缺失、不唯一或交付不可用 | blocked，保存阻塞原因 |
| 自动依赖解除 | blocked 且非空依赖全部可用；实质门槛通过 | 发起绑定 session 启动 |
| start-requested | 将启动请求持久化后调用原生 RPC | blocked，startDispatch.state=pending |
| start-received | 原生回执含绑定 threadId 和 turnId | running，清除 blocker，保存回执 |
| start-failed | 启动失败或结果不确定 | blocked，不自动重发 |
| user-record-only | 用户拖动至其他非验收状态 | 保存指定状态，不启动或停止 session |
| user-acceptance | 看板明确确认验收 | done，保存验收证据 |
| repository-merged | API 确认关联 PR / MR 已合入 | 按配置 review 或 done；正式实例配置 done |

## 自动解除依赖阻塞

用户授权“依赖全部完成后自动转为 running，并启动 session”。常驻 Codex bridge 每 10 秒扫描一次，无需打开看板。只扫描顶层登记任务；不会把零依赖任务仅凭 blocked 自动启动，也不会启动内部 Worker ledger。

依赖可用条件与拖动启动一致：依赖为 done 且有验收记录，或 completed 且 delivery.state 为 accepted / usable。未知依赖、重复编号、未验收交付仍阻塞。任务的 inputsReady / resourcesReady 和实质 executionGate 继续检查。

扫描复用 `createLocalTaskStatusHandler`，通过 `createLocalTaskReplyHandler` 核对绑定，再调用 turn/start；绑定 session 已运行则 turn/steer。已有 pending / uncertain / failed 启动记录不重发；已收到回执且重新进入 blocked 的任务可在依赖就绪后继续执行。扫描与拖动在同一 handler 串行处理，扫描只记录实际启动或错误，不增加看板提示。

原生 bridge 断开时不会伪造 running。持久化 pending 或 uncertain 的任务需要打开所属对话核实。

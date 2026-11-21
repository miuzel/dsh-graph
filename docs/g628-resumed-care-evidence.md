# g628 att-004：独立恢复的宿主副作用

固定宿主：DSH 0.2.2-rc.3，`/home/miuzel/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh`。私有真实服务栈与真实 registry、agent、session、subagent、看板及投递，LLM 使用内存假 adapter，时钟和计时器可控。

可达前提：真实托管子级自然结束退出 registry 后，经公开 `agents.resume` 独立恢复；持久 session 的 parentSession 仍为原主管；再次真实发送使其 running；`rootOf(child)` 抛 UNAUTHORIZED。测试使用真实 core API 建立与该子级对应的 in_progress 持久绑定，模拟遗留绑定；**实际产品路径能否自然保留相同绑定未证实**。

候选 a58df58 红色对照：keepalive children_running=1；care 采样该 task 并建立预算倒计时；到期新增一次主管 send、`care.inspection`，reminders 从 0 变 1，预算倒计时关闭，随后相同真实巡检的 progress 回传 accepted/applied 且新增 `care.outcome`。锁在此场景前后均 false；未声称实证锁被改变。

修复后：运行时身份不可确认时，涉及保活、care 采样、事件与结论回传的调用点使用 `requireLiveTree`，保留回退函数原语及正常 live 树的合法功能。负向测试对账：计数 unknown 而非 0，status unavailable、无任务/预算 deadline/巡检；推进 120 秒无新 inbox/send、care 事件、outcome 或锁，周期复查 timer 数量稳定。未签发 inspection 的回传返回 `ownership_unknown`；修复后对一个事先合法签发但随后独立恢复的 inspection 的真实回传尚未单独验证。

首轮全量 self-gate 的 g612 测试在 supervisor 5 秒等待处超时；同宿主单独重跑通过，随后完整重跑也通过。这支持偶发时序现象，但根因未经定位，不应断言一定是负载或与产品无关。

## att-006：故障窗口补测

各例使用私有真实 rc.3 栈、自然签发的 inspection、真实 managed child；为避免另一个 apply 内 care 运行时的 `care.run` 快照覆盖本实验真源，夹具不启动 apply，使用 core API 建立真实持久绑定。时钟和 LLM adapter 仍受控；不能据此断言生产中一定形成该遗留绑定。

- 精确拦截 `care.inspection.expired` 的追加并抛 EIO：自然结束后内存 expired，但最后落盘的 `care.run` 快照记录同一 inspection 为 claimed；无 expired 事件。该快照在 child 结束时将先前内存 claimed 状态写入。
- 签发后 dispose care 再自然结束：最后真实 `care.inspection` 快照保留 queued；重建读取时按产品既有规则归一为 delivered，而非杜撰 pending。
- child 结束期间对该 child 的 registry.get 注入异常，断言终止期间确实触发失败；最后快照为 claimed。恢复 registry、独立 resume 后重建 care。
- 三窗口各独立构造三种 outcome；重建后确有该 inspection（claimed 或 delivered），独立恢复的 child 上 rootOf 抛 UNAUTHORIZED；三种回传均为 ownership_unknown，比较结果事件、任务计数/预算/锁、inspection、lastOutcome、主管 send 前后不变。并未断言入口没有任何身份同步内存写入。
- 先前 EIO 断言误设磁盘 queued，观察到 claimed 后追踪为 `care.run` 快照；dispose 初版另一个 apply care 产生不含 inspection 的 `care.run` 快照。上述夹具隔离另一个运行时后按真实状态验证，不把调试红灯解释为产品安全缺陷。

## att-007：补证与边界

- 候选来源 att-006 `e677de9`，版本基线 `9cf4f2e`；固定 `G505_HOST_STACK_DIR` 至本机 0.2.2-rc.3 的 `dsh/node_modules/@deepseek-ai`。
- 故障注入捕获调用栈中的 `sampleTasks`，确认命中指定调用；将其 catch 变异为 childAgent=null 后三种 sampling 用例均真实断言失败（磁盘 inspection expired 而非 claimed），随后恢复原实现并重建。
- 真实 graph_start_attempt 签发 inspection 后，自然完成的 results_written 事件已落盘，goalDetail 的 child_id、parent_session_id 在退出 registry 后仍存；独立 resume 到 running 后绑定仍存，rootOf UNAUTHORIZED；三种 outcome 均 ownership_unknown。此实证未证明故障窗口也可经产品路径留下未过期 inspection。
- 普通 fork：rc.3 包导出 SessionController 与 `fork(request)`；在私有真实宿主直接 new 后调用 `controller.fork({sessionId: parent.id})` 报 `TypeError: Cannot read properties of undefined (reading 'fork')`，因为未初始化的 commands 不存在。本轮未完成私有 controller 服务的依赖装配及 fork 实测，故 UNVERIFIED，不以 session store fork 代替 controller。

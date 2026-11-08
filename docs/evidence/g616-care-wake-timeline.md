# g-616 证据：短窗口内多次关照唤醒的真实投递时间线

来源：负责人指定会话 `session-a0f8ca99-5f2d-40d1-92b9-97f2d0565c10`
（`~/.dsh/sessions/--home-miuzel-workspace-personal-dsh-subagent-ui--/session-a0f8ca99-…/session.v4.jsonl.zstd`）
与同一 workspace 的 graph 事件流 `~/workspace/personal/dsh-subagent-ui/.dsh-graph/events.jsonl`，
两处时间戳逐一比对一致（session 侧为投递时刻 `user/message.time`，graph 侧为 `care.inspection` 的 `ts`）。

## 逐次点名：两次投递属于**不同目标**（判据 1）

| # | 投递时刻 (UTC) | 投递时刻 (+08:00) | goal / attempt | child | inspection | 间隔 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 01:21:38 | 09:21:38 | **g-028** / att-001 | `11882505-…` | `4eb8db0a…` | — |
| 2 | 01:22:33 | 09:22:33 | **g-029** / att-001 | `69061b2c-…` | `40a4fc85…` | **55 秒** |
| 3 | 01:27:33 | 09:27:33 | g-029 / att-001 | `69061b2c-…` | `072ed446…` | 300 秒（正常复查间隔） |

**结论（判据 1）**：第 1、2 次投递分属 g-028 与 g-029 **两个不同目标**，
- 不是「同一任务被重复唤醒」（目标与 child 都不同）；
- 不是「逐子代理一个计时器」（同一 board 内 `decideCare` 本就取全组 `Math.min` 单一到期）。

## 真实成因：相邻到期未合并（判据 1 指定情形）

两个任务的首次到期由各自 `startedAt + 阈值` 决定：

| 任务 | `startedAt` (ms) | 首次到期 `startedAt + 300s` | 实际首次投递 |
| --- | --- | --- | --- |
| g-028 / att-001 | 1793927798000 (09:16:38) | **09:21:38** | 09:21:38（准点） |
| g-029 / att-001 | 1793927853000 (09:17:33) | **09:22:33** | 09:22:33（准点） |

两者的 `startedAt` 相差仅 55 秒 ⇒ 首次到期相差 55 秒。当前实现「到期即投递」，
于是主管在 **01:21:38** 与 **01:22:33** 被连续唤醒两次，每次都要重新组装上下文、重读全部活跃子代理，
而两次唤醒本可合并为一次（主管在任何一次唤醒中都会看到全部活跃子代理）。

## 巡检过期语义：**保持不变**（返工修正，att-002）

上一轮把 `expireStaleInspections()`（`dsh-graph-host/index.js`）由「任一 target 陈旧 ⇒ 整条
巡检 `expired`」改成「逐 target 作废」，理由是「合并后一个目标结束会作废整批」。**该结论是错的**：

- 它直接判红了**既有** `g506 B15 补充`（`core/tests/g506-care.test.ts:488`）与
  `g506 bootstrap HMR`（`core/tests/g506-care-bootstrap.test.ts:824`）两例；
- 不需要：陈旧批里活着目标的关照**不靠**「继续接受这条已作废巡检的回写」实现 ——
  `expireStaleInspections` 只作用于**已投递**的巡检，同批存活目标在巡检过期后照常参与
  下一轮调度（既有 `g506 B15 补充` 第二段断言即证明「仍活任务可在过时巡检过期后继续巡检」）。

故本目标**不改**该语义（判据 4「既有语义不变」）。返工后 `expireStaleInspectionTargets`
保持整条作废，并由 `core/tests/g616-care-coalesce.test.ts` 反向钉住（任一 target 陈旧 ⇒
整条 `expired`，同批其余结论按 `inspection_not_open` 拒绝），防止被再次"顺手优化"掉。

## 返工修正 2：合并不得提前唤醒（`g506 bootstrap HMR` 回归点）

上一轮把宽限加在**定时器唤醒时刻**上（`最早 + window`），使 300s 冷却这类
**非到期类**唤醒整体推迟一个窗口 —— `g506 bootstrap HMR` 在 301s 冷却后必须再等满 60s
才醒来，判红。

修正后的口径：**唤醒时刻仍是全组最早到期（与原实现逐字等价）**，合并只发生在
**触发之后选批**这一步 —— `careCoalesceBatch` 收 `dueAt <= now + window` 的任务。
宽限**只向过去算**：窗口内不会有第二次唤醒，故这些任务本就无法被更早关照
⇒ 合并零延迟成本、零提前。负责人裁定接受的「先到期任务被顺延至邻居也到期」由此实现。

## 复现与回归

上述路径已沉淀为自动化回归（均在 worktree 内 `bash scripts/build.sh` 后运行）：
- `core/tests/g616-care-coalesce.test.ts` — 纯函数层：合并选批、N 任务全部计账、
  `inspection_open` 顺延点名、**既有巡检过期语义不变**（反向钉住）
- `core/tests/g616-care-coalesce-scheduler.test.ts` — 真实 `createCareRuntime` 全链路：
  55 秒相邻到期合并为**一次**巡检与**一次** `send`，含「宽限外不凑合」对照
- 负向对照：把 `CARE_COALESCE_WINDOW_MS` 改 0 ⇒ 调度器用例判红
  （`actual: ['g-028'] / expected: ['g-028','g-029']`）

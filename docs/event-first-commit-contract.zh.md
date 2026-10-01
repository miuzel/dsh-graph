# 事件先行提交契约（prepare / event / persist）

> 来源：g-384（v0.18.0 代码审查 C3，P2；F2 由主管在 v0.19.0 阶段1 只读审查后指定为必做项）。
> 实现：`core/transaction.ts` 的 `commitPrepared()`（唯一次序实现）与 `withTx()`（在其上加锁）。
> 回归守卫：`core/tests/g384-event-first-commit.test.ts`、`core/tests/g383-lock-ownership.test.ts`。

## 1. 问题（修复前）

`events.jsonl` 是全部状态的唯一真相源（R-02），但两处高频写点把顺序写反了——**先落盘、后记事件**：

| 写点 | 修复前行为 |
| --- | --- |
| `core/ops.ts:1946` `transition()` | `saveGoal(goal.md)` → `appendEvent(goal.transition)` |
| `core/ops.ts:389` `writeSupervisorSession()` | `withTx` 回调内 `atomicWrite(project.yaml)`，回调返回后才追加 `supervisor.claimed` |

仅 events 追加失败（EIO/ENOSPC/进程中断）时：调用方**报错**，但目标状态/主管绑定**已经改变**，
`rebuild()` 随即检出 `frontmatter 与事件流重建不一致` 的 drift —— 失败留下了副作用，且无处对账。

F2（同类，形态不同）：`unbindGoalChild` 的取代路径先写 `attempt.superseded` 事件、后 `saveGoal`，
catch 只 `console.warn` 吞掉。`rebuild()` **不重放 attempt 事件**，于是「事件宣称 superseded、
文件仍绑定」既不可诊断、也无补偿。

## 2. 契约（三段，职责边界）

```text
prepare（调用方）  →  event（commitPrepared）  →  persist（commitPrepared）  →  解锁
纯内存：校验+变更      先追加事件（R-02）          后写文件（唯一允许写盘处）
```

1. **prepare**：调用方完成全部校验与内存变更，**零文件副作用**。
   `withTx` 回调里出现 `saveGoal`/`atomicWrite` 即违约（正是本次修复的形态）。
2. **event**：任何文件写入之前，先消费 `plan.events`。
   失败 ⇒ `TxError(phase="event")`，**persist 不执行** ⇒ 磁盘保持原值。
3. **persist**：事件已落盘后写文件（`plan.persist()`）。
   失败 ⇒ 补记 `tx.persist_failed` 诊断事件（best-effort，绝不覆盖原始错误）并抛
   `TxError(phase="persist")`；重试同一调用即收敛。

### 失败语义表

| 阶段 | 磁盘 | 事件流 | 调用方看到 | 恢复 |
| --- | --- | --- | --- | --- |
| prepare 异常 | 原值 | 不变 | 原异常（未分类异常回报 `phase=validate`，历史口径） | 修输入后重试 |
| event 失败 | **原值** | 不变（无半条记录） | `TxError`，`phase=event`，消息含「未发生任何文件写入，磁盘保持原值」 | 重试同一调用 |
| persist 失败 | 原值 | 已前进 + 1 条 `tx.persist_failed` | `TxError`，`phase=persist`，消息含「事件已先行落盘…重试同一调用即可收敛」 | 幂等重试同一调用 |

`tx.persist_failed` 的 `details`：`{ phase:"persist", error, events:[已落盘的事件名], recovery:"retry" }`。
它**不进** GUI「近期动态」（`MEANINGFUL` 白名单不含它），只作为事件流里的机器可读诊断。

### 诚实边界（不做的事）

- **不宣称跨文件原子事务**：event 与 persist 是两次独立写入，中间存在非原子窗口；
  本契约只保证「event 失败不留已改状态」与「persist 失败可诊断、可收敛」。
- **不引入数据库、不引入无限 rollback**：`persist` 失败**不自动重试**（自动重试会掩盖真实
  EIO/ENOSPC），也不回滚已落盘的事件（事件流 append-only）；由调用方幂等重试收敛。
- **事件先行 ≠ 跨文件原子**：同时改两个文件时，本契约仍逐文件保证。
- 锁回收策略（PID 归属、过期锁回收）**不在本契约范围**（属 g-394），本次未改动
  `acquireLock`/`releaseLock` 的回收语义。

## 3. 审计清单（同类写点）

判定口径：同一函数内，直接 `saveGoal`/`atomicWrite` 是否早于其后的直接 `appendEvent`；
`withTx` 回调内返回的 `events`（由事务层追加）视为「已先行」。
行号为本次修复快照（v0.19.0-test 基线 `9ffb519` 之上）。

### 3.1 已修（3 处）

| 写点 | 位置 | 现状 |
| --- | --- | --- |
| `transition()` | `core/ops.ts:1946` | `commitPrepared`：`goal.transition` 先行，`saveGoal` 进 `persist` |
| `writeSupervisorSession()` | `core/ops.ts:389` | `withTx` 回调只做 prepare，`atomicWrite` 进 `persist` |
| `unbindGoalChild()` 取代路径（F2） | `core/ops.ts:7699`（事件）→ `7720`（落盘）→ `7731`（诊断） | 顺序**有意不改**（child_id 已在 7693 捕获，先事件无额外收益）；catch 补记 `attempt.supersede_failed`（attempt/child_id/error/event_written/phase），仍不抛出、不打断本次解绑 |

### 3.2 既有等价契约：tx 内记事件 → 锁外落盘 → 失败补记诊断（保持现状，不改）

| 写点 | 位置 | 形态 |
| --- | --- | --- |
| `writeAttemptResults()` | `core/ops.ts:6441`（`attempt.results_written`，经 `withTx`）→ `6458`（锁外 `atomicWrite`）→ `6463`（失败补记 `attempt.results_skipped`，`write-failed: …`） | 事件先行 + 失败可诊断；**绝不抛出**（不打断 attempt 生命周期） |
| `refreshGoalResults()` | `core/ops.ts:7325`（`goal.results_summary_written`，经 `withTx`）→ `7320/7346`（归档副本 + 锁外 `atomicWrite`）→ `7351`（失败补记 `goal.results_summary_skipped`） | 同上；旧版先归档、归档失败即事务失败不写新版 |

**为何不迁移到 `commitPrepared`**：这两处的既有语义是「落盘失败**返回 fail 并补记事件、绝不抛出**」，
而 `commitPrepared` 的统一语义是抛出 `TxError(phase=persist)`。二者失败呈现**有意不同**
（前者被 attempt 生命周期调用，抛错会打断解绑/收尾链路）；迁移会改变调用方契约，故保留现状，
仅在此登记为「已符合事件先行 + 已可诊断」。

### 3.3 已符合事件先行（无需改动）

`setGoalDirective` / `setGoalDescription` / `appendGoalComment` / `recordAttemptHandoff` /
`deleteCard` / `fillCard` / `abandonAttempt` / `postponeGoal` / `convertOwnedToShared` /
`convertSharedToOwned` / `applyAcceptMapping` / 纯事件写点（`reportSupervisorStatus`、
`setGoalTags`、`deleteGoal`、`deleteAttachment`、`deleteSharedCard` 等）。

`unbindGoalChild` 主路径（选中 attempt 的解绑）亦为事件先行（7623/7643 事件 → 7669 落盘）；
其「回调内落盘」形态见 3.4 注记。

### 3.4 残余（同类反序，未在本次修复，21 处）

`createGoal`(1595/1604) · `setCriteria`(1657) · `updateCriteria`(1749) · `addRelation`(2575) ·
`removeRelation`(2625) · `addCard`(2990) · `createSharedCard`(3077) · `addSharedCardRef`(3100) ·
`removeSharedCardRef`(3469) · `storeAttachment`(3859) · `reviewCard`(4083) · `bindCardChild`(4174) ·
`startAttempt`(5776) · `reportStatus`(6119) · `bindAttemptChild`(6171) · `moveGoal`(7946) ·
`archiveGoal`(8048) · `unarchiveGoal`(8105) · `amendGoal`(9156) · `renameGoal`(9182) ·
`setGoalType`(9821)（`core/ops.ts` 行号）。

**注记（形态残余，已诊断）**：`unbindGoalChild`、`writeAttemptResults`、`refreshGoalResults` 的
文件写入发生在 `withTx` 回调内（而非经 `persist`），严格意义上偏离 2.1 的「prepare 零副作用」；
但三者都已满足「事件先行 + 落盘失败有诊断」，故不作为缺陷，仅登记为后续可收敛的形态债。

**残余风险（与修复前 C3 同类）**：3.4 中的写点事件追加失败时仍会留下「文件已改、无事件、调用报错」
的静默状态改变；`rebuild` 对 goal frontmatter 可检出 drift（attempt 级事件不重放，故 attempt 级
需靠 3.1/3.2 的诊断事件）。

**为何不一次性机械互换顺序**（本次硬边界）：每个写点的可收敛性依赖各自的幂等/重试语义
（如 `createGoal` 的 id 分配、`moveGoal` 的跨目录搬迁、`startAttempt` 的 attempt 目录创建、
权限与 CAS 门禁），必须逐点复核「事件先行后重试是否仍幂等」，否则会把「静默状态改变」换成
「重复事件/重复 id」。`commitPrepared` 已就位，后续可按同一契约逐点跟进（建议优先级：
状态/归属类 `archiveGoal`、`unarchiveGoal`、`moveGoal`、`startAttempt`、`bindAttemptChild`、
`setGoalType`、`reportStatus`）。

## 4. 验证

- `node --test core/tests/g384-event-first-commit.test.ts`（7 例）：①事件失败 ⇒ 文件逐字节原值 +
  阶段准确；②落盘失败 ⇒ `tx.persist_failed` + 重试收敛 + 对账一致；③正常操作无 drift；
  ④`withTx` 契约（event 失败不执行 persist、两条失败路径均释放锁、无残留）；
  ⑤F2 取代路径 ⇒ `attempt.supersede_failed` 诊断 + 文件逐字节原值。
- 故障注入为**精确**注入：只让 `events.jsonl` 的 append（EIO）或写入特定目标的 `rename`（EIO）失败，
  其余 fs 行为逐字不变；原 repro（`tmp/review-v0.18.0/tmp/core-review/repro.ts`）的注入方式与此一致。
- 负向对照（改坏/回退即红，均已实跑）：
  - 回退 `core/ops.ts` 到基线 `9ffb519`（还原两个写点的反序 + 去掉 F2 诊断）：
    ① 两例、② 两例、⑤ 共 5 例转红；
  - 去掉取代路径的 `attempt.supersede_failed` 补记：⑤ 转红；
  - 回退 `withTx` 的 `if (acquired) releaseLock` / `releaseLock` 持有者校验：
    `g383-lock-ownership.test.ts` ②③⑤ 转红（g-383 锁所有权语义未被本次改动弱化）。

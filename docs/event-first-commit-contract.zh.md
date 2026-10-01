# 事件先行提交契约（prepare / event / persist）

> 来源：g-384（v0.18.0 代码审查 C3，P2）。实现：`core/transaction.ts` 的
> `commitPrepared()`（唯一次序实现）与 `withTx()`（在其上加锁）。
> 回归守卫：`core/tests/g384-event-first-commit.test.ts`、`core/tests/g383-lock-ownership.test.ts`。

## 1. 问题（修复前）

`events.jsonl` 是全部状态的唯一真相源（R-02），但两处高频写点把顺序写反了——**先落盘、后记事件**：

| 写点 | 修复前行为 |
| --- | --- |
| `core/ops.ts` `transition()` | `saveGoal(goal.md)` → `appendEvent(goal.transition)` |
| `core/ops.ts` `writeSupervisorSession()` | `withTx` 回调内 `atomicWrite(project.yaml)`，回调返回后才追加 `supervisor.claimed` |

仅 events 追加失败（EIO/ENOSPC/进程中断）时：调用方**报错**，但目标状态/主管绑定**已经改变**，
`rebuild()` 随即检出 `frontmatter 与事件流重建不一致` 的 drift —— 失败留下了副作用，且无处对账。

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

`tx.persist_failed` 事件的 `details`：`{ phase:"persist", error, events:[已落盘的事件名], recovery:"retry" }`。
它**不进** GUI「近期动态」（`MEANINGFUL` 白名单不含它），只作为事件流里的机器可读诊断。

### 诚实边界（不做的事）

- **不宣称跨文件原子事务**：event 与 persist 是两次独立写入，中间存在非原子窗口；
  本契约只保证「event 失败不留已改状态」与「persist 失败可诊断、可收敛」。
- **不引入数据库、不引入无限 rollback**：`persist` 失败**不自动重试**（自动重试会掩盖真实
  EIO/ENOSPC），也不回滚已落盘的事件（事件流 append-only）；由调用方幂等重试收敛。
- **事件先行 ≠ 跨文件原子**：同时改两个文件时，本契约仍逐文件保证。

## 3. 审计清单（同类「先持久化后记事件」写点）

判定口径：同一函数内，直接 `saveGoal(...)`/`atomicWrite(...)` 是否早于其后的直接 `appendEvent(...)`。
行号为 v0.19.0-test 基线 `9ffb519` 之上的本次修复快照。

### 3.1 已修（本次，2 处）

| 写点 | 位置 | 现状 |
| --- | --- | --- |
| `transition()` | `core/ops.ts:1946` | `commitPrepared`：`goal.transition` 先行，`saveGoal` 进 `persist` |
| `writeSupervisorSession()` | `core/ops.ts:389` | `withTx` 回调只做 prepare，`atomicWrite` 进 `persist` |

### 3.2 已符合事件先行（无需改动，15 处）

`setGoalDirective` / `setGoalDescription` / `appendGoalComment` / `recordAttemptHandoff` /
`deleteCard` / `fillCard` / `abandonAttempt` / `postponeGoal` / `unbindGoalChild` /
`convertOwnedToShared` / `convertSharedToOwned` / `applyAcceptMapping` /
`writeAttemptResults` / `refreshGoalResults`（后两者：`withTx` 内事件先行 → 落盘失败补记
`…_skipped` 诊断事件，是本次 helper 的原型）/ 纯事件写点（`reportSupervisorStatus`、
`setGoalTags`、`deleteGoal` 等）。

### 3.3 残余（同类反序，未在本次修复，21 处）

`createGoal`(1595/1604) · `setCriteria`(1657) · `updateCriteria`(1749) · `addRelation`(2575) ·
`removeRelation`(2625) · `addCard`(2990) · `createSharedCard`(3077) · `addSharedCardRef`(3100) ·
`removeSharedCardRef`(3469) · `storeAttachment`(3859) · `reviewCard`(4083) · `bindCardChild`(4174) ·
`startAttempt`(5776) · `reportStatus`(6119) · `bindAttemptChild`(6171) · `moveGoal`(7922) ·
`archiveGoal`(8024) · `unarchiveGoal`(8081) · `amendGoal`(9132) · `renameGoal`(9158) ·
`setGoalType`(9797)（`core/ops.ts` 行号）。

**残余风险（与修复前 C3 同类）**：这些写点的事件追加失败仍会留下「文件已改、无事件、调用报错」
的静默状态改变，`rebuild` 可检出 drift 但不会自动修复。

**为何不一次性机械互换顺序**（本次硬边界）：每个写点的可收敛性依赖各自的幂等/重试语义
（例如 `createGoal` 的 id 分配、`moveGoal` 的跨目录搬迁、`startAttempt` 的 attempt 目录创建、
权限与 CAS 门禁），必须逐点复核「事件先行后重试是否仍幂等」，否则会把「静默状态改变」换成
「重复事件/重复 id」。`commitPrepared` 已就位，后续可按同一契约逐点跟进（建议优先级：
状态/归属类 `archiveGoal`、`unarchiveGoal`、`moveGoal`、`startAttempt`、`bindAttemptChild`、
`setGoalType`、`reportStatus`）。

## 4. 验证

- `node --test core/tests/g384-event-first-commit.test.ts`：①事件失败文件逐字节原值+阶段准确、
  ②落盘失败诊断+重试收敛、③正常操作对账一致、④`withTx` 契约与锁释放。
- 负向对照：把 `transition` 改回 `saveGoal → appendEvent`、或把 `atomicWrite` 搬回 `withTx`
  回调，① 立即转红；把 `withTx` 的 `if (acquired) releaseLock` 改回无条件释放，
  `g383-lock-ownership.test.ts` ② 立即转红（g-383 锁所有权语义不得被弱化）。

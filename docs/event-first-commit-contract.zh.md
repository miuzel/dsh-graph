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

### 3.4 g-395 批次收敛进度（原 21 处残余）

排序口径：**调用频率（F，1–5）× 失败后状态错位严重度（S，1–5）**。

S 的判据是「事件缺失后，错位的**后果**有多重」，先看可发现性、再按后果分档（统一口径，避免
把「不可诊断」直接等同于同一个分值）：

| S | 判据（三条同时成立才取该档） |
| --- | --- |
| 5 | `rebuild`/`validate` **均不覆盖「事件缺失」这一错位本身**（validate 只在特定形态下覆盖 frontmatter/位置不一致，见 3.4.1），且它直接改变目标的**归属/存在性**（搬迁、归档） |
| 4 | 事后不可诊断，且在磁盘上留下**改变后续行为**的新物件（如孤儿 attempt 目录改变 `count(att-*)+1` 的分配） |
| 3 | 事后不可诊断，但错位局限于**某个投影字段**（绑定/类型/关系/卡片状态），不改变归属、也不改变后续分配 |
| 2 | 事后不可诊断，影响仅限**审计/履历**（状态履历、判据、引用计数） |
| 1 | 纯文案 |

可发现性基线（实测 `core/ops.ts:3060 rebuild()`）：它只比对 `goal.created`/`goal.transition` 重放的
status，且只遍历 `listGoalFiles(root)`（不含归档）⇒ 搬迁/归属类（`goal.moved`/`goal.archived` 不重放、
也不比对位置，归档后目标甚至不在对账集合内）与 attempt 级（attempt 事件不重放、attempt.md 不参与对账）
都落在「不可诊断」一侧，因此 `startAttempt`=4、`bindAttemptChild`=3、`reportStatus`=2 并非口径不一，
而是同一族按后果分档的结果（分别对应「改变后续分配」「投影字段」「仅履历」）。

#### 3.4.1 已收敛（5 处 + 1 嵌套，g-395 第一批）

| 写点 | F×S | 失败后错位（修复前） | 收敛方式 |
| --- | --- | --- | --- |
| `startAttempt` | 5×4 | 事件失败留下「无事件的孤儿 attempt 目录」，且被 `count(att-*)+1` 计入 ⇒ 重试换号 | 事件先行；`attempts/` 与 `attempt.md` 移入 `persist`；失败时清理本次新建的半成品目录（有界） |
| `bindAttemptChild` | 5×3 | attempt.md 已绑 child 而事件流无 `attempt.bound` | 事件先行，`saveGoal` 进 `persist` |
| `reportStatus` | 5×2 | 最高频写点：attempt.md 已改而状态履历缺最新一条 | 同上 |
| `moveGoal` | 3×5 | 目标已搬迁而事件流无 `goal.moved`（rebuild 不重放它、也不比对位置 ⇒ 静默） | 事件先行；`persist` = 先写 frontmatter（仍在原位）→ 再搬迁，两个失败窗口都可重试收敛（可发现性见下）；同函数的隐式 `version.created` 骨架一并收敛 |
| `archiveGoal` | 2×5 | 目标已搬进 `archived/` 而事件流无 `goal.archived`；归档后已不在对账集合内 ⇒ 完全不可诊断 | 同 `moveGoal` |

**搬迁类两个失败窗口的可发现性（按形态分别陈述，实测）**：

| 窗口 | 磁盘状态 | 能否被 `validate` 检出 |
| --- | --- | --- |
| winA：写 frontmatter 失败（原子写，未生效） | 完全零改动（原位原值、未搬迁） | `validate=[]`；**只能靠 `tx.persist_failed` 诊断事件发现** |
| winB：搬迁步骤失败，且迁移**会改变 `meta.version`**（如 `backlog→version`、`vX→vY`） | frontmatter 已更新但仍在原位 | **可以**：`位于 backlog/ 但 version=vY` / `version 字段(vY) 与目录(vX)不一致` |
| winB：搬迁步骤失败，且迁移**不改变 `meta.version`**（如 `backlog→standalone`：仅 status draft→planning） | frontmatter 已更新但仍在原位 | `validate=[]`（`locationProblems` 只看 version 与目录的一致性）；**只能靠 `tx.persist_failed` 诊断事件发现** |

**为何仍取「先写 frontmatter、后搬迁」**：两种顺序在 winB 下都留下「frontmatter 与位置不一致」，
差别在**重试语义**（实测）：本批顺序下原位未被占用，重试重跑即完整收敛；而反序（先搬迁、后写）
在搬迁成功而写盘失败后，`moveGoal` 的重试会因 `targetFile === file` **静默 no-op**（位置正确、
frontmatter 永久滞后；基线版本事件在最后，代价是 `goal.moved` **永久缺失**），`archiveGoal` 的重试
则直接抛「归档位置已存在」。即本批顺序规避的是「目标事件永久缺失 / frontmatter 永久滞后」，
而非「重试必然死局」。

回归守卫：`core/tests/g395-event-first-batch1.test.ts`（9 例，精确 EIO 注入 + 负向对照 9/9 转红）。

#### 3.4.2 残余（16 处，供后续批次接手）

`createGoal`(16) · `addCard`(12) · `bindCardChild`(9) · `createSharedCard`(9) ·
`storeAttachment`(9) · `setGoalType`(9) · `setCriteria`(6) · `addRelation`(6) ·
`removeRelation`(6) · `addSharedCardRef`(6) · `reviewCard`(6) · `amendGoal`(6) ·
`renameGoal`(6) · `unarchiveGoal`(5) · `updateCriteria`(4) · `removeSharedCardRef`(4)
（括号为 F×S 分值；行号随 g-395 改动漂移，故只列函数名）。

**两处需要专门设计、不可机械迁移**：

- `createGoal`(F4×S4，分值最高)：id 由 `seqUpperBound()+1` 分配，且 `raiseSeqFloor` 已在落盘前
  持久抬高水位（g-337 预留语义）。事件先行后，`seqUpperBound` 含 `maxSeqFromEvents` ⇒ 事件已落盘
  而 persist 失败时，重试会把事件里的 `g-N` 计入水位并分配 `g-(N+1)`，事件流出现「有记录、无文件」
  的目标。收敛需要幂等键/显式 id 预留，属 API 设计变更。
- `addCard`(F4×S3)：组合写点（shared 路径先 `createSharedCard` 再 `addSharedCardRef`，goal 路径
  依次写 card 文件与 goal.md），需先收敛两个子写点再谈整体。

**新增登记（不在原 21 处内，本轮审计发现）**：`createGoal` 的隐式 version 骨架
（`saveGoal(version.md)` → `appendEvent(version.created)`）是与 `moveGoal` 同形的嵌套反序写点；
`moveGoal` 的同形骨架已随本批收敛，`createGoal` 的随其主写点一并处理。

**注记（形态残余，已诊断）**：`unbindGoalChild`、`writeAttemptResults`、`refreshGoalResults` 的
文件写入发生在 `withTx` 回调内（而非经 `persist`），严格意义上偏离 2.1 的「prepare 零副作用」；
但三者都已满足「事件先行 + 落盘失败有诊断」，故不作为缺陷，仅登记为后续可收敛的形态债。

**既有噪声（既有、未修、已另立目标 g-403）**：`moveGoal` 会按 g-137/g-147 规则改 `meta.status`
（`backlog→standalone` 时 draft→planning）却**不记 `goal.transition`**，而 `rebuild` 只从
`goal.created`/`goal.transition` 重放 status ⇒ `init → createGoal → moveGoal(backlog→standalone) → rebuild`
恒报 `frontmatter=planning 与事件流重建=draft 不一致`。基线 `b186ad0` 同样复现（与本批改动无关，
g-395 的两名复核者均独立实测确认）。本批回归用例改用**不改状态**的 `standalone→version` 迁移规避该噪声，
未修改其语义。

**残余风险（与修复前 C3 同类）**：3.4.2 中的写点事件追加失败时仍会留下「文件已改、无事件、调用报错」
的静默状态改变；`rebuild` 只重放 `goal.created`/`goal.transition`，attempt 级事件不重放 ⇒ attempt
级写点需靠 3.1/3.2 的诊断事件。

**为何不一次性机械互换顺序**（贯穿全部批次）：每个写点的可收敛性依赖各自的幂等/重试语义
（如 `createGoal` 的 id 分配、`storeAttachment` 的「同内容复用」早退、`startAttempt` 的目录/序号、
权限与 CAS 门禁），必须逐点复核「事件先行后重试是否仍幂等」，否则会把「静默状态改变」换成
「重复事件/重复 id」。本批实测到一例：`moveGoal` 的隐式 version 骨架会**先于** `goal.moved` 抛错，
从而绕过主写点的事件先行修复。

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

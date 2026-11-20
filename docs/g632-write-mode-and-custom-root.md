# g-632：MCP 写模式（按需开启）与核心资料目录名自定义

2026-11-17；基线 `9f34b45`。前序：[g-623 本地只读服务](<g623-local-service.md>)（安全负向矩阵 A–I 仍全部有效）。
本文只记录**已实现并已验证**的行为；未验证项单列，不在此处夸大为已通过。

本目标取代 g-623 判据 5/6 中两条**绝对口径**：「所有写命令未注册」「MCP token 不可调用审批路由」——
改为**默认仍关闭 + 服务端显式开启 + Human Gate 永不交给 MCP token**。

---

## A. MCP 写模式

### A.1 如何开启

**唯一入口是服务端的显式启动动作**（不是请求参数、不是 Header、不是 session）：

```bash
# ① 初始化时一并指定（写进服务私有运行配置 server.json）
goal-graph serve init --root <graphRoot 绝对路径> --workspace <exec 绝对路径> --allow-write

# ② 或启动时开启 / 关闭（同时回写运行配置）
goal-graph serve --root … --workspace … --allow-write
goal-graph serve --root … --workspace … --no-allow-write

# ③ 查看当前状态（含写模式）
goal-graph serve status
```

- `--allow-write` 是**纯布尔开关**：`--allow-write=false` 这类带取值的写法直接**用法错误**（不解析字符串真值）。
- 运行配置缺 `allowWrite` 字段（旧配置）⇒ 按**关闭**读取；畸形值（如字符串 `"true"`）同样按关闭读取，
  只认布尔 `true`。⇒ **现有用户零迁移、默认行为与 g-623 逐项一致**。
- 每次开关都追加一行审计到服务自有状态目录的 `write-mode-audit.jsonl`
  （`{ts, action, allowWrite, pid}`，0600；不含 token、不含请求内容）。`serve uninstall` 一并清理。

### A.2 请求参数不可能开启写模式

写模式开关族是**保留参数**：`allowWrite` / `allow_write` / `allowwrite` / `writeMode` / `write_mode` /
`writable` / `readOnly` / `read_only` / `write` / `mode`。出现在以下任一位置都会被拒：

| 位置 | 结果 |
|---|---|
| JSON-RPC 根级 `params` | `-32602` INVALID_PARAMS（`RESERVED_PARAM_KEYS` 命中） |
| `tools/call` 的 `arguments` | `-32602` INVALID_PARAMS（`WRITE_MODE_SWITCH_KEYS` 显式检查） |
| `initialize` 的 `params` | 同上（根级检查覆盖） |

### A.3 写模式边界表（单一真源：`core/service/write-commands.ts`）

写白名单共 **27 个**工具（`WRITE_MODE_COMMAND_NAMES`，与 g-623 那份「27 个写工具」名单**是两回事**，区别见本节末的口径澄清）。下表逐项标注四态与 core 实现位置；
「未纳入」一栏的每个名字都附**未纳入的原因**（不是笼统一句「本批未纳入」）。

#### A.3.1 可达的写工具（27 个，默认 ❌ / `--allow-write` 后 ✅）

| 工具 | core `ops.ts` 实现 | 默认（只读） | `--allow-write` 后 |
|---|---|---|---|
| `graph_create_goal` | `createGoal` :3572 | ❌ 未注册 | ✅ 可达 |
| `graph_set_criteria` | `setCriteria` :3679 | ❌ | ✅ |
| `graph_update_criteria` | `updateCriteria` :3737 | ❌ | ✅ |
| `graph_transition`（非 delivered） | `transition` :4025 | ❌ | ✅（`delivered` 仍拒，见 A.3.3） |
| `graph_move_goal` | `moveGoal` :11582 | ❌ | ✅ |
| `graph_add_card` | `addCard` :5224 | ❌ | ✅ |
| `graph_fill_card` | `fillCard` :6368 | ❌ | ✅ |
| `graph_delete_card` | `deleteCard` :6464 | ❌ | ✅ |
| `graph_archive_goal` | `archiveGoal` :11920 | ❌ | ✅ |
| `graph_delete_goal` | `deleteGoal` :12154 | ❌ | ✅ |
| `graph_add_relation` | `addRelation` :4635 | ❌ | ✅ |
| `graph_remove_relation` | `removeRelation` :4683 | ❌ | ✅ |
| `graph_store_attachment` | `storeAttachment` :6110 | ❌ | ✅ |
| `graph_memory_add` | `addMemory` :13750 | ❌ | ✅ |
| `graph_memory_remove` | `removeMemory` :13853 | ❌ | ✅ |
| `graph_update_settings` | `writeProjectConfig` :3040 | ❌ | ✅ |
| `graph_add_comment` | `appendGoalComment` :3971 | ❌ | ✅ |
| `graph_append_comment` | `appendGoalComment` :3971（同核别名） | ❌ | ✅ |
| `graph_set_description` | `setGoalDescription` :3911 | ❌ | ✅ |
| `graph_set_directive` | `setGoalDirective` :3831 | ❌ | ✅ |
| `graph_set_goal_budget` | `setGoalBudget` :3877 | ❌ | ✅ |
| `graph_set_goal_tags` | `setGoalTags` :13415 | ❌ | ✅ |
| `graph_set_goal_type` | `setGoalType` :13910 | ❌ | ✅ |
| `graph_report_supervisor_status` | `reportSupervisorStatus` :916 | ❌ | ✅ |
| `graph_rename_goal` | `renameGoal` :13165 | ❌ | ✅ |
| `graph_set_memory_tools_enabled` | `setMemoryToolsEnabled` :2647 | ❌ | ✅ |
| `graph_abandon_attempt` | `abandonAttempt` :11403 | ❌ | ✅（受限，见 A.3.4） |

#### A.3.2 11 个只读查询工具

`graph_list_goals` … `graph_events`：**默认 ✅ 可达，开启后仍 ✅ 可达**（与 g-623 逐项一致，本目标未改动）。

#### A.3.3 Human Gate：开启后**仍** fail-closed（3 个整工具 + 1 个状态过滤）

| 工具 | 默认（只读） | `--allow-write` 后 | 原因 |
|---|---|---|---|
| `graph_resolve_accept` | ❌ 未注册 | ❌ **仍 fail-closed**（`-32601` + `E_UNKNOWN_COMMAND`，理由指向本地 GUI） | 接受/异议必须由人在本地 GUI 看板裁决 |
| `graph_claim_supervisor` | ❌ 未注册 | ❌ **仍 fail-closed** | 主管身份不得由 MCP 写入冒充 |
| `graph_start_attempt` | ❌ 未注册 | ❌ **仍 fail-closed** | 派发会启动真实执行体，必须由宿主会话/主管发起 |
| `graph_transition → delivered` | ❌（工具未注册） | ❌ **`E_FORBIDDEN`**（工具本身可达） | 只有目标状态被拦；可达状态 = draft/planning/collecting/ready/in_progress/review/blocked |

`tools/list` 的写工具条目一律 `readOnlyHint: false` / `destructiveHint: true`。

#### A.3.4 `graph_abandon_attempt` 的真实能力边界（如实）

它**不是** Human Gate：只把 attempt 标记为 `result=cancelled`、`detached=true` 并清绑定，**不启动任何执行体**。
但它**不是万能的**——两处限制来自 core，MCP 侧未放宽：

- **授权**：core `authorizeUnbind` 只放行目标 owner（`meta.created_by`）或已配置的 `supervisor.session`。
  MCP 固定 actor 是 `mcp:local-service`，因此只对**由 MCP 自己创建**的目标（`created_by = mcp:local-service`）
  或已配置成该 actor 的目标生效；对 `human:*` 创建的目标一律抛「无权解绑——仅限目标 owner…」，**零副作用**。
- **活跃态**：MCP 侧**不提供** `liveCheck`（不把「子代理是否仍在跑」的判断权交给客户端）。因此当 attempt
  仍带 `child_id` 且 `result` 为 `pending` 时，core 走 else 分支抛「无法确认子代理状态（未提供 live check）」
  **拒绝放弃**。⇒ **MCP 只能清理已结算（`result` 非 `pending`）或从未绑定过 child 的陈旧 attempt**，
  清理不了「可能仍在跑」的活跃 attempt（那是人工/主管面）。此局限由
  `g632-write-mode-and-custom-root.test.ts` 的 A③b 第二用例**正向+负向双向钉住**。
- 另：`dispatch_in_flight` 首启未结算窗口、`delivered`/已归档目标，core 同样拒绝（沿用原有语义）。

#### A.3.5 明确**未纳入**写模式（10 个，逐项附原因）

这些名字出现在 g-623 的 H 写矩阵清单里，但**不是**写模式的候选。清单本身混入了只读诊断、插件侧不存在的
名字，以及动作面远大于「改 graph 目录」的操作。未纳入是**有声明的决策**，不是遗漏 ——
测试 A③ 用 `G623_NOT_IN_WRITE_MODE` 逐项登记，任何既不在白名单也不在该表的名字都会让断言变红。

| 工具 | 默认 | 开启后 | 未纳入原因 | 可开放的评估 |
|---|---|---|---|---|
| `graph_validate` | ❌ | ❌ | **不是写工具**：core `validate` :4963 只返回 problems，注释明写「只读诊断；不自动补记」 | 无需评估，本就不属写模式 |
| `graph_rotate_token` | ❌ | ❌ | **插件侧无该工具定义**（`dsh-graph-host/index.js` 0 处命中）；服务凭据轮换是另一回事 | 无实现，不适用 |
| `graph_clean_worktree` | ❌ | ❌ | 动**本地 Git worktree**（`core/worktree.ts:392` `cleanWorktree` → `listWorktrees`），不是 graph 目录写；还需实时 live 校验 | 另立目标 |
| `graph_unbind_goal_child` | ❌ | ❌ | 清执行绑定与 `binding token`（`unbindGoalChild` :11125），授权语义特殊，与执行体面同域 | 另立目标（需先定 token 传递方式） |
| `graph_refresh_results` | ❌ | ❌ | **`llm:true` 会派 summarizer 子代理**——唯一异步且派 LLM 的路径。让持有 loopback token 的进程触发 LLM 派发是**成本与副作用**问题，不仅是权限问题 | 另立目标（须先去掉/隔离 LLM 分支） |
| `graph_write_results` | ❌ | ❌ | 写 attempt 完成摘要（结果面），属主管职责 | 语义上**可开放**，留待另立目标 |
| `graph_rebuild` | ❌ | ❌ | 从事件流重建状态并回写 frontmatter（全库对账），动作面超出单目标写 | 语义上**可开放**，留待另立目标 |
| `graph_handoff` | ❌ | ❌ | 生成跨会话交接文档，属主管职责 | 语义上**可开放**，留待另立目标 |
| `graph_delete_attachment` | ❌ | ❌ | 附件删除（`deleteAttachment` :6270） | 语义上**可开放**，留待另立目标 |
| `graph_memory_replace` | ❌ | ❌ | 记忆修订（`replaceMemory` :13820，与 add/remove 同域但独立） | 语义上**可开放**，留待另立目标 |

> **口径澄清**：g-623 的「27 个写工具」是那份**负向矩阵的清单**（在那里它们的共同性质只是「默认都不可达」），
> 它**不是**写模式白名单的规格，且与白名单**不是子集关系**：白名单另有 13 个工具不在这 27 个之内
> （`graph_add_comment` / `add_relation` / `delete_card` / `fill_card` / `move_goal` / `remove_relation` /
> `report_supervisor_status` / `set_description` / `set_goal_budget` / `set_goal_tags` / `set_goal_type` /
> `set_memory_tools_enabled` / `update_criteria`，均为 core 真实写函数）。因此断言口径取
> 「27 个名字里的每一个都必须有归属（白名单 / Human Gate / 未纳入账）」，而**不是**「27 个全在表中」
> —— 后者在事实上不成立（`validate` 只读、`rotate_token` 无实现）。

### A.4 actor 可追溯（不可伪装）

- 所有写调用使用**固定 actor** `mcp:local-service`（`MCP_WRITE_ACTOR`）。它既不是 `human:*`
  （`isHumanActor` 为 false），也不是 `agent:<session>`，可在事件流/结果/审计面与人工、宿主 agent 区分。
- 客户端**不可能**提供 actor：`actor` / `owner` / `human` / `approval` / `approved` / `confirmed` /
  `root` / `graphRoot` / `executionWorkspace` / `token` / `sessionId` / `capability` / `role` 在写路径
  一律 `E_FORBIDDEN`，在根级 `params` 一律 `-32602`。

### A.5 Web API 不变

Web API（`/api/*`）**仍然只有 GET**：写模式只影响 **MCP** 入口，`/api/*` 的写路由**依然不存在**
（405 `E_UNKNOWN_COMMAND`）。这是有意的保守边界——浏览器侧的写入仍由宿主 GUI 承担。

### A.6 残余与已知局限（如实）

- 写白名单是**保守子集**：10 个工具明确未纳入（`graph_validate` / `graph_rotate_token` /
  `graph_clean_worktree` / `graph_unbind_goal_child` / `graph_refresh_results` / `graph_write_results` /
  `graph_rebuild` / `graph_handoff` / `graph_delete_attachment` / `graph_memory_replace`）——
  逐项原因与「是否可开放」的评估见 **A.3.5**。其中 `graph_abandon_attempt` **已开放**，但只能清理
  已结算/未绑定的陈旧 attempt，清理不了活跃态（见 A.3.4）。
- 写模式打开后**没有额外的 per-call 人工确认**：授权边界是「服务端启动时显式开启 + 只绑回环 + token」，
  与 g-623 同源。开启写模式等于承认「持有本地 loopback token 的进程可以在本仓库写看板数据」。
- `graph_transition` 的 `force`（跳过 in_progress 门槛）**未**开放给 MCP。

---

## B. 核心资料目录名按项目自定义

### B.1 唯一真源与默认值

`core/root.ts` 的 `DEFAULT_GRAPH_DIR_NAME = ".dsh-graph"` 是**唯一字面量真源**；
`assertGraphDirName` / `relativeGraphDirName` 负责越界校验与「未给出 ⇒ 默认名」的回落。
未配置时行为与原实现**逐字一致**（零迁移）。

### B.2 各入口如何拿到目录名

| 入口 | 配置通道 | 说明 |
|---|---|---|
| 插件（DSH host） | 既有 `config.root`（profile 配置 / `--patch` overlay） | 相对值 = workspace 下的目录名（可含子目录 `boards/main`）；绝对值为管理员覆盖（原语义保留） |
| CLI | `--graph-dir-name <name>`；或既有 `--root <path>` | 影响「从 cwd 向上查找哪个目录名」与 `--root <ws>` 时的补齐；与 `--root` **互斥** |
| 服务 | `serve init --root <绝对 ws> --graph-dir-name <name>`（或直接给完整绝对 `--root`） | 运行配置里**始终落完整绝对路径**；绝不从 `process.cwd()` 猜 |
| MCP / Web | 不暴露目录名参数（`root`/`graphRoot` 是保留参数） | 一律用服务启动时解析好的 graphRoot |
| 附件 / 记忆 / handoffs / 卡片 | 全部挂在 graphRoot 之下（`<root>/attachments`、`<root>/memory`、`<root>/HANDOFF.md`） | 自定义根下自然隔离，**不**回落默认根 |
| worktree 归属（sync / canonical root） | `core/root.ts` + `cli/sync.ts` 按**实际目录名**判定 | 见 B.3 |

### B.3 不破坏的既有性质（逐条有负向对照）

- **`.gitignore` 约定**：仓库 `.gitignore` 里 `/.dsh-graph/`、`**/.dsh-graph/`、`handoffs/` 是**本仓库自身**
  的约定，插件不改写用户仓库的 `.gitignore`。自定义名下把同一行改成对应目录名即可（如 `/board-a/`）；
  工具不会自动写 `.gitignore`（避免越权改用户的版本控制文件）。
- **worktree 归属判定**：`resolveCanonicalRoot` 仍按相对名做 linked-worktree 归一；`resolveWorkspaceForSync`
  现在按**实际目录名**比较（自定义名下同树接受、跨树仍拒绝、目录名与实际根不一致也拒绝）。
- **跨看板隔离 + 路径越界**：目录名只接受**工作区内规整相对名**。`../escape`、`a/../../b`、`/etc/passwd`、
  `C:/x`、`..`、`.`、`a//b`、`a/./b`、纯空白一律**拒绝**（fail-closed，不做静默归一化）；
  空串视为「未配置」回落默认名。
- **服务侧显式传入**：`resolveGraphRootExplicit` 是唯一解析点；相对 `--root` 依旧拒绝（不猜 cwd）。

### B.4 已验证 / 未验证

**已验证**（`core/tests/g632-write-mode-and-custom-root.test.ts` 15 用例 + 真实进程实装）：

- 默认关闭下工具表恰为 11 个只读工具，g-623 的 27 个写工具**逐个** `E_UNKNOWN_COMMAND` 且 graph 树快照不变；
- `allowWrite` 出现在根级 params / initialize / 工具 arguments 一律拒绝，且零副作用；
- 开启后写工具可达并真实落盘；actor 固定 `mcp:local-service`，伪 `human:owner` 被拒；
- g-623 名单 27 个名字的**每一个**都有归属断言（写白名单 / Human Gate / 未纳入账），漏登记即红；
  `graph_append_comment` 与 `graph_abandon_attempt` 均有开启态真实落盘用例（后者含权限/活跃态负向对照）；
- `graph_resolve_accept` / `transition→delivered` / `claim_supervisor` / `start_attempt` 写模式下仍 fail-closed，
  并有可读原因；正向对照 `transition→ready` 成功；
- `serve status` 可见 `allowWrite` + `writeMode` 说明；init/开启/关闭三次动作各留一条审计；
- 自定义名在 core / CLI / 服务三处一致生效；自定义根下只读查询读到**自定义根**（不回落默认根干扰看板）、
  附件落在自定义根；读/写两个方向的 `../` 穿越都被拒；
- 实装：真实 `goal-graph serve` 进程分别以「默认」「`--allow-write`」「`--no-allow-write`」启动，输出见
  交付报文的实装输出小节。

**未验证**（不宣称通过）：

- **真实 MCP 客户端**（Claude Code / Codex / OpenCode）在写模式下的互操作：本轮仍只验证 JSON-RPC 2.0 over HTTP
  直连，未与官方 SDK 实测；写工具的 `inputSchema`（`array` / `object` 形态）未在真实客户端上核验。
- **Windows 真机**：目录名校验的 Windows 盘符形态只做了单元级判别（`C:/x` 拒绝），未在 Windows 实机跑写模式。
- 浏览器 GUI 侧（写模式不影响 `/api/*`，故本轮不涉及 GUI 写入）。

# g-295 AGENTS.md 精简迁移方案与证据台账

> 本文件为 g-295 att-001 的前置冻结与方案设计交付物。仅提交方案与证据，不直接改写 AGENTS.md 终稿。

---

## 1. 冻结证据

| 指标 | 值 | 说明 |
|------|-----|------|
| 文件路径 | `AGENTS.md`（仓库根） | 基于 v0.11.1-test 基线 `1a3d9b6` |
| SHA-256 | `c6e59d53e78b7147cee775f026ecfde4e134a83c6f00d8b7220b7b567b4a739d` | sha256sum 原始输出 |
| 行数 | 348（wc -l）/ 349（含末行） | `wc -l` 不计无换行末行 |
| 字节数 | 23,513 | `wc -c`（字节，非字符） |

**冻结时间**：2026-09-15，由 att-001 在 `.worktrees/g-295-att-01` 中执行。
**基线 commit**：`1a3d9b6db5299d48218e388f52a29684b8f942fd`（v0.11.1-test HEAD）。

---

## 2. 章节分析与分类

### 2.1 完整段落清单

| # | 章节标题 | 行范围 | 字节估算 | 分类 | 理由 |
|---|----------|--------|----------|------|------|
| A | `## Generated File Policy` | 3–48 | ~2.2K | **常驻保留（精简）** | 源文件/生成物规则，每次开发必读 |
| B | `## Development Workflow` | 43–48 | ~0.4K | **合并入 A** | 与 Generated File Policy 高度重叠，4 条规则可合并 |
| C | `## Worktree Naming` | 50–63 | ~0.7K | **常驻保留** | 命名约定简短，每次建 worktree 必读 |
| D | `## Worktree Isolation by Change Risk` | 65–126 | ~3.5K | **常驻保留（决策矩阵精简）** | 核心隔离决策，但详细要求列表可精简 |
| E | `## Worktree 安全清理` | 128–136 | ~0.5K | **常驻保留** | 清理 5 步清单简短，防止误删 |
| F | `## Isolated Dev/Test dsh Instance (two profiles)` | 138–178 | ~2.3K | **迁移为按需** | 开发环境搭建详细操作，非每日必读 |
| G | `## 发布门禁（Release Gate）` — Windows 兼容性 | 180–237 | ~3.5K | **迁移为按需** | 发布前检查，非日常开发；g-292 管发布手册正文 |
| H | `## 发布门禁` — 版本号一致性 | 239–251 | ~0.8K | **迁移为按需** | 发布前检查项 |
| I | `## Important Notes` | 253–257 | ~0.3K | **删除** | 与 Generated File Policy 重复，无独立信息 |
| J | `## Harness Text-File Editing Notes` | 259–265 | ~0.8K | **常驻保留（精简）** | Harness 工具行为，每次 edit 前必读 |
| K | `## Security & Review Boundary (v0.8)` | 267–319 | ~3.2K | **常驻保留** | 安全边界、威胁模型、Review 范围——不可删减 |
| L | `## Subagent Architecture & Communication Guidelines` — §1 风险预警 | 321–325 | ~0.5K | **常驻保留** | 主管行为准则，简短 |
| M | `## Subagent Architecture` — §2 Persona vs Framework | 327–337 | ~0.8K | **常驻保留（精简）** | 框架纪律底线，但示例可精简 |
| N | `## Subagent Architecture` — §3 记忆分级决策铁律 | 339–349 | ~0.6K | **常驻保留** | scope 决策铁律，200 字符硬限，不可删减 |

### 2.2 分类汇总

**常驻保留（精简后仍占常驻上下文）**：A, C, D, E, J, K, L, M, N
- 约占原文件 ~60% 内容，但精简后预计降至 ~45-50%

**迁移为按需文档**：F, G, H
- 详细开发环境搭建（F）→ `docs/dev-instance-guide.md`
- 发布门禁 Windows 验证 + 版本号一致性（G+H）→ `docs/release-gate.md`（或合并到 g-292 的 `docs/release-handbook.md`）

**删除（冗余）**：I（Important Notes，与 A 重复）

---

## 3. 拟迁移段落清单（详细）

### 3.1 段落 F：Isolated Dev/Test dsh Instance

**原文行范围**：138–178（约 41 行）

**迁移目标**：`docs/dev-instance-guide.md`

**迁移内容**：
- Main web profile vs Test profile 的完整说明
- `scripts/dev-dsh-instance.sh` 的全部命令示例
- Development loop 的详细操作步骤（Node-side、Browser/kanban）
- Test instance isolation 说明

**AGENTS.md 中保留的导航**：
```markdown
## Isolated Dev/Test dsh Instance

开发与测试使用隔离的双 profile 体系。详见 [docs/dev-instance-guide.md](docs/dev-instance-guide.md)。

关键点：
- **Main profile** (`dsh --profile web`, port 3080)：使用已发布 npm 包
- **Test profile** (`dsh --profile dsh-graph-test`, port 3082)：使用本地 `link:` 绑定
- 由 `scripts/dev-dsh-instance.sh` 管理切换
```

### 3.2 段落 G+H：发布门禁

**原文行范围**：180–251（约 72 行）

**迁移目标**：`docs/release-gate.md`（或引用 g-292 的 `docs/release-handbook.md`）

**迁移内容**：
- Windows 兼容性验证的完整清单与脚本用法
- `scripts/win-smoke-test.mjs` 的 T1–T5 分层说明
- 产物传递纪律（tarball 流程）
- 版本号一致性检查清单

**AGENTS.md 中保留的导航**：
```markdown
## 发布门禁（Release Gate）

发布前必须完成 Windows 兼容性验证与版本号一致性检查。详见 [docs/release-gate.md](docs/release-gate.md)。

关键点：
- Windows 兼容性是**版本发布门禁**，不逐功能验证
- 执行件：`scripts/win-smoke-test.mjs`
- 版本号须在 `package.json`、`constants.js`、`README.md` 三处一致
- **g-292** 负责发布手册正文对齐
```

---

## 4. 证据回报字段映射

### 4.1 当前 AGENTS.md 的"每动作"表述

**原文**（AGENTS.md 无直接"每动作"表述，但 `index.js:512` 生成的 prompt 包含）：
> "汇报触发点：仅在【开始开工】、【阶段转变/转向新任务】、【遇到阻塞】、【本轮完成待命】4类有限关键节点调用 graph_report_status"

**当前 index.js 实际机制**（`dsh-graph-host/index.js:505-514`）：
- `formatAttemptDiscipline()` 生成状态汇报指令，嵌入 attempt prompt
- 汇报触发点已经是 4 类有限节点（非每动作）
- `graph_report_status` 调用 `core/ops.ts:reportStatus()`，写入 `attempt.md` 的 `status_line` 和 `status_state`
- `status_state` 枚举：`working | blocked | done | error`

### 4.2 映射方案：统一证据回报格式

将 AGENTS.md 中关于状态汇报的描述统一为以下格式：

```markdown
## 状态汇报（有限阶段触发）

汇报触发点（仅以下 4 类关键节点）：
1. **开始开工**：调用 `graph_report_status(state="working", status="开始...")`
2. **阶段转变**：任务类型变化或转向新子任务时更新
3. **遇到阻塞**：调用 `graph_transition(to="blocked")` + `graph_report_status(state="blocked")`
4. **本轮完成**：调用 `graph_transition(to="review")` + `graph_report_status(state="done")`

**证据回报字段**：
| 字段 | 说明 | 来源 |
|------|------|------|
| `status` | 一句话人话（≤20 字） | 子代理撰写 |
| `state` | 枚举：working/blocked/done/error | index.js 强制 |
| `status_state` | 同 state，写入 attempt.md | core/ops.ts |
| `status_line` | 同 status，写入 attempt.md | core/ops.ts |

**禁止**：
- 每个 read/bash 动作机械调用 graph_report_status
- 普通轻量操作追加汇报
- 自行迁移到 delivered（human gate）
```

### 4.3 与 g-289 隔离策略的边界

- **g-289 负责**：默认隔离策略（集成分支不干净时对 patch/chore/task 也默认建 worktree）的代码实现
- **g-295 负责**：AGENTS.md 中隔离决策**文档描述**的精简，不改变隔离策略本身
- **无冲突**：g-295 只改文档措辞和导航，不涉及 `defaultWorktreeForGoalType` 逻辑

### 4.4 与 g-292 发布手册正文的边界

- **g-292 负责**：`docs/release-handbook.md` 第 4 节发布树流程正文
- **g-295 负责**：AGENTS.md 中发布门禁段的导航指向（指向 release-gate.md 或 release-handbook.md）
- **不重复**：g-295 不写发布手册正文，只改 AGENTS.md 的导航链接

---

## 5. 三类代表任务加载映射

### 5.1 Feature Attempt Spawn

**场景**：supervisor 派发一个新的 feature attempt（如 g-295 本次）

| 内容 | 精简前（AGENTS.md 全量注入） | 精简后（常驻 + 按需） |
|------|------|------|
| Generated File Policy | ✅ 全量（~50 行） | ✅ 常驻精简版（~20 行） |
| Worktree Naming | ✅ 全量（~14 行） | ✅ 常驻（~14 行） |
| Worktree Isolation | ✅ 全量（~62 行） | ✅ 常驻决策矩阵（~25 行） |
| Dev/Test Instance | ✅ 全量（~41 行） | ❌ 不加载（按需：`docs/dev-instance-guide.md`） |
| Release Gate (Windows) | ✅ 全量（~72 行） | ❌ 不加载（按需：`docs/release-gate.md`） |
| Security Boundary | ✅ 全量（~53 行） | ✅ 常驻（~53 行） |
| Subagent Guidelines | ✅ 全量（~29 行） | ✅ 常驻精简版（~20 行） |
| Harness Editing Notes | ✅ 全量（~7 行） | ✅ 常驻精简版（~5 行） |

**加载量对比**：
- 精简前：~348 行 / ~23.5KB 全量注入 attempt prompt
- 精简后：常驻 ~190 行注入 + 按需文档仅在需要时 read

**结论**：feature attempt 不需要 Dev/Test Instance 和 Release Gate 的详细内容，精简后常驻注入量减少约 45%。

### 5.2 发布前检查（Pre-release Check）

**场景**：supervisor 执行版本发布前的 Windows 验证与版本号一致性检查

| 内容 | 精简前 | 精简后 |
|------|------|------|
| Generated File Policy | ✅ 全量 | ✅ 常驻精简版 |
| Release Gate (Windows) | ✅ 全量 | ✅ **按需加载** `docs/release-gate.md` |
| 版本号一致性 | ✅ 全量 | ✅ **按需加载** `docs/release-gate.md` |
| Dev/Test Instance | ✅ 全量 | ✅ **按需加载** `docs/dev-instance-guide.md` |
| Worktree Isolation | ✅ 全量 | ✅ 常驻决策矩阵 |
| Security Boundary | ✅ 全量 | ✅ 常驻 |

**加载量对比**：
- 精简前：~348 行全量（发布相关内容在中间，混杂其他规则）
- 精简后：常驻 ~190 行 + 按需加载 `release-gate.md`（~72 行）+ `dev-instance-guide.md`（~41 行，如需）

**结论**：发布前检查时按需加载发布相关内容，信息集中且完整，不被其他开发规则稀释。

### 5.3 Review 子代理

**场景**：supervisor 派发 review 子代理审查某个 attempt 的代码

| 内容 | 精简前 | 精简后 |
|------|------|------|
| Security & Review Boundary | ✅ 全量（~53 行） | ✅ 常驻（~53 行） |
| Generated File Policy | ✅ 全量 | ✅ 常驻精简版 |
| Worktree Isolation | ✅ 全量 | ✅ 常驻决策矩阵 |
| Release Gate | ✅ 全量 | ❌ 不加载 |
| Dev/Test Instance | ✅ 全量 | ❌ 不加载 |
| Subagent Guidelines | ✅ 全量 | ✅ 常驻精简版 |

**加载量对比**：
- 精简前：~348 行全量
- 精简后：常驻 ~190 行（Review 子代理只需安全边界 + 生成物规则 + 隔离策略）

**结论**：Review 子代理不需要发布门禁和开发环境搭建的详细内容，精简后 review prompt 更聚焦。

---

## 6. 快速通道复用边界

**明确复用对象**：AGENTS.md 中的「低风险小改动主管快速通道（Supervisor 直接执行）」段落（原文 112–126 行）。

**当前定义**：
- 适用边界：单个文件、一两行低风险修复、单个 build 脚本/小工具
- 排除：多文件修改、生成物、测试改动、有副作用、并发冲突风险
- 纪律：只授权 supervisor 直接在 `<version>-test` 上执行；不绕过人工 review/delivered gate

**g-295 的处理**：
- **保留该段落在常驻规范中**（不迁移为按需），因为这是 supervisor 每次决定隔离级别时必读的决策依据
- **不扩大也不缩小**其适用范围
- **不另造流程**：g-295 只调整 AGENTS.md 的文档结构，不引入新的快速通道变体

---

## 7. 职责矩阵

| 职责领域 | 负责目标 | g-295 的动作 |
|----------|----------|--------------|
| 隔离策略代码实现 | **g-289** | 不涉及（只改文档描述） |
| 隔离决策文档 | **g-295** | 精简 Worktree Isolation 段落 |
| 发布手册正文 | **g-292** | 不涉及（只改导航指向） |
| 发布门禁文档 | **g-295** | 迁移到 `docs/release-gate.md` + 导航 |
| AGENTS.md 常驻规范 | **g-295** | 精简、合并、迁移 |
| 状态汇报格式统一 | **g-295** | 统一证据回报字段映射 |

---

## 8. 实施建议（供负责人确认后执行）

### 8.1 AGENTS.md 精简后预期结构

```markdown
# Agent Guidelines for dsh-graph Repository

## Generated File Policy（精简合并版）
  - core/*.js 生成规则
  - client.js 生成规则
  - Verification 步骤
  - Development Workflow（合并）

## Worktree Naming（保留）

## Worktree Isolation by Change Risk（精简决策矩阵）
  - 核心原则（精简）
  - worktree = true（适用场景列表）
  - worktree = false（两类豁免）
  - 低风险小改动主管快速通道

## Worktree 安全清理（保留）

## Isolated Dev/Test dsh Instance（导航 + 关键点摘要）
  → 详见 docs/dev-instance-guide.md

## 发布门禁（导航 + 关键点摘要）
  → 详见 docs/release-gate.md
  → g-292 负责发布手册正文

## Harness Text-File Editing Notes（精简）

## Security & Review Boundary (v0.8)（保留全文）

## Subagent Architecture & Communication Guidelines
  - §1 风险预警（保留）
  - §2 Persona vs Framework（精简）
  - §3 记忆分级决策铁律（保留）
```

### 8.2 新建按需文档

| 文件 | 内容来源 | 预计行数 |
|------|----------|----------|
| `docs/dev-instance-guide.md` | AGENTS.md §F 原文 | ~45 行 |
| `docs/release-gate.md` | AGENTS.md §G+H 原文 | ~75 行 |

### 8.3 实施前提

1. **负责人确认本方案**：段落分类、迁移目标、导航格式
2. **精简后的 AGENTS.md 须经负责人整体通读确认后再合入**
3. **不以字符量作为唯一成功标准**：优先证明实际加载内容和安全边界完整

---

## 9. 验收对照（对应 acceptance_items）

| # | 验收项 | 本方案的覆盖 |
|---|--------|-------------|
| 1 | 冻结 AGENTS.md 全文哈希、行数/字符数及迁移段落清单并写入证据台账 | ✅ §1 冻结证据 + §2 段落清单 + §3 详细迁移列表 |
| 2 | 明确单一真源：关键节点证据回报取代每动作汇报，且与 g-289/g-292 无冲突 | ✅ §4 证据回报映射 + §4.3/§4.4 边界说明 |
| 3 | 提供 feature attempt spawn、发布前检查、review 子代理三类精简前后加载映射 | ✅ §5 三类代表任务加载映射 |
| 4 | 明确快速通道复用边界；AGENTS.md 终稿须负责人整体通读确认后再合入 | ✅ §6 快速通道 + §8.3 实施前提 |

---

*本文档由 g-295 att-001 生成，提交 supervisor 复核。*

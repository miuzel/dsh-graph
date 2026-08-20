# dsh-graph 核心层 Schema（草案 v0.1）

> 存储格式决策：叙事内容用 **Markdown + JSON frontmatter**，运行履历用 **JSONL**，
> 派生索引用 JSON。所有文件存于 workspace 的 `.dsh-graph/`，git 友好。
>
> 实现决定（dogfood 发现#3）：frontmatter 与 `*.yaml` 一律使用 **JSON（YAML 的子集）**，
> 引擎用标准库 `JSON.parse` 解析（R-01 零依赖约束下无 YAML 解析器）。
> 状态重建规则：`goal.created`→draft；`goal.planned` 在 draft 时→planning；
> `goal.transition`→details.to（details.to 非法状态值时忽略，发现#4/#6）。
> `goal.moved` 记录排期/位置移动（backlog ↔ goals ↔ versions），**不影响状态**。

## 1. 目录布局

```
.dsh-graph/
├── project.yaml              # 项目配置与自动化边界默认值
├── rules.md                  # 整体工作规则约束（§2.4）
├── backlog/                  # 暂存目标（未定形态），每目标一个 .md
│   └── <goal-slug>.md
├── goals/                    # 独立目标（不设版本直接执行，R-05）
│   └── <goal-slug>/
│       ├── goal.md
│       └── attempts/...
├── versions/
│   └── <version-slug>/
│       ├── version.md        # 版本定义、范围决策、集成测试决策、发布记录
│       └── goals/            # 本版本的目标文件（从 backlog/ 移入即排期）
│           └── <goal-slug>/
│               ├── goal.md
│               └── attempts/ # PK 或重做的各次尝试（§2.3）
│                   └── <attempt-id>/
│                       ├── attempt.md    # 执行者、沙盒、履历摘要
│                       └── delivery/     # 该 attempt 的独立交付目录
├── memory/
│   └── long-term/            # 长期记忆条目（§6.2），每条目一个 .md
│       └── <slug>.md
├── skills-index.yaml         # 已沉淀技能索引（§7）
├── events.jsonl              # 运行履历，append-only，全系统唯一真相源
└── index.json                # 派生缓存（看板查询加速），可从源文件重建，勿手改
```

约定：

- 目标的归属由**文件位置**决定（`backlog/` 暂存 vs `goals/` 独立 vs `versions/<v>/goals/`
  版本内），frontmatter 中的 `version` 字段为冗余便利字段，引擎负责保持二者一致；
  移动文件即改变归属，git 历史天然记录全部排期变迁；
- 所有 ID 全局唯一、稳定、不可复用；slug 人类可读，改名时 ID 不变；
- 引擎只写 frontmatter 的受管字段与受管小节（见各实体定义），其余区域人和 LLM 自由编辑。

## 2. 目标（goal.md）

```markdown
---
id: g-01J4X9K2M8            # 全局唯一，创建时生成，永不复用
title: 实现登录接口限流
status: collecting          # 状态机见 §7
blocked_reason: null        # status=blocked 时必填
created_at: 2025-08-20T10:00:00+08:00
created_by: human           # human | agent | supervisor
version: v0.3               # null 表示未入版本（backlog/ 或 goals/，由文件位置区分）；须与文件位置一致
scope:                      # 目标工作范围（脚本信任模型依据；验收脚本必须在此之外）
  - core/
depends_on:                 # 数据流依赖（§2.2），建边时引擎做环检测
  - goal: g-01J4W0AB3C
    consumes:               # 消费上游的哪些产出
      - delivery/api-spec.md
review:
  reviewer: ai              # human | ai
  prompt: null              # 自定义审核提示词（可覆盖项目默认）
pk:
  lanes: 1                  # >1 即并行 PK；默认 1
  sandbox: worktree         # worktree | directory | container
rules_snapshot: r-2025-08   # planning 时规则库版本快照，规则变更据此标记复核
skill_refs: []              # planning 引用的技能
---

## 目标描述
（创建时填写：做什么、范围、约束。自由文本。）

## 收集计划
<!-- planning 阶段 LLM 生成：要收集哪些信息、是否需要人工补充 -->
- [ ] 现有登录接口的认证链路代码位置
- [ ] 网关层是否已有全局限流可复用
- [x] ~~QPS 预期量级~~（人工补充：峰值约 200 QPS）

## 质量判据
<!-- 判据先于执行：in_progress 之前本节必须非空且已确认 -->
1. 超出限流阈值返回 429 与 Retry-After 头
2. 限流阈值可配置，不硬编码
3. [script] scripts/check_rate_limit.sh

## 证据台账
<!-- 受管小节：引擎维护；每条证据带来源、时间、freshness -->
| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
| ev-01 | 网关无现成限流组件 | code search | 2025-08-20T10:12 | fresh |

## 处置分支
<!-- 可覆盖项目默认的四条标准路由；留空即用默认 -->

## 依赖我的下游
<!-- 受管小节：引擎维护的反向索引，便于看板连线与交付通知 -->
```

**受管字段不变式（引擎校验）**：

- `status` 只能是 §7 状态机中的合法值，迁移只能沿有向边；
- 进入 `in_progress` 前：`质量判据` 小节非空、`rules_snapshot` 已记录、判据确认事件存在；
- 验收脚本（判据中的 `[script]` 项）路径必须落在 `scope` 之外，且在 planning 时由规划方
  编写冻结；执行期间脚本变更视同判据变更；
- `status: blocked` 时 `blocked_reason` 非空；
- `depends_on` 不得构成环（建边时检测）；
- `review.reviewer: human` 的目标，完成声明者与审核者不得为同一人（多人场景）。

## 2.5 上下文卡片（cards）

目标 Runner 的种子上下文，独立实体、看板可见。存放于目标目录下 `cards/<card-id>.md`：

```markdown
---
{
  "id": "card-01",
  "goal": "g-001",
  "title": "现有认证链路代码结构",
  "kind": "text",
  "status": "empty",
  "filled_by": null,
  "filled_at": null,
  "content_ref": null
}
---

（正文即卡片内容；kind 为 file/image 时正文为说明、content_ref 指向文件路径）
```

- `kind`：`text | file | image | data`；`status`：`empty | collecting | filled | reviewed`；
- `filled_by` 记录填充来源：`human:<name>` / `agent:<childId>` / `goal:<id>`（子目标交付回填）；
- 卡片创建时**只要求 title 与 kind**——查什么、怎么查在收集运行时填充，不预设；
- 目标 frontmatter 以 `context_cards: ["card-01", ...]` 有序引用，顺序即注入顺序；
- attempt 启动时把 `filled/reviewed` 卡片按序注入 runner 上下文，注入清单记入
  `attempt.started` 事件的 `details.injected_cards`；
- 相关命令：`add-card` / `fill-card` / `review-card`；相关事件：
  `card.created / card.collecting / card.filled / card.reviewed`；
- 收集运行（`collecting` 状态）是目标之外的独立工作：可以是人工、subagent 运行
  （允许人工多次干预/回答/review），或升级为子目标（交付物回填卡片）。

## 3. 尝试（attempts/<id>/attempt.md）

```markdown
---
id: att-01J4XA77Q1
goal: g-01J4X9K2M8
executor: agent:k3          # agent:<model> | human:<name> | external:<desc>
sandbox_path: .dsh-graph/.../attempts/att-01J4XA77Q1   # worktree 或目录
started_at: 2025-08-20T11:00:00+08:00
claimed_at: null            # 完成声明时间；声明即触发 review
status_line: null           # 执行中 agent 汇报的一句最新状态（卡片显示用；每次汇报追加 attempt.status_reported 事件，卡面只取最新）
result: pending             # pending | selected | merged | rejected | superseded
---

## 执行笔记
（执行者自由记录；短期记忆的载体之一）

## Review 记录
<!-- 受管小节：判据逐条核验结果；PK 时另附横向对比结论 -->
```

约定：

- 交付物写入该 attempt 的 `delivery/`，完成声明 = `claimed_at` 非空 + 交付物存在；
- `delivery/` 只进不出：打回重开产生**新 attempt**，旧 attempt 完整归档（PK 落选者与失败
  尝试都是长期记忆素材）；
- 单 lane 目标也使用同一结构（`lanes: 1` 即只有一个 attempt 目录），模型不特判。

## 4. 版本（version.md）

```markdown
---
id: v-01J4VZ88KX
name: v0.3
status: active              # planning | active | integrating | released
created_at: 2025-08-18T09:00:00+08:00
---

## 范围
<!-- supervisor 与负责人商定：本版本包含哪些目标、为何纳入/排除 -->
（目标清单为受管小节，引擎按 goals/ 目录维护）

## 集成测试决策
<!-- 安排或显式跳过；跳过必须给出理由（"没做"不是合法结论） -->

## 人工测试与测试数据
（人工测试入口说明、测试数据编制记录）

## 发布记录
<!-- 受管小节 -->
```

版本级复合结论不单独存储——由引擎按 `goals/` 内各目标 status 实时求值
（`depends_on_conclusions` 语义），结果写入 `index.json` 缓存。

## 5. 规则库（rules.md）

```markdown
---
version: r-2025-08          # 任何规则变更递增此版本号
---

## R-01 代码规范
- 层级：project
- 所有新代码必须通过 `pnpm lint`；禁止向 `legacy/` 新增代码。

## R-02 预算
- 层级：global
- 单目标 PK 不得超过 3 lanes。
```

- 每条规则有稳定 ID（`R-xx`）、层级（global / project / version）与正文；
- 目标 planning 时快照 `rules_snapshot`；规则版本前进后，引擎将在途且受影响的
  目标标记"判据需复核"，并写入履历。

## 6. 长期记忆（memory/long-term/<slug>.md）

```markdown
---
id: mem-01J4Y2C5D9
type: failure-pattern       # success-graph | failure-pattern | preference | skill-pointer
source_goal: g-01J4W0AB3C   # 必须携带来源，可审计
promoted_by: supervisor
promoted_at: 2025-08-20T15:00:00+08:00
status: active              # active | stale（证据过期/经验被证伪时标记，不删除）
---

## 内容
限流类目标的判据若只写"返回 429"，容易漏掉 Retry-After 头；review 时应检查……
```

提炼（promotion）由 supervisor 在目标交付时发起，自动化边界按 §5 配置；
检索在后续目标 planning / review 时按相关性注入，**只提高生成质量，不改变生命周期语义**。

## 7. 状态机与事件

### 7.1 目标状态机

```
draft → planning → collecting → ready → in_progress → review → delivered
  │        │           │          │          │          │
  └────────┴───────────┴──────────┴──────────┴──────────┴→ blocked（任意阶段可入，解除后回原态）
                                                     review → in_progress（打回，新 attempt）
                                                     review → delivered 同时派生新目标（部分实现/遗留问题）
```

### 7.2 版本状态机

```
planning → active → integrating → released
```

### 7.3 事件（events.jsonl，每行一个事件）

```jsonl
{"ts":"2025-08-20T10:00:00+08:00","actor":"human:miuzel","event":"goal.created","goal":"g-01J4X9K2M8","details":{"title":"实现登录接口限流"}}
{"ts":"2025-08-20T10:05:11+08:00","actor":"agent:k3","event":"goal.planned","goal":"g-01J4X9K2M8","details":{"criteria_count":3,"rules_snapshot":"r-2025-08"}}
{"ts":"2025-08-20T10:12:40+08:00","actor":"agent:k3","event":"evidence.added","goal":"g-01J4X9K2M8","details":{"evidence_id":"ev-01"}}
{"ts":"2025-08-20T11:00:00+08:00","actor":"agent:k3","event":"attempt.started","goal":"g-01J4X9K2M8","details":{"attempt":"att-01J4XA77Q1"}}
{"ts":"2025-08-20T12:30:00+08:00","actor":"human:miuzel","event":"completion.claimed","goal":"g-01J4X9K2M8","details":{"attempt":"att-01J4XA77Q1"}}
{"ts":"2025-08-20T12:45:00+08:00","actor":"reviewer:ai","event":"review.failed","goal":"g-01J4X9K2M8","details":{"attempt":"att-01J4XA77Q1","failed_criteria":[3]}}
```

事件类型全集（草案）：`project.initialized / rules.changed / version.created /
goal.created / goal.planned / criteria.confirmed / goal.transition /
dependency.added / evidence.added / goal.ready / attempt.started /
completion.claimed / review.passed / review.failed / pk.compared /
goal.delivered / goal.reworked / goal.blocked / goal.unblocked /
goal.spawned / goal.moved / card.created / card.collecting / card.filled / card.reviewed /
attempt.status_reported / version.scope_changed / version.integration_decided /
version.released / memory.promoted / skill.proposed /
skill.created`

原则：**任何状态迁移必须伴随事件**；events.jsonl 是唯一真相源，goal.md 的
frontmatter 状态可视为事件流的物化投影，允许从事件流重建。

## 8. 项目配置（project.yaml）

```yaml
name: my-project
defaults:
  review:
    reviewer: ai            # human | ai；单目标可覆盖
    prompt: null
  pk:
    lanes: 1
    sandbox: worktree
  disposition: {}           # 覆盖四条标准处置分支（§4）
supervisor:
  automation:               # 每个决策点独立配置（§5）
    scope_planning: human
    integration_decision: human
    rework: ai
    memory_promotion: ai
    skill_proposal: human
    release: human
```

## 9. 待决问题

1. 证据台账放 goal.md 表格 vs 独立 `evidence.jsonl` per goal——表格人读友好但引擎并发
   写要小心；倾向保留表格 + 事件流兜底。
2. `index.json` 的重建策略（每次事件后增量 vs 懒重建）。
3. PK 合并（merged）产物的存放位置：胜者 attempt 的 delivery 内新建 `merged/` 还是
   独立 attempt？倾向后者（合并也是一次执行）。

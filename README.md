# dsh-graph

把工作组织成**目标看板**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件 —— 基于图的目标管理（Graph-based Goal Management）。

<p align="center">
  <img src="docs/banner.webp" alt="dsh-graph —— Agent 工作的目标化管理" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/v/dsh-graph?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/dm/dsh-graph?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/miuzel/dsh-graph/blob/main/dsh-graph-host/package.json"><img src="https://img.shields.io/node/v/dsh-graph?style=flat-square" alt="node engine"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://img.shields.io/badge/awesome--dsh--plugin-listed-2f6feb?style=flat-square" alt="awesome-dsh-plugin listed"></a>
  <a href="https://github.com/miuzel/dsh-graph/blob/main/dsh-graph-host/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license MIT"></a>
  <a href="https://github.com/miuzel/dsh-graph/blob/main/dsh-graph-host/package.json"><img src="https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2%20%3C0.2.1--0-2f6feb?style=flat-square" alt="DSH host range"></a>
</p>

**当前版本 v0.19.7** —— npm 包名 `dsh-graph`，一个包同时提供面向 Agent 的 50 个 `graph_*` 工具（含 `/api/dsh-graph*` REST 端点）与内嵌 DSH Web 的二维泳道看板。

**最新亮点（v0.19.7）**

- **界面文案跟随宿主语言**：宿主切换语言时插件文案当场跟着变，不再需要重载；重启后也以宿主当前语言初始渲染。同时修掉「升级宿主后插件浏览器半边不激活」的冷启动问题。
- **Windows 上的文件系统操作不再踩坑**：目录形态的目标搬迁不再因为提前建了同名目录而被系统拒绝；看板内的相对路径按平台统一分隔符，归档 / 取消归档与路径校验不再报错或静默失效。真机门禁扩展为清单式全覆盖：每个与系统相关的调用点都登记在台账里，没登记就判红。
- **状态与记录不再可能对不上**：状态变更先记事件再落盘，中途失败不会留下「状态已改、记录没写」的中间态；取锁失败不再释放别人的锁，坏掉的锁能自行收敛而不是永久卡住；目标编号不会被删除后重新发出去；解绑只作用于被指定的那一次执行。
- **英文模式下不再夹带中文**：英文派发时，内置的模式片段、小节标题、空描述兜底材料都按语言渲染，界面与提示词里不再冒出中文。
- **「成功」不再可能是假的**：向会话投递内容、重新派发子代理等操作改为等待回执，没拿到回执就如实提示并给出复制兜底；仓库自带的整套测试也不再可能「看起来全绿」而实际漏跑文件、跳过用例或提前退出。

变更史见 [CHANGELOG.md](https://github.com/miuzel/dsh-graph/blob/main/CHANGELOG.md)；逐版本门禁结论见 [docs/release-checklist-v0.19.7.md](docs/release-checklist-v0.19.7.md)，平台门禁运行手册见 [docs/platform-gate.md](docs/platform-gate.md)。

## 平台状态

| 平台 | 本版状态 |
|------|----------|
| Linux / WSL2 | ✅ 已实测通过（本版全量测试 fail 0） |
| 原生 Windows | ⚠️ **v0.19.7 发布候选包尚未跑真机门禁（不得读出「已通过」）**；结论待回填至发布核对表（发布准备中，Windows 待回填）。**已实测的真实记录 —— 针对 0.19.x 产品代码，不是本次 RC**：2026-10-06 两次真机复验（win32/x64，Node v24.21.0，宿主 `0.2.0-rc.2`）`win-smoke` **通过 15 / 失败 0 / 告警 1**、**T3 看板文件系统生命周期 32/32 步**（g-427 形态 8 步，每步盘面断言）；最后一次复验包 `fix4`（**含客户端 bundle 改动**）产物指纹 sha256 `ff08d3cf…`，其产品代码与 v0.19.7 RC 相同（`9a96920..0ca63b6` 产品代码零 diff）。唯一告警 = `--tarball` 模式不含 `core/*.ts` ⇒ 台账对账改在仓库根完成（65 项 / 253 处命中、未登记 0），非缺陷。**v0.18.0 真机 T1–T5 全过却漏检 g-427，根因是覆盖面**（见下）；0.19.x 四处修复——g-425 冷启动、g-427 目录形态搬迁、g-429 相对路径分隔符族、**g-431 desktop 插件语言跟随**——**均已真机验证**（g-431 另经原生 desktop 手动复验：切语言当场跟随 + 重启保持新语言）。逐字报告见[平台门禁 §7.1/§7.2](docs/platform-gate.md) |
| macOS | ⚠️ **本次未执行真机门禁**（不得读出「已通过」）；本版验证结果见发布核对表（运行中，待回填）。最近一次真机结论见 [v0.16.0 清单](docs/release-checklist-v0.16.0.md) |

**Windows 真机门禁的覆盖面（g-428 起）**：执行件 [`scripts/win-smoke-test.mjs`](scripts/win-smoke-test.mjs) 不再只跑抽样 T1–T5，
而是三层**清单式全覆盖**（任一层不成立即判红）：① **台账层**——产品代码里每个 OS 相关调用点都在台账里登记，
并映射到具体冒烟步骤（`ws:`）或平台探针（`pg:`），否则需给出豁免理由，**未登记即判红**；
② **T3 32 步看板文件系统生命周期**——真跑安装包的 `core/ops.js`，覆盖建/移（目录形态 ↔ 扁平形态双向、
版本泳道）/归档/取消归档/暂缓/删除、目标自有卡与共享卡、附件 trash 往返、事务与标签锁及陈旧回收、
「预置非空目标 ⇒ 明确业务错误且重试收敛」，**每步都断言磁盘最终状态**（源已消失、目标完整、全板无重复、无锁残留）；
③ **`--mutation-check` 负向对照**——定向突变（还原 g-427 旧顺序 / 搬迁退化为复制）必须让对应检查**实拍变红**。
清单全文、12 项豁免理由与 v0.18.0 的漏检记录见 [平台门禁 §3.4](docs/platform-gate.md)。

Linux/WSL2 上这些检查**全绿也只证明脚本与判定力可用**（本地三入口 + 平台门禁已实跑），
**不能替代 Windows 真机结论**：真机结论只能由负责人在原生 Windows 上执行
`node scripts/win-smoke-test.mjs --tarball <tgz>` 取得，执行件会打印可直接整段粘贴的报告块（含 `覆盖=…` 一行），
回填位置见 [平台门禁 §7](docs/platform-gate.md)。

三平台共用同一安装包。已知限制：macOS 上**经显式传入且含符号链接**的工作区路径（如位于 `/tmp`、`/var` 之下）会被拒绝并报 `graph root symlink is not allowed`；由 `process.cwd()` 推导的路径不受影响。

## 安装

```sh
dsh plugin --profile <name> add dsh-graph
```

需要 Node ≥ 22。依赖说明、宿主兼容范围（`engines.dsh` 声明与实测宿主）、侧边栏用法、数据目录等完整内容，见 **[dsh-graph-host/README.md](dsh-graph-host/README.md)**（即 npm 包内 README）。升级宿主后若 Web 看板半边不激活（`web boot: … did not activate`），见该 README 的「[升级残留自检与清理](dsh-graph-host/README.md#升级残留自检与清理)」。

## 核心概念

- **基于图的目标管理**：目标是自足实体 —— 自然语言任务 + 动态生成的取证计划与质量判据；任务类型不预先模板化，结构化的是生命周期与求值语义。
- **四阶段生命周期**：`描述 → 收集 → 执行 → 确认`，由引擎强制的状态机：`draft → planning → collecting → ready → in_progress → review → delivered`（任意阶段可进入 `blocked`）。
- **判据先于执行**：进入执行前先登记质量判据，评审按逐条判据核验产出物。
- **上下文卡片**：目标 Runner 的种子上下文，生命周期 `empty → collecting → filled → reviewed`；形态分文本 / 文件 / 图片 / 数据。
- **排期**：Backlog（暂存池）↔ Version（批量质量管理）↔ 独立目标（standalone）；看板泳道顺序是展示态，可拖拽调整。
- **换会话交接**：`graph_handoff` 生成交接文档（board 投影 + 长期记忆 + 环境事实），`graph_claim_supervisor` 由新会话幂等接管。
- **目标间关系**：目标之间可标记「取代 / 调整 / 补充 / 相关」四类关系（`graph_set_relation`，可增可删）；关系只记在目标 frontmatter 这一处真源，看板卡片与目标弹窗直接可见。

## 提供的工具

50 个 `graph_*` 工具，按功能分组（逐个说明见 [dsh-graph-host/README.md](dsh-graph-host/README.md) 或 `graph_help`）：

| 分组 | 工具 |
|------|------|
| 目标生命周期 | `graph_create_goal` · `graph_rename_goal` · `graph_set_description` · `graph_set_goal_type` · `graph_set_goal_tags` · `graph_amend_goal` · `graph_transition` · `graph_postpone_goal` · `graph_archive_goal` · `graph_unarchive_goal` · `graph_delete_goal` · `graph_clean_worktree` · `graph_list_worktrees` |
| 目标关系 | `graph_set_relation` |
| 质量判据 | `graph_set_criteria` |
| 上下文卡片 | `graph_add_card` · `graph_fill_card` · `graph_review_card` · `graph_bind_collect_card` · `graph_delete_card` · `graph_convert_card_to_shared` · `graph_convert_card_to_owned` · `graph_attach_shared_card` · `graph_detach_shared_card` · `graph_list_shared_cards` |
| 附件 | `graph_store_attachment` · `graph_delete_attachment` |
| 排期 | `graph_move_goal` |
| 执行派发 | `graph_start_attempt` · `graph_set_directive` · `graph_record_attempt_handoff` · `graph_unbind_goal_child` · `graph_abandon_attempt` |
| 记忆 | `graph_memory_add` · `graph_memory_recall` · `graph_memory_remove` · `graph_memory_replace` |
| 配置管理 | `graph_get_settings` · `graph_update_settings` |
| 校验 / 对账 | `graph_validate` · `graph_rebuild` |
| 状态汇报 | `graph_report_status` · `graph_report_supervisor_status` |
| 评审裁决 | `graph_resolve_accept` |
| 历史讨论 | `graph_add_comment` |
| 完成摘要 | `graph_write_results` · `graph_refresh_results` |
| 换会话 | `graph_handoff` · `graph_claim_supervisor` |
| 帮助 | `graph_help` |

## 看板（浏览器客户端）

浏览器二维泳道看板：横向为生命周期阶段列（描述 / 收集 / 执行 / 确认 / 交付 / 阻塞），每个版本一条泳道，另有 Backlog 与独立目标区；支持拖拽排期、判据 / 上下文卡片抽屉、实时状态显示、阻塞折叠等。以下为虚构演示数据（nebula-notes）截图：

![看板总览](screenshot/screenshot-1.png)
![目标详情弹窗](screenshot/screenshot-2.png)
![侧边栏看板（窄档：阶段列纵向堆叠、工具条折叠为 `⋯ 工具`）](screenshot/sidebar-kanban.png)

## 侧边栏与数据目录

侧边栏入口、窄档（<480px）分档行为与「怎么把看板放进窄档」的实测说明，以及数据目录 `<workspace>/.dsh-graph`（纯文本 + 只追加 `events.jsonl`，git 友好、可 `graph_rebuild` 对账）的完整说明，均见 [dsh-graph-host/README.md](dsh-graph-host/README.md)。

## 仓库结构（monorepo）

- `core/` —— 核心层源码（唯一事实源），经 `scripts/sync-core.sh` 编译成 `dist/core/*.js` 进发布包；核心层不依赖 DSH。
- `dsh-graph-host/` —— 单包发布物源码：`index.js`（工具 + REST 端点）、`lib/client/*.js`（看板源模块，构建产物为 `dist/lib/client.js`）、`cordis.patch.yml`、`supervisor-guide.{zh,en}.md`、`README.md`、`LICENSE`。
- `schema/`、`docs/`、`scripts/` —— 数据 / 设计文档 / 构建脚本；一切构建产物落在 `dist/`（gitignored）。

## 开发

```sh
bash scripts/build.sh                 # 同步 core + 客户端产物 + 复制发布资产到 dist/
node --test core/tests/*.test.ts      # 全量测试
./node_modules/.bin/tsc --noEmit -p tsconfig.json
# 隔离测试实例（不碰主 GUI）：DSH_HOME 与 workspace 均在 ./tmp/dsh-test/ 下
bash scripts/dsh-test-web.sh <DSH版本> [--port PORT]
```

构建与实验一律在隔离 worktree（`.worktrees/<goal>-att-<NN>`）内进行；约定见 [AGENTS.md](AGENTS.md)，隔离实例参数与开发回路见 [docs/dev-instance-guide.md](docs/dev-instance-guide.md)。README 截图用 `scripts/dsh-graph-mock-seed.mjs` 生成虚构演示数据后复现。

## License

MIT（Copyright © 2026 miuzel）—— 见 [dsh-graph-host/LICENSE](dsh-graph-host/LICENSE)。

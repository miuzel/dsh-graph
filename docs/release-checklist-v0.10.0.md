# dsh-graph v0.10.0 发布检查清单

> 流程沿用 v0.9.2：supervisor 完成准备并推送 `main` + tag 后，由**负责人手动执行 `pnpm publish`**。
> 本文件同时承载 v0.10.0 的 Release Notes 与发布前/后检查项。

## 0. 宿主版本兼容性（本次发布强调项）

**✅ v0.10.0 已完整验证并支持 DeepSeek Harness `v0.1.5-rc.2`，并以其为推荐配套宿主版本。**

验证方式（均为实测，非声明）：

| 验证面 | 证据 |
|---|---|
| 隔离 Web 实例 | 演示实例 `./scripts/dsh-test-web.sh v0.1.5-rc.2 --port 3086`，插件经 `link:` 加载本地 `dsh-graph-host`，Web GUI + 看板正常渲染与交互 |
| 看板与客户端 | 版本泳道/阶段列/折叠区按需拉取、批量接受弹窗（分组/组级三态/缩进）、设置弹窗、worktree 区块中英双语实测通过 |
| 工具与 REST | 全部 `graph_*` 工具 + `/api/dsh-graph*` 端点在 `v0.1.5-rc.2` 实例上注册与调用正常（`/api/dsh-graph`、`/version-goals`、`/backlog-goals`、`/accept`、`/transition`、`/worktrees` 等） |
| 双语界面 | 中文与英文两套演示录制（`locale=zh/en`）均在 `v0.1.5-rc.2` 实例完成 |
| 兼容范围 | 兼容 `0.1.5` 系列与 `0.1.2-alpha.x` 及以上（工具/提示词契约向后兼容；`0.1.2-alpha.x` 为 v0.9.x 的验证基线） |

README 中的显式声明位置：`README.md`（顶部 + 安装小节）、`dsh-graph-host/README.md`（中文与英文「环境要求」小节）。

## 1. Release Notes（v0.10.0，14 个交付目标）

### 性能：看板首屏懒加载（g-258）

- 首屏只加载当前活跃版本与独立目标，backlog 与已交付版本**默认折叠、仅拉计数**；展开时按需拉取（`/api/dsh-graph/version-goals`、`/api/dsh-graph/backlog-goals`）；
- 主管真机实测（19 版本 / 133 已交付目标 / 17 backlog 的真实看板）：首屏载荷 **543,324 B → 70,532 B（-87.0%）**；展开/折叠无重复请求，折叠区首屏零明细。

### 角色契约与执行派发（g-253）

- 角色纪律文本单一真源（`ROLE_PROFILES.disciplineLines`）与 host/persona 口径统一，清除「每做一个动作」旧文案；
- 清理 `index.js` 死导入/死代码；executor 执行派发接入 `toolFilterForRole("executor", mode)`。

### 版本管理语义排序（g-264）

- 版本读取由字符串排序改为**语义版本比较**（`compareVersions`），泳道与版本抽屉统一「最新在前」；
- 异构/预发布标识（`-rc.1` / `nightly` / 非语义目录）稳定降级，空目录排于语义版本之后，不抛异常。

### 设置弹窗保存语义（g-259）

- 刷新间隔改为**POST 成功（`r.ok`）后**才写入 localStorage 并广播；校验失败/网络异常零本地副作用（真机故障注入实测：500 时 localStorage 保持不变 + 可见错误提示）。

### i18n 收尾（g-272、g-263）

- worktree 状态徽章接入 i18n（en：`OK` / `Locked` / `Removed`；zh 逐字不变）；
- 前端 client 模块硬编码中文收敛（26 处接入 dgT；保留项全部 `i18n-keep` 标注并由测试锚定）；
- **worktree 候选 `reason` 由中文句子改为稳定枚举**（22 个），客户端枚举→双语映射，`includes("外部删除")` 判断同步改枚举（行为不变）；
- npm 包 `description` 英文化。

### 看板批量接受（g-273）

- 「确认」列列头新增**批量接受**入口（计数联动、0 目标禁用）；
- 勾选式二次确认弹窗：**按版本分组**（组头版本+计数、**不含待接受目标的版本组不渲染**）、**每组全选/取消全选三态**、组内目标行缩进形成层级；
- 严格走既有 **非 force** `POST /api/dsh-graph/accept`（逐目标写 `review.requested`），**不跳过 Human Gate、不直写 delivered**；提交期间全锁定，部分失败继续其余并列出原因；
- 客户端把整批聚合为**一条**主管复核通知，避免 N 条刷屏。

### 媒体：中英双语功能演示视频（g-261、g-265~g-269、g-271）

- 中文成片 225.9s / 英文成片 216.0s（1920×1080、30fps、H.264 + AAC 48kHz），已分别发布于 B 站与 YouTube（英文版为不公开列出）；
- 制作工具链、脚本、字幕与证据归档于独立私有仓库 `dsh-graph-videos`（不随 npm 包与主仓库分发）。

## 2. 发布前检查项

- [x] `dsh-graph-host/package.json` 版本 `0.10.0-alpha` → **`0.10.0`**
- [x] 看板标题栏版本徽章：`dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` → `0.10.0`，并 `bash scripts/build-client.sh` 重建 `lib/client.js`（幂等）
- [x] `README.md`：版本号更新 + 顶部与安装小节显式声明 **支持 DSH `v0.1.5-rc.2`**
- [x] `dsh-graph-host/README.md`：中文与英文「环境要求」小节同步声明宿主兼容性
- [x] 全量测试 `node --test core/tests/*.test.ts` 全绿（**889/889**）
- [x] `dsh-graph-host/core/*.js` 与根 `core/*.ts` 一致（`bash scripts/sync-core.sh` 零 diff）
- [x] `dsh-graph-host/lib/client.js` 由 `scripts/build-client.sh` 重建且幂等（含 GENERATED 标记）
- [x] 工作区干净、`main` 只读未被触碰（全部改动先落 `v0.10.0-test`）
- [ ] `v0.10.0-test` 合并 → `main`，推送 `main` + annotated tag `v0.10.0`
- [ ] 负责人执行 `pnpm publish`（npm 官方 registry）
- [ ] 发布后核验：全新 profile 安装（`dsh plugin --profile <p> add dsh-graph`）→ 工具/看板/skill 注册正常

## 3. 发布后检查项

- [ ] 主 3080 profile 切回已发布版本（`bash scripts/dev-dsh-instance.sh main-published`）
- [ ] 开下一条开发线（`v0.11.0-test`，版本置 `0.11.0-alpha`）
- [ ] 按安全规则清理已合入的 attempt worktree/分支（g-272-att-002、g-273-att-001..004 等）
- [ ] 看板：v0.10.0 标记为 released；`dsh-graph-videos` README 补发布链接

## 4. 已知问题（不阻断本次发布）

1. **g-274（存量 flaky 测试）**：`g-187 cross-process CAS: concurrent same-base writes yield one conflict` 在高并发负载下偶发失败（3 并发 × 3 轮复现 1 次；单跑多次全绿），属时序敏感用例，已在 backlog 跟踪。
2. **g-273 判据 4 真机可见性 ◐**：批量接受的「整批一条主管通知」由单测覆盖（恰好一条 `session.prompt(..., "queue")`）；真机 demo fixture 的主管会话是不存在的演示 id，未能端到端观测。
3. **发布包体量**：包内含 `lib/client.js` 与编译后 `core/*.js`（无构建步骤即可运行），不含视频与演示数据。

# scripts/archived/ —— 历史脚本归档

**归档日期**：2026-09-21（负责人指示：`scripts/` 目录历史脚本与现行脚本混放，历史项归档）

本目录下的脚本**均为历史一次性工具**：

- **不被构建、测试或发布流程引用**——`pnpm build` / `pnpm test` / `pnpm prepack` / npm `prepare` 均只调用 `scripts/` 下的现行脚本，与本目录无关；
- **保留仅供追溯**——记录当时目标如何验收、当时迁移怎么做，不作为可复用工具维护；
- **内容一字未改**——归档仅做 `git mv` 位置迁移，未修改任何脚本内容（见下「已知限制」）。

> **现行脚本见 `scripts/`**（构建链 `build.sh` / `build-client.sh` / `sync-core.sh`、发布门禁 `win-smoke-test.mjs` / `win-smoke-test.cmd`、测试实例 `dsh-test-web.sh`、mock seed `dsh-graph-mock-seed.mjs`）。
>
> **`dev-dsh-instance.sh` 已被 `dsh-test-web.sh` 取代**，不要再使用旧脚本。

## A. 被取代（1 个）

| 脚本 | 用途 | 最后改动 |
|---|---|---|
| `dev-dsh-instance.sh` | 早期隔离开发实例管理：管 `web` + `dsh-graph-test` **双 profile**，子命令 `run/setup/main-published/main-dev/status/help`，隔离靠 `TEST_HOME`/`CWD` 环境变量 | 2026-09-20 |

**取代关系**：`dsh-test-web.sh <DSH版本> [--port PORT] [--proxychains] [--host HOST] [--host-dir PATH] [--skip-install]` 按 **DSH 版本**启动单实例、以 `DSH_HOME` 为隔离边界，并**拒绝透传受管参数**（`--profile`/`--dsh-home`/`--workspace`/`--patch` 等）。两者设计不同，不是同一工具的两个版本。

## B. per-goal 一次性验收脚本（14 个）

均为**已完成目标**的验收脚本，随目标交付一次性使用，目标关闭后不再有对象。

| 脚本 | 用途 | 最后改动 |
|---|---|---|
| `check_cards.sh` | 卡片能力验收 | 2026-08-20 |
| `check_g107.sh` | g-107 验收 | 2026-08-22 |
| `check_g108.sh` | g-108 验收 | 2026-08-22 |
| `check_g109.sh` | g-109 验收 | 2026-08-22 |
| `check_ga92e1406.sh` | g-a92e1406 验收 | 2026-08-22 |
| `check_kanban.sh` | 看板能力验收 | 2026-08-22 |
| `check_plugin.sh` | 插件装载验收 | 2026-08-22 |
| `check_g195.sh` | g-195 验收 | 2026-08-28 |
| `check_core.sh` | core 层回归验收 | 2026-09-04 |
| `check_g124.sh` | g-124 验收 | 2026-09-10 |
| `check_g125.sh` | g-125 验收 | 2026-09-10 |
| `check_g205.sh` | g-205 验收 | 2026-09-10 |
| `check_g206.sh` | g-206 验收（**基线即红**，见下） | 2026-09-10 |
| `check_g209.sh` | g-209 验收 | 2026-09-10 |

**`check_g206.sh` 特例**：该脚本**归档前就已经是红的**——它查找的威胁模型段落已迁至 `.dsh-graph/memory/long-term/review-boundary-local-dev.md:13`，脚本内的查找位置不再存在。这也是本次归档的动因之一（原登记的 g-334 已因此条「失去对象」被删除）。归档不修复此问题：它记录的是当时的验收方式。

## C. 一次性迁移 / 验证（3 个）

| 脚本 | 用途 | 最后改动 |
|---|---|---|
| `check-migration-fixtures.sh` | g-149 fixture 迁移测试 | 2026-08-24 |
| `migrate-dsh-graph-repo.sh` | g-149 / v0.6.1：`.dsh-graph` 从父仓库解耦为独立内层 Git 仓库（dry-run / `--apply` / `--rollback`） | 2026-08-24 |
| `g294-verify.cjs` | g-294 验证 | 2026-09-18 |

迁移与验证均为**一次性动作**，已完成且不可重放（当时的仓库形态已不存在）。

## D. 随本次归档一并判定（1 个）

| 脚本 | 用途 | 最后改动 |
|---|---|---|
| `test-dsh-test-web.sh` | `dsh-test-web.sh` 的离线 smoke（stub `pnpx`，断言 DSH_HOME 共享、按版本隔离、profile 复用、argv/cwd、非法参数拒绝） | 2026-09-03 |

**归档判定依据（实测）**：该测试已与现行 `dsh-test-web.sh` **接口不符**，实测为**红**：

- 未修改原样运行 → **exit 1**，首个失败断言：
  `argv[6] 不符：.../install-one-1（期望 link:.../dsh-graph-host，实际 link:.../dist）`
- 仅把测试内的 `HOST_LINK` 常量由 `link:$ROOT/dsh-graph-host` 改为 `link:$ROOT/dist`（第 58 行，被第 58/97/98/99/102 行共 5 处断言引用），其余不动 → **exit 0**，输出「离线 smoke 通过」。

**根因**：`dsh-test-web.sh` 在 commit `32f9c5e`（2026-09-21，*fix(build): correct exports target in dsh-graph-host and update dsh-test-web HOST_DIR to dist*）把插件链接目标默认值 `HOST_DIR` 从 `$REPO_ROOT/dsh-graph-host` 改为 `$REPO_ROOT/dist`；而 `test-dsh-test-web.sh` 最后改动停留在 `7ec71ae`（g-229），仍硬断言旧的 `dsh-graph-host` 链接目标。

**为何不改测试而是归档**：本次任务的范围是「只移动、不改脚本内容」。修正 `HOST_LINK` 属于**接口语义更新**、超出「为适配新目录而调整相对路径」的例外范围；且该测试不被任何构建/测试/发布流程或 CI 调用（全仓库零引用），留在 `scripts/` 只会是一颗常红的哑弹。若将来需要恢复该测试，改那一个常量即可（证据同上）。

## 已知限制：归档后相对路径的解析基准变了

本目录比 `scripts/` **深一层**，因此脚本内以自身位置推算仓库根的写法，其解析结果随之改变。这些脚本**按「内容不变」原则原样归档、不做修复**，仅在此记录实际影响，避免将来误用：

| 脚本 | 原写法 | 归档后解析为 | 影响 |
|---|---|---|---|
| `dev-dsh-instance.sh` | `REPO_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"` | `scripts/` 而非仓库根 | 仓库根推算错位 |
| `check_cards.sh` 等 12 个 `check_*.sh` | `cd "$(dirname "$0")/.."` | `scripts/` 而非仓库根 | 工作目录错位 |
| `check_g205.sh` | `GUIDE="${SCRIPT_DIR}/../dsh-graph-host/supervisor-guide.zh.md"` | `scripts/dsh-graph-host/...` | 文件路径不存在 |
| `check-migration-fixtures.sh` | `REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"` | `scripts/` 而非仓库根 | 仓库根推算错位 |
| `g294-verify.cjs` | `path.resolve(__dirname, '../tmp/g294-verify/...')` | `scripts/tmp/g294-verify/...` | 临时目录错位 |

`g294-verify.cjs` 另依赖已不存在的 `tmp/pw-browsers/**` Playwright 可执行文件，本就不具备直接可重跑性。

**结论**：本目录脚本视为**只读历史档案**。若确需重跑某一个，请先按上表修正其根路径推算（属一次性本地改动，不必回写本目录）。

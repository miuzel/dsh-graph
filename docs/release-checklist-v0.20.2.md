# dsh-graph v0.20.2 发布检查清单

> **本文件状态：发布准备 = 已完成（版本串转正三处 / `g352` 夹具复冻 / `CHANGELOG` 与守卫快照 / 发布正文真源 /
> 本清单 / 独立构建路径产物与对账 / H3 派发可用事实在 Linux 隔离实例跑通 / 自证闸门 全部落地）；
> 平台回填 = **已完成**（原生 Windows 的 Round A' / Round B / H3 三段由负责人真机执行，**结论已填齐**，见
> `docs/platform-gate.md` §7.10 / §7.11，**无一项由 agent 预填**）；
> 发布态动作：**已由负责人全部执行完毕** —— 合并 `main`（`912de67`）、annotated tag `v0.20.2`（重打后 `254d3ce`）、`git push`、`npm publish`、GitHub release `v0.20.2`
> 均已完成并**逐字对账通过**（详见 §8 与 §11 C：npm `shasum`/`fileCount`/`integrity` 三项与本地期望值相符 ⇒ **发布产物 ≡ 被测产物**）；
> **仅剩 `profile 安装 / 升级验证` 未执行**（§8 末）。**
>
> **平台真机结论（本版如实标注）：原生 Windows = 已实测通过**（候选包 `f39517c3…`：Round A' 静态复跑
> win-smoke `8/0/0` + platform-smoke `12/0/2`；Round B 完整 tarball 门禁 `通过15/失败0/告警1`、T3 生命周期 32/32；
> H3 三条派发路径真派发 ⇒ 矩阵 `H1–H6` **6/6**、win-smoke `9/0/0`、platform-smoke `13/0/2`；详见 §7.10 / §7.11）；
> **Linux / WSL2 = 已实测通过**（整套件自证闸门全绿 + 两道门禁静态层全绿 + H3 三条派发路径真派发事实已回传）；
> **原生 macOS = 本版未验证**；win32 上 `P1`（大小写不敏感卷）与 `P5`（无第二可写 FS）为**恒定 WARN**，
> P1 已由负责人裁决**记为已知限制、不改引擎**（§7.10）。
> ⇒ 两份 README 的平台状态表按 **「结论以台账为准」措辞**（**不写轮次计数与结论数字** —— 包内文件保持跨轮稳定；
> 三段回填全部只落在 `docs/` ⇒ **未触发第 4 轮产物**，§7「一轮闭环」核验成立）。
>
> 结构对照 [`docs/release-checklist-v0.20.1.md`](release-checklist-v0.20.1.md)。

**本次执行树**：发布准备 = worktree `.worktrees/g-476-att-01`，分支 `g-476-att-01`，基线 **`5950f03a9a28fa8439be52fe914dd037a2a1b2d0`**（= `v0.20.2-test` 顶点；其三提交 `c429717`（g-473）→ `dd42364`（g-475）→ `5950f03`（g-477））。

**发布源**：`v0.20.2-test` 分支（**发布时以 `git rev-parse v0.20.2-test` 为准**，不要照抄本行短 sha —— 本清单自身的补正提交也会推进该 tip）。发布时由负责人合入 `main`。

**纪律（准备阶段，逐条可核对）**：

- 全部构建 / 测试 / 打包**只在 worktree 内**完成；**未写主树 `dist/`** —— 主树 `git status --porcelain` = **0** 行，
  主树 `dist/` mtime 保持 **`2026-10-06 12:31:23`**（与 v0.20.1 准备轮记录值逐字相同 ⇒ 本轮未在主树构建）。
- worktree 的 `node_modules` 是指向主树的**符号链接**（只读复用）：全程**未执行任何 `pnpm` / `npx`**
  （`pnpm run` 在 pnpm ≥ 11 下会先做依赖检查、可能隐式触发 `prepare` = 完整构建并原子替换主树 `dist/`）。
  构建只用 `bash scripts/build.sh`，编译 / 检查只用 `./node_modules/.bin/*`；打包用 `npm pack`（`dist/package.json`
  无 `scripts` ⇒ 无生命周期脚本可跑），并把 `npm` 缓存放进 worktree 内 `tmp/`（系统 `~/.npm` 在本沙盒只读）。
- 全部产物、日志与证据落在 worktree 内 `tmp/` 或主树 `tmp/uat-v0202/`（均 gitignored，不入 git）；
  **打包后立即移除 `dist/*.tgz`**（实测 `find dist -name '*.tgz' | wc -l` = **0**，见 §5 与手册 g-470 条目）。

---

## 0. 相对上一版（v0.20.1）的变更（4 条用户可见）

1. **Windows 上派发不再因「工具名对不上」而起不来**：宿主提供哪套 shell 工具（`bash` / `pwsh`）由平台条件化的
   组合声明决定；旧版按固定名字预置白名单，组合里装的若是另一套，Windows 上评审 / 上下文收集 / 极简执行
   三条派发路径会直接起不来（工具调用报 `tools.restrict() names unknown`）。本版改为**按组合实际声明的工具名解析**，
   缺所需能力时给出可读诊断，不再让子代理无声失败。
2. **两平台门禁新增「组合与系统行为」探针层**：新增共享探针覆盖 shell 工具名解析、角色白名单求交、派发可用、
   路径大小写语义、换行与编码往返、命令引号与参数传递 —— 单一定义、Windows 执行件与跨平台执行件共用；
   组合声明一变就判红，缺真机事实时如实标注跳过，不冒充通过。
3. **注入式判定不再被真实系统带跑偏**：判「大小写敏感卷」时旧实现仍去问真实文件系统，在 Windows / macOS
   这类真实不敏感卷上会得出错误结论；本版让三种注入状态全部忠实、判定与真实卷解耦。同时修好 Windows 上
   组合声明的自动发现（旧实现调用 `npm` 不经 shell 必然失败），找不到时给出可复制的定位命令。
4. **配置与行为零变化**：宿主兼容声明范围、设置项与看板行为均未改动；从 v0.20.1 升级无需任何手工动作。

## 1. 目标与范围

| 目标 | 状态 | 说明 |
|---|---|---|
| `g-473` | `delivered`（已合入基线） | 角色工具白名单按组合探测到的 shell 名解析（`bash`/`pwsh`）+ 缺能力可读诊断 + 平台门禁补漏。提交 `c429717`。（类型 `bug`） |
| `g-475` | `review`（代码已合入基线） | 两平台门禁补「harness 组合 / OS 行为差异」风险面：H1–H6 共享探针（单一真源、两件执行件消费）。提交 `dd42364`。（类型 `task`） |
| `g-477` | `review`（代码已合入基线） | 大小写卷注入 seam 在真实不敏感卷上失效 + Windows 上 H1/H2 组合声明发现失效（两处 Windows Round A 真机修复）。提交 `5950f03`。（类型 `bug`） |
| `g-476` | 本清单（发布准备） | v0.20.2 发布准备与**一轮闭环**候选：版本串转正 / `g352` 复冻 / `CHANGELOG` + 守卫 / 发布正文真源 / 本清单 / 候选产物与对账 / `platform-gate` 回填位 / Windows 三段配方 + H3 Linux 实证。 |

## 2. 检查项

- [x] 版本串转正三处一致：`dsh-graph-host/package.json` version / `PLUGIN_VERSION` / 两份 README（中英）的版本表述，全部 = `0.20.2`（§3）
- [x] `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` **未动**（保持 `>=0.1.5-rc.2 <0.2.2-0`，§3）
- [x] README 平台状态表改为**跨轮稳定措辞**：Windows 行**按「结论以台账为准」+ 宿主代际陈述**（**不预称任何轮次结果**、不写结论数字）、macOS 行「**本版未验证**」；三处「最新亮点 / What's new」随本版更新为 `v0.20.2`（§7）
- [x] `CHANGELOG.md` 新增 `## v0.20.2 — 2026-10-10` 节（**4 条**、用户语言、无过程痕迹：不含 `g-XXX` / 门禁数字 / 探针编号 / 指纹 / 测试计数 / typecheck 结论）；`g371` 快照同步新增 `{ version: "v0.20.2", bullets: 4 }`（§6）
- [x] `CHANGELOG.md` 首部「逐版本门禁结论」链接改指 `docs/release-checklist-v0.20.2.md`（§6）
- [x] 发布正文真源 `docs/release-notes-v0.20.2.md` 入库（结构同 v0.20.1 模板：要点 + 安装/升级 + 验证与产物，§6）
- [x] `g352` 冻结签名 fixture 按维护者通道复冻：**仅** `source-commit` / `source-sha256` 变化（hunk `2,3c2,3`），正文与 `content-sha256` 逐字节未变（§6）
- [x] `docs/platform-gate.md`：**§7.10（Round A' 回填位）保持未预填**；新建 **§7.11** 作为本版 Round B 与 H3 的回填位（§7）；**(回填后) §7.10 / §7.11 均由负责人真机实测数据填齐**（§7）
- [x] Windows 三段执行配方 `tmp/uat-v0202/WINDOWS-GATE-RECIPE.md`（Round A' 静态复跑 / Round B 完整 tarball 门禁 / H3 三派发事实采集）落地，含两条一手互操作事实与「组合声明发现是加法式的」判读要点（tmp/，不入 git）；**(执行后修正)** 树包须含 `node_modules/yaml`（解在仓库内=假绿）、`platform-smoke` 在 win32 的期望为 `13/0/2`、Windows 侧不用裸 `dsh` 名字/不把带 `--flag` 的命令包进 PowerShell 函数
- [x] **H3 派发可用在 Linux 隔离实例上跑通**：隔离实例装候选 `dist`（`link:`）→ 真派发 `collector` / `executor-minimal` / `reviewer` 三条路径 → 真 `child_id` 收成事实文件 → 两道门禁消费后 `H3=PASS`；磁盘侧独立核对命中（§4；证据 `tmp/uat-v0202/h3-linux-evidence.md`）
- [x] 本清单建立：状态 / 执行树 / 版本一致性 / 三维度兼容口径 / 独立构建路径产物对账 / 闸门 / 平台诚实性 / 待负责人执行（全文）
- [x] 产物在隔离 worktree 内构建并打包：记录文件名 + 字节数 + sha256 + sha1 + **43 成员** + `docs/` 成员 0 + 包版本 `0.20.2`；**重建重打与本产物 `cmp` 逐字节一致**；打包后移除 `dist/*.tgz`（§5）
- [x] 自证闸门全绿：`node scripts/run-tests.mjs`（2411/2411）+ `tsc --noEmit`（0 错）+ `node --check dist/lib/client.js`（§6）；三段真机回填后于 tip 复跑同样全绿
- [x] **原生 Windows 真机门禁 Round A'（静态复跑：复验 H1/H2/H4 修复）** —— **已执行 · PASS**：win-smoke `8/0/0`、platform-smoke `12/0/2`、矩阵 `H1..H6 = PASS/PASS/SKIP/PASS/PASS/PASS`（H4 在真实 NTFS 上由 FAIL 反转）；结论见 `docs/platform-gate.md` **§7.10**
- [x] **原生 Windows 真机门禁 Round B（完整 tarball 门禁 T1–T5，宿主 `0.2.1-alpha.2`）** —— **已执行 · PASS**：`结果=PASS 通过15/失败0/告警1`（T3 生命周期 32/32；唯一告警=包内无 `core/*.ts` 故台账不对账，设计内）；附测旧代际 `0.2.0-rc.2` 同样 `15/0/1`；产物指纹 `f39517c3…` 双向对账一致；结论见 §7.11
- [x] **原生 Windows H3（三条派发路径真派发事实）** —— **已执行 · PASS**：三条路径各得非空 `child_id`（`964dd21c…` / `218156f3…` / `391377c4…`）、`errors` 全空、磁盘实体独立佐证；两道门禁消费后 `H3=PASS`（win-smoke `9/0/0`、platform-smoke `13/0/2`）；结论见 §7.11 的 H3 段
- [ ] **原生 macOS 真机门禁** —— **本版未执行**（§7）
- [x] 合并 `main` / 打 annotated tag —— **已执行（本地；合并提交 `912de67`，tag 重打后指向发布态收尾提交）**；`push` / `npm publish` / GitHub release / profile 安装升级 —— **待负责人执行**（§8，含可复制交接单见 §10）

## 3. 版本号一致性（红线 2）逐处证据

红线 2 的来源是 0.11.0 教训：`PLUGIN_VERSION` 常量**不参与构建校验**，版本串漂移只有人工核对才查得出。

| 落点 | 文件:行 | 实际值 |
|---|---|---|
| 包清单（真源） | `dsh-graph-host/package.json:3` | `"version": "0.20.2",` |
| 客户端常量（源） | `dsh-graph-host/lib/client/constants.js:12` | `const PLUGIN_VERSION = "0.20.2";` |
| 客户端常量（构建产物） | `dist/lib/client.js:2457`（**打包时那棵树**，见 §5 作用域注） | `const PLUGIN_VERSION = "0.20.2";` |
| 构建产物包清单 | `dist/package.json:3`（**打包时那棵树**） | `"version": "0.20.2",`（`scripts` = `null`） |
| 根 `package.json` | `package.json:3` | `"private": true`，**无 `version` 字段（未动，符合预期）** |
| README（根，中）当前版本 | `README.md:18` | `**当前版本 v0.20.2**` |
| README（根，中）最新亮点 | `README.md:20` | `**最新亮点（v0.20.2）**` |
| README（包内，中）当前版本 | `dsh-graph-host/README.md:43` | `**当前版本**：v0.20.2（…开发线沿用的版本串为 \`0.20.1\`）` |
| README（包内，中）最新亮点 | `dsh-graph-host/README.md:57` | `**最新亮点（v0.20.2）**` |
| README（包内，英）Current version | `dsh-graph-host/README.md:285` | `**Current version**: v0.20.2 …` |
| README（包内，英）What's new | `dsh-graph-host/README.md:299` | `**What's new (v0.20.2)**` |
| CHANGELOG 本版节 | `CHANGELOG.md:10` | `## v0.20.2 — 2026-10-10` |
| CHANGELOG 守卫快照 | `core/tests/g371-changelog-guard.test.ts:39` | `{ version: "v0.20.2", bullets: 4 },` |
| tarball 内包清单 | `package/package.json:3`（`dsh-graph-0.20.2.tgz`） | `"version": "0.20.2",` |
| tarball 内客户端常量 | `package/lib/client.js:2457`（`dsh-graph-0.20.2.tgz`） | `const PLUGIN_VERSION = "0.20.2";` |

> 上表后两行是**产物内**实测（`tar xzOf … | grep -n`），不是源码推断 —— 即「三处一致」在**发布的包里**也成立。

**`engines.dsh` / `peerDependencies` 未动（本版有意保持）**：

| 落点 | 文件:行 | 值 |
|---|---|---|
| `engines.dsh`（供 dsh-market 等宿主感知型市场读取） | `dsh-graph-host/package.json:30` | `>=0.1.5-rc.2 <0.2.2-0` |
| `peerDependencies["@deepseek-ai/dsh-settings"]`（**宿主门禁唯一真源**） | `dsh-graph-host/package.json:35` | `>=0.1.5-rc.2 <0.2.2-0` |

⇒ 本版只改「派发工具名解析 / 门禁探针 / 注入判定」，**不动声明面**（改声明面会改变安装门禁语义，超出补丁范围）。

**开发线版本串留痕（说明性，保留）**：`dsh-graph-host/README.md:43` / `:285` 的措辞把 `0.20.1` 标为**开发线沿用的版本串**
（v0.20.2 是把 `0.20.1` 转正为 `0.20.2` 之后的发布准备产物）—— 这是历史标注，不是「当前版本」声明。

## 4. 宿主兼容与「派发可用」维度（本版核心）

宿主兼容判定沿用 v0.20.1 起的**三维度**口径：**安装 / 启动 / 派发可用**，缺一不得判定兼容。

- **安装 / 启动**由 T1–T5（`scripts/win-smoke-test.mjs`）覆盖 —— 但 T1–T5 **不含派发维度**（v0.20.1 的 T1–T5 全绿
  仍漏掉了本版修的这类问题）⇒ 本版把「派发可用」做成**可回传的探针 H3**，而不是靠结论话术带过。
- **H3 的事实通道**：`--h3-dispatch-json <facts.json>`（等价 `DSH_GATE_H3_DISPATCH_JSON`），
  事实形状 `{ "attempted": true, "roles": [ { "role": "collector|executor-minimal|reviewer", "mode": …, "childId": …, "errors": [] } ] }`；
  **未回传事实**时 H3 逐字打印 `SKIP(需真机/实例)`（不冒充通过）；回传后按「三条路径均有非空 `childId`
  且 `errors` 未命中失败签名（`tools.restrict() … names unknown` / 子代理启动失败 / 兼容层缺接口）」判定 PASS/FAIL。
- **Linux 隔离实例侧已实证**（本版发布准备轮，见 `tmp/uat-v0202/h3-linux-evidence.md`）：
  1. 实例：`bash scripts/dsh-test-web.sh 0.2.1-alpha.2 --port 3092 --host-dir <worktree>/dist`
     （插件 `link:` 指向**候选** `dist`；`DSH_HOME` = `tmp/dsh-test/0.2.1/home`，workspace 隔离）；
  2. 主管会话：在实例 GUI 内新建会话并 `graph_claim_supervisor` 接管（REST 派发要求 `parentAgent` 非空 —— 这也是 Windows 侧唯一的人工一步）；
  3. 采集：`node tmp/uat-v0202/h3-collect-facts.mjs --base http://127.0.0.1:3092 --workspace <隔离 workspace> --out <facts.json>`
     —— 走产品 REST 端点 `/api/dsh-graph/start-collection`、`/start-execution`（`mode=minimal`）、`/start-review`；
  4. **两轮独立采集**各得三条真 `child_id`（`collector` `0130c587…` / `b82a58be…`、`executor-minimal` `aaa63717…` / `2985c648…`、
     `reviewer` `69057991…` / `bb76ee09…`）；
  5. **磁盘侧独立核对**：同一 `child_id` 出现在隔离实例自己的 `goals/g-00N/cards/*.md`（collector）、
     `goals/g-005|007/attempts/att-001/attempt.md`（executor）、`goals/g-005|007/reviews/rev-att-001-01.md`（reviewer）
     ⇒ 派发确实发生，不是响应字段自报；
  6. 门禁消费后：`win-smoke --static-only . --h3-dispatch-json <facts>` ⇒ `H3=PASS`、**通过 9 / 失败 0 / 告警 0**；
     `platform-smoke --static-only . --h3-dispatch-json <facts>` ⇒ `H3=PASS`、**通过 15 / 失败 0 / 告警 0**。
- **Windows 侧 H3 = 已由负责人真机回传并判 PASS**（`docs/platform-gate.md` §7.11 的 H3 段）：
  三条路径真派发得非空 `child_id`（`reviewer` `964dd21c…` / `collector` `218156f3…` / `executor-minimal` `391377c4…`），
  `errors` 全空，且同一实例磁盘上 `goals/g-003/cards/card-932963c4.md`、`goals/g-004/attempts/att-001/attempt.md`、
  `goals/g-004/reviews/rev-att-001-01.md` 真实存在（与 Linux 轮同口径的磁盘侧独立核对）；
  两道门禁消费后 `win-smoke --static-only . --h3-dispatch-json <facts>` ⇒ `H3=PASS`、**通过 9 / 失败 0 / 告警 0**；
  `platform-smoke …` ⇒ `H3=PASS`、**通过 13 / 失败 0 / 告警 2**（`P1`/`P5` 为 win32 恒定 WARN，与 H3 无关）。
  配方见 `tmp/uat-v0202/WINDOWS-GATE-RECIPE.md` §段 3（含 `--init-git-if-needed`：reviewer 路径要求候选 commit
  可 `git rev-parse`，非 git workspace 时只建一个仅含标记文件的 scratch 仓库）。
  ⚠️ 回传文件在中文 Windows 控制台可能显示乱码（`Get-Content` 默认 ANSI 解码 UTF-8 文件）—— 属取证显示层，
  非产品缺陷（同实例上 H5 编码往返探针 PASS）；复核用 `Get-Content -Encoding utf8`。

## 5. 发布产物与独立构建路径对账

| 项 | 值 |
|---|---|
| 文件名 | `dsh-graph-0.20.2.tgz` |
| 本地绝对路径 | `tmp/uat-v0202/dsh-graph-0.20.2.tgz`（仓库主树，gitignored，不入 git；由 worktree `.worktrees/g-476-att-01` 内 `bash scripts/build.sh` + `dist/` 内 `npm pack` 后另存） |
| 字节数 | **1,444,792** |
| sha256 | `f39517c3aa0470e3aa60d9541a06842f4633523f024fd697b456e68aed0e0703` |
| sha1 | `059fae1b6393a1d5c5c35442d10e8a24406e5683` |
| 成员数 | **43** |
| `docs/` 成员数 | **0**（`docs/` 不随包发布；`CHANGELOG.md` 亦不在包内） |
| 包内 `package.json` version | `0.20.2` |
| 包内 `lib/client.js` `PLUGIN_VERSION` | `0.20.2`（第 2457 行） |
| 包内 `README.md` == 提交源码 `dsh-graph-host/README.md` | **逐字节相同**，双方 sha256 `a2064bd761840158c37426a5f55977f8e29b0e873c41e29b6e754668e001eda5` |
| 包内成员顶层集合 | `cordis.patch.yml` / `core` / `diagrams` / `index.js` / `lib` / `LICENSE` / `package.json` / `prompts` / `README.md` / `supervisor-guide.en.md` / `supervisor-guide.zh.md` |
| 重打包对账 | 同一构建树内**重建 + 重打**，与本产物 `cmp` **逐字节一致**（同一 sha256 `f39517c3…`） |
| 校验和文件 | `tmp/uat-v0202/SHA256SUMS`（`sha256sum` 格式，随 release 附件上传） |
| 构建树 `dist/` 树 hash | `37576f858ca29cd8`（**指打包时那棵树** = worktree `.worktrees/g-476-att-01/dist`；口径：`find dist -type f -print0 \| sort -z \| xargs -0 sha256sum \| sha256sum \| cut -c1-16`） |

> ⚠️ **`dist/` 的作用域（复核时最容易踩的一条）**：`dist/` **不被 Git 跟踪**，因此「哪个树里的 `dist/`」决定它显示什么版本。
> 本清单 §3 / §5 中一切 `dist/...` 行号与树 hash 都指**打包时那棵树**（worktree `.worktrees/g-476-att-01`，`PLUGIN_VERSION = "0.20.2"`）。
> **主树（仓库根）的 `dist/` 是旧构建**（`PLUGIN_VERSION = "0.19.7"`，mtime `2026-10-06 12:31:23`），且**刻意未动** —— 它是运行中宿主的资产来源，
> 按 `AGENTS.md`「构建隔离」纪律不在主树构建；因此**在主树直接读 `dist/lib/client.js` 会读到 0.19.7，这不是版本漂移，也不是缺陷**。
> 合并 `main` 后主树源码已是 0.20.2、`dist/` 仍为旧构建属**预期状态**；若要让主树 GUI 跑 0.20.2，需在选定时刻单独构建（**发布后动作，非发布前置**）。

**构建 / 打包过程的两条实测纪律（沿用手册 g-470 条目）**：

- `npm pack` **会就地生成 `dist/dsh-graph-0.20.2.tgz`** ⇒ 本次每次打包后都立即移出到 `tmp/`，
  `find dist -name '*.tgz' | wc -l` 实测 **0**；`dist/` 必须干净后再跑闸门、再打包。
- 本沙盒 `~/.npm` 只读 ⇒ `npm pack` 必须 `npm_config_cache=<worktree>/tmp/npm-cache`，否则报 `EROFS`。

**跨树可复现性**：本版在**同一构建树内**的重建重打已逐字节一致（上表）；tag 树一侧已按**零构建论证**闭合
（tag 树 == 发布线 tip 树，且自打包点以来非 `docs/` 改动 = 0 文件 ⇒ 包相关输入逐字节相同），明细见 §8「发布源树对账」。
如需**字面复现**，可在 tag 树的隔离 worktree 内重建重打后与上表比对（可选；**不得在主树构建**）。

## 6. 夹具复冻 / CHANGELOG 与守卫 / 发布正文 / 测试与静态检查

**`g352` 冻结签名 fixture 复冻（`constants.js` 命中 `source-files` 覆盖面 ⇒ 必冻）**：

| 步骤 | 命令 / 比对 | 结论 |
|---|---|---|
| ① 手工前置首行 note | 在既有 note 前插入本轮记录（`# ` 行不参与 hash） | 保留完整历史链（g-476 → g-471 → g-469 → v0.20.0 → g-462 → g-461 → g-456） |
| ② 导出到临时路径 | `G352_SIG_DUMP=<tmp> node --test --test-name-pattern="会话内看板页签签名" core/tests/g352-narrow-width.test.ts` | 1 / 1 pass，导出成功 |
| ③ 与基线比对 | `diff`（基线 = `git show HEAD:core/tests/fixtures/g352-conv-signature.txt`） | 除首行 note 外**恰 1 个 hunk `2,3c2,3`**；`source-files` / `content-sha256` / `board-width` 与正文 **0 行差异** |
| ④ `G352_SIG_ACK=1` 写回 | 覆盖后 `cmp` 与 dump **逐字节相同** | `source-commit` → `5950f03a…`（本目标基线）；`source-sha256` `ba533c85…` → `1a9cdf6d…`；`content-sha256` `0e6b7094deafa61e0525d617f792a8da30b9aeba1a3c72cb221ee4061f783ed3` **未变** |

**`CHANGELOG` 与守卫**：`CHANGELOG.md:10` 新增 `## v0.20.2 — 2026-10-10`（**4 条**、用户语言）；
`g371` 快照在 `EXPECTED_SECTIONS` **顶部**新增 `{ version: "v0.20.2", bullets: 4 }`，**未**放宽
`MAX_BULLETS_PER_SECTION`（= 5）或任何既有断言；守卫负向对照（删整节 / 删一条 / 乱序 / 去日期 / 超上限 /
混入审计数字）保持原样必红。

**发布正文真源**：`docs/release-notes-v0.20.2.md`，必需小节齐备（手册 §4.1）：
`## v0.20.2 — 2026-10-10` + 要点（与 CHANGELOG 同文，4 条）+ `### 安装 / 升级` + `### 验证与产物`
（含平台门禁如实标注 / 派发可用维度与 H3 / 产物 sha256 + sha1 + 成员数 / 一轮闭环说明 / 发布记录链接）。

**测试与静态检查（worktree `.worktrees/g-476-att-01` 内，打包后已移除 `dist/*.tgz`）**：

| 项 | 命令 | 结果 |
|---|---|---|
| 整套件自证闸门 | `node scripts/run-tests.mjs` | **tests=2411 / pass=2411 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0** |
| CHANGELOG 守卫（含负向对照） | `node --test core/tests/g371-changelog-guard.test.ts` | **3 / 3 pass，fail 0** |
| 冻结签名 fixture 套件 | `node --test core/tests/g352-narrow-width.test.ts` | **63 / 63 pass，fail 0** |
| dist 新鲜度（纯只读） | `node --test core/tests/dist-freshness-g312.test.ts` | **fail 0**（打包后 `dist/` 无 `.tgz`、与源码同步） |
| 类型检查 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0**（零错） |
| 产物语法 | `node --check dist/lib/client.js` | **exit 0** |
| 门禁自检（静态） | `node scripts/win-smoke-test.mjs --self-test` | **全通过**（H 清单审计 + H 消费审计 + 变体必红 + 矩阵行） |
| Windows 执行件（静态层） | `node scripts/win-smoke-test.mjs --static-only .` | **Linux：通过 8 / 失败 0 / 告警 0**（`H3=SKIP(需真机/实例)`）；**原生 Windows Round A'：通过 8 / 失败 0 / 告警 0**；回传 H3 事实后（Linux 与 Windows **均为通过 9 / 失败 0 / 告警 0**、`H3=PASS`、矩阵 `H1–H6` 6/6） |
| 跨平台执行件（静态层） | `node scripts/platform-smoke-test.mjs --static-only .` | **Linux：通过 14 / 失败 0 / 告警 0**（`P1–P6` 全 PASS、`M4` PASS、`H3=SKIP`）→ 回传 H3 事实后 **通过 15 / 失败 0 / 告警 0**；**原生 Windows（Round A'）：通过 12 / 失败 0 / 告警 2** → 回传 H3 事实后 **通过 13 / 失败 0 / 告警 2**（`P1`/`P5` 为 win32 恒定 WARN；两平台数字不同属预期，不是回归） |

**一次过程留痕（如实）**：本 attempt 首轮跑自证闸门时出现 2 条失败，均来自**同一时点**的
「源码已改 0.20.2、`dist/` 还是 0.20.1」新鲜度检查（`g353` / `g312` 的负向对照项）——即我自己的编辑与
首轮闸门并发所致，**不是候选人缺陷**；重建 `dist/` 后同一套件即 2411/2411 全绿（上表）。

## 7. 平台门禁（**如实标注**）

| 平台 | 本版（`v0.20.2`）状态 | README 落点 |
|---|---|---|
| Linux / WSL2 | ✅ 已实测通过（本版整套件自证闸门 2411/2411 `fail=0`；两道门禁静态层全绿；H3 三条派发路径真派发事实已回传并判 PASS） | 两份 README 平台表首行 |
| 原生 Windows（红线 1） | ✅ **已实测通过**（负责人真机，2026-10-10，针对候选包 sha256 `f39517c3…`）：**Round A'** 静态复跑 win-smoke `8/0/0` + platform-smoke `12/0/2`、矩阵 `H1/H2/H4/H5/H6=PASS`（`H4` 在真实 NTFS 上由 FAIL 反转）；**Round B** 完整 tarball 门禁 `通过15/失败0/告警1`、T3 生命周期 `32/32`（附测旧代际宿主 `0.2.0-rc.2` 同样 `15/0/1`）；**H3** 三条派发路径真派发（非空 `child_id` + 磁盘实体佐证）⇒ `H3=PASS`、win-smoke `9/0/0`、platform-smoke `13/0/2`。结论见 `docs/platform-gate.md` **§7.10 / §7.11**（**无一项由 agent 预填**）。⚠️ 口径边界：Round A' / Round B 只覆盖安装 / 启动 / REST 层，**派发维度只由 H3 回答**；`P1`（大小写不敏感卷）已裁决为**已知限制、不改引擎**，`P5`（无第二可写 FS）未实测 | `README.md:34` / `dsh-graph-host/README.md:52` / 英文镜像 `:294`（**按台账指向措辞，不写轮次计数与结论数字**） |
| 原生 macOS | ⏳ **本版未验证** —— `v0.20.2` **未**在原生 macOS 上执行真机门禁 | `README.md:35` / `dsh-graph-host/README.md:53` / 英文镜像 `:295` |

**一轮闭环核验（本版纪律，已按实测结果验证）**：包内文件（含 `dsh-graph-host/README.md`）**不含任何随本轮真机结论变化的表述** ——
平台表按「结论以台账为准」+ 宿主代际陈述，**不写本轮的轮次结论数字**（包内平台行里唯一的数字是**上一版 `v0.20.1` 的历史记录**
「T1–T5 通过 15 / 失败 0 / 告警 1、T3 32/32 步」，它跨轮稳定、不由本轮结论改变）；`docs/` 与 `CHANGELOG.md` **不在包内**
⇒ Round A' / Round B / H3 三段跑完后**只回填了 `docs/`**（§7.10 / §7.11 / 本清单），
**候选产物字节与 sha256 全程未变**（仍为 `f39517c3…` / 1,444,792 B / 43 成员），**未触发第 4 轮产物**
（v0.20.1 曾因包内 README 写入轮次计数而多跑一轮；本版已避免）。§7.10 / §7.11 在**准备阶段**保持「待回填」原文，
**结论全部来自负责人真机回传，agent 未预填**（回填后的正文已无「待回填」字样；本节所述「保持未预填」是对准备阶段的记述）。
**⇒ 被测产物 ≡ 待发布产物**（同一 sha256）。

## 8. 发布态动作（合并 `main` 与打 tag **已完成**；`push` / `publish` / GitHub release / profile 安装升级 **待负责人执行**）

- [x] **原生 Windows 真机门禁 Round A'**（静态复跑）—— **已执行 · PASS**（win-smoke `8/0/0`、platform-smoke `12/0/2`、
      矩阵 `H1/H2/H4/H5/H6=PASS`、`H3=SKIP`；`H4` 在真实 NTFS 上由 FAIL 反转）；明细回填 `docs/platform-gate.md` **§7.10**
      （追加在该节原文之后，既有轮次记录未改写）。❗执行中修正了两处配方问题：首轮手搓源码树缺 `node_modules/yaml`
      ⇒ H1/H2/H4/H5 退化为 WARN（=没测到）且 P4.a/P6 FAIL，属**假绿环境的连带**，重建含 `yaml` 的树包并在无祖先
      `node_modules` 的目录复跑后全绿（该次数字已在 §7.10 标为废弃，不得引用）。
- [x] **原生 Windows 真机门禁 Round B**（完整 tarball 门禁）—— **已执行 · PASS**：`结果=PASS 通过15/失败0/告警1`、
      T3 生命周期 `32/32`、产物指纹 `f39517c3…` 双向对账一致；附测旧代际宿主 `0.2.0-rc.2` 同样 `15/0/1`；回填 §7.11。
      ⚠️ **口径边界**：只覆盖安装 / 启动 / REST 层，**不覆盖派发维度**。
- [x] **原生 Windows H3**（派发可用）—— **已执行 · PASS**：`reviewer` `964dd21c…` / `collector` `218156f3…` /
      `executor-minimal` `391377c4…` 三条真派发、`errors` 全空、实例磁盘实体佐证；两道门禁消费后 `H3=PASS`
      （win-smoke `9/0/0`、platform-smoke `13/0/2`）；回填 §7.11 的 H3 段。
      ❗执行中的三条环境修正（已写入配方）：Windows 侧**不用裸 `dsh` 名字**（PATH 上有 Desktop 的 `dsh.cmd`）、
      **不把带 `--flag` 的命令包进 PowerShell 函数**（`--profile` 到不了 CLI）、装包用**单条 cmd.exe 命令行**形态。
- [ ] **（可选）原生 macOS 真机门禁**：按 [`docs/platform-gate.md`](platform-gate.md) §5 命令序列执行；
      未执行则维持「本版未验证」。
- [x] **合并 `main`**：`v0.20.2-test` → `main`（`--no-ff`）—— **已执行 2026-10-11（本地）**：合并提交 **`912de67`**，
      `HEAD^{tree}` = `v0.20.2-test^{tree}` = `17672def1b9fbabaf1d097fadb6236c196820c2f`（**逐字相等，零内容漂移**）；
      合并带入 23 个文件 / +4945 −159；主树 `porcelain=0`。看板 `.dsh-graph/` 属**内层独立仓库**（外层跟踪 0 文件）⇒ 合并不触碰看板。
      ⚠️ **必须先合 `main` 再发布**：见 §9（README / 文档的图链接解析到 `blob/main`，否则 404）。
- [x] **打 annotated tag `v0.20.2`**（非轻量 tag）—— **已执行，并因发布前复核修掉 1 条 BLOCK（发布正文旧稿）按负责人决定重打**：
  首次打在合并提交 `912de6789bdb2ddf9f700ddb5a92c31d012f4947`；**重打后指向发布态收尾提交**（= 含发布正文修订与本清单的 `main` tip，
  以 `git rev-parse v0.20.2^{commit}` 为准）。核验口径不变：`git cat-file -t v0.20.2` = **`tag`**、`git describe` = `v0.20.2`、tag 正文含三段真机结论与产物 sha256。
  **为何重打**：首次 tag 的树内 `docs/release-notes-v0.20.2.md` 还是回填前旧稿（写「Windows 结论尚不存在」），与同树的 §7.10/§7.11 PASS 自相矛盾；
  重打后 tag 树 == 主树终态，该矛盾消失。**重打安全**：tag 未推送、无外部引用，且**非 `docs/` 改动为 0 文件** ⇒ 与发布产物的同源关系不受影响。
  ❗本清单的数条勾选与修订发生在首次 tag 之后（`docs/` 不入包 ⇒ 不影响发布产物；产物 sha256 全程未变）。
- [x] **`git push`**（`main` + tag）—— **已由负责人执行**：GitHub `main` = `254d3ce`；`refs/tags/v0.20.2` → tag 对象 `f159b5fd5ef353d0c259b5e9696c3dac0460815c` → **commit `254d3ce`**（`gh api` 核）。
- [x] **`npm publish`**（直发 §5 tarball）—— **已由负责人执行并逐字对账通过**：`npm view dsh-graph@0.20.2 dist --json` ⇒
      `shasum` = **`059fae1b6393a1d5c5c35442d10e8a24406e5683`**、`fileCount` = **43**、`integrity` = **`sha512-L8HdagJWaUuq4gpHTp8EN5xVg2vNUPVtnRZ0F1lqUPcnQtSVCwicAW4fkSDDkzKgXovSDc6Sw/nsU0eAFxa5AQ==`**
      —— 三项与本地期望值**逐字相符**；`dist-tags.latest` = `0.20.2` ⇒ **发布产物 ≡ 被测产物**。
- [x] **GitHub release `v0.20.2`** —— **已由负责人创建**（`2026-10-10T17:51:54Z`），附件 = `dsh-graph-0.20.2.tgz` + `SHA256SUMS`；
      附件 `SHA256SUMS` 下载复核 = `f39517c3…`（与 §5 一致）；正文与 `docs/release-notes-v0.20.2.md` 逐字比对通过
      （`diff` 仅 1 行：GitHub 追加的文末空行，属约定内唯一差异）⇒ **正文用的是修好 BLOCK 之后的那份**。
- [ ] **profile 安装 / 升级验证**：全新 profile（隔离 `DSH_HOME`）按用户方式安装 `dsh-graph@0.20.2`，
      复核三维度（安装 / 启动 / **派发可用**：派发返回真实 `child_id`；Linux 与原生 Windows 均已实证，见 §7.11 H3 段）。
- [x] **发布源树对账**（跨树可复现性）—— **已按零构建论证闭合**：tag 树 == 发布线 tip 树（同一 tree hash `17672def…`），
      且自打包点 `6a1d5e5` 到该树的**非 `docs/` 改动 = 0 个文件**（同期仅 `docs/platform-gate.md` / `docs/release-checklist-v0.20.2.md` 变动，
      两者都不在包内）⇒ **包相关输入与打包时逐字节相同**；再叠加此前已证的「重建重打 ≡ 本产物」（`cmp` 逐字节一致，§2）与构建确定性
      ⇒ tag 树产出的包 ≡ §5 产物（sha256 `f39517c3…`）。**未做额外的第二次重建**（避免无谓构建）；
      如需字面复现，可在 tag 树的隔离 worktree 内 `bash scripts/build.sh` + `dist/` 内 `npm pack` 后与 §5 对账（**不得在主树构建**）。
- [x] 看板 `v0.20.2` 泳道状态置 **`released`**（`2026-10-11`，发布完成后；与 `v0.20.1`/`v0.20.0`/`v0.19.8` 等既有已发布泳道同口径）。
- [ ] 归档 / 清理本轮临时产物（`tmp/uat-v0202/`）—— **未执行**：其中 `WINDOWS-GATE-RECIPE.md`、`h3-linux-evidence.md`、`h3-dispatch-facts.json`
      被本清单 / 发布正文引用为证据落点，且 `dsh-graph-0.20.2.tgz` 是已发布产物（本地留一份可离线复核）⇒ 建议**保留证据与产物**，
      仅当负责人明确要求时再清理（`tmp/` 本就不入版本控制）。

## 9. 发布期约束（**必须先合 `main`，否则文档与 README 的图链接 404**）

随包发布的**两张设计哲学交互图**与相关文档，其链接最终都解析到 **`main`** 分支上的文件：

- `dsh-graph-host/README.md`（中 / 英）以**绝对链接**指向 `blob/main/docs/design-philosophy.zh.md` / `...en.md`；
- 这两份文档内以**相对链接**指向 `../dsh-graph-host/diagrams/design-philosophy.{lifecycle,workflow}.html`
  与 `assets/design-philosophy.*.svg` —— GitHub 按**文件所在分支**解析相对链接 ⇒ 同样落到 `main`。

图路由本身（插件自带只读路由 `/api/dsh-graph/diagram/<name>`，从 `dist/diagrams/` 现读）与包内相对资产**不受此约束**。
该约束来自 `g-460` 判据 15，是**发布顺序**要求，不是缺陷。

## 10. 负责人发布交接单（**已执行完毕**，2026-10-10/11；命令与对账期望值保留备查）

> **发版前复核已完成（2026-10-11）**：主管侧逐条复核 §1–§7 通过，并修正 3 处**措辞不精确**（`dist/` 作用域、源树对账口径、§8 时态）；
> **独立复核判出 1 条 BLOCK** —— 发布正文真源 `docs/release-notes-v0.20.2.md` 仍是回填前旧稿，照本节的 `gh release create --notes-file` 发布
> 会把「本版 Windows 无结论」写成公开正文；**已在发布前修好**（正文改用 §7.10/§7.11 真机结论；该文件属 `docs/`、不在包内 ⇒ **产物 sha256 不变**）。
> 两份记录见 §11。
> **发布后真值（实测）**：GitHub `main` = **`254d3ce`**｜`refs/tags/v0.20.2` → tag 对象 `f159b5fd…` → **commit `254d3ce`**｜
> GitHub release `v0.20.2` 建于 `2026-10-10T17:51:54Z`（附件 tarball + `SHA256SUMS`）｜npm `dist-tags.latest` = **`0.20.2`**，
> `dist` 对账 `shasum 059fae1b…` / `fileCount 43` / `integrity sha512-L8Hdag…` **三项逐字相符** ⇒ 发布产物 ≡ 被测产物（sha256 `f39517c3…` / 1,444,792 B / 43 成员）。
> 本节保留为**可复制交接单与对账依据**（含期望值），便于复核与回溯；`profile 安装 / 升级验证` 仍待执行（见 §8 末）。

```bash
# 0) 前置复核（四条都应命中）
cd /home/miuzel/workspace/personal/dsh-graph
git rev-parse --short main                      # 发布态收尾提交
git rev-parse --short 'v0.20.2^{commit}'        # 应与上一行**相同**（annotated tag 重打后指向 main tip）
git rev-parse --short origin/main               # 57a16a7（尚未推送）
sha256sum tmp/uat-v0202/dsh-graph-0.20.2.tgz    # f39517c3aa0470e3aa60d9541a06842f4633523f024fd697b456e68aed0e0703

# 1) 推送 main 与 tag（§9：先合 main 已完成；本版 main 已在 tag 之上）
git push origin main
git push origin v0.20.2

# 2) 发布 npm —— 直发 §5 的 tarball（registry 不重打，产物与本地逐字节相同）
npm_config_cache="$PWD/tmp/npm-cache" npm publish tmp/uat-v0202/dsh-graph-0.20.2.tgz
#   注：本沙盒 ~/.npm 只读 ⇒ 必须给 npm_config_cache；如账号启用 2FA，追加 --otp=<code>

# 3) 发布后立即对账（三个值必须逐字相等）
npm_config_cache="$PWD/tmp/npm-cache" npm view dsh-graph@0.20.2 dist --json
#    shasum    == 059fae1b6393a1d5c5c35442d10e8a24406e5683
#    fileCount == 43
#    integrity == sha512-L8HdagJWaUuq4gpHTp8EN5xVg2vNUPVtnRZ0F1lqUPcnQtSVCwicAW4fkSDDkzKgXovSDc6Sw/nsU0eAFxa5AQ==

# 4) GitHub release（附件 = tarball + SHA256SUMS，正文用真源）
cd tmp/uat-v0202
gh release create v0.20.2 -R miuzel/dsh-graph dsh-graph-0.20.2.tgz SHA256SUMS \
  --title "v0.20.2" --notes-file ../../docs/release-notes-v0.20.2.md
gh release view v0.20.2 -R miuzel/dsh-graph --json body > body.json   # 与真源逐字比对（唯一可接受差异：文末换行归一化）

# 5) profile 安装 / 升级验证（全新隔离 DSH_HOME）；派发维度应返回真实 child_id
```

**出问题时的回退口径**：`npm publish` 后才发现问题 ⇒ **不撤包**，改发 `0.20.2` 的补丁版本（历史约定）；tag 若打错但**尚未推送** ⇒
`git tag -d v0.20.2` 后可重打（本版已按负责人决定重打过一次：**重打后 tag == `main` tip**；此后未经负责人指示**不得再移动**）。

## 11. 发版前复核记录（2026-10-11）

**A. 主管侧逐条复核（对照仓库真实状态自算，不采信本清单自述；源树 = tag `v0.20.2`（重打后 == `main` tip）/ 合并提交 `912de67`）**：

| 复核点 | 结论 | 证据（单行） |
|---|---|---|
| 版本号一致性（红线 2） | ✅ PASS | `dsh-graph-host/package.json` = `0.20.2`；`lib/client/constants.js:12` `PLUGIN_VERSION` = `0.20.2`；`README.md:18/20`、`dsh-graph-host/README.md:43/57/285/299` = `v0.20.2`；根 `package.json` 无 `version` 字段（符合预期） |
| 产物对账（§5） | ✅ PASS | 自算 sha256 `f39517c3…` / 1,444,792 B / 成员 **43** / `docs/` 成员 **0** / 包内 `version` `0.20.2` / sha1 `059fae1b…`；包内含 `package/README.md`、**不含** `CHANGELOG.md` |
| 一轮闭环（包内不含轮次结论） | ✅ PASS | 包内平台行按「结论以台账为准」措辞、无轮次计数与结论数字；三段回填仅改 `docs/`（自打包点起非 `docs/` 改动 **0** 文件）⇒ 产物字节未变 |
| 兼容声明（§2/§3） | ✅ PASS | `engines.dsh` = `>=0.1.5-rc.2 <0.2.2-0`；`peerDependencies["@deepseek-ai/dsh-settings"]` 同区间；`yaml ^2.9.0` 在 `dependencies`（自带运行依赖） |
| H3 事实通道（§4） | ✅ PASS | `--h3-dispatch-json` / `DSH_GATE_H3_DISPATCH_JSON` 真实存在于 `scripts/win-smoke-test.mjs`（8 处）与 `scripts/platform-smoke-test.mjs`（4 处）并被消费 |
| 闸门复跑（§6） | ✅ PASS | 在 **tag 树**（`.worktrees/g-476-att-01` 已快进至 `v0.20.2^{commit}`，其 `dist/` 为 0.20.2 构建）：`run-tests` tests=2411 pass=2411 fail=0 skipped=0 exit=0（42.5 s）+ `tsc --noEmit` exit=0 ｜ 该次是在**发布正文与清单修订之后**复跑，用于确认 `docs/` 改动没打破读取 `docs/` 的守卫（`g362` / `g428` / `g429` 等） |
| 发布态真值（§8） | ✅ PASS | `main` = 发布态收尾提交；tag `v0.20.2` → `main` tip（重打后；`git cat-file -t` = `tag`）；`origin/main = 57a16a7`（**未推送**，远端无该 tag）；registry `latest = 0.20.1` |
| 树清洁与临时产物 | ✅ PASS | `git status --porcelain` = 0；tag 树无 `tmp/`、`dist/*.tgz`、`.dist-stage.*` / `dist.prev.*` 混入 |
| 平台结论 ↔ 台账一致性 | ✅ PASS | 本清单 §2/§7 的 `8/0/0`、`12/0/2`、`15/0/1`、`32/32`、`9/0/0`、`13/0/2`、H1–H6、三条 `child_id` 与 `docs/platform-gate.md` §7.10/§7.11 逐项相同 |

**复核中发现并修正的 3 处措辞不精确（均非结论性缺陷）**：① §3/§5 的 `dist/...` 未写明「哪个树的 `dist/`」（主树 `dist/` 是旧构建 `0.19.7`，按字面复核会被误判为版本漂移）⇒ 新增 §5「`dist/` 作用域」注；② §5「发布时在 tag 树重建重打」与 §8「按零构建论证闭合」口径不一致 ⇒ 对齐；③ §8 标题时态（合并 / tag 已完成但标题仍写「一律未执行」）⇒ 改写。

**B. 独立复核记录（另一执行者，只读；复核基线 = 本清单 blob `0300e4b1`，2026-10-11）**：

- **总判**：`audit: BLOCK | checked=7 items | discrepancies=7` —— 7 个复核点 **6 PASS + 1 BLOCK**，另 6 条为 INFO 级；复核者在报告里明确
  「**阻塞点在发布正文真源，不在产物本身**」。
- **BLOCK（唯一阻断项，已修复）**：`docs/release-notes-v0.20.2.md:19-20` 仍写「**本版结论尚不存在**…§7.10 保持未预填」与
  「**Windows 侧 H3 仍待负责人按配方在真机上回传**…未经真机验证」，与 §7.10/§7.11 的真机回传原文直接冲突；而 §8/§10 明令用该文件作
  `gh release create --notes-file` ⇒ **照此发布将产出否认本版 Windows 结论的公开正文**。独立复核给出的对照口径：回传原文 Round A' =
  `H1=PASS H2=PASS H3=SKIP H4=PASS H5=PASS H6=PASS`、H3 三条 `child_id` `964dd21c`/`218156f3`/`391377c4`、`win-smoke` `9/0/0`、
  `platform-smoke` `13/0/2`；**platform-gate 一侧与回传原文逐字一致，偏差在 release-notes 一侧**。
  **处置**：发布前改写该文件 Windows 段与 H3 段为实测结论（含口径边界「Round A'/B 不含派发维度」与三条 `child_id` 的磁盘佐证），
  并同步 §5/§8 的源树对账口径与末行「发布记录」措辞；另在该行补一句说明**包内 README 为何按轮次无关措辞**（刻意的一轮闭环纪律、判定以台账为准、不是「未验证」），
  避免公开正文与包内措辞被读作互相矛盾。**并据此（由负责人决定）把 tag `v0.20.2` 重打到发布态收尾提交** —— 首次 tag 树内的该文件仍是旧稿，
  与同树的 §7.10/§7.11 PASS 自相矛盾；重打后 tag 树 == 主树终态，矛盾消失（重打安全：未推送、无外部引用、非 `docs/` 改动 0 文件）。
  该文件属 `docs/`、**不在包内**（`docs/` 成员 0）⇒ **产物字节与 sha256 未变**（仍 `f39517c3…`），不触发第 4 轮产物。
- **其余 6 条 INFO 的处置**：① §2 待办项未与 §8 同步（合并/tag 已 [x]）⇒ 已改为「已执行（本地 `912de67`）」；
  ② §10 前向引用「独立复核记录」缺失 + 预称「无阻断项」⇒ 由本小节补齐并改写该措辞；③ §7「不写轮次计数与结论数字」字面不精确
  （包内平台行含**上一版历史**数字）⇒ 已改为「不写**本轮的**轮次结论数字」并注明历史数字跨轮稳定；④ §3/§5 `dist/` 作用域 ⇒ 已在修订中增设
  §5 作用域注，独立复核确认 worktree `.worktrees/g-476-att-01/dist` = 0.20.2 且树 hash `37576f858ca29cd8` 相符；
  ⑤ 复核期间主树 `porcelain=1`（本清单自身在编辑中）⇒ 复核后已提交、`porcelain` 归 0；⑥ `DSH_GATE_H3_DISPATCH_JSON` 字面量只在
  `scripts/win-smoke-test.mjs` 出现（`platform-smoke-test.mjs` 经同一 `runHarnessProbes` 入口 + `opts.h3DispatchJson ?? process.env…`
  + 子进程继承 env 等价获得）⇒ 属措辞层面，等价性成立。
- **独立复核**未验证项（如实保留，**不得读作 PASS**）：① §6 运行期数字未由复核者复跑（其无原生 Windows 主机、不做构建）——
  其中 `run-tests` 2411/2411 与 `tsc --noEmit` 0 错由主管在 tree == tag tree 的工作树复跑（§11 A），Windows 侧数字来源为**负责人真机回传**；
  ② §5「同一构建树内重建重打 `cmp` 一致」未复跑（复核者只核对构建树 dist 树 hash 与 sha512 与文档一致）⇒ 发布侧以 §8 的**零构建论证**替代字面复现；
  ③ §8「profile 安装/升级未执行」无正向证据，但与 registry `latest = 0.20.1` 自洽（现时确实无法安装 `dsh-graph@0.20.2`）。
- **协作留痕（如实）**：独立复核期间本清单正被主管**并发编辑**（其基线 `0300e4b1` 为编辑中途版本）—— 这是**协调瑕疵**：该文件应先冻结再交复核。
  BLOCK 结论不受影响（`release-notes` 当时未被编辑），INFO 第 4/5/6 条即由此产生。
- **收口结论**：`BLOCK` 已闭合（发布正文与台账一致）；**产物指纹、tag 树版本串、远端未推送状态**三项独立确认为与清单一致；
  发布前剩余风险仅剩**操作正确性**（`push` / `npm publish` / GitHub release / profile 验证），§10 已给出可复制命令与逐项对账期望值。

**C. 发布后核验（2026-10-11，负责人执行完发布动作后由主管实测）**：

| 核验点 | 结果 | 证据（单行） |
|---|---|---|
| tag 对象 → commit | ✅ | `gh api …/git/tags/f159b5fd…` → `v0.20.2 -> 254d3ce (commit)` |
| GitHub `main` | ✅ | `gh api …/commits/main` → `254d3ce`（与本地一致） |
| release 附件 | ✅ | `gh release download … SHA256SUMS` → `f39517c3… dsh-graph-0.20.2.tgz`（与 §5 一致） |
| release 正文 | ✅ | 与 `docs/release-notes-v0.20.2.md` 逐字比对，`diff` 仅 1 行（GitHub 追加文末空行）；旧稿断言 `结论尚不存在` = 0 处 |
| npm 产物对账 | ✅ | `shasum 059fae1b…` / `fileCount 43` / `integrity sha512-L8Hdag…` 三项与本地期望值**逐字相符**；`dist-tags.latest = 0.20.2` |
| 被测 ≡ 发布 | ✅ | 上述 npm 三项 + release 附件 sha256 均指向同一候选产物 ⇒ **「被测产物 ≡ 发布产物」在发布后仍成立** |
| 看板泳道 | ✅ | `v0.20.2` 置 `released`（`.dsh-graph/versions/v0.20.2/version.md`） |
| 仍待执行 | ⏳ | `profile 安装 / 升级验证`（隔离 `DSH_HOME` 实装 `dsh-graph@0.20.2` 并复核三维度）；`tmp/uat-v0202/` 清理（建议保留证据与产物，见 §8 末） |


# dsh-graph v0.19.7 发布检查清单

> **本文件状态：发布准备中（Windows 真机复验 = 待回填；macOS = 未执行）。** 发布准备阶段创建，只登记**已实测**的结论。
>
> **红线 1（Windows）：本次发布候选包尚未在原生 Windows 上执行门禁 ⇒ 结论为「待回填」，本清单与两份 README 均不得读出「Windows 已通过」。**
> 待负责人在**原生 Windows** 上对本次 RC 执行：
>
> ```sh
> node scripts/win-smoke-test.mjs --tarball dsh-graph-0.19.7.tgz
> ```
>
> 回填方式：逐字报告落 `docs/platform-gate.md` §7，并把本节与 §2 / §6 的 Windows 行同步改为实测结论。
> **注意**：`docs/platform-gate.md` §7.1 / §7.2 已登记的两次真机 PASS（2026-10-06，复验包 `fix3` / `fix4`）覆盖的是
> **0.19.x 的产品代码**（`9a96920..0ca63b6` 之间产品代码零 diff，只有 README / 一个测试 / platform-gate 三处非产品改动），
> 但它们**不是**对本次 RC 门禁的替代 —— 红线 1 要求的是「对本发布产物跑一次」，故仍记为待回填。
>
> 流程沿用 v0.10.0 起确立的做法：主管完成准备并（经负责人授权后）合并 `main` + 打 annotated tag，
> 再由**负责人手动执行 `pnpm publish`**。
> 本文件同时承载 v0.19.7 的 Release Notes 与发布前 / 发布后检查项。
> 版本线说明：本次**把 0.19.0–0.19.7 全线合并为一个发布版本 `v0.19.7`**（上一发布版本为 `v0.18.0`；开发线版本串为
> `0.19.0-alpha`，属 **feature 线**）。lane 分支 `v0.19.7-test`（tip `0ca63b6`）已含 0.19.x 全部工作，
> `v0.19.4/5/6-test` 均为其祖先。
> 本清单结构对照 [`docs/release-checklist-v0.18.0.md`](release-checklist-v0.18.0.md)。

> **准备阶段未执行任何发布动作**：未 `npm publish`、未打 tag、未创建 GitHub release、未 `git push`、
> 未合并 `main`、未改写 git 历史、未触碰 `engines` 与 `peerDependencies`。
> 是否合并 `main` / 打 tag / 发布由负责人在人工 gate 决定。

**本次执行树**：worktree `.worktrees/g-432-att-01`，分支 `g-432-att-01`，基线 **`0ca63b6`**（= `v0.19.7-test` HEAD）。
**纪律（准备阶段）**：全部构建 / 测试 / 打包**均在 worktree 内**完成；**未写主树 `dist/`**
（主树 `dist/` 是运行中宿主的资产来源，历史上有 worker 因主树构建争用而静默死亡）；
worktree 缺 `node_modules`，经**符号链接**指向主树只读复用（不入 git，不改 `pnpm-workspace.yaml` / lockfile）；
worktree 内**未执行任何 `pnpm` 命令**（`pnpm run` 会先做依赖检查、可能隐式触发 `prepare` = 完整构建）。

---

## 0. 相对上一版（v0.18.0）的变更（5 条用户可见）

1. **界面文案跟随宿主语言**：宿主切换语言时，插件文案当场跟着变，不再需要重载；重启后也以宿主当前语言
   初始渲染。同时修掉了「升级宿主后插件浏览器半边不激活」的冷启动问题。
2. **Windows 上的文件系统操作不再踩坑**：目录形态的目标搬迁不再因为提前建了同名目录而被系统拒绝；
   看板内的相对路径按平台统一分隔符，归档 / 取消归档与路径校验不再报错或静默失效。真机门禁扩展为
   清单式全覆盖：每个与系统相关的调用点都登记在台账里，没登记就判红。
3. **状态与记录不再可能对不上**：状态变更先记事件再落盘，中途失败不会留下「状态已改、记录没写」的中间态；
   取锁失败不再释放别人的锁，坏掉的锁能自行收敛而不是永久卡住；目标编号不会被删除后重新发出去；
   解绑只作用于被指定的那一次执行。
4. **英文模式下不再夹带中文**：英文派发时，内置的模式片段、小节标题、空描述兜底材料都按语言渲染，
   界面与提示词里不再冒出中文。
5. **「成功」不再可能是假的**：向会话投递内容、重新派发子代理等操作改为等待回执，没拿到回执就如实提示
   并给出复制兜底；仓库自带的整套测试也不再可能「看起来全绿」而实际漏跑文件、跳过用例或提前退出。

> 两份 README（根 `README.md` + 包内 `dsh-graph-host/README.md`，中英）已同步「最新亮点（v0.19.7）」，
> 并把**三处平台状态表的 Windows 行如实化**（`be5641c` 同形做法）：明确「**v0.19.7 发布候选包尚未跑真机
> 门禁，不得读出「已通过」**」，同时**保留** 0.19.x 产品代码的真机记录（复验包 `fix4`），结论指向本清单
> （发布准备中，Windows 待回填）。macOS 行保持「本次未执行真机门禁」不变；Linux / WSL2 保持已实测通过。
> 仓库根 `CHANGELOG.md` 新增 `## v0.19.7 — 2026-10-06` 节（5 条要点），
> 一并把「逐版本门禁结论」链接指向本清单。

## 1. v0.19.7 版本内容集

版本主题：**把 0.19.0–0.19.7 全线收敛为一次发布** —— 客户端语言跟随与冷启动、Windows 文件系统正确性、
可靠性与事务契约、英文派发语言正确性、交付回执与测试闸门可信度。

| 主题 | 目标 | 用户 / 维护者可见效果 |
|---|---|---|
| 客户端 / 桌面体验 | g-425、g-431 | 冷启动不再因旧版本残留的加载声明（`dsh.client.inject` 死引用）整体不激活；宿主切语言时插件文案实时跟随，重启后以宿主语言初始渲染（locale 改为 cordis 迟到绑定） |
| Windows 文件系统正确性 | g-427、g-429、g-428 | 目录形态搬迁不再先建目标目录（NTFS 必然 EPERM 且重试不收敛）；板内相对路径分隔符族统一（归档 / 取消归档不再必抛、`validate` 位置校验不再静默失效）；冒烟升级为清单式全覆盖（OS 台账 fail-closed + T3 32 步 FS 生命周期 + 突变负向对照） |
| 可靠性与事务契约 | g-337、g-382、g-383、g-384、g-385、g-388、g-394、g-395、g-403 | 事件先行提交（失败不留「状态已改、事件未记」）；取锁失败不再释放他人锁；坏锁 / 读失败锁有界自愈；目标编号单调不复用；解绑只作用于选定 selector 且过 liveCheck；描述围栏识别写入 ≡ 读回；`moveGoal` 改 status 同批补记 `goal.transition` |
| 提示词与多语言 | g-389、g-390、g-400、g-401、g-402、g-405 | 英文派发零内置中文（模式片段、小节标题、反伪装替换串、`auto_from_desc` 前缀、空描述兜底材料）；常驻记忆等字面量 section 关闭模板插值 |
| 交付回执可信 | g-386、g-397、g-398 | 「已投递 / 已重新派发」以 `session.prompt` 回执为准，未确认不再虚报成功（走提示 + 复制兜底） |
| 绑定与缓存生命周期 | g-257、g-387、g-391、g-392、g-411、g-412 | 目录迟到可唤醒重试、已成功 / 在飞不重复 retain；旧宿主目录刷新收敛为一次性 refresh；删除客户端不可达路径；缓存空闲关闭 TTL 匹配 GUI 轮询 |
| 派发契约与隔离可见性 | g-251、g-252、g-406、g-409、g-414 | action 来源可辨、长描述完整承载；standing 预算真上界；隔离判定四字段（isolated / worktree / worktree_reason / created\|reused）透出；建树失败不残留 `attempts/` |
| 泳道命名与路径守卫 | g-364、g-404 | 真实命名入口的卷大小写别名与引用一致性；version slug 拒绝路径分隔符 / 上跳段 / 控制字符（全入口副作用前拒绝） |
| 开发与测试基础设施 | g-301、g-350、g-353、g-396、g-407、g-408、g-413–g-424 | 隔离实例只读预检先拒绝危险输入；构建链退化路径可回滚 / fail-closed + 唯一打包入口；整套件自证闸门 fail-closed（false green / false-positive 测试证据不可伪造）；`pnpm check:dist` 非只读入口口径订正 |
| 发布本身 | g-432 | 本清单 + 版本号一致性 + `CHANGELOG` 新节 + 发布候选包（RC） |

## 2. 发布前检查项

- [x] `dsh-graph-host/package.json` version = **`0.19.7`**（第 3 行）
- [x] `dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` = **`0.19.7`**（第 12 行），
      并 `bash scripts/build.sh` 重建 `dist/lib/client.js`（第 2326 行含该常量）
- [x] **版本号一致**（发布门禁红线 2）：见 §3 逐处 `文件:行` 实测输出
- [x] 两份 README（根 + 包内中 / 英）版本表述同步到 v0.19.7，并把「最新亮点」换为本版 5 条能力；
      工具计数未变，仍为 **50** 个 `graph_*`
- [x] `CHANGELOG.md` 新增 `## v0.19.7 — 2026-10-06` 节（5 条，符合每节 ≤5 条）
- [x] **既有断言精确更新（未放宽）**：`g371-changelog-guard` 的 `EXPECTED_SECTIONS` **加法式**补
      `{ version: "v0.19.7", bullets: 5 }`（既有 8 项逐字未动，`MAX_BULLETS_PER_SECTION` 与
      `FORBIDDEN_TRACES` 未改）；`g352` 冻结签名 fixture 按维护者口径**仅刷 provenance**（见 §3 注）
- [x] 全量测试 / 自证闸门 / 产物语法 / 打包：见 §5
- [x] `npm pack` 产出 `dsh-graph-0.19.7.tgz` 并记录字节数与 sha256 / sha1（§4）
- [x] **平台声明如实（红线 1）**：三处平台状态表按「用户可读的支持 / 验证结果」口径重写（**不含**内部工作编号、
      门禁机制、待回填 / RC 等开发过程信息）——`Linux / WSL2 = ✅ 支持`、`原生 Windows = ✅ 支持（已在原生 Windows 上实测）`、
      `macOS = ✅ 支持（已在 macOS 上实测）`；APFS 默认大小写不敏感并入「已知限制」。**真机结论**：
      Windows `--tarball` = **通过 15 / 失败 0 / 告警 1** + 仓库根台账对账 **2/0/0**（§7.3）；
      macOS `--static-only .` = **7/0/2**、`--tarball` = **16/0/0**（§7.4）
- [x] **macOS 源码构建路径首次真机验证 + 阻断缺陷修复（g-434）**：`bash scripts/build.sh` 在原生 macOS 上因
      「多字节变量名吞并」（bash 3.2 + UTF-8 locale）必然中止 ⇒ 10 处改 `${VAR}` + 新增结构性守卫；修复后
      三步走完并原子就位（§7.4）。**该缺陷不影响发布产物**（`scripts/` 不在包内）
- [ ] 合并 `main` / 打 annotated tag / `pnpm publish` —— **准备阶段未执行**，由负责人人工 gate 决定

## 3. 版本号一致性（红线 2）逐处证据

| 落点 | 文件:行 | 实际值 |
|---|---|---|
| 包清单 | `dsh-graph-host/package.json:3` | `"version": "0.19.7"` |
| 客户端常量（源） | `dsh-graph-host/lib/client/constants.js:12` | `const PLUGIN_VERSION = "0.19.7";` |
| 客户端常量（构建产物） | `dist/lib/client.js:2326` | `const PLUGIN_VERSION = "0.19.7";` |
| 构建产物包清单 | `dist/package.json:3` | `"version": "0.19.7"` |
| README（根，中）当前版本 | `README.md:18` | `**当前版本 v0.19.7**` |
| README（根，中）最新亮点 | `README.md:20` | `**最新亮点（v0.19.7）**` |
| README（包内，中）当前版本 | `dsh-graph-host/README.md:43` | `**当前版本**：v0.19.7` |
| README（包内，中）最新亮点 | `dsh-graph-host/README.md:57` | `**最新亮点（v0.19.7）**` |
| README（包内，英）Current version | `dsh-graph-host/README.md:261` | `**Current version**: v0.19.7` |
| README（包内，英）What's new | `dsh-graph-host/README.md:275` | `**What's new (v0.19.7)**` |
| CHANGELOG 新节 | `CHANGELOG.md:10` | `## v0.19.7 — 2026-10-06` |
| CHANGELOG 守卫快照 | `core/tests/g371-changelog-guard.test.ts:39` | `{ version: "v0.19.7", bullets: 5 },` |
| tarball 内包清单 | `package/package.json`（`dsh-graph-0.19.7.tgz`） | `"version": "0.19.7"` |
| tarball 内客户端常量 | `package/lib/client.js:2326`（`dsh-graph-0.19.7.tgz`） | `const PLUGIN_VERSION = "0.19.7";` |

**历史文档中的既有版本记载逐字未改**：`git diff --stat -- docs/platform-gate.md docs/release-checklist-v0.18.0.md docs/release-handbook.md docs/event-first-commit-contract.zh.md docs/reviews/` 输出为空；
`CHANGELOG.md` 的 diff 只含顶部「逐版本清单」链接一行 + 新节（`## v0.18.0` 及其以下各节逐字未动）。

> **注（g352 冻结签名 fixture 的 provenance 刷新）**：本目标必须改 `constants.js` 的 `PLUGIN_VERSION`，而
> `g352` 冻结签名的 `source-sha256` 头覆盖 `kanban, constants, narrow-width, helpers` 四个客户端源模块 ⇒
> 该头必然失配（改前全量测试实测 `fail=1`，红在 `fixture 与源码不同步`）。按仓库既有发布准备口径
> （`be5641c` 的 stat 同为 `fixture 3 行` + `g352-narrow-width.test.ts 2 +-`）处理：
> ① 先改维护者 dump 工具内嵌的说明文字（`core/tests/g352-narrow-width.test.ts:2094`，**仅该 1 行文字，
> 未触碰任何断言**，尤其 2109–2118 的四条不变式）；
> ② `G352_SIG_DUMP=<临时路径> node --test core/tests/g352-narrow-width.test.ts` 导出到**临时路径**；
> ③ 与改前 fixture（`git show HEAD:…`）比对：diff 恰为 **1 个 hunk `1,3c1,3`**（说明文字 / `source-commit` /
> `source-sha256` 三行），**非头部注释行改动数 = 0**，正文 `diff` = **0 行**（55/55 行一致），
> `content-sha256` 两侧同为 `0e6b7094deafa61e0525d617f792a8da30b9aeba1a3c72cb221ee4061f783ed3`（未变）；
> ④ 用该 dump **更新 fixture 本体**（`cmp` 逐字节等于 dump），`source-commit` 记为基线 `0ca63b6`
> （发布提交的祖先，满足 fixture 自校验判据①；先例 `be5641c` 记基线 `298dd75` 同形）。
> **未删除或放宽任何断言与守卫。**

## 4. 产物与指纹（红线 3：跨机器传递唯一渠道为 tarball）

| 项 | 值 |
|---|---|
| 产物 | `tmp/release-0197/dsh-graph-0.19.7.tgz` |
| 打包命令 | `(cd dist && npm pack --pack-destination <repo>/tmp/release-0197 --cache ../tmp/npm-cache --logs-dir ../tmp/npm-logs)`（`npm pack` 在沙箱下需把 cache / logs 指向 `tmp/` 内） |
| 字节数 | **625760** |
| sha256 | `86198a3935988536ef2fa5294cbe3e641f9786b8c8fa00be3c21744796ebb90a` |
| sha1 | `7f82c95520d6ebb3b04a25b9cb3c0323baf525c0` |
| 成员文件数 | **37**（与 v0.18.0 起口径一致） |
| 包内版本实锤 | `package/package.json` version = `0.19.7`；`package/lib/client.js:2326` `PLUGIN_VERSION = "0.19.7"` |
| `dist/` 内 `.tgz` 残留 | **0** |

`tmp/` 为 gitignored 临时目录，tarball 不入 git（跨机器传递时以上表指纹对账）。

**终版产物（README 用户口径清理 + macOS 结论回填后重打）**：

| 项 | 值 |
|---|---|
| 产物 | `tmp/release-0197-final/dsh-graph-0.19.7.tgz` |
| 字节数 | **624934** |
| sha256 | `3800ba76b1002ae9475019008cc4e973b6390a09953071ae89a1589cbdfd02bd` |
| sha1 | `dbf5e6c6dc0359aa4dc71f990b15aa8149761bf6` |
| 成员文件数 | **37** |
| 与 RC 的差异 | `diff -rq` 输出**仅 1 行**：`README.md` 不同 ⇒ 其余 **36 个文件逐字节相同**（实拍见 `docs/platform-gate.md` §7.5） |
| 包内版本实锤 | `package/package.json` version = `0.19.7`；`package/lib/client.js` `PLUGIN_VERSION = "0.19.7"` |

> **被测产物 vs 发布产物（红线 3 口径）**：§7.3 / §7.4 的真机门禁跑在**上表的 RC**（`86198a39…`）上，
> 发布用的是**终版包**（`667d2c10…`）。两者差异**仅 `README.md`**（用户可见文案：平台行与开发措辞清理），
> 产品代码、客户端 bundle、`prompts` 资产逐字节相同 ⇒ 真机结论对发布产物**继续有效**。
> 若要求严格「被测产物 ≡ 发布产物」，对终版包按 `docs/platform-gate.md` §7 与 §5 的命令各重跑一次即可
> （由负责人决定；本次按「先出结论、再清 README」的顺序执行）。

## 5. 测试与静态检查（RC：worktree `.worktrees/g-432-att-01` 内；终版：主树发布时点）

| 项 | 命令 | 结果 |
|---|---|---|
| 整套件自证闸门 | `node scripts/run-tests.mjs` | **tests=2074 / pass=2074 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0**（自证行：`tests=2074 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=2074 exit=0 ms=31207 glob=core/tests/*.test.ts`） |
| CHANGELOG 守卫（即时） | `node --test core/tests/g371-changelog-guard.test.ts` | **3 / 3 pass，fail 0**（含「正文无过程痕迹」与负向对照） |
| 冻结签名 fixture 套件 | `node --test core/tests/g352-narrow-width.test.ts` | **63 / 63 pass，fail 0** |
| 冻结签名正文比对 | `G352_SIG_DUMP=<tmp> node --test --test-name-pattern="会话内看板页签签名" core/tests/g352-narrow-width.test.ts` + `diff` | 正文 **diff 0 行**（55/55 行一致）；`content-sha256` 仍为 `0e6b7094…`，仅 `source-sha256` 随源码变更 |
| 产物语法 | `node --check dist/lib/client.js` | **通过**（exit 0） |
| 只读新鲜度 | `node --test core/tests/dist-freshness-g312.test.ts` | **5 / 5 pass，fail 0**（exit 0） |
| **终版**整套件自证闸门 | `node scripts/run-tests.mjs` | **tests=2077 / pass=2077 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0**（自证行：`tests=2077 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=2077 exit=0 ms=31487 glob=core/tests/*.test.ts`；+3 = g-434 新增守卫的 3 条用例） |
| **终版**产物语法 | `node --check dist/lib/client.js` | **通过**（exit 0） |
| **终版**只读新鲜度 | `node --test core/tests/dist-freshness-g312.test.ts` | **5 / 5 pass，fail 0**（exit 0） |
| g-434 守卫（含负向对照） | `node --test core/tests/g434-script-var-multibyte-guard.test.ts` | **3 / 3 pass**；放入含裸写 `$PROBE（` 的探针脚本 ⇒ **实拍判红**并给出 `${PROBE}` 修法（探针已删） |

## 6. 执行与未执行项（如实登记）

- **Windows 真机门禁（红线 1）：已执行 ⇒ PASS。** 负责人对**被测产物 = §4 RC**（625760 B，sha256 `86198a39…`）
  在**原生 Windows** 上执行 `node scripts/win-smoke-test.mjs --tarball dsh-graph-0.19.7.tgz`
  ⇒ **通过 15 / 失败 0 / 告警 1**（T3 看板 FS 生命周期 32 步）；另在仓库根执行 `--static-only .`
  ⇒ **2 / 0 / 0**（OS 台账 65 项 / 253 处命中 / **未登记 0**，fail-closed）。逐字报告见 `docs/platform-gate.md` §7.3。
- **macOS 真机门禁：已执行 ⇒ PASS，并修掉一个真机阻断缺陷。**
  ① `--static-only .` = **7 / 0 / 2**（P2 / P3 / P4 / P6 与 M4 **PASS**；`P1=WARN` = APFS 默认大小写不敏感，
  判读表即如此定义，已把该限制写入 README「已知限制」；`P5=WARN` = 无「可写的第二文件系统」，
  执行件按设计**拒绝**冒充通过）；
  ② `--tarball` = **16 / 0 / 0**，T3 生命周期 32/32 步，被测产物指纹与 §4 RC 一致 ⇒ **macOS 可安装可用**；
  ③ **源码构建**：首轮 `bash scripts/build.sh` 在 macOS 自带 **bash 3.2** 下第 112 行因「多字节变量名吞并」
  （`$VAR` 紧跟全角括号 ⇒ `set -u` 判未绑定）**必然中止**、`dist/` 从未构建 ⇒ 修复 `2c6c5c3`
  （10 处改 `${VAR}` + 新增结构性守卫）后三步走完并原子就位。**这是源码构建路径第一次在 macOS 上被真机
  验证**（v0.18.0 的 macOS 门禁只走 tarball，不执行 build.sh）。逐字报告与根因见 `docs/platform-gate.md` §7.4。
  **该缺陷不影响发布产物**（`scripts/` 不在包内）。
- **顺序口径（本次实际做法，写清以免下次误解）**：
  ① 发布准备提交写「**待回填**」，**不写**结论；
  ② 负责人对**被测产物 = §4 记录的 RC tarball**（以 sha256 对账）执行两平台真机门禁（Windows + macOS）；
  ③ 结论回填发生在**发布提交之后的文档提交**中：两份 README 平台行改为**用户可读的支持 / 验证结果**口径
     （按负责人指示**不含**内部工作编号、门禁机制、待回填等开发过程信息）+ `docs/platform-gate.md` §7 + 本清单；
  ④ 回填后 `bash scripts/build.sh` 重打**终版包**（§4 终版表）：与 RC **仅 `README.md` 不同**
     （`diff -rq` 恰 1 行，其余 **36 / 37 逐字节相同**，实拍见 `docs/platform-gate.md` §7.5）
     ⇒ 真机结论对发布产物继续有效。若要求严格「被测产物 ≡ 发布产物」，对终版包重跑两平台门禁即可。
- **未执行**：`npm publish`、annotated tag、GitHub release、`git push`、合并 `main`（均由负责人执行）。
- **未触碰**：`engines` / `peerDependencies` / 产品逻辑代码（`core/*.ts`、`dsh-graph-host/lib/**`
  除 `constants.js` 的版本串外零改动；`core/version-lane.ts` 零 diff）。终版相对 RC 追加的改动仅：
  `scripts/build.sh` + `scripts/dsh-test-web.sh`（10 处加花括号，**不入包**）、新增守卫测试
  `core/tests/g434-script-var-multibyte-guard.test.ts`、`docs/**`、两份 `README.md`（用户可见文案）。
- **平台状态表**：三处平台行已写入**真机结论**（Windows = `✅ 支持（已在原生 Windows 上实测）`；
  macOS = `✅ 支持（已在 macOS 上实测）`），APFS 大小写不敏感并入「已知限制」。README 全文无未验证声明。

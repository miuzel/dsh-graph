# dsh-graph v0.20.0 发布检查清单

> **本文件状态：发布准备 = 已完成（版本串转正 / CHANGELOG / 本清单 / 终版产物与对账 / 自证闸门 全部落地）。**
> **平台真机结论：原生 Windows = 未执行（待执行）；原生 macOS = 未执行。** 两者**均不得读出「已通过」**（详见 §7）。
> 本阶段**只做发布准备**：未合并 `main`、未打 annotated tag、未 `npm publish`、未创建 GitHub release、未 `git push`
> —— 这些不可逆动作**全部留给负责人人工 gate**（§8）。
> 负责人 2026-10-09 已裁决：v0.20.0 全部目标 `accept`、**版本号定案 `0.20.0`（直接正式版，非 rc）**；
> Windows 真机**另起目标**执行，且**必须跑在本清单 §4 的终版 tarball 上**（顺序不可反：先有终版产物，再上真机，否则真机验的不是终版产物）。
> 本清单结构对照 [`docs/release-checklist-v0.19.8.md`](release-checklist-v0.19.8.md)。

**本次执行树**：worktree `.worktrees/g-466-att-01`，分支 `g-466-att-01`，基线 **`1bba546`**（= 打包当时的 `v0.20.0-test` tip；`main` = `916f842`，本线领先 **27 个提交**）。

**纪律（准备阶段，逐条可核对）**：

- 全部构建 / 测试 / 打包**只在 worktree 内**完成；**未写主树 `dist/`** —— 主树 `git status --porcelain` = **0** 行，
  主树 `dist/` mtime 保持 **`2026-10-06 12:31:23`**，主树 `dist/` 全树内容 hash 构建前后一致（`0607f0a0…`）。
- worktree 的 `node_modules` 是指向主树的**符号链接**（只读复用）：全程**未执行任何 `pnpm` / `npx`**
  （`pnpm run` 会在 pnpm ≥ 11 下先做依赖检查、可能隐式触发 `prepare` = 完整构建并原子替换主树 `dist/`）。
  构建只用 `bash scripts/build.sh`，编译 / 检查只用 `./node_modules/.bin/*`；只读新鲜度检查用
  `node --test core/tests/dist-freshness-g312.test.ts`（**不用** `pnpm check:dist` —— 它不是只读入口）。
- 终版产物、日志与证据全部落在 worktree 内 `tmp/`（gitignored，不入 git）。

---

## 0. 相对上一版（v0.19.8）的变更（5 条用户可见）

1. **支持 DSH 0.2.1 系宿主**：宿主兼容范围放宽为 `>=0.1.5-rc.2 <0.2.2-0` —— 上界 `-0` 排除 `0.2.2` 的一切预发布与正式版，
   整条 `0.2.1` 线纳入范围，并已在隔离实例上以 `0.2.1-alpha.2` **未使用**任何版本豁免完成安装与启动。
   ⚠️ 宿主的安装/启动门禁**只读 `peerDependencies`、不读 `engines.dsh`**，两处声明必须**同步**放宽——只改前者无效。
2. **升级宿主后旧设置不再丢**：旧 `settings.yaml` 里的 `dsh-graph` 节会一次性、幂等地补进新的 `dsh-graph-host` 条目
   （重复执行不会重复导入，读取仍保留回退）；该升级路径已在真实宿主上做过端到端验证。
3. **Agent Teams 协作模式（默认关闭）**：同一次执行内可扇出多个成员并行推进，并指定独立验证者对结果交叉核验；
   开关关闭时提示词与行为与旧版逐字一致。
4. **不再产出坏数据、也不再静默失效**：设置写入的父级不是块式映射时直接拒绝（不再返回成功却写出非法 YAML）；
   工作树归属标记改为原子写入，中途失败不再留下半个标记、导致清理面保护静默失效。
5. **设计过程看得见、状态不用猜**：看板标题栏新增「Graph 设计」入口，弹窗内嵌两张可交互流程图（随包发布、经只读路由提供），
   并有中英双语文档说明开发流程；新一轮对话开始时先显示「正在处理…」占位，不必盯着空白等首字。

> 两份 README（根 `README.md` + 包内 `dsh-graph-host/README.md`，中 / 英）已同步「最新亮点（v0.20.0）」，
> 并把**平台状态表的 Windows / macOS 行如实化**（准备期不得读出「已通过」，见 §7）。
> 仓库根 `CHANGELOG.md` 的 `v0.20.0` 节扩为 5 条要点（用户语言、无过程痕迹），顶部「逐版本门禁结论」链接指向本清单。

## 1. v0.20.0 版本内容清单

版本主题：**把宿主兼容面推到 0.2.1 线，并收口「配置迁移 / 写入安全 / 协作模式 / 设计可视化」四处可信度缺口**。

| # | 目标 | 标题 |
|---|---|---|
| 1 | `g-440` | Agent Teams 协作模式落地：单 attempt 内扇出与独立验证者的契约与留痕 |
| 2 | `g-450` | flow 映射上的标量写入产出非法 YAML 却返回 200（既有缺陷） |
| 3 | `g-451` | worktree 归属标记原子写入：消除截断窗口导致的清理面保护静默失效 |
| 4 | `g-454` | 宿主代次升级时旧 settings.yaml 的 dsh-graph 节不会进入新条目：既有用户全局设置丢失（迁移缺口） |
| 5 | `g-456` | 开启 0.20.0 开发线：版本串置 `0.20.0-alpha` + 签名 fixture 重冻结 |
| 6 | `g-457` | v0.20.0 升级路径真机 E2E：旧 dsh-graph 节 → dsh-graph-host 一次性迁移（真实宿主 `0.2.0-rc.2`） |
| 7 | `g-460` | 开发流程 graph 的可视化与可自定义（1.0 准备：不同项目启用不同的 graph） |
| 8 | `g-461` | 在一轮新的对话开始时自动设置代理 status |
| 9 | `g-462` | 看板 UI 内嵌设计哲学交互图（archify 产物随包发布 + 入口） |
| 10 | `g-465` | 放宽宿主兼容声明面至 0.2.1 线（`<0.2.2-0`）并重验 |

**泳道外但与发布直接相关**：

| 目标 | 状态 | 说明 |
|---|---|---|
| `g-463` | `delivered`（独立泳道） | 与上游 DSH `0.2.1-alpha.2` 的兼容性**独立验证**：结论「兼容（仅需放宽声明面上界），零豁免可装可跑」直接支撑 `g-465`；证据见 §4。**不属版本泳道**（避免未经负责人批准改变发布阻塞集）。 |
| `g-464` | `in_progress`（**未计入本版**） | launcher 就绪判据假阳性修复。**打包当时其分支相对 `v0.20.0-test` 零提交**（worktree 内改动未提交）⇒ 与本版内容清单无关；若负责人后续合入，须另起一轮发布准备。 |

## 2. 检查项

- [x] 版本串转正：`dsh-graph-host/package.json` version 与 `dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` = `0.20.0`（§3）
- [x] README 三处渠道（根 `README.md` + 包内 zh / en）版本表述与「最新亮点」更新为 `v0.20.0`；平台状态行的 Windows / macOS **如实标注为未执行**（§3 / §7）
- [x] `CHANGELOG.md` 的 `## v0.20.0 — 2026-10-09` 节对齐最终版本串、扩为 **5 条**用户语言要点、无过程痕迹；`g371` 快照同步为 `{ version: "v0.20.0", bullets: 5 }` 且守卫绿（§6）
- [x] 全仓 `0.20.0-alpha` 残留核查并逐条归类（§3.1）
- [x] 两份 README 徽标宿主范围与 manifest 对齐（**返工项**，§3「返工记录」）；新增 `g466` 徽标守卫（从 manifest 推导 + 解码双口径 + 5 类编码变体负向对照 + 打包层断言，§6）
- [x] `g352` 冻结签名 fixture 按维护者通道重冻结：**仅** `source-commit` / `source-sha256` / 首行 note 变化，正文与 `content-sha256` **逐字节未变**（§6）
- [x] 本清单建立：状态 / 执行树 / 版本一致性 / 宿主门禁与兼容新事实 / 终版产物表 / 内容清单 / 自证闸门 / 平台诚实性 / 未执行项 / 发布期约束（全文）
- [x] 终版产物在隔离 worktree 内**重建重打**，记录文件名 + 字节数 + sha256 + sha1 + **43 成员** + 包版本 `0.20.0`；**重复打包两次 sha256 一致**；旧作废 sha256 就地留痕（§5）
- [x] 自证闸门全绿：`node scripts/run-tests.mjs` + `tsc --noEmit` + 只读 `dist-freshness` + `node --check`（§6）
- [ ] **原生 Windows 真机门禁（红线 1）** —— **未执行**：另起目标执行，且必须跑在 §5 的终版 tarball 上（§7 / §8）
- [ ] **原生 macOS 真机门禁** —— **未执行**（§7 / §8）
- [ ] 合并 `main` / 打 annotated tag / `npm publish` / GitHub release —— **准备阶段未执行**，由负责人人工 gate 决定（§8）

## 3. 版本号一致性（红线 2）逐处证据

红线 2 的来源是 0.11.0 教训：`PLUGIN_VERSION` 常量**不参与构建校验**，版本串漂移只有人工核对才查得出。

| 落点 | 文件:行 | 实际值 |
|---|---|---|
| 包清单（真源） | `dsh-graph-host/package.json:3` | `"version": "0.20.0",` |
| 客户端常量（源） | `dsh-graph-host/lib/client/constants.js:12` | `const PLUGIN_VERSION = "0.20.0";` |
| 客户端常量（构建产物） | `dist/lib/client.js:2457` | `const PLUGIN_VERSION = "0.20.0";` |
| 构建产物包清单 | `dist/package.json:3` | `"version": "0.20.0",` |
| 根 `package.json` | `package.json:3` | `"private": true`，**无 `version` 字段（未动，符合预期）** |
| README（根，中）当前版本 | `README.md:18` | `**当前版本 v0.20.0**` |
| README（根，中）最新亮点 | `README.md:20` | `**最新亮点（v0.20.0）**` |
| README（包内，中）当前版本 | `dsh-graph-host/README.md:43` | `**当前版本**：v0.20.0` |
| README（包内，中）最新亮点 | `dsh-graph-host/README.md:57` | `**最新亮点（v0.20.0）**` |
| README（包内，英）Current version | `dsh-graph-host/README.md:286` | `**Current version**: v0.20.0` |
| README（包内，英）What's new | `dsh-graph-host/README.md:300` | `**What's new (v0.20.0)**` |
| CHANGELOG 本版节 | `CHANGELOG.md:10` | `## v0.20.0 — 2026-10-09` |
| CHANGELOG 守卫快照 | `core/tests/g371-changelog-guard.test.ts:39` | `{ version: "v0.20.0", bullets: 5 },` |
| tarball 内包清单 | `package/package.json:3`（`dsh-graph-0.20.0.tgz`） | `"version": "0.20.0",` |
| tarball 内客户端常量 | `package/lib/client.js:2457`（`dsh-graph-0.20.0.tgz`） | `const PLUGIN_VERSION = "0.20.0";` |
| README 徽标宿主范围（根） | `README.md:15` | 徽标 URL 编码 `DSH-...%3C0.2.2--0`（**本轮修正**） |
| README 徽标宿主范围（包内，随包发布） | `dsh-graph-host/README.md:15` | 徽标 URL 编码 `DSH-...%3C0.2.2--0`（**返工修正**，见下） |
| tarball 内 README 徽标（打包层实锤） | `package/README.md:15`（`dsh-graph-0.20.0.tgz`） | 徽标 URL 编码 `DSH-...%3C0.2.2--0` |
| 徽标 ↔ manifest 守卫 | `core/tests/g466-readme-host-range-badge.test.ts` | 由 `engines.dsh` 推导期望徽标段，逐字 + 解码回明文双口径比对**三处**（根 / 包内 / `dist/README.md`），含 5 类编码变体负向对照 |

**返工记录（如实登记，审计痕迹）**：**首轮提交的「徽标已修正」只修了根 README 一处，是错的 —— 缺陷仍在随包发布的那份上。**

- **事实**：`g-465` 放宽声明面时，两份 README 的 shields.io 徽标都停留在旧上界；首轮只改了根 `README.md:15`，
  `dsh-graph-host/README.md:15`（⇒ `dist/README.md:15` ⇒ tarball 内 `package/README.md:15`）**仍是旧串**
  ⇒ 首版产物虽被自证闸门判绿，**随包 README 与 manifest 自相矛盾**，被独立复核以解包核对挡下、整批判 REWORK。
- **根因（为什么审计漏检两次）**：徽标是 **shields.io 百分号编码变体** —— 连字符双写、`<` `>` `=` 百分号编码，
  于是旧串里 `0.2.1-` 之后紧跟 `-0`，**不存在连续子串 `0.2.1-0`** ⇒ 以字面量 `0.2.1-0` 为口径的残留审计
  （`g-465` 的与我首轮的）**天然搜不到它**，「全仓 0 命中」是假绿。
- **返工内容**：①修 `dsh-graph-host/README.md:15` 徽标并**重建**（`dist/README.md` 由包内 README 拷贝）→ **重打包**（§5 新值）；
  ②新增结构性守卫 `core/tests/g466-readme-host-range-badge.test.ts`（**不硬编码**范围串，从 manifest 推导；
  逐字 + 解码双口径；对**打包层** `dist/README.md` 一并断言；5 类编码变体负向对照 + 文件级改坏即红实证），
  并**刻意不在仓库里留旧编码字面量** —— 旧形态由 `shieldsEncodeRange(">=0.1.5-rc.2 <0.2.1-0")` 现场推导，
  故对旧编码形态（`%3C` 百分号编码 + 双写连字符的 `0.2.1` 上界）做 `grep -F`（排除 `tmp/`）**0 命中**可直接证明；
  ③旧产物 sha256 `70a99f64…` **作废**（§5）。

该处为**文档对齐**，无产品行为改动。

### 3.1 全仓 `0.20.0-alpha` 残留归类

搜索式：`grep -rn '0\.20\.0-alpha'`（排除 `node_modules/`、`dist/`、`tmp/`、`.worktrees/`、`.dsh-graph/`、`.git/`）⇒ **3 处**，**发布面 0 处**：

| 位置 | 内容摘要 | 归类与处置 |
|---|---|---|
| `core/tests/fixtures/g352-conv-signature.txt:1` | 冻结签名 fixture 的维护者 note：记录「最近一次变更 v0.20.0 发布准备 … 由 `0.20.0-alpha` 转正为 `0.20.0`」与「更早 g-456 为开启 0.20.0 开发线把 `PLUGIN_VERSION` 由 `0.19.8` 置为 `0.20.0-alpha`」 | **历史 / 说明性，保留**。note 行以 `# ` 开头，按 fixture 自身约定被 `parseSignatureFixture` 当作头部丢弃，**不参与** `content-sha256` / `source-sha256` 计算；它记录的是**开发线版本串的历史事实**，正是重冻结留痕的用途。 |
| `dsh-graph-host/README.md:43` | 中文：「`0.20.0-alpha` 为开发线版本串」 | **说明性，保留**。这是**开发线版本串的标注**（与 v0.19.8 清单同形），不是「当前版本」声明；把它删掉会让读者误以为从未有过开发线串。 |
| `dsh-graph-host/README.md:286` | 英文：`0.20.0-alpha` was the development version string — not yet published to npm | **说明性，保留**（同上，英文镜像）。 |

⇒ **发布面（包清单 / 客户端常量 / 构建产物 / tarball / 当前版本声明）已无 `0.20.0-alpha` 残留**；`dist/lib/client.js` 与 `dist/package.json` 均已实测为 `0.20.0`（§3 表）。

**历史文档中的既有版本记载逐字未改**：`docs/release-checklist-v0.19.8.md` 及更早清单、`docs/release-checklist-v0.17.0.md`、
`docs/platform-gate.md`、`docs/release-handbook.md`、`docs/reviews/` 本轮**零改动**；
`CHANGELOG.md` 的 diff 只含顶部「逐版本清单」链接一行 + `v0.20.0` 节（`## v0.19.8` 及其以下各节**逐字未动**）。

## 4. 宿主门禁与兼容范围（本版新事实）

**兼容范围（三处同源，本版未再改动，`g-465` 已放宽）**：

| 落点 | 文件:行 | 值 |
|---|---|---|
| `engines.dsh`（供 dsh-market 等宿主感知型市场读取） | `dsh-graph-host/package.json:30` | `>=0.1.5-rc.2 <0.2.2-0` |
| `peerDependencies["@deepseek-ai/dsh-settings"]`（**宿主门禁唯一真源**） | `dsh-graph-host/package.json:35` | `>=0.1.5-rc.2 <0.2.2-0` |

**新事实 ①（根因）：宿主门禁只读 `peerDependencies`、不读 `engines.dsh`。**
主管在**隔离运行时**的 `@deepseek-ai/dsh-app-boot/lib/index.js` 亲自确认：`L289` `Object.hasOwn(fields,"peerDependencies")`、
`L290` `objectOf$1(fields.peerDependencies,…)`、`L322` 报错文案为 `peerDependencies …`。
⇒ **只放宽 `engines.dsh` 是无效动作**：安装期仍会被硬拒绝（`g-463` 场景 A 实测 `installation rejected … nothing was installed.`）。
⇒ 因此本仓库把 `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` 视为**必须同步**的一对。

**新事实 ②：`0.2.1-alpha.2` 上「无豁免」实测可用（零豁免）。**
放宽上界后，在隔离实例上以 `0.2.1-alpha.2` 完成安装与启动，**未使用** `allow-version` 豁免 ——
且**豁免文件不存在**（本轮复核：`tmp/dsh-test/0.2.1/home/profiles/web/compatibility.json` = `{}`，`version-exemptions.json` 不存在，
`find tmp/dsh-test/0.2.1 -name '*exempt*'` 零命中）。旧基线 `0.2.0-rc.2` 复测不回归。

**宿主门禁命令（可照抄执行；隔离实例，不碰 3080 主 GUI、不碰 3090 负责人实例）**：

```sh
# ①（准备阶段已验证的口径）在隔离实例上装 + 起，观察三条 apply 与启动日志
bash scripts/dsh-test-web.sh 0.2.1-alpha.2 --port 3091 --host-dir <worktree>/dist
#    期望日志（三条 apply 齐全，且无 prompt asset missing / 无插件加载失败）：
#      [dsh-graph-host] g-118: guide hint section 已注册 …
#      [dsh-graph-host] g-131: supervisor discipline section 已注册 …
#      [dsh-graph-host] apply: tools + /api/dsh-graph(+goal+write) registered …

# ② 看板页与两张图路由（只读）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3091/            # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3091/api/dsh-graph/diagram/design-philosophy.lifecycle.html
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3091/api/dsh-graph/diagram/design-philosophy.workflow.html

# ③ 客户端 bundle 可读 + 语法
curl -s ... dsh-graph/client.js ; node --check <下载的 bundle>      # 期望 exit 0
```

**证据路径（`g-463` / `g-465` 产物，均在仓库主树的 `tmp/` 内，只读引用）**：

| 事实 | 证据文件 | 关键行 |
|---|---|---|
| 三条 apply 齐全（`0.2.1-alpha.2`，port 3091） | `tmp/g465-att001/instance-alpha2.log` | `g-118` / `g-131` / `apply: tools + /api/dsh-graph(+goal+write) registered` |
| 看板页 200 + 两图路由 200 且 served sha256 == source sha256 | `tmp/g465-att001/http-evidence-alpha2.txt` | `GET / => http=200 bytes=36007`；两图 `equal=YES`（`54b554b7…` / `c1523f55…`） |
| 客户端 bundle 可读 + 语法通过 | 同上 | `GET <client bundle> => http=200 bytes=1999313` + `node --check exit=0` |
| 工具注册面含 `graph_*`（机器可读执行面） | `tmp/g465-att001/mock-dump.json` | 请求 2 `nTools=82 hasGraphHelp=true graphTools=51` → 请求 3 `toolResults=1` |
| 旧基线不回归（`0.2.0-rc.2`） | `tmp/g465-att001/instance-020rc2.log` | 同三条 apply 齐全 |
| 受支持宿主表随扩表增列（`g425`） | `tmp/g465-att001/g425-evidence-alpha2.txt` | E1–E4：`dsh.client` 清单 / 无 `dsh` 字段 / 死引用 0 命中 |
| 放宽前被硬拒绝（场景 A，根因留痕） | `tmp/g463-att001-runB-rejected.log` | `installation rejected … peerDependencies {"@deepseek-ai/dsh-settings":">=0.1.5-rc.2 <0.2.1-0"}` + `nothing was installed.` |

> ⚠️ **口径注记（沿用 `g-465` 复核结论）**：上述 `bytes=1999313` 是**客户端组装包**（`window.__ModuleLoader__.load` 多条模块），
> **不是** `dist/lib/client.js` 自身大小；引用时须标明口径，避免与 `node --check dist/lib/client.js`（后者约 1.0 MB）混淆。

## 5. 终版产物（红线 3：跨机器传递唯一渠道为 tarball）

**终版发布产物（本版唯一发布产物；**已按 §3「返工记录」重打**）**：

| 项 | 值 |
|---|---|
| 产物 | `tmp/release-0200/dsh-graph-0.20.0.tgz`（worktree `.worktrees/g-466-att-01` 内，gitignored） |
| 打包命令 | `bash scripts/build.sh` + `(cd dist && npm pack --pack-destination ../tmp/release-0200 --cache ../tmp/npm-cache --logs-dir ../tmp/npm-logs)` |
| 字节数 | **1436632** |
| sha256 | **`5d50aeab7943d678f521e8822b7f716c540b6f9e460950cdcee42b6d418f684d`** |
| sha1 | **`2190fee0d459b8c43ccc9b7ad5ba7337b9a056bd`** |
| 成员文件数 | **43**（`npm pack --dry-run` 实拍 `total files: 43`） |
| 包内版本实锤 | `package/package.json` version = **`0.20.0`**（含 `engines.dsh` 与 `peerDependencies` 均为 `>=0.1.5-rc.2 <0.2.2-0`）；`package/lib/client.js:2457` `PLUGIN_VERSION = "0.20.0"` |
| 包内 README 徽标实锤 | `package/README.md:15` 徽标范围段 = `%3E%3D0.1.5--rc.2%20%3C0.2.2--0`（与 manifest 一致；解包后 `grep -F` 旧编码形态 **0 命中**） |
| `package/README.md` 与源 | 与 `dsh-graph-host/README.md` 经 `cmp` **逐字节相同** |
| `dist/` 内 `.tgz` 残留 | **0** |

**⛔ 作废旧产物（审计痕迹）**：首版 tarball sha256 `70a99f64687971fb0675c621577d63dcf9cd1e201a184166396ef0268879cedf` /
sha1 `3022b2bcb2e92ed7aaeabaa9c3ebb4535ca9598a`（同为 1436632 B / 43 成员）
**已被上表取代，不得作为被测或发布产物**（其唯一缺陷即 §3「返工记录」：tarball 内 `package/README.md:15` 徽标仍是旧上界）。
该文件已原地改名为 `tmp/release-0200/superseded-70a99f64/dsh-graph-0.20.0.tgz` 留痕，避免与终版产物同名混淆；
其余同 sha 的重复副本已清理。**Windows 真机目标（g-467）必须验上表的新 sha256。**

**成员数变化说明**：v0.19.8 为 37 个成员；本版 **43** = 37 + **6** 个 `diagrams/` 产物
（`g-462` 随包发布的设计哲学交互图：`design-philosophy.{lifecycle,workflow}.{html,json,png}`）。

**可复现性实证（返工后 4 轮 + 返工前 4 轮，口径分开）**：

- **返工后（当前终版，全部同一 sha256 `5d50aeab…` 且 `cmp` 逐字节一致）**：
  第 1 轮打 `tmp/release-0200/dsh-graph-0.20.0.tgz`；第 2 轮再打到 `tmp/release-0200/repro/`；
  第 3 轮在**全量闸门跑完之后**打到 `tmp/release-0200/postgate-rework/`（⇒ 测试套件，含 `g348` 原子构建回归，
  **未改动 `dist/` 内容**）；第 4 轮在**提交之后**打到 `tmp/release-0200/postcommit-rework/`
  （⇒ §5 的 tarball 就是发布准备提交对应的终版产物；提交号见交付回报，本清单不写死短 sha，避免 `--amend` 后自引用失真）。
  （四轮字节数同为 1436632 B —— 徽标修正只把 `0.2.1` 换成 `0.2.2`，长度不变、内容不同。）
- **返工前（已作废，只作历史口径）**：曾对该缺陷版本打包四轮（含闸门后、提交后各一轮），sha256 稳定为 `70a99f64…`
  ⇒ 「打包可复现」这一属性本身当时成立；作废**只因为内容有缺陷**，与可复现性无关。

**被测产物纪律**：Windows 真机门禁（另起目标）与负责人人工发布都必须以**本表这一个 tarball** 为被测 / 发布产物：
先 `sha256sum` 对账（Windows 用 `certutil -hashfile … SHA256`，macOS 用 `shasum -a 256`），再执行门禁或发布。

## 6. 测试与静态检查（worktree `.worktrees/g-466-att-01` 内）

| 项 | 命令 | 结果 |
|---|---|---|
| 整套件自证闸门 | `node scripts/run-tests.mjs` | **tests=2339 / pass=2339 / fail=0 / skipped=0 / cancelled=0 / todo=0，exit 0**（自证行：`[run-tests] ✔ 自证通过：tests=2339 (>0) skipped=0 fail=0 cancelled=0 todo=0 pass=2339 exit=0 ms=36674 glob=core/tests/*.test.ts`） |
| CHANGELOG 守卫（含负向对照） | `node --test core/tests/g371-changelog-guard.test.ts` | **3 / 3 pass，fail 0**（本版节要点数 5 与快照一致；「无过程痕迹」通过；删整节 / 删一条 / 乱序 / 去日期 / 超上限 / 混入审计数字 逐项必红） |
| README 工具表守卫 | `node --test core/tests/g371-readme-tool-table.test.ts` | **pass，fail 0**（含在整套件闸门内；README 改动未破坏工具表） |
| **徽标 ↔ manifest 守卫（返工新增）** | `node --test core/tests/g466-readme-host-range-badge.test.ts` | **2 / 2 pass，fail 0**（判据：真源唯一 + 三处徽标由 manifest 推导逐字比对 + 解码双口径；负向对照：旧上界、单写连字符、小写百分号、`+` 空格、缺徽标 5 类在**同一函数**内全部判红，合法改写不误红） |
| **徽标守卫「改坏即红」文件级实证（返工新增）** | 临时把 `dsh-graph-host/README.md:15` 徽标改回旧上界 → 跑同一守卫 → 还原 | **2 / 2 fail**（点名「徽标范围段与 manifest 不符（实得 … `%3C` + `0.2.1--0`，期望 … `%3C0.2.2--0`）」+「解码回明文与 manifest 不符」）；还原后 `cmp` **逐字节相同**、守卫回到 2/2 pass |
| 冻结签名 fixture 套件 | `node --test core/tests/g352-narrow-width.test.ts` | **63 / 63 pass，fail 0** |
| 冻结签名正文比对 | `G352_SIG_DUMP=<tmp> … --test-name-pattern="会话内看板页签签名"` + `diff` | 正文 **diff 0 行**；`content-sha256` 两侧同为 `0e6b7094…`（**未变**）；`source-sha256` `71802765…` → `0d14a6a8…`、`source-commit` → 基线 `1bba546`、首行 note 更新 |
| 类型检查 | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 产物语法 | `node --check dist/lib/client.js` | **exit 0** |
| 只读新鲜度（**不经 pnpm**） | `node --test core/tests/dist-freshness-g312.test.ts` | **5 / 5 pass，fail 0** |

**冻结签名 fixture 的重冻结口径（`g352`，与 v0.19.8 同形，非削弱）**：
本轮必须改 `constants.js` 的 `PLUGIN_VERSION`，而该 fixture 的 `source-sha256` 头覆盖 `kanban,constants,narrow-width,helpers`
四个客户端源模块 ⇒ 该头必然失配（改前实测红在 `fixture 与源码不同步`）。处理方式：

1. 先按 fixture 自身约定手工更新**首行 note**（note 行以 `# ` 开头 ⇒ 被解析器当作头部丢弃，**不参与**两个 hash 计算）；
2. `G352_SIG_DUMP=<临时路径> node --test --test-name-pattern="会话内看板页签签名" core/tests/g352-narrow-width.test.ts` 导出到**临时路径**；
3. 与改前 fixture（`git show HEAD:…`）比对：diff 恰为 **1 个 hunk `2,3c2,3`**（`source-commit` / `source-sha256` 两行），
   第 4–6 行（`source-files` / `content-sha256` / `board-width`）**逐字节相同**，正文 `diff` = **0 行**；
4. 用该 dump 经 **`G352_SIG_ACK=1` 显式确认通道**更新 fixture 本体，`source-commit` 记为基线 **`1bba546`**（= 发布树的祖先，满足 fixture 自校验判据①；先例 `f5fb6b9` 记基线 `0ca63b6` 同形）。

**未删除或放宽任何断言与守卫，未手填任何 hash。**

## 7. 平台诚实性（本版**没有**任何真机结论）

| 平台 | 本版状态 | 依据 |
|---|---|---|
| Linux / WSL2 | ✅ 已实测通过（本版全量测试 fail 0；构建 / 打包 / 自证闸门均在本机完成） | §6 |
| 原生 Windows | ⏳ **未执行 —— 待执行（另起目标，经 interop 尝试）** | 见下 |
| 原生 macOS | ⏳ **未执行** | 见下 |

**为什么不得沿用上一版结论**：`docs/platform-gate.md` §7.3 / §7.4 / §7.6 / §7.7 登记的真机 PASS 覆盖的是
**v0.19.8 及更早的产品代码**，而本版含 10 项目标的产品改动（含新增随包 `diagrams/` 资产与客户端入口）⇒
**不能替代**本次候选包。`README` 的平台状态表因此**不得读出「已通过」**。
按发布门禁红线（`AGENTS.md`「发布门禁」段）：**Windows 验证缺失时 README 须如实标注「Windows 未验证」**。

**README 相应表述如何处理（本轮实改）**：

| 文件:行 | 改后表述（摘要） |
|---|---|
| `README.md:35` | `⏳ **本版未验证（待执行）**：v0.20.0 发布候选包尚未在原生 Windows 上执行真机门禁 ⇒ 不得读出「已通过」`；指向本清单，并声明历史记录只覆盖 v0.19.8 及更早产品代码 |
| `README.md:36` | `⏳ **本版未验证**：… 尚未在原生 macOS 上执行真机门禁 ⇒ 不得读出「已通过」`；历史记录 `§7.4 / §7.7` 同样只覆盖旧产品代码 |
| `dsh-graph-host/README.md:52` / `:53`（zh） | 同上（含 GitHub 绝对链接） |
| `dsh-graph-host/README.md:295` / `:296`（en） | `⏳ **Not verified for this release (pending)** … ⇒ **must not be read as "passed"**`（英文镜像） |

**回填（待真机执行后）**：Windows 真机目标完成后，须按 v0.19.8 先例**接续追加** `docs/platform-gate.md` §7.8（并在 §7 汇总表加一行），
把上面 3 处表（根 + 包内 zh/en）的 Windows 行改为实测口径，并在 §5 追加终版产物行；
**若因回填需要重打 tarball，须重新记录 sha256 并对新包重跑门禁或按红旗裁决**（v0.19.8 的 README-only 裁决先例见其 §4）。

## 8. 未执行项（全部由负责人人工 gate，准备阶段一律不执行）

- [ ] **合并 `main`**：`v0.20.0-test`（打包基线 `1bba546`）→ `main`（`--no-ff` 合并；建议合并后核对 `HEAD^{tree}` 与集成分支 tip 相等）；
- [ ] **打 annotated tag `v0.20.0`**；
- [ ] **`git push`**（`main` + tag）；
- [ ] **`npm publish`**（**负责人手动执行**；tarball 直发，发布后用 `npm view dsh-graph@0.20.0 dist --json` 的 `shasum` 与本清单 §5 的 sha1 `2190fee0…` 对账）；
- [ ] **GitHub release `v0.20.0`**（附件 `dsh-graph-0.20.0.tgz` + `SHA256SUMS`，下载回验 sha256 = `5d50aeab…`）；
- [ ] **原生 Windows 真机门禁**（另起目标，被测产物 = §5 终版 tarball）；
- [ ] **原生 macOS 真机门禁**（如负责人决定执行）；
- [ ] 发布后由负责人在看板决定是否把 `v0.20.0` 泳道标为 `released`。

## 9. 发布期约束（**必须先合 `main`，否则文档与 README 的图链接 404**）

本版随包发布的**两张设计哲学交互图**与相关文档，其链接最终都解析到 **`main`** 分支上的文件：

- `dsh-graph-host/README.md`（中 / 英）以**绝对链接**指向 `blob/main/docs/design-philosophy.zh.md` / `...en.md`（`:143` / `:401`）；
- 这两份文档内以**相对链接**指向 `../dsh-graph-host/diagrams/design-philosophy.{lifecycle,workflow}.html`
  与 `assets/design-philosophy.*.svg` —— GitHub 按**文件所在分支**解析相对链接 ⇒ 同样落到 `main`（`design-philosophy.zh.md:35` / `:43`）；
- 图路由本身（插件自带只读路由 `/api/dsh-graph/diagram/<name>`，从 `dist/diagrams/` 现读）与包内相对资产**不受此约束**。

而 §5 的终版产物当前**只存在于集成分支 `v0.20.0-test`**（`main` 尚未合并）⇒
**发布时必须先合并 `main`**，让 `main` 上确实存在对应的图与文档；否则任何点击这些链接的用户 / 市场页面都会拿到 **404**。

> 该约束来自 `g-460` 判据 15（文档与 README 图链接指向 `blob/main`），是**发布顺序**要求，不是缺陷：
> 合并 `main` 属负责人的不可逆动作（§8），本轮不执行。

# macOS 门禁（g-359）

**状态：执行件已就绪（v0.16.0）；真机结论待回填（见文末「回填表」）。本页不预先声明 macOS 已验证。**

本页是 macOS 侧的**可执行门禁手册**：执行件位置、检查分层、负责人可直接粘贴的命令序列、
每项的预期输出与判读口径、以及结论回填位置。

---

## 1. 为什么需要（不是理论风险）

项目长期只在 Linux/WSL2 上开发验证；macOS **没有**独立门禁执行件。已有的
[`scripts/win-smoke-test.mjs`](../scripts/win-smoke-test.mjs) 本身是跨平台的（文件头写明适用
Windows/Linux/macOS，且已对 `/tmp → /private/tmp` 软链做 realpath），但它**只标了未验证项、
没有 Mac 专检**。三个真实风险面此前没有任何机器覆盖：

| 风险面 | 说明 |
| --- | --- |
| ① `build.sh` 退化发布路径 | `mv` 无 `--exchange`（macOS/BSD 与 coreutils < 9.6）时退回**两次 rename + stderr 告警**。该分支在 coreutils ≥ 9.6 的构建机上永远走不到，长期零测试覆盖（g-348 测试里 `grep exchange` 0 命中）——**macOS 的发布构建走的正是这条路径**。 |
| ② APFS 默认大小写不敏感 | goal id / version slug 若仅大小写不同，可能落到同一实体（后写覆盖前者）。此前只在脚本注释里标「未验证」。 |
| ③ 软链 root 边界 | 显式传入且含软链的工作区路径（`/tmp`、`/var` 之下）会被 `core/root.ts` 拒绝并报 `graph root symlink is not allowed`；此前仅是文档里的已知限制，未在 Mac 实测。 |

---

## 2. 执行件位置与用法

**执行件**：[`scripts/macos-smoke-test.mjs`](../scripts/macos-smoke-test.mjs)
（Node 实现 —— macOS 自带 bash 是 **3.2**，无 `mapfile` / 关联数组 / `**`；用 Node 完全绕开 bashism，
并与既有执行件同栈。纯 Node、无第三方依赖、单文件可拷贝。）

```text
node scripts/macos-smoke-test.mjs --static-only .                        # 秒级：只做 T1 静态门禁 + M1–M4
node scripts/macos-smoke-test.mjs --tarball ~/dsh-graph-0.16.0.tgz       # 完整门禁：M1–M4 + 转发 T1–T5
node scripts/macos-smoke-test.mjs --self-test                           # 离线自检（本脚本 + win-smoke）
node scripts/macos-smoke-test.mjs --skip-build --tarball <tgz>          # 未装 node_modules 时跳过 M1
```

退出码：`0` = 无失败项且转发的执行件通过；`1` = 有失败项；其余 = 转发执行件的退出码（`2` = 用法错误）。

---

## 3. 检查分层

执行件只做两件事，**不复制** `win-smoke-test.mjs` 的任何检查逻辑。

### 3.1 本脚本专检（M1–M4，任意平台可跑；M2/M3 的 macOS 判定只在 darwin 上成立）

| 项 | 检查内容 | PASS / WARN / FAIL 口径 |
| --- | --- | --- |
| **M1 退化构建路径** | 在**隔离沙箱副本**里跑 `BUILD_FORCE_TWO_RENAME=1 bash scripts/build.sh`：退出码 / stderr 告警 / `node --check dist/lib/client.js` / `dist` 文件数 / 暂存树清理 | PASS = exit 0 且 stderr 出现告警 且语法检查 OK 且 `dist` 恰 37 个文件 且无 `.dist-stage.`/`dist.prev.`/`core-dist` 残留；任一不满足即 FAIL。WARN = 未装 `node_modules`（先 `pnpm install`）或用了 `--skip-build` |
| **M2 APFS 大小写探针** | 隔离目录里造仅大小写不同的两个 slug 与两个目录，检测是否别名（同 inode / 后写覆盖） | PASS = 本卷大小写敏感，无别名；**WARN = 探针证实别名**（APFS 默认卷即如此）——本项**只报告**，是否加引擎侧防御由负责人另行决策，不在本目标内改核心行为；FAIL = 探针自身异常 |
| **M3 软链 root 边界** | 用发布物里的真实 `resolveRoot`（`dist/core/root.js`）：显式 `/tmp` 下的 root 预期被拒且报 `graph root symlink is not allowed`；realpath 后的同类路径（≈ `process.cwd()` 推导）预期通过 | PASS = 显式被拒（文案一致）且物理路径通过；**WARN = 本机 `/tmp` 不是软链**（Linux 常态）⇒ 该边界在本机不成立，只证明物理路径可解析，**不能**当作 macOS 已验证；FAIL = 物理路径也被拒（真实缺陷，会让 macOS 会话完全打不开看板） |
| **M4 Linux-only 假设扫描** | 扫 `scripts/*.sh`、`scripts/*.mjs`、`core/tests/**` 中的 `renameat2` / `mv -T` / `readlink -f` / `stat -c` / `md5sum` / `sha256sum` / `sed -i`（缺 backup 后缀）/ `grep -P` / `date -d` / `cp --reflink` / `mktemp -d`（无模板）。**每命中判「已被特性探测/回退覆盖」或「隐患」** | PASS = 命中项全部已被覆盖；FAIL = 发布/测试路径存在隐患（附建议）；`scripts/archived/**` 只列 INFO（非发布路径，不计门禁）。唯一豁免扫描器自身（其模式定义表必然含这些字面量，判别力由 `--self-test` 固化）；`dsh-macos-gate:ignore-linux-only-probes` 标记区域内的**有意样本**会被跳过并在输出里报告跳过行数 |

### 3.2 转发的既有门禁（T1–T5，由 `win-smoke-test.mjs` 执行）

| 层 | 内容 | 结论边界 |
| --- | --- | --- |
| T1 静态门禁 | 发布包内不得对 POSIX 专有常量做 ESM 具名导入 | **跨平台有效** |
| T2 安装 | 全新隔离 `DSH_HOME` + 全新 profile 安装插件（tarball = 真实安装语义） | **跨平台有效** |
| T3 核心运行时 | 建目标 / 判据 / 标签 CAS / 并发 / `validate` | 平台敏感；非 win32 上只能证明脚本与代码可跑 |
| T4 实例启动 | `dsh --profile <p>` 启动，插件树加载无平台错误 | 同上 |
| T5 REST 冒烟 | dsh-graph 路由已注册、看板载荷可读、Web UI 可达 | 同上 |

> **结论边界**：T3–T5 在 macOS 上是**有效证据**（它们证明插件在 darwin 上真的跑起来了），
> 但**不构成** Windows 门禁结论 —— Windows 真机门禁（发布红线 1）仍须在原生 Windows 上单独执行，
> 见 [`docs/release-checklist-v0.16.0.md`](release-checklist-v0.16.0.md) §3。

---

## 4. Mac 可粘贴命令序列

### 4.0 前提

- macOS 装有 **Node ≥ 20.11**（`node --version`；`import.meta.dirname` 需要该下限）。
- 本仓库的检出（`git clone` 或整目录拷贝）—— M1 需要 `scripts/`、`core/*.ts`、`dsh-graph-host/`、
  `tsconfig.json`，M3 需要 `dist/core/root.js`，M4 需要 `scripts/` 与 `core/tests/`。

```sh
cd <仓库检出目录>
node --version                      # 期望 v20.11+ / v22+ / v24+
pnpm install                        # M1 需要 node_modules/.bin/tsc
pnpm build                          # 生成 dist/（macOS 上这一步本身就走退化发布路径）
```

> `pnpm build` 在 macOS 上会打印
> `⚠️ 当前 mv 不支持 --exchange（需 GNU coreutils ≥ 9.6），退回两次 rename：存在极短空窗`
> —— 这是**预期**的，正是 M1 要验证的那条路径。

### 4.1 先把产物与执行件拷到 Mac 本地盘，并核对 sha256

跨机器传递唯一渠道为 tarball（发布红线 3）；sha256 是唯一可靠的对账依据。

```sh
mkdir -p ~/dsh-graph-gate && cd ~/dsh-graph-gate
# 从 Linux/WSL2 侧拷入：dsh-graph-0.16.0.tgz（唯一的产物传递渠道）
shasum -a 256 dsh-graph-0.16.0.tgz
```

把该 sha256 与本仓库 `docs/release-checklist-v0.16.0.md` §3.2 记录的指纹**逐字比对**；
不一致就停下（产物传递被破坏），不要继续。

### 4.2 秒级预检（不联网、不安装）

```sh
cd <仓库检出目录>
node scripts/macos-smoke-test.mjs --static-only .
```

### 4.3 完整门禁（M1–M4 + 转发 T1–T5）

```sh
node scripts/macos-smoke-test.mjs --tarball ~/dsh-graph-gate/dsh-graph-0.16.0.tgz
```

### 4.4 离线自检（确认执行件自身没坏）

```sh
node scripts/macos-smoke-test.mjs --self-test
```

### 4.5 回传

把每节末尾 `----- 可复制回传的报告 -----` 区块原样贴回，并填写文末「回填表」。
若 M3 报 FAIL，请一并附上 `explicitRejected` / `derivedRejected` 两个布尔量与原始报错文案。

---

## 5. 每项的预期输出与判读

**M1（macOS 应 PASS）**

```text
[ OK ] M1 · 退化构建路径（BUILD_FORCE_TWO_RENAME=1 ⇒ 两次 rename） — exit=0 warn=true check=0 files=37 sameTree=true residue=0
```

- 若出现 `WARN … node_modules/.bin/tsc`：先 `pnpm install` 再跑。
- 若出现 `WARN …（附带观察）本次构建产物与仓库现有 dist/ 不一致`：说明仓库 `dist/` 是旧构建，
  先 `pnpm build` 让基线同步；该观察**不参与门禁判定**。
- 解读：macOS 的 `mv` 没有 `--exchange`，所以**真机上的普通 `pnpm build` 就走这条路径**；
  M1 只是把它变成可复现、可断言的检查（含产物正确性与暂存树清理）。

**M2（macOS 预期 PASS 或 WARN，两者都不是"门禁失败"）**

```text
[ OK ] M2 · APFS 大小写探针 … — 本卷大小写敏感，无别名（fileAliased=false sameInode=false dirAliased=false）
[WARN] M2 · APFS 大小写探针 … — 本卷大小写**不敏感**：仅大小写不同的 slug/id 会互相别名（fileAliased=true …）
```

- `WARN` 即 APFS 默认卷的预期结果。它**只报告**：是否在引擎侧加防御（例如禁止仅大小写不同的
  goal id / version slug）由负责人另行决策，本目标不擅自改核心行为。
- 请把该行原文回填，作为「APFS 别名风险是否已在真机证实」的结论。

**M3（macOS 应 PASS；Linux 上必为 WARN）**

```text
[ OK ] M3 · 软链 root 边界 … — tmpSymlink=true explicitRejected=true derivedRejected=false
```

- macOS 上 `/tmp → /private/tmp`：显式传入 `/tmp/...` 下的 root 必然被拒（这是既有设计），
  而 `process.cwd()` / realpath 得到的物理路径（`/private/tmp/...`）必须通过。
- `FAIL` 意味着物理路径也被拒 —— 那是会让 macOS 会话完全打不开看板的真实缺陷，需立即上报。

**M4（预期 PASS）**

```text
[ OK ] M4 · Linux-only 假设扫描 — 命中 N 处全部已被特性探测/回退覆盖（renameat2, mv-exchange）；archived 另 M 处仅列 INFO
                · 已覆盖 scripts/build.sh:119 [mv-exchange] — 同文件含 `mv --exchange --help` 能力探测 …
                · archived(不计门禁) scripts/archived/check-migration-fixtures.sh:53 [sha256sum] — 隐患：…
```

- 逐条读「已覆盖 / 隐患」两列：**隐患**项附有建议（例如 `sha256sum` ⇒ 改用 `shasum -a 256`）。
- `scripts/archived/**` 是已归档脚本，非发布路径，只列 INFO、不计门禁。
- 若发布/测试路径出现「隐患」，该行即 FAIL；修掉或补上能力探测+回退后同步判定表。

**T1–T5（转发的既有执行件）**

```text
[ OK ] T* · 转发 win-smoke-test.mjs（--tarball /Users/…/dsh-graph-0.16.0.tgz） — exit=0
```

- 末尾会打印 `dsh-graph Windows 冒烟 | 平台=darwin/arm64 …` 与 `总判定：PASS ✅` 及
  「注意：这是在非 Windows 上取得的 PASS…」——**这是既有口径，不是本脚本新增的限制**。
- macOS 上的 `T3` 必须真的跑通（建目标 / 判据 / 标签 CAS / 并发 / `validate`），这是本项目
  在 darwin 上的**有效证据**；但它**不能替代** Windows 真机结论。

**DSH_HOME 与 `/tmp` 软链（必读）**

`win-smoke-test.mjs` 会把隔离 `DSH_HOME` 做 **realpath** 后再使用：插件的 `resolveRoot` 会
**硬拒绝**路径中含软链的 root（`graph root symlink is not allowed`），而 macOS 的 `/tmp`、`/var`
都是软链（`/tmp → /private/tmp`、`/var → /private/var`）—— 不做 realpath 会在 macOS 上**假失败**。
所以报告里出现 `隔离 DSH_HOME：/private/var/folders/…（realpath of /var/folders/…）` 是**正常**的。
同理，手动传 `--dsh-home` 时请**直接给物理路径**（`realpath <dir>` 的结果），避免把设计上的拒绝
误读成缺陷。

---

## 6. 回填表（负责人填写）

| 项 | 结果（PASS/WARN/FAIL） | 原始行 / 备注 | 日期 |
| --- | --- | --- | --- |
| 平台与 Node |  | `平台=darwin/<arch> node=<ver>` | 待填 |
| 产物 sha256 核对 |  | `shasum -a 256 dsh-graph-0.16.0.tgz` =  | 待填 |
| M1 退化构建路径 | 待填 |  | 待填 |
| M2 APFS 大小写探针 | 待填 |  | 待填 |
| M3 软链 root 边界 | 待填 |  | 待填 |
| M4 Linux-only 假设扫描 | 待填 |  | 待填 |
| T1–T5（转发） | 待填 | 通过 / 失败 / 告警 计数 | 待填 |
| 总判定 / 退出码 | 待填 |  | 待填 |

**回填前的措辞纪律**：根 `README.md` 的平台行只能写「macOS 门禁执行件已就绪（v0.16.0），
真机结论待回填」；**在负责人回填真机结论之前，本项目不得对外声称 v0.16.0 的 macOS 已验证**
（与 Windows 红线 1 同构的纪律）。回填后由负责人在根 README 与
[`docs/release-checklist-v0.16.0.md`](release-checklist-v0.16.0.md) 同步更新措辞。

---

## 7. 相关文件

- [`scripts/macos-smoke-test.mjs`](../scripts/macos-smoke-test.mjs) —— 本页的执行件
- [`scripts/win-smoke-test.mjs`](../scripts/win-smoke-test.mjs) —— 被转发的跨平台门禁执行件
- [`scripts/build.sh`](../scripts/build.sh) —— 退化发布路径 + `BUILD_FORCE_TWO_RENAME` 测试注入
- [`core/tests/g359-two-rename-fallback.test.ts`](../core/tests/g359-two-rename-fallback.test.ts) —— 退化路径机器测试
- [`core/tests/g359-macos-gate.test.ts`](../core/tests/g359-macos-gate.test.ts) —— 执行件与 M4 判别力守卫
- [`docs/release-checklist-v0.16.0.md`](release-checklist-v0.16.0.md) §3 —— Windows 真机门禁与产物对账

> 本文档与 `scripts/`、`core/tests/` 一样**不进入 npm 发布包**（发布物只含 `dist/`），
> 故本页的增补**不会改变发布物指纹**。

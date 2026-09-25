# 平台门禁（macOS / Linux 合并执行件）

**执行件**：[`scripts/platform-smoke-test.mjs`](../scripts/platform-smoke-test.mjs)（单文件、纯 Node、零第三方依赖）
**状态（v0.17.0 / g-362）**：执行件已就绪，**Linux（WSL2）侧已实测全绿**（见 §6）；**macOS 侧结论待回填**（见 §7）。
**本页不预先声明 macOS 已验证。**

本页是**一份**跨平台门禁手册：执行件用法、检查分层、macOS 与 Linux 各自可直接粘贴的命令序列、
每项的预期输出与判读口径、取消项及其理由、以及结论回填位置。

> v0.16.0 的 macOS 专用手册 [`docs/macos-gate.md`](macos-gate.md) 已被本页取代（保留作历史记录）。
> 执行件也随之合并：`scripts/macos-smoke-test.mjs` 降为**转发 shim**，原 M1–M4 实现归档在
> [`scripts/archived/macos-smoke-test.mjs`](../scripts/archived/macos-smoke-test.mjs)（内容一字未改）。

---

## 1. 为什么合并成一份实现

v0.16.0 有 `win-smoke-test.mjs`（跨平台 T1–T5）+ `macos-smoke-test.mjs`（M1–M4）。macOS 与 Linux 的
门禁需求高度重叠（同一批 FS/locale 语义、同一批真实风险面），维护两份必然漂移：同一风险面要写两遍、
修一遍漏一遍。g-362 的裁决是**一份实现、平台差异只体现在判定口径与平台标注**：

- **同一份判定代码**：`judgeCaseSensitivity` / `judgeSymlinkRoot` / `judgeMountType` / `judgeConcurrentCas` /
  `judgeAtomicWrite` / `judgeExdev` / `judgeLocaleRoundTrip` 都是纯函数，macOS 与 Linux 走同一分支；
  差异只出现在「今日本机是哪一侧」与 WARN 的**影响说明措辞**（如 APFS 默认不敏感 vs Linux 上非 POSIX 语义）。
- **转发的 T1–T5 结论具平台效力**：在**原生 macOS/Linux** 上跑，`win-smoke-test.mjs` 的 T3–T5 是**真跑**
  （建目标/CAS/实例启动/REST 都真的发生）⇒ 结论**对本平台有效**。win 脚本自己打印的「非 win32 上
  T3–T5 只能证明脚本与代码可跑」是**针对 Windows 真机结论**的免责声明（发布红线 1），执行件会把这两层
  明确分开打印，避免误读。
- **不保留第二份实现**：`scripts/linux-smoke-test.mjs` 不存在（本目标明确不加）；旧 macOS 路径只留 shim，
  `core/tests/g362-platform-gate.test.ts` 用结构守卫钉住「shim 里不得出现任何判定函数/判定表」。

---

## 2. 执行件位置与用法

```text
node scripts/platform-smoke-test.mjs --skip-build                       # 秒级：P1–P3 + M4（跳过依赖 dist 的 P4/P5/P6）
node scripts/platform-smoke-test.mjs --static-only .                    # 秒级：P1–P6 + M4 + 转发的 T1 静态门禁
node scripts/platform-smoke-test.mjs --tarball ~/dsh-graph-<ver>.tgz    # 完整门禁：P1–P6 + M4 + 转发的 T1–T5
node scripts/platform-smoke-test.mjs --self-test                        # 离线自检（本脚本 + win-smoke）
node scripts/macos-smoke-test.mjs …                                     # 旧路径：打印取代提示后原样转发给新件
```

| 选项 | 作用 |
| --- | --- |
| `--tarball <file>` / `--spec <spec>` / `--path <dir>` / `--static-only <dir>` | 与既有 `win-smoke-test.mjs` 同义，**原样转发**（四者互斥；`--self-test` 可并存） |
| `--self-test` | 离线自检（本脚本判定逻辑 + 转发的 win-smoke 自检），不跑平台探针 |
| `--port` / `--profile` / `--dsh-home` / `--dsh` / `--timeout` | 一并转发 |
| `--repo <dir>` | 仓库根（默认本脚本所在目录的上一级） |
| `--temp-root <dir>` | 探测沙箱根（默认 `<repo>/tmp/platform-gate`） |
| `--skip-build` | 跳过依赖已构建 `dist/core/*.js` 的 P4/P5/P6（未 `pnpm build` 时）；**如实降级为 WARN，不伪装 PASS** |
| `--keep-temp` / `--json` | 保留探针临时目录 / 额外打印机器可读结果 |

**退出码**：`0` = 无 FAIL 且转发的执行件通过；`1` = 有 FAIL 项（或 `--self-test` 失败）；`2` = 用法错误
（未知选项、互斥来源）；其余 = 转发执行件的退出码。WARN **不**导致非零退出（只报告风险并要求人工判读）。

**沙箱纪律（必须遵守）**：`TMPDIR`、`--dsh-home`、npm 缓存一律落**仓库内 `tmp/`**——
沙盒（workspace-write）只允许写工作区，且 P1/P3 的大小写与挂载探针**只有与 graph root 同一文件系统**
才有意义（系统 `/tmp` 在 macOS 上是软链、在 WSL2 上常是 tmpfs）。执行件默认即如此，并会在报告里打印实际路径。

---

## 3. 检查分层

### 3.1 六项平台探针（P1–P6，判定口径随平台标注）

| 项 | 检查内容 | PASS | WARN | FAIL |
| --- | --- | --- | --- | --- |
| **P1** | 大小写敏感性：同目录建 `A` / `a`（文件 + 目录），看是否互相别名（同 inode / 同名归一） | 大小写敏感（两个不同实体） | 不敏感：仅大小写不同的 slug/id 会互相别名 ⇒ 附**平台口径**的影响说明（macOS 点出 APFS 默认不敏感；Linux 上的 vfat/exFAT 等点出非 POSIX 语义） | —— |
| **P2** | 软链 root 边界：显式传入**含软链**的 root 必须被拒（`graph root symlink is not allowed`），**物理路径**必须通过 | 两者都成立 | 未构建 `dist` / 无法建软链（未实测，不冒充通过） | 软链 root 未被拒（守卫失效）**或**物理路径也被拒（会话打不开看板） |
| **P3** | 挂载类型识别：读 `/proc/mounts`（Linux）或 `mount(8)`（macOS，先规范成同一形状），按最长前缀定位目标 FS，并用 `statfs` magic 交叉验证 | 本地盘（ext4/xfs/btrfs/apfs/hfs…） | 网络挂载（cifs/nfs/smb/sshfs…）/ tmpfs / WSL drvfs(`/mnt/*`) / overlayfs 叠加在非本地盘上 ⇒ 附影响说明（锁、原子性、易失性、别名） | —— |
| **P4.a** | 并发 CAS：4 个独立进程以同一 `base_tags` 抢写 | 恰好 1 成功 / 3 冲突 / 0 异常 | 未构建 dist 或 `--skip-build` | 出现 2 成功、0 成功、或任何异常 |
| **P4.b** | 原子写：16 并发写者 + 轮询读者（目标 FS 上） | 写者全成功、0 次撕裂读、最终内容完整、无 `.tmp.` 残留 | 同上 | 撕裂读 / 终态不完整 / 写者失败 / 有残留 |
| **P5** | 跨 FS `rename` 的 `EXDEV`：对可写的**第二文件系统**实测，并核对发布物 `replaceFileAtomic` 如实上抛（不静默降级为拷贝） | EXDEV + 源保留 + 目标未落地 + 代码上抛 | 无可写第二 FS（未实测）/ 非 EXDEV 错误（环境问题） | 静默降级为拷贝 / EXDEV 后源文件丢失 / 目标意外落地 |
| **P6** | locale / 编码：`LANG=C`、`LC_ALL=C` 下 `createGoal`(CJK 标题) + `setGoalDescription`(CJK 正文)，标题与正文**逐字节**出现在 `goal.md`、整文件 utf8 往返无损、`prompts` 资产逐字节可读且含非 ASCII | 全部成立 | 未构建 dist | 任一字节往返失败（locale 下的静默 mojibake 是真实数据损坏） |

### 3.2 平台无关附加检查：M4 发布脚本可移植性审计（承自 g-359）

`M4` 扫描 `scripts/*.sh|*.mjs`（顶层）与 `core/tests/**`，命中 `LINUX_ONLY_PATTERNS`（GNU/BSD 差异表：
`renameat2`、GNU `mv` 专有选项、`readlink -f`、`stat -c`、`md5sum`、`sha256sum`、无 backup 后缀的 `sed -i`、
`grep -P`、`date -d`、`cp --reflink`、无模板的 `mktemp -d`），逐处判「已被能力探测+回退覆盖」或「隐患」：
**发布/测试路径里的隐患 ⇒ FAIL**；`scripts/archived/**` 只列 INFO（非发布路径）；模式定义表自身豁免。
它守的是**发布脚本对 macOS/BSD 的可移植性**，与在哪台机器上跑无关 ⇒ 合并后仍保持存活并导出
（`LINUX_ONLY_PATTERNS` / `scanLinuxOnlyAssumptions` / `collectScanFiles` / `isCommentLine` / `ignoredLineMask`），
`core/tests/g359-macos-gate.test.ts` 的两个 M4 用例即从**新件**导入这组导出。

### 3.3 转发的既有门禁（T1–T5，由 `win-smoke-test.mjs` 执行）

不复制其逻辑，`--tarball/--spec/--path/--static-only/--self-test` 原样转发。在**原生 macOS/Linux** 上运行时，
其 T1–T5 结论**对本平台具平台效力**（T3–T5 真跑）；**Windows 真机结论仍必须由负责人在原生 Windows 上执行
`node scripts/win-smoke-test.mjs --tarball <tgz>`**（发布红线 1）——三条红线与职责边界见根 `AGENTS.md`「发布门禁」。

---

## 4. Linux 可粘贴命令序列

```bash
cd <repo>                                   # 建议用 worktree，避免在主树跑构建（AGENTS.md「构建隔离」）
export npm_config_cache="$PWD/tmp/npm-cache"  # 沙盒：npm/npx 缓存也落仓库内

# 4.1 秒级预检（不联网、不安装、不需要已构建 dist）
node scripts/platform-smoke-test.mjs --skip-build

# 4.2 静态门禁（需要已构建 dist：P4/P5/P6 依赖 dist/core/*.js）
bash scripts/build.sh
node scripts/platform-smoke-test.mjs --static-only .

# 4.3 完整门禁（P1–P6 + M4 + 转发的 T1–T5；会 npx 安装 DSH 并起隔离实例）
(cd dist && pnpm pack --pack-destination /tmp/… )   # 或在 dist/ 内 pnpm pack，产物挪到仓库内 tmp/
node scripts/platform-smoke-test.mjs --tarball "$PWD/tmp/dsh-graph-<ver>.tgz"

# 4.4 离线自检（确认执行件自身没坏；不装插件、不起实例）
node scripts/platform-smoke-test.mjs --self-test
```

**sha256 对账**（产物传递纪律：跨机器唯一渠道是 tarball）：`sha256sum tmp/dsh-graph-<ver>.tgz`，
与发布清单对账（v0.16.0 = `fe852e23…`；**本目标零发布物影响**：改造前后同一份源码重建 + `pnpm pack`
的 sha256 逐字节相同）。

---

## 5. macOS 可粘贴命令序列

macOS 自带 bash 是 **3.2**（无 `mapfile` / 关联数组 / `**`），执行件是 Node 实现，完全绕开 bashism。

```bash
# 5.0 前提：Node ≥ 22；仓库已 clone；在仓库内建 tmp/
cd <repo>
export npm_config_cache="$PWD/tmp/npm-cache"

# 5.1 把产物与执行件拷到 Mac 本地盘（跨机器唯一渠道是 tarball）
cp ~/Downloads/dsh-graph-<ver>.tgz tmp/
shasum -a 256 tmp/dsh-graph-<ver>.tgz          # 与发布清单对账（macOS 用 shasum，不是 sha256sum）

# 5.2 秒级预检（不联网、不安装）
node scripts/platform-smoke-test.mjs --skip-build

# 5.3 静态门禁（需要已构建 dist）
bash scripts/build.sh
node scripts/platform-smoke-test.mjs --static-only .

# 5.4 完整门禁（P1–P6 + M4 + 转发的 T1–T5）
node scripts/platform-smoke-test.mjs --tarball "$PWD/tmp/dsh-graph-<ver>.tgz"

# 5.5 离线自检
node scripts/platform-smoke-test.mjs --self-test
```

**macOS 上必须注意**：探测沙箱默认 `<repo>/tmp/platform-gate`（**不要**改到 `/tmp`、`/var` 之下 ——
那是软链，P2 会（正确地）拒绝，P1/P3 也不再与 graph root 同 FS）。完整门禁会起一个隔离实例
（`--dsh-home` 默认在 `<repo>/tmp/platform-gate/dsh-home-<时间戳>`），不触碰主 GUI。

---

## 6. 每项的预期输出与判读（Linux 实跑记录已回填）

逐项判定行形如：

```text
逐项判定（六项平台探针）：P1=PASS  P2=PASS  P3=PASS  P4=PASS  P5=PASS  P6=PASS
平台无关附加检查：M4=PASS（发布脚本可移植性审计，承自 g-359）
通过 8 项，失败 0 项，告警 0 项。
```

未运行过的项显示 `SKIP`（**不冒充 PASS**）；`--skip-build` 时 P4/P5/P6 显示 `WARN` + 原因。

**Linux（WSL2）实测记录 —— 2026-09-25，worktree `.worktrees/g-362-att-02`，node v26.7.0**：

| 项 | 实测结论 |
| --- | --- |
| P1 | `fsType=ext4 大小写敏感=true（A/a 是两个不同实体）` |
| P2 | `软链root被拒=true 物理路径被拒=false`（`repoPathSymlinked=false`） |
| P3 | `fsType=ext4 mount=…/g-362-att-02 source=/dev/sdd magic=ext2/3/4(0xef53) 表=/proc/mounts network=false tmpfs=false overlay=false drvfs=false wsl=true` ⇒ 本地盘 PASS（WSL2 内核，但 repo 在 ext4 上，非 drvfs） |
| P4.a | `成功=1 冲突=3 异常=0` |
| P4.b | `写者=16/16 读次数=23~42 撕裂读=0 最终完整=true 残留=0` |
| P5 | `secondFs=/dev/shm(tmpfs) dev 2096→156 rename=EXDEV 源保留=true 目标未落地=true replaceFileAtomic 抛出=true` |
| P6 | `locale=C 标题逐字节=true 正文逐字节=true goal.md往返=true prompts=14(非ASCII 14) prompts逐字节=true` |
| M4 | `扫描 98 个文件 ⇒ 命中 20 处（已覆盖 20 / 隐患 0）；archived 另 41 处仅列 INFO` |
| 转发 | `--static-only .` ⇒ T1 通过；`--tarball tmp/pack-final/dsh-graph-0.16.0.tgz` ⇒ 通过 10 / 失败 0 / 告警 0，`exit=0` |

单行证据（可直接粘贴）：

```text
evidence: suite=platform-gate.mjs probes=P1..P6+P4a/P4b result=PASS passed=8 failed=0 warn=0 exit=0 commit=<commit>
evidence: suite=platform-gate.mjs evidence: forwarded=tarball T1..T5 passed=10 failed=0 warn=0 exit=0 tarball_sha256=fe852e2353d5223ae6229bdc914eee32d8655df1c2fb96582a025dcd8e34f827
evidence: suite=core/tests node --test passed=1379 failed=0 skipped=0 exit=0
```

---

## 7. 回填表（负责人填写）

| 平台 | 执行日期 | 平台/架构 | Node | P1 | P2 | P3 | P4 | P5 | P6 | M4 | 转发的 T1–T5 | 结论 | 执行人 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Linux (WSL2) | 2026-09-25 | linux/x64 | v26.7.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 10/0/0 | **PASS**（已填） | agent:g-362-att-002 |
| macOS | 待填 | darwin/arm64 | | | | | | | | | | | |

回填时请一并粘贴「可复制回传的报告」整段（执行件在结论后自动打印），并在 `README.md` 平台范围段落更新结论。

---

## 8. 取消项及其理由（g-362 范围收窄，必须留痕）

| 项 | 原设想 | 取消理由（负责人裁决） | 处置 |
| --- | --- | --- | --- |
| **L1**（原 Linux 专检第 1 项） | 用 `BUILD_FORCE_TWO_RENAME=1` 强制 `build.sh` 的**退化发布路径**（无 `mv --exchange` 时两次 rename + 告警），在 Linux 上复刻 macOS 分支 | 该分支**已由 macOS 门禁的 M4 覆盖**（指针：`build.sh` 的 `mv --exchange --help` 能力探测 + 两次 rename 回退已被 M4 判为「已覆盖」，且真实 macOS 构建走的正是这条路径）⇒ 在 Linux 上人为强制是重复覆盖 | L1 的**代码与测试用例一并删除**（不在新件、不在新测试里） |
| **L5**（原 Linux 专检第 5 项） | 全仓库 GNU-only 假设审计（`readlink -f` / `stat -c` / `sha256sum` / `flock` / `cp --reflink` / `realpath -m` / `sort -V` / `xargs -r` / `find -printf` …） | 与 **M4** 是同一件事的两个实现（M4 自 g-359 起就在守这条），保留两份必然漂移 ⇒ 合并期只留 M4 | L5 **不实现**；M4 作为平台无关检查在新件里保持存活并导出（见 §3.2） |
| **`scripts/linux-smoke-test.mjs`** | 另开一个 Linux 专属执行件 | 「一份实现」是本次裁决：跨平台差异只体现在判定口径，不另开文件 | 不创建；若曾创建则删除（已删） |
| **`scripts/macos-smoke-test.mjs`（原实现）** | 继续维护 macOS 专属实现 | 同上；但**既有测试零削减**是硬约束 ⇒ 不能真删 | 降为**转发 shim**（打印取代提示 + 原样转发），原实现**归档**到 `scripts/archived/macos-smoke-test.mjs`（内容一字未改），既有用例只改 import 来源 |

---

## 9. 相关文件

- 执行件：[`scripts/platform-smoke-test.mjs`](../scripts/platform-smoke-test.mjs)（唯一实现）
- 旧路径（shim）：[`scripts/macos-smoke-test.mjs`](../scripts/macos-smoke-test.mjs) → 转发新件
- 归档：[`scripts/archived/macos-smoke-test.mjs`](../scripts/archived/macos-smoke-test.mjs)（M1–M4 原实现）+ [`scripts/archived/README.md`](../scripts/archived/README.md)
- 历史手册：[`docs/macos-gate.md`](macos-gate.md)（v0.16.0，已被本页取代）
- 转发的既有门禁：[`scripts/win-smoke-test.mjs`](../scripts/win-smoke-test.mjs)（T1–T5；Windows 真机门禁执行件）
- 测试守卫：[`core/tests/g362-platform-gate.test.ts`](../core/tests/g362-platform-gate.test.ts)（本次新增）、[`core/tests/g359-macos-gate.test.ts`](../core/tests/g359-macos-gate.test.ts)（用例零削减，仅改 import）

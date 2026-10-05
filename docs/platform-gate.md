# 平台门禁（macOS / Linux 合并执行件）

**执行件**：[`scripts/platform-smoke-test.mjs`](../scripts/platform-smoke-test.mjs)（单文件、纯 Node、零第三方依赖）
**状态（v0.16.1 / g-362）**：执行件已就绪，**Linux（WSL2）侧已实测全绿**（见 §6）；**macOS 侧结论待回填**（见 §7）。
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

**转发的执行件 `win-smoke-test.mjs` 另有自己的入口**（g-428 新增两项；Windows 真机门禁按第 1 行执行）：

```text
node scripts/win-smoke-test.mjs --self-test            # 秒级：判定逻辑 + 台账 + 步骤清单的自检（必须打印「自检全部通过。」）
node scripts/win-smoke-test.mjs --static-only .        # 秒级：T1 静态门禁 + T1 台账层，并打印完整覆盖清单
node scripts/win-smoke-test.mjs --mutation-check       # 分钟级：负向对照（需已构建 dist/），实拍「定向突变必红」
node scripts/win-smoke-test.mjs --tarball <tgz>        # 完整门禁（含 Windows 真机门禁的 T1–T5 + 32 步生命周期）
```

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

### 3.4 Windows 真机门禁的覆盖清单（g-428：清单式全覆盖 + 防漂移）

**动机是真实漏检，不是理论风险**：v0.18.0 的 Windows 真机 T1–T5 **全绿**（见 §7 回填表），却漏掉了
g-427 —— **目录形态的目标移入版本泳道在 Windows 上必然 EPERM、重试永不收敛，还会留下一个空目标目录**。
根因不在判定口径，而在**覆盖面**：旧 T3 只调 `init / createGoal / setCriteria / setGoalTags / validate`，
看板的**文件系统生命周期零覆盖**，而缺陷正落在那条无人走过的路径上。

故 `win-smoke-test.mjs` 现在由三层组成，**任一层不成立即判红**：

| 层 | 内容 | 判红条件 |
| --- | --- | --- |
| **T1 台账层**（新） | 静态枚举产品代码（`core/*.ts`、`dsh-graph-host/index.js`、`lib/**/*.js`）里的每一个 OS 相关调用点，逐项登记「风险面 + 映射（`ws:<冒烟步骤>` / `pg:<平台探针>`）或豁免理由」 | **未登记 ⇒ 红**；命中数或顶层函数集合与清单不一致（漂移）⇒ 红；清单项在实现里消失（幽灵项）⇒ 红；映射指向不存在的步骤/探针 ⇒ 红；豁免理由过短 ⇒ 红 |
| **T3 清单式生命周期**（新） | 真跑安装包的 `core/ops.js`：32 步看板文件系统生命周期，每步都断言**磁盘最终状态** | 任一步失败；步骤清单与实跑集合不一致；失败路径文案泄漏平台错误码；盘面出现双份/残留空目标目录/锁残留；`tx.persist_failed` 计数不符 |
| **负向对照** `--mutation-check`（新） | 对已构建包的 `core/ops.js` 做定向突变，实拍「对应检查必红」 | 突变后仍全绿（对照无鉴别力）；基线（未突变）已红；旧顺序突变未泄漏 EPERM（说明「不泄漏错误码」这条断言没有鉴别力） |

#### 3.4.1 T1 台账层：按文件的风险面与覆盖方式

当前清单 **65 项 / 命中 253 处 / 扫描 16 个文件（其中 9 个文件含 OS 调用点）/ 忽略处数 0**
（`忽略处数` 每次都打印；有意的例外只能走**成对标记** `dsh-win-os-ledger:ignore-os-sites` … `:end-…`，
标记不配对直接抛错，不存在静默放宽）：

| 文件 | 登记项 | 命中 | 覆盖方式（映射 / 豁免） |
| --- | --- | --- | --- |
| `core/ops.ts` | 22 | 133 | 冒烟 16 步 + 探针 P4.b + 豁免 2 |
| `core/platform.ts` | 12 | 40 | 冒烟 3 步 + 探针 P4.b/P1 |
| `core/transaction.ts` | 10 | 42 | 冒烟 2 步 + 探针 P4.b |
| `core/events.ts` | 6 | 10 | 冒烟 1 步 + 探针 P4.b |
| `core/version-lane.ts` | 5 | 13 | 冒烟 1 步 + 探针 P1 + 豁免 3 |
| `dsh-graph-host/index.js` | 4 | 7 | 冒烟 1 步 + 豁免 3 |
| `core/root.ts` | 3 | 4 | 冒烟 2 步 + 探针 P2 + 豁免 1 |
| `core/worktree.ts` | 2 | 3 | 豁免 2 |
| `core/cache.ts` | 1 | 1 | 豁免 1 |

**豁免项（12 项，全部带理由；「同 API 语义已由其它步骤覆盖」也算理由，但必须指名是哪个步骤）**：

| 站点 | 风险面 | 豁免理由 |
| --- | --- | --- |
| `core/cache.ts#statSync` | 看板缓存新鲜度探测（mtime+size，只读） | 只读探测、无平台分叉，不进 T3 写路径 |
| `core/ops.ts#caseAlias` | 附件路径的卷大小写别名解析（g-364） | 需真实大小写不敏感卷或注入；平台语义由 `pg:P1` 探测，注入复现见 `core/tests/g364-*` |
| `core/ops.ts#crlf` | 用户文本 CRLF 归一（纯字符串，无 FS 语义） | 字符串归一、无平台分叉；Windows 真机由 T3 全链路读写间接覆盖 |
| `core/root.ts#statSync` | git 元数据 mtime 探测（根新鲜度） | 仅只读 git mtime 探测，无写路径 |
| `core/version-lane.ts#renameSync` | 版本目录改名（`renameVersion`） | 版本改名走独立入口、T3 不触发；目录 rename 同 API 语义由 `ws:T3.layout_s1_to_version` 覆盖 |
| `core/version-lane.ts#rmdirSync` | 版本目录自底向上删除 | `deleteVersion` 走独立入口、T3 不触发；rmdir 空目录同 API 语义由 `ws:T3.layout_s1_to_backlog` 覆盖 |
| `core/version-lane.ts#rmSync` | 版本删除的文件清理 | `deleteVersion` 走独立入口、T3 不触发；rm 同 API 语义由 `ws:T3.dir_delete_archived` 覆盖 |
| `core/worktree.ts#mkdirSync` | worktree 目录创建（`.worktrees`） | worktree 管理需 git 仓库，不在看板冒烟范围 |
| `core/worktree.ts#realpathSync` | worktree 路径 realpath（软链保护） | 同上；软链 root 边界另见 `pg:P2` |
| `dsh-graph-host/index.js#crlf` | 去重键的 CRLF 归一 | 宿主端字符串归一，无 FS 语义 |
| `dsh-graph-host/index.js#realpathSync` | workspace canonical key / worktree 真实路径 | 宿主 workspace 归一由 T4/T5 间接覆盖；软链拒绝见 `pg:P2` |
| `dsh-graph-host/index.js#statSync` | 文件 mtime 探测（REST 载荷） | 只读探测；REST 读路径由 T5 覆盖 |

**显式非目标 API**（口径也登记在案，避免「为什么不查它」变成隐性判断）：
`readFileSync` / `writeFileSync` / `appendFileSync`、`readdirSync`、`existsSync`、`cpSync` / `copyFileSync`、
`chownSync` / `utimesSync` / `watch` / `watchFile`、`closeSync` / `readSync` / `writeSync`。

> 完整的 65 行清单（含每项的顶层函数名与命中数）由执行件打印：
> `node scripts/win-smoke-test.mjs --static-only .` ⇒ 「覆盖清单（文件 | API | 命中 | 顶层函数 | 风险面 | 映射/豁免）」。
> **不要**把那份清单手工抄进文档（必然漂移）：本页只写**汇总与豁免理由**，真源是 `OS_SITE_ROWS`，
> 一致性由 `core/tests/g428-win-os-ledger.test.ts` 钉住。
>
> 台账需要**产品源码**（`core/*.ts`）：在仓库根运行时扫描仓库源码；若在仓库之外、只对着一个已安装的
> 发布包运行（包内只有编译产物 `dist/core/*.js`），台账层会**如实降级为 WARN**并提示改用
> `--static-only .`，**不会**伪装 PASS。⇒ **Windows 真机门禁请在仓库根执行**（`git clone` 后 `bash scripts/build.sh` 再跑）。

#### 3.4.2 T3 清单式生命周期：32 步，每步都核对磁盘

| 分组 | 步骤（id） | 每步断言的磁盘事实 |
| --- | --- | --- |
| 基座 | `init_create` / `set_criteria` / `tags_write` / `tags_cas_overwrite` / `tags_cas_conflict` / `tags_clear` | 建目标/判据落盘；标签 CAS 的三态（写、覆盖、冲突必被拒） |
| 布局往返 | `layout_s1_create` / `layout_s1_to_version` / `layout_s1_to_standalone` / `layout_s1_to_backlog` / `layout_s1_to_standalone_again` | 目录形态 ↔ 扁平形态双向搬迁：**源位置必须消失、目标必须完整**（`goal.md` + `cards/`），且该目标在整块板上**恰有 1 份** |
| 卡片 / attempts / 附件 | `cards_own_and_shared` / `attempts_dir_present` / `attachments_store_delete` / `memory_roundtrip` | 目标自有卡与共享卡各自落盘；`attempts/` 随目标**整体**搬迁；附件原子删除走 trash 往返；记忆 jsonl + 锁往返 |
| 锁 | `tx_lock_reclaim` / `tags_lock_stale_reclaim` | 正常释放、死进程抢占、坏锁隔离回收；陈旧标签锁（死 PID + 过期 mtime）回收 |
| 生命周期（g-427 形态） | `lifecycle_move_dir_with_extras` / `lifecycle_move_back_to_version` / `lifecycle_archive_version_form` / `lifecycle_unarchive_version_form` / `lifecycle_postpone` / `lifecycle_backlog_dir_to_version` | **目录形态带 `cards/`+`attempts/` 搬迁**（g-427 现场）：归档 / 取消归档 / 暂缓（→ backlog 目录形态）/ 目录形态 → 版本泳道 |
| 失败路径 | `delete_fixture_create` / `failure_nonempty_target` / `failure_retry_converges` | 预置**非空**目标目录 ⇒ 明确业务错误（含目标路径 + 「已存在/非空」语义，**无平台错误码**），源与阻碍物都完好，`tx.persist_failed` 恰好 +1；排除阻碍后**重试收敛** |
| 扁平形态 + 删除 | `flat_create_and_move` / `flat_archive_unarchive` / `dir_delete_archived` / `flat_archive_delete` | 扁平 backlog ↔ 独立互转；归档后删除（目录形态连 `cards/`+`attempts/` 整目录清掉、扁平形态清 `.md`）；`goal.deleted` 事件落地 |
| 收尾 | `locks_and_board_summary` / `validate` | 无锁/临时产物残留、无残留空目标目录、**全板目标无重复**、`persistFailed == 预期`；`validate` 返回空 |

两条**结构性**自证（防止覆盖面被悄悄删小）：

1. **清单 ≡ 实跑**：执行件内的 `WIN_SMOKE_STEP_IDS` 必须全部真的跑过，且实跑集合里不得出现清单外的步骤（双向）。
2. **`--self-test` 反查**：`--self-test` 断言每个步骤 id 都出现在内嵌冒烟源里，并断言关键算子
   （`moveGoal` / `archiveGoal` / `unarchiveGoal` / `postponeGoal` / `deleteGoal` / `storeAttachment` /
   `deleteAttachment` / `addCard` / `setGoalTags` / `validate` …）与盘面断言（「源位置未消失」「在板上出现 N 份」
   「未随目录整体搬迁」「残留空目标目录」「锁/临时产物残留」）仍在文本里。

#### 3.4.3 负向对照：`--mutation-check`（判定力必须被实拍）

Linux 上**无法**用「还原旧顺序」自然复现 g-427（POSIX 的 `rename(dir, emptyDir)` 会成功），故对照以
**定向突变**做成，并且**先跑一次未突变基线**证明红是突变引起的：

```text
node scripts/win-smoke-test.mjs --mutation-check            # 需要已构建 dist/（worktree 内先 bash scripts/build.sh）
```

| 突变 | 期望结果 |
| --- | --- |
| 基线（未突变，同一夹具） | 32 步全通过、`validate` 空 |
| ① 还原 g-427 旧顺序（先建目标目录再 rename） | 首个失败步骤必须落在 **g-427 形态步骤**里，且文案**泄漏 `EPERM`** ⇒ 同时证明「不泄漏平台错误码」这条断言有鉴别力 |
| ② 搬迁退化为复制（残留双份） | 必须报出「该目标在板上出现 2 份」 |

突变形状识别失败（源码结构变了）⇒ 返回 `null` 并**判红**，绝不做一次静默无效的对照。

#### 3.4.4 v0.18.0 漏检记录（g-427，必须留痕）

| 项 | 内容 |
| --- | --- |
| 现象 | Windows 真机把**目录形态**目标移入版本泳道**必然 EPERM**；**重试永不收敛**；并在目标位置留下一个**空目标目录**；错误文案直接抛平台错误码 |
| 当时结论 | v0.18.0 Windows T1–T5 **全绿**（§7 回填表那一行）——因为旧 T3 完全不碰看板文件系统生命周期 |
| 影响面 | 单机用户的**常规操作**（目标归类到版本、归档、暂缓）在 Windows 上会失败；POSIX 上不可复现 ⇒ Linux/WSL2 全绿**不能**发现 |
| 修复 | `core/ops.ts` 新增 `renameDirInto`（只建父目录、回收遗留空目标目录、抛带路径与「已存在/非空」语义的 `GraphError`），4 个调用方（`moveGoal` / `archiveGoal` / `unarchiveGoal` / `postponeGoal`）统一改走它 |
| 防再犯（本目标） | 覆盖面上移到**清单式**：台账层逐调用点登记 + T3 32 步生命周期 + 每步盘面断言 + 清单≡实跑 + `--mutation-check` 必红实拍 |
| **仍未关闭** | **Windows 原生真机结论未取得**（本目标只在 Linux 上验证脚本与判定力）。README 与 §7 必须如实标注「未执行真机门禁」，真机结论由负责人在原生 Windows 上跑一次后回填 |

#### 3.4.5 维护指令（改了产品代码或加了步骤怎么办）

1. **新增/改动任何 OS 调用点** ⇒ `node scripts/win-smoke-test.mjs --static-only .` 会打印
   `[FAIL] OS 调用点覆盖清单（台账层） — … [unregistered] core/xxx.ts#renameSync …`；
   在 `scripts/win-smoke-test.mjs` 的 `OS_SITE_ROWS` 里补一行
   `["core/xxx.ts", "renameSync", <命中数>, ["<顶层函数>"], "<风险面>", "ws:<步骤>|pg:<探针>|exempt:<理由>"]`
   后复跑即可（映射必须指向**真实存在**的步骤/探针 id，否则判红）。
2. **新增冒烟步骤** ⇒ 把 id 加进 `WIN_SMOKE_STEP_IDS`，并保证内嵌冒烟源里真的 `step("<id>", …)`（否则 `--self-test` 判红）；
   若属 g-427 形态（目录搬迁）还要加进 `G427_FORM_STEP_IDS`。
3. **改动判定逻辑** ⇒ 在 `selfTest()` 里补**正反例**（真问题必红 + 干净样本必绿），再跑
   `node scripts/win-smoke-test.mjs --self-test`（必须打印 `自检全部通过。`）。
4. **每次改动后**跑三件套：`--self-test` / `--static-only .` / `--mutation-check`，外加
   `node scripts/platform-smoke-test.mjs --skip-build` 与 `--static-only .`（P1–P6 + M4 不得回退），
   最后跑整套件自证闸门 `node scripts/run-tests.mjs`。

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
| Linux (WSL2) · **v0.17.0** | 2026-09-30 | linux/x64 | v26.7.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 10/0/0 | **PASS**（已填；完整段 P1–P6/M4 = 9/0/0 + 转发 T1–T5 = 10/0/0，宿主 `0.2.0-rc.2`，端口 3095，最终包 sha256 `b5b3e0a4…`） | agent:独立验证者（v0.17.0 发布收尾） |
| Windows · **v0.18.0** | 2026-10-01 | win32/x64 | v24.13.0 | — | — | — | — | — | — | — | 10/0/0 | **PASS**（T1–T5 全过；宿主 `0.2.0-rc.2`，端口 3088；**被测产物即发布候选包** `dsh-graph-0.18.0.tgz` sha256 `3ae728dd…` 570157 B）<br>⚠️ **但漏检 g-427**：目录形态目标移入版本泳道在 Windows 上必然 EPERM、重试不收敛、残留空目标目录（根因=覆盖面，见 §3.4.4）⇒ 该行的 PASS **不代表**看板文件系统生命周期已被覆盖 |
| macOS · **v0.18.0** | 2026-10-01 | darwin/arm64 | v26.8.2 | — | — | — | — | — | — | — | 10/0/0 | **PASS**（非 win32 口径：T1/T2 结论有效，T3–T5 只证明脚本与代码可跑、**不替代 Windows 真机结论**；被测产物同 `3ae728dd…`；tarball 路径不跑 `build.sh` ⇒ BSD rename 回退仍未验证） |
| Windows · **v0.19.0-alpha**（g-428 覆盖清单版） | **待负责人执行** | — | — | — | — | — | — | — | — | — | **待回填** | **未执行真机门禁**（不得读出「已通过」）。执行 `node scripts/win-smoke-test.mjs --tarball <tgz>`，回填时请粘贴结论后的「可复制回传的报告」整段（其中含 `覆盖=台账=<N>项/<M>处命中（忽略<K>行）  T3生命周期=<S>步（g-427 形态 8 步，每步盘面断言）`一行） | 负责人 |

回填时请一并粘贴「可复制回传的报告」整段（执行件在结论后自动打印），并在 `README.md` 平台范围段落更新结论。
该报告块自 g-428 起额外含 **`覆盖=…`** 一行（台账项数/命中数/忽略处数 + T3 生命周期步数），
它是「真机到底覆盖了什么」的对账依据 ⇒ **回填时必须连同这一行一起粘贴**；
若该行缺失或台账显示 `忽略处数 > 0`，视为回填不完整（后者需在 §3.4.1 补登理由）。

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
- 转发的既有门禁：[`scripts/win-smoke-test.mjs`](../scripts/win-smoke-test.mjs)（T1–T5；Windows 真机门禁执行件；
  g-428 起另含 **T1 台账层**（`OS_SITE_ROWS` / `OS_SITE_REGISTRY` / `auditOsSiteLedger`）、**32 步清单式 T3 生命周期**、
  负向对照 `--mutation-check`）
- 测试守卫：[`core/tests/g362-platform-gate.test.ts`](../core/tests/g362-platform-gate.test.ts)（本次新增）、[`core/tests/g359-macos-gate.test.ts`](../core/tests/g359-macos-gate.test.ts)（用例零削减，仅改 import）、[`core/tests/g428-win-os-ledger.test.ts`](../core/tests/g428-win-os-ledger.test.ts)（g-428：台账与实现同步、未登记即判红、步骤清单≡实跑、判定力正反例、`--mutation-check` 必红实拍）
- P1 的下游影响面：[`docs/case-alias-naming.md`](case-alias-naming.md)（g-364：真实命名入口在大小写不敏感卷上的保护现状、注入复现方式与平台实测状态）

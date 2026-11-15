# g-629 分层实测记录（att-002：focused 重构为专题集合 + microTests）

基线 `95bbc9e`（`v1.0.0-test`）。所有数据均在**专属 worktree** `.worktrees/g-629-att-02` 内、
先跑 `bash scripts/build.sh` 得到新鲜 `dist/` 后**实测**，由 `node scripts/test-tier.mjs <集合>` 驱动
（入口把显式文件列表交给 `node scripts/run-tests.mjs`，判定全部继承）。**没有任何数字来自「串行耗时之和」的估算。**

机器：WSL2 / Node v26.7.0，单机单用户。`TMPDIR=/tmp`（**必须**在仓库外：设在仓库内会让
`g314`/`g316` 的「非工作区」用例把仓库自身当成工作区而假红）。

## 各层实测

| 集合 | 文件数 | 测试数 | 墙钟 | 结果 |
| --- | --- | --- | --- | --- |
| `shakedown`（**日常推荐**） | 207 | 2488 | **48.4 s** | ✔ exit 0 / fail 0 / skipped 0 / todo 0 / cancelled 0 |
| `integration` | 252 | 3069 | 58.7 s | ✔ exit 0 / fail 0 / skipped 0 / todo 0 / cancelled 0 |
| `full` | 259 | 3138 | 97.8 s | ✔ exit 0 / fail 0 / skipped 0 / todo 0 / cancelled 0 |
| `everything`（入口） | 261 | 3144 | 104.2 s | ✔ exit 0 / fail 0 / skipped 0 / todo 0 / cancelled 0 |
| `focused`（全部专题并集） | 78 | 713 | 42.6 s | ✔ exit 0 / fail 0 |

发布门禁对照：

| 门禁 | 文件数 | 测试数 | 墙钟 | 结果 |
| --- | --- | --- | --- | --- |
| `node scripts/run-tests.mjs`（无参） | 261 | 3144 | 100.5 s | ✔ 自证通过（`glob=core/tests/*.test.ts`） |
| `node --test core/tests/*.test.ts` | 261 | 3144 | 96.8 s | ✔ exit 0 |

## 加速比（实测，非估算）

- **shakedown 相对全量：100.5 s ÷ 48.4 s ≈ 2.08×**（测试数 2488 / 3144 ≈ 79%）
  —— 这才是**日常开发用的层**。
- `focused/gate-integrity`（门禁专题）相对全量：`8.8 s`，**≈ 11.4×** —— 专题的按需价值在这里。
- `integration` 相对全量：≈ 1.71×；`full` 相对全量：≈ 1.03×。

> **加速比的诚实说明**：shakedown 的 2.08× 不是「测试数比例」带来的（83% 的测试仍在里面），
> 而是**把真实等待/构建链/真实宿主那一小批最贵的文件移出日常层**的结果。
> 若把三大家族里单价高的 `g507-http-auth-surface`（20 s）、`g507-evidence-collect`（20 s）、
> `g507-http-auth-real-host` 也移出，shakedown 还能再快一倍 —— 但那是**不允许**的取舍
> （负责人硬约束：安全/隔离/门禁必须有日常覆盖），本表刻意保留它们。

## 单次采样噪声

以上每格为**单次**采样。同机重复运行的典型抖动约 **±10%**（参照：`full` 与 `everything` 是
**同一文件集合**，两次测得 97.8 s 与 104.2 s，差 6.6%；无参门禁 100.5 s 与 `node --test` 96.8 s，
差 3.8%）。⇒ 加速比 2.08× 的合理区间约为 **1.9×–2.3×**；不要把它读成精确倍数。

## 各 focused 专题实测

| 专题 | 文件数 | 测试数 | 墙钟 | 结果 |
| --- | --- | --- | --- | --- |
| `focused/rc3-host-compat` | 10 | 158 | 1.3 s | ✔ |
| `focused/event-first` | 6 | 55 | 2.2 s | ✔ |
| `focused/gate-integrity` | 12 | 161 | 8.8 s | ✔ |
| `focused/auth-surface` | 6 | 41 | 21.1 s | ✔ |
| `focused/reuse-baseline` | 17 | 117 | 21.9 s | ✔ |
| `focused/care-budget` | 27 | 181 | 37.7 s | ✔ |
| **全部专题并集** | 78 | 713 | 42.6 s | ✔ |

专题之间成本差异极大（1.3 s 到 37.7 s），这正是「按需调用」的意义：修门禁相关问题时只跑
`focused/gate-integrity`（8.8 s），不必等 37.7 s 的关照链专题。

## 集合关系（实测，非声明）

```
shakedown 207  ⊊  integration 252 (+45)  ⊊  full 259 (+7)
                                              everything 261 = full 259 ∪ microTests 3 (含守卫自身 1 个)
```

- `full` 与 `microTests` **不相交**；`full ∪ microTests` 与磁盘 261 个文件**双向相等**（已逐文件比对）。
- `everything` 经入口展开的 261 个文件与 `ls core/tests/*.test.ts` 逐项 `diff` **完全相同**。
- `focused` 6 个专题共 78 个文件（并集），**全部与日常层重叠**（这是有意的语义，见 `docs/test-tiers.md` §3）。

## 成本来源（逐文件串行实测，非并发）

| 文件 | 单跑墙钟 | 成本来源 | 归属 |
| --- | --- | --- | --- |
| `g618-care-wake-compact.test.ts` | 61.4 s | 以 60 s `waitFor` 上限等待 300 s 冷却（等不到即超时） | full + perf |
| `g612-att009-budget-fields.test.ts` | 35.1 s | 真实关照/预算计时 | integration + perf |
| `g612-d2-old-outcome-multitarget.test.ts` | 31.9 s | 同上 | integration + perf |
| `g612-d1-budget-edit-after-care.test.ts` | 31.0 s | 同上 | integration + perf |
| `g353-build-chain-boundaries.test.ts` | 24.3 s | 构建链嵌套 runner | integration |
| `client.test.ts` | 23.6 s | 160 个子用例，每个都跑真实 `git` 夹具 | integration |
| `root.test.ts` | 21.0 s | UI bundle 全量断言 | integration |
| `g628-resumed-care-effects.test.ts` | 20.9 s | 真实宿主关照效果 | integration + perf |
| `g507-http-auth-surface.test.ts` | 20.3 s | 真实宿主 HTTP 面 | **shakedown**（安全家族）+ variant |
| `g507-evidence-collect.test.ts` | 20.2 s | 真实等待 + token 脱敏 | **shakedown**（安全家族）+ perf |
| `g355-mock-seed-shared-card.test.ts` | 19.2 s | 共享池 + 真实等待 | integration |
| `g613-reuse-idle-child.test.ts` | 18.8 s | 真实 child 复用 | integration + variant |
| `g348-atomic-build.test.ts` | 13.7 s | 真实构建 + 并发读者 | integration |
| `g316-claim.test.ts` | 6.7 s | 真实 CLI + git 沙箱 | shakedown |

> `g507-http-auth-surface` 与 `g507-evidence-collect` 单跑各约 20 s，仍按**安全家族硬约束**留在
> 日常层 —— shakedown 的 48.4 s 中约 40 s 来自这两个文件与门禁家族。这是「宁可更慢也要守安全」的有意取舍。

## 复测命令

```bash
bash scripts/build.sh                              # 必须先构建，否则 dist 陈旧会大量假红
export TMPDIR=/tmp                                 # 必须在仓库外（g314/g316 假红）
node scripts/test-tier.mjs shakedown               # 日常
node scripts/test-tier.mjs --list                  # 各层 / 专题 / 标签规模
node scripts/test-tier.mjs focused/gate-integrity  # 按需专题
node --test core/tests/g629-tier-manifest.test.ts  # 分层清单一致性 + 7 类反向变异
node scripts/run-tests.mjs                         # 发布门禁（全量自证）
```

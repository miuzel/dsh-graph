# 测试分层（按文件集合 × 两条正交轴）与 g-326 三档（按改动性质）

> 本文件是 **g-629** 的交付说明。**三条维度正交并存**，互不替代：
>
> | 维度 | 问的问题 | 真源 | 产物 |
> | --- | --- | --- | --- |
> | **日常回归梯度**（本文件 §2） | 日常该跑哪一档 | `core/tests/tier-manifest.json` 的 `tiers` | `node scripts/test-tier.mjs <层>` |
> | **focused 专题集合**（本文件 §3） | 某次重大修复/事故后，**按需**重跑哪些验证 | 同文件的 `focused.topics` | `node scripts/test-tier.mjs focused/<专题>` |
> | **g-326 三档** | 这一次改动**该配多重的测试力度** | `prompts/executor-discipline.zh.md` 第 3 条 | 执行者遵守的纪律，无命令 |
>
> 举例：一次「纯文案」改动（g-326 一档）日常只跑 `shakedown`；一次「核心层重写」（三档）
> 要跑 `integration` 乃至 `everything`。**梯度决定日常范围，专题决定按需验证面，三档决定力度。**

## 1. 发布门禁没有变

**发布门禁仍是无参 `node scripts/run-tests.mjs`**（= 磁盘全集 `core/tests/*.test.ts`）。
它的 `TEST_GLOB = "core/tests/*.test.ts"` 字面量与无参行为**未被本目标改动**（g350/g413/g415 守卫钉住）。

分层入口 `scripts/test-tier.mjs` 是**日常开发更快的入口**，不是发布门禁的替代品：

```bash
node scripts/run-tests.mjs          # ← 发布门禁：磁盘全集，权威，自证
```

## 2. 日常回归梯度（`tiers`）

层级按 **include 派生**，`files` 是本层**新增**，实际集合 = include 链并集：

```
shakedown  ⊊  integration  ⊊  full          everything = full ∪ microTests = 磁盘全集
（日常主力）   （+真实宿主/构建链/UI）  （+重且低风险/平台/待核验）   （+细小低风险，仅 everything）
```

| 层 | 定位 | 纳入依据（**不按时长、不按文件名**） |
| --- | --- | --- |
| `shakedown` | **日常推荐层** | 纯 core：零真实宿主、零构建链、零长时间真实等待；**含三大家族全部文件** |
| `integration` | 主流程与 DSH 宿主集成 | 真实宿主栈（`makeRealHost`/`loadHostStack`）、真实 HTTP/端口、`build.sh`/`dist` 产物依赖、UI bundle、真实 CLI、真实等待/计时 |
| `full` | 完整回归边界 | integration + 重且低风险/平台专属/待核验项；**排除** `microTests` |
| `everything` | 磁盘全集 | `full ∪ microTests`；由入口按磁盘展开，**不登记**进 manifest（新增未分类文件因此会被守卫发现） |

- **层间不重复登记**：同一文件只写在一层的 `files` 里（守卫检查，重复即红）。
- `full ∪ microTests` 与磁盘 `core/tests/*.test.ts` **双向相等**：磁盘多一个、少一个都判红并点名。

### 2.1 `microTests`：细小低风险、舍不得删、只挂 everything

负责人原话：「everything 应包含一些细小的无需测试的一些测试用例，但又舍不得删的」。

下放**不是**凭文件名归类，逐项须同时满足（守卫 `g629-tier-manifest.test.ts` 逐项复算）：

1. **断言数 ≤ 8**（守卫真数源码里的 `assert.<method>(`）；
2. **不属于三大家族**（安全/鉴权、隔离、门禁防伪绿）；
3. **不依赖构建产物**（禁止 `import …/dist/…`）与逐字 ID / 长等待；
4. **仍有辨识力**：文件内自带负向对照，证明「改坏必红」（非恒真）。

| 文件 | 证据（代码复核） | 为谁而建 / 防什么复发 |
| --- | --- | --- |
| `g614-readme-gate-scope.test.ts` | 1 用例 / **4 assert** / 7 条具名检查；只读 `dsh-graph-host/README.md` 两行文案 | g-614：防「把 `0.2.0-rc.2` 及更早的行为误标成某版本起引入」的文案误导 |
| `guide-format-g340.test.ts` | 2 用例 / **5 assert**；只读 `prompts/supervisor-guide.{zh,en}.md` | g-340：指南格式红线此前**零机器守护**，防「g-编号/本次/标题版本号」回流 |
| `g434-script-var-multibyte-guard.test.ts` | 3 用例 / **8 assert**；纯读 `scripts/*.sh` | g-434：`$VAR` 紧跟全角字符被 macOS bash 3.2 吞并 ⇒ 源码构建 100% 失败 |

### 2.2 反例清单：这些「看着简单」为什么**不能**下放

| 文件 | 断言/用例 | 不可下放的理由 |
| --- | --- | --- |
| `g466-readme-host-range-badge.test.ts` | 18 assert | 不止文案：含 7 类变异对照 + `engines` 字段真源交叉核验 |
| `g371-changelog-guard.test.ts` | 13 assert | `EXPECTED_SECTIONS` 快照 + 6 组变异对照，属发布文档结构契约 |
| `g281-criteria-feedback-copy.test.ts` | 16 assert | 不只文案：双语 1:1 + `dist` 产物契约 + 资产正文逐字 |
| `g272-worktree-badge-i18n.test.ts` | 37 assert | i18n 对称 + `vm` 真实渲染，assert 远超上限 |
| `g408-check-dist-not-readonly.test.ts` | 11 assert | 发布门禁安全性（`pnpm check:dist` 非只读），属门禁域 |
| `g359-two-rename-fallback.test.ts` | 23 assert | 构建原子发布回滚/失败关闭，发布安全性 |
| `g616-care-coalesce*.test.ts` | 45 assert | 关照调度状态机，有真实计时语义 |
| `g389-literal-section-interpolate.test.ts` | 20 assert | 提示词字面段落插值契约，非纯文档 |
| `g313-architecture-eval-guard.test.ts` | 22 assert | 架构评估守卫，跨文件契约 |
| `prompt-newline-escape-g331.test.ts` | 6 assert | **轻量但有副作用**：`import ../../dist/core/ops.js`（构建产物依赖）+ 写 `tmp/` 重建数据根 ⇒ 归 `integration`，不入 `microTests` |

> **未找到任何「已被更强等价断言覆盖」的冗余项。** 特别地：i18n 对称检查在 client 侧**没有**全局等价覆盖
> （`prompt-i18n-parity.test.ts` 只覆盖提示词资产，不覆盖 client 渲染文案），因此不能以「别处已测」为由下放。

## 3. `focused`：关键目标**专题集合**（不是层级）

负责人原话：「focused 不是一个独立的等级，而是一些关键 goal 的专题测试，并不是一套测试，
是在必要时可以单独被调用的一系列测试。」

因此：**`focused` 不出现在 `tiers` 里，也不被 `shakedown/integration/full` include**（守卫双向检查）。
它是一组**具名专题**，每个专题说明「为哪个关键 goal/事故建的、要防什么复发」：

| 专题 | 文件数 | 为谁而建 / 防什么复发 |
| --- | --- | --- |
| `focused/rc3-host-compat` | 10 | g-321/g-351/g-469/g-473/g-475/g-477/g-624/g-625：宿主升级后插件静默失效 |
| `focused/reuse-baseline` | 17 | g-329/g-406/g-414/g-448/g-449/g-613/g-628：复用子代理后 cwd/基线错位、跨板写错板 |
| `focused/gate-integrity` | 12 | g-350/g-407/g-413/g-415—g-424/g-629：进程早退、静默少跑、伪造汇总冒充全绿 |
| `focused/auth-surface` | 6 | g-383/g-507：未鉴权即读看板、token 落盘明文、并发写撕裂 |
| `focused/event-first` | 6 | g-384/g-394/g-395/g-450/g-451：事件流与 frontmatter 漂移、并发写撕裂 |
| `focused/care-budget` | 27 | g-346/g-506/g-610/g-612/g-616/g-628：关照触发把预算/锁/子代理状态弄坏 |

**专题内容与层级文件重叠是正常的、有意的**：同一文件既可能在 `shakedown`（日常回归梯度的一部分），
也可能属于某个专题（按需调用的验证脚本）。两者是不同维度的东西，不是重复登记。6 个专题全部与日常层重叠。

```bash
node scripts/test-tier.mjs focused                  # 跑**全部**专题（并集）
node scripts/test-tier.mjs focused/gate-integrity   # 只跑单个专题
node scripts/test-tier.mjs --list                   # 列出层级 / 专题 / 标签规模，不运行
node scripts/test-tier.mjs focused/gate-integrity --list   # 打印该专题文件清单，不运行
```

## 4. 命令

```bash
node scripts/test-tier.mjs shakedown              # 日常推荐层
node scripts/test-tier.mjs integration            # 主流程与 DSH 宿主集成
node scripts/test-tier.mjs full                   # 完整回归（不含 microTests）
node scripts/test-tier.mjs everything             # 磁盘全集（与发布门禁同一文件集合）
node scripts/test-tier.mjs focused                # 全部专题
node scripts/test-tier.mjs focused/<专题>          # 单个专题
node scripts/test-tier.mjs full --labels perf     # 层 ∩ 标签（交，不是并）
node scripts/test-tier.mjs --list                 # 只打印规模，不运行
```

### 4.1 性能 / 变体是**正交维度**，不是层

`perf`（真实等待/计时敏感）与 `variant`（含变异/反向对照）是**标签**，与选择项取**交**：

- `node scripts/test-tier.mjs everything --labels perf`
- `node scripts/test-tier.mjs everything --labels variant`
- 标签**不会**把文件挤出它所在的层；含 `variant` 标签的文件若属三大家族，**仍须在日常层**。

## 5. 分层入口只做「集合展开」

`scripts/test-tier.mjs` 的唯一职责是**算出文件列表**，然后把**显式文件路径**原样交给
`scripts/run-tests.mjs`（`spawn`，`stdio: inherit`）。判定**全部继承**：

- 干净事件通道计数、三方交叉校验（事件汇总 ↔ 逐事件 tally ↔ 人类可读汇总）
- 逐文件**完成事件**覆盖断言（目标集合 ≡ 真正产出的文件集合）
- `NODE_OPTIONS` 选集/分片开关 fail-closed 拒绝
- `skipped` / `todo` / `cancelled` 不得伪装全绿、空集合 exit 2、退出码与计数矛盾判红

入口**不复制**上述任何逻辑（守卫断言入口源码里不存在 `parseEventChannel` / `coverageProblems` /
`cleanTestEnv` 等判定符号），并**自行**判空集（不依赖下游）与**原样透传**下游退出码。

## 6. 一致性守卫

`core/tests/g629-tier-manifest.test.ts`（14 个用例）守这些事：

1. 日常梯度**严格真子集链** `shakedown ⊊ integration ⊊ full`（相邻层相等即判红）+ 层间不重复登记；
2. `everything = full ∪ microTests = 磁盘`：full 与 microTests **不相交**、并集与磁盘**双向相等**；
   磁盘出现未分类新文件 ⇒ fail-closed 判红并**点名**；幽灵项 ⇒ 判红；
3. `focused` **不是层级**：不得出现在 `tiers`、不得被任何层 include；专题非空、有目的说明、文件真实存在；
4. **三大家族必须有日常覆盖**：全部文件位于 `shakedown` 或 `integration`（清单在测试里**显式枚举**），
   且不得下放到 `microTests`；
5. `microTests` **逐项复算代码证据**：断言数 ≤8、非家族、不 `import …/dist/…`、确实被排除在 full 外；
6. **反向变异必红**（对**同一套**判据函数 `manifestProblems` 施加变异）：
   ①删掉某层文件 ②上层改成与下层相等 ③新增未分类文件（真写进 `tmp/` 再真 `readdir` 读回）
   ④把家族文件移出日常层 ⑤专题集合为空 ⑥把 focused 当层级 include ⑦把家族文件下放到 microTests；
7. 入口/闸门契约：`TEST_GLOB` 字面量逐字不变、入口只 spawn 显式文件、不出现判定符号；
   真实进程负向对照：未知层 / 未知专题 ⇒ `exit 2`。

**新增测试文件时**：把它登记进 `core/tests/tier-manifest.json` 的某一层 `files`（并考虑 `labels`、
是否属于某个 `focused` 专题），否则下一次跑该守卫就会 fail-closed 判红并点名。

## 7. 实测数据

逐层明细（文件数 / 测试数 / 墙钟 / 成本来源 / 采样噪声）见 `docs/g629-tier-measurements.md`。摘要：

| 集合 | 文件数 | 测试数 | 墙钟 |
| --- | --- | --- | --- |
| `shakedown`（**日常推荐**） | 207 | 2488 | 48.4 s |
| `integration` | 252 | 3069 | 58.7 s |
| `full` | 259 | 3138 | 97.8 s |
| `everything` | 261 | 3144 | 104.2 s |
| `focused/gate-integrity`（按需专题） | 12 | 161 | 8.8 s |
| `node scripts/run-tests.mjs`（发布门禁） | 261 | 3144 | 100.5 s |

**shakedown 相对全量 ≈ 2.08×**（100.5 s ÷ 48.4 s）—— 这才是日常开发用的层。
加速不来自「少跑测试」（83% 的测试仍在其中），而来自**把真实等待/构建链/真实宿主那批最贵的文件移出日常层**；
同机单次采样抖动约 ±10%，故加速比合理区间约 **1.9×–2.3×**。

## 8. 不确定项与已知限制

- 待核验清单见 manifest 的 `uncertain` 字段（保守放在更靠前的层）。
- `g618-care-wake-compact.test.ts` 实测 61s：既有测试以 60s `waitFor` 上限等待 300s 冷却（等不到即超时再继续），
  **未修改该测试**，只归入 `full` + `perf`。要真正降它需要改测试语义 —— 超出本目标范围。
- 真实等待集中在少数文件上（`perf` 标签即「按需单独跑」的通道），这是 `shakedown` 能保持快的根本原因；
  但**不允许**因此把安全/隔离/门禁家族移出日常层（g614/g507-http-auth-real-host 等单价较高，仍留在 `shakedown`）。

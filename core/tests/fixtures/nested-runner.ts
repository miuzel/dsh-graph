/**
 * core/tests/fixtures/nested-runner.ts
 *
 * g-407：**嵌套测试运行器的唯一共用入口**。
 * 任何「测试内部再起一个测试 runner」的调用点都必须经由本模块，禁止各套件各写一份
 * `delete env.NODE_TEST_CONTEXT`。
 *
 * ── 缺陷（最小复现见 `core/tests/g407-nested-runner-context.test.ts`）──────────────
 * `node --test` 运行测试文件时会向该进程注入 `NODE_TEST_CONTEXT=child-v8`；测试内再
 * spawn 一个 `node --test` 时该变量被**继承**，子 runner 遂打印
 *
 *   (node:6) Warning: node:test run() is being called recursively within a test file.
 *   skipping running files.
 *
 * 并且 —— 关键 —— **exit 0 且零汇总输出**。于是子套件里任何「应当报红/应当通过」的断言
 * 都变成**永真**（false green），而顶层汇总只统计自己的用例（`skipped 0`），
 * 从表面完全看不出嵌套被跳过。这直接侵蚀全部测试证据的可信度。
 *
 * ── 本模块的三件事 ────────────────────────────────────────────────────────────────
 *  ① `cleanTestEnv()`：派生任何子进程前**摘掉**运行器注入变量；
 *  ② `assertNestedSuiteRan()`：把「零用例 / 被 skip / 没有汇总 / 计数口径不自洽」判为**显式失败**。
 *     理由：「子进程根本没跑用例」与「子进程跑完且全绿」在退出码上无法区分（都是 0），
 *     只看退出码的断言必然是永真 —— 必须改看**汇总输出本身**；
 *  ③ `assertNestedSuitePassed()`：全绿判据 = **退出码 0 且 cancelled 0 且 fail 0 且 skipped 0**。
 *
 * ── g-413 的两条补洞（同一根因域：闸门自身可被绕过）────────────────────────────────
 *  P1-1「取消不算红」：`node --test` 的 `cancelled`（如 `test(…,{timeout:1},()=>new Promise(()=>{}))`）
 *       不计入 `fail` ⇒ 只判 `fail === 0 && skipped === 0` 会放行被取消的用例。现已补
 *       `cancelled === 0` 与**退出码 === 0**（被取消时 `node --test` 退出非零）。
 *  P1-2「计数通道可被污染」：人类可读汇总与测试自己的 `console.log` 混在同一条 stdout 上
 *       （测试打印一行 `ℹ tests 1` 就能伪造）⇒ 文本解析无法区分来源。本模块的应对：
 *         · `parseTestSummary()` 改为**末尾匹配**（runner 汇总永远是最后一块），并给出
 *           `summaryBlocks` 块数供调用方判「该通道是否唯一/可信」；
 *         · `parseEventChannel()` 读取 `scripts/test-reporter-events.mjs` 产出的**带类型事件**通道
 *           （测试输出走 `test:stdout`，伪造不出 `test:summary`/`test:pass`/`test:fail`），权威计数只认它。
 *
 * ── g-415 的三条补洞（同一根因域：闸门可被判绿而未真正跑全）────────────────────────────
 *  P2-1「待办不算红」：`test.todo(...)` / `test(…,{todo:true},…)` 计入 `todo` 而不入 `fail`
 *       ⇒ 只判 fail/cancelled/skipped 会放行。已补 `todo === 0`（见 {@link nestedSuitePassProblems}）。
 *  P2-2「NODE_OPTIONS 选集旁路」：`cleanTestEnv()` 保留 `NODE_OPTIONS`，故 `--test-only` /
 *       `--test-name-pattern` / `--test-skip-pattern` / `--test-shard` 会让部分目标被静默排除。
 *       已补 {@link findTestSelectionOption} 供闸门 fail-closed 拒绝运行。
 *  P2-3「目标文件覆盖」：{@link parseEventChannel} 现收集**逐文件完成事件**（`test:summary` 带 `file`），
 *       闸门据此断言匹配集合 ≡ 完成事件集合 ⇒ 关闭 shard/pattern/测试内 `process.exit(0)` 早退。
 *
 * ── g-416 的收口（同一根因域在**共享 helper 层**的残余洞）──────────────────────────────────
 *  P2-3 此前只落在闸门 `scripts/run-tests.mjs` 里；**被 helper 消费**的嵌套套件仍可「断言未执行却局部判绿」：
 *  夹具注册 `test('pass',…)` + `test('fail',()=>assert.fail())` 后，在文件顶层用**反射退出**
 *  `globalThis['pro'+'cess']['ex'+'it'](0)` 早退，`runNestedArgv(…,['--test',f],…)` 得
 *  `code 0 / tests 1 / pass 1 / fail 0`，旧的 {@link nestedSuitePassProblems} **接受**。
 *  现收口三件事（全部 **fail-closed，无 opt-out**）：
 *   ① {@link nestedTargetCoverageProblems}：**目标文件集合**（helper 从调用参数推导，见
 *      {@link deriveNestedTargetTokens} → {@link expandNestedTargets}）必须与**产出逐文件
 *      `test:summary`（带 `file`）的集合**一致且 `>0`，否则判红；
 *   ② 事件通道交叉校验：`run.channel` 必须完整（summary + tally）且与人类可读汇总逐字段一致，
 *      否则人类通道视为可伪造、判红（保留既有 `code`/`fail`/`cancelled`/`skipped`/`todo`/口径断言）；
 *   ③ 目标来源：helper 自身从调用参数推导（`--test` 后的位置参数，支持多文件 / 目录 / `<dir>/*<suffix>`
 *      glob，与顶层闸门展开口径一致）；**无法推导时**退回调用方显式声明 `opts.targets`，两者都没有则
 *      **抛错 fail-closed**（选「自动推导 + 显式声明兜底 + 无声明即拒绝」而非「静默跳过检查」，理由：
 *      不存在任何能绕过覆盖断言的静默路径；消费点无需为新检查逐个开关）。
 *  事件通道经 **`NODE_OPTIONS`** 注入 `--test-reporter=…test-reporter-events.mjs` +
 *  `--test-reporter-destination=<私有临时文件>`（argv / shell 两种形态统一生效，无需改写调用方命令行）。
 *
 * ── g-417 的两条收口（g-416 复核确认的 P2 残余；同一根因域）────────────────────────────────
 *  ① **选集开关在 helper 侧未 fail-closed**：`cleanTestEnv()` 保留 `NODE_OPTIONS`，而逐文件覆盖只看
 *     **文件级**完成事件 ⇒ **用例级**选集（`--test-only` / `--test-name-pattern` / `--test-skip-pattern`
 *     / `--test-shard`）可静默排除失败用例而文件照常完成、照样判绿（实测：1 通过 + 1 失败的文件在
 *     `NODE_OPTIONS=--test-only` 下得 `tests 1 / pass 1 / fail 0`，被排除者**不计 skipped 也不计 fail**）。
 *     现由 {@link assertNoNestedTestSelection} 在**入口**（`capture` 内、spawn 之前）检测**生效**
 *     `NODE_OPTIONS`（= `process.env` 与 `opts.env` 合并后的值，与子进程实际拿到的一致），命中即**抛错
 *     拒绝执行**并**点名开关** —— 与自证闸门同口径（复用 {@link findTestSelectionOption} /
 *     {@link TEST_SELECTION_OPTION_NAMES}，不另立第二套口径）；`--no-warnings` /
 *     `--max-old-space-size=…` 等不改变选中集合的合法项照常放行。
 *  ② **含空格 `TMPDIR` 误红**：`NODE_OPTIONS` 由 Node 按空白切分，未加引号的含空格通道路径被切成两段
 *     ⇒ 通道文件写到被截断的前缀、读不到 ⇒ 覆盖断言判红（安全但**误红**）。现由
 *     {@link quoteNodeOptionsValue} 按 Node 的引号规则编码（双引号分组 + 转义 `\` 与 `"`；实测单引号
 *     不被识别、引号内 `\` 仍是转义符）⇒ 含空格（乃至 Windows 形态的反斜杠）路径下通道照常挂上。
 *
 * ── g-418 的两条收口（g-417 终局复核实测的 P1；均为**合法 API 误用即静默少跑**）──────────────
 *  ① **`opts.targets` 掩盖真实目标**：旧 `planNestedTargets` 形如 `opts.targets ?? deriveNestedTargetTokens(args)`
 *     ⇒ 只要声明非空就**不与 argv 实际集合比对**。实测 `runNestedArgv(node, ['--test', passA, reflectionExitB],
 *     {cwd, targets:[passA]})`（B = 注册失败断言后反射早退的夹具）得 `code 0 / targets [passA] / files [passA]
 *     / tests 2 / pass 2 / fail 0`，{@link nestedSuitePassProblems} 为空、{@link assertNestedSuitePassed}
 *     **接受** —— B 的失败断言从未执行。现由 {@link resolveNestedTargetPlan} 收口：**可推导时以推导集合为准**，
 *     声明必须与推导集合 realpath 归一后**精确一致**，否则抛错；**仅无法推导时**才允许使用声明。
 *  ② **`args` 内选集开关未拦**：g-417① 只查**生效 `NODE_OPTIONS`**，而 `runNestedArgv` 的 `args` 本身可携带
 *     用例级选集。实测 `runNestedArgv(node, ['--test','--test-name-pattern=vis', mix], {cwd})`（mix = 1 通过
 *     + 1 必失败）得 `code 0 / tests 1 / pass 1 / fail 0` 且目标文件**照常产出完成事件** ⇒ 覆盖断言看不出来、
 *     helper **接受**，失败用例被参数选集静默排除。现由 {@link nestedArgvTestSelectionProblem} /
 *     {@link assertNoNestedArgvTestSelection} 在**入口**（spawn 之前）拒绝并点名开关，复用 g-417 的
 *     {@link findTestSelectionOption} 同源 token 口径（`selectionOptionNameOfToken`），
 *     `--test-reporter` 等合法选项与文件路径不误拒。
 *
 * ── g-419 的两条收口（终局复核在 tip `c049a00` 上实测的**第三态 P1**）─────────────────────────
 *  ① **`opts.targets` 在 fallback 路径上成了 opt-out**：`resolveNestedTargetPlan` 仅在**可推导**时
 *     把声明与推导集合比对；**无法推导**（`['--test']` 无位置目标）时直接采信声明，而 spawn 的参数
 *     仍是 `['--test']` ⇒ Node 照旧**默认发现**，跑的文件可比声明多。实测私有 cwd 放
 *     `pass-a.test.mjs` + 注册失败断言后 `process.exit(0)` 的 `early-b.test.mjs`，
 *     `runNestedArgv(node, ['--test'], {cwd, targets:[passA]})` 得
 *     `code 0 / tests 2 / pass 2 / fail 0`，而 `channel.files=[passA]`（B 无逐文件完成事件）——
 *     单向覆盖只核声明集合 ⇒ `problems=[]`、{@link assertNestedSuitePassed} **接受**，
 *     B 的失败断言从未执行。现由 {@link injectPositionalTargetsIntoArgv} /
 *     {@link injectPositionalTargetsIntoCommand} 把**声明目标作为显式位置参数注入 spawn**
 *     （argv 形态插到 `--test` 之后；shell 形态等价重写）⇒ Node **不再默认发现**，
 *     「实际运行集 ≡ 声明集」由构造保证，再按既有判据核验完成事件；
 *     **无法安全重写**（不是 `node … --test …` 形态、缺 `--test` 等）⇒ **抛错 fail-closed**，
 *     绝不信任未经验证的声明；既无法推导又无声明仍抛错（既有行为保留）。
 *  ② **覆盖比对单向**：{@link nestedTargetCoverageProblems} 只查「目标未产出完成事件」。
 *     现改为**双向**：任何**产出了完成事件却不在目标集合内**的文件同样判红 —— 关闭「Node 实际跑得
 *     比 helper 展开更多」（glob 展开口径差异、默认发现漏网）的形态。
 *
 * ── g-420 的两条收口（终局复核在 tip `f495c09` 上给出的两项**非假绿** P2：文档与实现不一致 / 误红）──
 *  ① **交叉校验不对称**：g-416 的嵌套裁决只逐字段比较 `channel.summary` ↔ 人类可读 `run.summary`，
 *     **不比较 `channel.tally` ↔ `channel.summary`** —— 而顶层 `scripts/run-tests.mjs` 的
 *     `crossCheckProblems` 两者都比，与 AGENTS.md「与人类可读汇总 + 事件通道**逐字段交叉校验**」的
 *     声明不一致（复核者未找到 Node 26 上能让 tally/summary 分歧且仍全绿的真实形态，故非假绿、定级 P2）。
 *     现由 {@link nestedChannelCrossCheckProblems} 按与顶层**同口径**补齐：`channel.tally` 与
 *     `channel.summary` 逐字段（{@link CROSS_CHECK_FIELDS}）双向比对，且**两侧各自**核计数口径
 *     自洽（`tests === pass+fail+cancelled+skipped+todo`），分歧即判红并点名分歧字段。
 *  ② **shell 文法边界与误红**：`runNestedCommand` 的 shell 分词把**未加引号的反斜杠当普通字符**
 *     ⇒ `node --test /path/space\ name.test.mjs` 被误分词，**先跑后红**（幻觉出两个不存在目标 +
 *     一个额外完成事件）；重定向/管道等含元字符的命令同样先跑后红。现把支持的 shell 子集**显式化**
 *     （见 {@link runNestedCommand} 与 {@link NESTED_SHELL_SUBSET}）：只接受 `node … --test …` +
 *     空白分隔 + POSIX 单/双引号包裹的参数 + 普通路径/选项；**其它一切形态在 spawn 之前
 *     fail-closed 拒绝**（{@link assertSupportedNestedShellCommand}）并给清晰原因 ——
 *     未加引号的反斜杠转义、重定向（`>`/`<`/`2>`）、管道（`|`）、`;`/`&&`/`&`、子 shell `( )`、
 *     变量展开/命令替换（`$VAR`/`${…}`/`$(…)`/反引号）、`cd`/`env`/`FOO=1` 前缀、非 node 首 token、
 *     缺 `--test`。拒绝时**未创建事件通道、未启动任何进程、未产生 marker**（无副作用）。
 *  ③ **复合 shell 真 P1（终局复核在 `c8aa8a3`/`f495c09` 上实测）** —— ② 的类别但更严：
 *     `runNestedCommand('node --test; node --test pass.test.mjs', {cwd})`（**无** `opts.targets`）里
 *     两段都是**正常合法的 shell compound**、两段也**确实都跑了**；但两段**共用同一私有 events 文件**，
 *     后者**截断覆盖**前者 ⇒ 只有最后一段的 `test:summary` / 退出码存活，第一段真实 `fail` 被完全隐藏
 *     （实测 `code 0 / targets=[pass] / files=[pass] / tests 1 / pass 1 / fail 0 / summaryBlocks 2 /
 *     problems=[]` ⇒ helper **接受**）。粘连变体 `--test>/dev/null; node --test pass.test.mjs` 更强：
 *     第一段失败被重定向 + 覆盖双重隐藏，`summaryBlocks` 只剩 1。带 `opts.targets` 的版本同样复现。
 *     收口（**全部 spawn 前 fail-closed**）：①**粘连控制符**也要识别（按**字符**而非「空白分词的 token
 *     首字符」扫描，`--test;` / `--test>/dev/null` / `--test|cat` / `--test&&…` / 换行一律拒绝）；
 *     ②**强制单一 runner**（{@link nestedMultiRunnerProblem}：`node` 调用数或 `--test` 次数 `> 1` 即拒绝）
 *     —— **绝不**允许「多段 runner 共享一个 events 路径、只取最后摘要/最后退出码」。
 *     ③**「汇总块数 ≠ 1 判红」经终局复核后放弃**：合法消费点 g353 的嵌套运行 `channel.summaries === 2`
 *     （1 逐文件完成事件 + 1 全局汇总），改用人类可读 `summaryBlocks` 同样会被外层 `NODE_OPTIONS`
 *     注入的内层继承所误伤（实测嵌套 g353 被判红）；且 `>/dev/null` 粘连变体只剩 1 块 ⇒ 该层对上述
 *     三个复现零判别力。**防线全部落在 ① 粘连控制符识别 + ② 强制单一 runner**（均 spawn 前 fail-closed）。
 *
 * ── g-421 的收口（终局复核在 tip `ae1414c` 上实测的**负向裁决** P1：早退冒充「预期失败」）────────
 *  `{@link assertNestedSuiteFailed}`（负向变异对照专用）此前只核 `run.code !== 0` + 输出正则，
 *  **不核目标覆盖/事件通道** ⇒ 夹具先打印 sentinel、注册 `assert.fail(sentinel)` 后**立即
 *  `process.exit(1)`**，得 `code 1 / tests 1 / fail 1` 而 **`channel.files=[]`**（断言从未执行），
 *  helper **仍然接受** —— 「进程早退」可冒充「预期失败」= false-positive test evidence（P1）。
 *
 *  现收口：**正向与负向裁决共用同一组证据不变式**（{@link nestedEvidenceProblems} =
 *  目标集合 ≡ 逐文件完成事件集合且 `>0` + 人类汇总 ↔ 通道**逐字段**交叉校验 + 通道**内部**
 *  tally ↔ summary 交叉校验，全部 fail-closed、无 opt-out）：
 *   · {@link nestedSuitePassProblems}（正向，全绿）与 {@link nestedSuiteFailedProblems}（负向，如期报红）
 *     都调用同一实现 ⇒ 两端口径**只增不减**地一致，且**不各写一份**（结构性守卫钉住）；
 *   · {@link assertNestedSuiteRan}（「跑过没」前置）**同样**强制这组不变式 —— 它被 `g353` 的两个
 *     **负向对照消费点**（陈旧产物 / 漏模块）与整套件自证闸门直接消费，只核「跑过」会让
 *     「非零退出 + 输出签名」的早退伪造冒充负向对照成立；
 *   · `channel.files=[]` / 提前退出 / 断言未执行 ⇒ 一律**拒绝**并给明确红因
 *     （「失败不是由真实测试断言产生」）。
 *
 *  **第二轮收口（只核覆盖仍不够）**：另一种伪造**照常产出**文件级完成事件与自洽计数 ——
 *  `test('assertions pass', () => {})` **良性通过** + 打印期望签名 + 模块末尾 `process.exitCode = 1`
 *  ⇒ 实测 `code 1 / tests 2 / pass 1 / fail 1 / files=1`，那唯一 1 个 `fail` 只是 Node 为**文件进程**
 *  非零退出合成的「**文件包装**失败」（`details.error` 带 `exitCode`/`signal`），**本该失败的断言从未执行**。
 *  ⇒ 负向裁决（{@link nestedSuiteFailedProblems}）现在还要求事件通道里**确有 test/subtest 级的真实
 *  失败事件**（{@link nestedTestLevelFailures}：`details.type === "test"` 且**不带**进程级
 *  `exitCode`/`signal`），并且（传入签名时）**该失败事件的文本必须匹配签名**（证明失败正是预期的那个）。
 *  为此 `scripts/test-reporter-events.mjs` **加法式**新增 `{"type":"failure",…}` 实体级记录
 *  （`name`/`entityType`/`message`/`file`/`exitCode`/`signal`；summary/tally 语义不变 ⇒ 顶层闸门只用
 *  计数的交叉校验不受影响），由 {@link parseEventChannel} 收进 `channel.failures`。
 *  导出清单/不变式由 `g421` 结构性守卫按调用闭包钉住
 *  （{@link NESTED_EVIDENCE_VERDICTS} / {@link NESTED_EVIDENCE_PRECONDITIONS} / {@link NESTED_EVIDENCE_PARTS} /
 *  {@link NESTED_NON_VERDICT_EXPORTS}；**所有**运行时导出必须恰好归属其中一张清单，未归类即判红）。
 *
 *  **第三轮收口（g-424，只核「有 test 级失败事件 + 签名匹配」仍不够）**：签名可被**另一个目标**的
 *  真实失败满足，而被声明的目标其断言**从未执行**——终局复核在 tip `7121112` 实测的最小复现（两目标）：
 *   · A = `test('expected', () => assert.fail('EXPECTED_NEGATIVE_SIG'))`
 *   · B = `test.skip('skipped intended assertion', () => { throw new Error('EXPECTED_NEGATIVE_SIG') })`
 *   ⇒ `code 1 / tests 2 / fail 1 / skipped 1 / files=[A,B] / test 级失败 1 条`，旧负向裁决**接受**，
 *   而 B 的意图断言从未执行（`skip` 回调不运行、`todo` 零验证、`cancelled` 未跑完 ⇒ 都不参与通过判定）。
 *   这三类用例**照常**产出
 *   文件级完成事件、计数自洽 ⇒ 覆盖/通道校验看不出来。故 {@link nestedSuiteFailedProblems} 现与
 *   {@link nestedSuitePassProblems} / 顶层闸门**同口径**地要求 `cancelled === 0 && skipped === 0 &&
 *   todo === 0`（各自**点名红因**）；**只增不减、无 opt-out**。守卫见
 *   `core/tests/g424-negative-verdict-skip-todo.test.ts`。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 测试运行器注入到「测试文件进程」的环境变量。
 * 继承给孙进程会让嵌套 `node --test` 静默跳过全部文件（见文件头缺陷说明）。
 */
export const TEST_CONTEXT_VARS = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"] as const;

/**
 * g-415：`NODE_OPTIONS` 里会**改变「哪些文件/用例真的运行」**的开关（选集/分片类）。
 *
 * `cleanTestEnv()` 出于「不误伤合法用法」的考虑**保留** `NODE_OPTIONS`，于是这些开关会被原样
 * 继承给子 runner，让部分目标文件被**静默排除**而仍然 `exit 0`：
 *   - `--test-only`（配 `test.only`：只跑选集用例，其余静默不跑）；
 *   - `--test-name-pattern` / `--test-skip-pattern`（按名过滤 ⇒ 失败用例可被静默排除）；
 *   - `--test-shard`（只跑一个分片 ⇒ 其余文件静默不跑）。
 *
 * 自证闸门对四类一律 **fail-closed**（拒绝运行并 `exit≠0`），**不**采「清洗后再继续」：
 * 「清洗」要额外证明与用户显式选集**语义等价**，而「拒绝运行」不需要该论证，也不会误伤
 * 内存（`--max-old-space-size`）/告警（`--no-warnings`）/类型剥离等**不改变选中集合**的合法选项。
 */
export const TEST_SELECTION_OPTION_NAMES = [
  "--test-only",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-shard",
] as const;

/** shell 语义切分出的单个 token 及其在源串里的**字符区间**（g-419：shell 形态安全重写用）。 */
interface ShellToken {
  token: string;
  /** 起始下标（含）。 */
  start: number;
  /** 结束下标（不含）。 */
  end: number;
}

/**
 * 按 shell 语义切分（支持单/双引号与引号内的反斜杠转义；引号外的 `\` 是普通字符 —— 与原
 * {@link splitNodeOptions} 逐字同口径），并**保留每个 token 的源串区间** —— g-419 的 shell 形态重写
 * 需要在 `--test` 那个 token 之后插词，只有区间才能保证插入位置正确（重新拼接会丢掉原有引号/空格）。
 */
function tokenizeShellWithSpans(value: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let start = -1;
  let quote: string | null = null;
  const flush = (end: number): void => {
    if (current !== "") tokens.push({ token: current, start, end });
    current = "";
    start = -1;
  };
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (start === -1 && !/\s/.test(ch)) start = i;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      flush(i);
    } else {
      current += ch;
    }
  }
  flush(value.length);
  return tokens;
}

/** 尽力按 shell 语义切分 `NODE_OPTIONS`（支持单/双引号与反斜杠转义）；切分不完美也不影响判定。 */
function splitNodeOptions(value: string): string[] {
  return tokenizeShellWithSpans(value).map((entry) => entry.token);
}

/**
 * g-420②：`runNestedCommand` **支持的 shell 子集**（唯一权威表述；`runNestedCommand` 的文档、
 * 结构守卫与本常量三处同源，避免「文档说一套、实现做一套」再次发生）。
 *
 * **支持**：
 *  - 首个 token 是 `node` / `node.exe`（可带路径）；
 *  - 命令里含 `--test` token；
 *  - token 以空白分隔；参数可用 POSIX 单引号或双引号包裹（引号内为字面量；双引号内 `\` 转义下一个字符）；
 *  - `--test` 之后的位置参数：单个文件、目录、或 `<dir>/*<suffix>` glob（与顶层闸门同口径）；
 *  - 其余 node 选项（`--test-reporter=spec`、`--test-concurrency=…` 等）原样保留。
 *
 * **不支持（一律在 spawn 之前 fail-closed 拒绝，绝不「先跑后红」）**：
 *  - 未加引号的反斜杠转义（`space\ name`）—— 应改用引号包裹（`'space name'` / `"space name"`）；
 *  - 重定向 `>` / `<` / `2>`、管道 `|`、`;` / `&&` / `&`、子 shell `( )`、换行；**粘连形态同样拒绝**
 *    （`--test;`、`--test>/dev/null`、`--test|cat`、`--test&&…` —— 按**字符**而非「空白分词的 token 首字符」识别）；
 *  - 变量展开 / 命令替换：`$VAR`、`${…}`、`$(…)`、反引号；
 *  - `cd` / `env` / `FOO=1` 之类前缀，或任何非 node 首 token；
 *  - 缺 `--test`；
 *  - **多段 runner**：`node` 调用数或 `--test` 出现次数 `> 1`（终局复核在 `c8aa8a3`/`f495c09` 上实测的 P1 ——
 *    多段 runner **共用同一 events 文件**，后者截断覆盖前者 ⇒ 第一段的 `fail` 与非零退出码被完全隐藏，
 *    只留下最后一段的摘要/退出码；`node --test; node --test pass.test.mjs` 因此被判绿。一次只允许一个 runner）。
 */
export const NESTED_SHELL_SUBSET =
  "首 token 必须是 node；必须含且只含 1 个 --test；只允许单段 runner（node 调用数 / --test 次数均 ≤ 1）；" +
  "仅支持空白分隔 + POSIX 单/双引号包裹的参数 + 普通路径/选项；反斜杠转义、重定向、管道、; && &、( )、换行、" +
  "$VAR/${}/$( )/反引号、cd/env/FOO=1 前缀一律拒绝";

/** shell 元字符（**引号外**）⇒ 不支持的原因文案。`$` 单独处理（涵盖 `$VAR` / `${}` / `$()`）。 */
const SHELL_METACHAR_REASONS: Readonly<Record<string, string>> = {
  ">": "重定向 `>`",
  "<": "重定向 `<`",
  "|": "管道 `|`",
  ";": "命令分隔符 `;`",
  "&": "后台/逻辑分隔符 `&`",
  "(": "子 shell `(`",
  ")": "子 shell `)`",
  "`": "命令替换（反引号）",
  $: "变量展开 / 命令替换（`$`）",
};

/** `FOO=1` 形态的命令前缀（环境变量赋值）。 */
const SHELL_ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** 常见「包裹/前缀」命令 —— 明确点名，避免只给一句笼统的「首 token 不是 node」。 */
const SHELL_PREFIX_COMMANDS = new Set(["cd", "env", "exec", "nohup", "sudo", "time", "command"]);

interface ShellScan {
  /** 引号已剥离、按空白切分的 token（与真实 shell 语义一致：单引号内**无**转义）。 */
  spans: ShellToken[];
  /** 不支持形态的可读原因（去重，空数组 ⇒ 属于受支持子集）。 */
  problems: string[];
}

/**
 * g-420②：**严格** shell 扫描 —— 与 {@link tokenizeShellWithSpans} 的「尽力切分」不同，本函数在切分的
 * 同时**记录不支持形态**（引号外的反斜杠/元字符、引号内的 `$`/反引号、未闭合引号），供入口 fail-closed。
 *
 * 与 {@link tokenizeShellWithSpans} 的语义差异（本函数更贴近真实 shell，故 `runNestedCommand` 一律用它）：
 * 单引号内**没有**转义（`'a\b'` ⇒ `a\b`，而非 `ab`）；未加引号的反斜杠**不再被吞**（并判为不支持）。
 */
function scanNestedShellCommand(value: string): ShellScan {
  const spans: ShellToken[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const note = (reason: string): void => {
    if (seen.has(reason)) return;
    seen.add(reason);
    problems.push(reason);
  };
  let current = "";
  let start = -1;
  let quote: "'" | '"' | null = null;
  const flush = (end: number): void => {
    if (current !== "") spans.push({ token: current, start, end });
    current = "";
    start = -1;
  };
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (start === -1 && !/\s/.test(ch)) start = i;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
      } else {
        if (ch === "`" || ch === "$") note(SHELL_METACHAR_REASONS[ch]);
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "\n" || ch === "\r") {
      // g-420②（终局复核 P1）：换行也是 shell 命令分隔符 ⇒ `node --test a\nnode --test b` 会起**两段 runner**。
      note("换行/回车（shell 命令分隔符）不被支持 —— 一次只允许一条命令");
      flush(i);
    } else if (/\s/.test(ch)) {
      flush(i);
    } else if (ch === "\\") {
      note(
        "未加引号的反斜杠转义（`\\`）不被支持 —— 请改用引号包裹整个参数（如 'a b' 或 \"a b\"）",
      );
      current += ch;
    } else {
      const reason = SHELL_METACHAR_REASONS[ch];
      if (reason) note(reason);
      current += ch;
    }
  }
  flush(value.length);
  if (quote !== null) problems.push(`引号未闭合（${quote === "'" ? "单引号" : "双引号"}）`);
  return { spans, problems };
}

/**
 * g-420②（终局复核 P1）：**多段 runner 一律拒绝** —— 与「元字符/分隔符」检查互为纵深。
 *
 * 为什么单列：`node --test; node --test pass.test.mjs` 里每段都是**正常且合法**的 shell compound，
 * 两段也确实都跑了；但两段**共用同一私有 events 文件**，后者**截断覆盖**前者 ⇒ 只有最后一段的
 * `test:summary` / 退出码存活，第一段真实 `fail` 被完全隐藏（实测 `code 0 / tests 1 / pass 1 /
 * fail 0 / problems []` 且 helper **接受**；`--test>/dev/null` 粘连变体连人类汇总都只剩 1 块）。
 * 因此「一次运行只允许一个 runner」必须是**结构不变式**，不能寄望于摘要计数兜底。
 *
 * 计数口径：`node` 可执行 token 数（{@link isNodeBinary}，与注入判定同源）与**恰好等于** `--test`
 * 的 token 数（`--test-reporter` 等合法选项名不算 `--test`）。
 */
function nestedMultiRunnerProblem(spans: readonly ShellToken[]): string | null {
  const nodeCalls = spans.filter((entry) => isNodeBinary(entry.token));
  if (nodeCalls.length > 1) {
    return (
      `命令里出现 ${nodeCalls.length} 个 node 调用（${nodeCalls
        .slice(0, 3)
        .map((entry) => entry.token)
        .join("、")}${nodeCalls.length > 3 ? " …" : ""}）⇒ 多段 runner 不被支持`
    );
  }
  const testFlags = spans.filter((entry) => entry.token === "--test");
  if (testFlags.length > 1) {
    return `命令里出现 ${testFlags.length} 个 --test 标志 ⇒ 多段 runner 不被支持`;
  }
  return null;
}

/**
 * g-420②：`runNestedCommand` 的入口门禁 —— 只放行 {@link NESTED_SHELL_SUBSET}，其余形态**在 spawn 之前**
 * 抛错（调用方 `runNestedCommand` 在 `capture()`（会创建事件通道）之前调用本函数 ⇒ 拒绝时零副作用：
 * 未创建通道、未启动进程、未产生 marker）。
 *
 * 与 g-419① 的 `injectPositionalTargetsIntoCommand` 共用 {@link isNodeBinary} 口径；`--test` 存在性同样前置，
 * 使「非 node 首 token / 缺 --test」不再要等到 fallback 注入才发现。
 */
function assertSupportedNestedShellCommand(cmd: string, source: string): ShellToken[] {
  const scan = scanNestedShellCommand(cmd);
  const zero = "（未创建事件通道、未启动任何进程）";
  if (scan.problems.length > 0) {
    throw new Error(
      `${source}：命令不属于受支持的 shell 子集 —— ${scan.problems.join("；")}。` +
        `runNestedCommand 只支持：${NESTED_SHELL_SUBSET} ⇒ fail-closed 拒绝执行${zero}。`,
    );
  }
  const head = scan.spans[0]?.token ?? "";
  if (SHELL_ENV_ASSIGNMENT_RE.test(head)) {
    throw new Error(
      `${source}：不支持的环境变量赋值前缀（${head}）—— 请改用 opts.env（或 runNestedArgv 形态）` +
        `⇒ fail-closed 拒绝执行${zero}。`,
    );
  }
  if (SHELL_PREFIX_COMMANDS.has(head)) {
    throw new Error(
      `${source}：不支持的前缀命令（${head}）—— 请直接把 node 作为首个 token` +
        `⇒ fail-closed 拒绝执行${zero}。`,
    );
  }
  if (!isNodeBinary(head)) {
    throw new Error(
      `${source}：首 token 不是 node 可执行文件（${head === "" ? "<空命令>" : head}）` +
        `⇒ 无法安全重写/执行 ⇒ fail-closed 拒绝执行${zero}。`,
    );
  }
  if (!scan.spans.some((entry) => entry.token === "--test")) {
    throw new Error(
      `${source}：命令里没有 --test token ⇒ 不是嵌套测试运行形态 ⇒ fail-closed 拒绝执行${zero}。`,
    );
  }
  const multi = nestedMultiRunnerProblem(scan.spans);
  if (multi !== null) {
    throw new Error(
      `${source}：${multi} —— 多段 runner 会**共用同一 events 通道**、后者截断覆盖前者 ⇒ ` +
        `第一段的 fail/退出码被静默隐藏（实测可判绿）。请一次只运行一个 runner` +
        `⇒ fail-closed 拒绝执行${zero}。`,
    );
  }
  return scan.spans;
}

/**
 * 单个 token 是否为**选集/分片**开关（`--test-name-pattern=…` 归一为 `--test-name-pattern`）；
 * 不是则返回 `null`。**只有以 `-` 开头的 token 才当选项**（文件路径 / 独立取值不得误拒）。
 *
 * g-418②：这是「生效 `NODE_OPTIONS` 判定」与「传入子进程的 argv 判定」**共用**的唯一 token 级口径
 * （消费点分别见 {@link findTestSelectionOption} 与 {@link nestedArgvTestSelectionProblem}），
 * 保证两处不会各写一套、逐字漂移。
 */
function selectionOptionNameOfToken(token: string): string | null {
  if (!token.startsWith("-")) return null;
  const eq = token.indexOf("=");
  const name = eq === -1 ? token : token.slice(0, eq);
  return (TEST_SELECTION_OPTION_NAMES as readonly string[]).includes(name) ? name : null;
}

/**
 * 命中**选集/分片**开关时返回该开关名（`--test-name-pattern=…` 归一为 `--test-name-pattern`），
 * 否则返回 `null`。不改变选中集合的合法选项（内存/告警/类型剥离等）一律不受影响。
 */
export function findTestSelectionOption(nodeOptions: string | undefined | null): string | null {
  if (!nodeOptions) return null;
  for (const token of splitNodeOptions(nodeOptions)) {
    const name = selectionOptionNameOfToken(token);
    if (name !== null) return name;
  }
  return null;
}

/**
 * g-417①：嵌套运行**入口**的「生效 `NODE_OPTIONS` 选集」红因（复用 {@link findTestSelectionOption}）。
 * 命中四类选集/分片开关时返回**点名该开关**的红因文本，否则 `null`。
 *
 * 为什么必须在 helper 入口就拒绝（而不是只靠逐文件覆盖）：覆盖判据是**文件级**的，而
 * `--test-only` / `--test-name-pattern` / `--test-skip-pattern` 是**用例级**的 ——
 * 被它们排除的用例**既不计 `fail` 也不计 `skipped`**（实测「1 通过 + 1 失败」的文件在
 * `NODE_OPTIONS=--test-only` 下得 `tests 1 / pass 1 / fail 0`），文件照常产出完成事件 ⇒
 * 嵌套裁决可被环境**静默弱化**。与自证闸门同口径：**拒绝执行**，不采「清洗后继续」
 * （清洗要额外论证与用户显式选集语义等价，拒绝不需要）。
 */
export function nestedTestSelectionProblem(nodeOptions: string | undefined | null): string | null {
  const offending = findTestSelectionOption(nodeOptions);
  if (offending === null) return null;
  return (
    `NODE_OPTIONS 含测试选集/分片开关 ${offending}：嵌套子 runner 会继承它并**静默**改变「哪些用例/文件` +
    `真的跑」（用例级选集既不计 fail 也不计 skipped，逐文件完成事件照样产出 ⇒ 文件级覆盖断言看不出来）` +
    `⇒ fail-closed 拒绝嵌套执行；请从 NODE_OPTIONS 移除 ${offending}`
  );
}

/**
 * g-417①：入口守卫 —— 生效 `NODE_OPTIONS`（`process.env` 与 `opts.env` 合并后、即子进程真正拿到的值）
 * 命中选集/分片开关即抛错拒绝执行。**无 opt-out**：不存在「带着被弱化的选集继续跑」的静默路径。
 */
export function assertNoNestedTestSelection(nodeOptions: string | undefined | null, label: string): void {
  const problem = nestedTestSelectionProblem(nodeOptions);
  if (problem !== null) throw new Error(`${label}：${problem}`);
}

/**
 * g-418②：**实际传给子进程的 argv**（`runNestedArgv` 的 `args`；`runNestedCommand` 经 shell 语义
 * 切分出的等价 argv）里命中选集/分片开关时，返回**点名该开关**的红因文本，否则 `null`。
 *
 * 为什么入口必须**同时**拦 argv（不只拦生效 `NODE_OPTIONS`，g-417①）：`args` 本身就能携带用例级选集。
 * 实测 `runNestedArgv(node, ['--test','--test-name-pattern=vis', mix], {cwd})`（mix = 1 通过 + 1 必失败）
 * 得 `code 0 / tests 1 / pass 1 / fail 0`，且目标文件**照常产出完成事件** ⇒ 文件级覆盖断言看不出来，
 * helper 会**接受**（失败用例被参数选集静默排除）。
 *
 * 口径与 `NODE_OPTIONS` 判定**完全一致**：复用 {@link selectionOptionNameOfToken} /
 * {@link TEST_SELECTION_OPTION_NAMES}（`=值`、独立取值、多重空格等变体都归一为同一开关名）；
 * `--test-reporter` / `--test-reporter-destination` 等合法选项与文件路径（不以 `-` 开头）一律不受影响。
 * `--` 之后的 token 由 Node 视为**位置参数（目标文件）**，因此与 {@link deriveNestedTargetTokens}
 * 同口径地停止扫描（不把「文件名叫 `--test-only`」这种路径误判为开关）。
 */
export function nestedArgvTestSelectionProblem(argv: readonly string[]): string | null {
  for (const token of argv) {
    if (token === "--") break;
    const offending = selectionOptionNameOfToken(token);
    if (offending !== null) {
      return (
        `参数（argv）含测试选集/分片开关 ${offending}：嵌套子 runner 会按它**静默**改变「哪些用例/文件` +
        `真的跑」（用例级选集既不计 fail 也不计 skipped，逐文件完成事件照样产出 ⇒ 文件级覆盖断言看不出来）` +
        `⇒ fail-closed 拒绝嵌套执行；请从传给子进程的参数中移除 ${offending}`
      );
    }
  }
  return null;
}

/** g-418②：入口守卫 —— 传给子进程的 argv 命中选集/分片开关即抛错拒绝（**无 opt-out**）。 */
export function assertNoNestedArgvTestSelection(argv: readonly string[], label: string): void {
  const problem = nestedArgvTestSelectionProblem(argv);
  if (problem !== null) throw new Error(`${label}：${problem}`);
}

/**
 * 派生**任何**子进程前的干净 env：`process.env` 与 `extra` **先**合并，**再**摘掉运行器注入变量。
 * ⇒ `extra` 在摘除**之前**合并，因此调用方无法（也不应）通过 `extra` 把注入变量塞回去；
 * 反过来说，本 helper **构造不出**「带 `NODE_TEST_CONTEXT`」的 env（`extra` 里带上也会被摘除）。
 * （g-350：此处曾写成「extra 在摘除之后合并」，与实现相反；以本条为准。）
 */
export function cleanTestEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of TEST_CONTEXT_VARS) delete env[name];
  return env;
}

/** `node --test` 汇总行的机械摘要（同时兼容 spec reporter 的 `ℹ` 与 TAP 的 `#`）。 */
export interface TestSummary {
  tests: number;
  suites: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
  /** 是否出现了汇总块。**为 false 就说明 runner 根本没跑到用例**（skip 的典型形态）。 */
  hasSummary: boolean;
  /** 输出里是否出现「跳过全部文件」标记 ⇒ 继承 NODE_TEST_CONTEXT 的直接证据。 */
  runnerSkippedFiles: boolean;
  /**
   * 输出里 `ℹ|# tests N` 形态的汇总块个数（g-413）。
   * 人类可读通道混有测试自己的 `console.log` ⇒ `> 1` 说明该通道含伪造/重复汇总，**不可信**；
   * 权威计数一律用 {@link parseEventChannel}（带类型事件，测试输出无法伪造）。
   */
  summaryBlocks: number;
}

const SKIP_MARKER = /skipping running files/i;
const HAS_SUMMARY_RE = /(?:^|\n)\s*(?:ℹ|#)\s*tests\s+\d+/;

/** 逐个字段收集**全部**匹配 —— 绝不能只看首个（测试自己的打印会排在 runner 汇总之前，g-413 P1-2）。 */
function allSummaryValues(text: string, label: string): number[] {
  const re = new RegExp(`(?:^|\\n)\\s*(?:ℹ|#)\\s*${label}\\s+(\\d+)`, "g");
  return [...text.matchAll(re)].map((m) => Number(m[1]));
}

/**
 * 解析**人类可读**汇总。
 *
 * 取值语义（g-413 修正）：每个字段取**最后**一个匹配 —— runner 的最终汇总永远是最后一块输出，
 * 测试自己 `console.log` 的伪造行只会排在它之前。块数见 {@link TestSummary.summaryBlocks}，
 * 调用方可据此判「该通道是否唯一」。**需要不可伪造的权威计数时请用 {@link parseEventChannel}。**
 */
export function parseTestSummary(out: string, err = ""): TestSummary {
  const text = `${out}\n${err}`;
  const last = (label: string): number => {
    const values = allSummaryValues(text, label);
    return values.length > 0 ? values[values.length - 1] : 0;
  };
  return {
    tests: last("tests"),
    suites: last("suites"),
    pass: last("pass"),
    fail: last("fail"),
    cancelled: last("cancelled"),
    skipped: last("skipped"),
    todo: last("todo"),
    hasSummary: HAS_SUMMARY_RE.test(text),
    runnerSkippedFiles: SKIP_MARKER.test(text),
    summaryBlocks: allSummaryValues(text, "tests").length,
  };
}

/** 计数口径：`tests` 必须等于各分项之和（`pass+fail+cancelled+skipped+todo`；todo=0 时即不含 todo 的形态）。 */
export function tallyOf(s: TestSummary): number {
  return s.pass + s.fail + s.cancelled + s.skipped + s.todo;
}

/**
 * g-421：`test:fail` 的**实体级**明细（由 `scripts/test-reporter-events.mjs` 以 `type:"failure"`
 * 记录转发；见 {@link EventChannelReading.failures}）。
 *
 * 负向裁决必须能区分两种「失败」：
 *   - **真实 test/subtest 断言失败**：`entityType === "test"` 且**不带**进程级 `exitCode`/`signal`
 *     （error 只有 `message`/`cause` 的 Error 对象）；
 *   - **文件包装失败**：Node 因**文件进程**非零退出 / 被信号杀死而合成的失败 —— 带
 *     `exitCode`（数字）或 `signal`（如 `SIGKILL`）。`test('pass',()=>{}) + process.exitCode = 1`
 *     就属这一类：文件级完成事件照常产出，**但没有任何真实断言失败**。
 */
export interface TestFailureEvent {
  /** 事件实体名（真实用例 = 用例名；文件包装失败 = **文件路径**）。 */
  name: string;
  /** 事件实体层级（`details.type`：`test` / `suite` / …）。 */
  entityType: string;
  /** 失败文本（`details.error.message`，退化取字符串型 `cause`）。 */
  message: string;
  /** 事件自报的文件路径（可空）。 */
  file: string | null;
  /** **进程级**退出码 —— 仅「文件包装失败」带（真实断言失败为 `null`）。 */
  exitCode: number | null;
  /** **进程级**信号 —— 仅「被信号杀死的文件包装失败」带（真实断言失败为 `null`）。 */
  signal: string | null;
}

/**
 * **干净事件通道**（`scripts/test-reporter-events.mjs`，NDJSON）的解析结果。
 *
 * 这是 g-413 的权威计数来源：只有 runner 自产的**带类型**事件能进来（测试的 `console.log`
 * 走 `test:stdout`，本通道不转发）⇒ 伪造汇总文本**在结构上**进不了这里。
 */
export interface EventChannelReading {
  /** runner 自报的**最后一个**汇总（= 全局级）；`null` ⇒ 没有汇总（未加载 / 被杀 / 未跑完）。 */
  summary: TestSummary | null;
  /** reporter 按带类型事件**独立累加**的计数；`null` ⇒ 通道未完成（子进程被杀/崩溃）。 */
  tally: TestSummary | null;
  /** 出现过的 runner 汇总条数（文件级 + 最后一条全局级）。 */
  summaries: number;
  /**
   * g-415：**逐文件完成事件** —— `test:summary` 携带 `file` 的那些路径（全局汇总不带 `file`，不计入）。
   * 闸门据此断言「glob/入参匹配到的文件集合」与「真正产出完成事件的文件集合」一致，
   * 从而关闭 `--test-shard` / `--test-name-pattern` / 测试内 `process.exit(0)` 早退等**静默少跑**：
   * 被排除或中途早退的文件**根本不会**产出这条带 `file` 的汇总。
   */
  files: string[];
  /**
   * g-421：**逐 `test:fail` 的实体级明细**（可被信任的「失败是什么」来源）。
   * 计数无法区分「真实断言失败」与「文件包装因退出码/信号失败」，本字段可以 —— 见
   * {@link TestFailureEvent} 与 {@link nestedTestLevelFailures}。
   */
  failures: TestFailureEvent[];
  /** 无法解析/未知类型的行数（`> 0` ⇒ 通道被损坏或截断，计数不可信）。 */
  badLines: number;
}

/** 把 runner 汇总的 `{passed,failed}` 与 tally 的 `{pass,fail}` 归一成同一个摘要形状。 */
function summaryFromCounts(counts: Record<string, unknown>): TestSummary {
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const value = counts?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };
  return {
    tests: num("tests"),
    suites: num("suites"),
    pass: num("passed", "pass"),
    fail: num("failed", "fail"),
    cancelled: num("cancelled"),
    skipped: num("skipped"),
    todo: num("todo"),
    hasSummary: true,
    runnerSkippedFiles: false,
    summaryBlocks: 1,
  };
}

/** 解析干净事件通道的 NDJSON 文本（见 {@link EventChannelReading}）。 */
export function parseEventChannel(text: string): EventChannelReading {
  let summary: TestSummary | null = null;
  let tally: TestSummary | null = null;
  let summaries = 0;
  let badLines = 0;
  const files: string[] = [];
  const failures: TestFailureEvent[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let record: {
      type?: unknown;
      counts?: unknown;
      file?: unknown;
      name?: unknown;
      entityType?: unknown;
      message?: unknown;
      exitCode?: unknown;
      signal?: unknown;
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      badLines += 1;
      continue;
    }
    if (typeof record?.type !== "string") {
      badLines += 1;
      continue;
    }
    // g-421：实体级失败明细**不带** `counts` ⇒ 必须在下面的 counts 校验之前分支，否则会被算作坏行
    // （顶层闸门把 `badLines > 0` 当红因 ⇒ 漏掉这里会直接把合法运行判红）。
    if (record.type === "failure") {
      failures.push({
        name: typeof record.name === "string" ? record.name : "",
        entityType: typeof record.entityType === "string" ? record.entityType : "unknown",
        message: typeof record.message === "string" ? record.message : "",
        file: typeof record.file === "string" ? record.file : null,
        exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
        signal: typeof record.signal === "string" ? record.signal : null,
      });
      continue;
    }
    const counts = record.counts;
    if (typeof counts !== "object" || counts === null) {
      badLines += 1;
      continue;
    }
    if (record.type === "summary") {
      summaries += 1;
      // g-415：只收**带 file** 的逐文件完成事件（全局汇总不带 file ⇒ 不能充当任何文件的完成证据）。
      if (typeof record.file === "string" && record.file !== "") files.push(record.file);
      summary = summaryFromCounts(counts as Record<string, unknown>); // 逐条覆盖 ⇒ 留下最后（全局）一条
    } else if (record.type === "tally") {
      tally = summaryFromCounts(counts as Record<string, unknown>);
    } else {
      badLines += 1;
    }
  }
  return { summary, tally, summaries, files, failures, badLines };
}

/** g-416：`node --test` 中**独立取值**（`--opt value`）的选项名 —— 其后的 token 不是目标文件。 */
export const VALUE_TAKING_TEST_OPTIONS = new Set([
  "--test-reporter",
  "--test-reporter-destination",
  "--test-concurrency",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-shard",
  "--test-timeout",
  "--test-rerun-failures",
]);

/** 与顶层闸门 `scripts/run-tests.mjs` 同口径：只有 `<dir>/*<suffix>` 形态的 glob 被支持。 */
function expandNestedGlob(glob: string, cwd: string): string[] {
  const m = /^([^*]+)\/(\*[^/]*)$/.exec(glob);
  if (!m) {
    throw new Error(
      `nested-runner：不支持的 glob 形态（与顶层闸门同口径，只支持 <dir>/*<suffix>）：${glob} ⇒ fail-closed`,
    );
  }
  const [, dir, pattern] = m;
  const suffix = pattern.slice(1);
  const absDir = resolve(cwd, dir);
  return readdirSync(absDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(absDir, name));
}

/** 与顶层闸门同口径：目录型目标递归展开为 `*.test.<ext>`（避免把非测试文件当目标）。 */
const NESTED_TEST_FILE_RE = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;
function expandNestedDir(absDir: string): string[] {
  return readdirSync(absDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && NESTED_TEST_FILE_RE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** 归一化路径：存在则取 realpath（与事件通道里的 `file` 同口径比较），否则退回绝对路径。 */
function nestedNormPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * 把目标 token 展开成**具体测试文件集合**（绝对 + realpath 归一），与顶层闸门
 * `scripts/run-tests.mjs` 的展开口径一致：目录 ⇒ 递归 `*.test.*`；glob ⇒ 仅 `<dir>/*<suffix>`。
 * 展开为空一律抛错（fail-closed），不返回空集合让调用方「看起来没事」。
 */
export function expandNestedTargets(tokens: readonly string[], cwd: string): string[] {
  const files: string[] = [];
  for (const token of tokens) {
    if (/[*?[\]]/.test(token)) {
      files.push(...expandNestedGlob(token, cwd));
      continue;
    }
    const abs = resolve(cwd, token);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) files.push(...expandNestedDir(abs));
    else files.push(abs);
  }
  const unique = [...new Set(files.map(nestedNormPath))];
  if (unique.length === 0) {
    throw new Error(
      `nested-runner：目标展开后为空（tokens=${tokens.join(" ")}；cwd=${cwd}）⇒ 无法断言逐文件完成事件，fail-closed`,
    );
  }
  return unique;
}

/**
 * 从 argv / 命令行 token 里推导 `node --test` 的**目标文件 token**（不含选项）。
 * 返回 `null` ⇒ 不是 `--test` 形态或走默认文件发现（此时需调用方显式声明 `opts.targets`）。
 */
export function deriveNestedTargetTokens(args: readonly string[]): string[] | null {
  const testIndex = args.indexOf("--test");
  if (testIndex === -1) return null;
  const tokens: string[] = [];
  for (let i = testIndex + 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      tokens.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && VALUE_TAKING_TEST_OPTIONS.has(arg)) i += 1; // 跳过其独立取值
      continue;
    }
    tokens.push(arg);
  }
  return tokens;
}

/** 私有的干净事件通道 reporter（与闸门同一实现：NDJSON 带类型事件，测试输出伪造不进来）。 */
const EVENTS_REPORTER_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "test-reporter-events.mjs"),
).href;

/**
 * g-417②：按 Node 对 `NODE_OPTIONS` 的**引号规则**编码单个参数值。
 *
 * Node 的分词器按空白切分、并识别**双引号**分组（实测：单引号**不**被识别，会被原样当成路径字符）；
 * 双引号内 `\` 仍是转义符（实测 `"/a\b/c"` 会解析成 `/ab/c`）。故规则 = 双引号包裹 +
 * 把 `\` → `\\`、`"` → `\"`：
 *   - 含空格路径：不编码会被切成两段（通道路径被截断）⇒ 覆盖断言误红；
 *   - Windows 形态路径（`C:\Users\…`）：只加引号不转义反斜杠会把分隔符吞掉 ⇒ 同样误红。
 */
function quoteNodeOptionsValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * 为一次嵌套运行开一条**私有**事件通道：经 `NODE_OPTIONS` 注入 reporter（argv / shell 两形态统一生效，
 * 无需改写调用方命令行），通道文件落在系统临时目录（不写仓库、不参与任何 glob），运行结束即删。
 *
 * 必须**同时**注入 `spec → stdout`：一旦显式给出 `--test-reporter`，node 就不再挂默认 reporter，
 * 调用方在 `run.out` 上的人类可读输出（g-353/g-407 的断言对象）会被整个抹掉。
 */
function openEventChannel(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; eventsPath: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-nested-runner-"));
  const eventsPath = join(dir, "events.ndjson");
  const injected =
    `--test-reporter=spec --test-reporter-destination=stdout ` +
    `--test-reporter=${EVENTS_REPORTER_URL} ` +
    `--test-reporter-destination=${quoteNodeOptionsValue(eventsPath)}`;
  const inherited = env.NODE_OPTIONS?.trim();
  return {
    env: { ...env, NODE_OPTIONS: inherited ? `${inherited} ${injected}` : injected },
    eventsPath,
    close: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判定结果 */
      }
    },
  };
}

export interface NestedRunResult {
  /** 子进程退出码（null = 被信号终止）。 */
  code: number | null;
  out: string;
  err: string;
  /** 机械摘要：判定「有没有真的跑」只看它，不看退出码。 */
  summary: TestSummary;
  /** 便于失败消息复现的完整命令行。 */
  command: string;
  /** 子进程 cwd（把事件通道里的 `file` 归一化时用；g-416）。 */
  cwd: string;
  /** 本次嵌套运行的**目标文件集合**（绝对 + realpath 归一；g-416）。 */
  targets: string[];
  /** 私有**干净事件通道**的读取结果（逐文件完成事件 + 权威计数；g-416）。 */
  channel: EventChannelReading;
}

export interface NestedRunOptions {
  cwd: string;
  /** 附加环境变量（注入变量仍会被摘除）。 */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  /**
   * g-416：**显式声明**本次嵌套运行的目标文件（相对 `cwd` 或绝对；支持多文件 / 目录 / `<dir>/*<suffix>`）。
   *
   * g-418①（语义收紧）：**仅在 helper 无法从参数推导目标时**（走默认文件发现、或命令形态非 `node --test`）
   * 才被采用；**`args` 可推导时必须以推导集合为准**，此时若同时声明本项，必须与推导集合**精确一致**
   * （realpath 归一后集合相等），否则**抛错拒绝执行**（声明子集不得掩盖真实目标）。
   * 两者都没有 ⇒ helper 抛错 fail-closed（不存在「跳过覆盖断言」的静默路径）。
   */
  targets?: string[];
}

function finish(
  code: number | null,
  out: string,
  err: string,
  command: string,
  cwd: string,
  targets: string[],
  channel: EventChannelReading,
): NestedRunResult {
  return { code, out, err, command, cwd, targets, channel, summary: parseTestSummary(out, err) };
}

function capture(
  file: string,
  args: string[],
  opts: NestedRunOptions,
  command: string,
  targets: string[],
): Promise<NestedRunResult> {
  const baseEnv = cleanTestEnv(opts.env);
  // g-417①：入口 fail-closed —— 生效 NODE_OPTIONS 含选集/分片开关就拒绝执行（不做「清洗后继续」）。
  assertNoNestedTestSelection(baseEnv.NODE_OPTIONS, `嵌套运行入口（${command}）`);
  const events = openEventChannel(baseEnv);
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: events.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    child.on("error", (e) => {
      events.close();
      reject(e);
    });
    child.on("close", (code) => {
      let eventsText = "";
      try {
        eventsText = readFileSync(events.eventsPath, "utf8");
      } catch {
        eventsText = ""; // 通道文件缺失 = 通道未完成 ⇒ 覆盖断言据此判红
      }
      events.close();
      resolveRun(finish(code, out, err, command, opts.cwd, targets, parseEventChannel(eventsText)));
    });
  });
}

/**
 * g-419①：`node` 可执行文件判定 —— 只有 `node` / `node.exe`（可带路径、可带 `.exe`）才允许做
 * 「把声明目标注入 spawn」的重写。其它可执行文件（bash / 自定义脚本 / `env` 包裹等）形态无法保证
 * 注入后语义等价 ⇒ 一律 fail-closed（{@link injectPositionalTargetsIntoArgv}）。
 */
function isNodeBinary(token: string): boolean {
  const base = token.replaceAll("\\", "/").split("/").pop() ?? token;
  return base === "node" || base === "node.exe";
}

/** POSIX 单引号包裹（`'` → `'\''`）：注入含空格/特殊字符的绝对路径必须安全。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * g-419①：**argv 形态**的安全重写 —— 把声明目标作为**显式位置参数**插到 `--test` 之后，
 * 使 Node **不再走默认文件发现**（默认发现跑的文件数可比声明多 ⇒ 声明集不再代表实际运行集）。
 *
 * 插入点在 `--test` token 之后（`--` 终止符则在注入之后）⇒ `--test <files> [options]` 与
 * `--test <files> --` 都被 Node 当作位置目标（已实测；`node --test f --test-reporter=spec` 正常）。
 *
 * fail-closed：只有「`file` 是 node 可执行文件」且「`args` 里确有 `--test` token」才可安全重写；
 * 其余形态一律抛错 —— 不猜、也**不静默退回默认发现**（那正是第三态 P1 的成因）。
 */
function injectPositionalTargetsIntoArgv(
  file: string,
  args: readonly string[],
  targetPaths: readonly string[],
  source: string,
): string[] {
  if (!isNodeBinary(file)) {
    throw new Error(
      `${source}：无法从参数推导目标、需按 opts.targets 注入显式位置参数，但被启动的可执行文件不是 node` +
        `（${file}）⇒ 无法安全重写（注入会改变非测试进程的语义）⇒ fail-closed 拒绝执行。`,
    );
  }
  const testIndex = args.indexOf("--test");
  if (testIndex === -1) {
    throw new Error(
      `${source}：无法从参数推导目标、需按 opts.targets 注入显式位置参数，但参数里没有 --test` +
        `⇒ 无法安全重写 ⇒ fail-closed 拒绝执行（绝不信任未经验证的声明）。`,
    );
  }
  const rewritten = [...args];
  rewritten.splice(testIndex + 1, 0, ...targetPaths);
  return rewritten;
}

/**
 * g-419①：**shell 形态**的等价重写 —— 在 `--test` token 的**源串区间末尾**插入同样被 shell 安全引号
 * 包裹的绝对目标路径。用区间插入（不重新拼接整条命令）⇒ 原引号、多余空格、重定向/管道一律原样保留。
 *
 * fail-closed：首 token 必须是 node 可执行文件、且命令里确有 `--test` token，否则抛错（见
 * {@link injectPositionalTargetsIntoArgv} 的同款理由）。
 */
function injectPositionalTargetsIntoCommand(
  cmd: string,
  targetPaths: readonly string[],
  source: string,
): string {
  // g-420②：与入口门禁同源（严格 scanner）—— 此刻命令已通过子集校验，重扫只为拿 `--test` 的源串区间。
  const spans = scanNestedShellCommand(cmd).spans;
  const head = spans[0]?.token ?? "";
  if (!isNodeBinary(head)) {
    throw new Error(
      `${source}：无法从参数推导目标、需按 opts.targets 注入显式位置参数，但命令首 token 不是 node` +
        `（${head === "" ? "<空命令>" : head}）⇒ shell 结构无法安全改写 ⇒ fail-closed 拒绝执行。`,
    );
  }
  const testToken = spans.find((entry) => entry.token === "--test");
  if (!testToken) {
    throw new Error(
      `${source}：无法从参数推导目标、需按 opts.targets 注入显式位置参数，但命令里没有 --test token` +
        `⇒ fail-closed 拒绝执行（绝不信任未经验证的声明）。`,
    );
  }
  const injected = targetPaths.map(shellQuote).join(" ");
  return `${cmd.slice(0, testToken.end)} ${injected}${cmd.slice(testToken.end)}`;
}

/**
 * g-418①：realpath 归一的**集合相等**（{@link expandNestedTargets} 已去重；顺序无关，元素必须逐一对应）。
 * 声明集合与推导集合的比对与既有覆盖判据**同一口径**（`nestedNormPath` ⇒ realpath）。
 */
function sameNestedTargetSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
}

/**
 * g-418①：目标集合的**唯一裁决**（`opts.targets` 语义收紧）——
 *   ① **可推导时必须以推导集合为准**，显式声明只能与推导集合**精确一致**（realpath 归一）；
 *      不一致 ⇒ **抛错拒绝执行**（不得静默取其一，否则声明子集可掩盖真实目标、让早退目标不被覆盖）；
 *   ② **仅无法推导时**才允许使用声明集合（该集合仍受逐目标完成事件覆盖约束）；
 *   ③ 两者皆无 ⇒ 抛错（不存在「跳过覆盖断言」的静默路径）。
 */
function resolveNestedTargetPlan(
  derived: string[] | null,
  declared: string[] | null,
  source: string,
  cwd: string,
): string[] {
  if (derived === null && declared === null) {
    throw new Error(
      `${source}：无法推导嵌套运行的目标文件（未给 --test 目标 / 走默认文件发现），调用方也未显式声明 ` +
        `opts.targets ⇒ fail-closed 拒绝执行。请显式传 opts.targets（相对 cwd 或绝对；支持多文件、目录、` +
        `<dir>/*<suffix>）。`,
    );
  }
  if (derived === null) return declared as string[];
  if (declared === null) return derived;
  if (!sameNestedTargetSet(derived, declared)) {
    const show = (files: readonly string[]): string => {
      const shown = files.slice(0, 5).map((f) => relative(cwd, f));
      return `${shown.join("、")}${files.length > 5 ? ` …(+${files.length - 5})` : ""}`;
    };
    throw new Error(
      `${source}：显式声明的 opts.targets 与从参数**推导**出的目标集合不一致（realpath 归一后集合不相等）` +
        `⇒ fail-closed 拒绝执行：可推导时必须以推导集合为准，声明不得掩盖真实目标。` +
        `推导集合 ${derived.length} 个 [${show(derived)}]；声明集合 ${declared.length} 个 [${show(declared)}]。`,
    );
  }
  return derived;
}

/**
 * 目标推导的统一出口：**推导优先** → 一致声明只作校验 → 无法推导时才用声明（且必须**注入显式位置
 * 目标**，见 {@link needsFallbackInjection} / {@link injectPositionalTargetsIntoArgv}，g-419①）
 * → 不一致 / 两者皆无则抛错（fail-closed，无 opt-out）。入口先拦 argv 选集/分片开关（g-418②），
 * 全部发生在 spawn 之前。
 */
function planNestedTargets(args: readonly string[], opts: NestedRunOptions, source: string): string[] {
  // g-418②：**spawn 之前**拦 argv（argv 形态即 `args`；shell 形态为 shell 语义切分出的等价 argv）。
  assertNoNestedArgvTestSelection(args, source);

  // g-418①：可推导 ⇒ 采用**推导集合**；`opts.targets` 只在与之一致时被校验，仅无法推导时才被采用。
  const derivedTokens = deriveNestedTargetTokens(args);
  const derived =
    derivedTokens !== null && derivedTokens.length > 0 ? expandNestedTargets(derivedTokens, opts.cwd) : null;
  const declared =
    opts.targets !== undefined && opts.targets.length > 0 ? expandNestedTargets(opts.targets, opts.cwd) : null;

  // g-419①：fallback（无法推导）时，上面采纳的声明集合**不是**现成的运行集 —— 调用方必须按
  // {@link needsFallbackInjection} 把它注入 spawn，否则 Node 仍走默认发现、声明就成了 opt-out。
  return resolveNestedTargetPlan(derived, declared, source, opts.cwd);
}

/**
 * g-419①：本次调用是否走 **fallback**（args 无法推导目标 ⇒ 上面的裁决来源只能是 `opts.targets`）。
 * 为真时调用方**必须**把（裁决得到的）目标集合注入 spawn：argv 形态见
 * {@link injectPositionalTargetsIntoArgv}、shell 形态见 {@link injectPositionalTargetsIntoCommand}；
 * 注入不安全就抛错 —— **绝不**让 spawn 保持默认发现（那正是第三态 P1：声明集 ≠ 实际运行集）。
 *
 * 与 {@link planNestedTargets} 同源判定（同一 `deriveNestedTargetTokens` 口径），不另立第二套。
 */
function needsFallbackInjection(args: readonly string[]): boolean {
  const tokens = deriveNestedTargetTokens(args);
  return tokens === null || tokens.length === 0;
}

/**
 * 跑一条**嵌套测试**命令（shell 形态，供 `package.json` 里取到的脚本文本直接用）。
 * env 一律经 {@link cleanTestEnv} 清洗；生效 `NODE_OPTIONS` 命中选择集/分片开关则**抛错拒绝执行**
 * （{@link assertNoNestedTestSelection}，g-417①）；**shell 语义切分出的等价 argv** 命中选集/分片开关
 * 同样在 spawn 前抛错拒绝（{@link assertNoNestedArgvTestSelection}，g-418②）；目标不一致 / 无法推导同样抛错
 * （g-418① / g-416）；**无法推导但有声明 ⇒ 把声明目标注入命令后再执行**（g-419①，注入失败即抛错）。
 *
 * g-420②：**只接受 {@link NESTED_SHELL_SUBSET} 描述的 shell 子集** —— 入口第一步即
 * {@link assertSupportedNestedShellCommand}（早于会创建事件通道的 `capture()`）：
 * 未加引号的反斜杠转义、重定向/管道/`;`/`&&`/`&`/`( )`、`$VAR`/`${…}`/`$(…)`/反引号、
 * `cd`/`env`/`FOO=1` 前缀、非 node 首 token、缺 `--test` 一律**在 spawn 之前 fail-closed 拒绝**
 * 并给出清晰原因（不再「先跑后红」：旧分词把未引号反斜杠当普通字符 ⇒ `space\ name` 被切成两段）。
 */
export function runNestedCommand(cmd: string, opts: NestedRunOptions): Promise<NestedRunResult> {
  const source = `runNestedCommand(${cmd})`;
  // g-420②：入口门禁（spawn 之前、且早于 capture() 创建事件通道）⇒ 拒绝时零副作用。
  const spans = assertSupportedNestedShellCommand(cmd, source);
  const argv = spans.map((entry) => entry.token);
  const targets = planNestedTargets(argv, opts, source);
  const command = needsFallbackInjection(argv) ? injectPositionalTargetsIntoCommand(cmd, targets, source) : cmd;
  return capture("bash", ["-c", command], opts, command, targets);
}

/**
 * 跑一个**嵌套测试**进程（argv 形态，跨平台；`node --test …` 的推荐入口）。
 * env 一律经 {@link cleanTestEnv} 清洗；生效 `NODE_OPTIONS` 命中选择集/分片开关则**抛错拒绝执行**
 * （{@link assertNoNestedTestSelection}，g-417①）；`args` 命中选集/分片开关同样在 spawn 前抛错拒绝
 * （{@link assertNoNestedArgvTestSelection}，g-418②）；目标不一致 / 无法推导同样抛错（g-418① / g-416）；
 * **无法推导但有声明 ⇒ 把声明目标注入 argv 后再 spawn**（g-419①，注入失败即抛错）。
 */
export function runNestedArgv(
  file: string,
  args: string[],
  opts: NestedRunOptions,
): Promise<NestedRunResult> {
  const source = `runNestedArgv(${file} ${args.join(" ")})`;
  const targets = planNestedTargets(args, opts, source);
  const argv = needsFallbackInjection(args) ? injectPositionalTargetsIntoArgv(file, args, targets, source) : [...args];
  return capture(file, argv, opts, `${file} ${argv.join(" ")}`, targets);
}

function tail(run: NestedRunResult, n = 600): string {
  return `${run.out}`.slice(-n);
}

/**
 * 断言「嵌套子进程**确实跑了用例**」。
 *
 * 判据（任一不满足即**显式失败**，绝不静默放行）：
 *  ① 输出含 `skipping running files` ⇒ runner 跳过了全部文件（继承 NODE_TEST_CONTEXT 的直证）；
 *  ② 没有汇总块 ⇒ 根本没跑到用例（此时 exit 0 与「全绿」不可区分，任何断言都永真）；
 *  ③ 汇总里的用例总数为 0 ⇒ 零测试通过 = 失败；
 *  ④ **计数口径不自洽**（g-413）⇒ `tests !== pass+fail+cancelled+skipped+todo` 说明解析到的不是
 *     runner 的完整汇总（截断/污染），计数不可信，同样不得判绿。
 *
 * 注意：`pass === 0` **不**单独判红 —— 「唯一用例就是负向对照且如期失败」是合法形态，
 * 此类调用请用 {@link assertNestedSuiteFailed}。
 *
 * ── g-421 追加：**与全绿/如期报红裁决同一组证据不变式**（只增不减，fail-closed、无 opt-out）──────
 *  ⑤ {@link nestedEvidenceProblems}：目标集合 ≡ 逐文件**完成事件**集合且 `>0` + 人类汇总 ↔ 通道
 *     **逐字段**交叉校验 + 通道**内部** tally ↔ summary 交叉校验。缺了它，「文件级早退」会得到
 *     `tests > 0 / fail > 0` 的**自洽计数**（repro 实测 `code 1 / tests 1 / fail 1 / files []`）⇒
 *     本函数会误判「真的跑了」。
 *
 *  为什么本函数**必须**也核这些（终局复核追加要求）：它被 `g353` 的两个**负向对照消费点**
 *  （陈旧产物 / 漏模块）与整套件自证闸门直接消费 —— 若它只核「跑过」，「非零退出 + 输出签名」
 *  的**早退伪造**即可冒充「负向对照成立」。故本函数不是弱裁决：**任何**据运行证据下结论的入口
 *  都必须消费证据不变式（结构性守卫 `g421` 钉住：`assertNested*` 的调用闭包必须到达核心）。
 *  排序说明：先判「没跑 / 零用例 / 口径」这类**更基础**的红因（`g407` 的合成负向用例据此给出
 *  可读红因），最后追加证据不足 —— 两类红因都**只增不减**。
 */
export function assertNestedSuiteRan(run: NestedRunResult, label: string): void {
  const s = run.summary;
  if (s.runnerSkippedFiles) {
    assert.fail(
      `${label}：嵌套运行器**跳过了全部用例**（输出含 "skipping running files"）——` +
        `这是继承 NODE_TEST_CONTEXT 的典型征兆；此刻任何「期望报红/期望通过」的断言都永真。` +
        `命令：${run.command}`,
    );
  }
  if (!s.hasSummary) {
    assert.fail(
      `${label}：嵌套运行器**没有输出任何汇总行**（exit=${run.code}）⇒ 用例根本没跑，` +
        `退出码不可作为证据。命令：${run.command}\n输出尾部：${tail(run)}`,
    );
  }
  if (s.tests === 0 || tallyOf(s) === 0) {
    assert.fail(
      `${label}：嵌套运行器报告**零用例**（tests=${s.tests}）⇒ 零测试通过必须视为失败。` +
        `命令：${run.command}\n输出尾部：${tail(run)}`,
    );
  }
  if (tallyOf(s) !== s.tests) {
    assert.fail(
      `${label}：汇总**计数口径不自洽**（tests=${s.tests} ≠ pass+fail+cancelled+skipped+todo=${tallyOf(s)}）` +
        `⇒ 计数不可信（解析截断或通道被污染），不得判绿。命令：${run.command}\n输出尾部：${tail(run)}`,
    );
  }
  // g-421⑤：证据不变式（覆盖 + 通道交叉校验）—— 与全绿/如期报红裁决**同一组**，不得豁免。
  const evidence = nestedEvidenceProblems(run);
  if (evidence.length > 0) {
    assert.fail(
      `${label}：嵌套运行的**证据不足以判定通过或失败**（exit=${run.code}）—— 该运行可能根本没跑完，` +
        `其**失败/通过都不是由目标文件的真实测试断言产生的**：${evidence.join("；")}\n` +
        `命令：${run.command}\n输出尾部：${tail(run)}`,
    );
  }
}

/**
 * 全绿判据的**非抛错**形态：返回**全部**不达标项（空数组 = 达标）。
 * 判据：**退出码 0** 且 `cancelled === 0` 且 `fail === 0` 且 `skipped === 0` 且 `todo === 0`
 * （`tests > 0` 由 {@link assertNestedSuiteRan} 保证）。
 *
 * 为什么 `cancelled` 必须单列：`node --test` 把被取消（如 timeout）的用例计入 `cancelled` 而**不是** `fail`，
 * 只看 `fail === 0` 会把它放行（g-413 P1-1 的 false-green 洞）。
 *
 * 为什么 `todo` 必须单列（g-415）：`test.todo('x')` / `test('x',{todo:true},…)` 产出
 * `tests 1 / pass 0 / fail 0 / cancelled 0 / skipped 0 / todo 1` 且 **exit 0** —— 旧的
 * `fail/cancelled/skipped` 三判全部放行，于是「零个真实验证」被当成「全绿」。待办**不是**验证。
 *
 * 与 {@link assertNestedSuitePassed} **共用同一实现**：闸门需要把交叉校验红因与这些不达标项
 * 一次性打全，故单独暴露非抛错形态，避免两处各写一份判据。
 *
 * ── g-416 追加（**只增不减**，全部 fail-closed、无 opt-out）──────────────────────────────
 *  ⑥ 事件通道交叉校验：`run.channel` 必须完整（有 runner 汇总 + 逐事件计数），且与人类可读汇总
 *     逐字段一致；人类可读通道混有测试自己的 `console.log`（可打印伪造的 `ℹ tests 1`），不可单独采信；
 *  ⑦ **逐目标文件完成事件覆盖**（{@link nestedTargetCoverageProblems}）：目标文件集合 ≡ 产出
 *     逐文件 `test:summary`（带 `file`）的集合且 `>0`，否则判红 —— 关闭「注册用例后反射/直接早退」
 *     这类「断言未执行却局部判绿」（P2-3 此前只落在闸门，被 helper 消费的嵌套套件仍可绕过）。
 *
 * ── g-420① 追加（**只增不减**，fail-closed、无 opt-out）────────────────────────────────────
 *  ⑧ **事件通道内部交叉校验**（{@link nestedChannelCrossCheckProblems}）：`channel.tally`
 *     （reporter 按带类型事件独立累加）与 `channel.summary`（runner 自产汇总）必须逐字段双向一致，
 *     且两侧各自计数口径自洽；分歧即点名分歧字段判红 —— 补上「三方交叉校验」在本 helper 上缺失的
 *     那一条腿（此前只比了 `channel.summary` ↔ 人类可读汇总）。
 *  ⑨ **（终局复核后放弃，勿再加）**「汇总块数 ≠ 1 即判红」**刻意不实现** —— 实测会误伤合法嵌套运行：
 *     合法消费点 g353 的嵌套运行 `channel.summaries === 2`；改用人类可读 `summaryBlocks` 也不安全，
 *     外层 `NODE_OPTIONS` 注入会被内层再次追加 ⇒ 内层 stdout 汇总行加倍（实测嵌套 g353 的内层正例
 *     `clean` 运行 `summaryBlocks=2` ⇒ 被判红）。该层对 g-420② 的三个复现零判别力（`>/dev/null`
 *     变体只剩 1 块）。**放弃后同一命令实测 `code 0 / tests 7 / pass 7 / fail 0 / problems []`**。
 *     防线只在入口 (a)(b)。
 *
 * ── g-421 追加（**只增不减**，fail-closed、无 opt-out）────────────────────────────────────
 *  ⑩ ⑥⑦⑧ 三条证据不变式（通道完整性 / 人类汇总 ↔ 通道逐字段 / 通道内部 tally ↔ summary / 目标覆盖）
 *     收归**唯一实现** {@link nestedEvidenceProblems}，本函数与**负向裁决**
 *     （{@link nestedSuiteFailedProblems}）**共用**它 —— 关闭「负向路径少核覆盖/通道 ⇒ 早退冒充预期失败」。
 */
export function nestedSuitePassProblems(run: NestedRunResult): string[] {
  const s = run.summary;
  const problems: string[] = [];
  if (run.code !== 0) {
    problems.push(`子 runner 退出码 ≠ 0（exit=${run.code}${run.code === null ? "：被信号终止" : ""}）`);
  }
  if (s.cancelled > 0) problems.push(`有被**取消**的用例（cancelled=${s.cancelled}）`);
  if (s.fail > 0) problems.push(`有**失败**用例（fail=${s.fail}）`);
  if (s.skipped > 0) problems.push(`有用例被**跳过**（skipped=${s.skipped}）`);
  if (s.todo > 0) problems.push(`有**待办**用例（todo=${s.todo}）——待办不是验证，不得判绿`);
  // g-420②（终局复核修正）：**刻意不做**「汇总块数 ≠ 1 即判红」。
  // 实测依据（worktree 内真实运行）：
  //  · 合法消费点 g353 的嵌套运行 `channel.summaries === 2`（1 个逐文件完成事件 + 1 个全局汇总）
  //    ⇒ 任何以**事件通道摘要块数**为红因的守卫都会误伤真实形态（复核者已给出该数据点）。
  //  · 即便改用**人类可读** `summaryBlocks` 也不安全：外层 helper 经 `NODE_OPTIONS` 注入的 reporter 会被
  //    内层 helper 再次追加（`cleanEnv()` 不摘 `NODE_OPTIONS`）⇒ 内层子进程 stdout 的汇总行**加倍**，
  //    实测嵌套 g353 的内层正例 `clean` 运行 `summaryBlocks=2` ⇒ 合法全绿运行被判红。
  //  · 交换性：`>/dev/null` 粘连变体只剩 1 块 ⇒ 该层对 g-420② 的三个复现**零判别力**。
  // 放弃后实测（同一命令）：`code 0 / tests 7 / pass 7 / fail 0 / channel_summaries 2 / problems []`。
  // ⇒ 防线全部落在入口 (a) 粘连控制符识别 + (b) 强制单一 runner（spawn 前 fail-closed）。

  // g-421：证据不变式（覆盖 + 通道交叉校验）收归**唯一实现**，正向与负向裁决共用（同口径、不各写一份）。
  problems.push(...nestedEvidenceProblems(run));
  return problems;
}

/** 人类可读汇总与事件通道必须逐字段一致的计数字段（`suites` 不在内：`describe` 聚合口径不同，g-415 已单独校验）。 */
const CROSS_CHECK_FIELDS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const;

/**
 * g-420①：**事件通道内部**交叉校验的缺失项（非抛错形态；空数组 = tally 与 summary 逐字段一致且各自计数口径自洽）。
 *
 * 与顶层 `scripts/run-tests.mjs` 的 `crossCheckProblems` **同口径**（同一个 {@link CROSS_CHECK_FIELDS} 字段集，
 * 逐字段、双向、无「哪一方权威」的假设）：`channel.tally`（reporter 从**原始事件流**独立累加）与
 * `channel.summary`（runner **自报**汇总）是两个独立来源，只比其中一方时另一方出错不会被发现。
 * 任一侧出现分歧即**点名该字段**判红；两侧还各自必须满足计数口径自洽
 * （`tests === pass+fail+cancelled+skipped+todo`），否则计数本身不可信。
 */
export function nestedChannelCrossCheckProblems(
  tally: TestSummary | null | undefined,
  summary: TestSummary | null | undefined,
): string[] {
  const problems: string[] = [];
  const sides = [
    ["逐事件计数（tally）", tally],
    ["runner 汇总（summary）", summary],
  ] as const;
  for (const [name, side] of sides) {
    if (!side) {
      problems.push(`事件通道不完整：缺 ${name} ⇒ 计数不可信，fail-closed 判红`);
      continue;
    }
    if (tallyOf(side) !== side.tests) {
      problems.push(
        `${name}的计数口径不自洽（tests=${side.tests} ≠ pass+fail+cancelled+skipped+todo=${tallyOf(side)}）⇒ 计数不可信`,
      );
    }
  }
  if (!tally || !summary) return problems;
  for (const field of CROSS_CHECK_FIELDS) {
    if (tally[field] !== summary[field]) {
      problems.push(
        `事件通道内部不一致（逐事件计数 vs runner 汇总）：${field} ${tally[field]} ≠ ${summary[field]}` +
          `⇒ 计数通道自相矛盾，fail-closed 判红`,
      );
    }
  }
  return problems;
}

/**
 * g-416：**逐目标文件完成事件覆盖**的判据（非抛错形态；空数组 = 覆盖成立）。
 *
 * 判据（**双向**，g-419②）：`targets`（helper 从调用参数推导 / 调用方显式声明）**非空**，且
 *   ① 其中每个文件都出现在事件通道的**逐文件完成事件**（带 `file` 的 `test:summary`）里；
 *   ② **反向**：任何产出完成事件却**不在** `targets` 内的文件同样判红 —— 否则「Node 跑得比 helper
 *      展开/声明更多」（glob 展开口径差异、默认发现漏网）会被静默放过。
 * 为什么用「逐文件汇总」而不是文件级 `test:pass`：后者在测试内提前退出时**仍会发出**，
 * 无法区分「跑完」与「刚注册就退出」；被排除/中途早退的文件**不会**产出逐文件汇总。
 *
 * fail-closed：目标集合为空（无法推导且未声明）同样判红 —— 不存在跳过该检查的静默路径。
 */
export function nestedTargetCoverageProblems(
  targets: readonly string[] | null | undefined,
  channel: EventChannelReading | null | undefined,
  cwd: string,
): string[] {
  const problems: string[] = [];
  if (!targets || targets.length === 0) {
    problems.push(
      "无法确定嵌套运行的目标文件集合（helper 未能从参数推导，调用方也未显式声明 targets）⇒ 无法证明跑全，fail-closed 判红",
    );
    return problems;
  }
  const completed = new Set((channel?.files ?? []).map((f) => nestedNormPath(resolve(cwd, f))));
  const targetSet = new Set(targets.map(nestedNormPath));
  const show = (files: readonly string[]): string =>
    `${files
      .slice(0, 5)
      .map((f) => relative(cwd, f))
      .join("、")}${files.length > 5 ? " …" : ""}`;

  const missing = [...targetSet].filter((t) => !completed.has(t));
  if (missing.length > 0) {
    problems.push(
      `目标文件未产出完成事件（被选集/分片静默排除，或测试内提前退出）${missing.length}/${targetSet.size} 个` +
        `${completed.size === 0 ? "（事件通道里一条逐文件完成事件都没有：未挂干净 reporter 或测试内提前退出）" : ""}` +
        `：${show(missing)}`,
    );
  }

  // g-419②：**双向**比对 —— 产出完成事件却不在目标集合内的文件同样判红
  // （关闭「Node 实际跑得比 helper 展开/声明更多」：glob 展开口径差异、默认发现漏网）。
  const extra = [...completed].filter((f) => !targetSet.has(f));
  if (extra.length > 0) {
    problems.push(
      `有文件产出了完成事件却**不在目标文件集合内**（Node 实际运行集大于 helper 推导/声明集合）` +
        `${extra.length} 个：${show(extra)} ⇒ 声明集合不代表实际运行集，fail-closed 判红`,
    );
  }
  return problems;
}

/**
 * g-421：**运行证据不变式**的唯一实现（非抛错形态；空数组 = 证据链完整）。
 *
 * 这是一次嵌套运行的**证据充分性核心**，**正向与负向裁决必须共用它**（同口径 fail-closed）：
 *   ① 干净事件通道必须完整（runner 汇总 + 逐事件计数）—— 人类可读汇总混有测试自己的 `console.log`，
 *      可被打印伪造（如 `ℹ tests 1`），单独采信即永真；
 *   ② 人类可读汇总 ↔ 事件通道 `summary` **逐字段**一致（{@link CROSS_CHECK_FIELDS}）；
 *   ③ 事件通道**内部** `tally` ↔ `summary` 逐字段交叉校验且两侧口径自洽
 *      （{@link nestedChannelCrossCheckProblems}，g-420①）；
 *   ④ **逐目标文件完成事件覆盖**（{@link nestedTargetCoverageProblems}，g-416/g-419②，双向、`>0`）。
 *
 * 为什么必须共用：{@link assertNestedSuiteFailed} 曾只核「非零退出 + 输出正则」，于是
 * 「注册失败断言后立即 `process.exit(1)`」（`channel.files=[]`、断言从未执行）可冒充「预期失败」
 * （g-421 P1，false-positive test evidence）。抽成单一实现后，任何**据证据下结论**的裁决路径
 * 都只能经它，未来新增裁决 helper 漏掉不变式会被 `g421` 结构性守卫判红。
 */
export function nestedEvidenceProblems(run: NestedRunResult): string[] {
  const s = run.summary;
  const problems: string[] = [];
  const channel = run.channel;
  if (!channel || !channel.summary || !channel.tally) {
    problems.push(
      "干净事件通道不完整（缺 runner 汇总或逐事件计数）⇒ 人类可读汇总可被测试打印伪造，计数不可信，fail-closed 判红",
    );
  } else {
    for (const field of CROSS_CHECK_FIELDS) {
      if (channel.summary[field] !== s[field]) {
        problems.push(
          `人类可读汇总与事件通道不一致：${field} ${s[field]} ≠ ${channel.summary[field]}（人类通道可能被伪造）`,
        );
      }
    }
    // g-420①：事件通道**内部**（逐事件计数 ↔ runner 汇总）同样逐字段交叉校验（与顶层闸门同口径）。
    problems.push(...nestedChannelCrossCheckProblems(channel.tally, channel.summary));
  }
  problems.push(...nestedTargetCoverageProblems(run.targets, channel, run.cwd));
  return problems;
}

/** 断言嵌套运行「真的跑了」且**全绿**（g-413 补全判据，见 {@link nestedSuitePassProblems}）。 */
export function assertNestedSuitePassed(run: NestedRunResult, label: string): void {
  assertNestedSuiteRan(run, label);
  const problems = nestedSuitePassProblems(run);
  if (problems.length > 0) {
    assert.fail(`${label}：期望全绿的嵌套运行不达标 —— ${problems.join("；")}\n${tail(run, 1500)}`);
  }
}

/**
 * g-421：**真实 test/subtest 级失败事件**（排除「文件包装」因进程退出码/信号被判失败的合成事件）。
 *
 * 判据（两道，缺一不可）：
 *   ① `entityType === "test"` —— `suite` 是聚合块，不是断言；
 *   ② `exitCode === null && signal === null` —— 带进程级退出码/信号的是 Node 为**文件进程**失败
 *      合成的「包装失败」（`test('pass',()=>{}) + process.exitCode = 1` 即此形态），**不是**断言失败。
 *
 * 为什么需要它：「非零退出 + 文件级完成事件 + 输出正则」全部可以被「良性用例 + 改退出码」满足
 * （实测 `code 1 / tests 2 / pass 1 / fail 1 / files=1`，那 1 个 fail 只是文件包装）⇒ 负向裁决
 * 必须要求**确有 test 级失败**，否则「预期失败」可被无断言失败的运行冒充。
 */
export function nestedTestLevelFailures(run: NestedRunResult): TestFailureEvent[] {
  return (run.channel?.failures ?? []).filter(
    (f) => f.entityType === "test" && f.exitCode === null && f.signal === null,
  );
}

/**
 * g-421：**负向裁决**的非抛错形态（{@link assertNestedSuiteFailed} 的实现体；空数组 = 如期报红且证据充分）。
 *
 * 判据 = **非零退出（且非信号终止）** + **输出含预期错误特征** + **与正向裁决同一组证据不变式**
 * （{@link nestedEvidenceProblems}：目标集合 ≡ 逐文件完成事件集合且 `>0` + 通道/口径交叉校验）
 * + **`cancelled === 0 && skipped === 0 && todo === 0`**（g-424，与正向裁决/顶层闸门同口径）
 * + **确有 test/subtest 级真实失败事件**，且（传入签名时）该失败事件的文本**匹配签名**。
 *
 * 前两条是 g-407 的「双断言」；第三条是 g-421 第一轮收口（早退 ⇒ 无完成事件）；
 * 第四条是 g-421 第二轮收口 —— 只核覆盖挡不住「**良性用例 + `process.exitCode = 1`**」：
 * 该形态**正常产出**文件级完成事件、计数自洽，唯一破绽就是「失败事件是文件包装，没有 test 级断言失败」；
 * 第五条是 g-424 收口（终局复核在 tip `7121112` 实测的新 P1）—— 只核「有 test 级失败事件 + 签名匹配」
 * 挡不住「**签名由另一个目标的真实失败满足、而被声明的目标其断言从未执行**」（另一目标被 `skip`/`todo`/
 * `cancelled`）。这三类用例**照常**产出文件级完成事件、计数自洽 ⇒ 覆盖/通道校验都看不出来，唯有与正向
 * 裁决同口径地**点名拒绝**。
 *
 * 与 {@link nestedSuitePassProblems} **共用同一实现**（不各写一份）—— 守卫见
 * `core/tests/g421-nested-runner-negative-verdict.test.ts`。
 */
export function nestedSuiteFailedProblems(run: NestedRunResult, signature: RegExp): string[] {
  // g-421：签名是**必需**判据（省略签名 = 放弃「失败正是预期的那个」这一判据 ⇒ fail-closed 抛错，
  // 不给「弱化调用」留后门；类型上亦为必填，这里是运行时兜底）。
  if (!(signature instanceof RegExp)) {
    throw new Error(
      "负向裁决必须给出签名正则：省略签名等于放弃「失败正是预期的那个失败」判据，不允许弱化调用（g-421）",
    );
  }
  const problems: string[] = [];
  if (run.code === null) {
    problems.push(
      `期望失败的嵌套运行**不得被信号终止**（exit=null）—— 信号终止（SIGKILL/超时等）不是测试断言失败，` +
        `不能作为「如期报红」的证据`,
    );
  } else if (run.code === 0) {
    problems.push(`期望失败的嵌套运行必须非零退出（exit=${run.code}）——只判输出特征会留下单点永真`);
  }
  // g-424：**负向裁决与正向裁决同口径** —— 与 {@link nestedSuitePassProblems} / 顶层闸门一致，
  // 要求 `cancelled === 0 && skipped === 0 && todo === 0`（各自**点名红因**，措辞与正向裁决同口径）。
  //
  // 为什么必须（终局复核在 tip `7121112` 上实测的新 P1）：只核「证据核心 + ≥1 test 级真实失败事件 +
  // 签名匹配」**挡不住**「签名由**另一个目标**的真实失败满足、而**被声明的目标其断言从未执行**」。
  // 最小复现（两目标、真实可达，无需蓄意破坏）：
  //   A = `test('expected', () => assert.fail('EXPECTED_NEGATIVE_SIG'))`
  //   B = `test.skip('skipped intended assertion', () => { throw new Error('EXPECTED_NEGATIVE_SIG') })`
  //   ⇒ 实测 `code 1 / tests 2 / fail 1 / skipped 1 / files=[A,B] / test 级失败 1 条`，
  //   旧负向裁决**接受** —— 而 B 的意图断言**从未执行**（`test.skip` 的回调根本不运行）。
  // 同理：`todo` 是「零验证」（不计入 pass/fail，可 exit 0），`cancelled`（timeout/取消）意味着用例
  // 未跑完 ⇒ 三者都是「断言未执行/未验证却可冒充如期报红」的旁路。
  // 这三条与 {@link nestedEvidenceProblems} 的「覆盖/通道」正交：skip/todo 的用例**照常**产出文件级
  // 完成事件、计数自洽，故覆盖校验与通道交叉校验都看不出来。
  if (run.summary.cancelled > 0) {
    problems.push(
      `有被**取消**的用例（cancelled=${run.summary.cancelled}）—— 取消的用例断言**从未执行**，` +
        `不能作为「如期报红」的证据（负向裁决与正向裁决同口径）`,
    );
  }
  if (run.summary.skipped > 0) {
    problems.push(
      `有用例被**跳过**（skipped=${run.summary.skipped}）—— 跳过的用例断言**从未执行**，` +
        `不能作为「如期报红」的证据（负向裁决与正向裁决同口径）`,
    );
  }
  if (run.summary.todo > 0) {
    problems.push(
      `有**待办**用例（todo=${run.summary.todo}）—— 待办不是验证，` +
        `不得作为「如期报红」的证据（负向裁决与正向裁决同口径）`,
    );
  }
  // g-421：同口径证据不变式 —— 失败必须由**目标文件的真实测试断言**产生。
  for (const problem of nestedEvidenceProblems(run)) {
    problems.push(
      `负向裁决证据不足：失败不是由目标文件真实测试断言产生的可能（提前退出 / 断言未执行）——${problem}`,
    );
  }
  // g-421：**必须存在 test/subtest 级的真实失败事件**，且其 **error/details 文本**匹配签名。
  // ⚠️ 签名**只**在事件通道上匹配，**绝不**匹配 stdout / 整段人类可读输出 —— 后者正是伪造面
  // （夹具可自己 `console.error(<签名>)`）；`name=<basename>` + `error="test failed"` 的退出码伪装
  // 也正因「事件文本不含调用方签名」而被拒。
  const testFailures = nestedTestLevelFailures(run);
  if (testFailures.length === 0) {
    const wrapper = (run.channel?.failures ?? []).filter((f) => f.exitCode !== null || f.signal !== null);
    problems.push(
      `事件通道中**没有任何 test/subtest 级的失败事件** ⇒ 失败只是**文件包装**（进程退出码/信号）被判失败，` +
        `本该失败的断言根本没执行（实测形态：良性用例通过 + \`process.exitCode = 1\`；` +
        `包装失败事件 ${wrapper.length} 条）——「非零退出 + 文件级汇总 + 输出正则」不足以证明「确有一次真实断言失败」`,
    );
  } else {
    const matched = testFailures.some((f) => {
      signature.lastIndex = 0; // 每个候选都重置（带 /g 的签名会推进 lastIndex）
      return signature.test(`${f.name}\n${f.message}`);
    });
    if (!matched) {
      const seen = testFailures
        .map((f) => `${f.name}: ${f.message.slice(0, 80)}`)
        .join(" | ")
        .slice(0, 400);
      problems.push(
        `期望失败的嵌套运行必须输出预期错误特征 ${signature}，且该特征必须由 **test/subtest 级失败事件的 ` +
          `error 文本**命中（只看 stdout/人类可读输出会被伪造）：test 级失败事件有 ${testFailures.length} 条，` +
          `但**没有一条的文本匹配** —— 失败不是「预期的那个失败」（fail-closed 判红）；实际失败：${seen}`,
      );
    }
  }
  return problems;
}

/**
 * 断言嵌套运行「真的跑了」且**如期报红** —— **四重断言**：非零退出码（且非信号终止）**且** 输出含预期
 * 错误特征 **且** 证据链充分（{@link nestedEvidenceProblems}）**且** 事件通道里**确有 test/subtest 级
 * 真实失败事件**（其文本还必须匹配签名）。
 * 单看退出码会留下单点永真（子进程从未运行、或为了别的原因失败，都会被误读为「负向对照成立」）；
 * 只看「非零退出 + 输出特征」会留下 g-421 第一轮的 P1（打印特征后立即早退 ⇒ 断言从未执行却判「如期报红」）；
 * 只看「非零退出 + 完成事件覆盖」会留下第二轮的 P1（**良性用例 + `process.exitCode = 1`** ⇒ 文件级
 * 完成事件与计数都正常，`fail 1` 只是**文件包装**被判失败，断言根本没失败）。
 */
export function assertNestedSuiteFailed(run: NestedRunResult, label: string, signature: RegExp): void {
  assertNestedSuiteRan(run, label);
  const problems = nestedSuiteFailedProblems(run, signature);
  if (problems.length > 0) {
    assert.fail(`${label}：期望失败的嵌套运行不达标 —— ${problems.join("；")}\n${tail(run, 1500)}`);
  }
}

/**
 * g-421：**据运行证据下最终结论**的裁决 helper（结构性守卫 `core/tests/g421-*.test.ts` 的唯一真源）。
 * 每一个的**调用闭包**都必须到达 {@link nestedEvidenceProblems} —— 新增裁决 helper 若漏掉覆盖/通道
 * 不变式，守卫会因为「闭包到不了核心」而判红（不靠人工 remember）。
 */
export const NESTED_EVIDENCE_VERDICTS = [
  "nestedSuitePassProblems",
  "nestedSuiteFailedProblems",
  "assertNestedSuitePassed",
  "assertNestedSuiteFailed",
] as const;

/**
 * g-421：**据运行证据下结论**的阶段组件（被终局裁决与 `g353`/自证闸门直接消费）—— 它与终局裁决
 * **同一组**不变式：调用闭包同样必须到达 {@link nestedEvidenceProblems}（不是弱裁决的豁免名单）。
 * 守卫另外钉住它必须被至少一个 {@link NESTED_EVIDENCE_VERDICTS} 组合。
 */
export const NESTED_EVIDENCE_PRECONDITIONS = ["assertNestedSuiteRan"] as const;

/**
 * g-421：**证据不变式的构成部分**（{@link nestedEvidenceProblems} 本体 + 其两个判据实现）。
 * 守卫钉住核心本体必须引用两个构成判据（防止把核心掏空成恒返回 `[]` 的空壳）。
 */
export const NESTED_EVIDENCE_PARTS = [
  "nestedEvidenceProblems",
  "nestedChannelCrossCheckProblems",
  "nestedTargetCoverageProblems",
] as const;

/**
 * g-421：**非裁决**运行时导出（纯工具 / 解析 / 运行入口 / 入口门禁 / 查询助手 / 守卫清单常量）——
 * 它们**不据运行证据下结论**，故不要求消费 {@link nestedEvidenceProblems}。
 *
 * 为什么要有这张表：结构性守卫要求**所有运行时导出的名字被四张清单恰好覆盖一次**
 * ⇒ 任何新增导出（`function` / `async function` / `const … = …`）都必须**显式归类**：
 * 归进 {@link NESTED_EVIDENCE_VERDICTS}/{@link NESTED_EVIDENCE_PRECONDITIONS} 就必须履行证据不变式，
 * 归进本清单则是「我声明它不下结论」的**显式**决定。未归类的导出 ⇒ 守卫**判红**（fail-closed），
 * 不会被静默跳过 —— 这正是「未来新增弱裁决 helper」的防回归缺口。
 */
export const NESTED_NON_VERDICT_EXPORTS = [
  // 入口门禁（spawn 前 fail-closed 拒绝执行，不产生运行证据，故无「裁决」可言）
  "TEST_CONTEXT_VARS",
  "TEST_SELECTION_OPTION_NAMES",
  "NESTED_SHELL_SUBSET",
  "VALUE_TAKING_TEST_OPTIONS",
  "findTestSelectionOption",
  "nestedTestSelectionProblem",
  "assertNoNestedTestSelection",
  "nestedArgvTestSelectionProblem",
  "assertNoNestedArgvTestSelection",
  // 运行入口 / 环境
  "cleanTestEnv",
  "runNestedCommand",
  "runNestedArgv",
  // 解析与查询
  "parseTestSummary",
  "parseEventChannel",
  "tallyOf",
  "expandNestedTargets",
  "deriveNestedTargetTokens",
  "nestedTestLevelFailures",
  // 本节的守卫清单常量自身
  "NESTED_EVIDENCE_VERDICTS",
  "NESTED_EVIDENCE_PRECONDITIONS",
  "NESTED_EVIDENCE_PARTS",
  "NESTED_NON_VERDICT_EXPORTS",
] as const;

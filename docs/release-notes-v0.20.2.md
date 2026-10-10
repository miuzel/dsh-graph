## v0.20.2 — 2026-10-10

- **Windows 上派发不再因「工具名对不上」而起不来**：宿主提供哪套 shell 工具（`bash` / `pwsh`）由平台条件化的组合声明决定；旧版按固定名字预置白名单，组合里装的若是另一套，Windows 上评审 / 上下文收集 / 极简执行三条派发路径会直接起不来（工具调用报 `tools.restrict() names unknown`）。本版改为**按组合实际声明的工具名解析**，缺所需能力时给出可读诊断，不再让子代理无声失败。
- **两平台门禁新增「组合与系统行为」探针层**：新增共享探针覆盖 shell 工具名解析、角色白名单求交、派发可用、路径大小写语义、换行与编码往返、命令引号与参数传递 —— 单一定义、Windows 执行件与跨平台执行件共用；组合声明一变就判红，缺真机事实时如实标注跳过，不冒充通过。
- **注入式判定不再被真实系统带跑偏**：判「大小写敏感卷」时旧实现仍去问真实文件系统，在 Windows / macOS 这类真实不敏感卷上会得出错误结论；本版让三种注入状态全部忠实、判定与真实卷解耦。同时修好 Windows 上组合声明的自动发现（旧实现调用 `npm` 不经 shell 必然失败），找不到时给出可复制的定位命令。
- **配置与行为零变化**：宿主兼容声明范围、设置项与看板行为均未改动；从 v0.20.1 升级无需任何手工动作。

### 安装 / 升级

```sh
dsh plugin --profile <name> add dsh-graph@0.20.2
```

从 v0.20.1 升级**无需任何手工动作**：本版只改「派发工具名解析 / 门禁探针 / 注入判定」；宿主兼容声明范围（`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` 同为 `>=0.1.5-rc.2 <0.2.2-0`）、设置项与数据格式均未改动。

### 验证与产物

- **Linux / WSL2（本版已在发布准备轮实测）**：整套件自证闸门 2411/2411 全绿（`fail=0`/`skipped=0`，退出码 0）、`tsc --noEmit` 0 错；门禁执行件在本机（静态层）`win-smoke --self-test` 全绿、`win-smoke --static-only` 通过 8/失败 0/告警 0、`platform-smoke --static-only` 通过 14/失败 0/告警 0；回传 H3 事实后两者分别升为 9/0/0 与 15/0/0（`H3=PASS`）。逐项证据见 [`docs/release-checklist-v0.20.2.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.20.2.md)。
- **Windows 真机门禁（红线 1）：本版已在原生 Windows 上实测通过** —— 候选包（见下「发布产物」）在 `win32/x64` + Node `v24.21.0` 上完成三段：**Round A'（静态复跑）** `win-smoke` 通过 8/失败 0/告警 0、`platform-smoke` 通过 12/失败 0/告警 2（两条告警为 win32 恒定项：大小写不敏感卷、无第二个可写文件系统），harness 组合矩阵 `H1/H2/H4/H5/H6 = PASS`；**Round B（完整 tarball 门禁，宿主 `0.2.1-alpha.2`）** 通过 15/失败 0/告警 1、看板文件系统生命周期 32/32 步，附测更旧宿主代际 `0.2.0-rc.2` 同样 15/失败 0/告警 1（唯一告警：包内不含 `core/*.ts`，故台账不对账，属设计内）；**H3（派发可用）** 见下一条。逐字回传与判读见 [`docs/platform-gate.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md) **§7.10 / §7.11**。⚠️ **口径边界**：Round A' 与 Round B 只覆盖**安装 / 启动 / REST** 层，**派发维度只由 H3 回答**（v0.20.1 的教训正是 T1–T5 全绿仍漏掉这类问题）。三段执行配方与两条一手互操作事实见本地产物 `tmp/uat-v0202/WINDOWS-GATE-RECIPE.md`（`tmp/` 不入版本控制）。
  > 关于「包内 README 却写『结论以台账为准、不预称轮次结果』」：这是本版刻意的一轮闭环纪律 —— 包内文件不写任何随真机轮次变化的结论数字，因此**回填真机结论只需改 `docs/`（不入包）而无需重打产物**，从而保证「被测产物 ≡ 发布产物」（同一 sha256，见下）。**判定一律以台账为准**；该措辞**不是**「未验证」。
- **派发可用维度（H3，本版验证核心之一）**：T1–T5 **不含**「派发可用」维度（v0.20.1 的 T1–T5 全绿仍漏掉了本版修的这类问题），故本版把「派发可用」做成**可回传的探针**：在**隔离实例**里真实派发 `reviewer` / `collector` / `executor-minimal` 三条路径，把真 `child_id` 收成事实文件供两道门禁消费（缺事实时如实打印 `SKIP(需真机/实例)`，不冒充通过）。**Linux 隔离实例侧已跑通并回传事实**：两轮独立采集各取得三条真 `child_id`（`collector` / `executor-minimal` / `reviewer`），且同一 `child_id` 在隔离实例自己的 `cards/*.md`、`attempts/att-001/attempt.md`、`reviews/*.md` 里**独立核对命中**（即派发确实发生，而非仅响应字段）；两道门禁消费后 `H3=PASS`。命令、两次事实与门禁输出见本地产物 `tmp/uat-v0202/h3-linux-evidence.md`，采集器为 `tmp/uat-v0202/h3-collect-facts.mjs`。**Windows 侧 H3 亦已由负责人真机回传并判 PASS**：三条路径各得非空 `child_id`（`reviewer` `964dd21c…` / `collector` `218156f3…` / `executor-minimal` `391377c4…`）、`errors` 全空，且同一 `child_id` 在隔离实例自己的 `cards/*.md`、`attempts/att-001/attempt.md`、`reviews/rev-att-001-01.md` 里**独立核对命中**；两道门禁消费后 `H3=PASS`（`win-smoke` 通过 9/失败 0/告警 0、`platform-smoke` 通过 13/失败 0/告警 2，harness 组合矩阵 `H1–H6` **6/6**，事实文件 `%TEMP%\h3-dispatch-facts.json`）。⇒ **本版在原生 Windows 上的三个维度（安装 / 启动 / REST、静态组合矩阵、真派发可用）均已实测通过**；台账中该轮的 H3 一栏同样只回答「派发是否起得来」，**不**代表评审完成了独立验证（后者由评审留痕规范另行承载）。
- **原生 macOS**：**本版未验证** —— 未在原生 macOS 上执行真机门禁 ⇒ **不得读出「已通过」**；两份 README 的平台状态表已按「本版未验证」如实标注（最近一次 macOS 真机结论覆盖 v0.19.8 及更早的产品代码，**不能替代**本版）。
- **发布产物**：`dsh-graph-0.20.2.tgz` — sha256 `f39517c3aa0470e3aa60d9541a06842f4633523f024fd697b456e68aed0e0703`，sha1 `059fae1b6393a1d5c5c35442d10e8a24406e5683`，1,444,792 字节，共 **43 个成员**、包内**不含 `docs/`**（`docs/` 成员数 0）与 `CHANGELOG.md`，包内 `package/package.json` 的 `version` 与包内常量 `PLUGIN_VERSION` 均为 `0.20.2`；包内 `README.md` 与提交源码 `dsh-graph-host/README.md` **逐字节相同**（双方 sha256 `a2064bd7…`）。该指纹来自**隔离 worktree 的独立构建路径**（`.worktrees/g-476-att-01` 内 `bash scripts/build.sh` + `dist/` 内 `npm pack`），同一构建树内**重建重打与本产物 `cmp` 逐字节一致**（同 sha256）；tag 树一侧已按**零构建论证**闭合（tag 树 == 发布线 tip 树，且自打包点起非 `docs/` 改动 = 0 文件 ⇒ 包相关输入逐字节相同，见发布清单 §5/§8），如需字面复现可在 tag 树的隔离 worktree 内重建重打后逐字比对。
- **一轮闭环（本版纪律）**：包内文件**不含任何随本轮真机结论变化的表述** —— 两份 README 的平台状态表按「结论以台账为准」+「宿主代际陈述」措辞，不写轮次计数与结论数字（包内不含 `docs/` 与 `CHANGELOG.md`）⇒ Round A' / Round B / H3 跑完后**只需回填 `docs/`**（不入包），**不会触发第 4 轮产物**。⚠️ 仍需注意（沿用上一版教训）：`dist/` 内若残留上一次打包的 `.tgz`，会被当作普通文件一起打进新包 ⇒ 指纹改变，打包后务必移除 `dist/*.tgz`。
- **发布记录**：[`docs/release-checklist-v0.20.2.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.20.2.md)（含版本一致性三处、`CHANGELOG`/守卫快照、夹具复冻、独立构建路径对账、自证闸门、三段真机回填、**发版前复核记录（含独立复核）**、发布态动作与负责人发布交接单）。

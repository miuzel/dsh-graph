# 全量自证失败分类基线（g-617）

> **本页是本目标判据 1 的交付物**：把「全量 142 例失败」按**根因**分类，而不是当成一个问题。
> 证据采集时间：2026-11-06；基线 commit `bd1bd55`；宿主 DSH **0.2.2-rc.1**（cordis 4.1.0）。
> 复现方式：`core/tests/*.test.ts` 的完整拷贝 + 主树 `dist/` 只读副本（**未在主树构建**），
> 跑 `node scripts/run-tests.mjs`。

## 零、结论

| | 修复前 | 修复后 |
| --- | --- | --- |
| tests | 2920 | 2920 |
| pass | 2776 | **2920** |
| fail | 144（真失败 142） | **0** |
| skipped / todo / cancelled | 0 / 0 / 0 | 0 / 0 / 0 |
| 自证闸门 | ✖ exit≠0 | ✔ `自证通过 … exit=0` |

> 判据 4 的版本自适应：`hostStackCompatible()` 按**能力探测**判定（三包齐备 + cordis 同主版本 +
> 宿主包同 `major.minor.patch` 主干），不再逐字钉死预发布位；`initServiceInstances()` 对
> `[Service.init]` 钩子按 `typeof === "function"` 探测，**全部缺失时明确报错**
> （`G507HostStackMissing`，点名服务与可能原因），不静默跳过用例。

## 一、基线实测计数

| 指标 | 值 |
| --- | --- |
| tests | 2920 |
| pass | 2776 |
| **fail** | **144** |
| skipped / todo / cancelled | 0 / 0 / 0 |

> 目标描述记的是 `fail 142`。实测 144，差的 2 例是 **D 类**（见下），由采集环境（`cp -a` 保留源文件
> mtime 造成 `dist` 新鲜度比较失序）产生，**不是真失败**：同一套件在主树跑是 9/9 全绿。
> 因此「真失败」基线取 **142**，与目标描述一致。

## 二、分类（27 个文件）

| 类 | 例数 | 根因 | 代表用例 / 报错原文 |
| --- | --- | --- | --- |
| **A** | 94 | 直构服务的 `[Service.init]` 从未执行 ⇒ `turnBoundaryProjectionHandle` 永不注册 | `g612-supervisor-switch`、`g610-single-active-real-host`：`TypeError: Cannot read properties of undefined (reading 'stateOf')` |
| **B** | 45 | 同一根因的另一种先撞形态：`AgentLoop[Service.init]` 未跑 ⇒ `ctx.agents.setFactory()` 未执行 | `g506-care`、`g506-care-bootstrap`：`Error: no agent factory registered (load an agent-loop plugin)` |
| **C** | 3 | DSH 0.2.2 新增工具执行器插件未登记进组合台账 | `g362-platform-gate`、`g428-win-os-ledger`：`[registry] … 组合声明了未登记的工具插件 @deepseek-ai/dsh-tool-executor-native` / `-ptc` |
| **D** | 2 | **假红**：采集副本 mtime 失序导致 `dist-freshness-g312` 判红 | 主树同一套件 **9/9 全绿** ⇒ 非真问题 |
| **E** | 0 | 目标描述提到的「webServer 注册 66 条（REST 单例累积）」 | **全量日志 0 命中，无法复现** |

**A 与 B 是同一个根因**，不是两个问题：`cordis` 只在服务经 `ctx.plugin()` / fiber 装载时才自动调用
`[Service.init]()`。夹具都是 `new AgentLoop(ctx, …)` **直构**实例，于是 init 整体不执行；
先碰 `create()` 的用例报 B，先碰 `turnBoundaryOf()` 的报 A。

## 三、为什么不是「夹具依赖了已不存在的接口」

`turnBoundaryProjectionHandle` 在 DSH `0.2.2-rc.1` 中**仍然存在**（`dsh-agent/lib/index.js`:440 / 479 / 487），
`turnBoundaryOf` 仍是它的唯一来源。缺的不是句柄，而是**驱动 init 的那一步**。

最小实证（进程内探针）：

```
未驱动 init           → agents.create() → "no agent factory registered (load an agent-loop plugin)"
显式 await AgentRegistry[Service.init]() → agents.create() → OK
ctx.fiber.await() 无效（这些服务没有 fiber）
```

## 四、A/B 类修复

`core/tests/_host-stack.ts` 新增 `initServiceInstances()`：按**依赖顺序**对直构服务 await 各自的
`[Service.init]`，等价于「依次 `ctx.plugin()`」。调用点覆盖 5 处真实宿主夹具：

- `_g610-real-host.ts`（主力夹具，覆盖 A 类绝大多数用例）
- `g505-keepalive.test.ts`
- `g506-care.test.ts` / `g506-care-bootstrap.test.ts`
- `g612-pause-budget-realhost.test.ts`

顺序为 `WorkingDirectoryService → AgentRegistry → AgentLoop → SubagentRuntime`：前者注册
`workingDirectory` 投影（子代理启动路径要读），后者依次注册 turn-boundary、loop 自有投影与
catalog/timing/identity 投影。

## 五、0.2.2 的第二个契约差异：工具执行器

初始化问题修好后，turn 仍然立刻以
`The selected tool executor is unavailable. Load an executor in this composition` 结束。
0.2.2 起工具批次由**工具执行器提供者**承载（`ctx.tools.setExecutor()`，每作用域恰一个），
`dsh-base` 组合默认装载 `@deepseek-ai/dsh-tool-executor-native`。
夹具补齐为 `hostCtx.tools.setExecutor(new NativeToolExecutor(hostCtx))`（与宿主组合同一实现）。

## 六、C 类修复：组合台账补登记

`scripts/win-smoke-test.mjs` 的 `DSH_TOOL_PLUGIN_REGISTRY` 补两行——二者**不注册模型面向工具**，
是互斥的执行策略选择，故登记为 `null` + 非目标理由（与既有 `call-timeout-policy` 同范式）：

```
["@deepseek-ai/dsh-tool-executor-native", null, "工具执行器（原生直执行），不注册模型面向工具；与 ptc 互斥"]
["@deepseek-ai/dsh-tool-executor-ptc",    null, "工具执行器（PTC 模式），不注册模型面向工具；组合里默认 disabled"]
```

## 六·补　宿主栈解析顺序（判据 4：「装配到当前已安装 DSH」）

修复过程中发现 `_host-stack.ts` 的 ②「已安装宿主」探测**在本仓库内必然落空**：本仓库从不声明
`@deepseek-ai/dsh` 为依赖，`require.resolve("@deepseek-ai/dsh/package.json")` 永远 MODULE_NOT_FOUND，
于是每次解析都退到 ③ `tmp/g507-host-stack` 私有副本（旧 0.2.1-rc.2）。两处缺陷：

1. **未探测全局安装**：补 `npm root -g` → `<globalRoot>/@deepseek-ai/dsh`；
2. **目录形态只认一种**：全局安装形态 `<globalRoot>/@deepseek-ai/dsh` 没有 `node_modules/` 外层，
   宿主栈实际在 `<dsh>/node_modules/@deepseek-ai`（npm 按依赖就近放置）；`scopeFromDsh` 现同时探测两种形态。

修复后解析结果为 `source: "installed-host"`，指向本机 DSH **0.2.2-rc.1** 的 `node_modules/@deepseek-ai`。
这同时解释了修复前 `g612-goal-budget-http` 那例「找不到 `tmp/g507-host-stack/node_modules/zod`」——
旧私有副本缺依赖，而真正安装的宿主是完整的。

## 七、未削弱覆盖的交代

本目标**没有删除、跳过或弱化任何断言**：改动只发生在夹具的**装配方式**与一份组合台账上；
用例集合、断言语句与判据均未触碰。修复后 pass 数上升、fail 归零，`skipped`/`todo`/`cancelled` 保持 0。

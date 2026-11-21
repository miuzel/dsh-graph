/**
 * g-624 / g-627：`SubagentActivationSpec` 形态回归（g-627 收窄后只剩**扁平**一种形态）。
 *
 * 真机证据（DSH 0.2.2-rc.3 隔离实例派发）：报
 * `Cannot read properties of undefined (reading 'id')`、`child_id: null`，子代理未真正启动。
 * 根因不是 provider 探测，而是 rc.3 改了 spec 形态：
 *   · rc.1（=`0.2.2-rc.1`）及更早：`{ provider, label, request: { prompt, parent, ... }, signal }`
 *     —— rc.1 的真实 `startActivation` 用 `spec.request.parent.id` 取 parent；
 *   · rc.3（=`0.2.2-rc.3`）起：`{ provider, label, prompt, parent, ..., signal }`
 *     —— `request` 嵌套层被移除（rc.3 自带
 *     `docs/upgrade-guide/v0.2.1-rc.2/subagent-activation-options/guide.md`：把
 *     `request: task` 换成 `...task`，label/signal 保持在 spread 之后）。
 * 旧代码把 parent/prompt 放进 `request` 后整包交给 rc.3 的 `startActivation` ⇒ `spec.parent`
 * 为 undefined ⇒ 读 `.id` TypeError（正是上面那条真机报错）。
 *
 * **g-627 收窄**（宿主下限 = `>=0.2.2-rc.3`，见 `dsh-graph-host/package.json` 的 `engines.dsh`）：
 * 下限取 rc.3 的理由是「只支持真机验证过的版本」—— `0.2.2-rc.1` / `rc.2` **从未做过真机验证**，
 * 声称支持它们本身不实在。它们（连同更早宿主）因此**都在声明范围外**，而嵌套形态的最后使用者正是
 * 它们 ⇒ 嵌套分支删除、收口点只产出扁平形态，与 manifest 下界一致、无自相矛盾。
 *
 * 断言面：
 *  A① 扁平形态逐字段（含显式 `delivery: "parent"`）与引用透传；
 *  A② 可选项（toolFilter/agentOptions/cwd/agentPreset）全部上提到顶层、不丢不改名；
 *  A③ 显式 undefined 的可选项不泄漏成键；
 *  A④ 缺 `startActivation` ⇒ fail-closed 明确报错（点名宿主版本过低），绝不虚构 childId；
 *  A⑤ 反向变异：旧嵌套形态喂给真实 rc.3 形态的严格假服务必须被拒（判据本身有效）；
 *  A⑥ 结构守卫：嵌套分支已删除（不得回潮），5 个调用点不各自拼形态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startSubagentCompat } from "../../dist/index.js";

const REPO = join(import.meta.dirname, "../..");
const HOST_SOURCE = join(REPO, "dsh-graph-host/index.js");

type Spec = Record<string, any>;

/** rc.3（0.2.2-rc.3）能力面：没有 list()，spec 扁平（prompt/parent 在顶层）。严格校验形态。 */
function rc3Service(received: Spec[]) {
  return {
    getProvider: (name: string) => (name === "spawn" ? { prepareContinuable() {} } : undefined),
    startActivation: async (spec: Spec) => {
      assert.equal("request" in spec, false, "不得收到 request 嵌套（rc.3 已删除该字段）");
      assert.ok(Array.isArray(spec.prompt), "顶层必须有 prompt");
      assert.ok(spec.parent, "顶层必须有 parent（rc.3 读 spec.parent.id）");
      assert.equal(spec.delivery, "parent", "delivery 必填；必须显式 parent（结果通知父代理）");
      received.push(spec);
      return { childId: "rc3-child", result: {}, dispose: async () => {} };
    },
  };
}

const sortedKeys = (spec: Spec) => Object.keys(spec).sort();

test("g-624 A① 扁平 spec（无 request）+ 显式 delivery=parent，引用原样透传", async () => {
  const received: Spec[] = [];
  const parent = { id: "parent-2" };
  const prompt = [{ type: "text", text: "g-624 rc.3" }];
  const sig = new AbortController().signal;
  const started: any = await startSubagentCompat(rc3Service(received), {
    provider: "spawn", label: "graph:g-2/att-01", parent, prompt, signal: sig,
  });
  assert.equal(received.length, 1);
  assert.deepEqual(sortedKeys(received[0]), ["delivery", "label", "parent", "prompt", "provider", "signal"],
    "形态必须扁平（prompt/parent 上提、无 request）");
  assert.equal(received[0].provider, "spawn");
  assert.equal(received[0].label, "graph:g-2/att-01");
  assert.equal(received[0].parent, parent);
  assert.equal(received[0].prompt, prompt);
  assert.equal(received[0].signal, sig);
  assert.equal(received[0].delivery, "parent");
  assert.equal(started.childId, "rc3-child");
});

test("g-624 A② cwd/agentPreset/agentOptions/toolFilter 等可选项全部上提、不丢不改名", async () => {
  const parent = { id: "p" };
  const prompt = [{ type: "text", text: "opts" }];
  const toolFilter = { allow: ["read"] };
  const agentOptions = { provider: "deepseek", model: "m-1", reasoningEffort: "high" };
  const sig = new AbortController().signal;
  const rc3: Spec[] = [];
  await startSubagentCompat(rc3Service(rc3), {
    provider: "spawn", label: "graph:g-5/att-01", parent, prompt, signal: sig,
    toolFilter, agentOptions, cwd: "/tmp/some-checkout", agentPreset: "ptc",
  });
  assert.equal(rc3[0].toolFilter, toolFilter);
  assert.equal(rc3[0].agentOptions, agentOptions);
  assert.equal(rc3[0].cwd, "/tmp/some-checkout");
  assert.equal(rc3[0].agentPreset, "ptc");
  assert.equal("request" in rc3[0], false);
});

test("g-624 A③ 显式 undefined 的可选项不泄漏成键", async () => {
  const parent = {};
  const prompt: unknown[] = [];
  const rc3: Spec[] = [];
  await startSubagentCompat(rc3Service(rc3), {
    provider: "spawn", label: "x", parent, prompt, signal: new AbortController().signal,
    toolFilter: undefined, agentOptions: undefined,
  });
  assert.deepEqual(sortedKeys(rc3[0]), ["delivery", "label", "parent", "prompt", "provider", "signal"]);
});

test("g-627 A④ 低版本宿主（只有 startContinuable，≤0.2.1-alpha.1）⇒ fail-closed，绝不虚构 childId", async () => {
  const legacyCalls: string[] = [];
  // 低版本宿主的真实面貌：**只有** startContinuable（没有 startActivation）
  const svc = {
    startContinuable: async () => { legacyCalls.push("startContinuable"); return { childId: "legacy-child" }; },
  };
  let returned: any = "SENTINEL-NOT-CALLED";
  try {
    returned = await startSubagentCompat(svc, {
      provider: "spawn", label: "graph:collect/g-3/c-1", parent: {}, prompt: [], signal: new AbortController().signal,
    });
  } catch (e: any) {
    assert.match(String(e?.message ?? e), /缺少派发 API/, "必须给出明确的「缺少派发 API」错误");
    assert.match(String(e?.message ?? e), /0\.2\.2-rc\.3/, "错误须点名最低支持宿主版本（可操作；下限为 rc.3）");
    assert.deepEqual(legacyCalls, [], "旧名 startContinuable 绝不得被调用（回退已删除）");
    return;
  }
  assert.fail(`缺 startActivation 时必须抛错，而不是返回 ${JSON.stringify(returned)}（静默回退/虚构 childId）`);
});

test("g-624 A⑤ 反向变异可捕获：旧嵌套形态被严格假服务拒绝（判据本身有效）", async () => {
  const parent = {};
  const prompt: unknown[] = [];
  const nested = { provider: "spawn", label: "x", request: { parent, prompt }, signal: new AbortController().signal, delivery: "parent" };
  // 嵌套形态喂给 rc.3 ⇒ 严格校验必须拒绝（说明「回潮到嵌套」会被判红）
  await assert.rejects(() => rc3Service([]).startActivation(nested as any), /request/);
});

test("g-627 A⑥ 结构守卫：形态只在收口点构建，且嵌套 request 分支已删除（不得回潮）", () => {
  const src = readFileSync(HOST_SOURCE, "utf8");
  assert.match(src, /function buildSubagentActivationSpec\(/, "形态构建必须收口在 helper 内");
  assert.match(src, /\.\.\.task,/, "helper 必须保留扁平展开");
  // g-627：嵌套分支与 list() 判别必须已删除 —— 纯注释里的历史说明不计（只看可执行代码）。
  assert.equal(/request: task,/.test(src), false, "不得再产出嵌套 request 形态");
  assert.equal(/typeof subagents\?\.list === "function"/.test(src), false, "不得再用 list() 判别形态");
  const requestBuilds = [...src.matchAll(/const request = \{/g)];
  assert.equal(requestBuilds.length, 0, "5 个调用点不得再各自构造 request（形态判断只允许在收口点）");
});

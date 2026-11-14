/**
 * g-624：`SubagentActivationSpec` **形态**双版本兼容回归。
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
 * 修复契约：**5 个调用点只提交扁平 payload**（provider/label/signal/prompt/parent/可选项），
 * 形态由唯一收口点 `startSubagentCompat` 按**可核实的能力探测**构建：
 *   · 有 `list()`（rc.1/rc.2 及所有只有 startContinuable 的旧宿主）⇒ 嵌套 `request`；
 *   · 无 `list()` 且只有 `startActivation`（rc.3+）⇒ 扁平展开。
 *   `list()` 被删除与 spec 扁平化是同一个 rc.3 版本（rc.3 自带
 *   `docs/upgrade-guide/v0.2.1-rc.2/subagent-service-methods/guide.md`），故它是可核实判别依据。
 *
 * 反向变异必须判红：下面的 rc.1/rc.3 假服务**自身严格校验**收到的形态 —— 若 helper 把扁平形态
 * 发给 rc.1（或把嵌套形态发给 rc.3），假服务立刻抛错、用例必红；「反形态被严格假服务拒绝」另有
 * 独立用例证明这套判据真的能捕获倒置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startSubagentCompat } from "../../dist/index.js";

const REPO = join(import.meta.dirname, "../..");
const HOST_SOURCE = join(REPO, "dsh-graph-host/index.js");

type Spec = Record<string, any>;

/** rc.1（0.2.2-rc.1）能力面：有 list()，startActivation 但 spec 仍是嵌套 request。 */
function rc1Service(received: Spec[]) {
  return {
    list: () => ["spawn", "fork"],
    getProvider: (name: string) => (name === "spawn" ? { prepareContinuable() {} } : undefined),
    startActivation: async (spec: Spec) => {
      // 严格形态校验（这里就是「变异会被捕获」的判据）
      assert.ok(spec.request && typeof spec.request === "object", "rc.1 必须收到嵌套 request");
      assert.equal("prompt" in spec, false, "rc.1 顶层不得出现 prompt（rc.1 只读 spec.request.prompt）");
      assert.equal("parent" in spec, false, "rc.1 顶层不得出现 parent（rc.1 只读 spec.request.parent.id）");
      assert.ok(Array.isArray(spec.request.prompt), "rc.1 request.prompt 必须存在");
      assert.ok(spec.request.parent, "rc.1 request.parent 必须存在");
      assert.equal(spec.delivery, "parent", "两版 delivery 都必填；必须显式 parent（结果通知父代理）");
      received.push(spec);
      return { childId: "rc1-child", messageId: "m-1" };
    },
  };
}

/** rc.3（0.2.2-rc.3）能力面：没有 list()，spec 扁平（prompt/parent 在顶层）。 */
function rc3Service(received: Spec[]) {
  return {
    getProvider: (name: string) => (name === "spawn" ? { prepareContinuable() {} } : undefined),
    startActivation: async (spec: Spec) => {
      assert.equal("request" in spec, false, "rc.3 不得收到 request 嵌套（rc.3 已删除该字段）");
      assert.ok(Array.isArray(spec.prompt), "rc.3 顶层必须有 prompt");
      assert.ok(spec.parent, "rc.3 顶层必须有 parent（rc.3 读 spec.parent.id）");
      assert.equal(spec.delivery, "parent", "两版 delivery 都必填；必须显式 parent（结果通知父代理）");
      received.push(spec);
      return { childId: "rc3-child", result: {}, dispose: async () => {} };
    },
  };
}

const sortedKeys = (spec: Spec) => Object.keys(spec).sort();

test("g-624 A① rc.1（有 list）⇒ 嵌套 request 形态 + 显式 delivery=parent", async () => {
  const received: Spec[] = [];
  const parent = { id: "parent-1" };
  const prompt = [{ type: "text", text: "g-624 rc.1" }];
  const sig = new AbortController().signal;
  const started: any = await startSubagentCompat(rc1Service(received), {
    provider: "spawn", label: "graph:g-1/att-01", parent, prompt, signal: sig,
  });
  assert.equal(received.length, 1);
  assert.deepEqual(sortedKeys(received[0]), ["delivery", "label", "provider", "request", "signal"],
    "rc.1 形态的顶层字段必须恰为 provider/label/request/signal/delivery");
  assert.equal(received[0].provider, "spawn");
  assert.equal(received[0].label, "graph:g-1/att-01");
  assert.equal(received[0].signal, sig, "signal 引用必须原样透传");
  assert.deepEqual(sortedKeys(received[0].request), ["parent", "prompt"]);
  assert.equal(received[0].request.parent, parent, "parent 引用必须原样放进 request");
  assert.equal(received[0].request.prompt, prompt, "prompt 引用必须原样放进 request");
  assert.equal(started.childId, "rc1-child");
});

test("g-624 A② rc.3（无 list）⇒ 扁平 spec（无 request）+ 显式 delivery=parent", async () => {
  const received: Spec[] = [];
  const parent = { id: "parent-2" };
  const prompt = [{ type: "text", text: "g-624 rc.3" }];
  const sig = new AbortController().signal;
  const started: any = await startSubagentCompat(rc3Service(received), {
    provider: "spawn", label: "graph:g-2/att-01", parent, prompt, signal: sig,
  });
  assert.equal(received.length, 1);
  assert.deepEqual(sortedKeys(received[0]), ["delivery", "label", "parent", "prompt", "provider", "signal"],
    "rc.3 形态必须扁平（prompt/parent 上提、无 request）");
  assert.equal(received[0].provider, "spawn");
  assert.equal(received[0].label, "graph:g-2/att-01");
  assert.equal(received[0].parent, parent);
  assert.equal(received[0].prompt, prompt);
  assert.equal(received[0].signal, sig);
  assert.equal(received[0].delivery, "parent");
  assert.equal(started.childId, "rc3-child");
});

test("g-624 A③ 只有 startContinuable 的旧宿主（≤0.2.1-alpha.1）仍是嵌套形态（不退化）", async () => {
  const received: Spec[] = [];
  const svc = {
    startContinuable: async (spec: Spec) => {
      assert.ok(spec.request && spec.request.parent && Array.isArray(spec.request.prompt),
        "旧 API 宿主全部早于 rc.3 扁平化 ⇒ 必须收到嵌套 request");
      assert.equal(spec.delivery, "parent");
      received.push(spec);
      return { childId: "legacy-child", messageId: "m-2" };
    },
  };
  const parent = { id: "parent-3" };
  const got: any = await startSubagentCompat(svc, {
    provider: "spawn", label: "graph:collect/g-3/c-1", parent, prompt: [], signal: new AbortController().signal,
  });
  assert.equal(got.childId, "legacy-child");
  assert.deepEqual(sortedKeys(received[0]), ["delivery", "label", "provider", "request", "signal"]);
  assert.equal(received[0].request.parent, parent);
});

test("g-624 A④ 新名优先：同时具备 startActivation/startContinuable 时只走新名、且形态按能力面选", async () => {
  const parent = {};
  const calls: string[] = [];
  // 无 list ⇒ rc.3 扁平；同时存在的旧名绝不能被触碰
  const svc = {
    startActivation: async (spec: Spec) => {
      calls.push("startActivation");
      assert.equal("request" in spec, false);
      return { childId: "c-new", result: {}, dispose: async () => {} };
    },
    startContinuable: async () => { calls.push("startContinuable"); return { childId: "c-old" }; },
  };
  await startSubagentCompat(svc, { provider: "spawn", label: "x", parent, prompt: [], signal: new AbortController().signal });
  assert.deepEqual(calls, ["startActivation"], "新名必须优先，且不得同时调用旧名");
});

test("g-624 A⑤ cwd/agentPreset/agentOptions/toolFilter 等可选项在两种形态下都不丢", async () => {
  const parent = { id: "p" };
  const prompt = [{ type: "text", text: "opts" }];
  const toolFilter = { allow: ["read"] };
  const agentOptions = { provider: "deepseek", model: "m-1", reasoningEffort: "high" };
  const sig = new AbortController().signal;
  const payload = {
    provider: "spawn", label: "graph:g-5/att-01", parent, prompt, signal: sig,
    toolFilter, agentOptions, cwd: "/tmp/some-checkout", agentPreset: "ptc",
  };

  const rc1: Spec[] = [];
  await startSubagentCompat(rc1Service(rc1), payload);
  assert.deepEqual(rc1[0].request, { parent, prompt, toolFilter, agentOptions, cwd: "/tmp/some-checkout", agentPreset: "ptc" },
    "rc.1 的可选项必须全部落在 request 内（不得丢弃/改名）");

  const rc3: Spec[] = [];
  await startSubagentCompat(rc3Service(rc3), payload);
  assert.equal(rc3[0].toolFilter, toolFilter);
  assert.equal(rc3[0].agentOptions, agentOptions);
  assert.equal(rc3[0].cwd, "/tmp/some-checkout");
  assert.equal(rc3[0].agentPreset, "ptc");
  assert.equal("request" in rc3[0], false);
});

test("g-624 A⑥ 显式 undefined 的可选项不泄漏成键（两形态都保持旧调用形态）", async () => {
  const parent = {};
  const prompt: unknown[] = [];
  const rc1: Spec[] = [];
  await startSubagentCompat(rc1Service(rc1), {
    provider: "spawn", label: "x", parent, prompt, signal: new AbortController().signal,
    toolFilter: undefined, agentOptions: undefined,
  });
  assert.deepEqual(sortedKeys(rc1[0].request), ["parent", "prompt"], "未提供的可选项不得以 undefined 键出现");
  const rc3: Spec[] = [];
  await startSubagentCompat(rc3Service(rc3), {
    provider: "spawn", label: "x", parent, prompt, signal: new AbortController().signal,
    toolFilter: undefined, agentOptions: undefined,
  });
  assert.deepEqual(sortedKeys(rc3[0]), ["delivery", "label", "parent", "prompt", "provider", "signal"]);
});

test("g-624 A⑦ 反向变异可捕获：倒置形态会被严格假服务拒绝（判据本身有效）", async () => {
  const parent = {};
  const prompt: unknown[] = [];
  const nested = { provider: "spawn", label: "x", request: { parent, prompt }, signal: new AbortController().signal, delivery: "parent" };
  const flat = { provider: "spawn", label: "x", parent, prompt, signal: new AbortController().signal, delivery: "parent" };

  // 嵌套形态喂给 rc.3 ⇒ rc.3 严格校验必须拒绝（说明 helper 若倒置会红）
  await assert.rejects(() => rc3Service([]).startActivation(nested as any), /request/);
  // 扁平形态喂给 rc.1 ⇒ rc.1 严格校验必须拒绝
  await assert.rejects(() => rc1Service([]).startActivation(flat as any), /嵌套 request|顶层不得/);
});

test("g-624 A⑧ 结构守卫：形态只在收口点构建，5 个调用点不再各自拼 request", () => {
  const src = readFileSync(HOST_SOURCE, "utf8");
  assert.match(src, /function buildSubagentActivationSpec\(/, "形态构建必须收口在 helper 内");
  assert.match(src, /typeof subagents\?\.list === "function"/, "形态判别必须使用可核实的 list() 能力探测");
  assert.match(src, /request: task,/, "helper 必须保留嵌套形态分支");
  assert.match(src, /\.\.\.task,/, "helper 必须保留扁平形态分支");
  const requestBuilds = [...src.matchAll(/const request = \{/g)];
  assert.equal(requestBuilds.length, 0, "5 个调用点不得再各自构造 request（形态判断只允许在收口点）");
});

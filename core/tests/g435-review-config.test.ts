/**
 * g-435 判据验证套件：按项目架构设置 review.regions / contract_paths / non_product_prefixes。
 * 覆盖 10 条质量判据与全部边界条件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  init,
  createGoal,
  findGoalFile,
  setCriteria,
  loadGoal,
  resolveAccept,
  readProjectConfig,
  writeProjectConfig,
  GraphError,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

import {
  resolveReviewPolicy,
  isContractPath,
  regionOfPath,
  regionsOfPaths,
  isProductCodePath,
  countProductChangedLines,
  matchRegionSegment,
  effectiveContractPathsOf,
  effectiveNonProductPrefixesOf,
  effectiveReviewRegionsOf,
  DEFAULT_CONTRACT_PATHS,
  DEFAULT_REVIEW_REGIONS,
  DEFAULT_NON_PRODUCT_PREFIXES,
  CONTRACT_PATHS,
  REVIEW_REGIONS,
  // g-442/g-437：默认值真源（SPEC 表）——用于钉住「不另抄一份默认值」
  REVIEW_LIST_FIELDS,
} from "../review-policy.ts";
// g-437：`resolveAccept(fast_track=true)` 的门禁③改由引擎在 attempt 实际工作树上采集 Git 真源，
// 故本文件的「快速放行」正向/负向用例统一改用真 Git 夹具（策略级纯函数用例不受影响）。
import { makeFastTrackFixture } from "./fixtures/fast-track-fixture.ts";

function fixture(opts: { type?: string; criteria?: string[]; status?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g435-"));
  init(root);
  const goal = createGoal(root, { title: "fixture", version: "v-test", type: opts.type ?? "patch", actor: "t" });
  setCriteria(root, goal, opts.criteria ?? ["判据一 ✅已验", "判据二 ✅已验"], "t");
  const file = findGoalFile(root, goal);
  writeFileSync(file, readFileSync(file, "utf8").replace('"status": "planning"', `"status": "${opts.status ?? "review"}"`));
  return { root, goal, file };
}

/** **策略层**全绿机器报告（仅供策略/门禁判定路径构造入参）。
 *  同样**不构造** attempt/工作树真源段——真源采集与逐项对账的用例走真 Git 夹具。 */
function policyStageReport(over: Record<string, unknown> = {}) {
  return {
    baseline_commit: "86b2c2b",
    changed_paths: ["scripts/build.sh"],
    product_changed_lines: 12,
    untracked_files: 0,
    tests: { exit_code: 0, fail: 0 },
    typecheck: { exit_code: 0 },
    criteria: { all_verified: true },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// host 接线夹具：真实 tool + REST /api/dsh-graph/settings（GET/POST）。
// 与 g311/g342 同款，读 dist/（运行前需 `bash scripts/build.sh`）。
// ---------------------------------------------------------------------------
function hostHarness(root: string) {
  const registered: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  const byName = new Map(registered.map((d: any) => [d.name, d]));
  const exec = { agent: undefined, signal: new AbortController().signal };
  const callTool = (name: string, args: Record<string, unknown> = {}) => byName.get(name)!.execute(args, exec);
  return { byName, routes, callTool };
}

function fakeRes() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

/** 真实 HTTP 入口：GET/POST /api/dsh-graph/settings。 */
async function request(routes: Map<string, any>, method: string, body?: unknown) {
  const handler = routes.get("/api/dsh-graph/settings");
  assert.ok(handler, "settings 路由必须已注册");
  const req: any = {
    method,
    url: "/api/dsh-graph/settings",
    _l: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) { req._l[ev] = cb; },
  };
  const res = fakeRes();
  const p = handler(req, res);
  if (body !== undefined) req._l.data?.(JSON.stringify(body));
  req._l.end?.();
  await p;
  return { code: res._code, body: res._body };
}

/** 真实 resolveAccept(fast_track) 必须被拒（strict）且零副作用。 */
function expectFastTrackRejected(root: string, goal: string, paths: string[], label: string) {
  const events = readEvents(root).length;
  assert.throws(
    () => resolveAccept(root, goal, {
      actor: "supervisor:test", verdict: "accept", fast_track: true,
      machine_report: policyStageReport({ changed_paths: paths }),
    }),
    (e: unknown) => e instanceof GraphError && /fast_track 被拒/.test(e.message) && /strict/.test(e.message),
    `${label}：畸形/不可解析配置必须 fail-closed，不得快速放行`,
  );
  assert.equal(readEvents(root).length, events, `${label}：拒绝必须零副作用`);
}

// ---------------------------------------------------------------------------
// 判据 1：三项 review 列表通过主管设置 / schema 通道往返，保留注释与未知键；非法写入零副作用
// ---------------------------------------------------------------------------
test("g-435 判据 1：三项列表写读往返，保留注释与未知键；非法写入零副作用", () => {
  const { root } = fixture();
  const initialYaml = [
    "# 顶层注释保留",
    "name: test-proj",
    "unknown_top: keep-me",
    "review:",
    "  policy: auto  # policy 注释",
    "  unknown_sub: keep-me-too",
    "",
  ].join("\n");
  writeFileSync(join(root, "project.yaml"), initialYaml, "utf8");

  // 1. 成功写入三项列表
  writeProjectConfig(
    root,
    {
      review: {
        regions: ["src", "lib/client", "packages"],
        contract_paths: ["src/contract.ts", "docs/api.json"],
        non_product_prefixes: ["docs", "test-fixtures"],
      },
    },
    "supervisor:test",
  );

  const cfg = readProjectConfig(root);
  assert.deepEqual(cfg.review.regions, ["src", "lib/client", "packages"]);
  assert.deepEqual(cfg.review.contract_paths, ["src/contract.ts", "docs/api.json"]);
  assert.deepEqual(cfg.review.non_product_prefixes, ["docs", "test-fixtures"]);

  const textAfter = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(textAfter, /# 顶层注释保留/);
  assert.match(textAfter, /unknown_top: keep-me/);
  assert.match(textAfter, /# policy 注释/);
  assert.match(textAfter, /unknown_sub: keep-me-too/);

  // 2. 非法写入拒绝且零副作用（文件逐字节不变）
  const snapBeforeBad = readFileSync(join(root, "project.yaml"), "utf8");
  const badPatches = [
    { review: { regions: ["/abs/path"] } }, // 绝对路径
    { review: { regions: ["C:\\Users\\source"] } }, // Windows 绝对路径
    { review: { contract_paths: ["a/../b"] } }, // .. 路径段
    { review: { regions: ["trail/slash/"] } }, // regions 尾随斜杠
    { review: { contract_paths: ["trail/slash/"] } }, // contract_paths 尾随斜杠
    { review: { non_product_prefixes: ["trail/slash/"] } }, // non_product_prefixes 尾随斜杠
    { review: { regions: ["", "valid"] } }, // 空字符串
    { review: { contract_paths: ["dup", "dup"] } }, // 重复条目
    { review: { non_product_prefixes: ["./dup", "dup"] } }, // 归一后重复
    { review: { regions: [123 as any] } }, // 非字符串类型
    { review: { contract_paths: ["invalid:123"] } }, // 保留前缀 invalid:
    { review: { regions: ["invalid:null"] } }, // 保留前缀 invalid:
  ];

  for (const bad of badPatches) {
    assert.throws(() => writeProjectConfig(root, bad, "supervisor:test"), GraphError);
    assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), snapBeforeBad, "非法写入后文件必须逐字节不变");
  }

  // 3. 注释与未知键保护专项验证
  const commentYaml = [
    "review:",
    "  policy: auto",
    "  regions: # keep-header",
    "    - src",
    "    # item-comment",
    "    - lib",
    "  # unknown_sub 前置注释",
    "  unknown_sub: keep",
    "",
  ].join("\n");
  writeFileSync(join(root, "project.yaml"), commentYaml, "utf8");
  writeProjectConfig(root, { review: { regions: ["app", "server"] } }, "supervisor:test");
  const textAfterUpdate = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(textAfterUpdate, /regions: # keep-header/);
  assert.match(textAfterUpdate, /# unknown_sub 前置注释/);
  assert.match(textAfterUpdate, /unknown_sub: keep/);
  assert.deepEqual(readProjectConfig(root).review.regions, ["app", "server"]);

  // 4. 不支持的 flow-style 映射在更新时明确拒绝零副作用，不写坏文件
  const flowYaml = `review: { policy: auto, regions: [src], unknown_sub: keep }\n`;
  writeFileSync(join(root, "project.yaml"), flowYaml, "utf8");
  assert.throws(
    () => writeProjectConfig(root, { review: { regions: ["new"] } }, "supervisor:test"),
    GraphError,
  );
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), flowYaml, "flow 写入失败后零副作用");

  // 5. 畸形 YAML 经 GET 读回后若原样 POST 提交，必被拒绝且文件不变，绝不出现字面 invalid:
  //    （F2 修复后读侧不再产出哨兵 ⇒ 该回写由 schema/业务校验拒绝，而不是靠 "invalid:" 前缀报错）
  const malformedYaml = `review:\n  policy: auto\n  regions: [src]\n  contract_paths: 123\n`;
  writeFileSync(join(root, "project.yaml"), malformedYaml, "utf8");
  const readCfg = readProjectConfig(root);
  assert.equal(readCfg.review.config_malformed, true, "畸形字段必须产出 malformed 信号");
  assert.equal(JSON.stringify(readCfg.review).includes("invalid:"), false, "读侧绝不产出内部哨兵");
  assert.throws(
    () => writeProjectConfig(root, { review: readCfg.review }, "supervisor:test"),
    GraphError,
    "读取→原样回写必须被拒绝",
  );
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), malformedYaml, "畸形回写被拒后文件不变");
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8").includes("invalid:"), false);
  // 写侧仍对显式 invalid: 前缀给出「指向 project.yaml 取值非法」的报错（内部保留前缀，不可写入）
  assert.throws(
    () => writeProjectConfig(root, { review: { contract_paths: ["invalid:123"] } }, "supervisor:test"),
    (err: any) =>
      err instanceof GraphError &&
      err.message.includes("project.yaml") &&
      err.message.includes("取值非法"),
    "写侧对 invalid: 前缀的报错语义必须指向配置文件",
  );
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), malformedYaml, "invalid: 写入被拒后文件不变");

  // 6. 连带阻断防护：当存在畸形 review 配置时，只更新不含 review 段的合法 patch 必须成功写入
  writeProjectConfig(root, { executor: { provider: "custom-p", model: "custom-m" } }, "supervisor:test");
  const textAfterUnrelated = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(textAfterUnrelated, /provider: custom-p/);
  assert.match(textAfterUnrelated, /contract_paths: 123/);
  assert.equal(textAfterUnrelated.includes("invalid:"), false);
});

// ---------------------------------------------------------------------------
// 判据 2：持久化设置立即被策略消费；未配置与显式列表由单一默认应用点区分
// ---------------------------------------------------------------------------
test("g-435 判据 2：持久化设置立即生效，单一默认应用点区分未配置与显式空列表", () => {
  const { root } = fixture({ type: "patch" });

  // 1. 未配置时：三项为 null，策略消费默认常量（单一默认应用点）
  const cfgUnset = readProjectConfig(root);
  assert.equal(cfgUnset.review.regions, null);
  assert.equal(cfgUnset.review.contract_paths, null);
  assert.equal(cfgUnset.review.non_product_prefixes, null);
  // g-442/g-437 适配：单一默认应用点现在是 `resolveReviewListInput`（它始终**返回副本**），
  // 故消费侧只断言**值等价**。但「不另抄一份默认值」这一不变式仍然钉住：底部三条断言证明
  // g-442 的 SPEC 表 defaultValues 就是这三个 DEFAULT_* 常量**本体**（引用相等）。
  assert.deepEqual(effectiveReviewRegionsOf(cfgUnset.review.regions), [...DEFAULT_REVIEW_REGIONS]);
  assert.deepEqual(effectiveContractPathsOf(cfgUnset.review.contract_paths), [...DEFAULT_CONTRACT_PATHS]);
  assert.deepEqual(
    effectiveNonProductPrefixesOf(cfgUnset.review.non_product_prefixes),
    [...DEFAULT_NON_PRODUCT_PREFIXES],
  );
  const specDefault = (key: string) => REVIEW_LIST_FIELDS.find((s) => s.key === key)!.defaultValues;
  assert.equal(specDefault("regions"), DEFAULT_REVIEW_REGIONS, "缺省区域必须是同一个常量本体（不得另抄）");
  assert.equal(specDefault("contract_paths"), DEFAULT_CONTRACT_PATHS, "缺省契约路径必须是同一个常量本体");
  assert.equal(specDefault("non_product_prefixes"), DEFAULT_NON_PRODUCT_PREFIXES, "缺省排除前缀必须是同一个常量本体");

  // 2. 未配置下，变更 scripts/build.sh（属于 DEFAULT_REVIEW_REGIONS）可以快速放行。
  //    g-437：改用真 Git 夹具——门禁③由引擎在 attempt 实际工作树上自算，报告须与真源一致。
  const unset = makeFastTrackFixture({ type: "patch", changed: [{ path: "scripts/build.sh", lines: 12 }] });
  try {
    const r1 = resolveAccept(unset.root, unset.goal, {
      actor: "supervisor:test",
      verdict: "accept",
      fast_track: true,
      machine_report: unset.report(),
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.fast_track, true);
  } finally {
    unset.dispose();
  }

  // 3. 写入自定义配置：立即被 resolveAccept 消费，无需任何重启
  const narrowed = makeFastTrackFixture({
    type: "patch",
    changed: [{ path: "scripts/build.sh", lines: 12 }],
    projectConfig: { review: { regions: ["src", "pkg"] } }, // 不含 scripts
  });
  try {
    // scripts/build.sh 现在变为未登记区域，必须拒绝快速放行（升级为 strict）
    assert.deepEqual(effectiveReviewRegionsOf(readProjectConfig(narrowed.root).review.regions), ["src", "pkg"]);
    assert.throws(
      () =>
        resolveAccept(narrowed.root, narrowed.goal, {
          actor: "supervisor:test",
          verdict: "accept",
          fast_track: true,
          machine_report: narrowed.report(),
        }),
      /fast_track 被拒/,
    );
  } finally {
    narrowed.dispose();
  }

  // 4. 未配置 ≠ 显式空列表：以 DEFAULT_NON_PRODUCT_PREFIXES 里的 `dist/` 变更区分
  //    （两项都走真 Git 真源：未配置 ⇒ dist/ 不计产品码；显式 [] ⇒ dist/ 计入产品码）
  const distDefault = makeFastTrackFixture({ type: "patch", changed: [{ path: "dist/bundle.js", lines: 200 }] });
  try {
    assert.equal(distDefault.productLines, 0, "未配置 ⇒ 默认前缀 dist 生效，产品码 0 行");
    const okDefault = resolveAccept(distDefault.root, distDefault.goal, {
      actor: "supervisor:test",
      verdict: "accept",
      fast_track: true,
      machine_report: distDefault.report(),
    });
    assert.equal(okDefault.fast_track, true);
  } finally {
    distDefault.dispose();
  }

  const distExplicitEmpty = makeFastTrackFixture({
    type: "patch",
    changed: [{ path: "dist/bundle.js", lines: 200 }],
    projectConfig: { review: { non_product_prefixes: [] } },
    nonProductPrefixes: [],
  });
  try {
    assert.deepEqual(effectiveNonProductPrefixesOf(readProjectConfig(distExplicitEmpty.root).review.non_product_prefixes), []);
    assert.equal(distExplicitEmpty.productLines, 200, "显式空列表 ⇒ 默认前缀不生效，dist/ 计入产品码");
    assert.throws(
      () =>
        resolveAccept(distExplicitEmpty.root, distExplicitEmpty.goal, {
          actor: "supervisor:test",
          verdict: "accept",
          fast_track: true,
          machine_report: distExplicitEmpty.report(),
        }),
      /M2 产品代码变更/,
      "显式空列表必须真的改变口径（不得回退默认）",
    );
  } finally {
    distExplicitEmpty.dispose();
  }
});

// ---------------------------------------------------------------------------
// 判据 3：外部布局 contract_paths 命中 M1，另以 ≥3 区域夹具验证 M3；单区域不误称 M3 命中
// ---------------------------------------------------------------------------
test("g-435 判据 3：外部契约命中 M1，独立 ≥3 区域命中 M3，单区域不误报 M3", () => {
  // 外部项目配置：契约 api/v1/openapi.yaml，区域 models, controllers, services
  const extConfig = {
    contractPaths: ["api/v1/openapi.yaml"],
    regions: ["models", "controllers", "services"],
  };

  // M1 命中：变更外部契约
  const m1Decision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["api/v1/openapi.yaml"],
    ...extConfig,
  });
  assert.equal(m1Decision.policy, "strict");
  assert.deepEqual(m1Decision.strictReasons, ["contract_change"]);
  assert.match(m1Decision.reasons[0], /api\/v1\/openapi\.yaml/);

  // 单区域：只有 models/user.go，不应命中 M3
  const singleRegionDecision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["models/user.go"],
    ...extConfig,
  });
  assert.equal(singleRegionDecision.policy, "auto");
  assert.equal(singleRegionDecision.strictReasons.includes("cross_region"), false);

  // 跨 ≥3 区域：models, controllers, services
  const m3Decision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["models/user.go", "controllers/user.go", "services/user.go"],
    ...extConfig,
  });
  assert.equal(m3Decision.policy, "strict");
  assert.deepEqual(m3Decision.strictReasons, ["cross_region"]);
});

// ---------------------------------------------------------------------------
// 判据 4：普适默认不含 core/dsh-graph-host；默认 core/ops.ts 精确 unknown_region strict，auto/none 均升级
// ---------------------------------------------------------------------------
test("g-435 判据 4：默认不含 core/dsh-graph-host；默认下 core/ops.ts 精确 unknown_region strict", () => {
  assert.equal(DEFAULT_REVIEW_REGIONS.includes("core" as any), false);
  assert.equal(DEFAULT_REVIEW_REGIONS.includes("dsh-graph-host" as any), false);

  // 在默认配置下，core/ops.ts 是产品代码且落在未登记区域，auto 与 none 均安全升级
  for (const pol of ["auto", "none"] as const) {
    const d = resolveReviewPolicy({
      policy: pol,
      type: "patch",
      changedPaths: ["core/ops.ts"],
    });
    assert.equal(d.policy, "strict", `policy=${pol} 时未登记区域代码必须升级 strict`);
    assert.ok(d.strictReasons.includes("unknown_region"));
    assert.equal(d.strictReasons[d.strictReasons.length - 1], "unknown_region", "unknown_region 追加在末尾");
  }
});

// ---------------------------------------------------------------------------
// 判据 5：regions[] fail-closed；contract_paths[] 与 non_product_prefixes[] 合法且语义明确；手改非法配置不崩溃
// ---------------------------------------------------------------------------
test("g-435 判据 5：regions[] fail-closed；contract_paths[] 与 non_product_prefixes[] 合法；手改非法配置安全处理", () => {
  // 1. regions: [] 显式空列表 → fail-closed strict
  const emptyRegionsDecision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    regions: [],
    changedPaths: ["src/index.ts"],
  });
  assert.equal(emptyRegionsDecision.policy, "strict");

  // 2. contract_paths: [] 合法且 M1 不触发
  const emptyContractDecision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    contractPaths: [],
    changedPaths: ["core/schema.ts"], // 即使改了本仓库 schema，在未登记契约的项目中也不触发 M1
    regions: ["core"], // 假设登记了 core
  });
  assert.equal(emptyContractDecision.policy, "auto");
  assert.equal(emptyContractDecision.strictReasons.includes("contract_change"), false);

  // 3. non_product_prefixes: [] 合法（不排除前缀，除 .md 与通用 lockfile 外其余都算产品代码）
  const emptyPrefixDecision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    nonProductPrefixes: [],
    changedPaths: ["dist/bundle.js"], // 在默认下被排除，在 [] 下被当成产品代码
    regions: ["src"], // 未登记 dist → unknown_region
  });
  assert.equal(emptyPrefixDecision.policy, "strict");
  assert.ok(emptyPrefixDecision.strictReasons.includes("unknown_region"));

  // 4. 手工编辑 project.yaml 写入非法格式，读侧安全降级，不使 graph 工具崩溃
  const { root } = fixture();
  writeFileSync(
    join(root, "project.yaml"),
    `review:\n  regions: "not-a-list"\n  contract_paths: 12345\n`,
    "utf8",
  );
  // 读取必须不抛异常
  const cfg = readProjectConfig(root);
  assert.ok(cfg !== null);
  // resolveReviewPolicy 传入畸形数据不崩溃，且安全升级为 strict
  const safeDecision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    regions: "not-an-array" as any,
    contractPaths: {} as any,
  });
  assert.ok(safeDecision !== null);
  assert.equal(safeDecision.policy, "strict");
  assert.ok(safeDecision.strictReasons.includes("policy_unrecognized"));

  // 5. 重复项、尾随斜杠等非法配置安全升级 strict
  const dupDecision = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    regions: ["src", "src"],
  });
  assert.equal(dupDecision.policy, "strict");
  assert.ok(dupDecision.strictReasons.includes("policy_unrecognized"));

  // 6. regions: null # inherit 读为 null，不被误读为 []
  writeFileSync(
    join(root, "project.yaml"),
    `review:\n  policy: auto\n  regions: null # inherit\n`,
    "utf8",
  );
  const cfgNull = readProjectConfig(root);
  assert.equal(cfgNull.review.regions, null, "null 带注释必须被读为 null 而非 []");

  // 7. 手写数字标量与混合元素 [src, 123]、[src, null] 读取后策略安全升级 strict
  for (const field of ["regions", "contract_paths", "non_product_prefixes"] as const) {
    writeFileSync(
      join(root, "project.yaml"),
      `review:\n  policy: auto\n  regions: ${field === "regions" ? "123" : "[src]"}\n  ${field === "regions" ? "contract_paths: []" : field + ": 123"}\n`,
      "utf8",
    );
    const d = resolveReviewPolicy({
      policy: "auto",
      type: "patch",
      regions: readProjectConfig(root).review.regions,
      contractPaths: readProjectConfig(root).review.contract_paths,
      nonProductPrefixes: readProjectConfig(root).review.non_product_prefixes,
      changedPaths: ["src/a.ts"],
    });
    assert.equal(d.policy, "strict", `${field}: 123 必须升级 strict`);
    assert.ok(d.strictReasons.includes("policy_unrecognized"));
  }

  for (const mixed of ["[src, 123]", "[src, null]"]) {
    writeFileSync(
      join(root, "project.yaml"),
      `review:\n  policy: auto\n  regions: ${mixed}\n`,
      "utf8",
    );
    const d = resolveReviewPolicy({
      policy: "auto",
      type: "patch",
      regions: readProjectConfig(root).review.regions,
      changedPaths: ["src/a.ts"],
    });
    assert.equal(d.policy, "strict", `regions: ${mixed} 必须升级 strict`);
    assert.ok(d.strictReasons.includes("policy_unrecognized"));
  }
});

// ---------------------------------------------------------------------------
// 判据 6：段边界、最长前缀、顺序与规范化断言；旧嵌套区域行为与有意变化明示
// ---------------------------------------------------------------------------
test("g-435 判据 6：段边界、最长前缀、顺序与路径规范化；旧嵌套区域行为实测", () => {
  // 规范化：去前导 ./、反斜杠转 /、trim
  assert.equal(isContractPath(".\\api\\spec.json", ["api/spec.json"]), true);
  assert.equal(matchRegionSegment("src-extra/file.ts", "src"), false, "段边界：src-extra 不匹配 src");
  assert.equal(matchRegionSegment("src/file.ts", "src"), true, "段边界：src/file.ts 匹配 src");

  // 最长前缀优先：dsh-graph-host 与 dsh-graph-host/lib/client
  const customRegions = ["dsh-graph-host", "dsh-graph-host/lib/client", "scripts"];
  const reg = regionOfPath("dsh-graph-host/lib/client/board.js", customRegions);
  assert.equal(reg, "dsh-graph-host/lib/client", "最长前缀优先");

  // 同长度按配置顺序：假设有两个相同长度的前缀
  const sameLenRegions = ["app/v1", "app/v2"];
  assert.equal(regionOfPath("app/v1/sub.ts", sameLenRegions), "app/v1");

  // 旧嵌套别名实测说明：如果只登记 "lib/client"，根前缀匹配不会匹配 "dsh-graph-host/lib/client/board.js"
  assert.equal(regionOfPath("dsh-graph-host/lib/client/board.js", ["lib/client"]), null);
});

// ---------------------------------------------------------------------------
// 判据 7：本项目显式校准与旧样本对拍
// ---------------------------------------------------------------------------
test("g-435 判据 7：旧样本对拍（在显式配置夹具下保持 policy/strictReasons 判定等价）", () => {
  const repoExplicit = {
    contractPaths: ["core/schema.ts", "schema/SCHEMA.md"],
    regions: ["core", "dsh-graph-host", "dsh-graph-host/lib/client", "dsh-graph-host/prompts", "scripts"],
    nonProductPrefixes: ["core/tests", "dist", "core-dist", "node_modules", ".worktrees"],
  };

  // 1. 旧契约命中
  const d1 = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["core/schema.ts"],
    ...repoExplicit,
  });
  assert.equal(d1.policy, "strict");
  assert.deepEqual(d1.strictReasons, ["contract_change"]);

  // 2. 旧跨区域 M3 命中
  const d2 = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["core/ops.ts", "dsh-graph-host/index.js", "scripts/build.sh"],
    ...repoExplicit,
  });
  assert.equal(d2.policy, "strict");
  assert.deepEqual(d2.strictReasons, ["cross_region"]);
});

// ---------------------------------------------------------------------------
// 判据 8：文档 / 生成物中性；changedPaths 缺失与 [] 中性；真实未登记产品代码升级
// ---------------------------------------------------------------------------
test("g-435 判据 8：纯文档与生成物中性；changedPaths 缺失/[] 中性；产品码升级；段边界不误排除相邻前缀", () => {
  // 1. changedPaths 为 undefined 或 null 时中性（不触发 unknown_region）
  const dUnset = resolveReviewPolicy({ policy: "auto", type: "patch" });
  assert.equal(dUnset.policy, "auto");
  assert.equal(dUnset.strictReasons.includes("unknown_region"), false);

  // 2. changedPaths 为 [] 时中性
  const dEmpty = resolveReviewPolicy({ policy: "auto", type: "patch", changedPaths: [] });
  assert.equal(dEmpty.policy, "auto");
  assert.equal(dEmpty.strictReasons.includes("unknown_region"), false);

  // 3. 只有 .md 文档或生成物（在未登记区域）时中性
  const dDocs = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["unregistered/doc.md", "dist/app.js"],
  });
  assert.equal(dDocs.policy, "auto");
  assert.equal(dDocs.strictReasons.includes("unknown_region"), false);

  // 4. 真实未登记产品代码升级
  const dProd = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["unregistered/feature.ts"],
  });
  assert.equal(dProd.policy, "strict");
  assert.ok(dProd.strictReasons.includes("unknown_region"));

  // 5. 段边界专项：non_product_prefixes: ["dist"] 不得误排除 distillery/a.ts
  const distCustom = {
    nonProductPrefixes: ["dist"],
    regions: ["src"],
  };
  assert.equal(isProductCodePath("dist/bundle.js", ["dist"]), false, "dist/bundle.js 应该被排除");
  assert.equal(isProductCodePath("dist", ["dist"]), false, "dist 自身应该被排除");
  assert.equal(isProductCodePath("distillery/a.ts", ["dist"]), true, "distillery/a.ts 绝不应被排除");

  // distillery/a.ts 计入 200 行产品代码且未登记区域 → 触发 product_size 与 unknown_region
  const dDistillery = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["distillery/a.ts"],
    productChangedLines: 200,
    ...distCustom,
  });
  assert.equal(dDistillery.policy, "strict");
  assert.ok(dDistillery.strictReasons.includes("product_size"));
  assert.ok(dDistillery.strictReasons.includes("unknown_region"));
});

// ---------------------------------------------------------------------------
// F1（第三轮独立复核必修）：不可解析 YAML / 字段存在但不可判定 ⇒ fail-closed
//
// 不变量（写进断言）：**「字段不存在 ⇒ 合法未配置」与「字段存在但不可解析/无法判定 ⇒ 畸形」严格区分**；
// 后者一律 fail-closed（产出确定 malformed 信号并安全升级 strict），整档不可解析时 policy 标量也不放行。
// 本轮补的是**不可解析**形态 + **真实入口**（tool/HTTP GET + 真实 resolveAccept(fast_track)）；
// 此前判据 5 只用可解析畸形值且只断言「不崩」，故 2088 全绿也检不出 F1。
// ---------------------------------------------------------------------------
test("g-435 F1：不可解析 YAML 经真实 tool/HTTP 标为畸形，真实 resolveAccept(fast_track) 必拒；闭合对照仍 strict", async () => {
  const unparsable: Array<[string, string, string[]]> = [
    ["未闭合 flow list（契约冻结绕过向量）", "review:\n  policy: auto\n  regions: [src, dsh-graph-host]\n  contract_paths: [core/schema.ts\n", ["core/schema.ts"]],
    ["Tab 缩进（显式 strict 被丢弃向量）", "review:\n\tpolicy: strict\n", ["src/a.ts"]],
    ["未闭合 flow list 含非法项", "review:\n  policy: auto\n  regions: [src, 123\n", ["src/a.ts"]],
  ];
  for (const [label, text, paths] of unparsable) {
    const { root, goal } = fixture();
    const { callTool, routes } = hostHarness(root);
    writeFileSync(join(root, "project.yaml"), text, "utf8");

    // 真实 tool 入口：必须产出确定 malformed 信号，且绝不暴露内部哨兵
    const toolGet: any = await callTool("graph_get_settings");
    assert.equal(toolGet.config.review.config_malformed, true, `${label}：读侧必须产出确定 malformed 信号`);
    assert.ok(toolGet.config.review.invalid_fields, `${label}：读侧必须带 invalid_fields`);
    assert.equal(JSON.stringify(toolGet.config).includes("invalid:"), false, `${label}：响应不得含内部哨兵`);

    // 真实 HTTP GET：不崩溃、不掉哨兵
    const httpGet = await request(routes, "GET");
    assert.equal(httpGet.code, 200, `${label}：GET 不得崩溃`);
    assert.equal(JSON.stringify(httpGet.body).includes("invalid:"), false, `${label}：HTTP 响应不得含内部哨兵`);

    // 真实 resolveAccept(fast_track)：必拒（M1 契约冻结/显式 strict 不得被绕过）
    expectFastTrackRejected(root, goal, paths, label);
  }

  // 闭合对照：同内容闭合后为「确定 strict」（畸形信号来自非法元素），真实 fast_track 同样被拒
  const closed = fixture();
  const closedHost = hostHarness(closed.root);
  writeFileSync(join(closed.root, "project.yaml"), "review:\n  policy: auto\n  regions: [src, 123]\n", "utf8");
  const closedRead: any = await closedHost.callTool("graph_get_settings");
  assert.equal(closedRead.config.review.config_malformed, true, "闭合 [src,123] 必须被判畸形");
  expectFastTrackRejected(closed.root, closed.goal, ["src/a.ts"], "闭合 [src,123]");

  // 合法显式 strict：不得误判为畸形（无假阳性），仍拒放行
  const ok = fixture();
  const okHost = hostHarness(ok.root);
  writeFileSync(join(ok.root, "project.yaml"), "review:\n  policy: strict\n  regions:\n    - scripts\n", "utf8");
  const okRead: any = await okHost.callTool("graph_get_settings");
  assert.equal(okRead.config.review.config_malformed, undefined, "合法配置不得被判畸形");
  assert.equal(okRead.config.review.policy, "strict");
  expectFastTrackRejected(ok.root, ok.goal, ["scripts/build.sh"], "显式 strict");

  // 空档 / 纯注释档 = 合法未配置，不得假阳性
  const commentOnly = fixture();
  const coHost = hostHarness(commentOnly.root);
  writeFileSync(join(commentOnly.root, "project.yaml"), "# only a comment\n", "utf8");
  const coRead: any = await coHost.callTool("graph_get_settings");
  assert.equal(coRead.config.review.config_malformed, undefined, "纯注释档不得被判畸形");
  assert.equal(coRead.config.review.regions, null);
  assert.equal(coRead.config.review.policy, null);
});

// ---------------------------------------------------------------------------
// F2（第三轮独立复核必修）：内部哨兵 invalid:* 不得经公共读侧暴露，写侧拒收，读取→保存不可物化
// ---------------------------------------------------------------------------
test("g-435 F2：读侧不暴露内部哨兵 invalid:*；写侧拒收；读取→保存不可能物化哨兵", async () => {
  const { root } = fixture();
  const { callTool, routes } = hostHarness(root);
  const malformed = "review:\n  policy: auto\n  regions: [src]\n  contract_paths: 123\n";
  writeFileSync(join(root, "project.yaml"), malformed, "utf8");

  const toolGet: any = await callTool("graph_get_settings");
  const review = toolGet.config.review;
  assert.equal(JSON.stringify(toolGet.config).includes("invalid:"), false, "tool 响应不得含内部哨兵");
  assert.equal(review.config_malformed, true, "字段存在但不可判定 ⇒ malformed 信号");
  assert.match(String(review.invalid_fields.contract_paths), /contract_paths/);
  assert.match(String(review.invalid_fields.contract_paths), /project\.yaml/, "报错语义必须指向 project.yaml");
  assert.equal(
    Array.isArray(review.contract_paths) && review.contract_paths.some((v: unknown) => String(v).startsWith("invalid:")),
    false,
    "读侧不得把内部哨兵当普通条目暴露",
  );

  const httpGet = await request(routes, "GET");
  assert.equal(httpGet.code, 200);
  assert.equal(JSON.stringify(httpGet.body).includes("invalid:"), false, "HTTP 响应不得含内部哨兵");

  // 读取 → 原样回写：必须被写侧拒绝且零副作用（哨兵/原始畸形值绝不物化落盘）
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const eventsBefore = readEvents(root).length;
  const echoed = JSON.parse(JSON.stringify(review));
  const echoPost = await request(routes, "POST", { review: echoed });
  assert.equal(echoPost.code, 400, "原样回写必须被写侧拒绝");
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, "拒绝后文件逐字节不变");
  assert.equal(readEvents(root).length, eventsBefore, "拒绝后零事件");

  // 显式写入 invalid: 前缀同样拒收且零副作用
  const explicitPost = await request(routes, "POST", { review: { contract_paths: ["invalid:123"] } });
  assert.equal(explicitPost.code, 400, "写侧必须拒收 invalid: 前缀");
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before);
  assert.equal(/invalid:/.test(readFileSync(join(root, "project.yaml"), "utf8")), false, "磁盘绝不出现字面 invalid:");

  // 不含 review 段的合法 patch 在畸形文件上仍成功（校验先于一切持久化副作用）
  const unrelated = await request(routes, "POST", { executor: { provider: "p", model: "m" } });
  assert.equal(unrelated.code, 200, "不含 review 段的合法 patch 必须成功");
  const after = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(after, /provider: p/);
  assert.match(after, /contract_paths: 123/, "畸形行原样保留，不得被静默改写");
  assert.equal(/invalid:/.test(after), false);

  // 多字段畸形 GET 不抛出且全无哨兵
  writeFileSync(
    join(root, "project.yaml"),
    "review:\n  policy: auto\n  regions: 123\n  contract_paths: [src, null]\n  non_product_prefixes: 5\n",
    "utf8",
  );
  const multi = await request(routes, "GET");
  assert.equal(multi.code, 200, "多字段畸形 GET 不得崩溃");
  assert.equal(JSON.stringify(multi.body).includes("invalid:"), false);
});

// ---------------------------------------------------------------------------
// F3（第三轮独立复核必修）：schema_hints 广告的默认值与写侧口径一致（无尾随斜杠）且可原样写回
// ---------------------------------------------------------------------------
test("g-435 F3：schema_hints 广告的 review 默认值无尾随斜杠且可原样写回", async () => {
  const { root } = fixture();
  const { callTool, routes } = hostHarness(root);
  writeFileSync(join(root, "project.yaml"), "review:\n  policy: auto\n", "utf8");

  const hints: any = (await callTool("graph_get_settings")).schema_hints["review.defaults"];
  for (const p of hints.non_product_prefixes) {
    assert.equal(String(p).endsWith("/"), false, `广告默认前缀不得带尾随斜杠: ${p}`);
  }
  assert.deepEqual(hints.non_product_prefixes, [...DEFAULT_NON_PRODUCT_PREFIXES], "广告值必须与默认常量同源");

  const post = await request(routes, "POST", { review: { non_product_prefixes: hints.non_product_prefixes } });
  assert.equal(post.code, 200, `广告默认值必须可写（写侧口径一致）: ${JSON.stringify(post.body)}`);
});

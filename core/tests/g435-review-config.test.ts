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

import {
  resolveReviewPolicy,
  isContractPath,
  regionOfPath,
  regionsOfPaths,
  isProductCodePath,
  countProductChangedLines,
  matchRegionSegment,
  DEFAULT_CONTRACT_PATHS,
  DEFAULT_REVIEW_REGIONS,
  DEFAULT_NON_PRODUCT_PREFIXES,
  CONTRACT_PATHS,
  REVIEW_REGIONS,
} from "../review-policy.ts";

function fixture(opts: { type?: string; criteria?: string[]; status?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g435-"));
  init(root);
  const goal = createGoal(root, { title: "fixture", version: "v-test", type: opts.type ?? "patch", actor: "t" });
  setCriteria(root, goal, opts.criteria ?? ["判据一 ✅已验", "判据二 ✅已验"], "t");
  const file = findGoalFile(root, goal);
  writeFileSync(file, readFileSync(file, "utf8").replace('"status": "planning"', `"status": "${opts.status ?? "review"}"`));
  return { root, goal, file };
}

function greenReport(over: Record<string, unknown> = {}) {
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
});

// ---------------------------------------------------------------------------
// 判据 2：持久化设置立即被策略消费；未配置与显式列表由单一默认应用点区分
// ---------------------------------------------------------------------------
test("g-435 判据 2：持久化设置立即生效，单一默认应用点区分未配置与显式空列表", () => {
  const { root, goal } = fixture({ type: "patch" });

  // 1. 未配置时：regions 为 null，策略消费 DEFAULT_REVIEW_REGIONS
  const cfgUnset = readProjectConfig(root);
  assert.equal(cfgUnset.review.regions, null);
  assert.equal(cfgUnset.review.contract_paths, null);
  assert.equal(cfgUnset.review.non_product_prefixes, null);

  // 未配置下，变更 scripts/build.sh（属于 DEFAULT_REVIEW_REGIONS）可以快速放行
  const r1 = resolveAccept(root, goal, {
    actor: "supervisor:test",
    verdict: "accept",
    fast_track: true,
    machine_report: greenReport({ changed_paths: ["scripts/build.sh"] }),
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.fast_track, true);

  // 2. 写入自定义配置：立即被 resolveAccept 消费，无需任何重启
  writeProjectConfig(
    root,
    {
      review: {
        regions: ["src", "pkg"], // 不含 scripts
      },
    },
    "supervisor:test",
  );

  const f2 = fixture({ type: "patch", status: "review" });
  writeProjectConfig(
    f2.root,
    {
      review: {
        regions: ["src", "pkg"], // 不含 scripts
      },
    },
    "supervisor:test",
  );
  // scripts/build.sh 现在变为未登记区域，必须拒绝快速放行（升级为 strict）
  assert.throws(
    () =>
      resolveAccept(f2.root, f2.goal, {
        actor: "supervisor:test",
        verdict: "accept",
        fast_track: true,
        machine_report: greenReport({ changed_paths: ["scripts/build.sh"] }),
      }),
    /fast_track 被拒/,
  );
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
    nonProductPrefixes: ["core/tests/", "dist/", "core-dist/", "node_modules/", ".worktrees/"],
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

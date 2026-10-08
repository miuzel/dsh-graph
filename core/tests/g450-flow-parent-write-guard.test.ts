/**
 * g-450 判据验证套件：写入路径对「父级不是块式映射」的形态 fail-closed（400 + 零副作用）。
 *
 * 判据 1：内联 flow-style 映射父级（`review: { policy: auto, regions: [src] }`）上的标量写入
 *         ⇒ 4xx + 文件逐字节不变 + 事件零副作用；严禁「返回 200 却产出/追加非法 YAML」。
 * 判据 2：父级为标量（`review: 5`）/ 父级为序列（`review:\n  - a`）两同族形态一并收口（含中间层级）。
 * 判据 3：列表变体（g-435 已修）与标量变体都有具备判别力的用例（撤销修复 ⇒ 本文件必红）。
 * 判据 4：合法块式映射下的标量/列表写入零回归，且写后文件可被通用 YAML 解析器解析（往返验证）；
 *         `policy: AUTO` 读写不对称按最小改动保留并在此记录裁决。
 *
 * 负向对照（实测记录）：临时移除 core/ops.ts 的 `assertBlockMappingParent` 调用后，
 * 本文件「判据 1/2」用例必红（HTTP 200 + 文件被追加出不可解析 YAML），恢复后全绿。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import { init, readProjectConfig, writeProjectConfig, GraphError } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

// ---------------------------------------------------------------------------
// 真实 host 接线：tool + REST /api/dsh-graph/settings（GET/POST），与 g435/g311 同款夹具。
// 读 dist/（运行前需 `bash scripts/build.sh`）。
// ---------------------------------------------------------------------------
function hostHarness(root: string) {
  const registered: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer
      : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  return routes;
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

/** 夹具：graph root + 预置 project.yaml 文本（未配置时 init 会写默认档，这里总是覆盖）。 */
function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g450-"));
  init(root);
  const file = join(root, "project.yaml");
  writeFileSync(file, text, "utf8");
  return { root, file };
}

/** 写被拒的三项不变式：文件逐字节不变、事件零增长、写后文件仍可被通用 YAML 解析器解析。 */
function assertRejectedClean(root: string, file: string, before: string, eventsBefore: number, label: string) {
  const after = readFileSync(file, "utf8");
  assert.equal(after, before, `${label}：写入被拒后文件必须逐字节不变`);
  assert.equal(readEvents(root).length, eventsBefore, `${label}：写入被拒后事件必须零副作用`);
  assert.doesNotThrow(() => parseYaml(after), `${label}：文件绝不能被写坏`);
}

// ---------------------------------------------------------------------------
// 判据 1 + 判据 3：内联 flow-style 映射父级 —— 标量与列表两变体都必须 4xx + 零副作用
// ---------------------------------------------------------------------------
test("g-450 判据 1/3：flow 映射父级上的标量与列表写入均 fail-closed（4xx + 零副作用）", async () => {
  const flow = `review: { policy: auto, regions: [src] }\n`;
  const variants: Array<[string, Record<string, unknown>]> = [
    ["标量变体", { review: { policy: "strict" } }],
    ["列表变体", { review: { regions: ["lib"] } }],
  ];
  for (const [label, payload] of variants) {
    const { root, file } = fixture(flow);
    const routes = hostHarness(root);
    const eventsBefore = readEvents(root).length;
    assert.equal(parseYaml(flow).review.policy, "auto", `${label}：前置夹具必须可解析`);

    // ops 直入：拒绝且抛 GraphError（HTTP 入口据此映射 400）
    assert.throws(
      () => writeProjectConfig(root, payload, "supervisor:test"),
      (err: any) => err instanceof GraphError && err.message.includes("父级"),
      `${label}：写路径必须 fail-closed 并给出父级原因`,
    );
    assertRejectedClean(root, file, flow, eventsBefore, label);

    // 真实 HTTP 入口：4xx（400 语义）
    const r = await request(routes, "POST", payload);
    assert.equal(r.code, 400, `${label}：HTTP 必须 400（实测修复前为 200）`);
    assertRejectedClean(root, file, flow, eventsBefore, label);
    // 严禁「返回成功码却产出/追加不可解析 YAML」：原值必须原样可读
    assert.equal(parseYaml(readFileSync(file, "utf8")).review.policy, "auto", `${label}：原配置值不得被部分改写`);
  }
});

// ---------------------------------------------------------------------------
// 判据 2：父级为标量 / 父级为序列（含中间层级）一并收口
// ---------------------------------------------------------------------------
test("g-450 判据 2：父级为标量或序列时写入 fail-closed（4xx + 零副作用）", async () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["标量父级 + 列表写入", `review: 5\n`, { review: { regions: ["src"] } }],
    ["标量父级 + 标量写入", `review: 5\n`, { review: { policy: "strict" } }],
    ["标量中间层级", `defaults: 5\n`, { defaults: { review: { reviewer: "human" } } }],
    ["序列父级 + 标量写入", `review:\n  - a\n`, { review: { policy: "strict" } }],
    ["序列父级 + 列表写入", `review:\n  - a\n`, { review: { regions: ["src"] } }],
    ["内联 flow 序列父级", `review: [src]\n`, { review: { policy: "strict" } }],
    ["内联 flow 序列父级（列表写入）", `review: [src]\n`, { review: { regions: ["src"] } }],
    ["序列中间层级", `defaults:\n  review:\n    - a\n`, { defaults: { review: { reviewer: "human" } } }],
  ];
  for (const [label, text, payload] of cases) {
    const { root, file } = fixture(text);
    const routes = hostHarness(root);
    const eventsBefore = readEvents(root).length;

    assert.throws(
      () => writeProjectConfig(root, payload, "supervisor:test"),
      (err: any) => err instanceof GraphError && err.message.includes("父级"),
      `${label}：必须拒绝写入`,
    );
    assertRejectedClean(root, file, text, eventsBefore, label);

    const r = await request(routes, "POST", payload);
    assert.equal(r.code, 400, `${label}：HTTP 必须 400（b45522cf 实测形态修复前为 200）`);
    assertRejectedClean(root, file, text, eventsBefore, label);
  }
});

// ---------------------------------------------------------------------------
// 判据 4：合法块式映射写入零回归 + 通用 YAML 解析器往返验证
// ---------------------------------------------------------------------------
test("g-450 判据 4：块式映射下的标量/列表/新建块写入仍成功且往返可解析", async () => {
  const block = [
    "executor:",
    "  provider: old-p",
    "  model: old-m",
    "defaults:",
    "  pk:",
    "    lanes: 1",
    "review: # keep-header",
    "  policy: auto",
    "  regions:",
    "    - src",
    "  unknown_sub: keep-me",
    "top_unknown: keep-too",
    "",
  ].join("\n");
  const { root, file } = fixture(block);
  const routes = hostHarness(root);
  const eventsBefore = readEvents(root).length;

  const payload = {
    executor: { provider: "new-p" },
    defaults: { pk: { lanes: 3 } },
    review: { policy: "strict", regions: ["src", "lib"], contract_paths: ["core/ops.ts"] },
  };
  const r = await request(routes, "POST", payload);
  assert.equal(r.code, 200, `合法块式写入必须成功：${JSON.stringify(r.body)}`);

  const text = readFileSync(file, "utf8");
  // 往返：通用 YAML 解析器必须能解析，且语义正确、注释与未知键保留
  const parsed: any = parseYaml(text);
  assert.equal(parsed.executor.provider, "new-p");
  assert.equal(parsed.executor.model, "old-m", "未提交的键不得被动");
  assert.equal(parsed.defaults.pk.lanes, 3);
  assert.equal(parsed.review.policy, "strict");
  assert.deepEqual(parsed.review.regions, ["src", "lib"]);
  assert.deepEqual(parsed.review.contract_paths, ["core/ops.ts"]);
  assert.equal(parsed.review.unknown_sub, "keep-me");
  assert.equal(parsed.top_unknown, "keep-too");
  assert.match(text, /keep-header/);
  assert.match(text, /review: # keep-header/);

  // 插件自身的读侧同样不得报畸形
  const cfg = readProjectConfig(root);
  assert.equal(cfg.review.config_malformed, undefined);
  assert.equal(cfg.review.policy, "strict");
  assert.deepEqual(cfg.review.regions, ["src", "lib"]);
  assert.ok(readEvents(root).length > eventsBefore, "成功写入必须记 project.config_set 事件");

  // 整条链缺失的「新建块」路径不得被父级守卫误伤
  const created = fixture("top: keep\n");
  writeProjectConfig(created.root, { defaults: { pk: { lanes: 2 } } }, "supervisor:test");
  const createdText = readFileSync(created.file, "utf8");
  assert.equal((parseYaml(createdText) as any).defaults.pk.lanes, 2);
  assert.doesNotThrow(() => parseYaml(createdText));

  // 头行「值仅为注释」仍是合法块式映射头（即使注释里出现花括号）——不得被误拒
  // （旧 g-435 列表检查用 `includes("{")` 子串嗅探，会误拒此类头行；本目标改为按值解析口径）
  const braceComment = fixture("review: # see {a}\n  policy: auto\n");
  writeProjectConfig(braceComment.root, { review: { policy: "strict" } }, "supervisor:test");
  assert.equal((parseYaml(readFileSync(braceComment.file, "utf8")) as any).review.policy, "strict");
});

// ---------------------------------------------------------------------------
// 判据 4 相邻口径裁决：`policy: AUTO` 读侧归一、写侧拒收 —— 保留不对称（最小改动）
// ---------------------------------------------------------------------------
// 裁决理由：读侧 trim/lowercase 是**对手写 YAML 文件的容错**（文件可能被人手改大小写）；
// 写侧枚举是**公共 API 契约**（settingsPostSchema + validateConfigPatch 的 auto/strict/none）。
// 放宽写侧会扩大 API 接受面却无实际需求，且不对称**不构成绕过或数据损坏**（写 AUTO 会得到
// 明确 400 与合法取值提示，合法 `auto` 本就可写）⇒ 按最小改动**明确不改**，仅以用例钉住口径。
test("g-450 判据 4：policy AUTO 读写不对称按最小改动保留（读归一 / 写拒收、零副作用）", async () => {
  const text = `review:\n  policy: AUTO\n`;
  const { root, file } = fixture(text);
  const routes = hostHarness(root);

  // 读侧：手写大写被归一为显式 auto，且不判畸形
  const cfg = readProjectConfig(root);
  assert.equal(cfg.review.policy, "auto", "读侧必须归一大小写");
  assert.equal(cfg.review.config_malformed, undefined, "大小写差异不得被判畸形");

  // 写侧：AUTO 被拒（400）且零副作用
  const eventsBefore = readEvents(root).length;
  const rejected = await request(routes, "POST", { review: { policy: "AUTO" } });
  assert.equal(rejected.code, 400, "写侧必须拒收非规范枚举值");
  assertRejectedClean(root, file, text, eventsBefore, "policy AUTO");

  // 规范小写可写，写后文件可解析（往返）
  const ok = await request(routes, "POST", { review: { policy: "auto" } });
  assert.equal(ok.code, 200);
  assert.equal((parseYaml(readFileSync(file, "utf8")) as any).review.policy, "auto");
});

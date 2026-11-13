import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { cleanTestEnv } from "./fixtures/nested-runner.ts";
import * as model from "../domain/model.ts";
import * as machine from "../domain/machine.ts";
import * as modelFacade from "../model.ts";
import * as machineFacade from "../machine.ts";

const goodBody = "## 质量判据\n1. behavior is preserved ✅已验\n";
const goodContext = { body: goodBody, criteriaConfirmed: true, reason: "dependency unavailable" };

test("g393: facades expose exactly the domain runtime exports with shared identity", () => {
  for (const [direct, facade] of [[model, modelFacade], [machine, machineFacade]]) {
    assert.deepEqual(Object.keys(facade).sort(), Object.keys(direct).sort());
    for (const key of Object.keys(direct)) assert.strictEqual(facade[key], direct[key], key);
  }
  const error = new machine.GraphConflictError("conflict");
  assert.ok(error instanceof machineFacade.GraphError);
  assert.ok(error instanceof machineFacade.GraphConflictError);
});

test("g393: exhaustive 8 by 8 transition matrix retains all legal and illegal edges", () => {
  const edges: Record<string, string[]> = {
    draft: ["planning", "blocked"],
    planning: ["collecting", "ready", "blocked", "in_progress"],
    collecting: ["ready", "planning", "blocked", "in_progress"],
    ready: ["in_progress", "collecting", "blocked"],
    in_progress: ["review", "blocked", "collecting"],
    review: ["delivered", "in_progress", "blocked"],
    delivered: ["review"],
    blocked: ["planning"],
  };
  assert.deepEqual([...machine.STATUSES], Object.keys(edges));
  for (const from of machine.STATUSES) {
    for (const to of machine.STATUSES) {
      const meta = { status: from, blocked_from: "planning", rules_snapshot: "rules-v1" };
      const before = structuredClone(meta);
      const transition = () => machine.assertTransition(meta, to, goodContext);
      if (edges[from].includes(to)) assert.doesNotThrow(transition, `${from} -> ${to}`);
      else assert.throws(transition, machine.GraphError, `${from} -> ${to}`);
      assert.deepEqual(meta, before, "validation must not mutate metadata");
    }
  }
});

test("g393: invalid states, blocked reasons and blocked_from remain fail-closed", () => {
  for (const invalid of [undefined, null, "", "unknown", 1]) {
    assert.throws(() => machine.assertTransition({ status: invalid }, "planning", goodContext), /当前状态非法/);
    assert.throws(() => machine.assertTransition({ status: "planning" }, invalid as string, goodContext), /目标状态非法/);
  }
  for (const reason of [undefined, "", " \t\n"]) {
    assert.throws(() => machine.assertTransition({ status: "planning" }, "blocked", { ...goodContext, reason, force: true }), /必须提供 reason/);
  }
  assert.doesNotThrow(() => machine.assertTransition({ status: "planning" }, "blocked", { ...goodContext, reason: " valid " }));
  for (const blocked_from of [undefined, "", null]) {
    assert.throws(() => machine.assertTransition({ status: "blocked", blocked_from }, "planning", goodContext), /缺少 blocked_from/);
  }
  for (const back of machine.STATUSES.filter((status) => status !== "blocked")) {
    const meta = { status: "blocked", blocked_from: back, rules_snapshot: "v1" };
    assert.doesNotThrow(() => machine.assertTransition(meta, back, goodContext));
    const wrong = back === "planning" ? "ready" : "planning";
    assert.throws(() => machine.assertTransition(meta, wrong, { ...goodContext, force: true }), /只能解除回原状态/);
  }
  assert.throws(() => machine.assertTransition({ status: "blocked", blocked_from: "unknown" }, "planning", goodContext), /只能解除回原状态/);
});

test("g393: execution gate requires rules, substantive criteria and confirmation; force only bypasses gate", () => {
  for (const from of ["planning", "collecting", "ready", "review", "blocked"]) {
    const base = { status: from, blocked_from: "in_progress", rules_snapshot: "v1" };
    for (const rules_snapshot of [undefined, null, "", false]) {
      assert.throws(() => machine.assertTransition({ ...base, rules_snapshot }, "in_progress", goodContext), /rules_snapshot/);
    }
    for (const body of ["", "## 质量判据\n", "## 质量判据\n<!-- hidden\ncriterion -->\n（待登记）\n（待填写）\n（待登记；进入 in_progress 前必须非空且已确认）\n"]) {
      assert.throws(() => machine.assertTransition(base, "in_progress", { ...goodContext, body }), /质量判据小节必须非空/);
    }
    assert.throws(() => machine.assertTransition(base, "in_progress", { ...goodContext, criteriaConfirmed: false }), /criteria.confirmed/);
    assert.doesNotThrow(() => machine.assertTransition({ ...base, rules_snapshot: undefined }, "in_progress", { body: "", criteriaConfirmed: false, force: true }));
  }
  assert.throws(() => machine.assertTransition({ status: "draft" }, "in_progress", { ...goodContext, force: true }), /非法迁移/);
  assert.throws(() => machine.assertTransition({ status: "ready" }, "ready", { ...goodContext, force: true }), /状态未变化/);
});

test("g393: JSON frontmatter rejects malformed documents and round-trips unknown metadata and exact body", () => {
  const malformed: [string, RegExp][] = [
    ["", /起始分隔符/], ["{}\n---\nbody", /起始分隔符/],
    ["---\n{}", /结束分隔符/], ["---\nstatus: ready\n---\n", /不是合法 JSON/],
    ["---\n{\"status\":}\n---\n", /不是合法 JSON/],
    ...["null", "[]", "1", "true", '"text"'].map((value): [string, RegExp] => [`---\n${value}\n---\n`, /必须是 JSON 对象/]),
  ];
  for (const [input, expected] of malformed) assert.throws(() => model.parseDoc(input), expected);
  const meta = { id: "g-393", future: { nested: [null, false, "中文", { untouched: 42 }] }, unknown_flag: true };
  const body = "\n# Title\r\n\n## 目标描述\n  preserve spaces  \n\n## 质量判据\n<!-- note -->\n1. old\n\n## 最近指令\nkeep @att/sample\n\n## 自定义\n```md\n## not a section\n```\n尾部\n";
  const parsed = model.parseDoc(`---\n${JSON.stringify(meta)}\n---\n${body}`);
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, body);
  assert.deepEqual(model.parseDoc(model.serializeDoc(parsed)), parsed);
  assert.equal(model.serializeDoc(parsed).slice(model.serializeDoc(parsed).indexOf("\n---\n") + 5), body);
  const replaced = model.replaceSection(body, "质量判据", "<!-- note -->\n1. new ✅已验\n");
  assert.equal(replaced, body.replace("1. old", "1. new ✅已验"));
  for (const section of ["目标描述", "最近指令", "自定义"]) assert.equal(model.sectionText(replaced, section), model.sectionText(body, section));
  assert.throws(() => model.replaceSection(body, "missing", "text"), /小节不存在/);
  assert.equal(model.sectionText(body, "missing"), null);
  assert.deepEqual(model.criteriaItems(replaced), ["1. new ✅已验"]);
  assert.equal(model.allCriteriaVerified(replaced), true);
  assert.equal(model.allCriteriaVerified("## 质量判据\n（待登记）"), false);
  assert.equal(model.rebuildCriteriaSection("<!-- keep\ncomment -->\n\n1. old\n", ["new"]), "<!-- keep\ncomment -->\n\n1. new\n");
  assert.equal(model.sectionText("## 目标描述\n```md\n## 质量判据\n1. recovered", "质量判据"), "1. recovered");
});

test("g393: built domain modules load through facades and cover recursive source freshness", async () => {
  for (const name of ["model", "machine"]) {
    const direct = await import(new URL(`../../dist/core/domain/${name}.js`, import.meta.url).href);
    const facade = await import(new URL(`../../dist/core/${name}.js`, import.meta.url).href);
    assert.deepEqual(Object.keys(facade).sort(), Object.keys(direct).sort());
    for (const key of Object.keys(direct)) assert.strictEqual(facade[key], direct[key], key);
  }
  for (const source of domainSources(domainRoot)) {
    const relative = path.relative(domainRoot, source).replace(/\.ts$/, ".js");
    const target = fileURLToPath(new URL(`../../dist/core/domain/${relative.split(path.sep).join("/")}`, import.meta.url));
    assert.ok(statSync(source).mtimeMs <= statSync(target).mtimeMs, `stale domain artifact: ${relative}; run bash scripts/build.sh`);
  }
});

test("g393: isolated fixtures include domain dependencies; omitting the copy really fails module loading", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  for (const name of ["g348-atomic-build", "g353-build-chain-boundaries", "g355-mock-seed-shared-card", "g359-two-rename-fallback"]) {
    const source = readFileSync(path.join(repo, "core/tests", `${name}.test.ts`), "utf8");
    assert.match(source, /cpSync\(join\((?:repoRoot|REPO), "core", "domain"\), join\((?:repo|mirror), "core", "domain"\), \{ recursive: true \}\)/, name);
  }
  const tmp = path.join(repo, "tmp");
  mkdirSync(tmp, { recursive: true });
  const root = mkdtempSync(path.join(tmp, "g393-mirror-"));
  try {
    for (const mode of ["complete", "omitted"]) {
      const core = path.join(root, mode, "core");
      mkdirSync(core, { recursive: true });
      for (const name of ["model.ts", "machine.ts"]) cpSync(path.join(repo, "core", name), path.join(core, name));
      if (mode === "complete") cpSync(domainRoot, path.join(core, "domain"), { recursive: true });
      const env = cleanTestEnv();
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./core/machine.ts"); await import("./core/model.ts");'], { cwd: path.dirname(core), env, encoding: "utf8" });
      if (mode === "complete") assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
        assert.match(result.stderr, /core\/domain\/machine\.ts/);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const domainRoot = fileURLToPath(new URL("../domain/", import.meta.url));
const hostNames = new Set([
  "process", "Buffer", "global", "globalThis", "window", "document", "navigator", "Deno", "Bun",
  "require", "module", "exports", "__dirname", "__filename", "fetch", "XMLHttpRequest", "WebSocket",
  "Worker", "console", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "localStorage",
  "sessionStorage", "eval", "Function",
]);

/** Conservative architectural guard, not a sandbox: domain source has no host identifiers or external edges. */
function domainProblems(filename: string, source: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const checkSpecifier = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteral(node)) {
      problems.push("module specifier must be a string literal");
      return;
    }
    const specifier = node.text;
    const resolved = path.resolve(path.dirname(filename), specifier);
    const relative = path.relative(domainRoot, resolved);
    if (!/^\.\.?\//.test(specifier) || specifier.includes("\\") || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      problems.push(`module escapes domain: ${specifier}`);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportEqualsDeclaration(node)) problems.push("import-equals is forbidden");
    if (ts.isImportDeclaration(node)) checkSpecifier(node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) checkSpecifier(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) checkSpecifier(node.arguments[0]);
    if (ts.isImportTypeNode(node)) {
      checkSpecifier(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    }
    if (ts.isIdentifier(node) && hostNames.has(node.text)) problems.push(`host identifier: ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

function domainSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? domainSources(filename) : entry.isFile() && entry.name.endsWith(".ts") ? [filename] : [];
  });
}

test("g393: every recursively discovered domain TypeScript source is host-independent", () => {
  const files = domainSources(domainRoot);
  assert.ok(files.length >= 2, "domain scan must not pass vacuously");
  for (const filename of files) assert.deepEqual(domainProblems(filename, readFileSync(filename, "utf8")), [], filename);
});

test("g393: AST guard catches in-memory boundary mutations without touching product files", () => {
  const filename = path.join(domainRoot, "nested", "probe.ts");
  const accepted = [
    'import { value } from "../model.ts";', 'export * from "../machine.ts";',
    'export { value } from "./local.ts";', 'const load = () => import("../model.ts");',
    'type T = import("../model.ts").GoalDoc;',
    '// process and import("node:fs") in comments are harmless\nconst text = "Buffer globalThis require";',
  ];
  for (const source of accepted) assert.deepEqual(domainProblems(filename, source), [], source);
  const rejected = [
    'import "node:fs";', 'import type { X } from "typescript";', 'import "../../model.ts";',
    'export * from "node:path";', 'export { x } from "../../host.ts";',
    'const x = import("node:fs");', 'const x = import("../../host.ts");',
    'const x = import(name);', 'const x = import(`../model.ts`);',
    'type T = import("node:fs").Stats;', 'import fs = require("node:fs");',
    'import Alias = Namespace.Value;', 'const fs = require("node:fs");',
    'import "/absolute.ts";', 'export * from "..\\\\host.ts";',
    ...[...hostNames].map((name) => `const value = ${name};`),
  ];
  for (const source of rejected) assert.ok(domainProblems(filename, source).length > 0, source);
});

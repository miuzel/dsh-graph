import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = join(import.meta.dirname, "../../dsh-graph-host");
const i18nSource = readFileSync(join(root, "lib/client/i18n.js"), "utf8");
const modalSource = readFileSync(join(root, "lib/client/goal-modal.js"), "utf8");
const bundleSource = readFileSync(join(root, "lib/client.js"), "utf8");

function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en; this.createTranslator = createTranslator;", sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

function loadAttemptWorktreesComponent() {
  const h = (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children });
  const sandbox: any = {
    React: {
      createElement: h,
      useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
      useRef: (init: any) => ({ current: init }),
      useCallback: (fn: any) => fn,
      useEffect: () => {},
    },
    h,
    S: { btn: {}, btnPrimary: {}, meta: {}, modalSection: {}, modalH: {}, subCard: {} },
    copyText: async () => true,
    showToast: () => {},
    dgT: (key: string) => key,
  };

  const match = modalSource.match(/function AttemptWorktrees\(props\) \{[\s\S]*?\n    \}/);
  if (!match) throw new Error("AttemptWorktrees function definition not found in goal-modal.js");
  vm.runInNewContext(i18nSource + ";\n" + match[0] + ";\nthis.zh = zh; this.en = en; this.AttemptWorktrees = AttemptWorktrees;", sandbox);
  return sandbox;
}

function extractAllText(node: any): string[] {
  if (!node) return [];
  if (typeof node === "string") return [node];
  let res: string[] = [];
  if (Array.isArray(node)) {
    for (const item of node) {
      res = res.concat(extractAllText(item));
    }
  } else if (Array.isArray(node.children)) {
    for (const child of node.children) {
      res = res.concat(extractAllText(child));
    }
  }
  return res;
}

test("g-276: tab.worktree and worktree.noAttempts entries exist and English has no CJK", () => {
  const { zh, en } = loadClientI18n();

  // Keys exist in zh and en
  assert.equal(zh["tab.worktree"], "🌿 Worktree");
  assert.equal(en["tab.worktree"], "🌿 Worktree");
  assert.equal(zh["worktree.noAttempts"], "暂无 attempt 执行记录与 worktree");
  assert.equal(en["worktree.noAttempts"], "No attempts or worktrees yet");

  // English entries must not contain any CJK characters
  assert.doesNotMatch(en["tab.worktree"], /[\u3400-\u9fff]/);
  assert.doesNotMatch(en["worktree.noAttempts"], /[\u3400-\u9fff]/);
});

test("g-276: AttemptWorktrees has no collapse toggle and renders all attempts directly", () => {
  // Extract AttemptWorktrees function body
  const match = modalSource.match(/function AttemptWorktrees\(props\) \{([\s\S]*?)\n    \}/);
  assert.ok(match, "AttemptWorktrees function found");
  const fnBody = match[1];

  // No collapse state or toggle button
  assert.doesNotMatch(fnBody, /useState\(/, "AttemptWorktrees should have no local state");
  assert.doesNotMatch(fnBody, /expanded/, "AttemptWorktrees should not have expanded flag");
  assert.doesNotMatch(fnBody, /"▲"\s*:\s*"▼"/, "AttemptWorktrees should not have collapse chevron toggle");

  const sandbox = loadAttemptWorktreesComponent();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;

  // Multiple attempts render directly
  const vnode = sandbox.AttemptWorktrees({
    attempts: [{ id: "att-001" }, { id: "att-002" }],
    worktrees: {
      status: "ok",
      items: {
        "att-001": { path: ".worktrees/g-276-att-001", status: "正常" },
        "att-002": { path: ".worktrees/g-276-att-002", status: "正常" },
      },
    },
  });

  const texts = extractAllText(vnode);
  assert.ok(texts.some((t) => t.includes("att-001")), "att-001 is rendered");
  assert.ok(texts.some((t) => t.includes("att-002")), "att-002 is rendered");
  assert.ok(texts.some((t) => t.includes(".worktrees/g-276-att-001")), "att-001 path is rendered");
  assert.ok(texts.some((t) => t.includes(".worktrees/g-276-att-002")), "att-002 path is rendered");
});

test("g-276: AttemptWorktrees empty state handling without error", () => {
  const sandbox = loadAttemptWorktreesComponent();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;

  // 1. Empty attempts array
  const vnodeEmpty = sandbox.AttemptWorktrees({ attempts: [], worktrees: { status: "ok", items: {} } });
  const textsEmpty = extractAllText(vnodeEmpty);
  assert.ok(textsEmpty.includes("暂无 attempt 执行记录与 worktree"), "displays empty attempts note");

  // 2. Missing props
  const vnodeNoProps = sandbox.AttemptWorktrees({});
  const textsNoProps = extractAllText(vnodeNoProps);
  assert.ok(textsNoProps.includes("暂无 attempt 执行记录与 worktree"), "handles empty props safely");

  // 3. Unavailable discovery
  const vnodeUnavail = sandbox.AttemptWorktrees({
    attempts: [{ id: "att-001" }],
    worktrees: { status: "unavailable" },
  });
  const textsUnavail = extractAllText(vnodeUnavail);
  assert.ok(textsUnavail.some((t) => t.includes("无法发现 worktree")), "displays unavailable warning");

  // 4. English empty state has no CJK
  sandbox.dgT = (k: string) => sandbox.en[k] ?? k;
  const enVnodeEmpty = sandbox.AttemptWorktrees({ attempts: [] });
  const enTextsEmpty = extractAllText(enVnodeEmpty);
  assert.ok(enTextsEmpty.includes("No attempts or worktrees yet"), "displays English empty text");
  for (const text of enTextsEmpty) {
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, "English output must not contain CJK");
  }
});

test("g-276: modal structure contracts for worktree tab and removal from detail tab", () => {
  // 1. detailTab must not contain AttemptWorktrees
  const detailTabMatch = modalSource.match(/const detailTab = \[([\s\S]*?)\];/);
  assert.ok(detailTabMatch, "detailTab array found");
  assert.doesNotMatch(detailTabMatch[1], /AttemptWorktrees/, "detailTab must not contain AttemptWorktrees");

  // 2. worktreeTab must exist and contain AttemptWorktrees and WorktreeCandidates
  const worktreeTabMatch = modalSource.match(/const worktreeTab = \[([\s\S]*?)\];/);
  assert.ok(worktreeTabMatch, "worktreeTab array found");
  assert.match(worktreeTabMatch[1], /AttemptWorktrees/, "worktreeTab must contain AttemptWorktrees");
  assert.match(worktreeTabMatch[1], /WorktreeCandidates/, "worktreeTab must contain WorktreeCandidates");

  // 3. tab state includes worktree
  assert.match(modalSource, /setTab\("worktree"\)/, "setTab('worktree') onClick handler exists");
  assert.match(modalSource, /dgT\("tab\.worktree"\)/, "dgT('tab.worktree') used for tab label");

  // 4. panel container conditionally renders worktreeTab
  assert.match(modalSource, /tab === "worktree"\s*\?\s*worktreeTab/, "panel renders worktreeTab when tab === 'worktree'");

  // 5. bundle contains rebuilt code
  assert.match(bundleSource, /const worktreeTab = \[/);
  assert.match(bundleSource, /dgT\("tab\.worktree"\)/);
});

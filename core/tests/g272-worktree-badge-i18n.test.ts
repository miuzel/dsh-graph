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
  return { zh: sandbox.zh, en: sandbox.en, createTranslator: sandbox.createTranslator };
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
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      res = res.concat(extractAllText(child));
    }
  }
  return res;
}

test("g-272: client i18n zh/en dictionaries are symmetric and worktree entries exist", () => {
  const { zh, en } = loadClientI18n();
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, "client i18n zh and en must have exact same keys");

  // Chinese entries verbatim check
  assert.equal(zh["worktree.normal"], "正常");
  assert.equal(zh["worktree.statusNormal"], "正常");
  assert.equal(zh["worktree.statusLocked"], "已锁定");
  assert.equal(zh["worktree.alreadyRemoved"], "已移除");

  // English entries check
  assert.equal(en["worktree.normal"], "OK");
  assert.equal(en["worktree.statusNormal"], "OK");
  assert.equal(en["worktree.statusLocked"], "Locked");
  assert.equal(en["worktree.alreadyRemoved"], "Removed");

  // English worktree entries must not contain any CJK characters
  const enWorktreeValues = Object.entries(en)
    .filter(([k]) => k.startsWith("worktree."))
    .map(([, v]) => v);
  for (const val of enWorktreeValues) {
    assert.doesNotMatch(String(val), /[\u3400-\u9fff]/, `English worktree key value "${val}" must have no CJK`);
  }
});

test("g-272: AttemptWorktrees badge parity: en output has no CJK, zh output unchanged", () => {
  const sandbox = loadAttemptWorktreesComponent();

  const mockAttempts = [{ id: "att-001" }];

  // 1. Chinese locale test
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;

  // 1a. Normal status
  const zhVNodeNormal = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: { "att-001": { path: ".worktrees/g-272-att-01", status: "正常" } } },
  });
  const zhTextsNormal = extractAllText(zhVNodeNormal);
  assert.ok(zhTextsNormal.includes(".worktrees/g-272-att-01 ｜ 正常"), "Chinese badge must display '｜ 正常' verbatim");

  // 1b. Locked status
  const zhVNodeLocked = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: { "att-001": { path: ".worktrees/g-272-att-01", status: "已锁定" } } },
  });
  assert.ok(extractAllText(zhVNodeLocked).includes(".worktrees/g-272-att-01 ｜ 已锁定"));

  // 1c. Removed status
  const zhVNodeRemoved = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: { "att-001": { path: ".worktrees/g-272-att-01", status: "已移除" } } },
  });
  assert.ok(extractAllText(zhVNodeRemoved).includes(".worktrees/g-272-att-01 ｜ 已移除"));

  // 2. English locale test
  sandbox.dgT = (k: string) => sandbox.en[k] ?? k;

  // 2a. Normal status (from backend '正常')
  const enVNodeNormal = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: { "att-001": { path: ".worktrees/g-272-att-01", status: "正常" } } },
  });
  const enTextsNormal = extractAllText(enVNodeNormal);
  assert.ok(enTextsNormal.includes(".worktrees/g-272-att-01 ｜ OK"), "English badge must display '｜ OK'");
  for (const text of enTextsNormal) {
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, `English output "${text}" must not contain any CJK characters`);
  }

  // 2b. Normal status (from canonical 'ok')
  const enVNodeOk = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: { "att-001": { path: ".worktrees/g-272-att-01", status: "ok" } } },
  });
  assert.ok(extractAllText(enVNodeOk).includes(".worktrees/g-272-att-01 ｜ OK"));

  // 2c. Locked status (from '已锁定' or 'locked')
  const enVNodeLocked = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: { "att-001": { path: ".worktrees/g-272-att-01", status: "已锁定" } } },
  });
  const enTextsLocked = extractAllText(enVNodeLocked);
  assert.ok(enTextsLocked.includes(".worktrees/g-272-att-01 ｜ Locked"));
  for (const text of enTextsLocked) {
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, `English output "${text}" must not contain any CJK characters`);
  }

  // 2d. Removed status (from '已移除' or 'removed')
  const enVNodeRemoved = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: { "att-001": { path: ".worktrees/g-272-att-01", status: "已移除" } } },
  });
  const enTextsRemoved = extractAllText(enVNodeRemoved);
  assert.ok(enTextsRemoved.includes(".worktrees/g-272-att-01 ｜ Removed"));
  for (const text of enTextsRemoved) {
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, `English output "${text}" must not contain any CJK characters`);
  }

  // 2e. Worktree not created
  const enVNodeNone = sandbox.AttemptWorktrees({
    attempts: mockAttempts,
    worktrees: { status: "ok", items: {} },
  });
  const enTextsNone = extractAllText(enVNodeNone);
  assert.ok(enTextsNone.includes("No worktree created"));
  for (const text of enTextsNone) {
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, `English output "${text}" must not contain any CJK characters`);
  }
});

test("g-272: source contracts for worktree badge and unlocalized string cleanups", () => {
  assert.match(modalSource, /formatWorktreeStatus/);
  assert.match(modalSource, /dgT\("worktree\.statusNormal"\)|dgT\("worktree\.normal"\)/);
  assert.match(modalSource, /dgT\("worktree\.attemptTitle"\)/);
  assert.match(bundleSource, /formatWorktreeStatus/);
  assert.match(bundleSource, /dgT\("worktree\.statusNormal"\)|dgT\("worktree\.normal"\)/);

  // g-272 scan cleanups
  const dragPrompts = readFileSync(join(root, "lib/client/drag-prompts.js"), "utf8");
  assert.match(dragPrompts, /dgT\("memory\.charCount"/);

  const versionDrawer = readFileSync(join(root, "lib/client/version-drawer.js"), "utf8");
  assert.match(versionDrawer, /dgT\("versionDrawer\.displayCount"/);
  assert.match(versionDrawer, /dgT\("versionDrawer\.goalCount"/);

  const sharedPanel = readFileSync(join(root, "lib/client/shared-panel.js"), "utf8");
  assert.match(sharedPanel, /dgT\("shared\.goalRef"\)/);
  assert.match(sharedPanel, /dgT\("shared\.unrefGoalTooltip"/);

  const livePanel = readFileSync(join(root, "lib/client/live-panel.js"), "utf8");
  assert.match(livePanel, /dgT\("live\.modeStandard"\)/);
  assert.match(livePanel, /dgT\("live\.modeMinimal"\)/);

  const settingsModal = readFileSync(join(root, "lib/client/settings-modal.js"), "utf8");
  assert.match(settingsModal, /dgT\("settings\.reasoningEffortAria"\)/);
  assert.match(settingsModal, /dgT\("settings\.effortHint"\)/);

  const kanban = readFileSync(join(root, "lib/client/kanban.js"), "utf8");
  assert.match(kanban, /dgT\("lane\.standalone"\)/);
});

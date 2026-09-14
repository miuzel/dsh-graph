import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import vm from "node:vm";

import { init, createGoal, startAttempt, transition, goalDetail } from "../ops.ts";
import { listWorktrees } from "../worktree.ts";
import { appendEvent, nowIso } from "../events.ts";
import { discoverAttemptWorktrees, _clearWorktreeCache } from "../../dsh-graph-host/index.js";

const rootPkg = join(import.meta.dirname, "../../dsh-graph-host");
const i18nSource = readFileSync(join(rootPkg, "lib/client/i18n.js"), "utf8");
const modalSource = readFileSync(join(rootPkg, "lib/client/goal-modal.js"), "utf8");

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

function createGitFixture() {
  const ws = mkdtempSync(join(tmpdir(), "g279-fixture-"));
  execFileSync("git", ["init", "-q", ws]);
  execFileSync("git", ["-C", ws, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", ws, "config", "user.name", "test"]);
  const graphRoot = join(ws, ".dsh-graph");
  init(graphRoot);
  writeFileSync(join(ws, "README.md"), "# Test fixture\n");
  execFileSync("git", ["-C", ws, "add", "."]);
  execFileSync("git", ["-C", ws, "commit", "-qm", "initial commit"]);
  return { ws, graphRoot };
}

test("g-279 场景 1：HEAD 相对基线已推进时，只读发现正常展示路径/分支/HEAD 与推进提示", () => {
  const { ws, graphRoot } = createGitFixture();
  const goalId = createGoal(graphRoot, { title: "HEAD advanced goal", version: "v0.11.0", actor: "test" });
  const attId = startAttempt(graphRoot, goalId, { executor: "test", actor: "test" });

  const initialHead = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const branchName = `${goalId}-att-01`;
  const wtPath = join(ws, ".worktrees", branchName);

  execFileSync("git", ["-C", ws, "worktree", "add", "-q", "-b", branchName, wtPath]);
  writeFileSync(join(wtPath, "feature.txt"), "advanced content\n");
  execFileSync("git", ["-C", wtPath, "add", "."]);
  execFileSync("git", ["-C", wtPath, "commit", "-qm", "feat: advance head"]);
  const advancedHead = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  assert.notEqual(initialHead, advancedHead);

  _clearWorktreeCache();
  const detail = goalDetail(graphRoot, goalId);
  const discovery = discoverAttemptWorktrees(ws, goalId, detail.attempts, graphRoot);

  assert.equal(discovery.status, "ok");
  const item = discovery.items[attId];
  assert.ok(item, "Attempt worktree must be discovered even when HEAD has advanced");
  assert.equal(item.path, `.worktrees/${branchName}`);
  assert.equal(item.branch, branchName);
  assert.equal(item.head, advancedHead.slice(0, 7));
  assert.equal(item.baseline_head, initialHead.slice(0, 7));
  assert.equal(item.head_advanced, true);
  assert.equal(item.status, "正常");

  // UI 渲染验证 (zh & en)
  const sandbox = loadAttemptWorktreesComponent();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;
  const vnodeZh = sandbox.AttemptWorktrees({ attempts: detail.attempts, worktrees: discovery });
  const textsZh = extractAllText(vnodeZh);
  const expectedLineZh = `.worktrees/${branchName} ｜ ${branchName} ｜ baseline ${initialHead.slice(0, 7)} → HEAD ${advancedHead.slice(0, 7)} ｜ 正常`;
  assert.ok(textsZh.includes(expectedLineZh), `Chinese line should match: ${expectedLineZh}`);
  assert.ok(!textsZh.includes("未创建 worktree"), "Must not display '未创建 worktree'");

  sandbox.dgT = (k: string) => sandbox.en[k] ?? k;
  const vnodeEn = sandbox.AttemptWorktrees({ attempts: detail.attempts, worktrees: discovery });
  const textsEn = extractAllText(vnodeEn);
  const expectedLineEn = `.worktrees/${branchName} ｜ ${branchName} ｜ baseline ${initialHead.slice(0, 7)} → HEAD ${advancedHead.slice(0, 7)} ｜ OK`;
  assert.ok(textsEn.includes(expectedLineEn), `English line should match: ${expectedLineEn}`);
});

test("g-279 场景 2：未交付目标（protected/not_delivered）worktree 只读正常展示，不削弱清理侧安全闸", () => {
  const { ws, graphRoot } = createGitFixture();
  const goalId = createGoal(graphRoot, { title: "Undelivered goal", version: "v0.11.0", actor: "test" });
  const attId = startAttempt(graphRoot, goalId, { executor: "test", actor: "test" });

  const branchName = `${goalId}-att-01`;
  const wtPath = join(ws, ".worktrees", branchName);
  execFileSync("git", ["-C", ws, "worktree", "add", "-q", "-b", branchName, wtPath]);

  // 1. 清理侧安全闸验证：未交付目标绝不成为 candidate
  const cleanRows = listWorktrees(graphRoot, goalId);
  const cleanRow = cleanRows.find((x) => x.attempt === attId);
  assert.ok(cleanRow, "Cleanup engine should track the worktree");
  assert.equal(cleanRow.status, "protected");
  assert.equal(cleanRow.reason, "not_delivered");

  // 2. 展示侧验证：在 🌿 Worktree tab 依然完整展示
  _clearWorktreeCache();
  const detail = goalDetail(graphRoot, goalId);
  const discovery = discoverAttemptWorktrees(ws, goalId, detail.attempts, graphRoot);
  assert.equal(discovery.status, "ok");
  const item = discovery.items[attId];
  assert.ok(item, "Undelivered goal worktree must be discovered on display side");
  assert.equal(item.path, `.worktrees/${branchName}`);
  assert.equal(item.status, "正常");

  const sandbox = loadAttemptWorktreesComponent();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;
  const vnode = sandbox.AttemptWorktrees({ attempts: detail.attempts, worktrees: discovery });
  const texts = extractAllText(vnode);
  assert.ok(texts.some((t) => t.includes(`.worktrees/${branchName}`)));
  assert.ok(!texts.includes("未创建 worktree"));
});

test("g-279 场景 3：已清理/已移除的 worktree 历史只读展示与已清理状态，不得伪装成未创建", () => {
  const { ws, graphRoot } = createGitFixture();
  const goalId = createGoal(graphRoot, { title: "Cleaned goal", version: "v0.11.0", actor: "test" });
  const attId = startAttempt(graphRoot, goalId, { executor: "test", actor: "test" });

  const branchName = `${goalId}-att-01`;
  const wtRel = `.worktrees/${branchName}`;
  const wtAbs = join(ws, wtRel);
  const initialHead = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // 模拟清理事件记录（worktree 已被清理删除，从 git list 消失）
  appendEvent(graphRoot, {
    actor: "human:test",
    event: "worktree.candidate_registered",
    goal: goalId,
    details: {
      id: `${goalId}:${attId}:${wtAbs}`,
      goal: goalId,
      attempt: attId,
      path: wtAbs,
      branch: branchName,
      head: initialHead,
      status: "candidate",
    },
  });
  appendEvent(graphRoot, {
    actor: "human:test",
    event: "worktree.cleaned",
    goal: goalId,
    details: {
      id: `${goalId}:${attId}:${wtAbs}`,
      goal: goalId,
      attempt: attId,
      path: wtAbs,
      branch: branchName,
      head: initialHead,
      status: "candidate",
      cleaned_at: nowIso(),
    },
  });

  _clearWorktreeCache();
  const detail = goalDetail(graphRoot, goalId);
  const discovery = discoverAttemptWorktrees(ws, goalId, detail.attempts, graphRoot);
  assert.equal(discovery.status, "ok");

  const item = discovery.items[attId];
  assert.ok(item, "Cleaned attempt worktree must be discovered from history");
  assert.equal(item.path, wtRel);
  assert.equal(item.branch, branchName);
  assert.equal(item.head, initialHead.slice(0, 7));
  assert.equal(item.status, "已清理");
  assert.equal(item.cleaned, true);

  // UI 验证
  const sandbox = loadAttemptWorktreesComponent();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;
  const vnodeZh = sandbox.AttemptWorktrees({ attempts: detail.attempts, worktrees: discovery });
  const textsZh = extractAllText(vnodeZh);
  assert.ok(textsZh.some((t) => t.includes(wtRel) && t.includes("已清理")), "Should display path and 已清理 in zh");
  assert.ok(!textsZh.includes("未创建 worktree"), "Must not display '未创建 worktree' for cleaned worktree");

  sandbox.dgT = (k: string) => sandbox.en[k] ?? k;
  const vnodeEn = sandbox.AttemptWorktrees({ attempts: detail.attempts, worktrees: discovery });
  const textsEn = extractAllText(vnodeEn);
  assert.ok(textsEn.some((t) => t.includes(wtRel) && t.includes("Cleaned")), "Should display path and Cleaned in en");
  assert.ok(!textsEn.includes("No worktree created"), "Must not display 'No worktree created' for cleaned worktree");
});

test("g-279 场景 4：真实不存在 worktree 的 attempt 仍显示「未创建 worktree」", () => {
  const { ws, graphRoot } = createGitFixture();
  const goalId = createGoal(graphRoot, { title: "No worktree goal", version: "v0.11.0", actor: "test" });
  const attId = startAttempt(graphRoot, goalId, { executor: "test", actor: "test" });

  _clearWorktreeCache();
  const detail = goalDetail(graphRoot, goalId);
  const discovery = discoverAttemptWorktrees(ws, goalId, detail.attempts, graphRoot);
  assert.equal(discovery.status, "ok");
  assert.equal(discovery.items[attId], undefined, "Attempt with no worktree on disk or events must not be in items");

  const sandbox = loadAttemptWorktreesComponent();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;
  const vnodeZh = sandbox.AttemptWorktrees({ attempts: detail.attempts, worktrees: discovery });
  const textsZh = extractAllText(vnodeZh);
  assert.ok(textsZh.includes("未创建 worktree"), "Must display '未创建 worktree'");

  sandbox.dgT = (k: string) => sandbox.en[k] ?? k;
  const vnodeEn = sandbox.AttemptWorktrees({ attempts: detail.attempts, worktrees: discovery });
  const textsEn = extractAllText(vnodeEn);
  assert.ok(textsEn.includes("No worktree created"), "Must display 'No worktree created' in en");
});

test("g-279 场景 5：放宽匹配不得误挂无关 worktree，严格拒绝同名外来路径与分支不一致", () => {
  const { ws, graphRoot } = createGitFixture();
  const goalId = createGoal(graphRoot, { title: "Security check goal", version: "v0.11.0", actor: "test" });
  const attId = startAttempt(graphRoot, goalId, { executor: "test", actor: "test" });

  // 1. 同名但落在 canonical workspace 外部的路径
  const outsideDir = mkdtempSync(join(tmpdir(), "g279-outside-"));
  const outsidePath = join(outsideDir, `${goalId}-att-01`);
  execFileSync("git", ["-C", ws, "worktree", "add", "-q", "-b", `${goalId}-att-01`, outsidePath]);

  _clearWorktreeCache();
  const detail = goalDetail(graphRoot, goalId);
  const discovery = discoverAttemptWorktrees(ws, goalId, detail.attempts, graphRoot);
  assert.equal(discovery.items[attId], undefined, "Foreign path outside .worktrees must be rejected");

  execFileSync("git", ["-C", ws, "worktree", "remove", "--force", outsidePath]);

  // 2. 路径在 .worktrees/ 内但分支名不匹配
  const validPath = join(ws, ".worktrees", `${goalId}-att-01`);
  execFileSync("git", ["-C", ws, "worktree", "add", "-q", "-b", "some-unrelated-branch", validPath]);

  _clearWorktreeCache();
  const discovery2 = discoverAttemptWorktrees(ws, goalId, detail.attempts, graphRoot);
  assert.equal(discovery2.items[attId], undefined, "Mismatched branch name must be rejected");
});

test("g-279 场景 6：真实仓库靶子（g-275/276/277 与 g-270）硬核复核", () => {
  const ws = "/home/miuzel/workspace/personal/dsh-graph";
  const root = "/home/miuzel/workspace/personal/dsh-graph/.dsh-graph";

  _clearWorktreeCache();

  // g-275: 存在于磁盘，HEAD 已从 928ea52 推进到 5d6b1dc
  const d275 = goalDetail(root, "g-275");
  const res275 = discoverAttemptWorktrees(ws, "g-275", d275.attempts, root);
  assert.equal(res275.status, "ok");
  const item275 = res275.items["att-001"];
  assert.ok(item275, "g-275 att-001 worktree must be discovered");
  assert.equal(item275.path, ".worktrees/g-275-att-001");
  assert.equal(item275.branch, "g-275-att-001");
  assert.equal(item275.head, "5d6b1dc");
  assert.equal(item275.baseline_head, "928ea52");
  assert.equal(item275.head_advanced, true);

  // g-276: 存在于磁盘，HEAD 已从 928ea52 推进到 8b16cde
  const d276 = goalDetail(root, "g-276");
  const res276 = discoverAttemptWorktrees(ws, "g-276", d276.attempts, root);
  assert.equal(res276.status, "ok");
  const item276 = res276.items["att-001"];
  assert.ok(item276, "g-276 att-001 worktree must be discovered");
  assert.equal(item276.path, ".worktrees/g-276-att-001");
  assert.equal(item276.branch, "g-276-att-001");
  assert.equal(item276.head, "8b16cde");
  assert.equal(item276.baseline_head, "928ea52");
  assert.equal(item276.head_advanced, true);

  // g-277: 存在于磁盘，HEAD 已从 928ea52 推进到 d2efd33
  const d277 = goalDetail(root, "g-277");
  const res277 = discoverAttemptWorktrees(ws, "g-277", d277.attempts, root);
  assert.equal(res277.status, "ok");
  const item277 = res277.items["att-001"];
  assert.ok(item277, "g-277 att-001 worktree must be discovered");
  assert.equal(item277.path, ".worktrees/g-277-att-001");
  assert.equal(item277.branch, "g-277-att-001");
  assert.equal(item277.head, "d2efd33");
  assert.equal(item277.baseline_head, "928ea52");
  assert.equal(item277.head_advanced, true);

  // g-270: att-001 确实不存在，att-002 已清理
  const d270 = goalDetail(root, "g-270");
  const res270 = discoverAttemptWorktrees(ws, "g-270", d270.attempts, root);
  assert.equal(res270.status, "ok");
  assert.equal(res270.items["att-001"], undefined, "g-270 att-001 does not exist");
  const item270_2 = res270.items["att-002"];
  assert.ok(item270_2, "g-270 att-002 must be found as cleaned");
  assert.equal(item270_2.path, ".worktrees/g-270-att-002");
  assert.equal(item270_2.status, "已清理");
  assert.equal(item270_2.cleaned, true);

  // UI 端到端验证
  const sandbox = loadAttemptWorktreesComponent();
  sandbox.dgT = (k: string) => sandbox.zh[k] ?? k;

  const vnode275 = sandbox.AttemptWorktrees({ attempts: d275.attempts, worktrees: res275 });
  const texts275 = extractAllText(vnode275);
  assert.ok(texts275.some((t) => t.includes(".worktrees/g-275-att-001") && t.includes("baseline 928ea52 → HEAD 5d6b1dc")));

  const vnode270 = sandbox.AttemptWorktrees({ attempts: d270.attempts, worktrees: res270 });
  const texts270 = extractAllText(vnode270);
  assert.ok(texts270.includes("未创建 worktree"), "g-270 att-001 must show 未创建 worktree");
  assert.ok(texts270.some((t) => t.includes(".worktrees/g-270-att-002") && t.includes("已清理")), "g-270 att-002 must show 已清理");
});

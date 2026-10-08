/** g-447：自定义 root 下卡片「精确路径」必须指向**真实卡片文件**（内容/digest 匹配，而不仅 exists），
 *  且不得被默认根的同名卡片误读。
 *
 *  背景：`toWorkspaceCardPath` 旧实现无条件硬拼 `.dsh-graph/`，忽略实际解析出的图根
 *  （`core/root.ts` 的 `resolveCanonicalRoot`：相对值基于 workspace、绝对值独立覆盖）。
 *  缺陷形态有两种，本文件都钉住：
 *   ① **不可达**：自定义根下的目标，注入路径按 workspace 解析根本不存在；
 *   ② **静默误读**：默认根下恰有同 id 卡片时，注入路径指向**另一张卡**（只断言 exists 会假通过）。
 *
 *  覆盖：默认根 / 相对自定义根 / 嵌套相对自定义根 / 工作区内合法绝对根 ×（内容 + digest + 注入段路径）
 *  ＋同名负向对照 ＋2 参旧契约不回退 ＋权限面不扩大（越界卡片引用与附件引用仍被拒）
 *  ＋宿主派发端到端（相对自定义根 / 工作区内绝对根 / 默认根回归）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  addCard,
  fillCard,
  harvestedCards,
  formatHarvestedCardsSection,
  toWorkspaceCardPath,
  loadGoal,
} from "../ops.ts";
import { serializeDoc } from "../model.ts";
import { resolveCanonicalRoot, _clearCanonicalRootCache } from "../root.ts";
import { apply } from "../../dist/index.js";

const sha1_16 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** 建一个 git 主工作树（供 resolveCanonicalRoot 走真实 Git 发现）；板目录一律 gitignore ⇒ 判干净。 */
function gitWorkspace(prefix: string): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: ws, stdio: ["ignore", "pipe", "pipe"] });
  run("init", "-b", "main");
  writeFileSync(join(ws, ".gitignore"), ".dsh-graph/\nboard-a/\nboards/\nboard-absolute/\n.worktrees/\n");
  writeFileSync(join(ws, "seed.txt"), "seed\n");
  run("add", ".gitignore", "seed.txt");
  run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-m", "seed");
  return ws;
}

/** 在一个图根下造「一张自有卡 + 一张共享卡」的 filled 目标（正文带 tag 以区分来源）。 */
function makeBoard(root: string, tag: string): { goal: string; own: string; shared: string } {
  init(root);
  const goal = createGoal(root, { title: `board ${tag}`, version: "v-t", actor: "test", description: `描述 ${tag}` });
  setCriteria(root, goal, [`判据 ${tag}`], "test");
  const own = addCard(root, goal, { title: "own", kind: "text", actor: "test", scope: "goal" });
  const shared = addCard(root, goal, { title: "shared", kind: "text", actor: "test", scope: "shared" });
  fillCard(root, goal, own, { text: `BODY-${tag}-own `.repeat(30), summary: `摘要-${tag}`, by: "human:t", actor: "test" });
  fillCard(root, goal, shared, { text: `BODY-${tag}-shared `.repeat(30), summary: `摘要-${tag}`, by: "human:t", actor: "test" });
  return { goal, own, shared };
}

/** 卡片 id 是随机 `card-<uuid8>` ⇒ 负向对照（默认根下同 id 卡片）需**显式对齐 id**：
 *  把另一板的卡片文件改名为目标 id，并同步 goal.md 的 context_cards。 */
function alignCardIds(
  root: string,
  board: { goal: string; own: string; shared: string },
  target: { own: string; shared: string },
): { goal: string; own: string; shared: string } {
  if (board.own === target.own && board.shared === target.shared) return board;
  const goalFile = join(root, "versions", "v-t", "goals", board.goal, "goal.md");
  const doc = loadGoal(goalFile);
  const mapping: Record<string, string> = { [board.own]: target.own, [board.shared]: target.shared };
  const ownDir = join(root, "versions", "v-t", "goals", board.goal, "cards");
  for (const [from, to] of Object.entries(mapping)) {
    const ownFrom = join(ownDir, `${from}.md`);
    if (existsSync(ownFrom)) renameSync(ownFrom, join(ownDir, `${to}.md`));
    const sharedFrom = join(root, "shared-cards", `${from}.md`);
    if (existsSync(sharedFrom)) renameSync(sharedFrom, join(root, "shared-cards", `${to}.md`));
  }
  doc.meta.context_cards = (doc.meta.context_cards as string[]).map((id) => mapping[id] ?? id);
  writeFileSync(goalFile, serializeDoc(doc), "utf8");
  return { goal: board.goal, own: target.own, shared: target.shared };
}

/** 断言：该图根下目标的每张卡，注入路径按 workspace 解析后 → 可达 + 内容来自本图根 + digest 命中。 */
function assertInjectedPathsReadThisRoot(
  { ws, root, tag, goalId, label }: { ws: string; root: string; tag: string; goalId: string; label: string },
): void {
  const cards = harvestedCards(root, goalId, ws);
  assert.ok(cards.length >= 1, `[${label}] 应读到 filled 卡片`);
  for (const card of cards) {
    const at = `[${label}/${goalId}/${card.id}]`;
    assert.ok(card.path, `${at} 注入路径必须存在`);
    const abs = resolve(ws, card.path!);
    assert.ok(existsSync(abs), `${at} 注入路径按 workspace 解析必须可达：${card.path}`);
    const raw = readFileSync(abs, "utf8");
    assert.ok(raw.includes(`BODY-${tag}-`), `${at} 内容必须来自实际图根 ${root}，实际路径 ${card.path}`);
    if (tag !== "DEFAULT") {
      assert.ok(!raw.includes("BODY-DEFAULT-"), `${at} 不得读到默认根的同名卡片（负向对照）`);
    }
    // digest 是真实卡片文件内容的 sha1 前 16 位 ⇒ 「内容匹配」比 exists 强
    assert.equal(card.digest, sha1_16(raw), `${at} digest 必须与实际图根卡片文件内容一致`);
    // 注入段（强制折叠）里出现的正是该路径
    const sec = formatHarvestedCardsSection(root, goalId, { maxTotalChars: 1 }, cards, "zh", ws);
    assert.ok(sec.includes(card.path!), `${at} 注入段必须含该精确路径`);
  }
}

// ---- ① 单元：toWorkspaceCardPath 以实际解析出的图根（第三参 workspace）为基准 ----

test("g-447：toWorkspaceCardPath 在四类图根下都给出 workspace 相对的真实路径", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g447-unit-"));
  const card = (board: string) => join(ws, board, "goals", "g-1", "cards", "c-1.md");
  assert.equal(
    toWorkspaceCardPath(join(ws, ".dsh-graph"), card(".dsh-graph"), ws),
    ".dsh-graph/goals/g-1/cards/c-1.md", "默认根");
  assert.equal(
    toWorkspaceCardPath(join(ws, "board-a"), card("board-a"), ws),
    "board-a/goals/g-1/cards/c-1.md", "相对自定义根");
  assert.equal(
    toWorkspaceCardPath(join(ws, "boards", "board-n"), card("boards/board-n"), ws),
    "boards/board-n/goals/g-1/cards/c-1.md", "嵌套相对自定义根");
  assert.equal(
    toWorkspaceCardPath(join(ws, "board-absolute"), card("board-absolute"), ws),
    "board-absolute/goals/g-1/cards/c-1.md", "工作区内绝对根");
  // 注入契约：POSIX `/` 形态（Windows 反斜杠不得漏出）
  for (const rel of [
    toWorkspaceCardPath(join(ws, "board-a"), card("board-a"), ws),
    toWorkspaceCardPath(join(ws, "board-a"), card("board-a")),
  ]) assert.ok(!rel.includes("\\"), `注入路径必须是 POSIX 形态：${rel}`);
});

test("g-447：缺省 workspace 参数时保持旧契约（默认根形态逐字不变）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g447-legacy-"));
  // 2 参旧调用（既有消费方/既有断言）：basename 为 .dsh-graph 的根仍给出 .dsh-graph/… 相对路径
  assert.equal(
    toWorkspaceCardPath(join(ws, ".dsh-graph"), join(ws, ".dsh-graph/cards/c-1.md")),
    ".dsh-graph/cards/c-1.md");
  // 默认根 + 第三参：与旧契约一致（不回退）
  assert.equal(
    toWorkspaceCardPath(join(ws, ".dsh-graph"), join(ws, ".dsh-graph/goals/g-1/cards/c-1.md"), ws),
    toWorkspaceCardPath(join(ws, ".dsh-graph"), join(ws, ".dsh-graph/goals/g-1/cards/c-1.md")));
});

// ---- ② core：四类图根 ×（内容/digest/注入段）+ 同名负向对照（真实 Git 工作树） ----

test("g-447：四类图根下注入路径均指向真实卡片内容；默认根同名卡片不被误读", () => {
  const ws = gitWorkspace("dsh-graph-g447-core-");
  const defaultRoot = join(ws, ".dsh-graph");
  const defaultBoard = makeBoard(defaultRoot, "DEFAULT");

  const cases: Array<{ label: string; raw: string | undefined; root: string }> = [
    { label: "default", raw: undefined, root: defaultRoot },
    { label: "custom-relative", raw: "board-a", root: join(ws, "board-a") },
    { label: "nested-relative", raw: "boards/board-n", root: join(ws, "boards", "board-n") },
    { label: "in-workspace-absolute", raw: join(ws, "board-absolute"), root: join(ws, "board-absolute") },
  ];

  for (const c of cases) {
    _clearCanonicalRootCache();
    const resolved = resolveCanonicalRoot({ root: c.raw }, ws, { ttlMs: 0 });
    assert.equal(resolved.root, c.root, `[${c.label}] 图根解析`);
    const tag = c.label === "default" ? "DEFAULT" : c.label;
    let board = makeBoard(resolved.root, tag);
    if (c.label !== "default") {
      // 负向对照前提：默认根与自定义根下**同 id** 的同名卡片（显式对齐随机 id）
      assert.equal(board.goal, defaultBoard.goal, "同名负向对照要求两板目标 id 相同");
      board = alignCardIds(resolved.root, board, defaultBoard);
      assert.ok(existsSync(join(resolved.root, "shared-cards", `${board.shared}.md`)), "自定义根共享卡与默认根同 id");
    }
    // 两板同 id ⇒ 误读会被内容/digest 断言抓住
    assertInjectedPathsReadThisRoot({ ws, root: resolved.root, tag, goalId: board.goal, label: c.label });
    if (c.label !== "default") {
      // 只存在于自定义根的第二个目标 ⇒ 覆盖「注入路径根本不可达」形态
      const fresh = makeBoard(resolved.root, tag);
      assertInjectedPathsReadThisRoot({ ws, root: resolved.root, tag, goalId: fresh.goal, label: `${c.label}(fresh)` });
    }
  }
});

// ---- ③ 注入段：截断形态给出的精确路径在自定义根下可读且 digest 命中 ----

test("g-447：自定义根下截断提示里的精确路径真实可读（不只 exists）", () => {
  const ws = gitWorkspace("dsh-graph-g447-trunc-");
  _clearCanonicalRootCache();
  const root = resolveCanonicalRoot({ root: "board-a" }, ws, { ttlMs: 0 }).root;
  const board = makeBoard(root, "custom");
  const long = "自定义根正文数据。".repeat(200);
  fillCard(root, board.goal, board.own, { text: long, summary: "摘要", by: "human:t", actor: "test" });

  const cards = harvestedCards(root, board.goal, ws);
  const sec = formatHarvestedCardsSection(root, board.goal, { maxCardChars: 100 }, cards, "zh", ws);
  const m = sec.match(/完整内容请读取 ([\S]+)，digest=([0-9a-f]{16})/);
  assert.ok(m, "截断提示必须给出精确路径与 digest");
  const rel = m![1];
  assert.ok(rel.startsWith("board-a/"), `自定义根下路径必须以实际图根为基准：${rel}`);
  const abs = resolve(ws, rel);
  assert.ok(existsSync(abs), `路径必须真实存在：${abs}`);
  const raw = readFileSync(abs, "utf8");
  assert.equal(sha1_16(raw), m![2], "提示中的 digest 必须与被指向文件的真实内容一致");
  assert.ok(raw.includes("自定义根正文数据。"), "从该路径可读到卡片原始内容");
});

// ---- ④ 权限面不扩大：越界卡片引用 / 附件引用仍被拒（自定义根下同样） ----

test("g-447：自定义图根不扩大读取面（越界 context_cards 与附件引用仍被拒）", () => {
  const ws = gitWorkspace("dsh-graph-g447-perm-");
  _clearCanonicalRootCache();
  const root = resolveCanonicalRoot({ root: "board-a" }, ws, { ttlMs: 0 }).root;
  const board = makeBoard(root, "perm");
  const goalFile = join(root, "versions", "v-t", "goals", board.goal, "goal.md");

  // 越界卡片引用：仍必须跳过（旧实现被跳过的原因与图根无关，修复不得放宽）
  const doc = loadGoal(goalFile);
  doc.meta.context_cards = ["../../../../etc/passwd", board.own];
  writeFileSync(goalFile, serializeDoc(doc), "utf8");
  const cards = harvestedCards(root, board.goal, ws);
  assert.deepEqual(cards.map((c) => c.id), [board.own], "越界卡片引用必须仍被跳过（不因 root 修复而扩权）");
  const abs = resolve(ws, cards[0].path!);
  assert.ok(existsSync(abs), "合法卡的注入路径仍可达");
  assert.equal(cards[0].digest, sha1_16(readFileSync(abs, "utf8")), "合法卡 digest 仍与真实文件一致");

  // 附件引用：越界 @att 仍不进注入清单
  const body = readFileSync(abs, "utf8");
  const bodyStart = body.indexOf("\n---\n", 4);
  writeFileSync(abs, body.slice(0, bodyStart + 5) + "\n@att/../escape @att/ok-name.txt\n", "utf8");
  const again = harvestedCards(root, board.goal, ws);
  assert.deepEqual(again[0].attachments, ["ok-name.txt"], "越界附件引用必须仍被过滤");
  assert.ok(existsSync(resolve(ws, again[0].path!)), "附件过滤后注入路径仍以实际图根为准");
});

// ---- ⑤ 宿主端到端：spawn prompt 里的卡片精确路径（相对自定义根 / 绝对根 / 默认根回归） ----

/** 自有卡正文超总预算 ⇒ 注入段折叠它并给出**精确路径 + digest**；共享卡短 ⇒ 正文内联可见。
 *  两者合起来同时钉住「路径指向实际图根」与「内联内容来自实际图根」。 */
function makePromptBoard(root: string, tag: string): { goal: string; own: string; shared: string } {
  init(root);
  const goal = createGoal(root, { title: `p ${tag}`, version: "v-t", actor: "test", description: `描述 ${tag}` });
  setCriteria(root, goal, [`判据 ${tag}`], "test");
  const own = addCard(root, goal, { title: "own", kind: "text", actor: "test", scope: "goal" });
  const shared = addCard(root, goal, { title: "shared", kind: "text", actor: "test", scope: "shared" });
  fillCard(root, goal, own, { text: `LONG-${tag}-own `.repeat(400), summary: `摘要-${tag}`, by: "human:t", actor: "test" });
  fillCard(root, goal, shared, { text: `LONG-${tag}-shared`, summary: `摘要-${tag}`, by: "human:t", actor: "test" });
  return { goal, own, shared };
}

function hostWithRoot(ws: string, rootConfig: any, captured: { prompt?: string }) {
  const routes = new Map<string, any>();
  const registered: any[] = [];
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "subagents") return {
        list: () => ["spawn"],
        getProvider: () => ({ prepareContinuable: () => {} }),
        startContinuable: async (opts: any) => {
          captured.prompt = opts.request?.prompt?.[0]?.text ?? "";
          return { childId: "child-g447" };
        },
      };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, rootConfig);
  const tool = registered.find((d: any) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 已注册");
  return { tool };
}

const execCtx = (ws: string) => ({
  agent: { session: { id: "sess-exec", header: { cwd: ws } } },
  signal: new AbortController().signal,
});

/** 端到端：给定图根配置，断言 prompt 中的卡片精确路径按 workspace 解析后读到的**正是该图根**的卡片。 */
async function assertPromptCardPaths(makeConfig: (ws: string) => any, makeBoardRoot: (ws: string) => string, expectTag: string) {
  _clearCanonicalRootCache();
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g447-host-"));
  const defaultRoot = join(ws, ".dsh-graph");
  const defaultBoard = makePromptBoard(defaultRoot, "DEFAULT");
  const root = makeBoardRoot(ws);
  let board = defaultBoard;
  if (root !== defaultRoot) {
    board = alignCardIds(root, makePromptBoard(root, expectTag), defaultBoard);
  }
  assert.equal(board.goal, defaultBoard.goal, "负向对照：两板同目标 id");
  assert.equal(board.own, defaultBoard.own, "负向对照：两板同自有卡 id");
  assert.equal(board.shared, defaultBoard.shared, "负向对照：两板同共享卡 id");

  const captured: { prompt?: string } = {};
  const { tool } = hostWithRoot(ws, makeConfig(ws), captured);
  const res = await tool.execute({ goal: board.goal, worktree: false }, execCtx(ws));
  assert.equal(res.child_id, "child-g447");
  const prompt = captured.prompt!;

  const relOwn = relative(ws, join(root, "versions", "v-t", "goals", board.goal, "cards", `${board.own}.md`));
  const relShared = relative(ws, join(root, "shared-cards", `${board.shared}.md`));
  assert.ok(prompt.includes(relOwn), `prompt 必须含该图根的自有卡精确路径 ${relOwn}`);
  const wrongOwn = `.dsh-graph/versions/v-t/goals/${board.goal}/cards/${board.own}.md`;
  if (relOwn !== wrongOwn) {
    assert.ok(!prompt.includes(wrongOwn), "prompt 不得把卡片指向默认根（负向对照）");
  }
  // 端到端内容核验：prompt 给出的路径按 workspace 解析后读到的是该图根那张
  const rawOwn = readFileSync(resolve(ws, relOwn), "utf8");
  assert.ok(rawOwn.includes(`LONG-${expectTag}-own`), "prompt 路径必须读到该图根卡片内容");
  if (expectTag !== "DEFAULT") {
    assert.ok(!rawOwn.includes("LONG-DEFAULT-own"), "prompt 路径不得读到默认根同名卡片");
  }
  assert.ok(prompt.includes(`digest=${sha1_16(rawOwn)}`), "prompt 中的 digest 必须与该文件真实内容一致");
  // 内联的共享卡正文也必须来自该图根（路径正确但内容串板同样不可接受）
  assert.ok(existsSync(resolve(ws, relShared)), "共享卡注入路径按 workspace 解析必须可达");
  assert.ok(prompt.includes(`LONG-${expectTag}-shared`), "prompt 内联的共享卡正文必须来自该图根");
  if (expectTag !== "DEFAULT") {
    assert.ok(!prompt.includes("LONG-DEFAULT-shared"), "prompt 不得内联默认根的同名共享卡");
  }
  assert.ok(prompt.includes(relative(ws, join(root, "versions", "v-t", "goals", board.goal, "goal.md"))),
    "目标文件精确路径与卡片路径必须同一 workspace 基准");
}

test("g-447（端到端）：相对自定义根下 spawn prompt 的卡片精确路径指向自定义根", async () => {
  await assertPromptCardPaths(() => ({ root: "board-a" }), (ws) => join(ws, "board-a"), "custom");
});

test("g-447（端到端）：工作区内绝对根下 spawn prompt 的卡片精确路径指向该绝对根", async () => {
  await assertPromptCardPaths((ws) => ({ root: join(ws, "board-absolute") }), (ws) => join(ws, "board-absolute"), "abs");
});

test("g-447（端到端）：默认根行为不回退（.dsh-graph 相对路径 + 真实内容）", async () => {
  await assertPromptCardPaths(() => ({}), (ws) => join(ws, ".dsh-graph"), "DEFAULT");
});

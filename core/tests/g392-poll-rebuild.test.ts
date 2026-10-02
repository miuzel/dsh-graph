/**
 * g-392 判据 1/2：正常 GUI 轮询下的 payloadFactory 无效重建 —— 前后可重放对照。
 *
 * 事实（已核实基线）：
 *   - GUI helpers.js：DEFAULT_REFRESH_INTERVAL = 15s、MIN_REFRESH_INTERVAL = 5s 轮询；
 *   - core/cache-state.ts：IDLE_CLOSE_MS = 500（基线）；
 *   - core/cache.ts：watcher 关闭/重开 ⇒ watcherEpoch 变化 ⇒ rescan=true ⇒ 即使内容未变
 *     也会调用 payloadFactory 完整重建（结束仍可能 fromCache=true，该标记不代表省去投影工作）。
 *
 * 本文件**只使用基线就已存在的导出**（boardPayload / getCachedBoardPayload / closeWatchers），
 * 因此同一个文件可以在修复前后各跑一次，形成可重放对照：
 *   修复前（baseline ac544bb）：3 次 5s 轮询、无内容变化 ⇒ payloadFactory 调用 3 次（断言必红，
 *                               实际计数写在断言消息里，可直接读取）；
 *   修复后：                    同脚本同参数 ⇒ payloadFactory 调用 1 次（仅首次构建）。
 * 即：判据 1 的「修改前」数字由本文件在 baseline 上的失败消息给出，不是另行手写的结论。
 *
 * 判据 2 的三条断言同在本文件：
 *   - 文件变更即时失效：外部写 goal.md 后，watcher 事件在**不经任何看板读取**的情况下即推进
 *     generation（waitWatcherBump 断言），下一次读取必须 fromCache=false 且载荷/ETag 更新；
 *   - 关闭期间变更：closeWatchers() 模拟空闲关闭后写入，下一次读取必须 rescan 检出、
 *     返回新载荷且 ETag 不误复用（同时用「无变更时 rescan 仍调用一次工厂」证明检出确实发生）；
 *   - 驱逐期间变更：用 >MAX_WATCHERS 个 root 挤掉最早者（epoch 递增即证明驱逐关闭），此后写入
 *     必须被下次读取 rescan 检出（与空闲关闭共用同一「epoch 失配 ⇒ rescan」代码路径）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init, createGoal, boardPayload } from "../../dist/core/ops.js";
import { getCachedBoardPayload, closeWatchers } from "../../dist/core/cache.js";
import { generation, ensureWatcher, watcherEpoch } from "../../dist/core/cache-state.js";

const POLL_MS = 5000; // GUI 最低轮询间隔（最不利的正常轮询）
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-g392-poll-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "轮询目标", actor: "test" });
  return {
    root,
    goalId,
    goalFile: join(root, "backlog", `${goalId}.md`),
    cleanup: () => {
      closeWatchers();
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 计数用工厂：真实 boardPayload + 调用计数（不复制实现）。 */
function countingFactory() {
  const state = { calls: 0 };
  const factory = (root: string, opts: { includeArchived: boolean; lazy: boolean }) => {
    state.calls += 1;
    return boardPayload(root, { includeArchived: opts?.includeArchived, lazy: opts?.lazy });
  };
  return { state, factory };
}

/** 等待 watcher 事件推进 generation（证明失效来自文件系统事件，而非看板读取触发）。 */
async function waitWatcherBump(root: string, from: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (generation(root) === from && Date.now() < deadline) await sleep(20);
  assert.notEqual(generation(root), from, `watcher 未在 ${timeoutMs}ms 内送达文件变更事件`);
}

function externalTitle(root: string, goalId: string, title: string): void {
  writeFileSync(
    join(root, "backlog", `${goalId}.md`),
    `---\n${JSON.stringify({ id: goalId, title, status: "backlog" })}\n---\n\n## 描述\n外部写入\n`,
    "utf8",
  );
}

test("g-392 判据 1：正常 5s 轮询且无内容变化时 payloadFactory 只重建一次（基线为每次轮询重建）", async () => {
  const { root, cleanup } = setup();
  try {
    const { state, factory } = countingFactory();

    const first = getCachedBoardPayload(root, undefined, factory);
    assert.equal(first.fromCache, false, "首次读取必须真实构建");
    assert.equal(state.calls, 1, `首次读取后 payloadFactory 调用次数应为 1，实际 ${state.calls}`);

    for (let i = 0; i < 2; i++) {
      await sleep(POLL_MS);
      const polled = getCachedBoardPayload(root, undefined, factory);
      assert.equal(polled.fromCache, true, `第 ${i + 2} 次轮询应命中缓存（内容未变）`);
      assert.equal(polled.etag, first.etag, `第 ${i + 2} 次轮询 ETag 必须稳定`);
    }

    // 修复前（IDLE_CLOSE_MS=500）：每次空闲关闭都会 bump epoch ⇒ rescan ⇒ 工厂被调用 3 次。
    // 修复后（有限空闲 TTL ≥ 默认轮询间隔）：watcher 跨轮询保持存活 ⇒ 工厂只被调用 1 次。
    assert.equal(
      state.calls,
      1,
      `正常轮询 3 次（间隔 ${POLL_MS}ms）、无内容变化时 payloadFactory 调用次数应为 1，实际 ${state.calls}`,
    );
  } finally {
    cleanup();
  }
});

test("g-392 判据 2a：文件变更即时失效（watcher 事件推进 generation，下次读取重建且 ETag 更新）", async () => {
  const { root, goalId, cleanup } = setup();
  try {
    const { state, factory } = countingFactory();
    const before = getCachedBoardPayload(root, undefined, factory);
    const g0 = generation(root);

    externalTitle(root, goalId, "即时失效后的标题");
    await waitWatcherBump(root, g0); // 不经看板读取，watcher 事件本身推进 generation

    const after = getCachedBoardPayload(root, undefined, factory);
    assert.equal(after.fromCache, false, "文件变更后不得复用旧缓存");
    assert.equal(state.calls, 2, `变更后应重建一次（累计 2），实际 ${state.calls}`);
    assert.notEqual(after.etag, before.etag, "内容变更后 ETag 必须变化");
    assert.equal(after.payload.backlog[0].title, "即时失效后的标题");
  } finally {
    cleanup();
  }
});

test("g-392 判据 2b：空闲关闭期间变更 → 下次读取 rescan 检出，ETag 不误复用", async () => {
  const { root, goalId, cleanup } = setup();
  try {
    const { state, factory } = countingFactory();
    const first = getCachedBoardPayload(root, undefined, factory);
    assert.equal(state.calls, 1);

    // 模拟空闲关闭（等价于 IDLE_CLOSE / MAX_WATCHERS 驱逐）：epoch 递增，断档开始。
    closeWatchers();
    const noChange = getCachedBoardPayload(root, undefined, factory);
    assert.equal(noChange.fromCache, true, "关闭但内容未变：保留旧载荷与 ETag");
    assert.equal(noChange.etag, first.etag);
    assert.deepEqual(noChange.payload, first.payload);
    assert.equal(state.calls, 2, "断档后必须重新 rescan（工厂被调用）以证明未盲目复用");

    // 第二次断档：关闭期间的**外部变更**必须被下次读取检出。
    closeWatchers();
    externalTitle(root, goalId, "断档期间外部修改");
    const changed = getCachedBoardPayload(root, undefined, factory);
    assert.equal(changed.fromCache, false, "断档期间变更必须返回新载荷");
    assert.equal(state.calls, 3, `断档检出应重建一次（累计 3），实际 ${state.calls}`);
    assert.notEqual(changed.etag, first.etag, "断档期间变更后 ETag 不得误复用");
    assert.equal(changed.payload.backlog[0].title, "断档期间外部修改");
  } finally {
    cleanup();
  }
});

test("g-392 判据 2c：watcher 被上限驱逐期间变更 → 下次读取 rescan 检出，ETag 不误复用", () => {
  const victim = setup();
  const extra: string[] = [];
  try {
    const { root, goalId } = victim;
    const { state, factory } = countingFactory();
    const first = getCachedBoardPayload(root, undefined, factory);
    const epochBefore = watcherEpoch(root);
    assert.equal(state.calls, 1);

    // 用 >MAX_WATCHERS 个 root 挤压：最早注册的 victim 必被驱逐（关 watcher），epoch 递增即证据。
    for (let i = 0; i < 40; i++) {
      const ws = mkdtempSync(join(tmpdir(), `dsh-g392-evict-${i}-`));
      const other = join(ws, ".dsh-graph");
      init(other);
      extra.push(ws);
      ensureWatcher(other);
    }
    assert.ok(watcherEpoch(root) > epochBefore, "victim 应被上限驱逐（epoch 递增 = watcher 已关闭）");

    // 驱逐断档期间的**外部变更**必须被下次读取检出（与空闲关闭共用 epoch 失配 ⇒ rescan 路径）。
    externalTitle(root, goalId, "驱逐期间外部修改");
    const after = getCachedBoardPayload(root, undefined, factory);
    assert.equal(after.fromCache, false, "驱逐期间变更必须返回新载荷");
    assert.equal(state.calls, 2, `驱逐断档检出应重建一次（累计 2），实际 ${state.calls}`);
    assert.notEqual(after.etag, first.etag, "驱逐期间变更后 ETag 不得误复用");
    assert.equal(after.payload.backlog[0].title, "驱逐期间外部修改");
  } finally {
    victim.cleanup();
    for (const ws of extra) {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  }
});

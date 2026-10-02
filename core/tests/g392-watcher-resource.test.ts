/**
 * g-392 判据 3：watcher 资源纪律回归 —— unref / 资源上限 / 关闭清理 / 多 root 有界 / 无后台残留。
 *
 * 改动只放宽了**空闲关闭 TTL**（500ms → 有限 TTL），资源纪律必须逐条钉住：
 *   a. TTL 是有限正数且覆盖 GUI 默认轮询间隔（否则轮询间隙仍会关闭重建）；
 *   b. unref 调用路径保留（结构性守卫）+ 计时器 unref 可行为断言（Timeout.hasRef），并证明
 *      closeWatchers() 后子进程可立即退出（不残留后台句柄）；
 *   c. 多 root 不无界保留 watcher：超过 MAX_WATCHERS 时驱逐最早者并 bump epoch（下次读取走断档
 *      rescan 兜底），closeWatchers 后 watcher 与空闲计时器双双清零（测试/宿主不残留后台资源）。
 *
 * 平台事实（既有、非本次改动引入）：Node v26/Linux 上 `fs.watch(dir,{recursive:true})` 会为每个
 * 子目录额外挂 ref'd 的 FSEventWrap，`w.unref()` 对递归 watcher 不生效（FSWatcher 亦不暴露
 * hasRef()）。因此「unref 让持有中的递归 watcher 不占事件循环」在本平台**无法用行为断言证明**；
 * 真实释放路径是 closeWatchers()/驱逐关闭，本文件对这两条做行为断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { init } from "../../dist/core/ops.js";
import {
  closeWatchers,
  ensureWatcher,
  inspectWatchers,
  watcherEpoch,
  watcherIdleCloseMs,
  MAX_WATCHERS,
} from "../../dist/core/cache-state.js";

const workspaces: string[] = [];

function mkRoot(tag: string): string {
  const ws = mkdtempSync(join(tmpdir(), `dsh-g392-res-${tag}-`));
  const root = join(ws, ".dsh-graph");
  init(root);
  workspaces.push(ws);
  return root;
}

function cleanupAll(): void {
  closeWatchers();
  for (const ws of workspaces) {
    try { rmSync(ws, { recursive: true, force: true }); } catch {}
  }
  workspaces.length = 0;
}

test("g-392 判据 3a：空闲关闭 TTL 为有限值且覆盖 GUI 默认 15s 轮询", () => {
  const ttl = watcherIdleCloseMs();
  assert.ok(Number.isFinite(ttl) && ttl > 0, `空闲 TTL 必须是有限正数，实际 ${ttl}`);
  assert.ok(
    ttl >= 15_000,
    `空闲 TTL 必须覆盖 GUI 默认 15s 轮询（helpers.js DEFAULT_REFRESH_INTERVAL=15），实际 ${ttl}`,
  );
});

test("g-392 判据 3b：unref 调用保持 + 清理彻底（closeWatchers 后子进程可正常退出）", () => {
  // 结构性守卫：unref 调用路径不得被删除（Node 的 FSWatcher 不暴露 hasRef，行为断言不足以钉住代码）。
  const src = readFileSync(join(import.meta.dirname, "../../core/cache-state.ts"), "utf8");
  assert.match(src, /w\.unref\?\.\(\)/, "watcher 的 unref 调用必须保留");
  assert.match(src, /timer\.unref\?\.\(\)/, "空闲计时器的 unref 调用必须保留");

  // 计时器 unref 可被行为断言：Timeout.hasRef() === false。
  const localRoot = mkRoot("timer-ref");
  assert.equal(ensureWatcher(localRoot), true);
  const info = inspectWatchers();
  assert.equal(info.size, 1);
  assert.equal(info.timers, 1);
  assert.ok(info.timerRefs.every((ref) => ref === false), "空闲计时器必须 unref");
  closeWatchers();

  // 真实释放路径：closeWatchers() 之后不残留任何句柄，子进程无需再等空闲 TTL 即可退出。
  // （说明：Node v26/Linux 上 `fs.watch(dir,{recursive:true})` 会在每个子目录额外挂 ref'd
  //  FSEventWrap，`w.unref()` 对其无效——这是**既有**平台事实、非本次改动引入；因此本用例断言
  //  「关闭清理有效」，而不是「unref 能让持有中的递归 watcher 不占事件循环」。）
  const opsUrl = pathToFileURL(join(import.meta.dirname, "../../dist/core/ops.js")).href;
  const stateUrl = pathToFileURL(join(import.meta.dirname, "../../dist/core/cache-state.js")).href;
  const childCode =
    `import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";` +
    ` import { init } from ${JSON.stringify(opsUrl)}; import { ensureWatcher, closeWatchers } from ${JSON.stringify(stateUrl)};` +
    ` const root = join(mkdtempSync(join(tmpdir(), "g392-close-")), ".dsh-graph"); init(root); ensureWatcher(root);` +
    ` closeWatchers(); process.stdout.write("closed-ok");`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8", timeout: 8000 });
  assert.equal(
    child.status,
    0,
    `closeWatchers 后子进程必须能立即退出（不残留后台句柄），实际 status=${child.status} signal=${child.signal} err=${child.error?.message ?? ""}`,
  );
  assert.equal(child.stdout, "closed-ok");
});

test("g-392 判据 3c：多 root 不无界保留 watcher（上限驱逐）+ closeWatchers 清零", () => {
  try {
    const first = mkRoot("first");
    assert.equal(ensureWatcher(first), true);
    const firstEpoch = watcherEpoch(first);

    const flood: string[] = [];
    for (let i = 0; i < MAX_WATCHERS + 6; i++) flood.push(mkRoot(`n${i}`));
    for (const root of flood) ensureWatcher(root);

    const info = inspectWatchers();
    assert.ok(info.size <= MAX_WATCHERS, `watcher 不得无界增长：上限 ${MAX_WATCHERS}，实际 ${info.size}`);
    assert.equal(info.size, MAX_WATCHERS, "持续访问新 root 时数量应稳定在上限（有界）");
    assert.equal(info.keys.includes(first), false, "最早的 root 应被驱逐，不得无界保留");
    assert.ok(watcherEpoch(first) > firstEpoch, "驱逐必须 bump epoch，使下次读取走断档 rescan 兜底");
    assert.ok(info.keys.includes(flood[flood.length - 1]), "最新访问的 root 必须保留");
    assert.ok(info.timers <= info.size, "空闲计时器不得多于 watcher");
    assert.ok(info.timerRefs.every((ref) => ref === false), "空闲计时器必须全部 unref（不占住事件循环）");

    closeWatchers();
    const cleared = inspectWatchers();
    assert.equal(cleared.size, 0, "closeWatchers 后不得残留 watcher");
    assert.equal(cleared.timers, 0, "closeWatchers 后不得残留空闲计时器");
  } finally {
    cleanupAll();
  }
});

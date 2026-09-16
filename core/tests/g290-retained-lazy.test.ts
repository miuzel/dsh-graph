/**
 * g-290：backlog / released 版本「retained 明细掩盖成员变化」缺陷的回归测试。
 *
 * 缺陷：kanban.js 的 load() 在 lazy 载荷下无条件用 g-258 的 retained 明细覆盖服务端返回，
 * 并把 data.backlog_count 覆盖成 retained 明细长度、把 backlog_loaded 置真 →
 * 拖出/归档/删除 backlog 成员后应用内刷新看不见（幽灵卡片），只有整页刷新才消失。
 *
 * 本测试 import 真实的 lib/client/board-retain.js 纯函数（与 search-state.js 同模式），
 * 数据用真实的 boardProjection(lazy) / backlogGoals() / versionGoals() 产出，不做孤立复制实现。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  createVersion,
  setVersionStatus,
  setCriteria,
  transition,
  releaseVersion,
  moveGoal,
  archiveGoal,
  boardProjection,
  backlogGoals,
  versionGoals,
  setGoalType,
} from "../ops.ts";
import { reconcileRetainedBoardState } from "../../dsh-graph-host/lib/client/board-retain.js";

function setupTestProject(): { root: string; ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "dsh-g290-test-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  return {
    root,
    ws,
    cleanup: () => {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 造一个已发布版本 v1.0（内含 n 个 delivered 目标） */
function makeReleasedVersionWithGoals(root: string, n: number): string[] {
  createVersion(root, { slug: "v1.0", name: "Version 1.0", actor: "test" });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = createGoal(root, { title: `v1 目标 ${i}`, version: "v1.0", actor: "test" });
    setCriteria(root, id, [`判据 ${i}`], "test");
    transition(root, id, "collecting", { actor: "test" });
    transition(root, id, "ready", { actor: "test" });
    transition(root, id, "in_progress", { actor: "test" });
    transition(root, id, "review", { actor: "test" });
    transition(root, id, "delivered", { actor: "test", force: true });
    ids.push(id);
  }
  releaseVersion(root, { slug: "v1.0", actor: "human:test" });
  return ids;
}

/** 模拟「展开态已拉取明细」的 retained payload（boardDataRef 中上一份同维度载荷） */
function retainedWithBacklogDetail(root: string) {
  const lazy = boardProjection(root, { lazy: true });
  const detail = backlogGoals(root);
  return { ...lazy, backlog: detail, backlog_count: detail.length, backlog_loaded: true };
}

const BACKLOG_EXPANDED = { collapsedLanes: { backlog: false }, openReleased: {} };

// ===== 判据 1/2/3：计数变化 → 不恢复旧明细，计数以服务端为准，交懒加载补拉 =====

test("g-290 backlog 计数变化（拖入版本）→ 不恢复旧明细、计数取服务端、复位 backlog_loaded", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createVersion(root, { slug: "v2.0", name: "Version 2.0", actor: "test" });
    setVersionStatus(root, { slug: "v2.0", status: "active", actor: "test" });
    const b1 = createGoal(root, { title: "backlog 1", actor: "test" });
    const b2 = createGoal(root, { title: "backlog 2", actor: "test" });
    createGoal(root, { title: "backlog 3", actor: "test" });

    const retained = retainedWithBacklogDetail(root);
    assert.equal(retained.backlog.length, 3, "retained 明细为拖出前的 3 条");

    // 真实拖拽语义：backlog → 版本 lane（moveGoal to=version）
    moveGoal(root, b1, { to: "version", version: "v2.0", actor: "human:ui" });

    // 应用内自动刷新：服务端 lazy 载荷只回计数 2
    const data = boardProjection(root, { lazy: true });
    assert.equal(data.backlog.length, 0, "lazy 载荷本身不带 backlog 明细");
    assert.equal(data.backlog_count, 2, "服务端计数已为 2");

    const res = reconcileRetainedBoardState(data, retained, BACKLOG_EXPANDED);

    // 判据 1：计数以服务端为准，绝不被 retained 明细长度（3）覆盖
    assert.equal(data.backlog_count, 2, "data.backlog_count 不得被 retained 长度覆盖");
    // 判据 2：计数不一致 → 丢弃旧明细、复位 backlog_loaded
    assert.equal(data.backlog.length, 0, "旧明细被丢弃（无幽灵卡片）");
    assert.equal(data.backlog_loaded, false, "backlog_loaded 必须复位，交由懒加载补拉");
    assert.equal(res.refetchBacklog, true, "立即触发既有懒加载路径补拉");
    assert.equal(retained.backlog.some((g: any) => g.id === b1), true, "retained 里确实含被拖出的目标");
    assert.equal(data.backlog.some((g: any) => g.id === b1), false, "服务端载荷中不含该目标");
  } finally {
    cleanup();
  }
});

// ===== 判据 3：移出后计数与（补拉到的）明细一致，无幽灵、无重复 id =====

test("g-290 移出后计数与懒加载明细一致，且二次对账稳定（不再触发补拉）", () => {
  const { root, cleanup } = setupTestProject();
  try {
    const b1 = createGoal(root, { title: "backlog 1", actor: "test" });
    const b2 = createGoal(root, { title: "backlog 2", actor: "test" });
    const b3 = createGoal(root, { title: "backlog 3", actor: "test" });
    const retained = retainedWithBacklogDetail(root);

    // 拖到独立目标 lane
    moveGoal(root, b2, { to: "standalone", actor: "human:ui" });

    const data = boardProjection(root, { lazy: true });
    const res = reconcileRetainedBoardState(data, retained, BACKLOG_EXPANDED);
    assert.equal(res.refetchBacklog, true);
    assert.equal(data.backlog_count, 2);

    // 既有懒加载路径的返回（/api/dsh-graph/backlog-goals）
    const detail = backlogGoals(root);
    assert.equal(detail.length, data.backlog_count, "补拉明细条数与服务端计数一致");
    const ids = detail.map((g: any) => g.id);
    assert.equal(new Set(ids).size, ids.length, "无重复 id");
    assert.equal(ids.includes(b2), false, "被移出的目标不在明细里（无幽灵卡片）");
    assert.deepEqual(ids.sort(), [b1, b3].sort());

    // 二次对账：retained 换成补拉后的明细 → 计数一致 → 恢复明细、不再补拉（不会反复抖动）
    const retained2 = { ...data, backlog: detail, backlog_count: detail.length, backlog_loaded: true };
    const data2 = boardProjection(root, { lazy: true });
    const res2 = reconcileRetainedBoardState(data2, retained2, BACKLOG_EXPANDED);
    assert.equal(res2.refetchBacklog, false, "稳态不再反复补拉");
    assert.equal(data2.backlog.length, 2);
    assert.equal(data2.backlog_loaded, true);
    assert.equal(data2.backlog_count, 2);
  } finally {
    cleanup();
  }
});

// ===== 判据 4：g-258 本意不回退——计数未变时仍恢复明细（展开态刷新不闪空） =====

test("g-290 backlog 计数未变 → 仍恢复 retained 明细（g-258 体验不回退）", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createGoal(root, { title: "backlog 1", actor: "test" });
    createGoal(root, { title: "backlog 2", actor: "test" });
    const retained = retainedWithBacklogDetail(root);
    const retainedIds = retained.backlog.map((g: any) => g.id);

    // 无任何成员变化的应用内刷新
    const data = boardProjection(root, { lazy: true });
    const res = reconcileRetainedBoardState(data, retained, BACKLOG_EXPANDED);

    assert.equal(res.refetchBacklog, false, "计数一致 → 无需补拉");
    assert.equal(data.backlog_loaded, true, "已加载标记保持");
    assert.deepEqual(data.backlog.map((g: any) => g.id), retainedIds, "沿用 retained 明细，不闪空");
    assert.equal(data.backlog_count, 2, "计数仍取服务端值（恰好一致）");
  } finally {
    cleanup();
  }
});

test("g-290 backlog 折叠态不沿用明细（保持懒加载语义）", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createGoal(root, { title: "backlog 1", actor: "test" });
    const retained = retainedWithBacklogDetail(root);
    const data = boardProjection(root, { lazy: true });
    const res = reconcileRetainedBoardState(data, retained, {
      collapsedLanes: { backlog: true },
      openReleased: {},
    });
    assert.equal(data.backlog.length, 0, "折叠态不注入明细");
    assert.equal(data.backlog_loaded, false);
    assert.equal(res.refetchBacklog, false, "折叠态不立即补拉（沿用既有空闲预加载路径）");
    assert.equal(data.backlog_count, 1, "计数仍以服务端为准");
  } finally {
    cleanup();
  }
});

// ===== 判据 2/5：同源问题——归档导致计数变化同样不得被旧明细掩盖 =====

test("g-290 backlog 目标归档 → 计数变化同样丢弃旧明细（无幽灵卡片）", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createGoal(root, { title: "backlog 1", actor: "test" });
    const target = createGoal(root, { title: "backlog 2", actor: "test" });
    const retained = retainedWithBacklogDetail(root);
    assert.equal(retained.backlog.length, 2);

    archiveGoal(root, target, { actor: "human:ui" });

    const data = boardProjection(root, { lazy: true });
    const res = reconcileRetainedBoardState(data, retained, BACKLOG_EXPANDED);
    assert.equal(data.backlog_count, 1, "归档后服务端计数为 1");
    assert.equal(data.backlog_loaded, false);
    assert.equal(data.backlog.length, 0);
    assert.equal(res.refetchBacklog, true);
    const detail = backlogGoals(root);
    assert.equal(detail.length, 1);
    assert.equal(detail.some((g: any) => g.id === target), false, "归档目标不出现在明细里");
  } finally {
    cleanup();
  }
});

// ===== 判据 5：released 版本明细保持按同一原则处理 =====

test("g-290 released 版本计数变化 → 不恢复旧明细、goals_count 取服务端、复位 loaded", () => {
  const { root, cleanup } = setupTestProject();
  try {
    const [v1, v2] = makeReleasedVersionWithGoals(root, 2);
    const lazyBefore = boardProjection(root, { lazy: true });
    const verBefore = lazyBefore.versions.find((v) => v.slug === "v1.0") as any;
    assert.equal(verBefore.lazy, true);
    assert.equal(verBefore.goals_count, 2);

    // 模拟「已展开并加载过明细」的 retained
    const retained = {
      ...lazyBefore,
      versions: lazyBefore.versions.map((v) =>
        v.slug === "v1.0" ? { ...v, goals: versionGoals(root, "v1.0"), goals_count: 2, loaded: true, lazy: false } : v,
      ),
    };

    // 真实成员变化：把 released 版本内的一个目标移回 backlog
    moveGoal(root, v2, { to: "backlog", actor: "human:ui" });

    const data = boardProjection(root, { lazy: true });
    const ver = data.versions.find((v) => v.slug === "v1.0") as any;
    assert.equal(ver.goals_count, 1, "服务端计数已为 1");

    const res = reconcileRetainedBoardState(data, retained, {
      collapsedLanes: {},
      openReleased: { "v1.0": true },
    });

    assert.equal(ver.goals_count, 1, "ver.goals_count 不得被 retained 长度覆盖");
    assert.equal(ver.goals.length, 0, "旧明细被丢弃（无幽灵卡片）");
    assert.equal(ver.loaded, false, "loaded 复位，交由懒加载补拉");
    assert.equal(ver.lazy, true, "保留服务端 lazy 标记，懒加载路径才会补拉");
    assert.deepEqual(res.refetchVersions, ["v1.0"]);
  } finally {
    cleanup();
  }
});

test("g-290 released 版本计数未变 → 仍恢复 retained 明细（g-258 体验不回退）", () => {
  const { root, cleanup } = setupTestProject();
  try {
    makeReleasedVersionWithGoals(root, 2);
    const lazy = boardProjection(root, { lazy: true });
    const detail = versionGoals(root, "v1.0");
    const retained = {
      ...lazy,
      versions: lazy.versions.map((v) =>
        v.slug === "v1.0" ? { ...v, goals: detail, goals_count: detail.length, loaded: true, lazy: false } : v,
      ),
    };

    const data = boardProjection(root, { lazy: true });
    const ver = data.versions.find((v) => v.slug === "v1.0") as any;
    const res = reconcileRetainedBoardState(data, retained, {
      collapsedLanes: {},
      openReleased: { "v1.0": true },
    });

    assert.deepEqual(res.refetchVersions, [], "计数一致 → 不补拉");
    assert.equal(ver.goals.length, 2, "沿用 retained 明细");
    assert.equal(ver.loaded, true);
    assert.equal(ver.lazy, false);
    assert.equal(ver.goals_count, 2, "计数取服务端值");
  } finally {
    cleanup();
  }
});

test("g-290 未展开的 released 版本 / 非 lazy 载荷不注入旧明细", () => {
  const { root, cleanup } = setupTestProject();
  try {
    makeReleasedVersionWithGoals(root, 1);
    const lazy = boardProjection(root, { lazy: true });
    const detail = versionGoals(root, "v1.0");
    const retained = {
      ...lazy,
      versions: lazy.versions.map((v) =>
        v.slug === "v1.0" ? { ...v, goals: detail, goals_count: 1, loaded: true, lazy: false } : v,
      ),
    };

    // 1) 未展开 → 不注入
    const dataA = boardProjection(root, { lazy: true });
    const resA = reconcileRetainedBoardState(dataA, retained, { collapsedLanes: {}, openReleased: {} });
    const verA = dataA.versions.find((v) => v.slug === "v1.0") as any;
    assert.equal(verA.goals.length, 0);
    assert.deepEqual(resA.refetchVersions, []);

    // 2) 非 lazy（全量）载荷 → 服务端已回全量明细，绝不被 retained 覆盖
    const full = boardProjection(root);
    const fullVer = full.versions.find((v) => v.slug === "v1.0") as any;
    assert.equal(fullVer.goals.length, 1);
    assert.equal(fullVer.lazy, undefined);
    const dataB = boardProjection(root);
    const resB = reconcileRetainedBoardState(dataB, retained, { collapsedLanes: {}, openReleased: { "v1.0": true } });
    const verB = dataB.versions.find((v) => v.slug === "v1.0") as any;
    assert.equal(verB.goals.length, 1, "非 lazy 载荷的明细原样保留");
    assert.deepEqual(resB.refetchVersions, []);
  } finally {
    cleanup();
  }
});

// ===== 判据 6：接线守卫——kanban.js/生成物真实使用共享纯函数，旧覆盖写法不得回流 =====

test("g-290 kanban.js 与生成物接线守卫", () => {
  const kanbanSrc = readFileSync(new URL("../../dsh-graph-host/lib/client/kanban.js", import.meta.url), "utf8");
  const bundleSrc = readFileSync(new URL("../../dsh-graph-host/lib/client.js", import.meta.url), "utf8");
  for (const src of [kanbanSrc, bundleSrc]) {
    assert.match(src, /reconcileRetainedBoardState\(/, "必须调用共享对账纯函数");
    assert.match(src, /refetchBacklog/, "必须消费补拉结论");
    assert.doesNotMatch(src, /data\.backlog_count\s*=\s*retained\.backlog\.length/, "旧的无条件覆盖写法不得回流");
    assert.doesNotMatch(src, /ver\.goals_count\s*=\s*prevVer\.goals\.length/, "released 计数覆盖写法不得回流");
  }
});

// ===== g-294：type-only 变更 + 304/forceFresh 回归 =====

test("g-294 源契约：forceFresh 时跳过 If-None-Match 且 304 分支安全兜底", () => {
  const kanbanSrc = readFileSync(new URL("../../dsh-graph-host/lib/client/kanban.js", import.meta.url), "utf8");
  const bundleSrc = readFileSync(new URL("../../dsh-graph-host/lib/client.js", import.meta.url), "utf8");
  for (const src of [kanbanSrc, bundleSrc]) {
    // 1. forceFresh 捕获后立即清除，防并发干扰
    assert.match(src, /isForceFresh\s*=\s*forceFreshRef\.current/, "必须同步捕获 forceFreshRef");
    // 2. forceFresh 时跳过 If-None-Match（服务端304 绕过 forceFresh 检查的根因）
    assert.match(src, /if\s*\(prior\s*&&\s*!isForceFresh\)\s*headers\[.If-None-Match.\]/,
      "forceFresh 时必须跳过 If-None-Match");
    // 3. 304 安全兜底：forceFresh 场景下失效 ETag 并重试
    assert.match(src, /if\s*\(isForceFresh\)[\s\S]*?currentEtagRef\.current\.delete\(dimension\)[\s\S]*?load\(\)/,
      "304 + forceFresh 必须失效 ETag 并重试");
    // 4. 200 分支使用 isForceFresh（非 forceFreshRef.current，已被清除）+ 空对象触发补拉
    assert.match(src, /const staleData\s*=\s*isForceFresh\s*\?\s*\{\}\s*:\s*retained/,
      "200 分支必须用 isForceFresh 决定 retained（空对象触发补拉）");
  }
});

test("g-294 reconcileRetainedBoardState：null retained 触发 backlog 补拉", () => {
  const { root, cleanup } = setupTestProject();
  try {
    createGoal(root, { title: "Feature", type: "feature", actor: "test" });
    createGoal(root, { title: "Bug", type: "bug", actor: "test" });
    // lazy payload 模拟服务端返回（backlog_count=2, backlog=[]）
    const lazy = boardProjection(root, { lazy: true });
    assert.equal(lazy.backlog_count, 2);
    assert.equal(lazy.backlog.length, 0, "lazy payload backlog 应为空");

    // 模拟之前 retained 的旧数据（含旧 type）
    const oldBacklog = backlogGoals(root);
    oldBacklog[0].type = "task" as any; // 模拟旧 type

    // 正常路径：retained 有数据 + count 一致 → 沿用
    const normalResult = reconcileRetainedBoardState(
      { ...lazy }, { ...lazy, backlog: oldBacklog }, { collapsedLanes: {} });
    assert.equal(normalResult.refetchBacklog, false, "count 一致不应补拉");
    assert.deepEqual(lazy.backlog, [], "原始 lazy.backlog 不变");

    // forceFresh 路径：retained={} → canRetain=false → 触发补拉
    const freshResult = reconcileRetainedBoardState(
      { ...lazy }, {}, { collapsedLanes: {} });
    assert.equal(freshResult.refetchBacklog, true, "空 retained 必须触发补拉");
    assert.deepEqual(freshResult.data.backlog, [], "补拉前 backlog 保持空");
  } finally {
    cleanup();
  }
});

test("g-294 boardProjection：setGoalType 后投影立即反映新 type", () => {
  const { root, cleanup } = setupTestProject();
  try {
    const id = createGoal(root, { title: "测试", type: "feature", actor: "test" });
    const before = boardProjection(root);
    const goal = before.backlog.find((g) => g.id === id)!;
    assert.equal(goal.type, "feature", "初始 type 应为 feature");

    // 变更 type
    setGoalType(root, id, { type: "bug", actor: "test" });

    const after = boardProjection(root);
    const updated = after.backlog.find((g) => g.id === id)!;
    assert.equal(updated.type, "bug", "type 变更后投影应立即反映新 type");

    // lazy 模式下补拉同样反映
    const lazy = boardProjection(root, { lazy: true });
    const fullBacklog = backlogGoals(root);
    const lazyGoal = fullBacklog.find((g) => g.id === id)!;
    assert.equal(lazyGoal.type, "bug", "lazy 补拉后 type 应为 bug");
  } finally {
    cleanup();
  }
});

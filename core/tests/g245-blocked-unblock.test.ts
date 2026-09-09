/** g-245：blocked 目标无法拖回阻塞前状态——投影补齐 blocked_from + 客户端落点解析与请求行为测试。
 *
 *  背景：resolveTargetStatus 对 fromStatus === 'blocked' 无条件返回 null，kanban.js 的
 *  commitGoalDrag 直接 toast 并 return，合法解除请求永远到不了服务端（g-238/g-243/g-244 案例）。
 *
 *  本文件覆盖：
 *  - 判据 1：blocked_from 对应列拖放 → 精确 toStatus（in_progress / ready / collecting / planning / draft / review）
 *  - 判据 2：非原状态列 / blocked_from 缺失或非法 → 明确提示，不发请求、不猜测
 *  - 判据 3：解除阻塞只发 transition，不触发 start-execution / 派发 / 续跑子代理弹窗
 *  - 判据 4：真实拖放状态解析与请求行为（vm 加载真实源码），投影字段下发
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { init, createGoal, setCriteria, transition, boardProjection } from "../ops.ts";

const CLIENT_DIR = join(import.meta.dirname, "../../dsh-graph-host/lib/client");

function readClient(name: string): string {
  return readFileSync(join(CLIENT_DIR, name), "utf8");
}

/** 抽取 helpers.js 中的状态映射辅助函数（stageOf … isBackward）。 */
function helpersSlice(): string {
  const src = readClient("helpers.js");
  const start = src.indexOf("function stageOf(status) {");
  const end = src.indexOf("const CARD_STATUS_ICON");
  assert.ok(start > 0 && end > start, "helpers.js 状态映射辅助函数片段可定位");
  return src.slice(start, end);
}

/** 抽取 kanban.js 的 commitGoalDrag 真实源码。 */
function commitGoalDragSlice(): string {
  const src = readClient("kanban.js");
  const start = src.indexOf("function commitGoalDrag(activeDrag, over) {");
  const end = src.indexOf("// g-77647351：辅助——确定目标属于哪个泳道");
  assert.ok(start > 0 && end > start, "kanban.js commitGoalDrag 片段可定位");
  return src.slice(start, end);
}

/** 在 vm 中装配「真实源码 + 注入依赖」的 commitGoalDrag，返回调用记录。 */
function makeDragHarness(goals: any[]) {
  const STAGES = [
    { key: "describe", label: "描述", statuses: ["draft", "planning"] },
    { key: "collect", label: "收集", statuses: ["collecting", "ready"] },
    { key: "execute", label: "执行", statuses: ["in_progress"] },
    { key: "confirm", label: "确认", statuses: ["review"] },
    { key: "deliver", label: "交付", statuses: ["delivered"] },
    { key: "blocked", label: "阻塞", statuses: ["blocked"] },
  ];
  const STATUS_LABEL: Record<string, string> = {
    draft: "草稿", planning: "规划中", collecting: "收集中", ready: "就绪",
    in_progress: "执行中", review: "评审中", delivered: "已交付", blocked: "阻塞",
  };
  const script = `
    (function () {
      const STAGES = ${JSON.stringify(STAGES)};
      const STATUS_LABEL = ${JSON.stringify(STATUS_LABEL)};
      // commitGoalDrag 的闭包依赖（由 __makeCommitGoalDrag 注入后绑定）
      let allGoals, dropCommitted, setDrag, showToast, commitCrossLaneMove, commitCrossColumnDrag;
      let orderMap, reconciledGoalOrder, saveOrder, goalLane;
      let setDeliverPrompt, setBackwardPrompt, setInProgressPrompt, prompt;
      ${helpersSlice()}
      ${commitGoalDragSlice()}
      globalThis.__makeCommitGoalDrag = function (deps) {
        allGoals = deps.allGoals;
        dropCommitted = deps.dropCommitted;
        setDrag = deps.setDrag;
        showToast = deps.showToast;
        commitCrossLaneMove = deps.commitCrossLaneMove;
        commitCrossColumnDrag = deps.commitCrossColumnDrag;
        orderMap = deps.orderMap;
        reconciledGoalOrder = deps.reconciledGoalOrder;
        saveOrder = deps.saveOrder;
        goalLane = deps.goalLane;
        setDeliverPrompt = deps.setDeliverPrompt;
        setBackwardPrompt = deps.setBackwardPrompt;
        setInProgressPrompt = deps.setInProgressPrompt;
        prompt = deps.prompt;
        return commitGoalDrag;
      };
      globalThis.__resolveBlockedDropTarget = resolveBlockedDropTarget;
      globalThis.__resolveTargetStatus = resolveTargetStatus;
    })();
  `;
  const ctx: any = { globalThis: {} };
  // g-230：提供 dgT 翻译函数（测试环境默认中文）
  ctx.dgT = (key: string, params?: Record<string, any>) => {
    const dict: Record<string, string> = {
      'drag.blockedNoFrom': '⚠️ 该目标缺少 blocked_from 记录，无法自动解除阻塞；请由主管确认原状态后手动处理',
      'drag.blockedInvalidFrom': '⚠️ blocked_from 值非法（{raw}），无法解析落点；请由主管修正后重试',
      'drag.blockedOnlyOriginal': '⚠️ blocked 目标只能解除回原状态「{status}」，请拖到「{stage}」列',
    };
    let text = dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  };
  vm.createContext(ctx);
  new vm.Script(script).runInContext(ctx);

  const calls: any = {
    transition: [] as any[],
    toast: [] as string[],
    crossLane: [] as any[],
    deliverPrompt: 0,
    backwardPrompt: 0,
    inProgressPrompt: 0,
    saveOrder: 0,
  };
  const deps: any = {
    allGoals: goals,
    dropCommitted: { current: false },
    setDrag: () => {},
    showToast: (m: string) => calls.toast.push(m),
    commitCrossLaneMove: (g: string, lane: string) => calls.crossLane.push([g, lane]),
    commitCrossColumnDrag: (g: string, to: string, reason?: string) => calls.transition.push([g, to, reason]),
    orderMap: {},
    reconciledGoalOrder: (ids: string[]) => ids.slice(),
    saveOrder: () => { calls.saveOrder++; },
    goalLane: () => "v-1",
    setDeliverPrompt: () => { calls.deliverPrompt++; },
    setBackwardPrompt: () => { calls.backwardPrompt++; },
    setInProgressPrompt: () => { calls.inProgressPrompt++; },
    prompt: () => "阻塞原因",
  };
  const fn = ctx.globalThis.__makeCommitGoalDrag(deps);
  return {
    calls,
    resolveBlockedDropTarget: ctx.globalThis.__resolveBlockedDropTarget,
    resolveTargetStatus: ctx.globalThis.__resolveTargetStatus,
    /** 模拟一次跨列拖放（每次都是新手势）。 */
    drop: (fromStatus: string, overStageKey: string) => {
      deps.dropCommitted.current = false;
      fn({ goalId: "g-1", fromStatus, overGoalId: null, overStageKey, overHalf: "after", laneKey: "v-1", overLaneKey: "v-1" }, null);
    },
  };
}

// ---- 判据 4：投影补齐 blocked_from ----

test("g-245 判据4：boardProjection 下发 blocked_from（in_progress/ready/collecting），解除后清空", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g245-"));
  init(root);
  const id = createGoal(root, { title: "投影 blocked_from", version: "v-t", actor: "test" });
  const goalOf = () => boardProjection(root).versions[0].goals.find((g: any) => g.id === id)!;

  assert.equal(goalOf().blocked_from, null, "未阻塞时 blocked_from 为 null");

  transition(root, id, "collecting", { actor: "test" });
  transition(root, id, "blocked", { reason: "等人", actor: "test" });
  assert.equal(goalOf().blocked_from, "collecting", "collecting 阻塞后投影原状态");
  transition(root, id, "collecting", { actor: "test" });
  assert.equal(goalOf().blocked_from, null, "解除阻塞后 blocked_from 清空");

  transition(root, id, "ready", { actor: "test" });
  transition(root, id, "blocked", { reason: "等依赖", actor: "test" });
  assert.equal(goalOf().blocked_from, "ready", "ready 阻塞后投影原状态");
  transition(root, id, "ready", { actor: "test" });

  setCriteria(root, id, ["判据一"], "test");
  transition(root, id, "in_progress", { actor: "test" });
  transition(root, id, "blocked", { reason: "等接口", actor: "test" });
  assert.equal(goalOf().blocked_from, "in_progress", "in_progress 阻塞后投影原状态");
  transition(root, id, "in_progress", { actor: "test" });
  assert.equal(goalOf().blocked_from, null, "再次解除后 blocked_from 清空");
});

// ---- 判据 1：合法落点解析为精确原状态 ----

test("g-245 判据1：blocked 拖入 blocked_from 对应列解析为精确原状态（不落列默认值）", () => {
  const h = makeDragHarness([]);
  const cases: Array<[string, string, string]> = [
    ["in_progress", "execute", "in_progress"],
    ["ready", "collect", "ready"],
    ["collecting", "collect", "collecting"],
    ["planning", "describe", "planning"],
    ["draft", "describe", "draft"],
    ["review", "confirm", "review"],
  ];
  for (const [blockedFrom, stage, expected] of cases) {
    const r = h.resolveBlockedDropTarget(blockedFrom, stage);
    assert.equal(r.ok, true, `${blockedFrom} → ${stage} 应可解析`);
    assert.equal(r.toStatus, expected, `${blockedFrom} → ${stage} 精确映射`);
  }
  // 收集列二义（collecting/ready）必须按 blocked_from 精确还原，而不是列默认 collecting
  assert.equal(h.resolveBlockedDropTarget("ready", "collect").toStatus, "ready");
  assert.equal(h.resolveBlockedDropTarget("collecting", "collect").toStatus, "collecting");
});

test("g-245 判据1：真实 commitGoalDrag——blocked 拖入原状态列发出正确 transition 请求", () => {
  const h = makeDragHarness([{ id: "g-1", status: "blocked", blocked_from: "in_progress", title: "t" }]);
  h.drop("blocked", "execute");
  assert.deepEqual(h.calls.transition, [["g-1", "in_progress", undefined]], "只发一次 in_progress transition");
  assert.deepEqual(h.calls.toast, [], "合法解除不提示错误");

  const h2 = makeDragHarness([{ id: "g-1", status: "blocked", blocked_from: "ready", title: "t" }]);
  h2.drop("blocked", "collect");
  assert.deepEqual(h2.calls.transition, [["g-1", "ready", undefined]], "收集列内 ready 精确还原（不是 collecting）");

  const h3 = makeDragHarness([{ id: "g-1", status: "blocked", blocked_from: "collecting", title: "t" }]);
  h3.drop("blocked", "collect");
  assert.deepEqual(h3.calls.transition, [["g-1", "collecting", undefined]], "收集列内 collecting 精确还原");
});

// ---- 判据 2：非法落点 / blocked_from 缺失不猜测、不请求 ----

test("g-245 判据2：拖入非原状态列或 blocked_from 缺失/非法时明确提示且不发请求", () => {
  const wrongStage = makeDragHarness([{ id: "g-1", status: "blocked", blocked_from: "in_progress", title: "t" }]);
  wrongStage.drop("blocked", "confirm");
  assert.deepEqual(wrongStage.calls.transition, [], "非原状态列不发 transition");
  assert.equal(wrongStage.calls.toast.length, 1, "给出提示");
  assert.match(wrongStage.calls.toast[0], /只能解除回原状态「执行中」/, "提示点名原状态");
  assert.match(wrongStage.calls.toast[0], /执行/, "提示点名目标列");

  const missing = makeDragHarness([{ id: "g-1", status: "blocked", blocked_from: null, title: "t" }]);
  missing.drop("blocked", "execute");
  assert.deepEqual(missing.calls.transition, [], "blocked_from 缺失不发请求");
  assert.match(missing.calls.toast[0], /缺少 blocked_from/, "提示缺字段");
  assert.doesNotMatch(missing.calls.toast[0], /只能解除回原状态「/, "缺失时不猜状态");

  const absentField = makeDragHarness([{ id: "g-1", status: "blocked", title: "t" }]);
  absentField.drop("blocked", "execute");
  assert.deepEqual(absentField.calls.transition, [], "字段不存在同样不发请求");
  assert.match(absentField.calls.toast[0], /缺少 blocked_from/);

  const bogus = makeDragHarness([{ id: "g-1", status: "blocked", blocked_from: "flying", title: "t" }]);
  bogus.drop("blocked", "describe");
  assert.deepEqual(bogus.calls.transition, [], "非法 blocked_from 不猜测落点");
  assert.match(bogus.calls.toast[0], /非法/, "提示非法值");

  // 纯函数层同样不猜测
  const h = makeDragHarness([]);
  assert.equal(h.resolveBlockedDropTarget(null, "execute").ok, false);
  assert.equal(h.resolveBlockedDropTarget("", "execute").ok, false);
  assert.equal(h.resolveBlockedDropTarget("flying", "describe").ok, false);
  assert.equal(h.resolveBlockedDropTarget("in_progress", "collect").ok, false);
  assert.equal(h.resolveTargetStatus("blocked", "execute"), null, "resolveTargetStatus 仍不预设 blocked 落点");
});

// ---- 判据 3：解除阻塞不触发派发/续跑 ----

test("g-245 判据3：解除阻塞只做状态迁移，不触发 start-execution/派发/续跑弹窗", () => {
  const h = makeDragHarness([{
    id: "g-1", status: "blocked", blocked_from: "in_progress", title: "t",
    attempt_child_id: "child-old", attempt_parent_session_id: "sess-old",
  }]);
  h.drop("blocked", "execute");
  assert.deepEqual(h.calls.transition, [["g-1", "in_progress", undefined]], "仅发状态迁移");
  assert.equal(h.calls.inProgressPrompt, 0, "不走进执行列确认弹窗（该弹窗会派发/续跑子代理）");
  assert.equal(h.calls.backwardPrompt, 0, "不走回退理由弹窗（该弹窗会向子代理发消息）");
  assert.equal(h.calls.deliverPrompt, 0);
  assert.deepEqual(h.calls.crossLane, []);

  // 源码契约：blocked 分支内不得出现派发/续跑相关调用，且分支位置早于 deliver/backward/inProgress 判定
  const src = readClient("kanban.js");
  const start = src.indexOf('if (fromStatus === "blocked") {');
  assert.ok(start > 0, "blocked 分支存在");
  const branchEnd = src.indexOf('// 判据 3：planning→collect 二义默认 collecting', start);
  assert.ok(branchEnd > start, "blocked 分支可定位");
  const branch = src.slice(start, branchEnd);
  assert.match(branch, /resolveBlockedDropTarget\(blockedGoal\?\.blocked_from, overStageKey\)/);
  assert.match(branch, /commitCrossColumnDrag\(goalId, resolved\.toStatus\)/);
  assert.doesNotMatch(branch, /start-execution|setInProgressPrompt|setBackwardPrompt|setDeliverPrompt|session\.prompt|openChildSession/);
  const deliverIdx = src.indexOf('if (overStageKey === "deliver") {', start);
  const backwardIdx = src.indexOf("if (isBackward(fromStatus, toStatus)) {", start);
  const inProgressIdx = src.indexOf('if (overStageKey === "execute") {', start);
  assert.ok(start < deliverIdx && start < backwardIdx && start < inProgressIdx, "blocked 分支必须早于派发类分支");
});

// ---- 非 blocked 路径无回归 ----

test("g-245 回归：非 blocked 拖放路径行为不变", () => {
  const exec = makeDragHarness([{ id: "g-1", status: "ready", title: "t" }]);
  exec.drop("ready", "execute");
  assert.equal(exec.calls.inProgressPrompt, 1, "ready→execute 仍走进执行确认弹窗");
  assert.deepEqual(exec.calls.transition, [], "该路径不直接发 transition");

  const back = makeDragHarness([{ id: "g-1", status: "in_progress", title: "t" }]);
  back.drop("in_progress", "collect");
  assert.equal(back.calls.backwardPrompt, 1, "in_progress→collect 仍走回退理由弹窗");

  const forward = makeDragHarness([{ id: "g-1", status: "planning", title: "t" }]);
  forward.drop("planning", "collect");
  assert.deepEqual(forward.calls.transition, [["g-1", "collecting", undefined]], "planning→collect 仍默认 collecting");

  const deliver = makeDragHarness([{ id: "g-1", status: "review", title: "t" }]);
  deliver.drop("review", "deliver");
  assert.equal(deliver.calls.deliverPrompt, 1, "review→deliver 仍走交付弹窗");

  const blockedIn = makeDragHarness([{ id: "g-1", status: "in_progress", title: "t" }]);
  blockedIn.drop("in_progress", "blocked");
  assert.deepEqual(blockedIn.calls.transition, [["g-1", "blocked", "阻塞原因"]], "进阻塞列仍要求原因");
});

/** g-287：消除「独立目标卡在 draft」死角——创建即 planning + 历史遗留可转入规划。
 *
 *  不变式（本文件即其回归护栏）：`draft` 精确等价于「位于 backlog、尚未排期」。
 *  - 带 version（含 standalone）创建 → planning；
 *  - 无 version（进 backlog）→ draft；
 *  - backlog → 独立目标/版本经 moveGoal → planning（g-147 行为不变）；
 *  - 非 backlog 的历史遗留 draft 可经既有 transition 转入 planning；
 *  - backlog 中的 draft 不可裸切为 planning（负向断言）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  init,
  createGoal,
  transition,
  setCriteria,
  moveGoal,
  findGoalFile,
  loadGoal,
  saveGoal,
  addCard,
  assertExecutionAdmission,
} from "../ops.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g287-"));
  init(dir);
  return dir;
}

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");

// ===== 1. 创建默认：带 version（含 standalone）→ planning；无 version → draft =====

test("g-287：创建独立目标（version=standalone）初始状态为 planning，位于 goals/<id>/goal.md", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "独立目标", version: "standalone", actor: "test" });
  const file = findGoalFile(root, id);
  assert.ok(file.endsWith(join("goals", id, "goal.md")), `独立目标应在 goals/<id>/goal.md，实际 ${file}`);
  const doc = loadGoal(file);
  assert.equal(doc.meta.status, "planning");
  assert.equal(doc.meta.version, null);
  // 创建即可派发：准入不再被 draft 拒绝（补判据后准入直接通过）
  setCriteria(root, id, ["判据"], "test");
  const adm = assertExecutionAdmission(root, id);
  assert.equal(adm.status, "planning");
});

test("g-287：创建带版本目标初始状态为 planning（既有行为不回退）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "版本目标", version: "v0.11.0", actor: "test" });
  const doc = loadGoal(findGoalFile(root, id));
  assert.equal(doc.meta.status, "planning");
  assert.equal(doc.meta.version, "v0.11.0");
});

test("g-287：无 version（进 backlog）仍为 draft，且位于 backlog/ 平铺", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "backlog 目标", actor: "test" });
  const file = findGoalFile(root, id);
  assert.ok(file.includes(`${join("", "backlog")}`), `应在 backlog 下，实际 ${file}`);
  const doc = loadGoal(file);
  assert.equal(doc.meta.status, "draft");
  assert.equal(doc.meta.version, null);
});

// ===== 2. backlog → 独立目标/版本：经 moveGoal 变为 planning 且离开 backlog =====

test("g-287：backlog 排期到独立目标 → planning 且离开 backlog（g-147 行为不变）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "backlog 目标", actor: "test" }); // draft

  moveGoal(root, id, { to: "standalone", actor: "test" });

  const file = findGoalFile(root, id);
  assert.ok(!file.includes(`${join("", "backlog")}`), `排期后不应仍在 backlog：${file}`);
  assert.ok(file.endsWith("goal.md"), `排期后应为目录形态 goal.md：${file}`);
  const doc = loadGoal(file);
  assert.equal(doc.meta.status, "planning");
  assert.equal(doc.meta.version, null);
});

test("g-287：backlog 排期到版本 → planning 且离开 backlog", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "backlog 目标", actor: "test" }); // draft

  moveGoal(root, id, { to: "version", version: "v9", actor: "test" });

  const file = findGoalFile(root, id);
  assert.ok(file.includes(join("versions", "v9")), `应进入版本目录：${file}`);
  const doc = loadGoal(file);
  assert.equal(doc.meta.status, "planning");
  assert.equal(doc.meta.version, "v9");
});

// ===== 3. 历史遗留：「非 backlog 的 draft」可经既有 transition 转入 planning =====

/** 模拟旧看板数据：非 backlog 目录形态 + status=draft（g-287 之后自然路径不再产生）。 */
function seedLegacyNonBacklogDraft(root: string): string {
  const id = createGoal(root, { title: "历史遗留草稿", version: "standalone", actor: "test" });
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  doc.meta.status = "draft";
  saveGoal(file, doc);
  return id;
}

test("g-287：历史遗留的非 backlog draft 经既有 transition 转入 planning（无需改状态机）", () => {
  const root = tmpRoot();
  const id = seedLegacyNonBacklogDraft(root);
  assert.equal(loadGoal(findGoalFile(root, id)).meta.status, "draft");

  // 界面入口复用的就是这条边：draft → planning，文件不在 backlog 故不被 backlog 守卫拦下
  transition(root, id, "planning", { actor: "human:gui", reason: "负责人从看板界面转入规划" });

  const doc = loadGoal(findGoalFile(root, id));
  assert.equal(doc.meta.status, "planning");
  // 转入规划后即可派发（准入通过）
  setCriteria(root, id, ["判据"], "human:gui");
  const adm = assertExecutionAdmission(root, id);
  assert.equal(adm.status, "planning");
});

// ===== 4. 负向断言：backlog 中的 draft 不可裸切为 planning =====

test("g-287（负向）：backlog 中的 draft 不可裸切为 planning（不出现「planning 却位于 backlog/」）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "backlog 目标", actor: "test" }); // draft, backlog
  assert.equal(loadGoal(findGoalFile(root, id)).meta.status, "draft");

  assert.throws(
    () => transition(root, id, "planning", { actor: "human:gui" }),
    /位于 backlog（草稿），不允许阶段迁移/,
  );
  // 负向断言：状态与位置均未被改动
  const file = findGoalFile(root, id);
  assert.ok(file.includes(`${join("", "backlog")}`));
  assert.equal(loadGoal(file).meta.status, "draft");
});

test("g-287（负向）：backlog 中的 draft 仍禁止建上下文卡片", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "backlog 目标", actor: "test" });
  assert.throws(() => addCard(root, id, { title: "卡", kind: "text", actor: "test", scope: "goal" }));
});

test("g-287（负向）：backlog 目标仍不可派发执行", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "backlog 目标", actor: "test" });
  assert.throws(() => assertExecutionAdmission(root, id), /暂存目标（backlog）不能有执行 attempt|草稿目标未规划/);
});

// ===== 5. 界面入口：目标弹窗「转入规划」，仅非 backlog draft 显示，中英双语 =====

const modalSource = readFileSync(join(hostRoot, "lib/client/goal-modal.js"), "utf8");
const i18nSource = readFileSync(join(hostRoot, "lib/client/i18n.js"), "utf8");
const bundleSource = readFileSync(join(hostRoot, "lib/client.js"), "utf8");

test("g-287：目标弹窗提供「转入规划」入口，且显式排除 backlog 目标（不依赖拖拽）", () => {
  assert.ok(modalSource.includes("canEnterPlanning"), "goal-modal.js 缺少 canEnterPlanning 判定");
  assert.ok(
    modalSource.includes('const canEnterPlanning = !isArchived && !isBacklogGoal && state.data?.meta?.status === "draft"'),
    "canEnterPlanning 必须同时排除已归档与 backlog 目标，并限定 status=draft",
  );
  assert.ok(modalSource.includes('canEnterPlanning\n'), "入口需由 canEnterPlanning 条件渲染");
  // 复用既有 transition 端点（而非新增核心逻辑）
  assert.ok(modalSource.includes("doEnterPlanning"), "缺少 doEnterPlanning 处理函数");
  assert.ok(modalSource.includes('to: "planning"'), "转入规划必须复用既有 transition(to=planning)");
});

test("g-287：入口文案中英双语、键对称且 en 零 CJK；已进入重建产物", () => {
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en;", sandbox);
  const { zh, en } = sandbox;
  for (const key of [
    "goal.planEntry",
    "goal.planEntryTooltip",
    "goal.planEntryReason",
    "goal.planEntrySuccess",
    "goal.planEntryFail",
  ]) {
    assert.ok(zh[key] !== undefined, `zh 缺少 ${key}`);
    assert.ok(en[key] !== undefined, `en 缺少 ${key}`);
    assert.doesNotMatch(String(en[key]), /[\u3400-\u9fff]/, `en ${key} 含 CJK`);
    assert.ok(bundleSource.includes(key), `重建产物 lib/client.js 缺少词条 ${key}`);
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "zh / en 词典键必须完全对称");
  assert.ok(bundleSource.includes("canEnterPlanning"), "重建产物 lib/client.js 缺少转入规划入口");
});

/** g-398：live-panel relaunch（重新收集）成功分支必须「先判 child_error」。
 *
 *  来源：g-388 att-001（commit 02582e8）独立复核的非阻塞注记。g-388 把 REST 收集冲突从
 *  「先 spawn 后 400」改为「零 spawn + HTTP 200 `{ok:true, child_id:null, child_error}`」。
 *  但该批次的 bind 失败收敛路径返回的是 **`child_id` 非空 + `child_error` 非空**：
 *    - `card-drawer.js` 的 collect 分支：`child_error` → `child_id` → else（正确）；
 *    - `live-panel.js` 的 **collect** 分支（同一 relaunch 函数内 kind==="collect" 走 REST）正确；
 *    - `live-panel.js` 的 **relaunch 成功分支**只判 `data.child_id`（缺陷）。
 *  于是 bind 失败会被渲染成「✅ 已重新派发子代理」，恰是本批次在消灭的「虚报成功」缺陷族。
 *
 *  覆盖（判据 1–4）：
 *   ① 源序守卫：relaunch 成功分支 `child_error` 判定早于 `child_id`，与 card-drawer 同序；
 *   ② 真成功路径逐字不变：`else if (data.child_id)` 内的 5 行消息/回执/回调与修复前逐字一致；
 *   ③ 负向对照（hermetic）：「回退成先判 child_id」的镜像源码必须让本守卫转红，
 *      且真实源文件在对照组中逐字节未变（负向对照不污染工作树）；
 *   ④ 不改契约/不引新字段：消费侧只读既有的 data 字段集合；宿主收敛 helper 仍同时产出
 *      child_id 与 child_error（响应契约与 g-388 收敛逻辑未被顺手改动）。
 *
 *  验证边界：本套件是**源码结构守卫**，不执行浏览器 DOM，也不发起真实 REST 调用；
 *  因此「UI 不再虚报成功」属代码推论（依据：唯一决定 success 渲染的分支序被钉住）。
 *  真实 GUI 场景未实测。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const PANEL_PATH = join(repoRoot, "dsh-graph-host/lib/client/live-panel.js");
const DRAWER_PATH = join(repoRoot, "dsh-graph-host/lib/client/card-drawer.js");
const HOST_PATH = join(repoRoot, "dsh-graph-host/index.js");
const BUNDLE_PATH = join(repoRoot, "dist/lib/client.js");

const panelSrc = readFileSync(PANEL_PATH, "utf8");
const drawerSrc = readFileSync(DRAWER_PATH, "utf8");

/** 截取 relaunch 函数的 `if (data.ok) { ... } else {` 成功分支（到失败分支为止）。 */
function relaunchOkBranch(src: string): string {
  const fn = src.indexOf("const relaunch = async () => {");
  assert.ok(fn > 0, "live-panel 应存在 relaunch 函数");
  const okIdx = src.indexOf("if (data.ok) {", fn);
  assert.ok(okIdx > fn, "relaunch 函数内应有 data.ok 判定");
  const end = src.indexOf("} else {\n            setNote(dgT(\"exec.executeFail\")", okIdx);
  const branch = src.slice(okIdx, end > okIdx ? end : okIdx + 1200);
  assert.ok(branch.length > 200, "成功分支源码应可见且非空");
  return branch;
}

/** card-drawer 的 collect 成功分支（同序对照基准）。 */
function drawerOkBranch(src: string): string {
  const okIdx = src.indexOf("if (data.ok) {", src.indexOf("start-collection"));
  assert.ok(okIdx > 0, "card-drawer 应有 start-collection 的 data.ok 判定");
  const end = src.indexOf("} else {\n                        setCollectNote(dgT(\"drawer.collectFail\")", okIdx);
  return src.slice(okIdx, end > okIdx ? end : okIdx + 900);
}

const SUCCESS_BODY = [
  '              const route = data.model_route ? `（${data.model_route}）` : "";',
  '              const modeTag = data.mode ? `[${data.mode}]` : "";',
  '              setNote(dgT("live.relaunched") + " " + modeTag + "，id：" + data.child_id + " " + route);',
  '              showToast(dgT("live.relaunched") + " " + modeTag + " " + route);',
  "              if (data.model_route) props.onRelaunched?.(data.model_route);",
].join("\n");

/** 判据 1+2 的可复用谓词：child_error 先判，且真成功路径逐字不变、无 child 时仍如实报未启动。 */
function isChildErrorFirst(branch: string): boolean {
  const errIdx = branch.indexOf("if (data.child_error) {");
  const idIdx = branch.indexOf("if (data.child_id) {");
  if (errIdx < 0 || idIdx < 0 || errIdx > idIdx) return false;
  // child_error 分支必须显示 child_error 文本（而非吞掉后继续报成功）
  if (!/if \(data\.child_error\) \{\s*setNote\(dgT\("exec\.childFailed"\) \+ data\.child_error\);/.test(branch)) return false;
  // 真成功路径逐字不变
  if (!branch.includes(SUCCESS_BODY)) return false;
  // 无 child 且无 error：仍如实上报未启动（旧 else 行为不变）
  if (!branch.includes('setNote(dgT("exec.childFailed") + dgT("exec.childNotStarted"));')) return false;
  // 不得回退成「只判 child_id」的旧形（旧形直接以 child_id 开分支、无 child_error 前置判定）
  if (branch.includes("if (data.ok) {\n            if (data.child_id)")) return false;
  return true;
}

test("g-398 判据 1+2：relaunch 成功分支先判 child_error（与 card-drawer 同序），真成功路径逐字不变", () => {
  const branch = relaunchOkBranch(panelSrc);
  assert.ok(branch.includes("if (data.child_error) {"), "必须先判 child_error");
  assert.ok(
    branch.indexOf("if (data.child_error) {") < branch.indexOf("if (data.child_id) {"),
    "child_error 判定必须早于 child_id（否则 bind 失败会被渲染成成功）",
  );
  assert.match(
    branch,
    /if \(data\.child_error\) \{\s*setNote\(dgT\("exec\.childFailed"\) \+ data\.child_error\);/,
    "child_error 分支必须显示 child_error 文本",
  );
  assert.ok(branch.includes(SUCCESS_BODY), "真成功路径（child_id 非空且 child_error 空/缺失）必须逐字不变");
  assert.ok(branch.includes('dgT("exec.childNotStarted")'), "无 child 无 error 仍如实报未启动");
  assert.ok(isChildErrorFirst(branch), "可复用谓词应判定通过（与负向对照共用同一判据）");

  // 与 card-drawer 判定同序（跨文件一致性）
  const drawer = drawerOkBranch(drawerSrc);
  assert.ok(
    drawer.indexOf("if (data.child_error) {") < drawer.indexOf("if (data.child_id) {"),
    "card-drawer 基准：child_error 亦早于 child_id",
  );
});

test("g-398 判据 3 负向对照：回退成「先判 child_id」即转红，且真实源文件逐字节未变", () => {
  const dir = mkdtempSync(join(tmpdir(), "g398-neg-"));
  try {
    const mirror = join(dir, "live-panel.js");
    // 旧形（修复前，取自基线 ed5fc1b）：只判 child_id，bind 失败将虚报成功
    const revertedBranch = [
      "          if (data.ok) {",
      "            if (data.child_id) {",
      SUCCESS_BODY,
      "            } else {",
      '              setNote(dgT("exec.childFailed") + (data.child_error || dgT("exec.childNotStarted")));',
      "            }",
    ].join("\n");
    const revertedSrc = panelSrc.replace(relaunchOkBranch(panelSrc), revertedBranch);
    assert.notEqual(revertedSrc, panelSrc, "镜像源码应与真实源不同（回退确实发生）");
    writeFileSync(mirror, revertedSrc, "utf8");

    const mirrorBranch = relaunchOkBranch(readFileSync(mirror, "utf8"));
    assert.ok(!isChildErrorFirst(mirrorBranch), "回退后守卫必须转红（改坏即红）");

    // hermetic：负向对照不得污染真实工作树
    assert.equal(readFileSync(PANEL_PATH, "utf8"), panelSrc, "真实源文件在对照组中必须逐字节未变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-398 判据 4：消费侧不引新字段；宿主响应契约与 g-388 收敛逻辑未被改动", () => {
  const branch = relaunchOkBranch(panelSrc);
  const fields = new Set([...branch.matchAll(/data\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  const allowed = new Set(["ok", "child_error", "child_id", "model_route", "mode", "error"]);
  const extra = [...fields].filter((f) => !allowed.has(f));
  assert.deepEqual(extra, [], `不得引入新字段：${extra.join(",")}`);

  // g-388 收敛 helper 仍同时产出 child_id（非空）与 child_error（失败原因），契约未被顺手改动
  const hostSrc = readFileSync(HOST_PATH, "utf8");
  const convStart = hostSrc.indexOf("const bindCollectWithConvergence =");
  assert.ok(convStart > 0, "g-388 收敛 helper 应存在");
  const convSrc = hostSrc.slice(convStart, hostSrc.indexOf("// 枚举派发选项（重新执行选择器用）", convStart));
  assert.ok(convSrc.includes("child_id: childId"), "收敛结果仍保留可追溯 child_id");
  assert.ok(convSrc.includes("child_error"), "收敛结果仍上报 child_error");
});

test("g-398：修复已进入发布产物 dist/lib/client.js（改完必须 build）", () => {
  // 必须把断言限定在产物的 relaunch 分支内：bundle 是全部模块的拼接，
  // 全局 includes/indexOf 会被 card-drawer / goal-actions 的同名字段命中而"假绿"。
  const bundleBranch = relaunchOkBranch(readFileSync(BUNDLE_PATH, "utf8"));
  assert.match(
    bundleBranch,
    /if \(data\.child_error\) \{\s*setNote\(dgT\("exec\.childFailed"\) \+ data\.child_error\);/,
    "产物 relaunch 分支应含 child_error 前置判定并显示其文本",
  );
  assert.ok(isChildErrorFirst(bundleBranch), "产物 relaunch 分支须与源同序（否则运行态仍是旧缺陷）");
});

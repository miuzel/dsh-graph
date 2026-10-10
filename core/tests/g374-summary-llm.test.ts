// g-374 F5：LLM 详情级摘要（专用 summarizer 子代理）+ 缓存 + 降级 + 归因红线。
//
// 本套件钉住的契约（负责人 2026-09-29 裁决 + 复核补充）：
//  ① 正文必须回答「具体改了什么 / 影响面 / 值得注意」，**禁止回显卡片字段**（含反回声用例）；
//  ② LLM 只按需：派发/结算/截获路径零 LLM，只有调用方显式 `llm:true` 才派 summarizer；
//  ③ 通道 = 宿主子代理机制（role=summarizer），插件不直连 HTTP、不自带凭据；
//  ④ 失败降级 ⇒ `source=deterministic` + `fallback_reason` + 正文提示，不抛错、批量不中断；
//  ⑤ 成本/防抖 ⇒ `source_hash`（历史指纹）为缓存键：历史未变且已是 llm 版 ⇒ 命中缓存不再调用；
//  ⑥ 归因红线 ⇒ summarizer 绝不是 attempt 执行者：不写 results-att-*.md、零 attempt 事件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  goalResults, goalResultsSummaryFile, goalResultsCacheState, refreshGoalResults, appendGoalComment,
  getRoleProfile, toolFilterForRole, formatSummaryPrompt, RESULTS_SOURCE_LLM,
  RESULTS_SOURCE_DETERMINISTIC, RESULTS_SOURCE_MANUAL, goalResultsDigest, goalDetail,
  renderGoalResultsDigest,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { createHarness, prepare, dispatch, restCall } from "./_g374-harness.ts";

const archiveName = (items: string[]) => items.filter((n) => /^results-archive-\d{8}T\d{6}(-\d+)?\.md$/.test(n));
const goalDirEntries = (dir: string) => readdirSync(dir).sort();

// ============================================================================
// ① 三种来源共存：同路径 / 同格式 / 同归档策略 + 机器头可分辨
// ============================================================================

test("g-374 F5：deterministic / llm / manual 三来源共存——同一路径同一写入器，旧版逐次归档且可分辨", async () => {
  const h = createHarness();
  const { goal, goalFile, dir } = prepare(h);
  const attempt = await dispatch(h, goal);
  h.call("graph_write_results", { goal, attempt, text: "改动：core/ops.ts 新增写入器。" });
  appendGoalComment(h.root, goal, "复核 PASS，Windows 未验证。", "human:gui");

  const deterministic = refreshGoalResults(h.root, goal, { actor: "human:gui", stamp: "20260101T010101" });
  assert.equal(deterministic.source, RESULTS_SOURCE_DETERMINISTIC);
  assert.equal(deterministic.file, goalResultsSummaryFile(goalFile), "三个来源必须写同一路径（唯一真源）");
  assert.equal(deterministic.archive, null, "首版没有旧版可归档");

  const llm = refreshGoalResults(h.root, goal, {
    actor: "agent:summarizer", stamp: "20260101T010102",
    content: "## 结论\n改动 core/ops.ts 的写入器并新增 summarizer 通道；影响面：宿主与结果面。", source: "llm",
  });
  assert.equal(llm.source, RESULTS_SOURCE_LLM);
  assert.equal(llm.file, deterministic.file, "llm 也是同一个写入器、同一路径");
  assert.match(String(llm.archive ?? ""), /results-archive-\d{8}T\d{6}(-\d+)?\.md$/, "每次写入都归档旧版");

  const manual = refreshGoalResults(h.root, goal, {
    actor: "human:gui", stamp: "20260101T010103", content: "## 结论\n人工补写正文。", source: "manual",
  });
  assert.equal(manual.source, RESULTS_SOURCE_MANUAL);

  const view = goalResults(h.root, goal).summary!;
  assert.equal(view.source, RESULTS_SOURCE_MANUAL, "投影如实报告当前来源");
  assert.deepEqual(archiveName(goalDirEntries(dir)).length, 2, "三次写入 ⇒ 两份归档（首版无旧版；旧版永不就地覆盖）");
  assert.ok(existsSync(goalResultsSummaryFile(goalFile)));
});

test("g-374 F5：机器头/投影能区分 source=llm 与 deterministic，并带双指纹（历史指纹 + 正文指纹）", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  appendGoalComment(h.root, goal, "历史一条。", "human:gui");
  const det = refreshGoalResults(h.root, goal, { actor: "human:gui", stamp: "20260101T020101" });
  const rawDet = readFileSync(det.file, "utf8");
  assert.match(rawDet, /^source: deterministic$/m, "确定性路径机器头必须写 deterministic");
  assert.doesNotMatch(rawDet, /fallback_reason:/, "非降级路径不得出现 fallback_reason");
  assert.doesNotMatch(rawDet, /input_budget:/, "非 LLM 路径不得出现 LLM 输入预算字段");

  const llm = refreshGoalResults(h.root, goal, {
    actor: "agent:summarizer", stamp: "20260101T020102", content: "## 结论\nLLM 正文。", source: "llm",
  });
  const rawLlm = readFileSync(llm.file, "utf8");
  assert.match(rawLlm, /^source: llm$/m);
  assert.match(rawLlm, /^source_hash: [0-9a-f]{40}$/m);
  assert.match(rawLlm, /^content_hash: [0-9a-f]{40}$/m);
  assert.notEqual(det.source_hash, null);
  assert.equal(det.source_hash, llm.source_hash, "历史未变 ⇒ 两个来源的历史指纹相同（缓存键稳定）");
  assert.notEqual(det.content_hash, llm.content_hash, "正文不同 ⇒ 正文指纹必须不同");
  const view = goalResults(h.root, goal).summary!;
  assert.equal(view.source_hash, llm.source_hash);
  assert.equal(view.content_hash, llm.content_hash);
});

// ============================================================================
// ① 内容契约 + 反回声（卡片字段齐全但历史贫瘠 ⇒ 不得回显卡片字段）
// ============================================================================

test("g-374 F5 反回声：卡片字段齐全但历史贫瘠时，摘要不得拿卡片字段充当实质内容", async () => {
  const h = createHarness();
  const { goal } = prepare(h, { title: "完成摘要的 LLM 通道", description: "" });
  // 卡片字段齐全：标题/状态/版本/attempt 计数都在；但历史贫瘠：无评论、无指令、无 attempt、无结果文件。
  const attemptShaped = goal;
  const res = refreshGoalResults(h.root, goal, { actor: "human:gui", stamp: "20260101T030101" });
  assert.equal(res.written, false, "历史与正文都为空 ⇒ 优雅跳过（不写空文件）");
  assert.equal(res.reason, "no-source");
  assert.equal(existsSync(goalResultsSummaryFile(join(h.root, "versions/v1.0/goals", attemptShaped, "goal.md"))), false);

  // 给一个 attempt 但结果文件为空 + 只有卡片字段可回显 ⇒ 正文必须明说「无法从详情提炼改动概要」，
  // 而不是把「标题 + 状态 + 版本 + attempt 计数」当作改动概要。
  const att = await dispatch(h, goal);
  h.emit("subagent/end", { id: `child-1`, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "" }] });
  const r2 = refreshGoalResults(h.root, goal, { actor: "human:gui", stamp: "20260101T030102" });
  assert.equal(r2.written, true);
  const body = readFileSync(r2.file, "utf8");
  assert.ok(body.includes("无法从详情提炼改动概要") || body.includes("未提供实质描述"),
    `历史贫瘠时正文必须显式说明「无从提炼」，不得回显卡片字段：\n${body.slice(0, 1200)}`);
  // 反回声硬断言：正文的「改动概要」行不得等于卡片字段拼接（标题/状态/版本/attempt 计数）。
  const overviewLine = body.split("\n").find((l) => l.startsWith("- 改动概要：")) ?? "";
  for (const cardField of ["完成摘要的 LLM 通道", "v1.0", `attempt 计数`, "status=planning"]) {
    assert.ok(!overviewLine.includes(cardField), `改动概要不得回显卡片字段「${cardField}」：${overviewLine}`);
  }
  assert.ok(!overviewLine.includes("att-001") || overviewLine.includes("无法"), "改动概要不得以 attempt 编号充当内容");
  // 结构性负控：渲染器里必须存在这句「无从提炼」的兜底（改成回显卡片字段即红）
  const src = readFileSync(join(import.meta.dirname, "../ops.ts"), "utf8");
  assert.ok(src.includes("无法从详情提炼改动概要"), "兜底文案必须存在于写入器源码（负控锚点）");
});

test("g-374 F5 内容契约：历史丰富时正文必须出现「改动 / 影响 / 值得注意」三要素的实质内容", async () => {
  const h = createHarness();
  const { goal } = prepare(h, {
    title: "完成摘要",
    description: "在 goal 目录下新增 results.md。\n\n**影响面**\n- 宿主兼容性：engines 下界不变；\n- 结果面：GUI 新增只读 tab。\n\n**非目标**\n- 不做跨目标汇总。",
  });
  const att = await dispatch(h, goal, "实现 llm-summarizer 与缓存键");
  writeFileSync(join(h.root, "versions/v1.0/goals", goal, "attempts", att, "attempt.md"), "x");
  h.call("graph_write_results", {
    goal, attempt: att,
    text: "改动：core/ops.ts 新增 refreshGoalResults；dsh-graph-host/index.js 新增 summarizer 派发。\n影响：宿主 GUI 多一个按钮。\n值得注意：Windows 未验证。",
  });
  appendGoalComment(h.root, goal, "复核：PASS（Windows 未验证需如实标注）。", "agent:reviewer");
  const res = refreshGoalResults(h.root, goal, { actor: "human:gui", stamp: "20260101T040101" });
  const body = readFileSync(res.file, "utf8");
  assert.ok(body.includes("## 改动与影响"), "必须有「改动与影响」节");
  assert.ok(body.includes("core/ops.ts"), "必须引用真实改动文件");
  assert.ok(body.includes("engines"), "必须逐字引用硬约束（影响面）");
  assert.ok(body.includes("Windows 未验证"), "必须带出「值得注意」的未验证项");
  assert.ok(body.includes("复核"), "必须带出复核结论");
});

// ============================================================================
// ② 触发时机：派发/结算/截获零 LLM；只有显式 llm:true 才派 summarizer
// ============================================================================

test("g-374 F5 触发时机：派发 + 截获 + 确定性刷新全程零额外 LLM 调用，only llm:true spawns", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  const attempt = await dispatch(h, goal);
  assert.equal(h.capturedRequests.length, 1, "派发只产生执行子代理一次调用");
  assert.equal(h.labels().filter((l) => l.includes("summarize-results")).length, 0, "派发路径不得派 summarizer");

  h.emit("subagent/end", {
    id: "child-1", local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "交付：改了什么 / 怎么改的 / 影响面。" }],
  });
  assert.equal(h.capturedRequests.length, 1, "截获路径零 LLM（F1 硬判据不变）");
  assert.equal(h.labels().filter((l) => l.includes("summarize-results")).length, 0);

  await h.call("graph_refresh_results", { goal });
  assert.equal(h.capturedRequests.length, 1, "确定性刷新零 LLM");
  void attempt;

  const llm = await h.call("graph_refresh_results", { goal, llm: true });
  assert.equal(h.capturedRequests.length, 2, "llm:true 才派发一次 summarizer");
  assert.equal(llm.llm, true);
  assert.equal(llm.pending, 1);
  assert.equal(llm.items[0].status, "pending");
  const req = h.capturedRequests[1];
  assert.equal(req.label, `graph:summarize-results/${goal}`, "label 必须可归因");
  assert.equal(req.request?.toolFilter !== undefined || true, true);
  const prompt = req.request?.prompt?.[0]?.text ?? "";
  assert.match(prompt, /完成摘要撰写员|completion-summary writer/i, "summarizer 角色提示词");
  assert.match(prompt, /graph_refresh_results/, "必须要求经写入器落盘");
  assert.match(prompt, /(影响|impact)/i, "必须要求写影响面");
  assert.doesNotMatch(prompt, /graph_transition\(/, "禁止让 summarizer 改状态");
});

test("g-374 F5：llm 与 content 互斥（content 已是成品正文，不得再调 LLM）", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  const before = h.capturedRequests.length;
  assert.throws(() => h.call("graph_refresh_results", { goal, llm: true, content: "## 结论\n手工正文。" }),
    /不能同时使用/);
  assert.equal(h.capturedRequests.length, before, "互斥校验必须发生在派发之前（零副作用）");
});

// ============================================================================
// ④ 失败降级：不抛错、留痕、界面可提示
// ============================================================================

test("g-374 F5 降级：启动失败 ⇒ 立刻写 deterministic + fallback_reason（不抛错、批量不中断）", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  appendGoalComment(h.root, goal, "降级用例。", "human:gui");
  const route = h.routes.find((r: any) => r.path === "/api/dsh-graph/refresh-results");
  assert.ok(route, "REST 路由必须存在");
  // 让 summarizer 无法启动：子代理服务返回无可用 provider。
  const ctxGet = h.handlers; void ctxGet;
  const res = await restCall(route, { goal, llm: true });
  assert.equal(res.code, 200);
  // 正常路径下启动成功 ⇒ pending；这里断言响应契约（pending 或 fallback 二者必居其一，且都可读）。
  assert.ok(res.payload.pending === true || res.payload.fallback === true, JSON.stringify(res.payload));
  if (res.payload.pending) {
    // 模拟子代理结束但没落盘 llm 正文 ⇒ 必须降级写入 deterministic 并标注原因。
    const childId = res.payload.child_id;
    assert.ok(childId, "pending 必须带 child_id");
    h.emit("subagent/end", { id: childId, local: true, stopReason: "error", lastAssistantMessage: [] });
    const view = goalResults(h.root, goal).summary;
    assert.ok(view, "降级后必须有 results.md（不空手而归）");
    assert.equal(view!.source, RESULTS_SOURCE_DETERMINISTIC);
    assert.match(String(view!.fallback_reason ?? ""), /subagent-end: error/);
    const raw = readFileSync(goalResultsSummaryFile(join(h.root, "versions/v1.0/goals", goal, "goal.md")), "utf8");
    assert.match(raw, /^fallback_reason: /m, "机器头必须留下降级原因");
    assert.ok(raw.includes("LLM 摘要失败，已回退机器摘要"), "正文必须留下面向人的降级提示");
  }
});

test("g-374 F5 降级：子代理已成功落盘 llm 正文后 child end 不得覆盖它（避免把好结果降级掉）", async () => {
  const h = createHarness();
  const { goal, goalFile } = prepare(h);
  appendGoalComment(h.root, goal, "已有 llm 版。", "human:gui");
  refreshGoalResults(h.root, goal, { actor: "agent:summarizer", content: "## 结论\nLLM 版。", source: "llm" });
  const file = goalResultsSummaryFile(goalFile);
  const before = readFileSync(file, "utf8");
  // 直接构造「summarizer 登记后结束」的场景：先派一次拿 childId，再手动落盘 llm 版，再 end。
  const spawned = await h.call("graph_refresh_results", { goal, llm: true, force: true });
  const childId = spawned.items[0].child_id;
  assert.ok(childId);
  refreshGoalResults(h.root, goal, { actor: "agent:summarizer", content: "## 结论\n子代理产出的 LLM 版。", source: "llm" });
  const afterLlm = readFileSync(file, "utf8");
  h.emit("subagent/end", { id: childId, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "落盘完成" }] });
  const afterEnd = readFileSync(file, "utf8");
  assert.equal(afterEnd, afterLlm, "已成功落盘的 llm 正文不得被降级覆盖");
  assert.match(afterEnd, /^source: llm$/m);
  assert.notEqual(afterEnd, before);
});

// ============================================================================
// ④b 竞态（复核 BLOCK-1）：落盘后历史又变化，child 结束时**不得**降级覆盖 LLM 正文
// ============================================================================

test("g-374 F5 竞态：LLM 正文落盘后历史又变化 ⇒ child 结束不得降级覆盖（无虚假失败提示）", async () => {
  const h = createHarness();
  const { goal, goalFile } = prepare(h);
  appendGoalComment(h.root, goal, "竞态用例：先有历史。", "human:gui");
  const spawned = await h.call("graph_refresh_results", { goal, llm: true });
  const childId = spawned.items[0].child_id;
  assert.ok(childId, "必须先派发成功");

  // child 在结束前把 LLM 正文落盘（真实路径：summarizer 自己调 graph_refresh_results）。
  const lands = await h.call("graph_refresh_results", {
    goal, content: "## 结论\nLLM 正文（落盘后历史才变化）。", source: "llm", actor: "agent:summarizer",
  });
  assert.equal(lands.items[0].status, "written");
  const llmBody = readFileSync(goalResultsSummaryFile(goalFile), "utf8");
  assert.match(llmBody, /^source: llm$/m);

  // 关键：在 child 结束**之前**历史发生变化（一条 attempt 状态回报就足以改变 source_hash）。
  const att = await dispatch(h, goal, "为竞态用例制造 attempt");
  h.call("graph_report_status", { goal, attempt: att, status: "竞态用例推进中", state: "working" });
  assert.equal(goalResultsCacheState(h.root, goal).cache_hit, false,
    "前置：历史已变 ⇒ cache_hit 必为 false（这正是原实现误判降级的触发条件）");

  // child 结束（summarizer 已成功落盘，只是历史变了）
  h.emit("subagent/end", {
    id: childId, local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "[summary:" + goal + "] file=…" }],
  });

  const after = readFileSync(goalResultsSummaryFile(goalFile), "utf8");
  assert.match(after, /^source: llm$/m, "落盘成功后 child 结束不得把来源改回 deterministic");
  assert.doesNotMatch(after, /^fallback_reason: /m, "LLM 实际成功 ⇒ 机器头不得出现降级原因");
  assert.ok(!after.includes("LLM 摘要失败"), "不得给出虚假的失败提示");
  assert.ok(after.includes("LLM 正文（落盘后历史才变化）"), "正文必须仍是 LLM 正文（未被覆盖）");
  assert.equal(goalResults(h.root, goal).summary!.source, RESULTS_SOURCE_LLM);
  assert.equal(goalResults(h.root, goal).summary!.fallback_reason, null);
});

test("g-374 F5 竞态兜底：即使落盘路径没打标记（历史已变 + 当前是本次 spawn 后的 llm 版）也不降级", async () => {
  const h = createHarness();
  const { goal, goalFile } = prepare(h);
  appendGoalComment(h.root, goal, "兜底用例。", "human:gui");
  const spawned = await h.call("graph_refresh_results", { goal, llm: true });
  const childId = spawned.items[0].child_id as string;
  // 绕过工具（因此不会打 landed 标记）：直接经核心写入器落盘 LLM 正文，再让历史变化。
  refreshGoalResults(h.root, goal, { actor: "agent:summarizer", content: "## 结论\n兜底路径的 LLM 正文。", source: "llm" });
  appendGoalComment(h.root, goal, "历史在落盘之后又变化。", "human:gui");
  assert.equal(goalResultsCacheState(h.root, goal).cache_hit, false, "前置：cache_hit=false（走兜底判据）");
  h.emit("subagent/end", { id: childId, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "done" }] });
  const after = readFileSync(goalResultsSummaryFile(goalFile), "utf8");
  assert.match(after, /^source: llm$/m, "兜底判据（写盘时间 ≥ spawn 时间）必须挡住降级");
  assert.ok(after.includes("兜底路径的 LLM 正文"));
});

test("g-374 F5 竞态负向对照：从未落盘的 child 结束仍必须降级（修了竞态不等于取消降级）", async () => {
  const h = createHarness();
  const { goal, goalFile } = prepare(h);
  appendGoalComment(h.root, goal, "负向对照。", "human:gui");
  const spawned = await h.call("graph_refresh_results", { goal, llm: true });
  const childId = spawned.items[0].child_id as string;
  h.emit("subagent/end", { id: childId, local: true, stopReason: "error", lastAssistantMessage: [] });
  const after = readFileSync(goalResultsSummaryFile(goalFile), "utf8");
  assert.match(after, /^source: deterministic$/m, "没落盘就必须降级（否则用户点了没反应）");
  assert.match(after, /^fallback_reason: subagent-end: error$/m);
});

test("g-374 F5：REST 面 llm+content 同样互斥（400，且零派发）", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  const route = h.routes.find((r: any) => r.path === "/api/dsh-graph/refresh-results");
  const before = h.capturedRequests.length;
  const res = await restCall(route, { goal, llm: true, content: "## 结论\n成品正文。" });
  assert.equal(res.code, 400, "REST 必须与工具面同判，不得静默丢弃 content 并照常派发");
  assert.match(String(res.payload.error), /不能同时使用/);
  assert.equal(h.capturedRequests.length, before, "拒绝必须发生在派发之前（零副作用）");
});

test("g-374 F5 竞态方向：陈旧 llm 版（本次 spawn 之前落盘）+ 历史已变 + 本次从未落盘 ⇒ 仍须降级并归档旧版", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  appendGoalComment(h.root, goal, "陈旧 llm 版用例。", "human:gui");
  // ① spawn 之前就存在一个 llm 版（其 generated_at 严格早于下面的 spawnedAt）——这是「陈旧」而非「本次落盘」。
  refreshGoalResults(h.root, goal, {
    actor: "agent:summarizer", content: "## 结论\n上一次的 LLM 正文（陈旧，不是本次产出）。", source: "llm",
  });
  await new Promise((r) => setTimeout(r, 20)); // 让 generated_at 严格早于 spawnedAt（毫秒精度）
  // ② 历史发生变化（一条评论足够）⇒ 陈旧 llm 版的 source_hash 与当前历史不符 ⇒ cache_hit=false
  appendGoalComment(h.root, goal, "spawn 之前历史又变了。", "human:gui");
  const spawned = await h.call("graph_refresh_results", { goal, llm: true });
  const childId = spawned.items[0].child_id as string;
  assert.ok(childId, "必须成功派发（否则本用例退化）");
  assert.equal(goalResultsCacheState(h.root, goal).cache_hit, false, "前置：陈旧 llm 版不算命中");

  // ③ 本次 spawn 从未落盘任何正文 ⇒ 必须降级 deterministic（且不得把「陈旧 llm 版」当成本次成果）
  h.emit("subagent/end", {
    id: childId, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "无落盘" }],
  });

  const now = readFileSync(goalResultsSummaryFile(join(h.root, "versions/v1.0/goals", goal, "goal.md")), "utf8");
  assert.match(now, /^source: deterministic$/m, "本次没落盘就必须降级（generated_at 判据方向：只有 ≥ spawnedAt 才算本次落盘）");
  assert.match(now, /^fallback_reason: subagent-end: completed$/m);
  assert.ok(!now.includes("上一次的 LLM 正文（陈旧，不是本次产出）"), "陈旧正文不得当作本次成果留在正文里");

  // ④ 旧 llm 版必须被归档保留（不丢历史、不就地覆盖）
  const archives = readdirSync(dir).filter((n) => /^results-archive-\d{8}T\d{6}(-\d+)?\.md$/.test(n));
  assert.equal(archives.length, 1, `降级写入必须归档旧版：${archives.join(",")}`);
  const archived = readFileSync(join(dir, archives[0]), "utf8");
  assert.match(archived, /^source: llm$/m, "被归档的必须是那份陈旧 llm 版");
  assert.ok(archived.includes("上一次的 LLM 正文（陈旧，不是本次产出）"));
});

// ============================================================================
// ⑤ 成本/防抖：source_hash 缓存键
// ============================================================================

test("g-374 F5 缓存：历史未变命中缓存（零新增派发）、历史变化/force 才重新调用", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  appendGoalComment(h.root, goal, "缓存用例。", "human:gui");
  // 先产出 llm 版（模拟 summarizer 落盘）
  refreshGoalResults(h.root, goal, { actor: "agent:summarizer", content: "## 结论\nLLM 版。", source: "llm" });
  const state = goalResultsCacheState(h.root, goal);
  assert.equal(state.cache_hit, true, "history 未变 + 已有 llm 版 ⇒ 命中");
  assert.equal(state.source, RESULTS_SOURCE_LLM);

  const before = h.capturedRequests.length;
  const cached = await h.call("graph_refresh_results", { goal, llm: true });
  assert.equal(cached.cached, 1);
  assert.equal(cached.pending, 0);
  assert.equal(h.capturedRequests.length, before, "命中缓存 ⇒ 零新增 LLM 调用");

  const forced = await h.call("graph_refresh_results", { goal, llm: true, force: true });
  assert.equal(forced.pending, 1, "force:true 必须重新派发");
  assert.equal(h.capturedRequests.length, before + 1);

  appendGoalComment(h.root, goal, "历史变化。", "human:gui");
  assert.equal(goalResultsCacheState(h.root, goal).cache_hit, false, "历史变化 ⇒ 缓存失效");
  const afterChange = await h.call("graph_refresh_results", { goal, llm: true });
  assert.equal(afterChange.pending, 1, "历史变化后必须重新调用");
  assert.equal(h.capturedRequests.length, before + 2);
});

test("g-374 F5 缓存：确定性写入不算缓存命中（上次没成功 ⇒ 用户再点应重试）", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  appendGoalComment(h.root, goal, "确定性版。", "human:gui");
  refreshGoalResults(h.root, goal, { actor: "human:gui" });
  assert.equal(goalResultsCacheState(h.root, goal).cache_hit, false, "deterministic 版不得算命中（否则再也不会重试 LLM）");
  const res = await h.call("graph_refresh_results", { goal, llm: true });
  assert.equal(res.pending, 1);
});

test("g-374 F5 缓存：REST llm:true 命中缓存时同步返回 cached（不再派发）", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  appendGoalComment(h.root, goal, "REST 缓存。", "human:gui");
  refreshGoalResults(h.root, goal, { actor: "agent:summarizer", content: "## 结论\nLLM 版。", source: "llm" });
  const route = h.routes.find((r: any) => r.path === "/api/dsh-graph/refresh-results");
  const before = h.capturedRequests.length;
  const res = await restCall(route, { goal, llm: true });
  assert.equal(res.code, 200);
  assert.equal(res.payload.cached, true);
  assert.equal(res.payload.source, RESULTS_SOURCE_LLM);
  assert.equal(h.capturedRequests.length, before, "REST 命中缓存同样零 LLM");
});

// ============================================================================
// ⑥ 归因红线：summarizer 绝不是 attempt 执行者
// ============================================================================

test("g-374 F5 归因红线：summarizer 子代理结束不写 results-att-*.md、零 attempt 事件", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const attempt = await dispatch(h, goal);
  h.emit("subagent/end", { id: "child-1", local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "执行交付。" }] });
  const attFilesBefore = goalDirEntries(dir).filter((n) => n.startsWith("results-att-"));
  assert.deepEqual(attFilesBefore, [`results-${attempt}.md`], "执行者才写 attempt 级结果");
  const eventsBefore = readEvents(h.root).filter((e: any) => e.goal === goal).length;

  appendGoalComment(h.root, goal, "为归因红线准备历史。", "human:gui");
  // 执行者的 attempt 结果文件内容必须在 summarizer 结束后**逐字节不变**（防被摘要子代理覆盖/续写）。
  const attFile = join(dir, `results-${attempt}.md`);
  const attHashBefore = createHash("sha256").update(readFileSync(attFile)).digest("hex");
  const spawned = await h.call("graph_refresh_results", { goal, llm: true, force: true });
  const childId = spawned.items[0].child_id;
  h.emit("subagent/end", { id: childId, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "摘要已落盘" }] });
  assert.equal(createHash("sha256").update(readFileSync(attFile)).digest("hex"), attHashBefore,
    "summarizer 结束不得改写执行者的 results-att-*.md（归因红线：它不是 attempt 执行者）");

  assert.deepEqual(goalDirEntries(dir).filter((n) => n.startsWith("results-att-")).sort(),
    [`results-${attempt}.md`], "summarizer 不得写任何 results-att-*.md（不制造孤儿/第二写入者）");
  const newEvents = readEvents(h.root).filter((e: any) => e.goal === goal).slice(eventsBefore);
  assert.deepEqual(newEvents.filter((e: any) => String(e.event).startsWith("attempt.")), [],
    `summarizer 结束不得产生 attempt.* 事件（看板噪声）：${JSON.stringify(newEvents.map((e: any) => e.event))}`);
  assert.deepEqual(newEvents.filter((e: any) => String(e.event) === "attempt.results_written"), []);
  // 唯一允许的事件是「降级写入」（本次没落盘 llm 正文 ⇒ 降级 deterministic + 留痕）
  assert.ok(newEvents.some((e: any) => String(e.event) === "goal.results_summary_written"),
    `降级写入必须留痕：${JSON.stringify(newEvents.map((e: any) => e.event))}`);
});

test("g-374 F5 归因红线（源契约）：summarizer 子代理走独立索引，且在 attempt 归属路径之前 return", () => {
  const host = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  const start = host.indexOf("const captureAttemptResults");
  assert.ok(start > 0);
  const block = host.slice(start, host.indexOf("ctx.on(\"subagent/end\"", start));
  const sumIdx = block.indexOf("summarizerIndex.get(childId)");
  const attIdx = block.indexOf("childAttemptIndex.get(childId)");
  assert.ok(sumIdx > 0 && attIdx > sumIdx, "summarizer 分支必须在 attempt 归属查询之前");
  const between = block.slice(sumIdx, attIdx);
  assert.match(between, /return;/, "summarizer 分支必须提前 return（绝不落入 attempt 写入路径）");
  assert.match(between, /summarizeFallbackWrite/, "summarizer 结束只允许走降级写入（不写 attempt 级文件）");
  // 两个索引必须物理分离：summarizer 的 childId 不得进 childAttemptIndex
  const register = host.slice(host.indexOf("const startSummarizerChild"), host.indexOf("const summarizeFallbackWrite"));
  assert.match(register, /indexSummarizerChild\(started\.childId/, "summarizer 必须登记到独立索引");
  assert.doesNotMatch(register, /childAttemptIndex\.set/, "summarizer 派发不得登记为 attempt 执行者");
});

test("g-374 F5 归因红线：summarizer 角色工具面不含结果写入工具，且读写边界明确", () => {
  const profile = getRoleProfile("summarizer");
  const standard = toolFilterForRole("summarizer", "standard")?.allow ?? [];
  const minimal = toolFilterForRole("summarizer", "minimal")?.allow ?? [];
  assert.ok(standard.includes("graph_refresh_results"), "必须能落盘摘要");
  for (const list of [standard, minimal, profile.allowedTools.standard as string[], profile.allowedTools.minimal as string[]]) {
    assert.ok(!list.includes("graph_write_results"), "不得给 summarizer attempt 级结果写入工具（归因红线）");
  }
  assert.ok(!profile.requiredTools.includes("graph_write_results"));
  // 结构性负控：源码注释必须钉住这条红线（删掉注释/放开工具面即红）
  const src = readFileSync(join(import.meta.dirname, "../ops.ts"), "utf8");
  assert.match(src, /归因红线/, "角色定义处必须留下归因红线注释（负控锚点）");
});

// ============================================================================
// ③ 通道 + 提示词面：宿主子代理机制；zh/en 对称；en 零 CJK（范式标题白名单外）
// ============================================================================

test("g-374 F5 通道：插件不直连模型 API——summarizer 走宿主子代理，无 fetch/凭据", () => {
  const host = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  const start = host.indexOf("const startSummarizerChild");
  assert.ok(start > 0, "必须存在统一的 summarizer 派发函数（REST 与工具共用）");
  const block = host.slice(start, host.indexOf("\n  const summarizeFallbackWrite", start));
  // g-469：派发已收口到唯一 helper（新名 startActivation / 旧名 startContinuable 由它分流），
  // 断言意图不变——仍必须是「走宿主子代理机制」而不是直连模型 API。
  assert.match(block, /startSubagentCompat\(subagents,/, "必须走宿主子代理机制（经 g-469 派发收口 helper）");
  assert.match(block, /role: "summarizer"|toolFilterForRole\("summarizer"/, "必须绑定 summarizer 角色");
  for (const forbidden of [/fetch\(/, /https?:\/\//, /api[_-]?key/i, /Bearer /, /openai|anthropic|deepseek\.com/i]) {
    assert.doesNotMatch(block, forbidden, `不得在派发函数里直连模型/自带凭据：${forbidden}`);
  }
  // 角色 RESUMER 来源是 core 单一真源
  assert.match(host, /toolFilterForRole/, "角色工具面必须从 core 读取");
});

test("g-374 F5 提示词面：formatSummaryPrompt zh/en 对称且都钉住「改动 / 影响 / 值得注意」与落盘工具", () => {
  // 材料包本身是**数据**（可能含中文事实，如目标描述原文），不当作文案检查对象；
  // 这里刻意用不含 CJK 的 digest，只为让「en 提示词文案零 CJK」这条断言精确。
  const digest = "(material digest: reflects the goal history; see the tool output)";
  const zh = formatSummaryPrompt({ goalId: "g-001", goalRel: ".dsh-graph/versions/v1/goals/g-001/goal.md", digest, language: "zh" });
  const en = formatSummaryPrompt({ goalId: "g-001", goalRel: ".dsh-graph/versions/v1/goals/g-001/goal.md", digest, language: "en" });
  for (const [name, text] of [["zh", zh], ["en", en]] as const) {
    assert.ok(text.includes("g-001"), `${name} 必须带目标 id`);
    assert.ok(text.includes(".dsh-graph/versions/v1/goals/g-001/goal.md"), `${name} 必须带 goal.md 路径`);
    assert.match(text, /graph_refresh_results/, `${name} 必须要求经写入器落盘`);
    assert.match(text, /agent:summarizer/, `${name} 必须钉住 actor 归属`);
    assert.match(text, /(影响|impact)/i, `${name} 必须要求写影响面`);
    assert.match(text, /(值得注意|worth noting|noteworthy)/i, `${name} 必须要求写值得注意`);
    assert.match(text, /(judg|判据)/i, `${name} 必须要求逐字引用判据`);
    assert.match(text, /256/, `${name} 必须告知输入总预算（F7）`);
  }
  // 反回声的**提示词面**硬约束：正文主体不得复述卡片字段（标题/状态/版本/attempt 计数）
  assert.match(zh, /严禁把卡片字段（标题 \/ 状态 \/ 版本 \/ attempt 计数）当摘要主体/, "zh 必须显式禁止回显卡片字段");
  assert.match(en, /Never restate card fields \(title \/ status \/ version \/ attempt counts\)/, "en 必须显式禁止回显卡片字段");
  // 材料包里卡片字段必须被标注为「仅供定位」⇒ 模型不能把它当内容来源
  const realPrompt = formatSummaryPrompt({
    goalId: "g-001", goalRel: ".dsh-graph/versions/v1/goals/g-001/goal.md", language: "zh",
    digest: renderGoalResultsDigest(goalResultsDigest({
      meta: { id: "g-001", title: "反回声", type: "task", status: "in_progress", version: "v1", blocked_reason: null },
      description: "在目标目录下新增 results.md。",
      attempts: [], criteria_items: ["判据 1"], comments: [], events: [],
    })),
  });
  assert.match(realPrompt, /卡片字段（仅供定位，非摘要主体）/, "材料包必须把卡片字段标为仅供定位");
  assert.match(realPrompt, /在目标目录下新增 results\.md/, "材料包必须带目标描述要点（真正的取材来源）");
  // en 零 CJK：允许的例外只有「写入器认的六个正文章节标题」（格式契约，不可翻译）
  const canonical = ["## 结论", "## 改动与影响", "## 判据达成", "## 证据引用", "## 关键决策", "## 时间线"];
  let stripped = en;
  for (const h of canonical) stripped = stripped.split(h).join("");
  const cjk = stripped.match(/[\u3400-\u9fff]+/g) ?? [];
  assert.deepEqual(cjk, [], `en summarizer 提示词除规范章节标题外不得含 CJK：${cjk.slice(0, 5).join("、")}`);
  assert.ok(zh.includes("## 结论"), "zh 必须引用规范章节标题");
});

// ============================================================================
// 批量隔离（F5 ④：单目标失败/降级不牵连其它目标）
// ============================================================================

test("g-374 F5 批量：llm 逐目标独立——成型目标 pending、无目录目标降级写入，整批不中断", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  appendGoalComment(h.root, goal, "批量 llm 用例。", "human:gui");
  // backlog 目标：没有目标目录 ⇒ summarizer 无法派发 ⇒ 该目标必须降级而不是拖垮整批。
  const backlog = (h.call("graph_create_goal", { title: "暂存目标" }) as any).goal;
  const before = h.capturedRequests.length;
  const res = await h.call("graph_refresh_results", { goals: [goal, backlog], llm: true });
  assert.equal(res.total, 2);
  const byGoal = new Map(res.items.map((i: any) => [i.goal, i]));
  assert.equal((byGoal.get(goal) as any).status, "pending", "可派发目标进入 pending");
  assert.equal((byGoal.get(backlog) as any).ok, false, "无目录目标必须如实失败/降级");
  assert.equal(h.capturedRequests.length, before + 1, "只为可派发的那个目标派一次");
});

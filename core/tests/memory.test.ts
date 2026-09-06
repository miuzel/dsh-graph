/** g-105：记忆管理操作与事件流测试（add / replace / remove / recall / readMemory）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  addMemory,
  replaceMemory,
  removeMemory,
  recallMemory,
  readMemory,
  generateHandoff,
  GraphError,
} from "../ops.ts";
import { readMemoryEvents, replayMemory } from "../events.ts";

test("g-105: addMemory 写入事件流并在 memory.jsonl 中持久化", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);

  const { id, entry } = addMemory(root, {
    kind: "project",
    text: "pnpm 11 supply-chain 策略在 pnpm-workspace.yaml 设 minimumReleaseAge",
    importance: 4,
    actor: "agent:test",
  });

  assert.ok(id.startsWith("mem-"));
  assert.equal(entry.id, id);
  assert.equal(entry.kind, "project");
  assert.equal(entry.importance, 4);
  assert.ok(entry.created_at);
  assert.ok(entry.updated_at);

  const memFile = join(root, "memory", "memory.jsonl");
  assert.ok(existsSync(memFile));
  const lines = readFileSync(memFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.equal(ev.event, "memory.added");
  assert.equal(ev.actor, "agent:test");
  assert.equal(ev.details.id, id);
  assert.equal(ev.details.kind, "project");
});

test("g-105: replaceMemory 用唯一短片段定位并更新内容与元数据", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);

  const m1 = addMemory(root, {
    kind: "user",
    actor: "agent:test",
    text: "负责人偏好：极简输出，不要冗余的废话前缀",
    importance: 5,
  });

  const m2 = addMemory(root, {
    kind: "project",
    text: "DSH 插件规范：runtime 零 @deepseek-ai/* import",
    importance: 3,
  });

  // 用唯一短片段定位 m1
  const replaced = replaceMemory(root, {
    old: "极简输出",
    text: "负责人偏好：极简输出，严禁一切自我思考与规则自查前缀",
    importance: 5,
    actor: "agent:test",
  });

  assert.equal(replaced.id, m1.id);
  assert.equal(replaced.entry.text, "负责人偏好：极简输出，严禁一切自我思考与规则自查前缀");

  const memories = readMemory(root);
  assert.equal(memories.length, 2);
  const updatedM1 = memories.find((m) => m.id === m1.id);
  assert.ok(updatedM1);
  assert.equal(updatedM1.text, "负责人偏好：极简输出，严禁一切自我思考与规则自查前缀");
});

test("g-105: replaceMemory / removeMemory 唯一定位校验（0条或多条匹配报错）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);

  addMemory(root, { kind: "project", text: "规范 A：必须保证事件先行" });
  addMemory(root, { kind: "project", text: "规范 B：必须保证测试隔离" });

  // 0 条匹配
  assert.throws(
    () => replaceMemory(root, { old: "不存在的内容", text: "新内容" }),
    /未找到匹配片段的记忆条目/,
  );

  // 多条匹配（"必须保证" 匹配两条）
  assert.throws(
    () => replaceMemory(root, { old: "必须保证", text: "新内容" }),
    /定位片段不唯一，匹配到 2 条记忆/,
  );

  assert.throws(
    () => removeMemory(root, { old: "必须保证", reason: "重复规范已被明确撤回" }),
    /定位片段不唯一，匹配到 2 条记忆/,
  );
});

test("g-105: removeMemory 明确撤回或证实过时后删除条目", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);

  const m = addMemory(root, {
    kind: "project",
    text: "过时事实：旧版本使用 mnemon_runtime_memory",
  });

  assert.equal(readMemory(root).length, 1);

  const removed = removeMemory(root, {
    old: "mnemon_runtime_memory",
    reason: "mnemon 架构已下线，由 dsh-graph 自带记忆取代",
    actor: "supervisor",
  });

  assert.equal(removed.id, m.id);
  assert.equal(readMemory(root).length, 0);

  // 事件流保留 memory.removed 事件
  const events = readMemoryEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "memory.removed");
  assert.equal(events[1].details.reason, "mnemon 架构已下线，由 dsh-graph 自带记忆取代");
});

test("g-105: recallMemory 检索与排序（kind / 多关键词 / importance / limit）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);

  addMemory(root, {
    kind: "project",
    text: "子代理 spawn provider 选带 prepareContinuable 能力的",
    importance: 2,
  });
  addMemory(root, {
    kind: "project",
    text: "冻结脚本必须保持 R-03 规范，不可随意改动",
    importance: 4,
  });
  addMemory(root, {
    kind: "user",
    actor: "agent:test",
    text: "负责人偏好：交付前核对 main clean，不留未追踪文件",
    importance: 5,
  });

  // 1. 无条件 recall
  const all = recallMemory(root, { actor: "agent:test" });
  assert.equal(all.total, 3);
  // importance 降序：5 -> 4 -> 2
  assert.equal(all.matches[0].importance, 5);
  assert.equal(all.matches[1].importance, 4);
  assert.equal(all.matches[2].importance, 2);

  // 2. kind 过滤
  const userOnly = recallMemory(root, { kind: "user", actor: "agent:test" });
  assert.equal(userOnly.total, 1);
  assert.equal(userOnly.matches[0].kind, "user");

  // 3. 多关键词 AND 匹配
  const matched = recallMemory(root, { query: "spawn continuable", actor: "agent:test" });
  assert.equal(matched.total, 1);
  assert.ok(matched.matches[0].text.includes("prepareContinuable"));

  // 5. limit 截断
  const limited = recallMemory(root, { limit: 2, actor: "agent:test" });
  assert.equal(limited.total, 3);
  assert.equal(limited.matches.length, 2);
});

test("g-105: 容错损坏行与重放", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);

  addMemory(root, { kind: "project", text: "正常记忆 1" });

  // 写入损坏行与空行
  const memFile = join(root, "memory", "memory.jsonl");
  appendFileSync(memFile, "{ corrupt json line ...\n\n{\"ts\":\"2026-08-20\",\"actor\":\"test\",\"event\":\"invalid_event_no_details\"}\n", "utf8");

  addMemory(root, { kind: "user", text: "正常记忆 2", actor: "agent:test" });

  const memories = readMemory(root);
  assert.equal(memories.length, 2);
  assert.equal(memories[0].text, "正常记忆 1");
  assert.equal(memories[1].text, "正常记忆 2");
});

test("g-105: generateHandoff 包含结构化记忆与 long-term 文件引用", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);

  addMemory(root, {
    kind: "project",
    text: "架构事实：dsh-graph-host 统一工具注册",
    importance: 5,
  });

  const handoff = generateHandoff(root, { query: "统一", actor: "agent:test" });
  assert.ok(handoff.includes("## 长期记忆"));
  assert.ok(handoff.includes("结构化记忆（`memory/memory.jsonl` 共 1 条，已按 ACL/任务筛选）"));
  assert.ok(handoff.includes("架构事实：dsh-graph-host 统一工具注册"));
});

test("g-105: 严格输入、ACL、撤回 reason 与坏对象容错", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);
  assert.throws(() => addMemory(root, { kind: "project", text: "Authorization: Bearer abcdefghijklmnop" }), /凭据|token/);
  assert.throws(() => addMemory(root, { kind: "project", text: "含" + String.fromCharCode(1) + "控制字符" }), /控制字符/);
  assert.throws(() => addMemory(root, { kind: "project", text: "x", source_goal: "g-no-such-goal" }), /目标不存在/);
  assert.throws(() => removeMemory(root, { old: "x" }), /reason/);
  addMemory(root, { kind: "user", text: "alice private", actor: "agent:alice" });
  addMemory(root, { kind: "project", text: "shared fact", actor: "agent:alice" });
  assert.equal(recallMemory(root, { actor: "agent:bob" }).matches.some((m) => m.text === "alice private"), false);
  assert.equal(recallMemory(root, { actor: "agent:alice" }).matches.some((m) => m.text === "alice private"), true);
  appendFileSync(join(root, "memory", "memory.jsonl"), `null\n[]\n{"event":"memory.added","actor":"x","details":null}\n`, "utf8");
  assert.equal(readMemory(root).length, 2);
});

test("g-105: replace user replay 保留 owner 并拒绝越权", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-mem-"));
  init(root);
  addMemory(root, { kind: "user", text: "alice preference", actor: "agent:alice" });
  replaceMemory(root, { old: "alice preference", text: "alice updated", actor: "agent:alice" });
  assert.equal(recallMemory(root, { actor: "agent:alice" }).matches[0].text, "alice updated");
  assert.equal(recallMemory(root, { actor: "agent:bob" }).matches.length, 0);
  assert.throws(() => replaceMemory(root, { old: "alice updated", text: "hijack", actor: "agent:bob" }), /无权/);
  assert.throws(() => replaceMemory(root, { old: "alice updated", text: "kind swap", kind: "project", actor: "agent:alice" }), /跨 kind/);
});

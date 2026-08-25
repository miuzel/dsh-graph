/**
 * g-133：profile 级全局默认（dsh-graph 设置）源契约回归（node:test，零依赖）。
 *
 * 覆盖三类不变式：
 *  1. 模型路由优先级合成 `resolveModelRoute`：单次派发 override > workspace project.yaml 明确值
 *     > profile 全局默认 > 继承；空值不覆盖低层。
 *  2. 补充提示词三态合成 `resolvePromptOverride`：default/缺失 → 继承全局；非空文本 → 覆盖；
 *     显式空值 → 禁用（null）。
 *  3. project.yaml 覆盖字段解析 `readPromptOverrideValue`：`default`/缺失 → default；
 *     非空文本（含引号/空格）→ 文本；显式空值（'' / ""）→ 空串。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveModelRoute,
  resolvePromptOverride,
  readPromptOverrideValue,
} from "../ops.ts";

test("g-133 profile settings 契约：只暴露三字段并保留 Host API fallback", () => {
  const host = readFileSync(new URL("../../dsh-graph-host/index.js", import.meta.url), "utf8");
  const client = readFileSync(new URL("../../dsh-graph-host/lib/client/settings.js", import.meta.url), "utf8");
  for (const field of ["subagentProvider", "subagentModel", "subagentPrompt"]) assert.match(host, new RegExp(field));
  assert.doesNotMatch(host, /supervisorPrompt/);
  assert.doesNotMatch(client, /supervisorPrompt/);
  assert.match(client, /api\.settings\.describe/);
  assert.match(client, /api\.settings\.mutate/);
});

test("g-133 provider/model 目录 select 源契约：connection.api 捕获 + llm RPC + 已存值保留 + advisory 不拦截保存", () => {
  const client = readFileSync(new URL("../../dsh-graph-host/lib/client/settings.js", import.meta.url), "utf8");
  // 数据源：settings 模块内捕获 ctx.get('connection').api，挂载时调用 llm.providers/models 目录 RPC
  assert.match(client, /ctx\?\.get\?\.\("connection"\)/);
  assert.match(client, /api\.llm\.providers/);
  assert.match(client, /api\.llm\.models/);
  // provider/model 是目录 select（非自由文本 input）；首项留空继承
  assert.match(client, /h\("select"/);
  assert.match(client, /继承父会话/);
  // 已存但目录未列出的旧值保留为「已存值（当前目录未列出）」固定 option
  assert.match(client, /已存值/);
  assert.match(client, /当前目录未列出/);
  // advisory 目录不拦截保存：不再有「不在目录中」的保存拦截文案
  assert.doesNotMatch(client, /不在当前 Host 的合法 provider 目录中/);
  assert.doesNotMatch(client, /supervisorPrompt/);
});

test("g-133 模型路由：单次派发 override 最高优先", () => {
  const out = resolveModelRoute(
    { provider: "override-p", model: "override-m" },
    { provider: "project-p", model: "project-m" },
    { subagentProvider: "global-p", subagentModel: "global-m" },
  );
  assert.deepEqual(out, { provider: "override-p", model: "override-m" });
});

test("g-133 模型路由：无 override 时 project.yaml 明确值优先于全局默认", () => {
  const out = resolveModelRoute(
    null,
    { provider: "project-p", model: "project-m" },
    { subagentProvider: "global-p", subagentModel: "global-m" },
  );
  assert.deepEqual(out, { provider: "project-p", model: "project-m" });
});

test("g-133 模型路由：override 只给 provider、project 只给 model 时逐层求值", () => {
  const out = resolveModelRoute(
    { provider: "override-p", model: null },
    { provider: null, model: "project-m" },
    { subagentProvider: "global-p", subagentModel: "global-m" },
  );
  // provider：override-p；model：override 为 null → project-m
  assert.deepEqual(out, { provider: "override-p", model: "project-m" });
});

test("g-133 模型路由：全空回退全局默认，均为空则 null（继承）", () => {
  assert.deepEqual(
    resolveModelRoute(null, { provider: null, model: null }, { subagentProvider: "global-p", subagentModel: "global-m" }),
    { provider: "global-p", model: "global-m" },
  );
  assert.deepEqual(
    resolveModelRoute(null, { provider: null, model: null }, { subagentProvider: "", subagentModel: "" }),
    { provider: null, model: null },
  );
});

test("g-133 提示词三态：default 继承全局", () => {
  assert.equal(resolvePromptOverride("全局提示词", "default"), "全局提示词");
});

test("g-133 提示词三态：非空文本覆盖全局", () => {
  assert.equal(resolvePromptOverride("全局提示词", "workspace 覆盖文本"), "workspace 覆盖文本");
});

test("g-133 提示词三态：显式空值禁用（null）", () => {
  assert.equal(resolvePromptOverride("全局提示词", ""), null);
});

test("g-133 提示词三态：全局为空 & default → 空串（注入时视为无补充词）", () => {
  assert.equal(resolvePromptOverride("", "default"), "");
});

test("g-133 project.yaml 覆盖字段解析：缺失 → default", () => {
  assert.equal(readPromptOverrideValue("executor:\n  provider: x\n", "subagent_prompt"), "default");
});

test("g-133 project.yaml 覆盖字段解析：default 字面量 → default", () => {
  assert.equal(readPromptOverrideValue("defaults:\n  subagent_prompt: default\n", "subagent_prompt"), "default");
});

test("g-133 project.yaml 覆盖字段解析：显式空值（单引号）→ 空串", () => {
  assert.equal(readPromptOverrideValue("defaults:\n  subagent_prompt: ''\n", "subagent_prompt"), "");
});

test("g-133 project.yaml 覆盖字段解析：显式空值（双引号）→ 空串", () => {
  assert.equal(readPromptOverrideValue('defaults:\n  supervisor_prompt: ""\n', "supervisor_prompt"), "");
});

test("g-133 project.yaml 覆盖字段解析：带空格/引号的覆盖文本 → 去引号返回原文", () => {
  const yaml = "defaults:\n  subagent_prompt: '专注质量，先跑测试'\n";
  assert.equal(readPromptOverrideValue(yaml, "subagent_prompt"), "专注质量，先跑测试");
});

test("g-133 project.yaml 覆盖字段解析：行尾 # 注释不入值", () => {
  // 单引号内 # 不作注释；行尾裸 # 前为值
  const yaml = "defaults:\n  subagent_prompt: 自定义提示词 # 注释\n";
  assert.equal(readPromptOverrideValue(yaml, "subagent_prompt"), "自定义提示词");
});

/** g-118（负责人 2026-08-22 设计转向）：引导提示词注入 + graph_help 命令回归测试。
 *  验证：① 注册 dsh-graph-guide-hint section，所有会话渲染**简短引导提示词**（非完整守则）；
 *  ② 引导提示词含 claim 指引（graph_claim_supervisor 用法）+ graph_help 命令存在；
 *  ③ 隔离：注入内容**不含** supervisor 完整守则（铁律「绝不自己实现」等）——主管守则绝不
 *     自动注入任何会话（含执行子代理），仍走显式 skill 调用；
 *  ④ graph_help 工具注册且输出使用说明 + claim 指引；
 *  ⑤ systemPrompt 服务缺失时静默跳过、不阻塞 apply；
 *  ⑥ 工具注册数与 g-116/g-119 共存（16 + graph_bind_collect_card + graph_help = 18）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../ops.ts";
import { resolveRoot } from "../root.ts";
import { apply } from "../../dsh-graph-host/index.js";

/** 构造带 systemPrompt stub 的 mock ctx：捕获 section 注册、tools.register 捕获工具定义。 */
function makeMockCtx() {
  const sections: any[] = [];
  const registered: any[] = [];
  const ctx: any = {
    get: (key: string) => {
      if (key === "systemPrompt") {
        return {
          section: (section: any) => {
            sections.push(section);
            return () => {};
          },
        };
      }
      return undefined; // 无 subagents / skills / webServer 等服务
    },
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => {
        registered.push(def);
        return () => {};
      },
      get: () => ({}),
    },
  };
  return { ctx, sections, registered };
}

test("g-118：注册 dsh-graph-guide-hint section（所有会话注入引导提示词）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g118-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, { root });
  const section = sections.find((s) => s.name === "dsh-graph-guide-hint");
  assert.ok(section, "应注册 dsh-graph-guide-hint section");
  assert.equal(typeof section.text, "function", "text 应为渲染函数");
});

test("g-118：所有会话（含执行子代理/无 agent）渲染简短引导提示词，含 claim 指引与 help 提示", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g118-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, { root });
  const section = sections.find((s) => s.name === "dsh-graph-guide-hint");
  assert.ok(section);
  const text = section.text;

  // 组装上下文形状 = assembleContextFor(agent) → {agent, scope, signal}
  const ctxFor = (id: string) => ({ agent: { session: { id, header: { cwd: ws } } } });
  for (const id of ["session-super-1", "session-exec-1", "session-any"]) {
    const out = text(ctxFor(id));
    assert.ok(typeof out === "string" && out.length > 0, `会话 ${id} 应渲染非空引导提示词`);
    assert.ok(out.includes("graph_claim_supervisor"), "引导含 claim 用法");
    assert.ok(out.includes("graph_help"), "引导含 help 命令存在提示");
    assert.ok(out.includes("不自动注入"), "引导说明完整守则不自动注入");
    // 缺陷回归（负责人 2026-08-22 实测）：新会话用户只说「你好」就自动 claim——
    // 引导措辞必须是「仅在负责人明确要求时接管」，不得诱导自动接管
    assert.ok(out.includes("不要自动接管"), "引导明确禁止自动接管 supervisor");
    assert.ok(out.includes("只在负责人明确要求"), "claim 触发条件限定为负责人明确要求");
  }
  // 无 agent / 无 session 也应渲染（引导提示词对所有会话无害）
  assert.ok(text({}).includes("graph_claim_supervisor"));
  assert.ok(text(undefined).includes("graph_claim_supervisor"));
});

test("g-118：隔离——注入内容不含 supervisor 完整守则（铁律/不可妥协等）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g118-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, { root });
  const section = sections.find((s) => s.name === "dsh-graph-guide-hint");
  assert.ok(section);
  const out = section.text({ agent: { session: { id: "session-super-1", header: { cwd: ws } } } });
  // 完整守则的特征性内容绝不出现在注入里（主管守则仍走显式 skill 调用）
  assert.ok(!out.includes("绝不自己实现"), "注入不含铁律「绝不自己实现」");
  assert.ok(!out.includes("不可妥协"), "注入不含完整守则章节");
  assert.ok(!out.includes("主管 Agent"), "注入不授予主管角色");
});

test("g-118：graph_help 工具注册，输出使用说明 + claim 指引（不含完整守则）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g118-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, registered } = makeMockCtx();
  apply(ctx, { root });
  const help = registered.find((d) => d.name === "graph_help");
  assert.ok(help, "应注册 graph_help 工具");
  const out = help.execute({}, { agent: undefined, signal: new AbortController().signal });
  assert.ok(out.help.includes("graph_claim_supervisor"), "help 含 claim 指引");
  assert.ok(out.help.includes("graph_handoff"), "help 含换会话步骤");
  assert.ok(out.help.includes("graph_create_goal"), "help 含工具清单");
  assert.ok(out.help.includes("仅在负责人明确要求"), "help 限定 claim 仅在负责人明确要求时");
  assert.ok(!out.help.includes("绝不自己实现"), "help 不含主管铁律（完整守则走 skill）");
});

test("g-118：systemPrompt 服务缺失时静默跳过（headless / 测试组合），不阻塞 apply", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g118-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const ctx: any = {
    get: () => undefined,
    effect: (fn: () => unknown) => fn(),
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root }); // 不抛错即可（无 systemPrompt → 静默跳过）
});

test("g-118/g-119：注入不影响 graph_* 工具注册（16 + bind + help + rename + archive/unarchive + delete + record_attempt_handoff + set_directive + add_comment + delete_card + set_goal_type = 27）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g118-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, registered, sections } = makeMockCtx();
  apply(ctx, { root });
  assert.equal(registered.length, 27, "g-116 16 + g-119 graph_bind_collect_card + g-118 graph_help + g-141 graph_rename_goal + g-110 archive/unarchive + g-140 delete + g-150 graph_record_attempt_handoff + g-150 范围扩展 graph_set_directive / graph_add_comment + g-128 graph_delete_card + g-158 graph_set_goal_type = 27");
  assert.equal(sections.filter((s) => s.name === "dsh-graph-guide-hint").length, 1, "section 只注册一次");
});

// g-131：主管纪律提醒测试
test("g-131：注册 dsh-graph-supervisor-discipline section（仅主管会话注入）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g131-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, { root });
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(section, "应注册 dsh-graph-supervisor-discipline section");
  assert.equal(typeof section.text, "function", "text 应为渲染函数");
});

test("g-131：主管会话注入纪律提醒，普通/子代理会话不注入", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g131-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, { root });
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(section);

  // 主管会话：应注入纪律提醒
  const superOut = section.text({ agent: { session: { id: "session-super-1", header: { cwd: ws } } } });
  assert.ok(superOut.length > 0, "主管会话应渲染纪律提醒");
  assert.ok(superOut.includes("主管纪律提醒"), "提醒含标题");
  assert.ok(superOut.includes("只做规划、派发、把关、复核"), "提醒含铁律1");
  assert.ok(superOut.includes("graph_report_supervisor_status"), "提醒含 status 汇报");
  assert.ok(superOut.includes("review→delivered 必须等负责人 verdict"), "提醒含 verdict 要求");

  // 普通会话：不注入
  const normalOut = section.text({ agent: { session: { id: "session-normal-1", header: { cwd: ws } } } });
  assert.equal(normalOut, "", "普通会话不应渲染纪律提醒");

  // 子代理会话：不注入
  const execOut = section.text({ agent: { session: { id: "session-exec-1", header: { cwd: ws } } } });
  assert.equal(execOut, "", "子代理会话不应渲染纪律提醒");

  // 无 agent：不注入
  assert.equal(section.text({}), "", "无 agent 不应渲染纪律提醒");
  assert.equal(section.text(undefined), "", "undefined context 不应渲染纪律提醒");
});

test("g-131：未配置 supervisor.session 时不注入任何会话", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g131-"));
  const root = resolveRoot({}, ws);
  init(root);
  // 不写 project.yaml 或无 supervisor.session
  writeFileSync(join(root, "project.yaml"), "# empty\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, { root });
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(section);
  assert.equal(section.text({ agent: { session: { id: "session-any", header: { cwd: ws } } } }), "",
    "未配置 supervisor.session 时不应注入纪律提醒");
});

test("g-131：纪律提醒含主管铁律特征内容（与 g-118 隔离断言互补）", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g131-"));
  const root = resolveRoot({}, ws);
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: session-super-1\n");
  const { ctx, sections } = makeMockCtx();
  apply(ctx, { root });
  const section = sections.find((s) => s.name === "dsh-graph-supervisor-discipline");
  assert.ok(section);
  const out = section.text({ agent: { session: { id: "session-super-1", header: { cwd: ws } } } });
  // 铁律特征内容（g-118 隔离断言验证 GUIDE_HINT 不含这些，g-131 验证 discipline section 含这些）
  assert.ok(out.includes("绝不自己实现"), "纪律提醒含铁律「绝不自己实现」");
  assert.ok(out.includes("一句话决策"), "纪律提醒含「一句话决策」");
  assert.ok(out.includes("完整守则见 skill dsh-graph-supervisor"), "提醒指引完整守则走 skill");
});

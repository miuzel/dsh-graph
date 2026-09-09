import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  init,
  createGoal,
  addCard,
  fillCard,
  reviewCard,
  loadCard,
  formatCollectPrompt,
  formatPmPrompt,
  formatReviewPrompt,
  SUBAGENT_ROLES,
  normalizeSubagentRole,
  ROLE_PROFILES,
  getRoleProfile,
  toolFilterForRole,
  GRAPH_MINIMAL_ALLOWED_TOOLS,
} from "../ops.ts";
import { apply, formatAttemptPrompt } from "../../dsh-graph-host/index.js";

// ===== 判据 1：supervisor/executor/collector/reviewer/PM 角色能力与 prompt 要求统一映射测试 =====

test("判据 1 - 角色枚举与能力 Profile 完整性定义", () => {
  const expectedRoles = ["supervisor", "executor", "collector", "reviewer", "pm"];
  assert.deepEqual(SUBAGENT_ROLES as readonly string[], expectedRoles, "必须包含 5 大通用角色");

  for (const role of expectedRoles) {
    const profile = getRoleProfile(role as any);
    assert.ok(profile, `角色 ${role} 必须存在 profile`);
    assert.equal(profile.id, role);
    assert.ok(profile.name && typeof profile.name === "string", "包含非空 name");
    assert.ok(profile.description && typeof profile.description === "string", "包含非空 description");
    assert.equal(typeof profile.readOnly, "boolean", "包含 readOnly 布尔标识");
    assert.ok(Array.isArray(profile.disciplineLines) && profile.disciplineLines.length > 0, "包含底线纪律行");
    assert.ok(Array.isArray(profile.requiredTools), "包含必须使用的工具清单");
    assert.ok(profile.allowedTools, "包含 allowedTools 定义");
  }

  // normalizeSubagentRole 容错
  assert.equal(normalizeSubagentRole("PM"), "pm");
  assert.equal(normalizeSubagentRole("  executor  "), "executor");
  assert.equal(normalizeSubagentRole("invalid_role"), null);
  assert.equal(normalizeSubagentRole(null), null);
});

test("判据 1 - 角色能力与 Prompt 工具可见性统一映射测试", () => {
  // 校验每个角色提示词中所要求的工具，在对应角色的 toolFilter 白名单中均可见
  for (const role of SUBAGENT_ROLES) {
    const profile = getRoleProfile(role);
    const standardFilter = toolFilterForRole(role, "standard");
    const minimalFilter = toolFilterForRole(role, "minimal");

    for (const reqTool of profile.requiredTools) {
      // standard 模式下：若有白名单，必须包含 reqTool；若为 undefined 则表示全量工具可见
      if (standardFilter?.allow) {
        assert.ok(
          standardFilter.allow.includes(reqTool),
          `角色 ${role} standard 模式下必须可见提示词要求工具: ${reqTool}`,
        );
      }

      // minimal 模式下：对于非 supervisor 角色，提示词要求的基础工具必须在 minimalTools 中可见
      if (role === "executor") {
        assert.ok(
          minimalFilter?.allow?.includes(reqTool),
          `executor 在 minimal 模式下必须可见核心协同工具: ${reqTool}`,
        );
      } else if (role === "collector") {
        assert.ok(
          minimalFilter?.allow?.includes(reqTool),
          `collector 在 minimal 模式下必须可见卡片回填与附件工具: ${reqTool}`,
        );
      } else if (role === "reviewer" || role === "pm") {
        assert.ok(
          minimalFilter?.allow?.includes(reqTool),
          `${role} 在 minimal 模式下必须可见只读工具: ${reqTool}`,
        );
      }
    }
  }
});

test("判据 1 - 实体工具参数有效性测试", () => {
  // 收集 host 注册的所有工具及其参数定义
  const registeredTools = new Map<string, any>();
  const ctx: any = {
    get: () => undefined,
    effect: (fn: any) => fn(),
    webServer: { register: () => () => {} },
    tools: {
      register: (toolDef: any) => {
        registeredTools.set(toolDef.name, toolDef);
        return () => {};
      },
    },
  };
  apply(ctx, {});

  // 验证提示词中引导调用的工具参数，在工具 schema 中真实存在且有效
  const toolSignatures: Record<string, string[]> = {
    graph_fill_card: ["goal", "card", "text", "summary"],
    graph_store_attachment: ["name", "content"],
    graph_report_status: ["goal", "attempt", "status"],
    graph_transition: ["goal", "to"],
    graph_report_supervisor_status: ["status"],
    graph_resolve_accept: ["goal", "verdict"],
    graph_start_attempt: ["goal"],
  };

  for (const [toolName, expectedParams] of Object.entries(toolSignatures)) {
    const tool = registeredTools.get(toolName);
    assert.ok(tool, `工具 ${toolName} 必须在插件中已注册`);
    const params = tool.parameters?.properties ?? {};
    for (const p of expectedParams) {
      assert.ok(p in params, `工具 ${toolName} 的参数 ${p} 必须在 schema properties 中存在`);
    }
  }
});

// ===== 判据 2：collector 不创建虚假 attempt 来满足 report_status，采用明确卡片状态契约 =====

test("判据 2 - collector 契约：无 graph_report_status，依托卡片生命周期，回填并等待复核", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g242-coll-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "测试收集", version: "v1.0", actor: "human:user" });
  const cardId = addCard(root, goalId, { title: "背景调研", scope: "goal", actor: "human:user" });

  const prompt = formatCollectPrompt(root, goalId, cardId);

  // 1. prompt 明确禁止伪造 attempt 与调用 graph_report_status
  assert.ok(prompt.includes("不创建虚假 attempt，绝不调用 graph_report_status"));
  assert.ok(!prompt.includes("graph_report_status("), "收集 prompt 绝不引导调用 graph_report_status");

  // 2. prompt 正确引导调用 graph_fill_card
  assert.ok(prompt.includes(`graph_fill_card(goal="${goalId}", card="${cardId}"`));
  assert.ok(prompt.includes("不得自行调用 `graph_review_card`——完成后由 supervisor 复核"));

  // 3. collector 工具白名单绝不包含 graph_report_status 与管理写工具
  const standardFilter = toolFilterForRole("collector", "standard");
  const minimalFilter = toolFilterForRole("collector", "minimal");
  assert.ok(!standardFilter?.allow?.includes("graph_report_status"), "collector standard 模式绝不能有 graph_report_status");
  assert.ok(!minimalFilter?.allow?.includes("graph_report_status"), "collector minimal 模式绝不能有 graph_report_status");
  assert.ok(!standardFilter?.allow?.includes("graph_start_attempt"), "collector 绝不能有 graph_start_attempt");
  assert.ok(!standardFilter?.allow?.includes("graph_transition"), "collector 绝不能有 graph_transition");
  assert.ok(!standardFilter?.allow?.includes("graph_resolve_accept"), "collector 绝不能有 graph_resolve_accept");

  // 4. 卡片回填正常流转为 filled，复核后为 reviewed
  fillCard(root, goalId, cardId, { text: "收集内容详情", summary: "收集完成", by: "agent:collector", actor: "agent:collector" });
  const filledCard = loadCard(root, goalId, cardId);
  assert.equal(filledCard.doc.meta.status, "filled");

  reviewCard(root, goalId, cardId, { by: "human:reviewer", actor: "human:reviewer" });
  const reviewedCard = loadCard(root, goalId, cardId);
  assert.equal(reviewedCard.doc.meta.status, "reviewed");
});

test("判据 2 - supervisor-guide 修正：明确收集子代理不创建 attempt 与不调用 graph_report_status", () => {
  const guidePath = join(import.meta.dirname, "../../dsh-graph-host/supervisor-guide.zh.md");
  const guide = readFileSync(guidePath, "utf8");

  assert.ok(
    guide.includes("status_line 仅由执行子代理更新"),
    "supervisor 指南明确 status_line 仅由执行子代理更新",
  );
  assert.ok(
    guide.includes("收集子代理不创建 attempt，绝不伪造 attempt 调用 `graph_report_status`"),
    "supervisor 指南明确收集子代理不伪造 attempt 报状态",
  );
  assert.ok(
    guide.includes("依托卡片生命周期状态（`empty → collecting → filled → reviewed`）"),
    "supervisor 指南明确卡片生命周期协作契约",
  );
});

// ===== 判据 3：reviewer/PM 只读任务不默认暴露无关管理写工具，bash 说明 =====

test("判据 3 - reviewer/PM 只读工具白名单拦截与 bash 权限如实说明", () => {
  // PM 只读性
  const pmProfile = getRoleProfile("pm");
  assert.equal(pmProfile.readOnly, true, "PM 角色必须是 readOnly");
  const pmStandard = toolFilterForRole("pm", "standard");
  const pmMinimal = toolFilterForRole("pm", "minimal");

  const writeTools = ["edit", "write", "bash", "graph_create_goal", "graph_start_attempt", "graph_transition", "graph_resolve_accept"];
  for (const wt of writeTools) {
    assert.ok(!pmStandard?.allow?.includes(wt), `PM standard 模式绝不能包含写工具: ${wt}`);
    assert.ok(!pmMinimal?.allow?.includes(wt), `PM minimal 模式绝不能包含写工具: ${wt}`);
  }

  // Reviewer 只读性与 bash 权限
  const revProfile = getRoleProfile("reviewer");
  assert.equal(revProfile.readOnly, true, "Reviewer 角色必须是 readOnly");
  const revStandard = toolFilterForRole("reviewer", "standard");
  const revMinimal = toolFilterForRole("reviewer", "minimal");

  assert.ok(!revStandard?.allow?.includes("edit"), "Reviewer 绝不暴露 edit");
  assert.ok(!revStandard?.allow?.includes("write"), "Reviewer 绝不暴露 write");
  assert.ok(!revStandard?.allow?.includes("graph_create_goal"), "Reviewer 绝不暴露 graph_create_goal");
  assert.ok(!revStandard?.allow?.includes("graph_resolve_accept"), "Reviewer 绝不暴露 graph_resolve_accept (Human Gate)");

  // Reviewer 保留 bash 时必须有如实权限说明，不声称工具白名单是强安全沙箱
  assert.ok(revStandard?.allow?.includes("bash"), "Reviewer 保留 bash 用于运行只读测试/静态检查/git diff");
  assert.ok(revProfile.bashPermissionNote, "Reviewer 必须包含 bash 权限说明");
  assert.ok(revProfile.bashPermissionNote.includes("owner-trusted"), "明确符合 owner-trusted 单机单用户模型");
  assert.ok(revProfile.bashPermissionNote.includes("非强安全沙箱"), "不声称工具白名单是强安全沙箱");

  // Reviewer prompt 中同样体现该说明
  const revPrompt = formatReviewPrompt({
    goalId: "g-999",
    attemptId: "att-001",
    goalRel: ".dsh-graph/goals/g-999/goal.md",
  });
  assert.ok(revPrompt.includes("白名单裁剪非强安全沙箱，安全边界遵循单用户 owner-trusted 模型"));
  assert.ok(revPrompt.includes("最终 verdict 裁决由主管/负责人通过 graph_resolve_accept 执行，reviewer 绝不自行通过"));
});

// ===== 判据 4：切换 persona 与 standard/minimal 模式不丢必要框架纪律 =====

test("判据 4 - 切换 persona 与 standard/minimal 模式不丢失框架纪律与 Human Gate", () => {
  // 1. minimal 模式保留 6 项基础工具，包含完整框架协同工具
  const minimalFilter = toolFilterForRole("executor", "minimal");
  assert.deepEqual(
    minimalFilter?.allow,
    GRAPH_MINIMAL_ALLOWED_TOOLS,
    "minimal 模式工具集与既有受控 6 工具契约严格一致",
  );

  // 2. formatAttemptPrompt 统一模板无论任何输入，均无条件内联框架协同纪律段
  const prompt = formatAttemptPrompt({
    goal: "g-100",
    attempt: "att-001",
    goalRel: ".dsh-graph/goals/g-100/goal.md",
    taskType: "fix",
  });
  assert.ok(prompt.includes("## 通用执行纪律"), "必须包含通用执行纪律区块");
  assert.ok(prompt.includes("graph_report_status"), "必须包含 graph_report_status 指令");
  assert.ok(prompt.includes("graph_transition"), "必须包含 graph_transition 指令");
  assert.ok(prompt.includes("绝不自行 graph_transition 到 \"delivered\""), "必须内嵌 Human Gate delivered 禁区");
});

// ===== 判据 5：通用角色能力与 g-136 / g-218 边界明确 =====

test("判据 5 - 角色能力通用性与边界解耦：不复制项目特有规则与 Git 治理", () => {
  for (const role of SUBAGENT_ROLES) {
    const profile = getRoleProfile(role);
    const text = JSON.stringify(profile);
    // 不应硬编码项目特有的生成物同步命令或脚本（归 g-136）
    assert.ok(!text.includes("sync-core.sh"), `角色 ${role} profile 中不得硬编码本项目构建脚本 sync-core.sh`);
    assert.ok(!text.includes("build-client.sh"), `角色 ${role} profile 中不得硬编码本项目打包脚本 build-client.sh`);
    // 不应包含具体的 Git committer 白名单逻辑（归 g-218）
    assert.ok(!text.includes("committer_whitelist"), `角色 ${role} profile 中不得硬编码 Git 治理细节`);
  }
});

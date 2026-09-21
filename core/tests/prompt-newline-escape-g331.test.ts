/**
 * g-331：提示词换行转义防回归测试
 *
 * 背景：core/ops.ts 的 formatCollectPrompt / formatPmPrompt / formatReviewPrompt
 * 三处英侧分支曾使用 join("\\n") ——在 TypeScript 源码中 "\\n" 是「字面反斜杠 + n」
 * 两个字符，而非换行符。后果是英文语种下三条提示词被拼成一整行、正文夹带字面 \n，
 * 列表与小节结构对模型完全不可辨认；zh 分支正常，因此长期未被发现。
 *
 * 本测试从**构建产物** dist/core/ops.js 渲染，锁三件事：
 *   1. en 三路：换行数 > 0 且字面反斜杠-n 出现次数 === 0；
 *   2. zh 三路：与修复前（基线 bbda595）输出逐字符一致（下方 ZH_GOLDEN 为零回归 golden）；
 *   3. core/ops.ts 源码中不再残留以字面反斜杠-n 作为 join 分隔符的写法。
 *
 * 运行前需先 bash scripts/build.sh（本测试读 dist/，不读 core 源）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  init,
  createGoal,
  findGoalFile,
  formatCollectPrompt,
  formatPmPrompt,
  formatReviewPrompt,
} from "../../dist/core/ops.js";

/** 修复前（基线 bbda595）zh 三路提示词的渲染结果，数据根已归一化为 <ROOT>。
 *  逐字符固化：任何 zh 文案改动都会让本测试变红——这是 g-331 的零回归约束。
 *  生成方式：从 bbda595 构建产物渲染后归一化，未经人工改写。
 */
const ZH_GOLDEN: Record<string, string> = {
  collect:
    "## 收集任务上下文\n" +
    "\n" +
    "**工作目录**：当前分配的 worktree/当前工作目录。\n" +
    "**canonical 附件根（绝对路径，非 worktree 相对路径）**：`<ROOT>/attachments`\n" +
    "**数据根（.dsh-graph，绝对路径）**：`<ROOT>`\n" +
    "\n" +
    "**目标信息**：\n" +
    "- id: `g-001`\n" +
    "- 标题: 探针目标\n" +
    "\n" +
    "**卡片信息**：\n" +
    "- id: `card-probe`\n" +
    "- 标题: 探针卡片\n" +
    "\n" +
    "**收集范围**：\n" +
    "请收集与卡片「探针卡片」相关的详细上下文信息，用于填充该卡片。\n" +
    "\n" +
    "**回填要求**：\n" +
    "1. 把正文全文写进 `text` 参数；`summary` 写一句话要点式摘要（≤100 字左右），不要长文。\n" +
    "2. 若收集到文件附件（md/txt 文本、图片、csv/Excel、二进制等），调用 `graph_store_attachment` 把内容写入上面的 canonical 附件根：\n" +
    "   - 文本：`graph_store_attachment(name=\"docs/report.md\", content=<UTF-8 文本>)`\n" +
    "   - 二进制/图片/Excel：`graph_store_attachment(name=\"chart.png\", base64=<base64>)`（或原始字节上传）。\n" +
    "   - 返回的稳定引用名为相对路径（可含安全子目录，如 `docs/report.md`）。\n" +
    "3. 回调正文或 goal.md 时，用 `@att/<相对引用名>` 引用附件（如 `@att/docs/report.md`）；引用会在卡片正文、goal.md、后续 attempt 注入与 GUI 查看时保留/解析。\n" +
    "4. 完成后调用以下精确命令回填结果：\n" +
    "```\n" +
    "graph_fill_card(goal=\"g-001\", card=\"card-probe\", text=<全文可含 @att/<name>>, summary=<≤100字摘要>)\n" +
    "```\n" +
    "\n" +
    "**附件安全与边界（严格遵守）**：\n" +
    "1. 附件只能写入上述 canonical 附件根及其安全子目录；拒绝绝对路径、`.`/`..` 穿越、反斜杠、NUL。\n" +
    "2. 不得写入或引用 `.dsh-graph` 之外的文件；不要用相对 `.dsh-graph/attachments`（worktree 内不可达）。\n" +
    "3. 若从互联网抓取：仅允许 http/https，设置超时与大小上限，禁止 `file://`、`localhost`、内网地址（SSRF）；抓取结果经 `graph_store_attachment` 安全落盘，不得直接写文件系统。\n" +
    "\n" +
    "**禁区（严格遵守）**：\n" +
    "1. 不得修改其他 goal 或 card——只能回填当前绑定的卡片 `card-probe`\n" +
    "2. 不得自行调用 `graph_review_card`——完成后由 supervisor 复核\n" +
    "3. 所有 graph 工具操作必须在当前分配的 worktree/当前工作目录下运行\n" +
    "4. 进度协作依托卡片生命周期（empty → collecting → filled → reviewed），不创建虚假 attempt，绝不调用 graph_report_status\n" +
    "\n" +
    "**用户附加要求**：\n" +
    "附加要求：探针",
  pm:
    "你是固定的产品经理 Agent。请只向主管 Agent 返回\"目标定义/润色建议\"，不要调用任何 graph_* 工具，不要修改目标、不改变状态、版本或执行语义。\n" +
    "\n" +
    "目标 ID：g-001\n" +
    "goal.md 工作区相对路径：.dsh-graph/goals/x/goal.md\n" +
    "人工指导意见：指导\n" +
    "\n" +
    "请先用 read 工具读取上述 goal.md，再围绕目标价值、背景、范围、可验证判据、边界/错误路径、风险和人工核验给出简洁、可执行的润色建议；保留原意，不直接替换或写入目标。\n" +
    "\n" +
    "## 回报格式要求\n" +
    "⚠️ 你的回报必须以标题行开头，格式严格为：【g-001 润色建议】\n" +
    "这是主管自动识别目标的关键标识，缺少此格式将导致建议无法正确关联到目标。\n" +
    "\n" +
    "## 只读约束与纪律\n" +
    "- 物理工具拦截：不提供任何管理写工具、代码修改工具与命令执行工具，仅提供只读分析能力；\n" +
    "- 保留原意：仅输出分析与建议，不擅自修改任何项目数据。",
  review:
    "你是专业的代码与目标复核 Agent（Reviewer）。请对目标 g-001 的执行 attempt att-001 进行只读审查。\n" +
    "\n" +
    "目标 ID：g-001\n" +
    "执行 Attempt：att-001\n" +
    "goal.md 工作区相对路径：.dsh-graph/goals/x/goal.md\n" +
    "\n" +
    "**验收判据**：\n" +
    "1. 判据一\n" +
    "2. 判据二\n" +
    "\n" +
    "**复核指导**：复核指导\n" +
    "\n" +
    "## 审查纪律与工具权限\n" +
    "- 纯只读审查：仅使用 read、glob、grep 审查代码与变更，不暴露且不调用 edit/write 修改代码；\n" +
    "- 绝不调用管理写工具：不暴露任何 graph_* 管理写工具（如 graph_create_goal, graph_start_attempt, graph_transition, graph_resolve_accept 等）；\n" +
    "- 裁决归属主管/人工 Gate：仅输出审查报告与建议（PASS / FAIL 及具体证据），最终 verdict 裁决由主管/负责人通过 graph_resolve_accept 执行，reviewer 绝不自行通过；\n" +
    "- bash 权限说明：如保留 bash，仅用于运行只读测试（如单元测试 node --test、静态检查、git diff 等），其实际具备当前工作区的本地运行权限；白名单裁剪非强安全沙箱，安全边界遵循单用户 owner-trusted 模型。",
};

/** 渲染探针参数：与固化 golden 时使用的参数逐字符一致（改这里必须同步重算 golden） */
const PROBE = {
  goalTitle: "探针目标",
  goalVersion: "v-probe",
  cardId: "card-probe",
  cardTitle: "探针卡片",
  goalRel: ".dsh-graph/goals/x/goal.md",
  attemptId: "att-001",
  collectAddendum: "附加要求：探针",
  pmGuidance: "指导",
  reviewCriteria: ["判据一", "判据二"],
  reviewGuidance: "复核指导",
};

/** 确定性数据根（位于 gitignored 的 tmp/ 下；每次重建以保证 goal id 稳定为 g-001） */
function setupRoot(): string {
  const root = join(import.meta.dirname, "../../tmp/g331-prompt-golden-root");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  init(root);
  const goalId = createGoal(root, {
    title: PROBE.goalTitle,
    version: PROBE.goalVersion,
    actor: "g331-test",
  });
  const cardsDir = join(dirname(findGoalFile(root, goalId)), "cards");
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(
    join(cardsDir, `${PROBE.cardId}.md`),
    `---\n{"id":"${PROBE.cardId}","goal":"${goalId}","title":"${PROBE.cardTitle}","kind":"text","status":"empty"}\n---\n\n`,
  );
  return root;
}

/** 把数据根绝对路径替换为 <ROOT>，使 golden 与 checkout 路径无关 */
function normalize(text: string, root: string): string {
  let out = text.split(root).join("<ROOT>");
  const real = realpathSync(root);
  if (real !== root) out = out.split(real).join("<ROOT>");
  return out;
}

function metrics(text: string) {
  return {
    // 真实换行符 U+000A
    newlines: (text.match(/\n/g) || []).length,
    // 字面反斜杠 + n 两个字符（本测试要杜绝的形态）
    literalBackslashN: (text.match(/\\n/g) || []).length,
    chars: text.length,
  };
}

function renderAll() {
  const root = setupRoot();
  const goalId = "g-001";
  return {
    root,
    collect: {
      zh: formatCollectPrompt(root, goalId, PROBE.cardId, PROBE.collectAddendum),
      en: formatCollectPrompt(root, goalId, PROBE.cardId, "user addendum: probe", "en"),
    },
    pm: {
      zh: formatPmPrompt({ goalId, goalRel: PROBE.goalRel, guidance: PROBE.pmGuidance }),
      en: formatPmPrompt({
        goalId,
        goalRel: PROBE.goalRel,
        guidance: "guide",
        language: "en",
      }),
    },
    review: {
      zh: formatReviewPrompt({
        goalId,
        attemptId: PROBE.attemptId,
        goalRel: PROBE.goalRel,
        criteria: PROBE.reviewCriteria,
        guidance: PROBE.reviewGuidance,
      }),
      en: formatReviewPrompt({
        goalId,
        attemptId: PROBE.attemptId,
        goalRel: PROBE.goalRel,
        criteria: ["crit A", "crit B"],
        guidance: "review guide",
        language: "en",
      }),
    },
  };
}

const ROUTES = ["collect", "pm", "review"] as const;

test("g-331：en 三路提示词换行转义已修复（换行 > 0 且字面反斜杠-n === 0）", () => {
  const r = renderAll();
  for (const route of ROUTES) {
    const text = r[route].en;
    const m = metrics(text);
    assert.ok(
      m.newlines > 0,
      `${route}_en 必须含真实换行符，实际换行数 = ${m.newlines}（整篇被拼成一行即为转义缺陷复发）`,
    );
    assert.equal(
      m.literalBackslashN,
      0,
      `${route}_en 不得含字面反斜杠-n，实际出现 ${m.literalBackslashN} 次（join("\\\\n") 缺陷复发）`,
    );
    // 结构可辨认：多行且首行不等于整篇
    assert.ok(
      text.split("\n").length > 1,
      `${route}_en 必须渲染为多行，实际行数 = ${text.split("\n").length}`,
    );
  }
});

test("g-331：zh 三路提示词与修复前逐字符一致（零回归 golden）", () => {
  const r = renderAll();
  for (const route of ROUTES) {
    const actual = normalize(r[route].zh, r.root);
    const expected = ZH_GOLDEN[route];
    assert.equal(
      createHash("sha256").update(actual, "utf8").digest("hex"),
      createHash("sha256").update(expected, "utf8").digest("hex"),
      `${route}_zh 与基线 bbda595 的渲染结果不一致（zh 分支被改动，违反零回归约束）`,
    );
    // 逐字符相等（hash 相同即字节相同；此处再做显式比对以给出可读差异）
    assert.equal(
      actual,
      expected,
      `${route}_zh 逐字符比对失败；长度 实际=${actual.length} 期望=${expected.length}`,
    );
    const m = metrics(actual);
    assert.equal(
      m.literalBackslashN,
      0,
      `${route}_zh 本就无字面反斜杠-n，实际 ${m.literalBackslashN} 次`,
    );
    assert.ok(m.newlines > 0, `${route}_zh 换行数应 > 0，实际 ${m.newlines}`);
  }
});

test("g-331：core/ops.ts 源不再残留字面反斜杠-n 作为 join 分隔符", () => {
  const src = readFileSync(join(import.meta.dirname, "../../core/ops.ts"), "utf8");
  // 匹配源码文本中的 .join("\\n")（含两个反斜杠字符）；正确写法是 .join("\n")
  const offenders = src.match(/\.join\("\\\\n"\)/g) || [];
  assert.equal(
    offenders.length,
    0,
    `core/ops.ts 残留 ${offenders.length} 处字面反斜杠-n join 分隔符，应为 .join("\\n") 的真实换行写法`,
  );
});

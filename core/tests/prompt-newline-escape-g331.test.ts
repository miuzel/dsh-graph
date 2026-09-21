/**
 * g-331：提示词换行转义防回归测试
 *
 * 背景：core/ops.ts 的 formatCollectPrompt / formatPmPrompt / formatReviewPrompt
 * 三处英侧分支曾使用 join("\\n") ——在 TypeScript 源码中 "\\n" 是「字面反斜杠 + n」
 * 两个字符，而非换行符。后果是英文语种下三条提示词被拼成一整行、正文夹带字面 \n，
 * 列表与小节结构对模型完全不可辨认；zh 分支正常，因此长期未被发现。
 *
 * 本测试从**构建产物** dist/core/ops.js 渲染，只守护两件事：
 *   1. en 三路：换行数 > 0 且字面反斜杠-n 出现次数 === 0；
 *   2. zh 三路：**不变量**——字面反斜杠-n 出现次数 === 0 且换行数 > 0；
 *   3. core/ops.ts 源码中不再残留以字面反斜杠-n 作为 join 分隔符的写法。
 *
 * 刻意**不**冻结 zh 全文：早期版本（att-001）曾把 zh 三路渲染产物逐字符固化成
 * ZH_GOLDEN golden，那会让未来任何**合法**的 zh 文案改动变红——例如 g-313 计划往
 * formatPmPrompt 的 zh 分支追加几行。那属于「散文冻结」，与本测试真正要守护的
 * 「转义正确性」无关，已按负责人裁定降级为不变量。
 *
 * 「zh 未被本次修复波及（零回归）」的结论因此是一次性验证记录、不是常驻断言。
 * 证据留档于 att-001 的 tmp/baseline.json（基线 bbda595）与 tmp/final.json（修复后
 * c5a5db2）及其 attempt 报告：三路 zh 渲染逐字符一致。
 *
 * 运行前需先 bash scripts/build.sh（本测试读 dist/，不读 core 源）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  init,
  createGoal,
  findGoalFile,
  formatCollectPrompt,
  formatPmPrompt,
  formatReviewPrompt,
} from "../../dist/core/ops.js";

/** 渲染探针参数：en 与 zh 断言共用同一组参数 */
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

test("g-331：zh 三路提示词未被转义缺陷波及（不变量：换行 > 0 且字面反斜杠-n === 0）", () => {
  const r = renderAll();
  for (const route of ROUTES) {
    const text = r[route].zh;
    const m = metrics(text);
    assert.equal(
      m.literalBackslashN,
      0,
      `${route}_zh 不得含字面反斜杠-n，实际出现 ${m.literalBackslashN} 次（转义缺陷扩散到 zh 分支）`,
    );
    assert.ok(
      m.newlines > 0,
      `${route}_zh 必须含真实换行符、结构可辨认，实际换行数 = ${m.newlines}`,
    );
  }
  // 注意：此处刻意**不**比对 zh 全文。zh 文案的任何合法追加/润色都不应让本测试变红；
  // 「本次修复没有改变 zh 输出」的逐字符证据见文件头注释指向的一次性留档。
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

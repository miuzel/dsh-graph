import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const i18nSource = readFileSync(join(hostRoot, "lib/client/i18n.js"), "utf8");
const goalActionsSource = readFileSync(join(hostRoot, "lib/client/goal-actions.js"), "utf8");
const bundleSource = readFileSync(join(hostRoot, "lib/client.js"), "utf8");

function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en; this.createTranslator = createTranslator;", sandbox);
  return { zh: sandbox.zh, en: sandbox.en, createTranslator: sandbox.createTranslator };
}

test("g-281: i18n criteria.feedback* keys exist, zh/en symmetric, en has no CJK", () => {
  const { zh, en, createTranslator } = loadClientI18n();

  // 1. 验证新增的 criteria.feedbackBtn 与精简后的 criteria.feedbackTooltip
  assert.equal(zh["criteria.feedbackBtn"], "反馈", "中文按钮文本应为「反馈」");
  assert.equal(en["criteria.feedbackBtn"], "Feedback", "英文按钮文本应为「Feedback」");
  assert.equal(zh["criteria.feedbackTooltip"], "向执行会话反馈此判据", "中文 tooltip 应保留指引性精简说明");
  assert.equal(en["criteria.feedbackTooltip"], "Send this criterion to the execution session", "英文 tooltip 应保留指引性精简说明");

  // 2. 验证所有 criteria.feedback* 键在中英双语中均存在
  const feedbackKeys = [
    "criteria.feedbackBtn",
    "criteria.feedbackTooltip",
    "criteria.feedbackPlaceholder",
    "criteria.feedbackSend",
    "criteria.feedbackQueued",
    "criteria.feedbackNotConnected",
    "criteria.feedbackSendFail",
  ];

  for (const k of feedbackKeys) {
    assert.ok(zh[k], `zh 字典缺失键 ${k}`);
    assert.ok(en[k], `en 字典缺失键 ${k}`);
    assert.doesNotMatch(en[k], /[\u3400-\u9fff]/, `en ${k} 不得包含 CJK 字符`);
  }

  // 3. 验证 zh 和 en 全量键严格 1:1 对称
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, "client i18n zh 和 en 词条键必须严格一致完全对称");
});

test("g-281: goal-actions.js 与 client.js 判据列表行内按钮与 Tooltip 源码契约", () => {
  for (const [name, src] of [["goal-actions.js", goalActionsSource], ["client.js", bundleSource]]) {
    // 按钮可见文本使用 criteria.feedbackBtn
    assert.ok(
      src.includes('dgT("criteria.feedbackBtn")'),
      `${name} 必须使用 dgT("criteria.feedbackBtn") 作为按钮可见文本`
    );

    // 按钮 title 挂载 criteria.feedbackTooltip
    assert.ok(
      src.includes('title: dgT("criteria.feedbackTooltip")'),
      `${name} 必须使用 title: dgT("criteria.feedbackTooltip") 保留说明指引`
    );

    // 按钮样式包含 whiteSpace: "nowrap" 防撑破防换行
    assert.ok(
      /h\("button",\s*\{\s*style:\s*\{[^}]*flexShrink:\s*0[^}]*whiteSpace:\s*"nowrap"[^}]*\},\s*className:\s*"dg-btn"/.test(src),
      `${name} 按钮必须包含 whiteSpace: "nowrap" 与 flexShrink: 0 样式`
    );

    // 内部提示词前缀与 session.prompt 契约完全保留
    assert.ok(
      src.includes("【${props.goalId} 判据反馈】${criterion}\\n${t}"),
      `${name} 必须保留【\${props.goalId} 判据反馈】提示词模板契约`
    );
    assert.ok(
      src.includes('dgT("criteria.feedbackNotConnected")') &&
      src.includes('dgT("criteria.feedbackQueued")') &&
      src.includes('dgT("criteria.feedbackSendFail")'),
      `${name} 必须完整保留反馈状态提示契约`
    );
  }
});

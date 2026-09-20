import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const distRoot = join(import.meta.dirname, "../../dist");
const i18nSource = readFileSync(join(hostRoot, "lib/client/i18n.js"), "utf8");
const constantsSource = readFileSync(join(hostRoot, "lib/client/constants.js"), "utf8");
const modalSource = readFileSync(join(hostRoot, "lib/client/goal-modal.js"), "utf8");
const kanbanSource = readFileSync(join(hostRoot, "lib/client/kanban.js"), "utf8");
const bundleSource = readFileSync(join(distRoot, "lib/client.js"), "utf8");

function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en; this.createTranslator = createTranslator;", sandbox);
  return { zh: sandbox.zh, en: sandbox.en, createTranslator: sandbox.createTranslator };
}

test("g-277: i18n tags compact keys exist, zh/en symmetric, en has no CJK", () => {
  const { zh, en, createTranslator } = loadClientI18n();
  const keys = [
    "tags.addCompact",
    "tags.inputPlaceholderCompact",
    "tags.removeTagNamed",
    "tags.addTooltip",
    "tags.removeTooltip",
    "tags.saveFail",
  ];

  for (const k of keys) {
    assert.ok(zh[k], `zh dictionary missing key ${k}`);
    assert.ok(en[k], `en dictionary missing key ${k}`);
    assert.doesNotMatch(en[k], /[\u3400-\u9fff]/, `en ${k} must not contain CJK characters`);
  }

  assert.equal(zh["tags.addCompact"], "+标签");
  assert.equal(en["tags.addCompact"], "+Tag");

  const tZh = createTranslator(null);
  assert.equal(tZh("tags.removeTagNamed", { tag: "frontend" }), "移除标签 #frontend");

  // Check overall symmetry of dictionaries
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, "client i18n zh and en must have exact same keys");
});

test("g-277: constants.js and client.js define CSS hover and focus visibility for delete button and wrap/truncate", () => {
  for (const [name, src] of [["constants.js", constantsSource], ["client.js", bundleSource]]) {
    // 1. Tag chip wrap and chip class
    assert.ok(src.includes(".dg-tag-chips-wrap"), `${name} must define .dg-tag-chips-wrap`);
    assert.ok(src.includes(".dg-tag-chip"), `${name} must define .dg-tag-chip`);
    assert.ok(src.includes(".dg-tag-del"), `${name} must define .dg-tag-del`);
    assert.ok(src.includes(".dg-tag-add-btn"), `${name} must define .dg-tag-add-btn`);
    assert.ok(src.includes(".dg-tag-input"), `${name} must define .dg-tag-input`);

    // 2. CSS hover delete visibility rules
    assert.ok(
      src.includes(".dg-tag-chip .dg-tag-del") && src.includes("visibility: hidden"),
      `${name} must hide .dg-tag-del by default`
    );
    assert.ok(
      src.includes(".dg-tag-chip:hover .dg-tag-del") && src.includes("visibility: visible"),
      `${name} must show .dg-tag-del on hover`
    );
    assert.ok(
      src.includes(".dg-tag-chip:focus-within .dg-tag-del"),
      `${name} must keep .dg-tag-del visible on keyboard focus (:focus-within)`
    );

    // 3. Multi-tag wrapping strategy
    assert.ok(
      src.includes("flex-wrap: wrap"),
      `${name} must enable flex-wrap for chips wrap`
    );

    // 4. Long-tag truncate strategy (max-width + ellipsis)
    assert.ok(
      src.includes("text-overflow: ellipsis"),
      `${name} must define text-overflow: ellipsis for tags`
    );
  }
});

test("g-277: GoalTagsEditor renders compact chips with hover-delete structure and +标签 button", () => {
  const h = (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children: children.flat() });
  let renderedState: any = null;
  const mockState = (init: any) => {
    let val = typeof init === "function" ? init() : init;
    return [val, (next: any) => { val = next; }];
  };

  const sandbox: any = {
    React: {
      createElement: h,
      useState: mockState,
      useEffect: () => {},
    },
    h,
    S: { meta: {}, promptInput: {}, btn: {} },
    graphUrl: (p: string) => p,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    showToast: () => {},
    dgT: (key: string, params?: any) => {
      if (key === "tags.addCompact") return "+标签";
      if (key === "tags.removeTooltip") return "点击移除标签";
      if (key === "tags.removeTagNamed") return `移除标签 #${params?.tag}`;
      if (key === "tags.inputPlaceholderCompact") return "标签名，回车保存…";
      return key;
    },
  };

  const match = modalSource.match(/function GoalTagsEditor\(props\) \{[\s\S]*?\n    \}/);
  assert.ok(match, "GoalTagsEditor definition not found in goal-modal.js");
  vm.runInNewContext(match[0] + "; this.GoalTagsEditor = GoalTagsEditor;", sandbox);

  const GoalTagsEditor = sandbox.GoalTagsEditor;
  const vdom = GoalTagsEditor({ goalId: "g-101", tags: ["backend", "perf"] });

  assert.equal(vdom.type, "span");
  assert.equal(vdom.props.className, "dg-tag-chips-wrap");

  // Should have 2 chips plus 1 add button
  const chips = vdom.children.filter((c: any) => c && c.props?.className === "dg-tag-chip");
  assert.equal(chips.length, 2, "Should render 2 tag chips");

  assert.equal(chips[0].props.title, "#backend");
  assert.equal(chips[0].props.tabIndex, 0, "Chip must be focusable for keyboard navigation");

  const delBtn0 = chips[0].children.find((c: any) => c && c.props?.className === "dg-tag-del");
  assert.ok(delBtn0, "Chip must contain a .dg-tag-del button");
  assert.equal(delBtn0.children[0], "×", "Delete button must show ×");

  const addBtn = vdom.children.find((c: any) => c && c.props?.className === "dg-tag-add-btn");
  assert.ok(addBtn, "Must render .dg-tag-add-btn");
  assert.equal(addBtn.children[0], "+标签", "Add button must display +标签");
});

test("g-277: goal-modal.js renders GoalTagsEditor in subtitle line (headMeta) and removes it from body (detailTab)", () => {
  // 1. In headMeta: subtitle row contains bits.join(" ｜ "), separator "｜", and GoalTagsEditor
  assert.ok(
    modalSource.includes('h("span", null, bits.join(" ｜ "))'),
    "Subtitle row must contain bits.join(' ｜ ')"
  );
  assert.ok(
    modalSource.includes('h(GoalTagsEditor, {'),
    "GoalTagsEditor must be called in goal-modal.js"
  );
  assert.ok(
    modalSource.includes('h("span", { style: { opacity: 0.5, userSelect: "none" } }, "｜")'),
    "Subtitle row must contain separator before GoalTagsEditor"
  );

  // 2. In detailTab: GoalTagsEditor must NOT be rendered
  const detailTabMatch = modalSource.match(/const detailTab = \[([\s\S]*?)\];/);
  assert.ok(detailTabMatch, "detailTab array definition found in goal-modal.js");
  assert.ok(
    !detailTabMatch[1].includes("GoalTagsEditor"),
    "detailTab must NOT contain GoalTagsEditor (must be removed from body)"
  );

  // 3. kanban.js passes onTagsChanged to GoalModal
  assert.ok(
    kanbanSource.includes("onTagsChanged: () => load()"),
    "kanban.js must pass onTagsChanged to GoalModal to sync board"
  );
});

test("g-277: GoalTagsEditor preserves set-goal-tags CAS base_tags and force: true fallback", () => {
  assert.ok(
    modalSource.includes('/api/dsh-graph/set-goal-tags'),
    "GoalTagsEditor must persist via /api/dsh-graph/set-goal-tags"
  );
  assert.ok(
    modalSource.includes('base_tags: tags'),
    "GoalTagsEditor must supply base_tags for optimistic concurrency"
  );
  assert.ok(
    modalSource.includes('force: true'),
    "GoalTagsEditor must fallback to force: true on 409 conflict"
  );
});

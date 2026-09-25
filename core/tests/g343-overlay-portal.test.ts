/** g-343 源契约：看板浮层必须逃出看板根节点的层叠上下文（portal 到 body），
 *  composer 不得再被降到 z-index:0。
 *
 *  背景（实测证据，隔离实例 elementsFromPoint 命中栈）：
 *  - 看板根节点用 S.wrap（position:relative + z-index:1）⇒ 自成层叠上下文；
 *    遮罩(99998)/抽屉(99999) 留在子树内时被囚禁在该上下文，与子树外的 composer 只能整体比高低。
 *  - composer 原生 z-index:7；g-216 曾把它降到 0，于是子树内任何 z-index ≥ 1 的卡片元素
 *    （主管条 50、卡片内弹层 9999）翻到 composer 之前——这就是 g-343 的缺陷本体。
 *  - 实测：composer=0 时卡片压在 composer 之上；composer=7 时 composer 又浮到遮罩之上。
 *    ⇒ 两者不可同时成立，必须让浮层逃出子树。
 *
 *  本文件锁死「逃出子树」的实现形态与「不再降级 composer」的修法边界：禁止退化成
 *  「删掉 z-index:0 那一行就收工」（那会让 composer 浮到遮罩之上）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const CLIENT = join(ROOT, "dsh-graph-host/lib/client");
const read = (p: string) => readFileSync(p, "utf8");
const bundle = read(join(ROOT, "dist/lib/client.js"));
const helpers = read(join(CLIENT, "helpers.js"));
const constants = read(join(CLIENT, "constants.js"));

/** 抽出 constants.js 里 composerSeat 的层级规则块（g-216/g-343 那一块）。 */
function composerRuleBlock(src: string): string {
  const anchor = src.indexOf(".wSkVaW_root:has(.dg-modal-open) .wSkVaW_composerSeat");
  assert.ok(anchor > 0, "constants.js 含 composerSeat 的 .dg-modal-open 规则块");
  const end = src.indexOf("}", anchor);
  return src.slice(anchor, end + 1);
}

test("g-343 契约：浮层统一 portal 到 document.body（逃出看板子树层叠上下文）", () => {
  assert.match(helpers, /function dgOverlay\(props, \.\.\.children\) \{/,
    "helpers.js 提供共享 dgOverlay(props, ...children)（实参形状同 h(\"div\", props, ...children)）");
  assert.match(helpers, /ReactDOM\.createPortal\(node, document\.body\)/,
    "dgOverlay 经 ReactDOM.createPortal 挂到 document.body");
  assert.match(helpers, /if \(typeof document === "undefined" \|\| !document\.body\) return node;/,
    "无 document（vm/SSR 场景）时退化为裸节点，不抛错");
});

test("g-343 契约：19 个内联浮层调用点全部改走 dgOverlay（无裸 h(\"div\", { style: S.overlay …）)", () => {
  const bare = bundle.match(/h\("div", \{ style: S\.overlay/g) ?? [];
  assert.equal(bare.length, 0, "生成 bundle：不允许残留内联 h(\"div\", { style: S.overlay … 浮层");
  const calls = bundle.match(/dgOverlay\(/g) ?? [];
  assert.equal(calls.length, 20, "生成 bundle：19 个浮层调用点 + 1 处函数定义 = 20");
  // g-181 既有契约不回归：guard 仍逐一挂在浮层上
  const guarded = bundle.match(/style: S\.overlay, \.\.\.\w+Guard/g) ?? [];
  assert.equal(guarded.length, 19, "生成 bundle：19 个父级 overlay 仍全部接 guard");
});

test("g-343 契约：composerSeat 规则块不得再把 composer 降到 z-index:0（保留 pointer-events 禁用）", () => {
  const block = composerRuleBlock(constants);
  assert.doesNotMatch(block, /z-index:\s*0\s*!important/,
    "composerSeat 规则块禁止 z-index:0 !important：那会让子树内 z-index≥1 的卡片翻到 composer 之前");
  assert.doesNotMatch(block, /z-index\s*:/,
    "composerSeat 规则块不再声明 z-index，composer 保持原生 7（浮层已 portal 到 body）");
  assert.match(block, /pointer-events: none !important/,
    "保留 pointer-events:none !important（g-216 的点击穿透禁用语义）");
  // 三个选择器形状保持不变（宿主结构依赖）
  for (const sel of [
    ".wSkVaW_root:has(.dg-modal-open) .wSkVaW_composerSeat",
    ".wSkVaW_body:has(.dg-modal-open) .wSkVaW_composerSeat",
    'body:has(.dg-modal-open) [class*="composerSeat"]',
  ]) {
    assert.ok(block.includes(sel), `composerSeat 规则块保留选择器 ${sel}`);
  }
});

test("g-343 契约：g-216 的另一半（widthHandle 降级/隐藏）不回归", () => {
  assert.match(constants, /\.wSkVaW_root:has\(\.dg-kanban-root\) \.wSkVaW_widthHandle/,
    "constants.js 保留「看板打开时降下 widthHandle」规则");
  assert.match(constants, /\.wSkVaW_root:has\(\.dg-modal-open\) \.wSkVaW_widthHandle/,
    "constants.js 保留「弹窗/抽屉打开时隐藏 widthHandle」规则");
  assert.match(constants, /body:has\(\[style\*="position: fixed"\]\) \[data-width-handle\]/,
    "constants.js 保留按内联 position:fixed 隐藏 widthHandle 的兜底规则（浮层 portal 到 body 后仍命中）");
  const widthBlock = constants.slice(constants.indexOf(".wSkVaW_root:has(.dg-kanban-root) .wSkVaW_widthHandle"),
    constants.indexOf("/* 弹窗与抽屉打开时禁用 composer"));
  assert.match(widthBlock, /display: none !important/);
});

// dsh-graph 模块开关的**界面呈现裁剪**纯函数模块（g-494）
//
// 负责人 2026-10-12：「功能开关中，关闭的功能对应的功能入口应隐藏，比如记忆模块关闭后，
// 应隐藏记忆按钮」——关闭 ⇒ **隐藏**（不是置灰/禁用）。本模块是这一判定在**客户端呈现层**的
// **唯一实现**，供 kanban.js / goal-modal.js / card-drawer.js 等调用，并让 core/tests 断言
// 同一份真实实现（与 search-state.js / board-retain.js 同模式）。
//
// 同源铁律（判据 2）：界面隐藏与「服务端真裁剪」读**同一份**开关状态 —— 服务端在
// `/api/dsh-graph` 看板载荷里下发 `modules`（由 core `boardPayload` 经**同一个**
// `resolveModuleSwitches` 从 `project.yaml` 的 `modules` 段解析）。本模块**不自备**开关副本、
// **不解析 project.yaml**、也不引入任何第二真源；它只回答「已下发的开关值 ⇒ 这个入口是否渲染」。
//
// fail-safe 铁律：载荷缺 `modules` / 缺某键 / 值非布尔（老服务端、异常载荷）一律视为**开启** ⇒
// 入口照常渲染。绝不出现「界面比能力更严」（入口被藏、服务端其实还留着能力）这种一侧裁剪。
// 反向的「服务端已裁、界面仍留入口」由服务端下发同源值消除：两侧同读一份 modules。

/* exported MODULE_UI_ENTRIES, moduleEnabled, visibleModuleEntries */

/**
 * 模块 id 闭集 —— 与 core `HARNESS_MODULE_IDS` 同源同序（浏览器 bundle 无法 import core 常量，
 * 故此处是按既有惯例的**副本**；两边一致性由 core/tests/g494-module-ui-trim.test.ts 的
 * 前后端对账断言钉住，改一边不改另一边必红）。
 */
const MODULE_UI_IDS = ["tags", "memory", "shared_cards", "automation_prompts", "attachments"];

/**
 * **界面入口清单**（模块 → 该模块关闭时必须一并隐藏的全部界面入口）。
 *
 * 这是「哪些入口受哪个模块管辖」的**唯一映射表**（与 core `MODULE_TOOL_NAMES` 的「工具面」
 * 映射同构、互不替代）：`key` 是稳定入口标识（也是守卫与负例断言的锚点），`container` 说明
 * 入口所在的界面容器（用于判据 4「不留孤儿 UI」：容器/分隔符/分组标题随容器内最后一个入口
 * 消失而消失）。
 *
 * 登记口径 —— 只登记**该模块独占**的功能入口；与模块无关的通用入口（刷新 / 设置 / 使用说明 /
 * 版本管理 / 创建版本 / 显示已归档 / 搜索）**一律不登记**，绝不因某个模块关闭而误删通用入口。
 */
const MODULE_UI_ENTRIES = {
  tags: [
    { key: "tagfilter", container: "head-toolbar", label_key: "tagFilter.title" },
    { key: "tagclear", container: "head-toolbar", label_key: "tagFilter.clear" },
    { key: "goal-tags-editor", container: "goal-modal-subtitle", label_key: "tags.title" },
  ],
  memory: [
    { key: "memory", container: "head-toolbar", label_key: "memory.btn" },
  ],
  shared_cards: [
    { key: "shared", container: "head-toolbar", label_key: "shared.title" },
  ],
  // 纯提示词面模块：没有任何界面功能入口（关闭只在模型面裁剪，界面零变化）。
  automation_prompts: [],
  // 附件：界面上的 `@att/` 只是**卡片正文的引用展示**（不是独立功能入口，见交付清单「未隐藏项」），
  // 其写入能力入口在目标/卡片的收集提示词区（不注册为独立按钮）⇒ 无独立界面入口。
  attachments: [],
};

/**
 * 已下发开关下，某模块是否**可用**（决定其界面入口是否渲染）。
 *
 * fail-safe：载荷缺失/畸形/键缺失 ⇒ `true`（渲染入口）。只有**显式布尔 false** 才隐藏。
 *
 * @param {object|null|undefined} modules 看板载荷的 `modules` 字段（`{ [id]: boolean }`）
 * @param {string} id 模块 id
 * @returns {boolean}
 */
function moduleEnabled(modules, id) {
  if (!modules || typeof modules !== "object") return true;
  const v = modules[id];
  // 只有**真布尔 false** 才判关闭；undefined / null / 字符串 / 数字一律视为开启（fail-safe）。
  return v !== false;
}

/**
 * 某容器下**可见**的模块入口 key 列表（按清单声明序）。
 *
 * 用途：判据 4「不留孤儿 UI」——调用方据此判定「该容器内是否还有任何模块入口可见」，
 * 从而决定容器/分隔符/分组标题本身是否渲染（**由内容驱动**，不新增第二份容器开关）。
 *
 * @param {object|null|undefined} modules 看板载荷的 `modules` 字段
 * @param {string} container 容器标识
 * @returns {string[]} 该容器内可见入口的 key 列表
 */
function visibleModuleEntries(modules, container) {
  const out = [];
  for (const id of MODULE_UI_IDS) {
    for (const e of MODULE_UI_ENTRIES[id] ?? []) {
      if (e.container !== container) continue;
      if (!moduleEnabled(modules, id)) continue;
      out.push(e.key);
    }
  }
  return out;
}

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export { MODULE_UI_ENTRIES, MODULE_UI_IDS, moduleEnabled, visibleModuleEntries };
// <<<ESM-EXPORTS-END<<<

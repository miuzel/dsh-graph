// dsh-graph — 浏览器半边（npm 包名 = dsh-graph；内部 host 插件 id 保留 dsh-graph-host）：手写 classic script，零构建。
// 二维泳道看板。视觉约定：卡片类型用「粗左边框 + 颜色 + 图标」区分；
// 依赖关系用琥珀色左边框 + 「⛓ 等待」标识；详情走 modal 弹窗；事件话术人类化。
window.__ModuleLoader__.load({
  id: "dsh-graph",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

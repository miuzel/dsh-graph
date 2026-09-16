/**
 * g-298: GUI 场景测试（拖拽、折叠、懒加载、刷新重开、窄视口）
 *
 * 本测试文件定义了关键 GUI 场景的操作序列和预期行为，
 * 用于指导 WebBridge 实机测试或人工复核。
 *
 * 注意：本测试是源码级契约测试，不是实机 GUI 测试。
 * 实机测试需要使用 kimi_webbridge 工具在隔离测试实例（3082）中执行。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const kanbanSource = readFileSync(join(hostRoot, "lib/client/kanban.js"), "utf8");
const cardDrawerSource = readFileSync(join(hostRoot, "lib/client/card-drawer.js"), "utf8");

// ===== 1. 拖拽场景契约 =====

test("g-298 拖拽场景：HTML5 拖拽 API 源码契约", () => {
  // kanban.js 使用 HTML5 拖拽 API（dragover, dragleave, drop 等）
  // 检查拖拽实现的关键模式

  // 1. 拖拽状态机
  assert.match(kanbanSource, /const \[drag, setDrag\] = React\.useState\(null\)/);

  // 2. 拖拽事件监听（document 级兜底）
  assert.match(kanbanSource, /document\.addEventListener\("dragover", acceptDrag\)/);
  assert.match(kanbanSource, /document\.addEventListener\("drop", acceptDrop\)/);

  // 3. 自动滚动支持（拖拽时自动滚动容器）
  assert.match(kanbanSource, /window\.addEventListener\("dragover", handleDragOver, true\)/);
  assert.match(kanbanSource, /window\.addEventListener\("dragleave", handleDragLeave, true\)/);

  // 4. 拖拽结束后清理事件监听器
  assert.match(kanbanSource, /document\.removeEventListener\("dragover", acceptDrag\)/);
  assert.match(kanbanSource, /document\.removeEventListener\("drop", acceptDrop\)/);

  // 5. 拖拽期间阻止默认行为
  assert.match(kanbanSource, /e\.preventDefault\(\)/);

  // 6. 拖拽效果设置（move 操作）
  assert.match(kanbanSource, /e\.dataTransfer\.dropEffect = "move"/);
});

// ===== 2. 折叠场景契约 =====

test("g-298 折叠场景：泳道折叠/展开源码契约", () => {
  // 折叠功能必须支持泳道和列的折叠/展开

  // 1. 折叠状态存储（使用 React state）
  assert.match(kanbanSource, /const \[collapsedLanes, setCollapsedLanes\] = React\.useState\(\{\}\)/);

  // 2. 阻塞列默认折叠
  assert.match(kanbanSource, /const \[blockedColumnCollapsed, setBlockedColumnCollapsed\] = React\.useState\(true\)/);

  // 3. 交付列默认展开
  assert.match(kanbanSource, /const \[deliverColumnCollapsed, setDeliverColumnCollapsed\] = React\.useState\(false\)/);

  // 4. 折叠状态判断
  assert.match(kanbanSource, /const isCollapsed = collapsible && !!collapsedLanes\[key\]/);

  // 5. 折叠状态持久化（可选）
  // assert.match(kanbanSource, /localStorage|sessionStorage/);
});

// ===== 3. 懒加载场景契约 =====

test("g-298 懒加载场景：成员变化后重新打开目标详情源码契约", () => {
  // 懒加载必须支持成员变化后的数据刷新

  // 1. 懒加载触发条件（lazy 参数）
  assert.match(kanbanSource, /const params = "\?lazy=1"/);

  // 2. 懒加载状态判断
  assert.match(kanbanSource, /lazy && !bd\.backlog_loaded/);
  assert.match(kanbanSource, /lazy && !ver\.loaded/);

  // 3. 数据刷新机制（reconcileRetainedBoardState）
  assert.match(kanbanSource, /reconcileRetainedBoardState/);

  // 4. 成员变化检测（计数对比）
  assert.match(kanbanSource, /bd\.backlog_count !== 0/);
  assert.match(kanbanSource, /ver\.goals_count !== 0/);
});

// ===== 4. 刷新重开场景契约 =====

test("g-298 刷新重开场景：整页刷新后重新打开目标/卡片源码契约", () => {
  // 刷新重开必须支持整页刷新后的状态恢复

  // 1. 数据加载函数
  assert.match(kanbanSource, /const load = \(\) =>/);

  // 2. 轮询刷新机制（30s 间隔）
  assert.match(kanbanSource, /30.*1000|30s|轮询/);

  // 3. 弹窗状态管理（modalGoal）
  assert.match(kanbanSource, /const \[modalGoal, setModalGoal\] = React\.useState\(null\)/);

  // 4. 弹窗关闭后强制补播更新动画
  assert.match(kanbanSource, /forceReplayRef|forceReplay/);

  // 5. 版本抽屉状态持久化（localStorage）
  assert.match(kanbanSource, /useHiddenVersionSlugs/);
});

// ===== 5. 窄视口场景契约 =====

test("g-298 窄视口场景：固定小视口下重复操作源码契约", () => {
  // 窄视口必须支持响应式布局

  // 1. 卡片抽屉视口自适应（card-drawer.js）
  assert.match(cardDrawerSource, /function clampDrawerWidth\(rawWidth, windowWidth\)/);
  assert.match(cardDrawerSource, /window\.innerWidth/);

  // 2. 窄视口保护（最小 380px）
  assert.match(cardDrawerSource, /MIN_CARD_DRAWER_WIDTH.*380/);

  // 3. 视口动态约束（最大 90vw）
  assert.match(cardDrawerSource, /Math\.min\(MAX_CARD_DRAWER_WIDTH, winW \* 0\.9\)/);

  // 4. 视口变化监听
  assert.match(cardDrawerSource, /window\.addEventListener\("resize", handleResize\)/);
  assert.match(cardDrawerSource, /window\.removeEventListener\("resize", handleResize\)/);
});

// ===== 6. 证据模板契约 =====

test("g-298 证据模板：必须包含的字段", () => {
  // 证据模板必须包含以下字段（检查模板文件存在性）
  const templatePath = join(import.meta.dirname, "../../docs/gui-test-evidence-template.md");
  const templateContent = readFileSync(templatePath, "utf8");

  // 检查关键字段
  assert.match(templateContent, /证据 ID/);
  assert.match(templateContent, /关联目标/);
  assert.match(templateContent, /关联候选/);
  assert.match(templateContent, /测试环境/);
  assert.match(templateContent, /场景类型/);
  assert.match(templateContent, /操作序列/);
  assert.match(templateContent, /预期行为/);
  assert.match(templateContent, /实际行为/);
  assert.match(templateContent, /证据附件/);
  assert.match(templateContent, /判定/);
  assert.match(templateContent, /PASS.*FAIL.*UNVERIFIED/);
});

// ===== 7. Fixture 版本化契约 =====

test("g-298 Fixture 版本化：检查清单文件存在性", () => {
  const checklistPath = join(import.meta.dirname, "../../docs/fixture-versioning-checklist.md");
  const checklistContent = readFileSync(checklistPath, "utf8");

  // 检查关键部分
  assert.match(checklistContent, /Mock Seed/);
  assert.match(checklistContent, /测试实例/);
  assert.match(checklistContent, /核心测试/);
  assert.match(checklistContent, /版本化操作规则/);
  assert.match(checklistContent, /验证命令/);
});

// ===== 8. 真实交互要求契约 =====

test("g-298 真实交互要求：拖拽必须使用真实指针", () => {
  // kanban.js 使用 HTML5 拖拽 API，这是浏览器原生支持的真实交互
  // 检查拖拽实现使用标准 API

  // HTML5 拖拽 API 事件（浏览器原生支持）
  assert.match(kanbanSource, /document\.addEventListener\("dragover"/);
  assert.match(kanbanSource, /document\.addEventListener\("drop"/);

  // 拖拽效果设置（浏览器原生 API）
  assert.match(kanbanSource, /e\.dataTransfer\.dropEffect/);

  // 不得使用合成事件（检查常见模式）
  assert.doesNotMatch(kanbanSource, /dispatchEvent.*DragEvent/);
  assert.doesNotMatch(kanbanSource, /new DragEvent/);
});

test("g-298 真实交互要求：窄视口必须使用固定尺寸", () => {
  // 检查 card-drawer.js 中的视口处理
  // 必须支持固定小视口（如 375x667）

  // 视口自适应逻辑
  assert.match(cardDrawerSource, /windowWidth|viewportWidth/);
  assert.match(cardDrawerSource, /clampDrawerWidth.*windowWidth/);

  // 窄视口保护
  assert.match(cardDrawerSource, /MIN_CARD_DRAWER_WIDTH.*380/);
});

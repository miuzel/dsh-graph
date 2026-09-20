import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CARD_DRAWER_WIDTH,
  MIN_CARD_DRAWER_WIDTH,
  MAX_CARD_DRAWER_WIDTH,
  CARD_DRAWER_STORAGE_KEY,
  clampDrawerWidth,
  readDrawerWidth,
  writeDrawerWidth,
} from "../../dsh-graph-host/lib/client/card-drawer.js";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const helpersSource = readFileSync(join(hostRoot, "lib/client/helpers.js"), "utf8");
const cardDrawerSource = readFileSync(join(hostRoot, "lib/client/card-drawer.js"), "utf8");
const distRoot = join(import.meta.dirname, "../../dist");
const clientBundleSource = readFileSync(join(distRoot, "lib/client.js"), "utf8");
const i18nSource = readFileSync(join(hostRoot, "lib/client/i18n.js"), "utf8");

// Mock Storage helper for read/writeDrawerWidth tests
function createMockStorage(initial: Record<string, string> = {}, shouldThrow = false) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string): string | null {
      if (shouldThrow) throw new Error("Storage failure");
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      if (shouldThrow) throw new Error("Storage failure");
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      if (shouldThrow) throw new Error("Storage failure");
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}

test("g-280 判据5: clampDrawerWidth 纯函数 - 默认值、钳位与非法值容错", () => {
  assert.equal(DEFAULT_CARD_DRAWER_WIDTH, 400);
  assert.equal(MIN_CARD_DRAWER_WIDTH, 380);
  assert.equal(MAX_CARD_DRAWER_WIDTH, 1200);

  // 非法值安全回退 400px
  assert.equal(clampDrawerWidth(NaN, 1920), 400);
  assert.equal(clampDrawerWidth(undefined as any, 1920), 400);
  assert.equal(clampDrawerWidth(null as any, 1920), 400);
  assert.equal(clampDrawerWidth("invalid", 1920), 400);

  // 正常范围内数值保持原样
  assert.equal(clampDrawerWidth(400, 1920), 400);
  assert.equal(clampDrawerWidth(500, 1920), 500);
  assert.equal(clampDrawerWidth(850, 1920), 850);
  assert.equal(clampDrawerWidth(1200, 1920), 1200);

  // 字符串解析与浮点数取整
  assert.equal(clampDrawerWidth("600", 1920), 600);
  assert.equal(clampDrawerWidth("650px", 1920), 650);
  assert.equal(clampDrawerWidth(450.4, 1920), 450);
  assert.equal(clampDrawerWidth(450.6, 1920), 451);
});

test("g-280 判据3: clampDrawerWidth 边界钳位与视口自适应", () => {
  // 下限钳位：最小 380px
  assert.equal(clampDrawerWidth(100, 1920), 380);
  assert.equal(clampDrawerWidth(0, 1920), 380);
  assert.equal(clampDrawerWidth(-50, 1920), 380);
  assert.equal(clampDrawerWidth(379, 1920), 380);
  assert.equal(clampDrawerWidth(380, 1920), 380);

  // 上限钳位：宽视口下最大 1200px
  assert.equal(clampDrawerWidth(1201, 1920), 1200);
  assert.equal(clampDrawerWidth(2000, 1920), 1200);

  // 视口动态约束：最大 min(1200, window.innerWidth * 0.9)
  // windowWidth = 1000 -> 90vw = 900
  assert.equal(clampDrawerWidth(950, 1000), 900);
  assert.equal(clampDrawerWidth(1500, 1000), 900);
  assert.equal(clampDrawerWidth(700, 1000), 700);

  // windowWidth = 800 -> 90vw = 720
  assert.equal(clampDrawerWidth(750, 800), 720);
  assert.equal(clampDrawerWidth(720, 800), 720);

  // windowWidth = 500 -> 90vw = 450
  assert.equal(clampDrawerWidth(500, 500), 450);
  assert.equal(clampDrawerWidth(400, 500), 400);

  // 超小视口保护：windowWidth = 350 -> 90vw = 315，自适应不溢出视口
  assert.equal(clampDrawerWidth(400, 350), 315);
});

test("g-280 判据4: readDrawerWidth 纯函数 - 读取持久化宽度与回退机制", () => {
  assert.equal(CARD_DRAWER_STORAGE_KEY, "dg-card-drawer-width");

  // Storage 为空或无 key 时回退默认 400
  assert.equal(readDrawerWidth(null, 1920), 400);
  assert.equal(readDrawerWidth(createMockStorage(), 1920), 400);

  // 非法值回退默认 400
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "" }), 1920), 400);
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "abc" }), 1920), 400);
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "-10" }), 1920), 400);
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "0" }), 1920), 400);

  // 合法值正常恢复
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "550" }), 1920), 550);

  // 读到超出边界的值时安全钳位
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "200" }), 1920), 380);
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "2000" }), 1920), 1200);

  // 读到超出当前视口的值时安全钳位到当前视口安全范围
  assert.equal(readDrawerWidth(createMockStorage({ [CARD_DRAWER_STORAGE_KEY]: "800" }), 600), 540);

  // Storage 抛出异常时不崩溃，安全回退
  assert.equal(readDrawerWidth(createMockStorage({}, true), 1920), 400);
});

test("g-280 判据4: writeDrawerWidth 纯函数 - 保存持久化宽度", () => {
  const storage = createMockStorage();

  // 写入有效宽度
  const res1 = writeDrawerWidth(650, storage, 1920);
  assert.equal(res1, 650);
  assert.equal(storage.getItem(CARD_DRAWER_STORAGE_KEY), "650");

  // 写入超限宽度，先钳位再保存
  const res2 = writeDrawerWidth(2000, storage, 1920);
  assert.equal(res2, 1200);
  assert.equal(storage.getItem(CARD_DRAWER_STORAGE_KEY), "1200");

  // 写入低于下限宽度，先钳位再保存
  const res3 = writeDrawerWidth(100, storage, 1920);
  assert.equal(res3, 380);
  assert.equal(storage.getItem(CARD_DRAWER_STORAGE_KEY), "380");

  // Storage 抛出异常时不崩溃
  const throwingStorage = createMockStorage({}, true);
  assert.equal(writeDrawerWidth(500, throwingStorage, 1920), 500);
});

test("g-280 判据5: 公共样式 S.drawer 隔离与源码契约", () => {
  // helpers.js 中的公共样式 S.drawer 必须保持 width: 400 硬编码不变（不被修改或污染）
  assert.match(helpersSource, /drawer:\s*\{[^}]*width:\s*400/);

  // card-drawer.js 必须使用局部内联覆盖宽度，不修改 S.drawer
  assert.match(cardDrawerSource, /style:\s*\{\s*\.\.\.S\.drawer,\s*width\s*\}/);

  // 初始 state 读自 readDrawerWidth()
  assert.match(cardDrawerSource, /const\s+\[width,\s*setWidth\]\s*=\s*React\.useState\(\(\)\s*=>\s*readDrawerWidth\(\)\)/);
});

test("g-280 判据1与判据2: 拖拽手柄感应区、光标与事件监听生命周期契约", () => {
  // 手柄样式与属性契约
  assert.match(cardDrawerSource, /dg-card-drawer-resize-handle/);
  assert.match(cardDrawerSource, /data-testid":\s*"card-drawer-resize-handle"/);
  assert.match(cardDrawerSource, /width:\s*6/);
  assert.match(cardDrawerSource, /cursor:\s*"col-resize"/);
  assert.match(cardDrawerSource, /position:\s*"absolute"/);
  assert.match(cardDrawerSource, /left:\s*0/);

  // 拖拽手柄上 mousedown/click 必须阻断冒泡，不得触发遮罩 onClose
  assert.match(cardDrawerSource, /const handleResizeMouseDown\s*=\s*\(e\)\s*=>\s*\{[^}]*e\.stopPropagation\(\)/);
  assert.match(cardDrawerSource, /onClick:\s*\(e\)\s*=>\s*e\.stopPropagation\(\)/);

  // 双击复位 400px
  assert.match(cardDrawerSource, /handleResizeDoubleClick/);
  assert.match(cardDrawerSource, /clampDrawerWidth\(DEFAULT_CARD_DRAWER_WIDTH/);

  // 拖拽期间 user-select: none 与 cursor: col-resize
  assert.match(cardDrawerSource, /document\.body\.style\.userSelect\s*=\s*"none"/);
  assert.match(cardDrawerSource, /document\.body\.style\.cursor\s*=\s*"col-resize"/);

  // mousemove 与 mouseup 挂载在 window 上
  assert.match(cardDrawerSource, /window\.addEventListener\("mousemove",\s*handleMouseMove\)/);
  assert.match(cardDrawerSource, /window\.addEventListener\("mouseup",\s*handleMouseUp\)/);

  // 卸载与拖拽结束时平滑解绑监听（防幽灵拖拽与泄漏）
  assert.match(cardDrawerSource, /window\.removeEventListener\("mousemove",\s*handleMouseMove\)/);
  assert.match(cardDrawerSource, /window\.removeEventListener\("mouseup",\s*handleMouseUp\)/);
  assert.match(cardDrawerSource, /document\.body\.style\.userSelect\s*=\s*prevUserSelect/);
  assert.match(cardDrawerSource, /document\.body\.style\.cursor\s*=\s*prevCursor/);

  // 视口自适应 resize 监听与解绑
  assert.match(cardDrawerSource, /window\.addEventListener\("resize",\s*handleResize\)/);
  assert.match(cardDrawerSource, /window\.removeEventListener\("resize",\s*handleResize\)/);

  // client.js 编译产物必须同步包含对应实现
  assert.match(clientBundleSource, /dg-card-drawer-resize-handle/);
  assert.match(clientBundleSource, /style:\s*\{\s*\.\.\.S\.drawer,\s*width\s*\}/);
  assert.match(clientBundleSource, /window\.addEventListener\("mousemove"/);
  assert.match(clientBundleSource, /window\.removeEventListener\("mousemove"/);
});

test("g-280 判据与 i18n 契约: drawer.resizeTip 存在且双语对称", () => {
  assert.match(i18nSource, /'drawer\.resizeTip':\s*'拖拽调整宽度（双击恢复默认）'/);
  assert.match(i18nSource, /'drawer\.resizeTip':\s*'Drag to resize \(double-click to reset\)'/);
});

#!/usr/bin/env node
/**
 * g-294 历史缺陷验证：backlog 卡片类型切换后看板是否立即更新
 * 
 * 有缺陷基线 (6a87cf9): 类型切换后卡片显示旧类型（需刷新）
 * 修复候选 (d76b0c5): 类型切换后卡片立即显示新类型
 * 
 * 用法: node scripts/g294-verify.js <baseline|fixed>
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const MODE = process.argv[2];
if (!MODE || !['baseline', 'fixed'].includes(MODE)) {
  console.error('Usage: node scripts/g294-verify.js <baseline|fixed>');
  process.exit(1);
}

const WORKSPACE = path.resolve(__dirname, '../tmp/g294-verify/workspace');
const SCREENSHOT_DIR = path.resolve(__dirname, '../tmp/g294-verify/screenshots');
const GRAPH_ROOT = path.join(WORKSPACE, '.dsh-graph');

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function main() {
  console.log(`[g-294 verify] Mode: ${MODE}`);
  console.log(`[g-294 verify] Workspace: ${WORKSPACE}`);
  
  const browser = await chromium.launch({ 
    headless: true,
    executablePath: path.resolve(__dirname, '../tmp/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
  });
  
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  
  try {
    // 1. 打开看板（使用 g-294-verify workspace）
    console.log('[1/5] Opening kanban with g-294-verify workspace...');
    const token = 'y5EawHWcZ0fukc8RODlpk8mvUAlWzWCewkI0AJpDxMU';
    await page.goto(`http://127.0.0.1:3082/?token=${token}&workspace=${encodeURIComponent(WORKSPACE)}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${MODE}-01-initial.png`) });
    
    // 2. 找到 backlog 卡片并记录初始类型
    console.log('[2/5] Finding backlog card...');
    const card = await page.locator('[data-goal-id="g-001"]').first();
    if (!await card.isVisible()) {
      throw new Error('Backlog card g-001 not found');
    }
    
    const initialType = await card.locator('.dg-type-badge, [class*="type"]').textContent().catch(() => 'unknown');
    console.log(`  Initial type: ${initialType}`);
    
    // 3. 点击类型 badge 打开切换器
    console.log('[3/5] Clicking type badge...');
    const typeBadge = await card.locator('.dg-type-badge, [class*="type"]').first();
    await typeBadge.click();
    await page.waitForTimeout(500);
    
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${MODE}-02-type-selector.png`) });
    
    // 4. 选择新类型（feature）
    console.log('[4/5] Selecting new type (feature)...');
    const featureOption = await page.locator('[data-type="feature"], .dg-type-option:has-text("feature")').first();
    if (!await featureOption.isVisible()) {
      throw new Error('Type option "feature" not found');
    }
    await featureOption.click();
    await page.waitForTimeout(1000);
    
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${MODE}-03-after-type-change.png`) });
    
    // 5. 检查类型是否立即更新（不刷新页面）
    console.log('[5/5] Checking type update without refresh...');
    const updatedCard = await page.locator('[data-goal-id="g-001"]').first();
    const updatedType = await updatedCard.locator('.dg-type-badge, [class*="type"]').textContent().catch(() => 'unknown');
    console.log(`  Updated type: ${updatedType}`);
    
    const typeChanged = updatedType !== initialType && updatedType.toLowerCase().includes('feature');
    
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${MODE}-04-final.png`) });
    
    const result = {
      mode: MODE,
      initialType,
      updatedType,
      typeChanged,
      consoleErrors: consoleErrors.length,
      verdict: typeChanged ? 'PASS (类型立即更新)' : 'FAIL (类型未更新或需刷新)'
    };
    
    console.log('\n[g-294 verify] Result:');
    console.log(JSON.stringify(result, null, 2));
    
    fs.writeFileSync(
      path.join(SCREENSHOT_DIR, `${MODE}-result.json`),
      JSON.stringify(result, null, 2)
    );
    
    await browser.close();
    process.exit(typeChanged ? 0 : 1);
    
  } catch (error) {
    console.error('[g-294 verify] Error:', error.message);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${MODE}-error.png`) });
    await browser.close();
    process.exit(2);
  }
}

main();

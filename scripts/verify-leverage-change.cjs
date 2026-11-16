const { chromium } = require('playwright');

async function testLeverage() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log('1. Loading dashboard http://localhost:4080...');
  await page.goto('http://localhost:4080', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Pin nav so it is permanently visible
  await page.evaluate(() => {
    if (typeof revealStealthNav === 'function') revealStealthNav(0);
    document.body.classList.add('nav-pinned', 'nav-revealed');
  });
  await page.waitForTimeout(300);

  // Check top navbar badge
  const navLevBadge = page.locator('#navLevBadge');
  console.log('Nav lev badge initial text:', await navLevBadge.textContent());

  // Test 1: Click #navLevBadge to open dropdown
  console.log('2. Clicking #navLevBadge to open nav dropdown...');
  await page.evaluate(() => toggleNavLevDropdown());
  await page.waitForTimeout(300);
  const ddVisible = await page.locator('#navLevDropdown').isVisible();
  console.log('Nav lev dropdown visible:', ddVisible);
  if (!ddVisible) throw new Error('navLevDropdown did not open!');

  // Click 25x in dropdown
  console.log('3. Clicking 25x in dropdown...');
  await page.locator('#navLevDropdown button[data-lev="25"]').click();
  await page.waitForTimeout(800);

  const badgeAfter25 = await navLevBadge.textContent();
  console.log('Nav lev badge after 25x preset in dropdown:', badgeAfter25);
  if (badgeAfter25.trim() !== 'x25') throw new Error(`Expected x25, got ${badgeAfter25}`);

  // Test 2: Switch to Strategy tab and check Card 1
  console.log('4. Switching to Strategy tab...');
  await page.evaluate(() => switchTab('strategy'));
  await page.waitForTimeout(600);

  const cfgLevVal = await page.locator('#cfgLev').inputValue();
  console.log('Strategy tab #cfgLev value:', cfgLevVal);
  if (cfgLevVal !== '25') throw new Error(`Expected cfgLev to be 25, got ${cfgLevVal}`);

  const is25Active = await page.locator('#levPresetsWrap button[data-lev="25"]').evaluate(el => el.classList.contains('active'));
  console.log('Preset 25x in Card 1 is active:', is25Active);
  if (!is25Active) throw new Error('Preset 25x in Card 1 should have .active class!');

  // Test 3: Click 100x preset in Card 1
  console.log('5. Clicking 100x preset in Card 1...');
  await page.locator('#levPresetsWrap button[data-lev="100"]').click();
  await page.waitForTimeout(800);

  const badgeAfter100 = await navLevBadge.textContent();
  const cfgLevAfter100 = await page.locator('#cfgLev').inputValue();
  const feedbackText = await page.locator('#levApplyFeedback').textContent();
  console.log('Badge after 100x:', badgeAfter100, '| #cfgLev:', cfgLevAfter100, '| Feedback:', feedbackText);
  if (badgeAfter100.trim() !== 'x100' || cfgLevAfter100 !== '100') {
    throw new Error(`Expected 100x, got badge=${badgeAfter100}, input=${cfgLevAfter100}`);
  }

  // Test 4: Custom input to 50 + click Apply
  console.log('6. Entering 50 in #cfgLev and clicking #btnApplyLevDirect...');
  await page.locator('#cfgLev').fill('50');
  await page.locator('#btnApplyLevDirect').click();
  await page.waitForTimeout(800);

  const badgeAfter50 = await navLevBadge.textContent();
  console.log('Badge after applying 50x:', badgeAfter50);
  if (badgeAfter50.trim() !== 'x50') throw new Error(`Expected x50, got ${badgeAfter50}`);

  // Test 5: Verify SSE polling does not revert back
  console.log('7. Waiting 2.5s to verify SSE broadcast preserves leverage x50...');
  await page.waitForTimeout(2500);
  const badgeAfterSSE = await navLevBadge.textContent();
  console.log('Badge after waiting 2.5s of SSE ticks:', badgeAfterSSE);
  if (badgeAfterSSE.trim() !== 'x50') throw new Error(`SSE reverted leverage! Expected x50, got ${badgeAfterSSE}`);

  console.log('🎉 ALL LEVERAGE TESTS PASSED PERFECTLY!');
  await browser.close();
}

testLeverage().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(err.message));

  console.log('1. Loading http://localhost:4080...');
  await page.goto('http://localhost:4080', { waitUntil: 'domcontentloaded' });

  console.log('2. Opening Strategy tab...');
  await page.evaluate(() => switchTab('strategy'));
  await page.waitForTimeout(500);

  console.log('3. Switching to % Capital and setting 1.8%...');
  await page.evaluate(() => {
    setRiskMode('pct');
    document.getElementById('cfgRiskPct').value = '1.8';
    updateLiveRiskCalculator();
  });

  console.log('4. Waiting 3 seconds through SSE / renderAll cycles...');
  await page.waitForTimeout(3000);

  const dom1 = await page.evaluate(() => ({
    activeBtn: document.querySelector('#riskModeSwitch button.active')?.getAttribute('data-mode'),
    pctVisible: document.getElementById('cfgRiskPct')?.style.display,
    pctVal: document.getElementById('cfgRiskPct')?.value,
    amtVisible: document.getElementById('cfgRiskAmount')?.style.display
  }));

  console.log('DOM state in % Capital mode:', dom1);
  assert.strictEqual(dom1.activeBtn, 'pct', 'Mode button must remain "pct"');
  assert.strictEqual(dom1.pctVisible, 'block', '% input must remain visible');
  assert.strictEqual(dom1.pctVal, '1.8', '% input value must be preserved');
  assert.strictEqual(dom1.amtVisible, 'none', 'Amount input must remain hidden');

  console.log('5. Saving settings...');
  await page.evaluate(() => validateAndSaveRiskSettings(true));
  await page.waitForTimeout(1000);

  const state1 = await page.evaluate(async () => {
    const res = await fetch('/api/state');
    return res.json();
  });
  console.log('Saved settings (% Capital):', {
    riskMode: state1.settings.riskMode,
    maxRiskPct: state1.settings.maxRiskPct
  });
  assert.strictEqual(state1.settings.riskMode, 'pct');
  assert.strictEqual(Math.round(state1.settings.maxRiskPct * 1000) / 1000, 0.018);

  console.log('6. Switching to Montant (€ / $) mode (100 €)...');
  await page.evaluate(() => setQuickRiskAmount(100));
  await page.waitForTimeout(2000);

  const dom2 = await page.evaluate(() => ({
    activeBtn: document.querySelector('#riskModeSwitch button.active')?.getAttribute('data-mode'),
    amtVisible: document.getElementById('cfgRiskAmount')?.style.display,
    amtVal: document.getElementById('cfgRiskAmount')?.value,
    pctVisible: document.getElementById('cfgRiskPct')?.style.display
  }));
  console.log('DOM state in Montant mode:', dom2);
  assert.strictEqual(dom2.activeBtn, 'amount');
  assert.strictEqual(dom2.amtVal, '100');

  console.log('7. Saving settings (Montant 100 €)...');
  await page.evaluate(() => validateAndSaveRiskSettings(true));
  await page.waitForTimeout(1000);

  const state2 = await page.evaluate(async () => {
    const res = await fetch('/api/state');
    return res.json();
  });
  console.log('Saved settings (Montant):', {
    riskMode: state2.settings.riskMode,
    riskAmount: state2.settings.riskAmount
  });
  assert.strictEqual(state2.settings.riskMode, 'amount');
  assert.strictEqual(state2.settings.riskAmount, 100);

  await browser.close();
  assert.strictEqual(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join(', ')}`);
  console.log('✅ ALL VERIFICATIONS PASSED: Strategy mode switching is 100% functional, responsive and durable.');
})();

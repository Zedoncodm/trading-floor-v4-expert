const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push(err.message);
  });

  console.log('Navigating to http://localhost:4080...');
  await page.goto('http://localhost:4080', { waitUntil: 'networkidle' });

  // Open "Stratégie" tab using shortcut or evaluate
  console.log('Opening Strategy tab via switchTab("strategy")...');
  await page.evaluate(() => switchTab('strategy'));
  await page.waitForTimeout(500);

  // Switch Risk mode to amount (€ / $)
  console.log('Selecting Montant (€ / $) for Risk...');
  await page.click('#riskModeSwitch button[data-mode="amount"]');
  await page.waitForTimeout(300);

  // Click on preset 100 €
  await page.click('#riskAmountPresets button:has-text("100 €")');

  // Switch SL mode to amount
  console.log('Selecting Montant Fixe (€ / $) for Stop-Loss...');
  await page.click('#slModeSwitch button[data-mode="amount"]');
  await page.waitForTimeout(300);
  await page.click('#slAmountPresets button:has-text("-100 €")');

  // Switch TP mode to amount
  console.log('Selecting Montant (€ / $) for Take-Profit...');
  await page.click('#tpModeSwitch button[data-mode="amount"]');
  await page.waitForTimeout(300);
  await page.click('#tpAmountPresets button:has-text("+200 €")');

  await page.waitForTimeout(400);

  // Check live calculator summary
  const summaryText = await page.innerText('#liveRiskSummaryBox');
  console.log('Live Risk Summary:\n', summaryText);

  // Save settings
  console.log('Saving settings...');
  await page.click('#btnSaveRisk');
  await page.waitForTimeout(500);

  // If danger modal is visible (due to high leverage or high risk), click confirm
  const dangerModal = await page.$('#dangerRiskModal.open');
  if (dangerModal) {
    console.log('Confirming danger modal...');
    await page.evaluate(() => confirmSaveDangerRisk());
    await page.waitForTimeout(500);
  }

  // Take screenshot of strategy section
  const screenshotPath = path.resolve('data', 'strategy-euro-unlocked.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Screenshot saved to:', screenshotPath);

  console.log('Console errors count:', consoleErrors.length);
  if (consoleErrors.length > 0) {
    console.error('Console errors:', consoleErrors);
  }

  await browser.close();
  if (consoleErrors.length > 0) {
    process.exit(1);
  } else {
    console.log('✅ Strategy euro unlocked verification PASSED with 0 errors.');
  }
})();

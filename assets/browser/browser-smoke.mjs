import { createRequire } from 'node:module';

const require = createRequire('/opt/claude-browser/package.json');
const { chromium } = require('playwright');
const screenshot = '/srv/claude-browser-share/browser-smoke.png';

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.setContent(`
    <!doctype html>
    <html><head><title>browser-runtime-ok</title></head>
    <body><button id="probe" onclick="this.textContent='browser-runtime-ok'">probe</button></body></html>
  `);
  await page.click('#probe');
  const result = await page.textContent('#probe');
  if (result !== 'browser-runtime-ok') throw new Error(`DOM probe failed: ${result}`);
  await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({
    ok: true,
    title: await page.title(),
    browserVersion: browser.version(),
    screenshot,
  }));
} finally {
  await browser?.close();
}

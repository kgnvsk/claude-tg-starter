#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error('Usage: browser-pdf.mjs <input.html> [output.pdf]');
  process.exit(2);
}

const input = resolve(inputArg);
const output = resolve(outputArg || input.replace(/\.html?$/i, '') + '.pdf');
await mkdir(dirname(output), { recursive: true });

const require = createRequire('/opt/claude-browser/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(input).href, { waitUntil: 'load', timeout: 30000 });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: output,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
  });
  const info = await stat(output);
  if (info.size === 0) throw new Error('generated PDF is empty');
  console.log(output);
} finally {
  await browser.close();
}

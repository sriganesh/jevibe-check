import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Render the vendored Lucide Message Circle Check icon; no generated or hand-drawn icon paths.
const svg = await readFile(new URL('../extension/icons/message-circle-check.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({viewport: {width: size, height: size}, deviceScaleFactor: 1});
    await page.setContent(`<style>html,body{margin:0;background:transparent}.icon{width:100vw;height:100vh;border-radius:24%;background:#FFD1B8;display:grid;place-items:center;color:#67301C}.icon svg{width:76%;height:76%}</style><div class="icon">${svg}</div>`);
    await page.screenshot({path: fileURLToPath(new URL(`../extension/icons/icon-${size}.png`, import.meta.url)), omitBackground: true});
    await page.close();
  }
} finally {await browser.close();}

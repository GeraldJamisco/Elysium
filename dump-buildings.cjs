#!/usr/bin/env node
// ============================================================
// dump-buildings.cjs — raw dump of the authored building registry.
//
// Rebuilt in Phase 8.  The original was deleted in error during the
// Phase 7 visual pass and nothing in the repository referenced it, so
// this is a reconstruction from its evident purpose: print every
// building buildings.js realised, with its footprint, family, entrance
// edge and height, in a form that can be diffed between runs to prove
// placement is still deterministic.
//
//   node dump-buildings.cjs            human-readable table
//   node dump-buildings.cjs --json     machine-readable, for diffing
// ============================================================

const path = require('path');
const fs = require('fs');

let puppet;
try { puppet = require('puppeteer-core'); } catch {}
if (!puppet) { try { puppet = require(path.join(process.env.TEMP || 'C:\\Users\\t\\AppData\\Local\\Temp', 'node_modules', 'puppeteer-core')); } catch {} }
if (!puppet) { console.error('puppeteer-core not found'); process.exit(1); }

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const chromePath = CHROME_PATHS.find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const asJson = process.argv.includes('--json');

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(2500);

  const data = await page.evaluate(() => ({
    buildings: window.MC.buildings.map(b => ({
      tag: 'b@' + b.cx.toFixed(1) + ',' + b.cz.toFixed(1),
      cx: +b.cx.toFixed(2), cz: +b.cz.toFixed(2),
      w: +b.w.toFixed(2), d: +b.d.toFixed(2), h: +b.height.toFixed(2),
      family: b.family, entrance: b.entrance, corner: !!b.corner,
      id: b.id || null, block: b.block || null, purpose: b.purpose || null,
    })),
    hallTag: window.MC.hallDef ? window.MC.hallDef.buildingTag : null,
  }));

  if (asJson) {
    console.log(JSON.stringify(data, null, 1));
  } else {
    const rows = data.buildings;
    console.log(`buildings: ${rows.length}   hall: ${data.hallTag}`);
    const byFamily = {};
    rows.forEach(b => { byFamily[b.family] = (byFamily[b.family] || 0) + 1; });
    console.log('by family:', JSON.stringify(byFamily));
    console.log('');
    console.log(['ID', 'TAG', 'BLOCK', 'FAMILY', 'ENTR', 'W', 'D', 'H', 'CORNER'].join('\t'));
    rows.sort((a, b) => (a.id || '').localeCompare(b.id || '') || a.cx - b.cx || a.cz - b.cz);
    for (const b of rows) {
      console.log([
        b.id || '-', b.tag, b.block || '-', b.family, b.entrance,
        b.w, b.d, b.h, b.corner ? 'Y' : '',
      ].join('\t'));
    }
  }

  await browser.close();
})();

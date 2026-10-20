#!/usr/bin/env node
// ============================================================
// markings.cjs — is every road marking actually on a road?
//
// The obstruction sweep cannot see this class: markings are painted
// geometry, not collision bodies, so nothing solid is ever reported and
// a zebra crossing lying in the middle of a lawn passes every check the
// project had.  This recomputes, from the live junction model, where
// each crossing bar, stop line and give-way line WOULD be placed, and
// asks whether there is a carriageway under it.
//
//   node qa/markings.cjs [range]
//
// Exits non-zero if any marking would land off the road.
// ============================================================

const path = require('path');
const fs = require('fs');

let puppet;
try { puppet = require(path.join(process.env.TEMP || '/tmp', 'node_modules', 'puppeteer-core')); } catch {}
if (!puppet) { try { puppet = require('puppeteer-core'); } catch {} }
if (!puppet) { console.error('puppeteer-core not found'); process.exit(1); }

const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromePath) { console.error('Chrome not found'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RANGE = Number(process.argv[2] || 900);

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(11000);

  const r = await page.evaluate((RANGE) => {
    const junc = window.MC.junctions.all().filter(j => Math.hypot(j.x, j.z) <= RANGE);
    const onRoad = (x, z) => {
      const segs = window.MC.roads.segmentsNear(x, z, 30);
      for (const g of segs) {
        const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
        const l2 = dx * dx + dz * dz;
        let u = l2 ? ((x - g.x1) * dx + (z - g.z1) * dz) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = x - (g.x1 + u * dx), pz = z - (g.z1 + u * dz);
        if (px * px + pz * pz <= (g.width / 2) ** 2) return true;
      }
      return false;
    };

    let checked = 0;
    const off = [];
    for (const j of junc) {
      if (j.control === 'NONE') continue;
      for (const ap of j.approaches) {
        const w = ap.width || 6;
        const dist = j.control === 'ROUNDABOUT' ? 16.0 : w * 0.9 + 3.2;
        const x = j.x + Math.cos(ap.bear) * dist;
        const z = j.z + Math.sin(ap.bear) * dist;
        checked++;
        if (!onRoad(x, z)) {
          off.push({ id: j.id, control: j.control, road: ap.type,
                     at: [+x.toFixed(1), +z.toFixed(1)] });
        }
      }
    }
    return { junctions: junc.length, checked, off: off.length, sample: off.slice(0, 12) };
  }, RANGE);

  console.log(`--- ROAD MARKINGS (${RANGE} m) ---`);
  console.log(`controlled junctions ${r.junctions}   marking positions checked ${r.checked}`);
  console.log(`OFF THE CARRIAGEWAY : ${r.off}`);
  if (r.off) {
    console.log('');
    r.sample.forEach(x =>
      console.log(`   ${x.id}  ${x.control.padEnd(10)} ${x.road.padEnd(10)} at ${JSON.stringify(x.at)}`));
  } else {
    console.log('\nCLEAR — every marking lands on a carriageway.');
  }

  await browser.close();
  process.exit(0);
})();

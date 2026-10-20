#!/usr/bin/env node
// ============================================================
// diag-civic.cjs — the Community Hall and its relationships.
//
// Rebuilt in Phase 8.  The original was deleted in error during the
// Phase 7 visual pass; this is a reconstruction from its evident
// purpose — check that the civic building the interior is bound to is
// still the building the town actually built, and that its entrance is
// reachable.  Phase 8 extends it to report the Hall's spatial
// relationships, since those are now part of the model.
//
//   node diag-civic.cjs
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
];
const chromePath = CHROME_PATHS.find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromePath) { console.error('Chrome not found'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(3000);

  const r = await page.evaluate(() => {
    const hallTag = window.MC.hallDef.buildingTag;
    const reg = window.MC.buildings;
    const b = reg.find(x => ('b@' + x.cx.toFixed(1) + ',' + x.cz.toFixed(1)) === hallTag);
    const d = window.MC.district;
    const rec = d ? d.buildings.find(x => x.tag === hallTag) : null;

    // Is the doorway reachable from the street?  Walk in from the far
    // side of the carriageway on the Hall's own axis.
    const coll = window.MC.collisionRegistry;
    const EX = x => x.type !== 'interior';
    let approach = null;
    if (b) {
      const from = b.cx + b.w / 2 + 12;
      const res = coll.preventTunneling(from, b.cz, -14, 0, 0.4, EX);
      approach = { stoppedAt: +res.x.toFixed(2), gapToFace: +(res.x - (b.cx + b.w / 2)).toFixed(2) };
    }

    return {
      hallTag,
      found: !!b,
      registry: b ? { id: b.id, block: b.block, family: b.family, entrance: b.entrance, purpose: b.purpose, street: b.street } : null,
      model: rec ? {
        frontage: rec.frontage,
        entrance: rec.entrance,
        connections: rec.connections,
        spatialRole: rec.spatialRole,
      } : null,
      civicCount: reg.filter(x => x.family === 'civic').length,
      links: d ? d.links.filter(l => l.from === (rec && rec.id) || l.to === 'The Green') : [],
      spaces: d ? d.spaces.filter(s => s.owner === (rec && rec.id)) : [],
      approach,
      interiorBodies: coll.getBodies().filter(x => x.type === 'interior').length,
    };
  });

  console.log('Community Hall:', r.hallTag, r.found ? 'FOUND' : 'MISSING');
  if (!r.found) { console.error('FAIL — the interior is bound to a building that no longer exists'); process.exit(1); }
  console.log('registry   ', JSON.stringify(r.registry));
  console.log('frontage   ', JSON.stringify(r.model && r.model.frontage));
  console.log('entrance   ', JSON.stringify(r.model && r.model.entrance));
  console.log('connections', JSON.stringify(r.model && r.model.connections));
  console.log('spaces     ', JSON.stringify(r.spaces));
  console.log('links      ', JSON.stringify(r.links));
  console.log('civic buildings on the green:', r.civicCount, '(expected 4)');
  console.log('interior collision bodies:', r.interiorBodies);
  console.log('street approach:', JSON.stringify(r.approach),
              r.approach && r.approach.gapToFace < 1.2 ? '-> reaches the doorway' : '-> BLOCKED short of the door');

  await browser.close();
})();

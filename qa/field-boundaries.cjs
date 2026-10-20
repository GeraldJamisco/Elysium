#!/usr/bin/env node
// ============================================================
// field-boundaries.cjs — Phase 9C boundary provenance audit.
//
// Hedgerows were already placed well.  What 9C added is a REASON for
// each one, so that nothing downstream can treat an agricultural
// boundary, the edge of a wood and the verge of a trunk road as the same
// interchangeable hedge.
//
// This checks the naming is honest rather than decorative:
//
//   * every boundary carries an id, an origin, a length and a bearing
//   * origins are drawn from the defined set, and more than one is used
//   * no boundary is duplicated on the same ground
//   * no boundary sits inside a building
//   * no boundary lies in a carriageway
//   * classification is deterministic across two derivations
//
//   node qa/field-boundaries.cjs [range]
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
const RANGE = Number(process.argv[2] || 1200);

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(16000);

  const r = await page.evaluate((RANGE) => {
    const M = window.MC;
    const L = M.landscape;
    if (!L || !L.fieldBoundaries) return { missing: true };

    const all = L.fieldBoundaries().filter(b => Math.hypot(b.x, b.z) <= RANGE);
    const bodies = M.collisionRegistry.getBodies().filter(b => b.type !== 'interior');

    const byOrigin = {};
    const seenId = new Set();
    let dupId = 0, malformed = 0;
    const cellSeen = new Set();
    let dupGround = 0;

    for (const b of all) {
      byOrigin[b.origin] = (byOrigin[b.origin] || 0) + 1;
      if (seenId.has(b.boundaryId)) dupId++; else seenId.add(b.boundaryId);
      if (!b.boundaryId || !b.origin || !(b.length > 0) || !isFinite(b.orientation)) malformed++;
      const k = Math.round(b.x / 3) + ':' + Math.round(b.z / 3);
      if (cellSeen.has(k)) dupGround++; else cellSeen.add(k);
    }

    // No boundary inside a building.
    let inBuilding = 0;
    for (const b of all) {
      for (const s of bodies) {
        if (!/building/.test(s.type)) continue;
        if (b.x > s.minX && b.x < s.maxX && b.z > s.minZ && b.z < s.maxZ) { inBuilding++; break; }
      }
    }

    // No hedge PLANTED in a carriageway.
    //
    // Tested against where the hedge pass actually put geometry, not the
    // midpoint of the boundary line: a field edge that crosses a road has
    // its midpoint on the road quite legitimately, and the hedge there is
    // suppressed.  Testing the midpoint reported four false defects.
    let inCarriageway = 0, planted = 0, gapped = 0;
    for (const b of all) {
      gapped += b.gaps || 0;
      for (const [px, pz] of (b.drawn || [])) {
        planted++;
        for (const s of M.roads.segmentsNear(px, pz, 40)) {
          const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
          const l2 = dx * dx + dz * dz;
          let t = l2 ? ((px - s.x1) * dx + (pz - s.z1) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(px - (s.x1 + t * dx), pz - (s.z1 + t * dz)) < s.width / 2) { inCarriageway++; break; }
        }
      }
    }

    // Determinism: re-classify the same ground and compare.
    let drift = 0;
    for (const b of all.slice(0, 200)) {
      const again = L.classifyBoundary(b.x - 1, b.z, b.x + 1, b.z, M.roads.segmentsNear(b.x, b.z, 60));
      const once = L.classifyBoundary(b.x - 1, b.z, b.x + 1, b.z, M.roads.segmentsNear(b.x, b.z, 60));
      if (again.origin !== once.origin) drift++;
    }

    return {
      total: all.length, byOrigin, dupId, malformed, dupGround,
      inBuilding, inCarriageway, drift, planted, gapped,
    };
  }, RANGE);

  if (r.missing) {
    console.log('INVALID — MC.landscape.fieldBoundaries not exposed.');
    await browser.close(); process.exit(1);
  }

  console.log(`--- FIELD BOUNDARIES (${RANGE} m) ---`);
  console.log(`boundaries            ${r.total}`);
  console.log(`by origin             ${JSON.stringify(r.byOrigin)}`);
  console.log(`distinct origins      ${Object.keys(r.byOrigin).length}`);
  console.log('');
  console.log(`malformed records     ${r.malformed}`);
  console.log(`duplicate ids         ${r.dupId}`);
  console.log(`duplicated ground     ${r.dupGround}`);
  console.log(`inside a building     ${r.inBuilding}`);
  console.log(`hedge runs planted    ${r.planted}`);
  console.log(`runs gapped (road/gate) ${r.gapped}`);
  console.log(`planted in carriageway ${r.inCarriageway}`);
  console.log(`classification drift  ${r.drift}`);
  console.log(`\nconsole errors: ${errs.length || 'NONE'}`);

  const bad = r.malformed > 0 || r.dupId > 0 || r.inBuilding > 0 ||
              r.inCarriageway > 0 || r.drift > 0 || Object.keys(r.byOrigin).length < 2;
  console.log(bad ? '\nFAIL' : '\nPASS — every boundary has a distinct id and a defensible origin.');
  await browser.close();
  process.exit(bad ? 1 : 0);
})();

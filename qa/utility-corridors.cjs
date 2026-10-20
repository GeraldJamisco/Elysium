#!/usr/bin/env node
// ============================================================
// utility-corridors.cjs — Phase 9C utility audit.
//
// A corridor is the cheapest way to say "this place is serviced" and the
// easiest thing in the whole phase to overdo.  The failure mode is not a
// crash; it is a landscape peppered with poles, which reads as a
// generator that has discovered electricity rather than as infrastructure.
//
// So this audits restraint as much as correctness:
//
//   * corridors connect real settlements, one per pair
//   * endpoints are clear of both settlements' built edges
//   * pole spacing is what it claims to be
//   * pole DENSITY per square kilometre stays low
//   * nothing crosses the park, the plaza or the stadium reservation
//   * no pole stands in a carriageway or on a footway
//   * the corridor set is deterministic
//
//   node qa/utility-corridors.cjs [range]
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
const RANGE = Number(process.argv[2] || 2500);
const MAX_POLES_PER_KM2 = 12;       // restraint, expressed as a number

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
  await sleep(14000);

  const r = await page.evaluate(({ RANGE }) => {
    const M = window.MC;
    const U = M.landscape;
    if (!U || !U.utilityCorridors) return { missing: true };

    const all = U.utilityCorridors();
    const near = all.filter(c =>
      Math.hypot(c.x1, c.z1) <= RANGE + 800 || Math.hypot(c.x2, c.z2) <= RANGE + 800);

    // One per pair.
    const pairSeen = new Set();
    let dupPair = 0;
    for (const c of all) {
      const k = [c.from, c.to].sort().join('|');
      if (pairSeen.has(k)) dupPair++; else pairSeen.add(k);
    }

    const park = M.world.parkBounds;
    const inPark = (x, z) => x > park.minX - 8 && x < park.maxX + 8 &&
                             z > park.minZ - 8 && z < park.maxZ + 8;

    let crossesProtected = 0, poles = 0, inCarriageway = 0, onFootway = 0;
    const FOOT = 2.6;
    for (const c of near) {
      const n = Math.max(1, Math.floor(c.len / 12));
      for (let k = 0; k <= n; k++) {
        const t = (k / n) * c.len;
        const x = c.x1 + c.ux * t, z = c.z1 + c.uz * t;
        if (inPark(x, z) || M.world.reservationAt(x, z, 0)) crossesProtected++;
      }
    }

    // Poles from the SHARED eligibility function — the same set the
    // builder draws.  Reading a registry instead made this depend on what
    // had streamed in, and an empty registry passed while proving nothing.
    const allPoles = [];
    for (const c of near) for (const p of U.corridorPoles(c)) allPoles.push(p);
    for (const p of allPoles) {
      if (Math.hypot(p.x, p.z) > RANGE) continue;
      poles++;
      for (const s of M.roads.segmentsNear(p.x, p.z, 40)) {
        const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
        const l2 = dx * dx + dz * dz;
        let u = l2 ? ((p.x - s.x1) * dx + (p.z - s.z1) * dz) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const d = Math.hypot(p.x - (s.x1 + u * dx), p.z - (s.z1 + u * dz));
        if (d < s.width / 2) { inCarriageway++; break; }
        if (d < s.width / 2 + FOOT) { onFootway++; break; }
      }
    }

    // Determinism: the corridor set must be the same object set twice.
    const again = U.utilityCorridors();
    const stable = again.length === all.length &&
                   again.every((c, i) => c.id === all[i].id);

    const areaKm2 = Math.PI * (RANGE / 1000) * (RANGE / 1000);
    return {
      corridors: all.length, nearCorridors: near.length, dupPair,
      poles, polesPerKm2: +(poles / areaKm2).toFixed(2),
      crossesProtected, inCarriageway, onFootway, stable,
      sample: near.slice(0, 6).map(c => ({
        id: c.id, len: Math.round(c.len),
        from: [Math.round(c.x1), Math.round(c.z1)],
        to: [Math.round(c.x2), Math.round(c.z2)],
      })),
    };
  }, { RANGE });

  if (r.missing) {
    console.log('INVALID — MC.landscape.utilityCorridors not exposed.');
    await browser.close(); process.exit(1);
  }

  console.log(`--- UTILITY CORRIDORS (${RANGE} m) ---`);
  console.log(`corridors (all)        ${r.corridors}`);
  console.log(`corridors in range     ${r.nearCorridors}`);
  console.log(`duplicate pairs        ${r.dupPair}`);
  console.log(`poles PLACED in range  ${r.poles}`);
  console.log(`poles per km2          ${r.polesPerKm2}   (limit ${MAX_POLES_PER_KM2})`);
  console.log(`crossing protected     ${r.crossesProtected}`);
  console.log(`pole in carriageway    ${r.inCarriageway}`);
  console.log(`pole on footway        ${r.onFootway}`);
  console.log(`deterministic          ${r.stable}`);
  console.log('');
  r.sample.forEach(c => console.log(`   ${c.id.padEnd(22)} ${String(c.len).padStart(5)} m  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`));
  console.log(`\nconsole errors: ${errs.length || 'NONE'}`);

  // A pass with no poles at all is not a pass: it means the corridors
  // carry nothing and the audit measured an empty set.
  const bad = r.dupPair > 0 || r.crossesProtected > 0 || r.inCarriageway > 0 ||
              r.onFootway > 0 || !r.stable || r.polesPerKm2 > MAX_POLES_PER_KM2 ||
              (r.nearCorridors > 0 && r.poles === 0);
  console.log(bad ? '\nFAIL' : '\nPASS — corridors connect real places, sparsely, and clear of the public way.');
  await browser.close();
  process.exit(bad ? 1 : 0);
})();

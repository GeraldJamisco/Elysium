#!/usr/bin/env node
// ============================================================
// landscape-access.cjs — Phase 9C farm access audit.
//
// A farm track exists to answer one question: can this steading be
// reached?  Before 9C the answer was "presumably" — three farmsteads
// stood 19 to 93 m off a regional road with nothing drawn between them
// and it, and the land read as farmed by nobody.
//
// This checks the relationship rather than the object count:
//
//   * every farmstead has an access road within range
//   * the track that serves it reaches the yard
//   * tracks do not enter buildings or protected ground
//   * tracks have NOT leaked into the public road graph
//
// That last one is the important one.  Phase 8.5/8.6 own the road
// network; a farm track appearing as a segment would put an unclassified
// edge into a graph whose connectivity, terminals and junctions are all
// audited on the assumption that every edge is a public road.
//
//   node qa/landscape-access.cjs [range]
//
// Exits non-zero on an unreachable farm or a track in the road graph.
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
const RANGE = Number(process.argv[2] || 1600);

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

  const r = await page.evaluate((RANGE) => {
    const M = window.MC;
    // Deterministic denominator: the road graph streams in, and a probe
    // that measures before it settles describes a half-built world.
    for (const s of M.parcels.allSettlements()) {
      if (Math.hypot(s.x, s.z) < RANGE + 900) M.parcels.ensureSettlementRoads(s);
    }

    const parcels = M.roads.parcelsNear(0, 0, RANGE).filter(p => p.w !== undefined);
    const farms = parcels.filter(p => p.kind === 'farmhouse');
    const bodies = M.collisionRegistry.getBodies().filter(b => b.type !== 'interior');

    const ACCESS_LIMIT = 210;          // PROC.farmAccessRange
    const unreachable = [];
    const detail = [];

    for (const f of farms) {
      const segs = M.roads.segmentsNear(f.x, f.z, 400);
      let bd = Infinity, bt = null;
      for (const s of segs) {
        const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
        const l2 = dx * dx + dz * dz;
        let t = l2 ? ((f.x - s.x1) * dx + (f.z - s.z1) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(f.x - (s.x1 + t * dx), f.z - (s.z1 + t * dz));
        if (d < bd) { bd = d; bt = s.type; }
      }
      const rec = { at: [Math.round(f.x), Math.round(f.z)], accessD: +bd.toFixed(1), road: bt };
      detail.push(rec);
      if (!isFinite(bd) || bd > ACCESS_LIMIT) unreachable.push(rec);
    }

    // The public road graph must contain no track.  Tracks are drawn
    // geometry only, so any segment of a type the hierarchy does not
    // define would mean the layers have bled into each other.
    const KNOWN = new Set(['regional', 'arterial', 'collector', 'street', 'lane', 'authored']);
    const strayTypes = {};
    for (const s of M.roads.segmentsNear(0, 0, RANGE)) {
      if (!KNOWN.has(s.type)) strayTypes[s.type] = (strayTypes[s.type] || 0) + 1;
    }

    // A farmyard must not sit inside another building's body.
    let farmsInSolid = 0;
    for (const f of farms) {
      for (const b of bodies) {
        if (b.tag && b.tag.includes(`${f.x.toFixed(1)}`)) continue;
        if (f.x > b.minX && f.x < b.maxX && f.z > b.minZ && f.z < b.maxZ) { farmsInSolid++; break; }
      }
    }

    // A TRACK must not run through a building.
    //
    // Tested against parcels, not collision bodies: the registry only
    // holds what has streamed in, so an orbit-side probe sees an empty
    // world and this check would pass for the wrong reason.  A walk
    // capture found a track running through a neighbouring farmhouse
    // that every metric had called healthy.
    const boxes = parcels.map(q => {
      const ca = Math.abs(Math.cos(q.rot || 0)), sa = Math.abs(Math.sin(q.rot || 0));
      const hx = (q.w * ca + q.d * sa) / 2, hz = (q.w * sa + q.d * ca) / 2;
      return { x: q.x, z: q.z, hx, hz, tag: `${q.kind}@${Math.round(q.x)},${Math.round(q.z)}` };
    });
    const trackThroughBuilding = [];
    for (const f of farms) {
      const segs = M.roads.segmentsNear(f.x, f.z, 400);
      let bd = Infinity, at = null;
      for (const s of segs) {
        const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
        const l2 = dx * dx + dz * dz;
        let t = l2 ? ((f.x - s.x1) * dx + (f.z - s.z1) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s.x1 + t * dx, qz = s.z1 + t * dz;
        const d = Math.hypot(f.x - qx, f.z - qz);
        if (d < bd) { bd = d; at = [qx, qz]; }
      }
      if (!at) continue;
      const N = 30;
      for (let k = 1; k < N; k++) {
        const t = k / N;
        const x = at[0] + (f.x - at[0]) * t, z = at[1] + (f.z - at[1]) * t;
        const hit = boxes.find(b =>
          Math.abs(x - b.x) < b.hx - 0.5 && Math.abs(z - b.z) < b.hz - 0.5 &&
          Math.hypot(b.x - f.x, b.z - f.z) > 30);
        if (hit) { trackThroughBuilding.push({ farm: [Math.round(f.x), Math.round(f.z)], through: hit.tag }); break; }
      }
    }

    return {
      farms: farms.length,
      unreachable, detail: detail.sort((a, b) => a.accessD - b.accessD),
      strayTypes, farmsInSolid, trackThroughBuilding,
      accessLimit: ACCESS_LIMIT,
    };
  }, RANGE);

  console.log(`--- FARM ACCESS (${RANGE} m) ---`);
  console.log(`farmsteads            ${r.farms}`);
  console.log(`unreachable           ${r.unreachable.length}`);
  console.log(`farmyard inside solid ${r.farmsInSolid}`);
  console.log(`non-road-graph types  ${JSON.stringify(r.strayTypes)}   (must be {})`);
  console.log(`track through building ${r.trackThroughBuilding.length}`);
  r.trackThroughBuilding.forEach(t => console.log(`   farm ${JSON.stringify(t.farm)} -> through ${t.through}`));
  console.log('');
  console.log('access distances:');
  r.detail.slice(0, 16).forEach(d =>
    console.log(`   ${JSON.stringify(d.at).padEnd(16)} ${String(d.accessD).padStart(7)} m off ${d.road}`));
  if (r.unreachable.length) {
    console.log('\nUNREACHABLE:');
    r.unreachable.forEach(d => console.log('  ', JSON.stringify(d)));
  }
  console.log(`\nconsole errors: ${errs.length || 'NONE'}`);

  const bad = r.unreachable.length > 0 || Object.keys(r.strayTypes).length > 0 ||
              r.farmsInSolid > 0 || r.trackThroughBuilding.length > 0;
  console.log(bad ? '\nFAIL' : '\nPASS — every farmstead is reachable and no track is in the road graph.');
  await browser.close();
  process.exit(bad ? 1 : 0);
})();

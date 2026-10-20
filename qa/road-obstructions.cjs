#!/usr/bin/env node
// ============================================================
// road-obstructions.cjs — find anything standing in a road.
//
// A walk down one street found plot boundaries jutting across the
// footway.  One street is not an audit: this sweeps EVERY road in range
// and reports every solid body that overlaps a carriageway or a footway,
// anywhere on the planet, so the same class of defect cannot hide in the
// streets nobody happened to walk.
//
// The rule is simple and checkable: the carriageway and the footway are
// public way.  Nothing solid belongs in them except the street furniture
// that is meant to be there — and even that is reported, so a tree in
// the middle of a lane is visible as a tree in the middle of a lane.
//
//   node qa/road-obstructions.cjs [range] [--all]
//
// Exits non-zero if anything is found in a carriageway.
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
const RANGE = Number(process.argv[2] || 700);
const showAll = process.argv.includes('--all');

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(12000);                        // let chunks stream in

  const r = await page.evaluate((RANGE) => {
    const segs = window.MC.roads.segmentsNear(0, 0, RANGE);
    const bodies = window.MC.collisionRegistry.getBodies()
      .filter(b => b.type !== 'interior');

    // Street furniture that legitimately stands on a footway.  It is
    // still reported if it lands in a CARRIAGEWAY.
    const FURNITURE = new Set(['lamp', 'tree', 'signal', 'seat', 'bench', 'basin', 'roundabout-island']);

    const inCarriageway = [];
    const onFootway = [];
    const seen = new Set();

    for (const s of segs) {
      const len = s.len || Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
      if (len < 1) continue;
      const dx = (s.x2 - s.x1) / len, dz = (s.z2 - s.z1) / len;
      const nx = -dz, nz = dx;
      const halfRoad = s.width / 2;
      // Only streets and lanes are built with a footway (buildRoadGeometry
      // draws footway strips for marks === 'none').  Assuming 2.2 m of
      // pavement on every road reported seventy-four buildings as
      // standing on a footway that does not exist — a normal setback off
      // an arterial, counted as a defect.
      const HAS_FOOTWAY = { street: 2.2, lane: 2.2, authored: 2.5, arterial: 2.6, collector: 2.6 };
      const halfWay = halfRoad + (HAS_FOOTWAY[s.type] || 0);

      const step = 2.0;
      for (let t = 0; t <= len; t += step) {
        const cx = s.x1 + dx * t, cz = s.z1 + dz * t;
        for (const b of bodies) {
          // Cheap AABB reject.
          if (cx < b.minX - halfWay || cx > b.maxX + halfWay) continue;
          if (cz < b.minZ - halfWay || cz > b.maxZ + halfWay) continue;
          // Perpendicular distance from the road centreline to the body.
          const qx = Math.max(b.minX, Math.min(cx, b.maxX));
          const qz = Math.max(b.minZ, Math.min(cz, b.maxZ));
          const off = Math.abs((qx - cx) * nx + (qz - cz) * nz);
          const along = Math.abs((qx - cx) * dx + (qz - cz) * dz);
          if (along > step) continue;
          const tag = b.tag || b.type;
          if (off < halfRoad - 0.15) {
            if (seen.has('C' + tag)) continue;
            seen.add('C' + tag);
            inCarriageway.push({ tag, type: b.type, road: s.type,
                                 at: [+qx.toFixed(1), +qz.toFixed(1)],
                                 off: +off.toFixed(2) });
          } else if (off < halfWay && !FURNITURE.has(b.type)) {
            if (seen.has('F' + tag)) continue;
            seen.add('F' + tag);
            onFootway.push({ tag, type: b.type, road: s.type,
                             at: [+qx.toFixed(1), +qz.toFixed(1)],
                             off: +off.toFixed(2) });
          }
        }
      }
    }

    const tally = a => a.reduce((o, x) => { o[x.type] = (o[x.type] || 0) + 1; return o; }, {});
    return {
      segments: segs.length, bodies: bodies.length,
      carriageway: inCarriageway.length, carriagewayBy: tally(inCarriageway),
      footway: onFootway.length, footwayBy: tally(onFootway),
      cSample: inCarriageway.slice(0, 20),
      fSample: onFootway.slice(0, 20),
    };
  }, RANGE);

  console.log(`--- OBSTRUCTIONS IN THE PUBLIC WAY (${RANGE} m) ---`);
  console.log(`roads checked ${r.segments}   solid bodies ${r.bodies}`);
  console.log('');
  console.log(`IN CARRIAGEWAY : ${r.carriageway}  ${JSON.stringify(r.carriagewayBy)}`);
  console.log(`ON FOOTWAY     : ${r.footway}  ${JSON.stringify(r.footwayBy)}   (street furniture excluded)`);
  if (r.carriageway) {
    console.log('\ncarriageway sample:');
    (showAll ? r.cSample : r.cSample.slice(0, 8)).forEach(x =>
      console.log(`   ${x.type.padEnd(14)} ${JSON.stringify(x.at).padEnd(18)} on ${x.road}, ${x.off} m off centre`));
  }
  if (r.footway) {
    console.log('\nfootway sample:');
    (showAll ? r.fSample : r.fSample.slice(0, 8)).forEach(x =>
      console.log(`   ${x.type.padEnd(14)} ${JSON.stringify(x.at).padEnd(18)} on ${x.road}, ${x.off} m off centre`));
  }
  if (!r.carriageway && !r.footway) console.log('\nCLEAR — nothing solid in any carriageway or footway.');

  await browser.close();
  process.exit(r.carriageway > 0 ? 1 : 0);
})();

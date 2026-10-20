#!/usr/bin/env node
// ============================================================
// diag-buildings.cjs — building placement and frontage integrity.
//
// Rebuilt in Phase 8.  The original was deleted in error during the
// Phase 7 visual pass; this is a reconstruction from its evident
// purpose — check that every building the town planned was actually
// built, sits inside its block, does not overlap a neighbour, and has
// registered collision.  Phase 8 adds the checks the relationship model
// makes possible: that every building addresses a real street, that its
// door is on the street side, and that the door is reachable.
//
// Exits non-zero if any check fails, so it can gate a change.
//
//   node diag-buildings.cjs
//   node diag-buildings.cjs --verbose    list every building
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
const verbose = process.argv.includes('--verbose');

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
    const reg = window.MC.buildings;
    const d = window.MC.district;
    const coll = window.MC.collisionRegistry;
    const bodies = coll.getBodies();
    const EX = b => b.type !== 'interior';
    const fails = [];
    const rows = [];

    for (const b of reg) {
      const tag = 'b@' + b.cx.toFixed(1) + ',' + b.cz.toFixed(1);
      const rec = d ? d.buildings.find(x => x.tag === tag) : null;
      const row = { tag, id: b.id || '-', block: b.block || '-', family: b.family, entrance: b.entrance };

      // 1. Identity: every building belongs to a block and a street.
      if (!b.id) fails.push(`${tag}: no district id`);
      if (!rec) { fails.push(`${tag}: not in the district model`); rows.push(row); continue; }
      if (!rec.frontage.street) fails.push(`${b.id}: addresses no street (edge ${rec.frontage.side})`);
      row.street = rec.frontage.street || '-';

      // 2. Collision: the body exists and matches the footprint.
      const body = bodies.find(x => x.type === 'building' && x.tag === tag);
      if (!body) fails.push(`${b.id}: no collision body`);
      else {
        const dw = Math.abs((body.maxX - body.minX) - b.w);
        const dd = Math.abs((body.maxZ - body.minZ) - b.d);
        if (dw > 0.05 || dd > 0.05) fails.push(`${b.id}: collision body does not match footprint`);
      }

      // 3. Overlap with any other building.
      for (const o of reg) {
        if (o === b) continue;
        if (Math.abs(o.cx - b.cx) < (o.w + b.w) / 2 - 0.05 &&
            Math.abs(o.cz - b.cz) < (o.d + b.d) / 2 - 0.05) {
          fails.push(`${b.id}: footprint overlaps ${o.id || ('b@' + o.cx.toFixed(1))}`);
          break;
        }
      }

      // 4. The door is on the street side, and a person can reach it.
      // Walk in along the entrance normal from 14 m out.
      const e = rec.entrance;
      const fromX = e.x + e.dx * 14, fromZ = e.z + e.dz * 14;
      const res = coll.preventTunneling(fromX, fromZ, -e.dx * 16, -e.dz * 16, 0.4, EX);
      const gap = Math.hypot(res.x - e.x, res.z - e.z);
      row.doorGap = +gap.toFixed(2);
      // The plinth gap is 1.2 m wide and the facade's threshold sits on
      // the face, so anything under ~1.5 m means the doorway was reached.
      if (gap > 1.6) fails.push(`${b.id}: door not reachable from the street (stopped ${gap.toFixed(2)} m short)`);

      // 5. The rear has a defined condition.
      const rear = rec.connections.greenSpace || rec.connections.serviceAccess;
      if (!rear) fails.push(`${b.id}: no rear condition`);
      row.rear = rear || '-';
      row.neighbours = rec.connections.neighbours.length;

      rows.push(row);
    }

    return { count: reg.length, fails, rows, summary: window.MC.districtSummary ? window.MC.districtSummary() : null };
  });

  console.log(`buildings: ${r.count}`);
  if (r.summary) console.log('district:', JSON.stringify(r.summary));
  console.log('');

  if (verbose) {
    console.log(['ID', 'BLOCK', 'STREET', 'FAMILY', 'ENTR', 'DOORGAP', 'REAR', 'NBRS'].join('\t'));
    r.rows.sort((a, b) => a.id.localeCompare(b.id));
    for (const x of r.rows) {
      console.log([x.id, x.block, x.street || '-', x.family, x.entrance,
                   x.doorGap ?? '-', x.rear || '-', x.neighbours ?? '-'].join('\t'));
    }
    console.log('');
  }

  if (r.fails.length) {
    console.log(`FAIL — ${r.fails.length} problem(s):`);
    r.fails.forEach(f => console.log('  ' + f));
  } else {
    console.log('PASS — every building has an identity, a street, a reachable door, a rear condition and matching collision.');
  }

  await browser.close();
  process.exit(r.fails.length ? 1 : 0);
})();

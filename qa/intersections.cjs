#!/usr/bin/env node
// ============================================================
// intersections.cjs — classify Veridian Cap's junctions.
//
// Phase 8.6 asks for the intersections to be classified BEFORE any
// generator is touched.  This reads the live planarized graph and
// produces the inventory: what roads meet, how important the junction
// is, and what control it should therefore carry.
//
// It is deliberately read-only, and it reports the RAW RECOMMENDATION —
// what each junction could justify on its own.  It does NOT apply the
// spacing rules in junctions.js rationTreatments(), which are what
// decide how many are actually built.  Read this tool's roundabout count
// as "candidates", never as "built": it said twelve at a moment when the
// engine was building two, and that is a easy way to frighten yourself.
// For what is really there, use window.MC.junctions.summary().
//
//   node qa/intersections.cjs [--all]
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
const showAll = process.argv.includes('--all');

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 180000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(7000);

  const r = await page.evaluate(() => {
    const RANGE = 800, SNAP = 4.0;
    const segs = window.MC.roads.segmentsNear(0, 0, RANGE);

    // Rank of each class, widest/fastest first.  'authored' is Veridian
    // Cap's own street grid, which functions as a collector.
    const RANK = { regional: 5, arterial: 4, collector: 3, authored: 3, street: 2, lane: 1 };

    const nodes = [];
    const keyOf = (x, z) => {
      for (let i = 0; i < nodes.length; i++) {
        if (Math.hypot(nodes[i].x - x, nodes[i].z - z) <= SNAP) return i;
      }
      nodes.push({ x, z, legs: [] });
      return nodes.length - 1;
    };
    for (const s of segs) {
      const a = keyOf(s.x1, s.z1), b = keyOf(s.x2, s.z2);
      // The bearing of the road leaving the node, for approach geometry.
      nodes[a].legs.push({ type: s.type, bear: Math.atan2(s.z2 - s.z1, s.x2 - s.x1), seg: s });
      nodes[b].legs.push({ type: s.type, bear: Math.atan2(s.z1 - s.z2, s.x1 - s.x2), seg: s });
    }

    // Reduce the legs at a node to the DISTINCT ROADS meeting there.
    //
    // A road passing straight through a junction arrives on one bearing
    // and leaves on the opposite one: that is ONE road, not two.  The
    // first version of this compared legs by same-bearing only, so an
    // arterial bending a few degrees as it crossed a street registered as
    // two arterials and the junction was classed STRATEGIC.  That is how
    // a 152-junction town came out wanting 68 roundabouts.
    const opposite = (a, b) => {
      const d = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      return Math.abs(d - Math.PI) < 0.65;             // within ~37 deg of straight
    };
    const roadsAt = n => {
      const legs = n.legs.slice();
      const used = new Array(legs.length).fill(false);
      const roads = [];
      for (let i = 0; i < legs.length; i++) {
        if (used[i]) continue;
        let partner = -1;
        for (let j = i + 1; j < legs.length; j++) {
          if (used[j] || legs[j].type !== legs[i].type) continue;
          if (opposite(legs[i].bear, legs[j].bear)) { partner = j; break; }
        }
        used[i] = true;
        if (partner >= 0) { used[partner] = true; roads.push({ type: legs[i].type, through: true }); }
        else roads.push({ type: legs[i].type, through: false });
      }
      return roads;
    };

    const out = [];
    nodes.forEach((n, i) => {
      if (n.legs.length < 3) return;                 // not a junction
      const roads = roadsAt(n);
      if (roads.length < 2) return;                  // a road bending, not a junction
      const ranks = roads.map(a => RANK[a.type] || 1).sort((a, b) => b - a);
      const hi = ranks[0], second = ranks[1];
      const types = [...new Set(roads.map(a => a.type))].sort();
      const ap = { length: n.legs.length };

      // Classification.  Driven by the two highest road classes meeting,
      // then by how many arms there are.
      let cls, control, reason;
      if (hi >= 5 && second >= 4) { cls = 'REGIONAL'; control = 'ROUNDABOUT'; reason = 'regional road meets the settlement arterial'; }
      else if (hi >= 5) { cls = 'REGIONAL'; control = 'SIGNAL'; reason = 'regional road meets a town street'; }
      else if (hi >= 4 && second >= 4) { cls = 'STRATEGIC'; control = 'ROUNDABOUT'; reason = 'arterial crosses arterial'; }
      else if (hi >= 4 && second >= 3) { cls = 'MAJOR'; control = 'SIGNAL'; reason = 'arterial meets a collector'; }
      else if (hi >= 4) { cls = 'MAJOR'; control = ap.length >= 4 ? 'SIGNAL' : 'NONE'; reason = 'arterial meets local streets'; }
      else if (hi >= 3 && second >= 3) { cls = 'NEIGHBOURHOOD'; control = 'CROSSING'; reason = 'collector meets collector'; }
      else if (hi >= 3) { cls = 'NEIGHBOURHOOD'; control = 'CROSSING'; reason = 'collector meets local streets'; }
      else { cls = 'LOCAL'; control = 'NONE'; reason = 'local streets only'; }

      out.push({
        i, x: +n.x.toFixed(1), z: +n.z.toFixed(1),
        arms: ap.length, types, cls, control, reason,
        r: +Math.hypot(n.x, n.z).toFixed(0),
      });
    });

    const tally = {};
    out.forEach(o => { tally[o.cls] = (tally[o.cls] || 0) + 1; });
    const ctrl = {};
    out.forEach(o => { ctrl[o.control] = (ctrl[o.control] || 0) + 1; });

    return { junctions: out.length, tally, ctrl, list: out.sort((a, b) => a.r - b.r) };
  });

  console.log('--- VERIDIAN CAP INTERSECTION INVENTORY (800 m) ---');
  console.log('junctions (3+ arms):', r.junctions);
  console.log('by class  ', JSON.stringify(r.tally));
  console.log('by control', JSON.stringify(r.ctrl),
              ' <- CANDIDATES, before spacing rules; MC.junctions.summary() is what is built');
  console.log('');
  const show = showAll ? r.list : r.list.filter(o => o.cls !== 'LOCAL' && o.cls !== 'NEIGHBOURHOOD');
  console.log('ID        R     ARMS  CLASS          CONTROL     ROADS                REASON');
  show.slice(0, 40).forEach((o, k) => {
    console.log(
      `INT-${String(k + 1).padStart(3, '0')}  ${String(o.r).padStart(4)}  ${o.arms}     ` +
      `${o.cls.padEnd(14)} ${o.control.padEnd(11)} ${o.types.join('+').padEnd(20)} ${o.reason}`);
  });
  if (!showAll) console.log(`\n(${r.list.length - show.length} local/neighbourhood junctions hidden; --all to list)`);

  await browser.close();
})();

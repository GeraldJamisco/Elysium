#!/usr/bin/env node
// ============================================================
// street-terminals.cjs — every dead end, and why it is there.
//
// READ ONLY.  It changes nothing.
//
// The road graph is planarized, so a graph segment is NOT a street: one
// street is many fragments.  A previous attempt to tidy dead ends worked
// on fragments and ate backwards along whole streets — remove the tail,
// the next fragment becomes a tail — breaking the settlement into twelve
// components with more dead ends than it started with.  This tool does
// the opposite of deleting: it reconstructs the LOGICAL CHAIN behind each
// terminal and asks why the chain ends.
//
// A dead end is not a defect.  A cul-de-sac, a settlement edge, a road
// that stops at a park are all reasons.  What is not a reason is "the
// generator stopped here".
//
// Exits non-zero if any UNEXPLAINED terminal exists.
//
//   node qa/street-terminals.cjs [range] [--list] [--json]
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
const LIST = process.argv.includes('--list');
const JSONOUT = process.argv.includes('--json');

// Terminals accepted as known exceptions, by position key "x,z".
// Empty by default: an exception has to be argued for, not assumed.
const ACCEPTED = new Set([]);

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(13000);

  const out = await page.evaluate((RANGE) => {
    const SNAP = 3.5;
    const segs = window.MC.roads.segmentsNear(0, 0, RANGE);
    const parcels = window.MC.roads.parcelsNear(0, 0, RANGE);
    const bodies = window.MC.collisionRegistry.getBodies().filter(b => b.type !== 'interior');
    const W = window.MC.world;
    const RANK = { regional: 5, arterial: 4, collector: 3, authored: 3, street: 2, lane: 1 };

    // ---- Graph ----
    const nodes = [];
    const at = (x, z) => {
      for (let i = 0; i < nodes.length; i++) {
        if (Math.hypot(nodes[i].x - x, nodes[i].z - z) <= SNAP) return i;
      }
      nodes.push({ x, z, seg: [] });
      return nodes.length - 1;
    };
    segs.forEach(s => {
      const a = at(s.x1, s.z1), b = at(s.x2, s.z2);
      s._a = a; s._b = b;
      nodes[a].seg.push(s); nodes[b].seg.push(s);
    });
    const deg = i => nodes[i].seg.length;

    // ---- LOGICAL STREET CHAINS ----
    //
    // A chain runs from one non-degree-2 node to the next, through
    // degree-2 nodes of the same road class.  That is the street a person
    // would name; the fragments between crossings are not.
    const walk = (startNode, firstSeg) => {
      const chain = [];
      let node = startNode, seg = firstSeg;
      const guard = new Set();
      while (seg && !guard.has(seg.id)) {
        guard.add(seg.id);
        chain.push(seg);
        const next = (seg._a === node) ? seg._b : seg._a;
        if (deg(next) !== 2) { node = next; break; }
        const onward = nodes[next].seg.find(g => g.id !== seg.id);
        if (!onward || RANK[onward.type] !== RANK[seg.type]) { node = next; break; }
        node = next; seg = onward;
      }
      return { chain, endNode: node };
    };

    const chains = [];
    const claimed = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (deg(i) === 2) continue;                        // mid-chain
      for (const s of nodes[i].seg) {
        if (claimed.has(s.id)) continue;
        const { chain, endNode } = walk(i, s);
        chain.forEach(g => claimed.add(g.id));
        chains.push({ segs: chain, a: i, b: endNode,
                      len: chain.reduce((t, g) => t + g.len, 0),
                      type: chain[0].type });
      }
    }
    chains.sort((p, q) => (p.segs[0].x1 - q.segs[0].x1) || (p.segs[0].z1 - q.segs[0].z1));
    chains.forEach((c, k) => { c.id = 'VC-CHAIN-' + String(k + 1).padStart(3, '0'); });
    const chainOfNode = new Map();
    chains.forEach(c => { chainOfNode.set(c.a, c); chainOfNode.set(c.b, c); });

    // ---- Context ----
    const angleBetween = (a, b) => {
      const d = Math.abs(a - b) % Math.PI;
      return Math.min(d, Math.PI - d);                 // 0..PI/2
    };
    const nearestRoad = (x, z, exclude) => {
      let bd = Infinity, best = null;
      for (const g of segs) {
        if (exclude.has(g.id)) continue;
        const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
        const l2 = dx * dx + dz * dz;
        let u = l2 ? ((x - g.x1) * dx + (z - g.z1) * dz) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const d = Math.hypot(x - (g.x1 + u * dx), z - (g.z1 + u * dz));
        if (d < bd) { bd = d; best = g; }
      }
      return { d: bd, seg: best };
    };
    const parcelsWithin = (x, z, r) =>
      parcels.filter(p => Math.hypot(p.x - x, p.z - z) < r).length;
    const nearestSolid = (x, z, r) => {
      let bd = Infinity, t = null;
      for (const b of bodies) {
        const qx = Math.max(b.minX, Math.min(x, b.maxX));
        const qz = Math.max(b.minZ, Math.min(z, b.maxZ));
        const d = Math.hypot(x - qx, z - qz);
        if (d < bd) { bd = d; t = b.type; }
      }
      return { d: bd, type: t };
    };
    const inPark = (x, z) => {
      const b = W.parkBounds;
      return x > b.minX - 6 && x < b.maxX + 6 && z > b.minZ - 6 && z < b.maxZ + 6;
    };
    // Can a person keep walking past the road end?
    const pedestrianOk = (x, z, dx, dz) => {
      for (let t = 1; t <= 12; t += 1.5) {
        const px = x + dx * t, pz = z + dz * t;
        for (const b of bodies) {
          if (px < b.minX - 0.5 || px > b.maxX + 0.5) continue;
          if (pz < b.minZ - 0.5 || pz > b.maxZ + 0.5) continue;
          return { ok: false, blockedBy: b.type, at: +t.toFixed(1) };
        }
      }
      return { ok: true };
    };

    // ---- Terminals ----
    const terminals = [];
    for (let i = 0; i < nodes.length; i++) {
      if (deg(i) !== 1) continue;
      const n = nodes[i];
      if (Math.hypot(n.x, n.z) > RANGE - 30) continue;

      const chain = chainOfNode.get(i) ||
        { id: 'VC-CHAIN-???', segs: nodes[i].seg, len: nodes[i].seg[0].len, type: nodes[i].seg[0].type };
      const ids = new Set(chain.segs.map(g => g.id));
      const head = nodes[i].seg[0];
      const awayX = (head._a === i) ? head.x2 - head.x1 : head.x1 - head.x2;
      const awayZ = (head._a === i) ? head.z2 - head.z1 : head.z1 - head.z2;
      const L = Math.hypot(awayX, awayZ) || 1;
      const dirX = -awayX / L, dirZ = -awayZ / L;

      const dev = W.developmentAt(n.x, n.z);
      // A margin, not zero.  The approach to reserved land is built to
      // stop ON the boundary, and reservationAt() tests the strict
      // interior — so with no margin the one terminal whose reason is
      // the reservation is the one terminal the reservation test misses,
      // and it falls through to SHOULD_CONNECT.
      const res = W.reservationAt(n.x, n.z, 3);
      const near = nearestRoad(n.x, n.z, ids);
      const served = parcelsWithin(n.x, n.z, 30);
      const solid = nearestSolid(n.x, n.z);
      const ahead = W.developmentAt(n.x + dirX * 40, n.z + dirZ * 40);
      const ped = pedestrianOk(n.x, n.z, dirX, dirZ);
      const inProtected = !!res || inPark(n.x, n.z);

      // Streets stop below BAND.EDGE; arterials run on to BAND.FRINGE.
      // Using one threshold for both called fourteen normal street ends
      // UNEXPLAINED — the taxonomy was wrong, not the world.
      const stopBand = (head.type === 'street' || head.type === 'lane')
        ? W.BAND.EDGE.min : W.BAND.FRINGE.min;

      let cls, why;
      if (res) { cls = 'RESERVATION_EDGE'; why = `stops at the ${res.name}`; }
      else if (inPark(n.x, n.z)) { cls = 'PARK_EDGE'; why = 'stops at the central green'; }
      else if (W.insideAuthoredTown(n.x, n.z, 4)) { cls = 'TOWN_EDGE'; why = 'authored town street end'; }
      else if (solid.d < 3.0 && solid.type.includes('building')) {
        cls = 'ENDS_AT_BUILDING'; why = `road face is ${solid.d.toFixed(1)} m from a building`;
      } else if (dev.intensity <= stopBand + 0.015) {
        cls = 'DEVELOPMENT_EDGE';
        why = `development thins out (${dev.intensity.toFixed(2)} at the ${head.type} limit ${stopBand})`;
      } else if (ahead.intensity <= stopBand) {
        cls = 'DEVELOPMENT_EDGE'; why = 'development ends just beyond';
      } else if (dev.settlement && head.owner && dev.settlement.id !== head.owner) {
        // The road has run out of its own settlement and into the field
        // of the next one; a settlement builds to its own edge, not into
        // its neighbour's.
        cls = 'SETTLEMENT_EDGE';
        why = `leaves ${head.owner} at the edge of ${dev.settlement.id}`;
      } else if (near.d <= 26 && near.seg.type === 'regional') {
        cls = 'DEVELOPMENT_EDGE'; why = 'ends beside a trunk road (no direct access by design)';
      } else if (near.d <= 26 && RANK[near.seg.type] >= 2 &&
                 angleBetween(head.angle, near.seg.angle) > 0.52) {
        // Only when the two roads actually meet at an angle.  A road
        // ending alongside one that runs PARALLEL to it is not a missing
        // link — joining them would merge two roads doing separate jobs,
        // which is exactly the "connect because it is close" the brief
        // warns against.
        cls = 'SHOULD_CONNECT'; why = `stops ${near.d.toFixed(1)} m short of a ${near.seg.type}`;
      } else if (near.d <= 40 && angleBetween(head.angle, near.seg.angle) <= 0.52) {
        cls = 'PARALLEL_TAKEOVER';
        why = `runs out beside a parallel ${near.seg.type} ${near.d.toFixed(1)} m away`;
      } else if (served >= 3) {
        cls = 'INTENTIONAL_CULDESAC'; why = `serves ${served} plots and turns`;
      } else if (served >= 1) {
        cls = 'DESTINATION_TERMINAL'; why = `ends at the ${served} plot(s) it serves`;
      } else {
        cls = 'UNEXPLAINED'; why = 'active development, serves nothing, near nothing';
      }

      terminals.push({
        id: 'T' + String(terminals.length + 1).padStart(2, '0'),
        chain: chain.id, x: +n.x.toFixed(1), z: +n.z.toFixed(1),
        road: head.type, chainLen: +chain.len.toFixed(0), chainSegs: chain.segs.length,
        dev: +dev.intensity.toFixed(2), band: dev.band.name,
        nearRoad: near.seg ? near.seg.type : null, nearRoadD: +near.d.toFixed(1),
        plotsServed: served,
        nearSolid: solid.type, nearSolidD: +solid.d.toFixed(1),
        inProtected, pedestrianOk: ped.ok,
        pedBlockedBy: ped.ok ? null : ped.blockedBy,
        cls, why,
      });
    }

    const tally = {};
    terminals.forEach(t => { tally[t.cls] = (tally[t.cls] || 0) + 1; });
    return {
      chains: chains.length, nodes: nodes.length, segs: segs.length,
      terminals, tally,
      againstBuilding: terminals.filter(t => t.cls === 'ENDS_AT_BUILDING').length,
      insideParcel: terminals.filter(t => t.nearSolidD < 1.0).length,
      inProtected: terminals.filter(t => t.inProtected).length,
      nearCompatible: terminals.filter(t => t.nearRoadD <= 26).length,
      noPedestrian: terminals.filter(t => !t.pedestrianOk).length,
      // A terminal can have a perfect reason in this table and still
      // read on the ground as a road that was abandoned mid-build.  The
      // treatment flags are what the generator actually DRAWS at the
      // end, so they are reported here beside the reason — otherwise
      // nothing verifies that the ending a player sees exists at all.
      treated: (() => {
        const t = { head: 0, taper: 0, untreated: 0 };
        for (const term of terminals) {
          const seg = segs.find(g =>
            (Math.hypot(g.x1 - term.x, g.z1 - term.z) < 1.5 && g.termA) ||
            (Math.hypot(g.x2 - term.x, g.z2 - term.z) < 1.5 && g.termB));
          if (!seg) { t.untreated++; continue; }
          const kind = Math.hypot(seg.x1 - term.x, seg.z1 - term.z) < 1.5
            ? seg.termA : seg.termB;
          t[kind] = (t[kind] || 0) + 1;
        }
        return t;
      })(),
    };
  }, RANGE);

  if (JSONOUT) { console.log(JSON.stringify(out, null, 1)); await browser.close(); return; }

  const unexplained = out.terminals.filter(t =>
    t.cls === 'UNEXPLAINED' && !ACCEPTED.has(`${t.x},${t.z}`));

  console.log(`--- STREET TERMINALS (${RANGE} m) ---`);
  console.log(`logical street chains : ${out.chains}`);
  console.log(`graph                 : ${out.nodes} nodes / ${out.segs} segments`);
  console.log(`terminals             : ${out.terminals.length}`);
  console.log('');
  const c = k => out.tally[k] || 0;
  console.log(`  intentional cul-de-sacs  ${c('INTENTIONAL_CULDESAC')}`);
  console.log(`  destination terminals    ${c('DESTINATION_TERMINAL')}`);
  console.log(`  development-edge         ${c('DEVELOPMENT_EDGE')}`);
  console.log(`  settlement-edge          ${c('SETTLEMENT_EDGE')}`);
  console.log(`  town-edge (authored)     ${c('TOWN_EDGE')}`);
  console.log(`  park-edge                ${c('PARK_EDGE')}`);
  console.log(`  reservation-edge         ${c('RESERVATION_EDGE')}`);
  console.log(`  parallel takeover        ${c('PARALLEL_TAKEOVER')}`);
  console.log(`  ends at building         ${c('ENDS_AT_BUILDING')}`);
  console.log(`  SHOULD_CONNECT           ${c('SHOULD_CONNECT')}`);
  console.log(`  UNEXPLAINED              ${c('UNEXPLAINED')}`);
  console.log('');
  console.log(`terminal against building        ${out.againstBuilding}`);
  console.log(`terminal inside parcel/solid     ${out.insideParcel}`);
  console.log(`terminal inside protected space  ${out.inProtected}`);
  console.log(`terminal near compatible road    ${out.nearCompatible}`);
  console.log(`terminal lacking pedestrian exit ${out.noPedestrian}`);
  console.log('');
  console.log('TERMINAL TREATMENT (what is drawn at the end)');
  console.log(`  turning head             ${out.treated.head}`);
  console.log(`  taper to track           ${out.treated.taper}`);
  console.log(`  none (authored / boundary) ${out.treated.untreated}`);
  console.log('');

  const show = LIST ? out.terminals
    : out.terminals.filter(t => t.cls === 'SHOULD_CONNECT' || t.cls === 'UNEXPLAINED' || t.cls === 'ENDS_AT_BUILDING');
  if (show.length) {
    console.log('ID   CHAIN          POSITION         ROAD       CHAIN  DEV   PLOTS PED  CLASS                 WHY');
    show.forEach(t => console.log(
      `${t.id}  ${t.chain}  ${(`${t.x},${t.z}`).padEnd(16)} ${t.road.padEnd(10)} ` +
      `${String(t.chainLen).padStart(4)}m ${String(t.dev).padStart(5)} ${String(t.plotsServed).padStart(5)} ` +
      `${(t.pedestrianOk ? 'ok' : 'NO').padEnd(4)} ${t.cls.padEnd(21)} ${t.why}`));
  }
  if (!LIST) console.log(`\n(${out.terminals.length - show.length} explained terminals hidden; --list for all)`);

  console.log('');
  console.log(unexplained.length
    ? `FAIL — ${unexplained.length} unexplained terminal(s)`
    : 'PASS — every terminal has a spatial reason');

  await browser.close();
  process.exit(unexplained.length ? 1 : 0);
})();

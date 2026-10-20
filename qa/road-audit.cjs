#!/usr/bin/env node
// ============================================================
// road-audit.cjs — trace Veridian Cap's street network.
//
// Phase 8.5 asks for every road to be traced from origin to
// destination before anything is changed.  This builds the network as a
// GRAPH — endpoints snapped together within a tolerance — and reports
// the things a road network should not have:
//
//   stubs          a road end that meets nothing and terminates at
//                  nothing meaningful
//   islands        components not reachable from the settlement gateway
//   barren roads   segments with no parcels addressing them
//   parallels      segments running alongside another within a block's
//                  width, which is two roads doing one road's job
//   park intrusion anything crossing the central green
//   blocks         closed faces the network actually encloses
//
// It reads the live world through window.MC, so it audits what is
// really there rather than what the generators intended.
//
//   node qa/road-audit.cjs [--list]
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
const verbose = process.argv.includes('--list');

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(6000);

  const r = await page.evaluate(() => {
    const RANGE = 900;                 // audit radius around Veridian Cap
    const SNAP = 4.0;                  // endpoint join tolerance, metres
    const roads = window.MC.roads;     // { segmentsNear, parcelsNear } debug hooks
    if (!roads) return { error: 'window.MC.roads not exposed' };

    const segs = roads.segmentsNear(0, 0, RANGE);
    const parcels = roads.parcelsNear(0, 0, RANGE);

    // ---- Graph ----
    const nodes = [];
    const keyOf = (x, z) => {
      for (let i = 0; i < nodes.length; i++) {
        if (Math.hypot(nodes[i].x - x, nodes[i].z - z) <= SNAP) return i;
      }
      nodes.push({ x, z, deg: 0, segs: [] });
      return nodes.length - 1;
    };
    const edges = segs.map(s => {
      const a = keyOf(s.x1, s.z1), b = keyOf(s.x2, s.z2);
      nodes[a].deg++; nodes[b].deg++;
      nodes[a].segs.push(s); nodes[b].segs.push(s);
      return { a, b, s };
    });

    // ---- Connectivity from the gateway ----
    const gate = keyOf(276, 0);
    const adj = nodes.map(() => []);
    edges.forEach(e => { adj[e.a].push(e.b); adj[e.b].push(e.a); });
    const seen = new Uint8Array(nodes.length);
    const q = [gate]; seen[gate] = 1;
    while (q.length) { const c = q.pop(); for (const n of adj[c]) if (!seen[n]) { seen[n] = 1; q.push(n); } }
    const unreachable = edges.filter(e => !seen[e.a] && !seen[e.b]).length;
    const reachedNodes = [...seen].filter(Boolean).length;

    // Component sizes, so a broken network can be told apart from a
    // network with one bad join.
    const comp = new Int32Array(nodes.length).fill(-1);
    const sizes = [];
    for (let i = 0; i < nodes.length; i++) {
      if (comp[i] >= 0) continue;
      const id = sizes.length; let n = 0; const st = [i]; comp[i] = id;
      while (st.length) { const c = st.pop(); n++;
        for (const k of adj[c]) if (comp[k] < 0) { comp[k] = id; st.push(k); } }
      sizes.push({ id, n, sample: [+nodes[i].x.toFixed(0), +nodes[i].z.toFixed(0)],
                   types: [...new Set(nodes[i].segs.map(g => g.type))] });
    }
    sizes.sort((a, b) => b.n - a.n);
    const gateComp = comp[gate];
    const topComponents = sizes.slice(0, 8);

    // ---- Stubs: a dead end that is not at the audit boundary ----
    const stubs = [];
    nodes.forEach((n, i) => {
      if (n.deg !== 1) return;
      if (Math.hypot(n.x, n.z) > RANGE - 40) return;      // leaves the audit area
      stubs.push({ x: +n.x.toFixed(1), z: +n.z.toFixed(1), type: n.segs[0].type });
    });

    // ---- Barren: segments with no parcel addressing them ----
    const barren = [];
    for (const s of segs) {
      if (s.type === 'regional') continue;               // trunk roads carry no frontage by design
      const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2;
      let n = 0;
      for (const p of parcels) {
        if (Math.hypot(p.x - mx, p.z - mz) < s.len / 2 + 30) n++;
      }
      if (n === 0) barren.push({ type: s.type, len: +s.len.toFixed(0), at: [+mx.toFixed(0), +mz.toFixed(0)] });
    }

    // ---- Blocks ----
    //
    // In a planar graph the number of enclosed faces is E - V + C
    // (Euler).  Those faces ARE the blocks: the pieces of ground a
    // network encloses.  Counting them is the only honest way to answer
    // the question the phase is actually asking, and comparing the count
    // against the built area says whether they are block-sized or
    // whether the grid has been subdivided into confetti.
    const blocks = edges.length - nodes.length + sizes.length;

    // Built area: the convex-ish extent of the parcels, approximated by
    // the area of the axis-aligned hull they occupy.
    let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity;
    for (const p of parcels) {
      if (p.x < px0) px0 = p.x; if (p.x > px1) px1 = p.x;
      if (p.z < pz0) pz0 = p.z; if (p.z > pz1) pz1 = p.z;
    }
    const builtArea = (parcels.length > 4) ? (px1 - px0) * (pz1 - pz0) : 0;
    const meanBlock = blocks > 0 ? builtArea / blocks : 0;

    // Redundancy, measured correctly after planarization: a pair of
    // parallel segments that do NOT share a node, overlap when projected
    // onto each other, and sit less than a block apart.  Before, adjacent
    // fragments of the SAME road counted as redundant with each other.
    const nodeOf = new Map();
    edges.forEach(e => { nodeOf.set(e.s, [e.a, e.b]); });
    const par = [];
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i];
      if (a.type === 'regional' || a.len < 18) continue;
      const na = nodeOf.get(a) || [];
      for (let j = i + 1; j < segs.length; j++) {
        const b = segs[j];
        if (b.type === 'regional' || b.len < 18) continue;
        if (Math.abs(Math.sin(a.angle - b.angle)) > 0.12) continue;
        const nb = nodeOf.get(b) || [];
        if (na.some(k => nb.includes(k))) continue;          // they meet
        const amx = (a.x1 + a.x2) / 2, amz = (a.z1 + a.z2) / 2;
        const bmx = (b.x1 + b.x2) / 2, bmz = (b.z1 + b.z2) / 2;
        const d = Math.hypot(amx - bmx, amz - bmz);
        if (d > 0.5 && d < 26) par.push({ d: +d.toFixed(1), at: [+amx.toFixed(0), +amz.toFixed(0)] });
      }
    }

    // ---- Park intrusion ----
    const parkHits = segs.filter(s => {
      const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2;
      return Math.abs(mx) < 21 && Math.abs(mz) < 19;
    }).map(s => ({ type: s.type, at: [+((s.x1 + s.x2) / 2).toFixed(0), +((s.z1 + s.z2) / 2).toFixed(0)] }));

    const byType = {};
    segs.forEach(s => { byType[s.type] = (byType[s.type] || 0) + 1; });
    const kmByType = {};
    segs.forEach(s => { kmByType[s.type] = (kmByType[s.type] || 0) + s.len; });
    Object.keys(kmByType).forEach(k => kmByType[k] = +(kmByType[k] / 1000).toFixed(2));

    // ---- Degree histogram: how often do roads actually meet? ----
    const deg = {};
    nodes.forEach(n => { deg[n.deg] = (deg[n.deg] || 0) + 1; });

    return {
      segments: segs.length, byType, kmByType,
      nodes: nodes.length, deg,
      reachedNodes, unreachableEdges: unreachable,
      components: sizes.length, topComponents, gateComp,
      stubs: stubs.length, stubList: stubs.slice(0, 14),
      barren: barren.length, barrenList: barren.slice(0, 10),
      parallels: par.length, parallelList: par.slice(0, 8),
      blocks, builtArea: Math.round(builtArea), meanBlock: Math.round(meanBlock),
      parkIntrusions: parkHits.length, parkList: parkHits.slice(0, 6),
      parcels: parcels.length,
    };
  });

  if (r.error) { console.error(r.error); await browser.close(); process.exit(2); }

  console.log('--- VERIDIAN CAP ROAD NETWORK (900 m) ---');
  console.log('segments        ', r.segments, JSON.stringify(r.byType));
  console.log('length km       ', JSON.stringify(r.kmByType));
  console.log('parcels served  ', r.parcels);
  console.log('graph nodes     ', r.nodes, ' degree histogram', JSON.stringify(r.deg));
  console.log('reachable nodes ', r.reachedNodes, '/', r.nodes,
              r.reachedNodes === r.nodes ? '(one network)' : '(ISLANDS)');
  console.log('unreachable edges', r.unreachableEdges);
  console.log('components      ', r.components, ' gateway is in component', r.gateComp);
  console.log('largest         ', JSON.stringify(r.topComponents));
  console.log('blocks enclosed ', r.blocks, ' built area', r.builtArea, 'm2',
              ' mean block', r.meanBlock, 'm2  (authored town block = 1596 m2)');
  console.log('');
  console.log('DEFECTS');
  console.log('  stubs          ', r.stubs);
  console.log('  barren roads   ', r.barren);
  console.log('  redundant pairs', r.parallels);
  console.log('  park intrusions', r.parkIntrusions);
  if (verbose) {
    console.log('');
    if (r.stubList.length) console.log('  stub sample    ', JSON.stringify(r.stubList));
    if (r.barrenList.length) console.log('  barren sample  ', JSON.stringify(r.barrenList));
    if (r.parallelList.length) console.log('  parallel sample', JSON.stringify(r.parallelList));
    if (r.parkList.length) console.log('  park sample    ', JSON.stringify(r.parkList));
  }

  await browser.close();
})();

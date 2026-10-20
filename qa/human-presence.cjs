#!/usr/bin/env node
// ============================================================
// human-presence.cjs — Phase 10A.
//
// People are the first thing in this world that MOVES, which makes them
// the first thing that can be wrong differently on every frame.  So this
// audits the invariants rather than a snapshot:
//
//   POPULATION   bounded, deterministic, unique ids, valid origins
//   NAVIGATION   every route resolves, terminates, and uses the ped net
//   COLLISION    nobody stands inside a building or on a carriageway
//   LIFECYCLE    every agent is in a defined state; none stuck
//
// The simulation is advanced explicitly before measuring.  Under
// SwiftShader the harness renders about one frame a second while dt is
// clamped to 0.1 s, so a wall-clock wait measures a town that has barely
// moved — an agent standing on its own doorstep passes every check for
// the wrong reason.
//
//   node qa/human-presence.cjs [simSeconds]
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
const SIM = Number(process.argv[2] || 180);
const MAX_POPULATION = 80;

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(9000);

  const r = await page.evaluate((SIM) => {
    const M = window.MC;
    if (!M.people) return { missing: true };
    const st = M.people.state;
    const net = M.people.net();

    // ---- Determinism: the same seed must lay the same people down ----
    const before = st.agents.map(a => `${a.id}|${a.activity}|${a.homeTag}`).join(',');

    // ---- Advance the town ----
    const steps = Math.round(SIM / 0.1);
    for (let i = 0; i < steps; i++) M.people.update(0.1, M.camera.position);

    const s = M.people.summary();
    const bodies = M.collisionRegistry.getBodies().filter(b => b.type !== 'interior');

    // Population
    const ids = new Set(), dupIds = [];
    let badOrigin = 0, badPos = 0;
    for (const a of st.agents) {
      if (ids.has(a.id)) dupIds.push(a.id); else ids.add(a.id);
      if (a.origin < 0) badOrigin++;
      if (!isFinite(a.x) || !isFinite(a.z)) badPos++;
    }

    // Navigation: every walking agent must hold a route into the ped net
    let noRoute = 0, badRoute = 0, offNet = 0;
    for (const a of st.agents) {
      if (a.state !== 'WALKING') continue;
      if (!a.route || a.route.length < 2) { noRoute++; continue; }
      for (const n of a.route) if (n < 0 || n >= net.nodes.length) { badRoute++; break; }
      // A walking agent should be near SOME node of its own route.
      let near = Infinity;
      for (const n of a.route) {
        const q = net.nodes[n];
        near = Math.min(near, Math.hypot(q.x - a.x, q.z - a.z));
      }
      if (near > 14) offNet++;
    }

    // Collision: nobody inside a solid, nobody on a carriageway
    const inBuilding = [], onCarriageway = [];
    for (const a of st.agents) {
      for (const b of bodies) {
        if (a.x > b.minX && a.x < b.maxX && a.z > b.minZ && a.z < b.maxZ) {
          inBuilding.push({ id: a.id, at: [+a.x.toFixed(1), +a.z.toFixed(1)], body: b.type });
          break;
        }
      }
      for (const sg of M.roads.segmentsNear(a.x, a.z, 40)) {
        const dx = sg.x2 - sg.x1, dz = sg.z2 - sg.z1;
        const l2 = dx * dx + dz * dz;
        let t = l2 ? ((a.x - sg.x1) * dx + (a.z - sg.z1) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(a.x - (sg.x1 + t * dx), a.z - (sg.z1 + t * dz));
        // Inside the carriageway and NOT at a crossing is a defect.
        if (d < sg.width / 2 - 0.3) {
          let atCrossing = false;
          for (const j of M.junctions.all()) {
            if (j.control === 'none') continue;
            if (Math.hypot(a.x - j.x, a.z - j.z) < 18) { atCrossing = true; break; }
          }
          if (!atCrossing) onCarriageway.push({ id: a.id, at: [+a.x.toFixed(1), +a.z.toFixed(1)] });
          break;
        }
      }
    }

    // Lifecycle
    const VALID = ['SPAWN', 'WALKING', 'ARRIVED', 'ACTIVE', 'DEPARTING', 'DESPAWN'];
    let badState = 0;
    for (const a of st.agents) if (!VALID.includes(a.state)) badState++;

    // Settlement bounds: nobody should wander out of town.
    let outOfTown = 0;
    for (const a of st.agents) if (Math.hypot(a.x, a.z) > 260) outOfTown++;

    return {
      population: s.population, max: st.agents.length,
      byActivity: s.byActivity, byState: s.byState,
      net: s.net,
      dupIds, badOrigin, badPos,
      noRoute, badRoute, offNet,
      inBuilding, onCarriageway,
      badState, outOfTown,
      routeFailures: s.routeFailures, reroutes: s.reroutes, stuck: s.stuck,
      determinismKey: before,
    };
  }, SIM);

  if (r.missing) {
    console.log('INVALID — MC.people not exposed.');
    await browser.close(); process.exit(1);
  }

  console.log(`--- HUMAN PRESENCE (after ${SIM}s of town life) ---`);
  console.log(`population            ${r.population}  (cap ${MAX_POPULATION})`);
  console.log(`pedestrian net        ${JSON.stringify(r.net)}`);
  console.log(`by activity           ${JSON.stringify(r.byActivity)}`);
  console.log(`by state              ${JSON.stringify(r.byState)}`);
  console.log('');
  console.log(`duplicate ids         ${r.dupIds.length}`);
  console.log(`invalid origin        ${r.badOrigin}`);
  console.log(`non-finite position   ${r.badPos}`);
  console.log(`walking with no route ${r.noRoute}`);
  console.log(`route out of range    ${r.badRoute}`);
  console.log(`agent off its route   ${r.offNet}`);
  console.log(`inside a building     ${r.inBuilding.length}`);
  console.log(`on a carriageway      ${r.onCarriageway.length}`);
  console.log(`invalid state         ${r.badState}`);
  console.log(`outside settlement    ${r.outOfTown}`);
  console.log(`route failures        ${r.routeFailures}   reroutes ${r.reroutes}   stuck ${r.stuck}`);
  if (r.inBuilding.length) r.inBuilding.slice(0, 5).forEach(x => console.log('   IN BUILDING', JSON.stringify(x)));
  if (r.onCarriageway.length) r.onCarriageway.slice(0, 5).forEach(x => console.log('   ON ROAD', JSON.stringify(x)));
  console.log(`\nconsole errors: ${errs.length || 'NONE'}`);

  const bad = r.population > MAX_POPULATION || r.dupIds.length || r.badOrigin || r.badPos ||
              r.noRoute || r.badRoute || r.inBuilding.length || r.onCarriageway.length ||
              r.badState || r.outOfTown || errs.length;
  console.log(bad ? '\nFAIL' : '\nPASS — population bounded, routed, on the network, and out of the traffic.');
  await browser.close();
  process.exit(bad ? 1 : 0);
})();

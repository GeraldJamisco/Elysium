#!/usr/bin/env node
// ============================================================
// VERIDIAN CAP REFERENCE DISTRICT — Phase 8 capture harness
//
// Phase 7's harness placed the EAGLE camera around the planet.  Phase 8
// is about what a person on the footway sees, so this one also places
// the WALK camera at named positions in the reference district and looks
// in a named direction.
//
// Walk placement goes through the real walk state (ws + camera), and
// every walk shot is taken after a collision resolve, so a viewpoint
// that is inside a wall shows up as a moved camera rather than as a
// pretty screenshot of the inside of a building.
//
//   node qa/district-capture.cjs <outdir>
//
// Env:
//   MC_ROUTES=1   also walk the reference routes and report whether each
//                 leg physically completed (see ROUTES below)
// ============================================================

const path = require('path');
const fs = require('fs');

let puppet;
try { puppet = require('puppeteer-core'); } catch {}
if (!puppet) { try { puppet = require(path.join(process.env.TEMP || '/tmp', 'node_modules', 'puppeteer-core')); } catch {} }
if (!puppet) { console.error('puppeteer-core not found'); process.exit(1); }

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const chromePath = CHROME_PATHS.find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const outDir = path.resolve(__dirname, process.argv[2] || 'phase8/before');

// ---- Eagle views over the reference district ----
// The district is the nine authored blocks: x in [-76, 76], z in [-70, 70].
const EAGLE = [
  // A near-plan view: the only way to judge whether the BLOCKS read, as
  // opposed to whether the street frontages do.
  { n: 'E0-district-plan', x: 0, z: 0, dist: 300, pitch: 1.44, yaw: 0.35 },
  { n: 'E0b-block-plan', x: -55, z: -51, dist: 120, pitch: 1.42, yaw: 0.35 },
  { n: 'E1-district-centre', x: 0, z: 0, dist: 210, pitch: 1.02, yaw: 0.65 },
  { n: 'E2-district-north', x: 0, z: -40, dist: 150, pitch: 0.72, yaw: 1.57 },
  { n: 'E3-district-south', x: 0, z: 40, dist: 150, pitch: 0.72, yaw: -1.57 },
  { n: 'E4-district-east', x: 45, z: 0, dist: 150, pitch: 0.72, yaw: 3.14 },
  { n: 'E5-district-west', x: -45, z: 0, dist: 150, pitch: 0.72, yaw: 0.0 },
  { n: 'E6-hall-and-park', x: -26, z: -8, dist: 105, pitch: 0.80, yaw: 0.35 },
  { n: 'E7-block-interior', x: -55, z: -51, dist: 95, pitch: 0.90, yaw: 0.8 },
];

// ---- Walk viewpoints: [x, z, yaw] -- yaw 0 looks toward -Z (north) ----
// Positions are on footways and paths, never inside a plot.
const WALK = [
  { n: 'W1-spawn', x: -22, z: -30.75, yaw: 0 },
  { n: 'W2-hall-across-street', x: -22.6, z: -8.5, yaw: Math.PI / 2 },
  { n: 'W3-hall-approach', x: -30, z: -8.5, yaw: Math.PI / 2 },
  { n: 'W4-hall-entrance', x: -34.5, z: -8.5, yaw: Math.PI / 2 },
  { n: 'W5-park-west-edge', x: -19.5, z: -8.5, yaw: -Math.PI / 2 },
  { n: 'W6-park-centre', x: 0, z: 6, yaw: 0 },
  { n: 'W7-residential-frontage', x: -22.4, z: -45, yaw: Math.PI / 2 },
  { n: 'W8-intersection', x: -27.5, z: -25.5, yaw: 0 },
  { n: 'W9-block-interior', x: -55, z: -51, yaw: 0 },
  { n: 'W10-main-street', x: 27.5, z: 0, yaw: 0 },
  { n: 'W11-avenue-out', x: 88, z: 0, yaw: Math.PI / 2 },
];

// ---- Reference walk routes: each leg must physically complete ----
const ROUTES = [
  { n: 'A home->park', legs: [[-22.4, -45], [-22.4, -25.5], [-19.5, -8.5], [-6, -6], [0, 0]] },
  { n: 'B home->hall', legs: [[-22.4, -45], [-22.4, -25.5], [-22.6, -8.5], [-30, -8.5], [-35.5, -8.5]] },
  { n: 'C hall->park', legs: [[-35.5, -8.5], [-30, -8.5], [-22.6, -8.5], [-19.5, -8.5], [0, 0]] },
  { n: 'D neighbourhood->main street', legs: [[-55, -30.75], [-27.5, -30.75], [0, -30.75], [27.5, -30.75], [27.5, 0]] },
  { n: 'E core->outer', legs: [[27.5, 0], [60, 0], [88, 0], [130, 0], [190, 0]] },
];

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR:', e.message); });
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE-ERR:', m.text()); } });

  fs.mkdirSync(outDir, { recursive: true });
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(2500);

  // ---- Orbit -> Eagle via the site card, as a player would ----
  for (let i = 0; i < 25; i++) {
    const pin = await page.evaluate(() => window.MC.getPinScreen('Veridian Cap'));
    if (pin && pin.visible) { await page.mouse.click(pin.x, pin.y); break; }
    await page.mouse.move(700, 300); await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 20 }); await page.mouse.up();
    await sleep(300);
  }
  await sleep(800);
  const go = await page.$('.c-go');
  if (go) await go.click();
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => window.MC.stageState?.current) === 'eagle') break;
    await sleep(250);
  }
  if (await page.evaluate(() => window.MC.stageState?.current) !== 'eagle') {
    console.error('FAILED to reach eagle'); await browser.close(); process.exit(1);
  }
  await page.evaluate(() => {
    document.querySelectorAll('.card-close').forEach(b => b.click());
    const reg = document.getElementById('nav-reg-toggle'); if (reg) reg.click();
  });
  await sleep(4000);

  const stats = async () => page.evaluate(() => {
    const r = window.MC.renderer.info.render;
    let meshes = 0;
    window.MC.scene.traverse(o => { if (o.isMesh && o.visible) meshes++; });
    return {
      calls: r.calls, tris: r.triangles, meshes,
      bodies: window.MC.collisionRegistry.getBodies().length,
    };
  });

  // ---- EAGLE ----
  for (const v of EAGLE) {
    await page.evaluate(({ x, z, dist, pitch, yaw }) => {
      const e = window.MC.eagle;
      e.target.x = x; e.target.z = z; e.target.y = 0;
      e.distance = dist; e.pitch = pitch; e.yaw = yaw;
      window.MC.applyEagleCam();
    }, v);
    await sleep(7000);
    await page.screenshot({ path: path.join(outDir, v.n + '.png') });
    console.log(v.n, JSON.stringify(await stats()));
  }

  // ---- Descend to WALK ----
  await page.evaluate(() => { const e = window.MC.eagle; e.target.set(0, 0, 0); window.MC.applyEagleCam(); });
  await sleep(1500);
  await page.keyboard.press('f');
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => window.MC.stageState?.current) === 'walk') break;
    await sleep(250);
  }
  if (await page.evaluate(() => window.MC.stageState?.current) !== 'walk') {
    console.error('FAILED to reach walk'); await browser.close(); process.exit(1);
  }
  await sleep(2000);

  // Place the walk camera, then resolve collision so a viewpoint inside a
  // wall is reported rather than quietly photographed.
  // The viewpoint is NOT corrected — a named viewpoint that turns out to be
  // inside solid geometry is a defect in the district, and quietly sliding
  // the camera out of it would photograph over the problem.
  const place = (x, z, yaw) => page.evaluate(({ x, z, yaw }) => {
    const { camera, collisionRegistry, ws } = window.MC;
    camera.position.set(x, 2.05, z);
    ws.euler.set(0, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(ws.euler);
    const solid = collisionRegistry.query(x, z, 0.4).filter(b => b.type !== 'interior');
    return { solid: solid.length, tags: solid.slice(0, 2).map(b => b.tag || b.type) };
  }, { x, z, yaw });

  for (const v of WALK) {
    const res = await place(v.x, v.z, v.yaw);
    await sleep(3500);
    await page.screenshot({ path: path.join(outDir, v.n + '.png') });
    console.log(v.n, res.solid ? `SOLID viewpoint (${res.tags.join(',')})` : 'ok');
  }

  // ---- Reference routes ----
  if (process.env.MC_ROUTES) {
    console.log('\n---- REFERENCE ROUTES ----');
    for (const rt of ROUTES) {
      const legs = [];
      for (let i = 0; i < rt.legs.length - 1; i++) {
        const [ax, az] = rt.legs[i], [bx, bz] = rt.legs[i + 1];
        const r = await page.evaluate(({ ax, az, bx, bz }) => {
          const { camera, collisionRegistry } = window.MC;
          const F = b => b.type !== 'interior';
          const fix = collisionRegistry.resolveOverlap(ax, az, 0.4);
          let x = fix ? fix.x : ax, z = fix ? fix.z : az;
          const total = Math.hypot(bx - x, bz - z);
          const steps = Math.max(1, Math.ceil(total / 0.25));
          for (let s = 0; s < steps; s++) {
            const tx = x + (bx - x) / (steps - s);
            const tz = z + (bz - z) / (steps - s);
            const res = collisionRegistry.preventTunneling(x, z, tx - x, tz - z, 0.4, F);
            x = res.x; z = res.z;
          }
          camera.position.set(x, 2.05, z);
          return { end: [+x.toFixed(2), +z.toFixed(2)], gap: +Math.hypot(bx - x, bz - z).toFixed(2) };
        }, { ax, az, bx, bz });
        legs.push(`${i + 1}:${r.gap <= 1.2 ? 'OK' : 'BLOCKED gap=' + r.gap}`);
      }
      console.log(rt.n.padEnd(30), legs.join('  '));
    }
  }

  console.log('\nconsole errors:', errors.length === 0 ? 'NONE' : errors.length);
  await browser.close();
  console.log('captured ->', outDir);
})();

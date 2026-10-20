#!/usr/bin/env node
// ============================================================
// perf.cjs — measured render budget at fixed viewpoints.
//
// The brief asks for before/after numbers and says not to claim an
// improvement without measuring one.  This samples draw calls,
// triangles, visible meshes, collision bodies and frame time at the
// same three viewpoints every run, so two runs are comparable.
//
// Frame time is measured over 90 frames of requestAnimationFrame with
// the camera held still.  It is SwiftShader here, so the absolute
// numbers are software-rendering numbers and only the ratio between
// runs means anything.
//
//   node qa/perf.cjs
// ============================================================

const path = require('path');
const fs = require('fs');

let puppet;
try { puppet = require('puppeteer-core'); } catch {}
if (!puppet) { try { puppet = require(path.join(process.env.TEMP || '/tmp', 'node_modules', 'puppeteer-core')); } catch {} }
if (!puppet) { console.error('puppeteer-core not found'); process.exit(1); }

const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromePath) { console.error('Chrome not found'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIEWS = [
  { n: 'eagle-district-plan', x: 0, z: 0, dist: 300, pitch: 1.44, yaw: 0.35 },
  { n: 'eagle-district-centre', x: 0, z: 0, dist: 210, pitch: 1.02, yaw: 0.65 },
  { n: 'eagle-hall-and-park', x: -26, z: -8, dist: 105, pitch: 0.80, yaw: 0.35 },
];

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new',
    // SwiftShader renders a frame in well over a second here, so the
    // frame sample can outrun puppeteer's default 30 s protocol timeout.
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(2500);

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
  // ASSERT we actually reached Eagle.
  //
  // The Phase 8.5 run reported 47 draw calls and 43,208 triangles for all
  // three views and I nearly published it as settlement performance.  It
  // was the orbit globe: the descend had silently failed, the page was
  // still in orbit, and the numbers were identical every time precisely
  // because nothing had changed.  A harness that cannot tell you it
  // measured the wrong thing is worse than no harness.
  const stage = await page.evaluate(() => window.MC.stageState?.current);
  if (stage !== 'eagle') {
    console.error(`FAILED to reach eagle (stage=${stage}) — refusing to report orbit numbers as settlement performance`);
    await browser.close();
    process.exit(1);
  }
  await page.evaluate(() => {
    document.querySelectorAll('.card-close').forEach(b => b.click());
    const reg = document.getElementById('nav-reg-toggle'); if (reg) reg.click();
  });
  await sleep(6000);

  // Second guard: the orbit globe renders ~47 calls / ~43k triangles.
  // Anything that close to it is not a settlement view.
  const sanity = await page.evaluate(() => {
    const i = window.MC.renderer.info.render;
    return { calls: i.calls, tris: i.triangles, ground: window.MC.scene.getObjectByName('globe')?.visible };
  });
  if (sanity.ground !== false || sanity.tris < 100000) {
    console.error('REFUSING to report: scene looks like orbit, not the settlement —', JSON.stringify(sanity));
    await browser.close();
    process.exit(1);
  }

  console.log(['VIEW', 'CALLS', 'TRIS', 'MESHES', 'BODIES', 'MS/FRAME'].join('\t'));
  for (const v of VIEWS) {
    await page.evaluate(({ x, z, dist, pitch, yaw }) => {
      const e = window.MC.eagle;
      e.target.x = x; e.target.z = z; e.target.y = 0;
      e.distance = dist; e.pitch = pitch; e.yaw = yaw;
      window.MC.applyEagleCam();
    }, v);
    await sleep(8000);

    const r = await page.evaluate(() => new Promise(resolve => {
      const info = window.MC.renderer.info.render;
      let meshes = 0;
      window.MC.scene.traverse(o => { if (o.isMesh && o.visible) meshes++; });
      const snap = {
        calls: info.calls, tris: info.triangles, meshes,
        bodies: window.MC.collisionRegistry.getBodies().length,
      };
      let n = 0; const t0 = performance.now();
      const tick = () => {
        if (++n >= 20) { snap.ms = (performance.now() - t0) / n; resolve(snap); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    console.log([v.n, r.calls, r.tris, r.meshes, r.bodies, r.ms.toFixed(1)].join('\t'));
  }

  await browser.close();
})();

#!/usr/bin/env node
// ============================================================
// walk-forward.cjs — do what a player does.
//
// Enter Eagle, press F, and walk forward from wherever the camera
// lands, photographing the way ahead every few metres and reporting
// every solid body within reach.  The point is to find things standing
// in the road, which no aerial view shows and no graph audit catches:
// the collision registry knows an object is solid, but only walking
// into it tells you it should not be there.
//
//   node qa/walk-forward.cjs <outdir> [steps] [stepLen]
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
const outDir = path.resolve(__dirname, process.argv[2] || 'walkfwd');
const STEPS = Number(process.argv[3] || 14);
const STEP = Number(process.argv[4] || 12);

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 800 });
  const errs = [];
  page.on('pageerror', e => { errs.push(e.message); console.log('PAGEERROR:', e.message); });

  fs.mkdirSync(outDir, { recursive: true });
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
  await page.evaluate(() => {
    document.querySelectorAll('.card-close').forEach(b => b.click());
    const r = document.getElementById('nav-reg-toggle'); if (r) r.click();
  });
  await sleep(4000);

  // Press F, exactly as a player would.
  await page.keyboard.press('f');
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate(() => window.MC.stageState?.current) === 'walk') break;
    await sleep(250);
  }
  if (await page.evaluate(() => window.MC.stageState?.current) !== 'walk') {
    console.error('FAILED to reach walk'); await browser.close(); process.exit(1);
  }
  await sleep(2500);

  const start = await page.evaluate(() => {
    const p = window.MC.camera.position;
    return { x: +p.x.toFixed(2), z: +p.z.toFixed(2) };
  });
  console.log(`landed at (${start.x}, ${start.z}) — walking forward ${STEPS} x ${STEP} m\n`);

  const hits = [];
  for (let s = 0; s <= STEPS; s++) {
    const r = await page.evaluate(({ s, STEP }) => {
      const { camera, collisionRegistry, THREE, ws } = window.MC;
      // Forward as the camera is actually facing.
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      fwd.y = 0; fwd.normalize();
      if (s > 0) {
        // Move with collision, as walking does.
        const res = collisionRegistry.preventTunneling(
          camera.position.x, camera.position.z, fwd.x * STEP, fwd.z * STEP, 0.4,
          b => b.type !== 'interior');
        camera.position.x = res.x; camera.position.z = res.z;
      }
      camera.position.y = 2.05;
      const p = camera.position;
      // Everything solid in the corridor just ahead.
      const ahead = [];
      for (let d = 0; d <= 10; d += 1.0) {
        const qx = p.x + fwd.x * d, qz = p.z + fwd.z * d;
        for (const b of collisionRegistry.query(qx, qz, 1.2)) {
          if (b.type === 'interior') continue;
          if (!ahead.some(a => a.tag === (b.tag || b.type))) {
            ahead.push({ tag: b.tag || b.type, type: b.type,
                         d: +d.toFixed(1),
                         w: +(b.maxX - b.minX).toFixed(2),
                         h: +(b.maxY - b.minY).toFixed(2),
                         dp: +(b.maxZ - b.minZ).toFixed(2) });
          }
        }
      }
      return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), ahead };
    }, { s, STEP });

    await sleep(2200);
    const name = `S${String(s).padStart(2, '0')}-${r.x}_${r.z}`.replace(/\./g, 'p');
    await page.screenshot({ path: path.join(outDir, name + '.png') });

    // Anything solid that is NOT a building/tree/lamp/hedge is suspicious
    // in a road corridor.
    const odd = r.ahead.filter(a =>
      !['building', 'proc-building', 'tree', 'lamp', 'hedge', 'seat', 'bench', 'basin'].includes(a.type));
    console.log(`S${String(s).padStart(2, '0')} (${r.x}, ${r.z})  solid ahead: ` +
      (r.ahead.length ? r.ahead.map(a => `${a.type}@${a.d}m`).join(' ') : 'clear') +
      (odd.length ? `   <-- ODD: ${odd.map(o => o.tag).join(', ')}` : ''));
    if (odd.length) hits.push({ at: [r.x, r.z], odd });
  }

  console.log('\nconsole errors:', errs.length || 'NONE');
  if (hits.length) {
    console.log('\nSUSPICIOUS OBJECTS IN THE WALKED CORRIDOR:');
    hits.forEach(h => console.log(' ', JSON.stringify(h)));
  }
  console.log('captured ->', outDir);
  await browser.close();
})();

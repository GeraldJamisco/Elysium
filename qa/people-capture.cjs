#!/usr/bin/env node
// ============================================================
// people-capture.cjs — Phase 10A player-perspective evidence.
//
// qa/spot.cjs cannot photograph a populated town.  Not because the
// people are missing — they are there, drawn, and routing — but because
// the simulation advances with the FRAME, and under SwiftShader the
// harness renders about one frame a second while dt is clamped to 0.1 s.
// Eleven seconds of capture buys roughly a metre of walking, so every
// agent is still standing on its own doorstep.
//
// So this drives the clock explicitly: reach Walk, step updatePeople a
// known number of times to advance the town by a stated number of
// simulated seconds, then place the camera and shoot.  The stepping is
// the same function the render loop calls with the same clamp — it is
// fast-forward, not a different simulation.
//
//   node qa/people-capture.cjs <outdir> <simSeconds> <spec> [spec...]
//   spec:  name:x,z,yaw          walk view
//          E:name:x,z,dist,pitch,yaw   eagle view
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
const outDir = path.resolve(__dirname, process.argv[2] || 'people');
const SIM_SECONDS = Number(process.argv[3] || 90);
const specs = process.argv.slice(4);

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 800 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

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
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate(() => window.MC.stageState?.current) === 'eagle') break;
    await sleep(250);
  }
  await page.evaluate(() => {
    document.querySelectorAll('.card-close').forEach(b => b.click());
    const r = document.getElementById('nav-reg-toggle'); if (r) r.click();
  });
  await sleep(4500);

  if (await page.evaluate(() => window.MC.stageState?.current) !== 'eagle') {
    console.log('INVALID — never reached eagle.');
    await browser.close(); process.exit(1);
  }

  // ---- Advance the town ----
  const advanced = await page.evaluate(async (secs) => {
    const M = window.MC;
    const steps = Math.round(secs / 0.1);
    for (let i = 0; i < steps; i++) {
      M.people.update(0.1, M.camera.position);
    }
    return M.people.summary().byState;
  }, SIM_SECONDS);
  console.log(`advanced ${SIM_SECONDS}s of town life ->`, JSON.stringify(advanced));

  const ordered = [...specs.filter(x => x.startsWith('E:')), ...specs.filter(x => !x.startsWith('E:'))];
  let walked = false;
  for (const spec of ordered) {
    const parts = spec.split(':');
    if (parts[0] === 'E') {
      const [, n, coords] = parts;
      const [x, z, dist, pitch, yaw] = coords.split(',').map(Number);
      await page.evaluate(v => {
        const e = window.MC.eagle;
        e.target.set(v.x, 0, v.z); e.distance = v.dist; e.pitch = v.pitch; e.yaw = v.yaw;
        window.MC.applyEagleCam();
      }, { x, z, dist, pitch, yaw });
      await sleep(8000);
      const st = await page.evaluate(() => window.MC.stageState?.current);
      if (st !== 'eagle') { console.log(n, 'SKIPPED — stage is', st); continue; }
      await page.screenshot({ path: path.join(outDir, n + '.png') });
      console.log(n, 'ok');
    } else {
      if (!walked) {
        await page.keyboard.press('f');
        for (let i = 0; i < 90; i++) {
          if (await page.evaluate(() => window.MC.stageState?.current) === 'walk') break;
          await sleep(250);
        }
        await sleep(2000); walked = true;
      }
      const [n, coords] = parts;
      const [x, z, yaw] = coords.split(',').map(Number);
      const near = await page.evaluate(v => {
        const { camera, ws, collisionRegistry } = window.MC;
        camera.position.set(v.x, 2.05, v.z);
        ws.euler.set(0, v.yaw, 0, 'YXZ');
        camera.quaternion.setFromEuler(ws.euler);
        const st = window.MC.people.state;
        let n = 0;
        for (const a of st.agents) if (Math.hypot(a.x - v.x, a.z - v.z) < 45) n++;
        return { solid: collisionRegistry.query(v.x, v.z, 0.4).filter(b => b.type !== 'interior').length, n };
      }, { x, z, yaw });
      await sleep(3200);
      await page.screenshot({ path: path.join(outDir, n + '.png') });
      console.log(n, near.solid ? 'SOLID' : 'ok', `· ${near.n} people within 45 m`);
    }
  }

  console.log('console errors:', errs.length || 'NONE');
  await browser.close();
})();

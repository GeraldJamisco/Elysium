#!/usr/bin/env node
// Phase 7 visual sanitation — Eagle/Walk survey capture harness.
// Places the eagle camera at explicit world positions/altitudes so the
// generated civilization can be judged from above and from the ground.
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
const outDir = path.resolve(__dirname, process.argv[2] || 'phase7/before');

// Each view: eagle target (x,z), camera distance, pitch (rad), yaw (rad).
const VIEWS = [
  { n: '01-eagle-veridian',   x: 0,    z: 0,     dist: 320,  pitch: 0.95, yaw: 0.6 },
  { n: '02-eagle-high',       x: 400,  z: 0,     dist: 900,  pitch: 1.05, yaw: 0.6 },
  { n: '03-eagle-edge',       x: 500,  z: 150,   dist: 420,  pitch: 0.75, yaw: 0.9 },
  { n: '04-eagle-suburb',     x: 700,  z: -250,  dist: 320,  pitch: 0.70, yaw: 1.4 },
  { n: '05-eagle-rural',      x: 1200, z: 300,   dist: 500,  pitch: 0.70, yaw: 0.5 },
  { n: '06-eagle-hinterland', x: 2000, z: 600,   dist: 700,  pitch: 0.80, yaw: 0.4 },
  { n: '07-eagle-corridor',   x: 900,  z: 0,     dist: 260,  pitch: 0.45, yaw: 0.0 },
  { n: '08-eagle-low-street', x: 450,  z: 40,    dist: 120,  pitch: 0.40, yaw: 1.1 },
  // Thornwater: a town, 1.2 km out — the reference for a settlement
  // that is not Veridian Cap having a centre of its own.
  { n: '09-town-thornwater',  x: 606,  z: 1057,  dist: 360,  pitch: 0.85, yaw: 0.7 },
  { n: '10-town-core',        x: 606,  z: 1057,  dist: 130,  pitch: 0.50, yaw: 1.2 },
  // Selthwaite: a hamlet.  It must not look like a small town.
  { n: '11-hamlet',           x: 1615, z: -185,  dist: 190,  pitch: 0.60, yaw: 0.9 },
  // Ground level, out in the suburbs and out on a country road.
  { n: '12-street-level',     x: 420,  z: 120,   dist: 45,   pitch: 0.16, yaw: 1.0 },
  { n: '13-rural-road',       x: 1050, z: 500,   dist: 55,   pitch: 0.14, yaw: 0.3 },
  { n: '14-settlement-edge',  x: 640,  z: 90,    dist: 95,   pitch: 0.24, yaw: 2.1 },
];



(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()); });

  fs.mkdirSync(outDir, { recursive: true });
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(2500);

  // Enter eagle by clicking the Veridian Cap pin.
  for (let i = 0; i < 25; i++) {
    const pin = await page.evaluate(() => window.MC.getPinScreen('Veridian Cap'));
    if (pin && pin.visible) { await page.mouse.click(pin.x, pin.y); break; }
    await page.mouse.move(700, 300); await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 20 }); await page.mouse.up();
    await sleep(300);
  }
  await sleep(800);
  // The pin opens the site card; the card's CTA is what actually descends.
  const go = await page.$('.c-go');
  if (go) { await go.click(); }
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => window.MC.stageState?.current) === 'eagle') break;
    await sleep(250);
  }
  if (await page.evaluate(() => window.MC.stageState?.current) !== 'eagle') {
    console.error('FAILED to reach eagle stage'); await browser.close(); process.exit(1);
  }
  // Close the survey register / site card so they do not cover the world.
  await page.evaluate(() => {
    document.querySelectorAll('.card-close').forEach(b => b.click());
    const reg = document.getElementById('nav-reg-toggle'); if (reg) reg.click();
  });
  await sleep(1500);

  for (const v of VIEWS) {
    await page.evaluate(({ x, z, dist, pitch, yaw }) => {
      const e = window.MC.eagle;
      e.target.x = x; e.target.z = z; e.target.y = 0;
      e.distance = dist; e.pitch = pitch; e.yaw = yaw;
      window.MC.applyEagleCam();
    }, v);
    // Let the streaming queue catch up (2 chunks/frame).
    await sleep(14000);
    if (process.env.MC_HIDE) {
      await page.evaluate(n => {
        const o = window.MC.scene.getObjectByName(n);
        if (o) o.visible = false;
        else { // not a named object: try the sky dome
          if (n === 'sky' && window.MC.scene.children) {
            window.MC.scene.traverse(c => { if (c.material && c.material.type === 'ShaderMaterial' && c.geometry && c.geometry.type === 'SphereGeometry') c.visible = false; });
          }
        }
      }, process.env.MC_HIDE);
      await sleep(600);
    }
    await page.screenshot({ path: path.join(outDir, v.n + '.png') });
    const stat = await page.evaluate(() => ({
      chunks: window.MC.procWorld ? window.MC.procWorld.getChunkCount() : -1,
      bodies: window.MC.collisionRegistry?.bodies?.length ?? -1,
      tris: window.MC.renderer?.info?.render?.triangles ?? -1,
      globeVis: window.MC.scene.getObjectByName('globe')?.visible,
      calls: window.MC.renderer?.info?.render?.calls ?? -1,
    }));
    console.log(v.n, JSON.stringify(stat));
    if (process.env.MC_RAY && v.n === process.env.MC_RAY) {
      const probe = await page.evaluate(() => {
        const { THREE, camera, scene } = window.MC;
        const rc = new THREE.Raycaster();
        const res = [];
        for (const [sx, sy] of [[655, 265], [640, 290], [700, 285]]) {
          rc.setFromCamera(new THREE.Vector2((sx / 1280) * 2 - 1, -(sy / 800) * 2 + 1), camera);
          rc.far = 30000;
          res.push({ px: [sx, sy], hits: rc.intersectObjects(scene.children, true)
            .filter(h => h.object.visible)
            .slice(0, 3).map(h => ({ n: h.object.name || h.object.type, d: Math.round(h.distance) })) });
        }
        return { cam: camera.position.toArray().map(Math.round), res };
      });
      console.log('RAY', JSON.stringify(probe));
    }
  }

  await browser.close();
  console.log('captured ->', outDir);
})();

// Veridian Cap visual capture harness
const path = require('path');
const fs = require('fs');
let puppet = null;
for (const d of ['C:/Users/t/AppData/Local/Temp', process.env.TEMP, '/tmp']) {
  try { puppet = require(path.join(d, 'node_modules', 'puppeteer-core')); break; } catch {}
}
if (!puppet) { try { puppet = require('puppeteer-core'); } catch {} }
if (!puppet) { console.error('no puppeteer-core'); process.exit(1); }

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find(p => { try { fs.accessSync(p); return true; } catch { return false; } });

const OUT = process.argv[2] || path.join(process.env.TEMP, 'shots');
const TAG = process.argv[3] || 'base';
const ONLY = process.argv[4] || null;   // optional station filter
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fixed stations: [name, pos(x,y,z), yaw, pitch]
const STATIONS = [
  ['street',     [-22, 2.05, -30.75], 0, 0],
  ['intersect',  [-17.25, 2.05, -21.5], -0.9, -0.06],
  ['park-app',   [0, 2.05, 15.5], 0, -0.02],
  ['park-plaza', [0, 2.05, 7.0], 0, 0.05],
  ['park-edge',  [-13, 2.05, -2], Math.PI, -0.04],
  ['courtyard',  [-40, 2.05, -40], 0.6, -0.05],
  ['avenue',     [88, 2.05, 0], Math.PI / 2, -0.03],
];

(async () => {
  const browser = await puppet.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
           '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
           '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));

  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(7000);

  if (!await page.evaluate(() => !!window.MC)) {
    console.error('MC not ready'); await browser.close(); process.exit(1);
  }

  const shot = async name => {
    if (ONLY && !name.includes(ONLY)) return;
    await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
  };

  // 1. The opening frame, exactly as the player first sees it.
  await shot('00-orbit-initial');

  // 2. Rotate Amarine so Veridian Cap's region faces the camera.
  const p = await page.evaluate(() => {
    const MC = window.MC;
    const root = MC.scene.getObjectByName('globe');
    let best = null, bestScore = -1e9;
    for (let i = 0; i < 360; i++) {
      root.rotation.y = i / 360 * Math.PI * 2;
      root.updateMatrixWorld(true);
      const s = MC.getPinScreen('Veridian Cap');
      if (s && s.visible) {
        const score = -Math.abs(s.x - innerWidth / 2) - Math.abs(s.y - innerHeight / 2);
        if (score > bestScore) { bestScore = score; best = { x: s.x, y: s.y, rot: root.rotation.y }; }
      }
    }
    if (best) { root.rotation.y = best.rot; root.updateMatrixWorld(true); }
    return best;
  });
  await sleep(700);
  await shot('01-orbit-region');

  // 2b. Veridian Cap carried round onto the night side: the only lit place
  //     on Amarine should be findable in the dark.
  await page.evaluate(() => {
    const MC = window.MC;
    const root = MC.scene.getObjectByName('globe');
    const start = root.rotation.y;
    let best = null, bestScore = -1e9;
    for (let i = 0; i < 360; i++) {
      root.rotation.y = i / 360 * Math.PI * 2;
      root.updateMatrixWorld(true);
      const pin = MC.pins.find(q => q.data.real);
      const world = pin.mesh.getWorldPosition(new (MC.THREE ? MC.THREE.Vector3 : Object)());
      const s = MC.getPinScreen('Veridian Cap');
      if (!s || !s.visible) continue;
      // Prefer the deepest night position that is still facing the camera.
      const sun = MC.orbitSun;
      const n = pin.dir.clone().applyQuaternion(root.quaternion).normalize();
      const ndl = n.dot(sun);
      const score = -Math.abs(ndl + 0.35);
      if (score > bestScore) { bestScore = score; best = root.rotation.y; }
    }
    root.rotation.y = best !== null ? best : start;
    root.updateMatrixWorld(true);
  });
  await sleep(700);
  await shot('01b-orbit-night');

  // Restore a daylit view of the settlement region before approaching.
  await page.evaluate(() => {
    const MC = window.MC;
    const root = MC.scene.getObjectByName('globe');
    let best = null, bestScore = -1e9;
    for (let i = 0; i < 360; i++) {
      root.rotation.y = i / 360 * Math.PI * 2;
      root.updateMatrixWorld(true);
      const s = MC.getPinScreen('Veridian Cap');
      if (s && s.visible) {
        const score = -Math.abs(s.x - innerWidth / 2) - Math.abs(s.y - innerHeight / 2);
        if (score > bestScore) { bestScore = score; best = root.rotation.y; }
      }
    }
    if (best !== null) { root.rotation.y = best; root.updateMatrixWorld(true); }
  });
  await sleep(400);

  // 3. Zoomed orbit, approaching the settlement.
  const zoomed = await page.evaluate(() => {
    const MC = window.MC;
    const c = MC.camera;
    const dir = c.position.clone().normalize();
    c.position.copy(dir.multiplyScalar(120));
    MC.controls && MC.controls.orbit && MC.controls.orbit.update();
    c.lookAt(0, 0, 0);
    const s = MC.getPinScreen('Veridian Cap');
    return s ? { x: s.x, y: s.y } : null;
  });
  await sleep(700);
  await shot('02-orbit-approach');

  const click = zoomed || p;
  if (click) await page.mouse.click(click.x, click.y); else console.error('pin screen null');
  await sleep(4200);
  await shot('03-eagle');

  const setEagle = async (dist, pitch, yaw, tx, tz) => {
    await page.evaluate(({ dist, pitch, yaw, tx, tz }) => {
      const { eagle, camera } = window.MC;
      eagle.distance = dist; eagle.pitch = pitch; eagle.yaw = yaw;
      eagle.target.set(tx, 0, tz);
      const cp = Math.sin(pitch), sp = Math.cos(pitch);
      camera.position.set(tx + dist * sp * Math.cos(yaw), dist * cp, tz + dist * sp * Math.sin(yaw));
      camera.lookAt(eagle.target);
    }, { dist, pitch, yaw, tx, tz });
    await sleep(500);
  };
  await setEagle(120, 0.82, 0.85, 10, 0);
  await shot('04-eagle-wide');
  await setEagle(58, 1.05, 2.3, 0, 0);
  await shot('05-eagle-low');

  // Descend to Walk.
  await page.keyboard.press('KeyF');
  await sleep(1500);

  const place = async (pos, yaw, pitch) => {
    await page.evaluate(({ pos, yaw, pitch }) => {
      const { camera, ws } = window.MC;
      camera.position.set(pos[0], pos[1], pos[2]);
      ws.euler.set(pitch, yaw, 0, 'YXZ');
      camera.quaternion.setFromEuler(ws.euler);
    }, { pos, yaw, pitch });
    await sleep(450);
  };

  for (const [name, pos, yaw, pitch] of STATIONS) {
    await place(pos, yaw, pitch);
    await shot(`10-${name}`);
  }

  // Frontage and entrance views, aimed at real buildings from the registry.
  const picks = await page.evaluate(() => {
    const OUT = {};
    const bs = window.MC.buildings;
    const norm = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };
    const view = (b, back) => {
      const [nx, nz] = norm[b.entrance];
      const half = (b.entrance === 'north' || b.entrance === 'south') ? b.d / 2 : b.w / 2;
      return {
        pos: [b.cx + nx * (half + back), 2.05, b.cz + nz * (half + back)],
        yaw: Math.atan2(nx, nz),
        family: b.family, h: b.height,
      };
    };
    // The building the player first faces on entering Walk.
    const spawn = [-22, -30.75];
    const near = bs.filter(b => b.entrance === 'north')
      .sort((a, c) => Math.hypot(a.cx - spawn[0], a.cz - spawn[1]) -
                      Math.hypot(c.cx - spawn[0], c.cz - spawn[1]))[0];
    if (near) { OUT.entrance = view(near, 7.5); OUT.frontage = view(near, 17); }
    const civic = bs.find(b => b.family === 'civic');
    if (civic) OUT.civic = view(civic, 16);
    const tall = bs.filter(b => b.family === 'landmark').sort((a, c) => c.height - a.height)[0];
    if (tall) OUT.landmark = view(tall, 24);
    const home = bs.find(b => b.family === 'residence');
    if (home) OUT.residence = view(home, 15);
    return OUT;
  });

  for (const [k, v] of Object.entries(picks)) {
    await place(v.pos, v.yaw, k === 'landmark' ? 0.22 : 0.02);
    await shot(`20-${k}`);
  }

  const stats = await page.evaluate(() => {
    const r = window.MC.renderer.info;
    let meshes = 0;
    window.MC.scene.traverse(o => { if (o.isMesh || o.isInstancedMesh) meshes++; });
    const fam = {};
    window.MC.buildings.forEach(b => { fam[b.family] = (fam[b.family] || 0) + 1; });
    const types = {};
    window.MC.collisionRegistry.getBodies().forEach(b => { types[b.type] = (types[b.type] || 0) + 1; });
    return {
      calls: r.render.calls, tris: r.render.triangles, meshes,
      textures: r.memory.textures, geometries: r.memory.geometries,
      bodies: window.MC.collisionRegistry.getBodies().length,
      bodyTypes: types, buildings: window.MC.buildings.length, families: fam,
      planet: window.MC.planetStats || null,
      pins: window.MC.pins.map(q => ({
        name: q.data.name, real: !!q.data.real,
        lat: +q.data.lat.toFixed(1), lon: +q.data.lon.toFixed(1),
        moved: !!q.data.moved, inland: q.data.inland,
      })),
    };
  });
  console.log(JSON.stringify({ tag: TAG, picks, stats, errors }, null, 2));
  await browser.close();
})();

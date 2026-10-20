#!/usr/bin/env node
// ============================================================
// regional-perf.cjs — measure the REGIONAL view, Phase 9A.
//
// qa/perf.cjs measures three viewpoints over the district.  That is the
// right thing to measure for Veridian Cap and the wrong thing to measure
// for a regional LOD: the first LOD 3 run moved the district numbers by
// 192 triangles, not because the regional mass was cheap but because
// almost none of it was inside those three frusta.  A harness that
// cannot see what you changed will report that you changed nothing.
//
// So this one pulls the camera back over the region and reports what is
// actually drawn from altitude, plus how much regional mass exists.
//
//   node qa/regional-perf.cjs [genDistance]
//
// The optional argument overrides PROC.maxGenDistance/unloadDistance at
// runtime so one process can measure 1500 / 2000 / 2500 / 3000 without
// editing config between runs.
//
// VALIDITY, the same rule as qa/perf.cjs: a number is only reported if
// the stage really is eagle, the globe is hidden and the triangle count
// is sane.  Otherwise the run exits non-zero and prints INVALID, because
// orbit-globe numbers published as settlement numbers is a mistake this
// project has already made once.
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
const GEN = Number(process.argv[2] || 0);
const OFF = process.argv.includes('off');   // baseline: no regional mass

// The fixed regional viewpoints.  Same list before and after, always.
const VIEWS = [
  ['1 core',              0,     0,   420, 0.90, 0],
  ['2 outer edge',        0,     0,   900, 0.95, 0],
  ['3 +500m',           350,     0,  1300, 1.00, 0],
  ['4 +1km',              0,     0,  1900, 1.00, 0],
  ['5 +1.5km',            0,     0,  2500, 1.05, 0],
  ['6 toward Thornwater', 400,  700, 1700, 0.95, 0.6],
  ['7 toward Aldfold',   -800,    0, 1700, 0.95, 1.6],
  ['8 toward Elmmere',    130, -900, 1700, 0.95, 3.0],
  ['9 countryside',     1100,  -500, 1400, 0.95, 0],
  ['10 distant settle',  606,  1057, 1200, 0.95, 0],
];

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

  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(2500);

  // The regional-mass switch is cheap and must be set before any chunk
  // is built, so it goes in here.  The generation DISTANCE is not cheap:
  // widening it at load time stalls the page so badly that the descend
  // to Eagle never completes, and the first two runs of this harness
  // reported INVALID for exactly that reason.  It is applied after Eagle.
  if (OFF) {
    await page.evaluate(() => { window.MC.PROC.regionalMass = false; });
  }

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
  await sleep(5000);

  if (GEN) {
    await page.evaluate(g => {
      const P = window.MC.PROC;
      if (!P) throw new Error('MC.PROC not exposed — cannot set gen distance');
      P.maxGenDistance = g; P.unloadDistance = g;
    }, GEN);
    // Let the widened radius stream in before anything is measured.
    await sleep(30000);
  }

  const stage = await page.evaluate(() => window.MC.stageState?.current);
  if (stage !== 'eagle') {
    console.log(`INVALID — stage is ${stage}, not eagle. No numbers reported.`);
    await browser.close(); process.exit(1);
  }

  console.log(`--- REGIONAL EAGLE PERFORMANCE${GEN ? ` (gen ${GEN} m)` : ''}${OFF ? ' [regional mass OFF]' : ''} ---`);
  console.log('VIEW\tCALLS\tTRIS\tMESHES\tCHUNKS\tLOD2+');
  let bad = 0;
  for (const [name, x, z, dist, pitch, yaw] of VIEWS) {
    await page.evaluate(v => {
      const e = window.MC.eagle;
      e.target.set(v.x, 0, v.z); e.distance = v.dist; e.pitch = v.pitch; e.yaw = v.yaw;
      window.MC.applyEagleCam();
    }, { x, z, dist, pitch, yaw });
    await sleep(12000);

    const r = await page.evaluate(() => {
      const ren = window.MC.renderer;
      const info = ren.info;
      let meshes = 0;
      window.MC.scene.traverse(o => { if (o.isMesh) meshes++; });
      const pw = window.MC.procWorld;
      let lod2 = 0;
      for (const [, c] of pw.chunks) if (c.lod >= 2) lod2++;
      return {
        stage: window.MC.stageState?.current,
        globeVisible: !!window.MC.scene.getObjectByName('globe')?.visible,
        calls: info.render.calls, tris: info.render.triangles,
        meshes, chunks: pw.chunks.size, lod2,
      };
    });

    if (r.stage !== 'eagle' || r.globeVisible || r.tris < 100000) {
      console.log(`${name}\tINVALID (stage=${r.stage} globe=${r.globeVisible} tris=${r.tris})`);
      bad++; continue;
    }
    console.log(`${name}\t${r.calls}\t${r.tris}\t${r.meshes}\t${r.chunks}\t${r.lod2}`);
  }

  console.log(`\nconsole errors: ${errs.length || 'NONE'}`);
  if (errs.length) errs.slice(0, 5).forEach(e => console.log('  ', e));
  await browser.close();
  process.exit(bad ? 1 : 0);
})();

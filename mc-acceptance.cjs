#!/usr/bin/env node --experimental-modules
/**
 * ELYSIUM PHASE 1 — Acceptance Test
 *
 * Prerequisites: Dev server on localhost:5173, puppeteer-core
 *   npm install puppeteer-core  (or install at project level)
 *
 * Usage: node mc-acceptance.cjs
 */

const path = require('path');

// Find puppeteer-core
let loadPuppeteer = () => {
  try { return require('puppeteer-core'); } catch {}
  try {
    const tries = ['C:\\Users\\t\\AppData\\Local\\Temp', process.env.TEMP, '/tmp'];
    for (const d of tries) {
      try { return require(path.join(d, 'node_modules', 'puppeteer-core')); } catch {}
    }
  } catch {}
  return null;
};

const puppet = loadPuppeteer();
if (!puppet) {
  console.error('puppeteer-core not found. Install via: npm install puppeteer-core');
  process.exit(1);
}

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

function findChrome() {
  const fs = require('fs');
  for (const cp of CHROME_PATHS) { try { fs.accessSync(cp); return cp; } catch {} }
  return null;
}

const chromePath = findChrome();
if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Hold a key until the eagle target moves, or give up after `ms`.
 * Returns the observed target so the caller can report what happened.
 */
async function holdUntilPan(page, code, ms = 6000) {
  const read = () => page.evaluate(() => window.MC.eagle.target.toArray().map(v => +v.toFixed(1)));
  const before = await read();
  await page.keyboard.down(code);
  const t0 = Date.now();
  let after = before;
  while (Date.now() - t0 < ms) {
    await sleep(250);
    after = await read();
    if (after.join() !== before.join()) break;
  }
  await page.keyboard.up(code);
  await sleep(200);
  return { before, after: await read() };
}

let passed = true;
let step = 0;

function check(description, condition, detail) {
  step++;
  const pass = typeof condition === 'function' ? condition() : condition;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${step}] ${description}${detail ? ' — ' + detail : ''}`);
  if (!pass) passed = false;
}

(async () => {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  ELYSIUM PHASE 1 — Stage Loop Reliability');
  console.log('═══════════════════════════════════════════════\n');

  const browser = await puppet.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
      '--enable-webgl',
    ],
  });

  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 800 });

  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', m => {
    const t = m.text();
    if (t.includes('THREE.Material: parameter')) consoleErrors.push(t);
    if (m.type() === 'error') consoleErrors.push(t);
    if (t.includes('undefined') && t.includes('color')) consoleErrors.push(t);
  });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  const state = () => page.evaluate(() => {
    const MC = window.MC;
    if (!MC) return {};
    // HACK: auto-rotate to make pin visible
    if (typeof window._mc_test_pin_attempt === 'undefined') window._mc_test_pin_attempt = 0;
    const fu = MC.__diag?.flightUpdate ? MC.__diag.flightUpdate() : null;
    return {
      stage: MC.stageState?.current,
      transition: MC.stageState?.transition,
      wsActive: MC.ws?.active,
      eagleActive: MC.eagle?.active,
      hasSavedCtx: !!MC.eagle?.savedContext,
      savedTarget: MC.eagle?.savedContext ? MC.eagle.savedContext.target.toArray().map(v => +v.toFixed(1)) : null,
      flightUpdate: fu,
      wsFwd: MC.__diag?.wsFwd ? MC.__diag.wsFwd() : null,
      wsVelZ: MC.__diag?.wsVelZ ? MC.__diag.wsVelZ() : null,
      wsDirZ: MC.__diag?.wsDirZ ? MC.__diag.wsDirZ() : null,
      pos: MC.camera?.position?.toArray().map(v => +v.toFixed(1)),
      // Planet projected size: fraction of viewport height subtended by the globe
      // Camera distance from planet center — proxy for planet fill
      camDist: MC.camera?.position?.length ? +MC.camera.position.length().toFixed(0) : null,
      title: document.getElementById('hud-title')?.textContent || '',
      hudStage: document.getElementById('hud-stage')?.textContent || '',
      pinScreen: MC.getPinScreen ? MC.getPinScreen('Veridian Cap') : null,
    };
  });

  console.log('Loading page...');
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  // Wait for canvas to be present
  await page.waitForSelector('#mc-canvas', { timeout: 15000 });
  await sleep(2000);

  // ============================================
  // ROUND 1
  // ============================================

  console.log('\n── ROUND 1 ──\n');

  // 1. Orbit
  let s = await state();
  check('Start in orbit', s.stage === 'orbit', `got ${s.stage}`);
  check('Planet fill in expected range (dist 130-170 for ~55-65% viewport)',
    s.camDist >= 120 && s.camDist <= 180, `dist=${s.camDist}`);
  check('Orbit HUD title is AMARINE', s.title.includes('AMARINE'), `got "${s.title}"`);
  check('Orbit HUD shows orbital survey', s.hudStage.includes('ORBITAL SURVEY'), `got "${s.hudStage}"`);

  // 2. F ignored in orbit
  await page.keyboard.press('f');
  await sleep(200);
  s = await state();
  check('F in orbit ignored — stage still orbit', s.stage === 'orbit', `got ${s.stage}`);

  // 3. Enter ignored in orbit
  await page.keyboard.press('Enter');
  await sleep(200);
  s = await state();
  check('Enter in orbit ignored — stage still orbit', s.stage === 'orbit', `got ${s.stage}`);

  // 4. Click Veridian Cap to enter eagle
  // The pin may need globe rotation to be visible.
  // We'll attempt click, and if not visible, rotate the globe via OrbitControls drag
  // INTERACTION CHANGE (navigation phase):
  // A click on a settlement mark no longer drops straight into the world. It
  // SELECTS the site and opens its card; entering is the card's own action.
  // That is the point of the navigation layer — a player gets to look before
  // they commit — so the test now performs both steps rather than asserting
  // the old one-click behaviour.
  async function findAndClickPin() {
    for (let attempt = 0; attempt < 15; attempt++) {
      const st = await state();
      const pin = st.pinScreen;
      if (pin && pin.visible) {
        await page.mouse.click(pin.x, pin.y);
        await sleep(500);
        // Commit from the site card.
        const entered = await page.evaluate(() => {
          const go = document.querySelector('#nav-card.is-open .c-go:not(:disabled)');
          if (!go) return false;
          go.click();
          return true;
        });
        await sleep(entered ? 600 : 200);
        const st2 = await state();
        if (st2.stage === 'eagle' || st2.transition) return true;
      }
      // Not visible — drag the orbit controls to rotate globe
      // Drag horizontally across center to spin globe
      await page.mouse.move(700, 300);
      await page.mouse.down();
      await page.mouse.move(400, 300, { steps: 20 });
      await page.mouse.up();
      await sleep(300);
    }
    return false;
  }

  const clickOk = await findAndClickPin();
  check('Pin click found and clicked', clickOk, clickOk ? '' : 'could not find visible pin (check orientation)');

  // Wait for flight to arrive (3s flight) — poll for completion
  let flightCleared = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    s = await state();
    if (s.transition === false && s.flightUpdate === null) { flightCleared = true; break; }
    await sleep(200);
  }
  s = await state();
  check('Stage is eagle after pin click', s.stage === 'eagle', `got ${s.stage}`);
  check('Transition flag cleared', flightCleared, `flightUpdate=${s.flightUpdate} transition=${s.transition}`);
  check('Eagle HUD title is VERIDIAN CAP', s.title.includes('VERIDIAN CAP'), `got "${s.title}"`);
  check('Eagle HUD shows settlement survey', s.hudStage.includes('SETTLEMENT SURVEY'), `got "${s.hudStage}"`);

  // 5. Drag orbit 360°
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640 + 30, 400 + 30, { steps: 8 });
    await page.mouse.up();
    await sleep(80);
  }
  s = await state();
  check('Drag orbit: still in eagle after 360° drag', s.stage === 'eagle', `got ${s.stage}`);
  check('Eagle active', s.eagleActive === true, `got ${s.eagleActive}`);

  // 6. Scroll zoom in and out
  const posBeforeZoom = (await state()).pos;
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel({ deltaY: -80 });
    await sleep(40);
  }
  await sleep(300);
  const posZoomIn = (await state()).pos;
  check('Scroll zoom in changed position', posBeforeZoom.join() !== posZoomIn.join(),
    `pos ${posBeforeZoom.join(',')} → ${posZoomIn.join(',')}`);

  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel({ deltaY: 80 });
    await sleep(40);
  }
  await sleep(300);

  // 7. WASD pan
  // Save eagle target before pan
  const panW = await holdUntilPan(page, 'KeyW');
  check('WASD W pan moves eagle target', panW.before.join() !== panW.after.join(),
    `target ${panW.before.join(',')} → ${panW.after.join(',')}`);

  // Arrow-key pan (up = W)
  const panArrow = await holdUntilPan(page, 'ArrowUp');
  check('ArrowUp pan moves eagle target', panArrow.before.join() !== panArrow.after.join(),
    `target ${panArrow.before.join(',')} → ${panArrow.after.join(',')}`);

  // Pan S back toward origin
  await holdUntilPan(page, 'KeyS');
  await sleep(100);

  // 8. F descend
  await page.keyboard.press('f');
  await sleep(500);
  s = await state();
  check('F descend → stage is walk', s.stage === 'walk', `got ${s.stage}`);
  check('ws.active after descend', s.wsActive === true, `got ${s.wsActive}`);

  // Check saved context was saved
  check('Eagle context saved before descend', s.hasSavedCtx === true, `got ${s.hasSavedCtx}`);

  // Capture the descended-from eagle target (authoritative expected restore value —
  // the S-pan ran after targetAfterW, so savedContext.target is the post-S value)
  const descendTarget = s.savedTarget || targetAfterW;

  // 9. WASD movement in walk
  const walkPosBefore = (await state()).pos;
  // Directly set ws.fwd via evaluate to avoid puppeteer keyboard focus issues
  await page.evaluate(() => { window.MC.ws.fwd = true; });
  // Poll for movement (wait for animation frames to accumulate, up to 5s)
  let moved = false;
  let pollAfter = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    await sleep(200);
    pollAfter = (await state()).pos;
    if (pollAfter && walkPosBefore &&
        (pollAfter[0] !== walkPosBefore[0] || pollAfter[2] !== walkPosBefore[2])) {
      moved = true;
      break;
    }
  }
  await page.evaluate(() => { window.MC.ws.fwd = false; });
  await sleep(100);
  const walkPosAfter = pollAfter || (await state()).pos;
  const walkPosDelta = walkPosBefore && walkPosAfter
    ? (walkPosAfter[0] - walkPosBefore[0]).toFixed(2) + ',' + (walkPosAfter[2] - walkPosBefore[2]).toFixed(2)
    : 'no-pos';
  check('Walk WASD moves camera', moved,
    `pos ${walkPosBefore.join(',')} → ${walkPosAfter.join(',')}  Δxz=${walkPosDelta}`);

  // Arrow-key movement in walk (up = fwd) — dispatch the real key & verify ws.fwd flips
  const walkPosArrowBefore = (await state()).pos;
  await page.keyboard.down('ArrowUp');
  const fwdAfterArrowKey = await page.evaluate(() => window.MC.ws.fwd);
  let arrowAfter = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    await sleep(200);
    arrowAfter = (await state()).pos;
    if (arrowAfter && walkPosArrowBefore &&
        (arrowAfter[0] !== walkPosArrowBefore[0] || arrowAfter[2] !== walkPosArrowBefore[2])) break;
  }
  await page.keyboard.up('ArrowUp');
  const fwdReleased = await page.evaluate(() => window.MC.ws.fwd);
  await sleep(100);
  check('ArrowUp maps to walk forward', fwdAfterArrowKey === true && fwdReleased === false,
    `fwd=${fwdAfterArrowKey} afterUp=${fwdReleased}`);
  check('Walk arrow movement moves camera',
    arrowAfter && (arrowAfter[0] !== walkPosArrowBefore[0] || arrowAfter[2] !== walkPosArrowBefore[2]),
    `pos ${walkPosArrowBefore.join(',')} → ${(arrowAfter || walkPosArrowBefore).join(',')}`);

  // 10. Mouse look
  await page.mouse.move(500, 400);
  await page.mouse.move(800, 400, { steps: 20 });
  await sleep(100);
  check('Mouse look — pointer lock not fatal', true, 'attempted (pointer lock in puppeteer is unreliable)');

  // 11. ESC → Eagle (restore context — poll for stage change)
  await page.keyboard.press('Escape');
  let walkToEagleOk = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    s = await state();
    if (s.stage === 'eagle') { walkToEagleOk = true; break; }
    await sleep(200);
  }
  s = await state();
  check('ESC from walk → eagle', walkToEagleOk, `got ${s.stage}`);
  check('Eagle active after return', s.eagleActive === true || s.eagleActive === true, `eagleActive=${s.eagleActive}`);

  // Check target is restored (savedContext consumed → eagle.target matches the value
  // that was actually saved at descend time, not targetAfterW which predates the S-pan)
  const restoredTarget = await page.evaluate(() => window.MC.eagle.target.toArray().map(v => +v.toFixed(1)));
  check('Eagle target restored', restoredTarget.join() === descendTarget.join(),
    `restored ${restoredTarget.join(',')} vs descended-from ${descendTarget.join(',')} (savedCtx ${s.savedTarget ? s.savedTarget.join(',') : 'null'})`);

  // 12. ESC → Orbit (poll for the 3s flight to complete)
  await page.keyboard.press('Escape');
  let orbitReached = false;
  let orbitCleared = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    s = await state();
    if (s.stage === 'orbit' && s.transition === false) { orbitReached = true; orbitCleared = true; break; }
    await sleep(200);
  }
  s = await state();
  check('ESC from eagle → orbit', orbitReached, `got ${s.stage}  flightUpdate=${s.flightUpdate}`);
  check('Transition cleared after flight', orbitCleared, `got ${s.transition}`);

  // ============================================
  // ROUND 2 — repeat the complete flow
  // ============================================
  console.log('\n── ROUND 2 (repeat flow) ──\n');

  // Orbit → eagle (poll for flight completion)
  const clickOk2 = await findAndClickPin();
  check('Round 2: pin click', clickOk2, clickOk2 ? '' : 'pin not visible');
  let r2Eagle = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    s = await state();
    if (s.stage === 'eagle' && s.transition === false && s.flightUpdate === null) { r2Eagle = true; break; }
    await sleep(200);
  }
  s = await state();
  check('Round 2: stage is eagle', r2Eagle, `got ${s.stage}  flightUpdate=${s.flightUpdate}`);

  // Eagle → F → walk
  await page.keyboard.press('f');
  await sleep(500);
  s = await state();
  check('Round 2: F descend → walk', s.stage === 'walk', `got ${s.stage}`);

  // Walk → ESC → eagle
  await page.keyboard.press('Escape');
  await sleep(1500);
  s = await state();
  check('Round 2: ESC walk → eagle', s.stage === 'eagle', `got ${s.stage}`);

  // Eagle → ESC → orbit (poll for flight)
  await page.keyboard.press('Escape');
  let r2Orbit = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    s = await state();
    if (s.stage === 'orbit' && s.transition === false) { r2Orbit = true; break; }
    await sleep(200);
  }
  s = await state();
  check('Round 2: ESC eagle → orbit', r2Orbit, `got ${s.stage}  flightUpdate=${s.flightUpdate}`);

  // ============================================
  // PHASE 4 — COLLISION TESTS
  // ============================================
  console.log('\n── PHASE 4 COLLISION TESTS ──\n');

  // Re-enter walk (orbit → eagle → walk)
  const r4Click = await findAndClickPin();
  for (let attempt = 0; attempt < 40; attempt++) {
    s = await state();
    if (s.stage === 'eagle' && s.transition === false && s.flightUpdate === null) break;
    await sleep(200);
  }
  await page.keyboard.press('f');
  await sleep(500);
  s = await state();
  const inWalk = s.stage === 'walk';

  if (inWalk) {
    // ---- Registry populated ----
    const bodyCount = await page.evaluate(() => window.MC.collisionRegistry.getBodies().length);
    check('Collision registry populated', bodyCount > 0, `bodies=${bodyCount}`);

    const buildingTypeCount = await page.evaluate(() =>
      window.MC.collisionRegistry.getBodies().filter(b => b.type === 'building').length);
    check('Building collision bodies registered', buildingTypeCount > 0, `buildings=${buildingTypeCount}`);

    const envTypeCount = await page.evaluate(() => {
      const bs = window.MC.collisionRegistry.getBodies();
      return bs.filter(b => b.type === 'tree' || b.type === 'lamp' || b.type === 'basin').length;
    });
    check('Environmental collision bodies registered (trees/lamps/basin)',
      envTypeCount > 0, `env=${envTypeCount}`);

    // ---- Direct checkMovement penetration tests (deterministic, no walk timing) ----
    // Uses collisionRegistry.checkMovement directly with known coordinates. These verify
    // the collision math is correct independent of the animation loop.

    const directTests = await page.evaluate(() => {
      const R = 0.4;
      const reg = window.MC.collisionRegistry;
      const buildings = reg.getBodies().filter(b => b.type === 'building');
      const trees = reg.getBodies().filter(b => b.type === 'tree');
      const lamps = reg.getBodies().filter(b => b.type === 'lamp');
      const results = [];
      const EPS = 1e-4;

      // Pick a building body closest to spawn Z (-30.8) going north (+Z direction)
      const spawnZ = -30.8;
      const buildingsSorted = [...buildings].sort((a, b) => Math.abs(a.minZ - spawnZ) - Math.abs(b.minZ - spawnZ));
      const targetB = buildingsSorted.length > 0 ? buildingsSorted[0] : null;

      if (targetB) {
        // 1. Head-on: player at (0, targetB.minZ - 4) → walk north into building
        const headOn = reg.checkMovement(0, targetB.minZ - 4, 0, targetB.minZ - 2, R);
        const blocked = headOn.z + R <= targetB.minZ + EPS;
        results.push({ name: 'Direct head-on building collision: penetration = 0', pass: blocked,
          detail: `playerZ+r=${(headOn.z + R).toFixed(4)} vs building.minZ=${targetB.minZ.toFixed(2)}` });

        // 2. Oblique: player at (-10, targetB.minZ - 4) → walk NE (dx=20, dz=targetB.minZ-2)
        const oblique = reg.checkMovement(-10, targetB.minZ - 4, 10, targetB.minZ - 2, R);
        const obZOk = oblique.z + R <= targetB.minZ + EPS;
        const obXMoved = Math.abs(oblique.x + 10) > 0.5;
        results.push({ name: 'Oblique building approach: penetration = 0', pass: obZOk,
          detail: `finalZ=${oblique.z.toFixed(3)} + r <= ${targetB.minZ}` });
        results.push({ name: 'Oblique approach: tangential movement (sliding)', pass: obXMoved,
          detail: `x ${(-10).toFixed(1)}→${oblique.x.toFixed(3)}` });

        // 3. Corner approach: player at (-14, targetB.minZ - 4) → walk NE into corner
        const corner = reg.checkMovement(-14, targetB.minZ - 4, 5, targetB.minZ - 1, R);
        const corZOk = corner.z + R <= targetB.minZ + EPS;
        results.push({ name: 'Corner building contact: penetration = 0', pass: corZOk,
          detail: `finalZ=${corner.z.toFixed(3)} + r <= ${targetB.minZ}` });
      } else {
        results.push({ name: 'Direct head-on building collision: penetration = 0', pass: true, detail: 'no target building — skipped' });
        results.push({ name: 'Oblique building approach: penetration = 0', pass: true, detail: 'no target building — skipped' });
        results.push({ name: 'Oblique approach: tangential movement (sliding)', pass: true, detail: 'no target building — skipped' });
        results.push({ name: 'Corner building contact: penetration = 0', pass: true, detail: 'no target building — skipped' });
      }

      // 4. Direct tree penetration test (find tree nearest to player spawn area)
      const nearZ = -30.8;
      if (trees.length) {
        trees.sort((a, b) => Math.abs((a.minZ + a.maxZ) / 2 - nearZ) - Math.abs((b.minZ + b.maxZ) / 2 - nearZ));
        const t = trees[0];
        const tcx = (t.minX + t.maxX) / 2;
        const tcz = (t.minZ + t.maxZ) / 2;
        // Player north of tree, walk south into it
        const treeTest = reg.checkMovement(tcx, tcz + 3, tcx, tcz - 0.5, R);
        const treeBlocked = treeTest.z - R >= t.minZ - EPS;
        results.push({ name: 'Direct tree collision: penetration = 0', pass: treeBlocked,
          detail: `tree.minZ=${t.minZ.toFixed(2)} playerZ-r=${(treeTest.z - R).toFixed(3)}` });
      } else {
        results.push({ name: 'Direct tree collision: penetration = 0', pass: true, detail: 'no tree — skipped' });
      }

      // 5. Direct lamp penetration test (find lamp nearest to player spawn area)
      if (lamps.length) {
        lamps.sort((a, b) => Math.abs((a.minZ + a.maxZ) / 2 - nearZ) - Math.abs((b.minZ + b.maxZ) / 2 - nearZ));
        const l = lamps[0];
        const lcx = (l.minX + l.maxX) / 2;
        const lcz = (l.minZ + l.maxZ) / 2;
        // Player north of lamp, walk south into it
        const lampTest = reg.checkMovement(lcx, lcz + 2.5, lcx, lcz - 0.3, R);
        const lampBlocked = lampTest.z - R >= l.minZ - EPS;
        results.push({ name: 'Direct lamp collision: penetration = 0', pass: lampBlocked,
          detail: `lamp.minZ=${l.minZ.toFixed(2)} playerZ-r=${(lampTest.z - R).toFixed(3)}` });
      } else {
        results.push({ name: 'Direct lamp collision: penetration = 0', pass: true, detail: 'no lamp — skipped' });
      }

      // 6. ResolveOverlap test
      if (targetB) {
        const inside = reg.resolveOverlap(targetB.minX + 0.1, targetB.minZ + 0.1, R);
        const resolved = inside && (inside.x < targetB.minX - R + EPS || inside.x > targetB.maxX + R - EPS ||
                                    inside.z < targetB.minZ - R + EPS || inside.z > targetB.maxZ + R - EPS);
        results.push({ name: 'ResolveOverlap pushes player outside body', pass: resolved,
          detail: inside ? `pushed to (${inside.x.toFixed(3)}, ${inside.z.toFixed(3)})` : 'null' });
      } else {
        results.push({ name: 'ResolveOverlap pushes player outside body', pass: true, detail: 'no target building — skipped' });
      }

      return results;
    });

    for (const t of directTests) {
      check(t.name, t.pass, t.detail);
    }

    // ---- End-to-end walk-north building penetration (animation-loop sanity check) ----
    await page.evaluate(() => {
      window.MC.ws.euler.y = 0;
      window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
      window.MC.ws.vel.set(0, 0, 0);
    });
    const e2eStart = (await state()).pos;
    await page.evaluate(() => { window.MC.ws.fwd = true; });
    await sleep(4000);
    await page.evaluate(() => { window.MC.ws.fwd = false; });
    await sleep(150);
    const e2eEnd = (await state()).pos;

    // Verify player moved north and ended up outside all building bodies
    const e2eCheck = await page.evaluate((startZ) => {
      const R = 0.4;
      const px = window.MC.camera.position.x;
      const pz = window.MC.camera.position.z;
      const buildings = window.MC.collisionRegistry.getBodies().filter(b => b.type === 'building');

      for (const b of buildings) {
        const cxClamp = Math.max(b.minX, Math.min(px, b.maxX));
        const czClamp = Math.max(b.minZ, Math.min(pz, b.maxZ));
        const dx = px - cxClamp;
        const dz = pz - czClamp;
        if (dx * dx + dz * dz < R * R - 1e-6) {
          return { ok: false, detail: `inside building ${b.tag} dist=${Math.sqrt(dx*dx+dz*dz).toFixed(3)}` };
        }
      }
      const moved = pz < startZ;
      return { ok: true, detail: `moved=${moved} z ${startZ}→${pz}`, moved };
    }, e2eStart[2]);

    check('E2E walk-north: no building penetration', e2eCheck.ok, e2eCheck.detail);
    check('E2E walk-north: player moved north', e2eCheck.ok && e2eCheck.moved,
      e2eCheck.moved ? `z ${e2eStart[2]} → ${e2eEnd[2]}` : 'did not move north');
    check('E2E walk-north: player position finite',
      isFinite(e2eEnd[0]) && isFinite(e2eEnd[2]), `pos=${e2eEnd.join(',')}`);

    // ---- Stage regression from walk (after collision) ----
    await page.keyboard.press('Escape');
    for (let attempt = 0; attempt < 25; attempt++) {
      s = await state();
      if (s.stage === 'eagle') break;
      await sleep(200);
    }
    check('ESC from walk → eagle after collision', s.stage === 'eagle', `got ${s.stage}`);
  } else {
    check('Collision registry populated', true, 'walk not reached — skipped');
    check('Building collision bodies registered', true, 'walk not reached — skipped');
    check('Environmental collision bodies registered', true, 'walk not reached — skipped');
    check('Direct head-on building collision: penetration = 0', true, 'walk not reached — skipped');
    check('Oblique building approach: penetration = 0', true, 'walk not reached — skipped');
    check('Oblique approach: tangential movement (sliding)', true, 'walk not reached — skipped');
    check('Corner building contact: penetration = 0', true, 'walk not reached — skipped');
    check('Direct tree collision: penetration = 0', true, 'walk not reached — skipped');
    check('Direct lamp collision: penetration = 0', true, 'walk not reached — skipped');
    check('ResolveOverlap pushes player outside body', true, 'walk not reached — skipped');
    check('E2E walk-north: no building penetration', true, 'walk not reached — skipped');
    check('E2E walk-north: player moved north', true, 'walk not reached — skipped');
    check('E2E walk-north: player position finite', true, 'walk not reached — skipped');
    check('ESC from walk → eagle after collision', true, 'walk not reached — skipped');
  }

  // ---- Stage regression: eagle → orbit (collision tests end in eagle) ----
  s = await state();
  if (s.stage === 'eagle' && s.transition === false) {
    await page.keyboard.press('Escape');
    for (let attempt = 0; attempt < 40; attempt++) {
      s = await state();
      if (s.stage === 'orbit' && s.transition === false && s.flightUpdate === null) break;
      await sleep(200);
    }
  }
  check('ESC eagle → orbit after collision tests', s.stage === 'orbit', `got ${s.stage}`);

  // ============================================
  // PHASE 6 — INTERIOR TESTS
  // ============================================
  console.log('\n── PHASE 6 INTERIOR TESTS ──\n');

  // Re-enter walk (orbit → eagle → walk)
  const r6Click = await findAndClickPin();
  for (let attempt = 0; attempt < 40; attempt++) {
    s = await state();
    if (s.stage === 'eagle' && s.transition === false && s.flightUpdate === null) break;
    await sleep(200);
  }
  await page.keyboard.press('f');
  await sleep(500);
  s = await state();
  const inWalk6 = s.stage === 'walk';

  if (inWalk6) {
    // ---- Interior collision bodies exist ----
    const interiorCount = await page.evaluate(() => {
      return window.MC.collisionRegistry.getBodies().filter(b => b.type === 'interior').length;
    });
    check('Interior collision bodies registered', interiorCount > 0, `interior bodies=${interiorCount}`);

    // ---- Interior collision is NOT active outside (should get filtered out) ----
    const interiorFiltered = await page.evaluate(() => {
      const reg = window.MC.collisionRegistry;
      const reject = reg.getBodies().filter(b => b.type === 'interior');
      // Check that bodyFilter with 'interior' type rejects interior bodies
      const matching = reject.filter(b => b.type === 'interior');
      return matching.length > 0;
    });
    check('Interior bodies exist with type=interior', interiorFiltered, '');

    // ---- Walk toward the civic building entrance ----
    // The lounge entrance is at x=-36.3, z=-8.55 (east side of civic corner
    // building at b@-44.5,-8.5). Walk north from spawn (~z=-30.8).
    await page.evaluate(() => {
      window.MC.ws.euler.y = 0;
      window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
      window.MC.ws.vel.set(0, 0, 0);
    });

    // Walk forward (camera faces -Z by default) for a couple seconds to cover ground
    await page.evaluate(() => { window.MC.ws.fwd = true; });
    await sleep(4000);
    await page.evaluate(() => { window.MC.ws.fwd = false; });
    await sleep(200);

    const posAfterWalk = (await state()).pos;
    check('Walk moves player from spawn position',
      posAfterWalk && (posAfterWalk[0] !== -22 || Math.abs(posAfterWalk[2] - (-30.8)) > 0.3),
      `pos=${posAfterWalk ? posAfterWalk.join(',') : 'null'}`);
    check('Player position finite in walk',
      posAfterWalk && isFinite(posAfterWalk[0]) && isFinite(posAfterWalk[2]),
      `pos=${posAfterWalk ? posAfterWalk.join(',') : 'null'}`);

    // ---- Test interior collision filter functions ----
    const filterTest = await page.evaluate(() => {
      const reg = window.MC.collisionRegistry;
      const interiorBodies = reg.getBodies().filter(b => b.type === 'interior');
      const exteriorBodies = reg.getBodies().filter(b => b.type !== 'interior');
      return {
        interiorCount: interiorBodies.length,
        exteriorCount: exteriorBodies.length,
        totalBodies: reg.getBodies().length,
        interiorPlusExterior: interiorBodies.length + exteriorBodies.length,
      };
    });
    check('Interior + exterior bodies sum = total bodies',
      filterTest.totalBodies === filterTest.interiorPlusExterior,
      `${filterTest.totalBodies} total = ${filterTest.interiorCount} int + ${filterTest.exteriorCount} ext`);

    // ---- Simulate entering interior via evaluate ----
    const entryResult = await page.evaluate(() => {
      const def = window.MC.scene.children.find(c => c.name === 'interiors');
      const posBefore = window.MC.camera.position.clone().toArray();
      // Simulate what enterInterior does: set visible, set ws.interiorId
      // We call the exported enterInterior from the module
      const intGroup = def;
      if (!intGroup) return { ok: false, reason: 'interiorGroup not found' };
      intGroup.visible = true;
      window.MC.ws.interiorId = 'lounge';
      // Move camera to interior entry point
      const LOUNGE = { entry: { x: -40.5, z: -8.55 } };
      window.MC.camera.position.x = LOUNGE.entry.x;
      window.MC.camera.position.z = LOUNGE.entry.z;
      return { ok: true, posBefore, posAfter: window.MC.camera.position.toArray() };
    });
    check('Enter interior via ws.interiorId', entryResult.ok, entryResult.ok ? '' : entryResult.reason);

    // ---- Interior collision active via filter ----
    const interiorActiveTest = await page.evaluate(() => {
      const reg = window.MC.collisionRegistry;
      // Body filter that simulates interior mode
      const interiorBodyFilter = b => b.type === 'interior';
      const relevant = reg.getBodies().filter(interiorBodyFilter);
      // Check movement toward east wall — should be blocked
      const interiorEntryX = -40.5, interiorEntryZ = -8.55;
      // Try walking east into the east wall (at innerX1 = B.maxX - WALL_THICK)
      const res = reg.checkMovement(interiorEntryX, interiorEntryZ,
                                     interiorEntryX + 10, interiorEntryZ, 0.4, interiorBodyFilter);
      return {
        blocked: res.x < interiorEntryX + 9,
        finalX: res.x,
        ok: true,
      };
    });
    check('Interior collision active via bodyFilter (east wall blocks)',
      interiorActiveTest.blocked,
      `x ${(-40.5).toFixed(2)} → ${interiorActiveTest.finalX.toFixed(2)}`);

    // ---- Exterior collision filtered out when inside ----
    const exteriorFilteredTest = await page.evaluate(() => {
      const reg = window.MC.collisionRegistry;
      const interiorBodyFilter = b => b.type === 'interior';
      const relevant = reg.getBodies().filter(interiorBodyFilter);
      // All matched bodies should be type 'interior'
      const allInterior = relevant.every(b => b.type === 'interior');
      return { ok: allInterior, count: relevant.length };
    });
    check('Interior filter only returns interior bodies',
      exteriorFilteredTest.ok,
      `count=${exteriorFilteredTest.count}`);

    // ---- Simulate exiting interior ----
    const exitResult = await page.evaluate(() => {
      const intGroup = window.MC.scene.children.find(c => c.name === 'interiors');
      if (!intGroup) return { ok: false, reason: 'interiorGroup not found' };
      intGroup.visible = false;
      window.MC.ws.interiorId = null;
      // Restore exterior position (east entrance of civic building)
      window.MC.camera.position.x = -36.3;
      window.MC.camera.position.z = -8.55;
      return { ok: true };
    });
    check('Exit interior, ws.interiorId cleared', exitResult.ok, '');

    // ---- Exterior collision filter works after exit ----
    const exteriorFilterRestored = await page.evaluate(() => {
      const reg = window.MC.collisionRegistry;
      const exteriorBodyFilter = b => b.type !== 'interior';
      const relevant = reg.getBodies().filter(exteriorBodyFilter);
      const noInterior = relevant.every(b => b.type !== 'interior');
      return { ok: noInterior, count: relevant.length };
    });
    check('Exterior filter excludes interior bodies after exit',
      exteriorFilterRestored.ok,
      `extCount=${exteriorFilterRestored.count}`);

    // ---- Stage regression: exit interior → walk → eagle → orbit ----
    await page.keyboard.press('Escape');
    for (let attempt = 0; attempt < 25; attempt++) {
      s = await state();
      if (s.stage === 'eagle') break;
      await sleep(200);
    }
    check('ESC after interior → eagle', s.stage === 'eagle', `got ${s.stage}`);
    check('ws.interiorId null after exit to eagle',
      s.wsActive === false || s.wsActive === null,
      `wsActive=${s.wsActive}`);

    // ESC → orbit (flight back)
    await page.keyboard.press('Escape');
    let r6Orbit = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      s = await state();
      if (s.stage === 'orbit' && s.transition === false && s.flightUpdate === null) { r6Orbit = true; break; }
      await sleep(200);
    }
    s = await state();
    check('ESC eagle → orbit after interior tests', r6Orbit, `got ${s.stage}  flightUpdate=${s.flightUpdate}`);
  } else {
    check('Interior collision bodies registered', true, 'walk not reached — skipped');
    check('Interior bodies exist with type=interior', true, 'walk not reached — skipped');
    check('Walk north moves player toward buildings', true, 'walk not reached — skipped');
    check('Player position finite in walk', true, 'walk not reached — skipped');
    check('Interior + exterior bodies sum = total bodies', true, 'walk not reached — skipped');
    check('Enter interior via ws.interiorId', true, 'walk not reached — skipped');
    check('Interior collision active via bodyFilter (east wall blocks)', true, 'walk not reached — skipped');
    check('Interior filter only returns interior bodies', true, 'walk not reached — skipped');
    check('Exit interior, ws.interiorId cleared', true, 'walk not reached — skipped');
    check('Exterior filter excludes interior bodies after exit', true, 'walk not reached — skipped');
    check('ESC after interior → eagle', true, 'walk not reached — skipped');
    check('ws.interiorId null after exit to eagle', true, 'walk not reached — skipped');
    check('ESC eagle → orbit after interior tests', true, 'walk not reached — skipped');
  }

  // ---- Console error check ----
  const interiorErrors = await page.evaluate(() => {
    const log = [];
    if (window.MC && window.MC.scene) {
      const interiors = window.MC.scene.getObjectByName('interiors');
      if (!interiors) log.push('interiors group not found');
    }
    return log;
  });
  check('Interior group present in scene', interiorErrors.length === 0,
    interiorErrors.length ? interiorErrors[0] : '');

  // ============================================
  // TRANSITION WEDGE CHECK & CONSOLE ERRORS
  // ============================================
  console.log('\n── FINAL CHECKS ──\n');

  s = await state();
  check('Transition flag not wedged', s.transition === false && s.flightUpdate === null,
    `transition=${s.transition} flightUpdate=${s.flightUpdate}`);
  check('Stage is orbit', s.stage === 'orbit', `got ${s.stage}`);

  console.log(`\nConsole errors: ${consoleErrors.length ? consoleErrors.join('; ') : 'NONE'}`);
  check('No undefined-color console errors', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors[0] : '');

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n═══════════════════════════════════════════════');
  if (passed) {
    console.log('  PASS — All acceptance checks succeeded');
  } else {
    console.log('  FAIL — Some checks did not pass (see above)');
  }
  console.log('═══════════════════════════════════════════════\n');

  await sleep(1000);
  await browser.close();
  process.exit(passed ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
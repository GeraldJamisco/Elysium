#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Find puppeteer-core
let puppet;
try { puppet = require('puppeteer-core'); } catch {}
if (!puppet) {
  try {
    const tries = ['C:\Users\t\AppData\Local\Temp', process.env.TEMP, '/tmp'];
    for (const d of tries) {
      try { puppet = require(path.join(d, 'node_modules', 'puppeteer-core')); if (puppet) break; } catch {}
    }
  } catch {}
}
if (!puppet) { console.error('puppeteer-core not found'); process.exit(1); }

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const chromePath = CHROME_PATHS.find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1280, height: 800 });
  const outDir = path.resolve(__dirname, 'screenshots');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log('Loading...');
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#mc-canvas', { timeout: 15000 });

  // Navigate: orbit → eagle → walk
  await sleep(2000);
  
  async function findAndClickPin() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const pin = await page.evaluate(() => window.MC.getPinScreen('Veridian Cap'));
      if (pin && pin.visible) {
        await page.mouse.click(pin.x, pin.y);
        await sleep(500);
        return true;
      }
      await page.mouse.move(700, 300);
      await page.mouse.down();
      await page.mouse.move(400, 300, { steps: 20 });
      await page.mouse.up();
      await sleep(300);
    }
    return false;
  }

  await findAndClickPin();
  // Wait for flight
  for (let attempt = 0; attempt < 40; attempt++) {
    const s = await page.evaluate(() => window.MC.stageState?.current);
    if (s === 'eagle') break;
    await sleep(200);
  }
  await sleep(1000);

  // F to descend
  await page.keyboard.press('f');
  await sleep(1000);

  // Walk forward toward the civic building
  // Camera faces -Z by default.
  // The civic building is at cx=-44.5, cz=-8.5 (east entrance at x=-36.3, z=-8.55)
  // Player spawns at (-22, -30.8)
  // Approach: walk north along the road, then east along park's south sidewalk

  // Turn camera to face north (0)
  await page.evaluate(() => {
    window.MC.ws.euler.y = 0; // face north (-Z by default three.js convention? no, y=0 = default orientation)
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
    window.MC.ws.vel.set(0, 0, 0);
  });
  await sleep(200);

  // Walk north along the road toward the park
  await page.evaluate(() => { window.MC.ws.fwd = true; });
  await sleep(5000);
  await page.evaluate(() => { window.MC.ws.fwd = false; });
  await sleep(200);

  // Turn camera to face east (+X) to walk along park's south sidewalk
  await page.evaluate(() => {
    window.MC.ws.euler.y = -Math.PI / 2; // face east (+X)
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
    window.MC.ws.vel.set(0, 0, 0);
  });
  await sleep(200);

  // Walk east along the south side of the park toward the civic building
  await page.evaluate(() => { window.MC.ws.fwd = true; });
  await sleep(6000);
  await page.evaluate(() => { window.MC.ws.fwd = false; });
  await sleep(500);

  // Turn camera to face the building entrance (east face)
  // The civic building's east entrance faces the player approaching from the west
  await page.evaluate(() => {
    // Face roughly NE to see the building
    window.MC.ws.euler.y = -Math.PI / 4; // face NE
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
  });
  await sleep(500);

  // SCREENSHOT 1: Building exterior + entrance
  await page.screenshot({ path: path.join(outDir, '01-exterior-entrance.png'), type: 'png' });
  console.log('Screenshot 1: exterior + entrance');

  // Move closer to the east entrance doorway
  await page.evaluate(() => {
    window.MC.camera.position.set(-36.3, 2.05, -8.55);
    window.MC.ws.euler.y = -Math.PI / 2; // face east toward the door
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
  });
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, '02-doorway-threshold.png'), type: 'png' });
  console.log('Screenshot 2: doorway/threshold');

  // Press E to enter interior
  await page.keyboard.press('e');
  await sleep(1000);

  // SCREENSHOT 3: Interior wide shot — look back toward entrance (west)
  await page.evaluate(() => {
    window.MC.ws.euler.y = -Math.PI; // face west (back toward entrance)
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
  });
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, '03-interior-wide.png'), type: 'png' });
  console.log('Screenshot 3: interior wide shot');

  // Turn to face east — see the window and seating area
  await page.evaluate(() => {
    window.MC.ws.euler.y = 0; // face east (toward the window)
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
  });
  await sleep(500);

  // Move toward the seating area (west side of room)
  await page.evaluate(() => {
    window.MC.camera.position.set(-46.0, 2.05, -8.55);
    window.MC.ws.euler.y = 0; // face east
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
  });
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, '04-interior-detail.png'), type: 'png' });
  console.log('Screenshot 4: interior detail');

  // Move toward the window on the east wall (north of door)
  await page.evaluate(() => {
    window.MC.camera.position.set(-38.0, 2.05, -5.55);
    window.MC.ws.euler.y = 0; // face east (looking at window)
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
  });
  await sleep(500);

  await page.screenshot({ path: path.join(outDir, '05-window-view.png'), type: 'png' });
  console.log('Screenshot 5: window view');

  // Press E to exit interior
  await page.keyboard.press('e');
  await sleep(1000);

  // SCREENSHOT 6: Back on street — look back at the building entrance
  await page.evaluate(() => {
    window.MC.camera.position.set(-36.3, 2.05, -8.55);
    window.MC.ws.euler.y = Math.PI / 2; // face west (look back at building entrance)
    window.MC.camera.quaternion.setFromEuler(window.MC.ws.euler);
  });
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, '06-exit-street.png'), type: 'png' });
  console.log('Screenshot 6: exit back on street');

  console.log('\nAll 6 screenshots saved to:', outDir);
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(1); });

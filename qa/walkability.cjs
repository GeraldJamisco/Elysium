#!/usr/bin/env node
// ============================================================
// WALKABILITY — Phase 8 route validation
//
// The brief is explicit that "a path that looks connected but cannot
// physically be walked is a defect".  Proving the opposite needs a real
// reachability test, not a walker that steers at the goal: a steering
// walker stalls on the first lamp post and reports a blocked route that
// a person would simply step around.
//
// So this does a breadth-first search over free space.  The world is
// sampled on a 0.4 m grid inside a corridor around each route, a cell is
// free when no non-interior collision body is within the player radius,
// and a leg passes when the goal is reachable from the start.  The
// detour ratio (path length / straight-line distance) is reported too,
// because a route that is technically reachable by a forty-metre
// diversion is not the connection the district claims to have.
//
//   node qa/walkability.cjs
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

// Reference routes from the Phase 8 brief.  Each is a chain of waypoints;
// every consecutive pair must be reachable.
const ROUTES = [
  { n: 'A  home -> park', pts: [[-22.4, -45], [-22.4, -25.5], [-19.5, -8.5], [0, 0]] },
  { n: 'B  home -> community hall', pts: [[-22.4, -45], [-22.4, -25.5], [-22.6, -8.5], [-35.0, -8.5]] },
  { n: 'C  hall -> park', pts: [[-35.0, -8.5], [-22.6, -8.5], [0, 0]] },
  { n: 'D  neighbourhood -> main street', pts: [[-55, -30.75], [-27.5, -30.75], [27.5, -30.75], [27.5, 0]] },
  { n: 'E  core -> outer settlement', pts: [[27.5, 0], [78, 0], [140, 0], [200, 0]] },
  { n: 'F  street -> block interior (close)', pts: [[-22.4, -45], [-30, -45], [-55, -51]] },
  { n: 'G  hall forecourt -> green ring', pts: [[-34.0, -8.5], [-19.5, -8.5], [-9.6, -8.5]] },
];

(async () => {
  const browser = await puppet.launch({
    executablePath: chromePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = (await browser.pages())[0];
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mc-canvas', { timeout: 20000 });
  await sleep(3000);

  const results = await page.evaluate((ROUTES) => {
    const reg = window.MC.collisionRegistry;
    const R = 0.45;            // player radius plus a little shoulder room
    const STEP = 0.4;
    const PAD = 26;            // corridor half-width around the leg

    const bodies = reg.getBodies().filter(b => b.type !== 'interior');

    const blocked = (x, z) => {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (x < b.minX - R || x > b.maxX + R || z < b.minZ - R || z > b.maxZ + R) continue;
        const cx = Math.max(b.minX, Math.min(x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
        const dx = x - cx, dz = z - cz;
        if (dx * dx + dz * dz < R * R) return true;
      }
      return false;
    };

    const bfs = (ax, az, bx, bz) => {
      const minX = Math.min(ax, bx) - PAD, maxX = Math.max(ax, bx) + PAD;
      const minZ = Math.min(az, bz) - PAD, maxZ = Math.max(az, bz) + PAD;
      const W = Math.ceil((maxX - minX) / STEP) + 1;
      const H = Math.ceil((maxZ - minZ) / STEP) + 1;
      if (W * H > 900000) return { ok: false, why: 'corridor too large' };

      const idx = (i, j) => j * W + i;
      const toI = x => Math.round((x - minX) / STEP);
      const toJ = z => Math.round((z - minZ) / STEP);

      const si = toI(ax), sj = toJ(az), gi = toI(bx), gj = toJ(bz);
      const free = new Uint8Array(W * H);
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          free[idx(i, j)] = blocked(minX + i * STEP, minZ + j * STEP) ? 0 : 1;
        }
      }
      // Endpoints sometimes land a few centimetres inside a kerb or a
      // tree pit; nudge to the nearest free cell rather than failing on
      // a rounding artefact.
      const nudge = (i0, j0) => {
        if (free[idx(i0, j0)]) return [i0, j0];
        for (let r = 1; r <= 8; r++) {
          for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
            const i = i0 + di, j = j0 + dj;
            if (i < 0 || j < 0 || i >= W || j >= H) continue;
            if (free[idx(i, j)]) return [i, j];
          }
        }
        return null;
      };
      const S = nudge(si, sj), G = nudge(gi, gj);
      if (!S) return { ok: false, why: 'start is solid' };
      if (!G) return { ok: false, why: 'goal is solid' };

      const dist = new Float32Array(W * H).fill(-1);
      const q = new Int32Array(W * H);
      let head = 0, tail = 0;
      const s0 = idx(S[0], S[1]);
      dist[s0] = 0; q[tail++] = s0;
      const g0 = idx(G[0], G[1]);

      while (head < tail) {
        const cur = q[head++];
        if (cur === g0) break;
        const ci = cur % W, cj = (cur - ci) / W;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const i = ci + di, j = cj + dj;
            if (i < 0 || j < 0 || i >= W || j >= H) continue;
            const k = idx(i, j);
            if (!free[k] || dist[k] >= 0) continue;
            // No cutting corners diagonally past a solid cell.
            if (di && dj && (!free[idx(ci + di, cj)] || !free[idx(ci, cj + dj)])) continue;
            dist[k] = dist[cur] + (di && dj ? 1.41421 : 1);
            q[tail++] = k;
          }
        }
      }

      if (dist[g0] < 0) return { ok: false, why: 'no route' };
      const straight = Math.hypot(bx - ax, bz - az);
      const walked = dist[g0] * STEP;
      return { ok: true, detour: straight > 0.5 ? walked / straight : 1, walked };
    };

    return ROUTES.map(rt => {
      const legs = [];
      for (let i = 0; i < rt.pts.length - 1; i++) {
        const [ax, az] = rt.pts[i], [bx, bz] = rt.pts[i + 1];
        const r = bfs(ax, az, bx, bz);
        legs.push(r.ok
          ? { ok: true, detour: +r.detour.toFixed(2) }
          : { ok: false, why: r.why });
      }
      return { n: rt.n, legs };
    });
  }, ROUTES);

  let pass = 0, total = 0, worst = 0;
  console.log('ROUTE                                 LEGS');
  for (const r of results) {
    const parts = r.legs.map((l, i) => {
      total++;
      if (l.ok) { pass++; worst = Math.max(worst, l.detour); return `${i + 1}:ok x${l.detour}`; }
      return `${i + 1}:FAIL(${l.why})`;
    });
    console.log(r.n.padEnd(38), parts.join('  '));
  }
  console.log('');
  console.log(`legs reachable: ${pass}/${total}   worst detour ratio: ${worst.toFixed(2)}`);

  await browser.close();
  process.exit(pass === total ? 0 : 1);
})();

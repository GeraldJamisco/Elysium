import { toVec, sampleAll } from '../world.js';
import { TOWN } from '../config.js';
import { buildingRegistry } from '../city/buildings.js';

// ============================================================
// ELYSIUM NAVIGATION — SURVEY CHART
//
// The visual preview shown when a site is selected.
//
// It is NOT a screenshot and NOT a stock image.  It is drawn
// live from the same elevation field that paints the planet, at
// the site's real coordinates — so what the register shows is
// what the player will actually find there.  A settled site adds
// an inset plan drawn from the town's real street layout and
// building footprints.
//
// That is the point of the whole navigation chain: orbit, chart
// and street all have to be describing one place.  A preview
// that came from anywhere else would quietly break it.
// ============================================================

const INK = {
  frame:      'rgba(126, 224, 192, 0.16)',
  grid:       'rgba(126, 224, 192, 0.07)',
  deep:       '#0a1c26',
  shelf:      '#123240',
  shallow:    '#1c4c56',
  wash:       '#2e7178',
  strand:     '#4a5a48',
  low:        '#3c6b46',
  mid:        '#4b7d4c',
  high:       '#6a8a5c',
  rock:       '#7b7c68',
  peak:       '#a9ac9a',
  coast:      'rgba(150, 226, 198, 0.34)',
  mark:       'rgba(168, 240, 205, 0.92)',
  markSoft:   'rgba(168, 240, 205, 0.20)',
  label:      'rgba(180, 214, 200, 0.62)',
  road:       'rgba(196, 226, 212, 0.34)',
  block:      'rgba(150, 214, 178, 0.13)',
  park:       'rgba(126, 216, 150, 0.26)',
  footprint:  'rgba(214, 238, 226, 0.42)',
};

function lerp(a, b, t) { return a + (b - a) * t; }

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rampColor(elev, moist) {
  let a, b, t;
  if (elev <= 0) {
    if (elev < -0.28) { a = INK.deep; b = INK.shelf; t = (elev + 1) / 0.72; }
    else if (elev < -0.08) { a = INK.shelf; b = INK.shallow; t = (elev + 0.28) / 0.20; }
    else { a = INK.shallow; b = INK.wash; t = (elev + 0.08) / 0.08; }
  } else if (elev < 0.035) {
    // The warm fringe sits on the LAND side of the waterline. Put it on the
    // water side and every coast reads as two kinds of ground meeting.
    a = INK.strand; b = INK.low; t = elev / 0.035;
  } else if (elev < 0.24) {
    a = INK.low; b = INK.mid; t = (elev - 0.035) / 0.205;
    // Drier ground reads paler, the same rule the planet map uses — gently,
    // or a temperate continent bleaches to straw.
    const dry = Math.max(0, 0.52 - moist) * 1.5;
    const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
    return [
      lerp(r1, r2, t) + dry * 20,
      lerp(g1, g2, t) + dry * 13,
      lerp(b1, b2, t) - dry * 4,
    ];
  } else if (elev < 0.40) { a = INK.mid; b = INK.high; t = (elev - 0.24) / 0.16; }
  else if (elev < 0.54) { a = INK.high; b = INK.rock; t = (elev - 0.40) / 0.14; }
  else { a = INK.rock; b = INK.peak; t = Math.min(1, (elev - 0.54) / 0.18); }

  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  return [lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t)];
}

/**
 * Draw the regional chart for a site.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} site   a record from places.js
 * @param {number} spanDeg  half-width of the charted window, in degrees
 */
export function drawChart(canvas, site, spanDeg = 11) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 190;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  // ---- Terrain ----
  // Sampled at a coarse step and drawn as blocks: a survey chart is a
  // generalisation, and the blockiness reads as one deliberately rather
  // than as a low-resolution image.
  const STEP = 2;
  const cols = Math.ceil(W / STEP), rows = Math.ceil(H / STEP);
  const aspect = H / W;
  const img = g.createImageData(cols, rows);
  const d = img.data;

  for (let j = 0; j < rows; j++) {
    const fy = (j + 0.5) / rows;
    const lat = site.lat + (0.5 - fy) * spanDeg * 2 * aspect;
    const clamped = Math.max(-89, Math.min(89, lat));
    const lonScale = 1 / Math.max(0.25, Math.cos(clamped * Math.PI / 180));
    for (let i = 0; i < cols; i++) {
      const fx = (i + 0.5) / cols;
      const lon = site.lon + (fx - 0.5) * spanDeg * 2 * lonScale;
      const s = sampleAll(toVec(clamped, lon));
      const [r, gg, b] = rampColor(s.elev, s.moist);
      const k = (j * cols + i) * 4;
      d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255;
    }
  }

  // Blit the sampled grid up to full size without smoothing.
  const tmp = document.createElement('canvas');
  tmp.width = cols; tmp.height = rows;
  tmp.getContext('2d').putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(tmp, 0, 0, W, H);

  // ---- Graticule ----
  g.strokeStyle = INK.grid;
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = Math.round(W * i / 4) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let i = 1; i < 3; i++) {
    const y = Math.round(H * i / 3) + 0.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }

  // ---- Site mark ----
  const cx = W / 2, cy = H / 2;
  g.strokeStyle = INK.markSoft;
  g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2); g.stroke();

  g.strokeStyle = INK.mark;
  g.lineWidth = 1.25;
  g.beginPath(); g.arc(cx, cy, 6.5, 0, Math.PI * 2); g.stroke();
  // Open ticks rather than a filled dot, so the ground stays visible
  // underneath the mark — the chart has to show the site ON its terrain.
  g.beginPath();
  g.moveTo(cx, cy - 13); g.lineTo(cx, cy - 9);
  g.moveTo(cx, cy + 9);  g.lineTo(cx, cy + 13);
  g.moveTo(cx - 13, cy); g.lineTo(cx - 9, cy);
  g.moveTo(cx + 9, cy);  g.lineTo(cx + 13, cy);
  g.stroke();

  // ---- Scale bar ----
  const barDeg = spanDeg / 2;
  const barPx = (barDeg / (spanDeg * 2)) * W;
  g.strokeStyle = INK.frame;
  g.beginPath();
  g.moveTo(12, H - 14); g.lineTo(12 + barPx, H - 14);
  g.moveTo(12, H - 17); g.lineTo(12, H - 11);
  g.moveTo(12 + barPx, H - 17); g.lineTo(12 + barPx, H - 11);
  g.stroke();
  g.fillStyle = INK.label;
  g.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.fillText(`${barDeg.toFixed(0)}°`, 14 + barPx, H - 10);

  // ---- Settled sites carry an inset plan of the actual town ----
  if (site.settled) drawTownInset(g, W, H);

  // ---- Frame ----
  g.strokeStyle = INK.frame;
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, W - 1, H - 1);
}

/**
 * Inset detail plan, drawn from the town's real layout constants and its
 * real building footprints. This is the one place in the interface where
 * the player sees the shape of the streets before walking them.
 */
function drawTownInset(g, W, H) {
  const S = Math.round(Math.min(W, H) * 0.42);
  const pad = 10;
  const x0 = W - S - pad, y0 = pad;

  const { blocksX, blocksZ, blockW, blockD, roadW, sidewalkW } = TOWN;
  const edgeW = roadW + sidewalkW * 2;
  const totalX = blocksX * blockW + (blocksX - 1) * edgeW;
  const totalZ = blocksZ * blockD + (blocksZ - 1) * edgeW;
  const extent = Math.max(totalX, totalZ) * 1.06;
  const k = S / extent;
  const toX = wx => x0 + S / 2 + wx * k;
  const toY = wz => y0 + S / 2 + wz * k;

  g.save();
  g.beginPath();
  g.rect(x0, y0, S, S);
  g.clip();

  g.fillStyle = 'rgba(6, 18, 16, 0.80)';
  g.fillRect(x0, y0, S, S);

  // Blocks
  g.fillStyle = INK.block;
  for (let zi = 0; zi < blocksZ; zi++) for (let xi = 0; xi < blocksX; xi++) {
    const minX = -totalX / 2 + xi * (blockW + edgeW);
    const minZ = -totalZ / 2 + zi * (blockD + edgeW);
    const isPark = (xi === 1 && zi === 1);
    g.fillStyle = isPark ? INK.park : INK.block;
    g.fillRect(toX(minX), toY(minZ), blockW * k, blockD * k);
  }

  // Carriageways
  g.strokeStyle = INK.road;
  g.lineWidth = Math.max(1, roadW * k);
  for (let xi = 0; xi < blocksX - 1; xi++) {
    const rdX = -totalX / 2 + (xi + 1) * blockW + xi * edgeW + roadW / 2 + sidewalkW;
    g.beginPath(); g.moveTo(toX(rdX), toY(-totalZ / 2)); g.lineTo(toX(rdX), toY(totalZ / 2)); g.stroke();
  }
  for (let zi = 0; zi < blocksZ - 1; zi++) {
    const rdZ = -totalZ / 2 + (zi + 1) * blockD + zi * edgeW + roadW / 2 + sidewalkW;
    g.beginPath(); g.moveTo(toX(-totalX / 2), toY(rdZ)); g.lineTo(toX(totalX / 2), toY(rdZ)); g.stroke();
  }
  // The road out of town, running east past the edge of the inset.
  g.beginPath();
  g.moveTo(toX(totalX / 2), toY(0));
  g.lineTo(toX(totalX / 2 + TOWN.avenueLen), toY(0));
  g.stroke();

  // Real building footprints
  g.fillStyle = INK.footprint;
  for (const b of buildingRegistry) {
    g.fillRect(toX(b.cx - b.w / 2), toY(b.cz - b.d / 2),
               Math.max(1, b.w * k), Math.max(1, b.d * k));
  }

  g.restore();

  g.strokeStyle = INK.frame;
  g.lineWidth = 1;
  g.strokeRect(x0 + 0.5, y0 + 0.5, S - 1, S - 1);

  g.fillStyle = INK.label;
  g.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.fillText('PLAN', x0 + 5, y0 + 11);
}

/**
 * A 40px terrain swatch for a register row.
 *
 * The register has to be scannable by eye as well as readable by name: a
 * coastal site and an upland site should look different before the player
 * reads either label. Sampled from the same field as everything else.
 */
export function drawSwatch(canvas, site, spanDeg = 16) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const S = canvas.clientWidth || 40;
  canvas.width = Math.round(S * dpr);
  canvas.height = Math.round(S * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const N = 20;
  const img = g.createImageData(N, N);
  const d = img.data;
  for (let j = 0; j < N; j++) {
    const lat = site.lat + (0.5 - (j + 0.5) / N) * spanDeg * 2;
    const clamped = Math.max(-89, Math.min(89, lat));
    const lonScale = 1 / Math.max(0.25, Math.cos(clamped * Math.PI / 180));
    for (let i = 0; i < N; i++) {
      const lon = site.lon + ((i + 0.5) / N - 0.5) * spanDeg * 2 * lonScale;
      const smp = sampleAll(toVec(clamped, lon));
      const [r, gg, b] = rampColor(smp.elev, smp.moist);
      const k = (j * N + i) * 4;
      d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = N; tmp.height = N;
  tmp.getContext('2d').putImageData(img, 0, 0);

  g.save();
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - 0.5, 0, Math.PI * 2);
  g.clip();
  g.imageSmoothingEnabled = true;
  g.drawImage(tmp, 0, 0, S, S);
  g.restore();

  g.strokeStyle = site.settled ? 'rgba(127,224,192,0.5)' : 'rgba(127,224,192,0.14)';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - 0.5, 0, Math.PI * 2);
  g.stroke();
}

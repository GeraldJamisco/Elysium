import * as THREE from 'three';

// ============================================================
// ELYSIUM NAVIGATION — THE VIEWFINDER
//
// Produces the preview imagery the register and the site card
// show, by RENDERING THE ACTUAL WORLD from authored camera
// positions and keeping the results as images.
//
// This is the whole reason the navigation layer can be trusted:
// the picture of the Community Hall is the Community Hall, shot
// from the street the player will walk down to reach it. Nothing
// in the interface is concept art for a place that does not
// exist, and nothing can drift out of sync with the world,
// because it IS the world.
//
// A site that has not been built cannot be photographed, so an
// unsettled site falls back to a survey chart drawn from the
// terrain model (see chart.js). Settled places get photographs;
// surveyed places get charts. The distinction is the honest one.
//
// COST
// Five offscreen renders, once, at load. They happen while the
// surface scenery is already assembled, and every render target
// is disposed as soon as its image has been captured.
// ============================================================

let _renderer = null;
let _scene = null;

export function setViewfinderContext(renderer, scene) {
  _renderer = renderer;
  _scene = scene;
}

/**
 * Render one view of the world and return it as a data URL.
 *
 * @param {object} shot { pos:[x,y,z], look:[x,y,z], fov, w, h }
 * @returns {string|null} a PNG data URL, or null if rendering is unavailable
 */
export function capture(shot) {
  if (!_renderer || !_scene) return null;
  const w = shot.w || 512;
  const h = shot.h || 320;

  // NOT multisampled: readRenderTargetPixels cannot resolve a multisampled
  // buffer and hands back nothing, which renders every preview black. The
  // previews are downscaled in the interface anyway, so the aliasing this
  // costs is invisible.
  const target = new THREE.WebGLRenderTarget(w, h, { samples: 0 });
  target.texture.colorSpace = _renderer.outputColorSpace;

  const cam = new THREE.PerspectiveCamera(shot.fov || 58, w / h, 0.35, 3000);
  cam.position.set(shot.pos[0], shot.pos[1], shot.pos[2]);
  cam.lookAt(shot.look[0], shot.look[1], shot.look[2]);

  const prevTarget = _renderer.getRenderTarget();
  _renderer.setRenderTarget(target);
  _renderer.render(_scene, cam);

  // Read the pixels back and hand them over as an ordinary image, so the
  // GPU resource can be released immediately rather than held for the life
  // of the session just to fill a 160px thumbnail.
  const buf = new Uint8Array(w * h * 4);
  _renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
  _renderer.setRenderTarget(prevTarget);
  target.dispose();

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  // WebGL reads bottom-up; images are top-down.
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    img.data.set(buf.subarray(src, src + w * 4), y * w * 4);
  }
  ctx.putImageData(img, 0, 0);

  // A whisper of vignette so the previews sit in the interface rather than
  // looking like screenshots pasted into it.
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.32, w / 2, h / 2, h * 0.86);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(4,14,12,0.34)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  return canvas.toDataURL('image/png');
}

/**
 * Capture every preview the navigation layer needs.
 * @param {object} shots  map of key -> shot spec
 * @returns {object} map of key -> data URL
 */
export function captureAll(shots) {
  const out = {};
  for (const [key, shot] of Object.entries(shots)) {
    try {
      out[key] = capture(shot);
    } catch (err) {
      console.warn('viewfinder: could not capture', key, err);
      out[key] = null;
    }
  }
  return out;
}

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const scene = new THREE.Scene();
// Far plane 12000, not 4000.
//
// The terrain plain is 14000 across, so relief stands out to roughly
// 7 km, while the camera stopped drawing at 4 km.  On the street and
// under the old Eagle haze that cut was invisible.  With the Phase 9A
// regional view — 2.5 km of world seen from 2.2 km up, through thinner
// air — it became a hard horizon: distant hills sliced mid-slope with
// sky showing through the gap, in facets, which read as panels floating
// above the landscape.
//
// The sky dome does not hide it: its material is depthWrite:false, so
// it never occludes anything, it only fills what nothing else drew.
//
// Near stays 0.5 — depth precision is governed mostly by the near plane,
// and the 10-12 mm road/footway/marking offsets this project depends on
// are unchanged by moving far.
export const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.5, 12000);
export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
export const controls = { orbit: null };

export function initRenderer() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.id = 'mc-canvas';
  document.body.appendChild(renderer.domElement);

  controls.orbit = new OrbitControls(camera, renderer.domElement);
  controls.orbit.enableDamping = true;
  controls.orbit.dampingFactor = 0.08;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

/** Reconfigure the one OrbitControls for a given stage (orbital/eagle) */
export function setOrbitConfig({ target, minDist, maxDist, enablePan, enableZoom }) {
  const o = controls.orbit;
  o.target.set(target[0], target[1], target[2]);
  o.minDistance = minDist;
  o.maxDistance = maxDist;
  o.enablePan = !!enablePan;
  if (enableZoom !== undefined) o.enableZoom = enableZoom;
  o.update();
}

export function startLoop(fn) {
  renderer.setAnimationLoop(() => { fn(); renderer.render(scene, camera); });
}
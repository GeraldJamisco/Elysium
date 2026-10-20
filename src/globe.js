import * as THREE from 'three';
import { PINS, CAMERA, ORBIT } from './config.js';
import { scene, camera } from './scene.js';
import { planetMaps } from './planetmaps.js';
import { resolveSettlement, toVec } from './world.js';

export const state = {
  globeRadius: CAMERA.globeRadius,
  onGround: false,
  flightUpdate: null,
  stars: null,
  planet: null,
  pinGroup: null,
};
const pins = [];
export { pins };

// The sun that lights Amarine from orbit. Shared by the surface, the
// cloud deck and the atmosphere shell so the terminator, the cloud
// shading and the limb glow all agree on where the light is coming from.
const SUN_DIR = new THREE.Vector3(...ORBIT.sunDir).normalize();

export function buildGlobe() {
  const g = new THREE.Group();
  g.name = 'globe';
  scene.add(g);

  const R = CAMERA.globeRadius;
  const maps = planetMaps();

  // ============================================================
  // SURFACE
  //
  // A custom shader rather than MeshStandardMaterial, because the
  // orbit view needs three things a standard material will not give:
  // a terminator soft enough to read as atmosphere rather than as a
  // hard edge, a night side that stays legible instead of going to
  // black, and city lights that appear only where the sun does not.
  // ============================================================
  const surfaceMat = new THREE.ShaderMaterial({
    uniforms: {
      uAlbedo:   { value: maps.albedo },
      uData:     { value: maps.data },
      uSunDir:   { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(ORBIT.sunColor) },
      uAmbient:  { value: new THREE.Color(ORBIT.nightAmbient) },
      uAtmo:     { value: new THREE.Color(ORBIT.atmoColor) },
      uLights:   { value: new THREE.Color(ORBIT.cityLight) },
      uExposure: { value: ORBIT.surfaceExposure },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform sampler2D uAlbedo;
      uniform sampler2D uData;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uAmbient;
      uniform vec3 uAtmo;
      uniform vec3 uLights;
      uniform float uExposure;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vView;

      void main() {
        vec3 albedo = texture2D(uAlbedo, vUv).rgb;
        vec3 data   = texture2D(uData, vUv).rgb;
        float water = data.r;
        float city  = data.g;
        float snow  = data.b;

        vec3 N = normalize(vN);
        vec3 V = normalize(vView);
        float ndl = dot(N, uSunDir);

        // Day mask with a wide soft terminator. A planet's shadow edge is
        // blurred by its own atmosphere over hundreds of kilometres; a hard
        // lambert cut is the thing that makes a sphere look like a prop.
        float day = smoothstep(-0.12, 0.24, ndl);

        // Slightly wrapped diffuse so the land near the terminator keeps
        // some form instead of collapsing to a flat band.
        float diff = clamp(ndl * 0.90 + 0.12, 0.0, 1.0);
        diff = pow(diff, 1.25);

        vec3 lit = albedo * uSunColor * diff;

        // Ocean sheen. Only water gets it, and only where the sun is up,
        // which is most of what separates sea from land at a glance.
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 220.0);
        lit += uSunColor * spec * water * day * 0.30;
        // A second, much broader lobe gives the sea a sheen away from the
        // glint itself rather than leaving it flat.
        lit += uSunColor * pow(max(dot(N, H), 0.0), 8.0) * water * day * 0.055;
        // Snow and ice throw a broader, softer highlight.
        lit += uSunColor * pow(max(dot(N, H), 0.0), 12.0) * snow * day * 0.08;

        // Night side: a low cool fill keeps the surface readable without
        // pretending it is daylight.
        lit += albedo * uAmbient * (1.0 - day * 0.72);

        // City lights, only on the unlit side, brightest at full night.
        float night = 1.0 - day;
        lit += uLights * city * night * night * 1.5;

        // Atmospheric limb: strongest at grazing angles, and much stronger
        // on the sunlit side where there is actually light to scatter.
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        float fwd = smoothstep(-0.30, 0.85, ndl);
        lit += uAtmo * fres * (0.10 + 0.90 * fwd) * 0.85;

        lit *= uExposure;
        gl_FragColor = vec4(lit, 1.0);
      }
    `,
  });

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 80), surfaceMat);
  sphere.name = 'planet-surface';
  g.add(sphere);
  state.planet = sphere;

  // ============================================================
  // CLOUD DECK
  // Thin, banded and sparse. Enough to say "this world has weather",
  // never enough to hide the geography underneath it.
  // ============================================================
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.012, 96, 56),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uMap:    { value: makeCloudTex() },
        uSunDir: { value: SUN_DIR.clone() },
        uTint:   { value: new THREE.Color(ORBIT.cloudColor) },
        uOpacity: { value: ORBIT.cloudOpacity },
      },
      vertexShader: `
        varying vec2 vUv; varying vec3 vN;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap; uniform vec3 uSunDir; uniform vec3 uTint;
        uniform float uOpacity;
        varying vec2 vUv; varying vec3 vN;
        void main() {
          float c = texture2D(uMap, vUv).r;
          float ndl = dot(normalize(vN), uSunDir);
          float day = smoothstep(-0.12, 0.34, ndl);
          float shade = clamp(ndl * 0.75 + 0.25, 0.0, 1.0);
          vec3 col = uTint * (0.30 + 0.70 * shade);
          gl_FragColor = vec4(col, c * uOpacity * (0.12 + 0.88 * day));
        }
      `,
    })
  );
  clouds.name = 'clouds';
  g.add(clouds);

  // ============================================================
  // ATMOSPHERE SHELL
  // Rendered back-face-first outside the planet so it reads as a
  // halo of air around the limb rather than a flat coloured outline.
  // ============================================================
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.055, 96, 56),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSunDir: { value: SUN_DIR.clone() },
        uColor:  { value: new THREE.Color(ORBIT.atmoColor) },
        uStrength: { value: ORBIT.atmoStrength },
      },
      vertexShader: `
        varying vec3 vN; varying vec3 vView;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vView = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDir; uniform vec3 uColor; uniform float uStrength;
        varying vec3 vN; varying vec3 vView;
        void main() {
          // Back faces: the normal points away from the viewer, so flip it.
          vec3 N = normalize(-vN);
          float rim = pow(1.0 - max(dot(N, normalize(vView)), 0.0), 3.4);
          float sun = smoothstep(-0.45, 0.55, dot(N, uSunDir));
          float a = rim * (0.05 + 0.95 * sun);
          gl_FragColor = vec4(uColor * a * uStrength, a);
        }
      `,
    })
  );
  atmo.name = 'atmosphere';
  g.add(atmo);

  // ============================================================
  // SETTLEMENT MARKERS
  // ============================================================
  const markers = new THREE.Group();
  markers.name = 'pins';
  g.add(markers);
  state.pinGroup = markers;

  // Every marker is placed on ground the geography model guarantees is
  // land — see world.resolveSettlement. A marker floating over ambiguous
  // terrain is the one thing the orbit view must never do.
  const placed = resolveSettlement(PINS);

  placed.forEach(p => {
    const dir = new THREE.Vector3(...toVec(p.lat, p.lon));
    const pos = dir.clone().multiplyScalar(R);
    const node = p.real ? settledMarker(dir, R) : surveyMarker(dir, R);
    markers.add(node.group);
    pins.push({ mesh: node.hit, data: p, pos, dir, real: p.real, group: node.group });
  });

  return g;
}

/** Orient a flat disc so it lies tangent to the sphere at `dir`. */
function tangentQuat(dir) {
  const q = new THREE.Quaternion();
  q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  return q;
}

/**
 * Veridian Cap: a settled place.
 *
 * The marker is deliberately NOT a bright ball stuck to the surface. It is
 * a ring lying flat on the ground with a short upright tick above it, so it
 * reads as an annotation of a location — the land underneath stays visible
 * through it, which is what lets the player see that the town sits on a
 * continent rather than on the marker.
 */
function settledMarker(dir, R) {
  const group = new THREE.Group();
  const q = tangentQuat(dir);
  const base = dir.clone().multiplyScalar(R * 1.001);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xa8e6bb, transparent: true, opacity: 0.72,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.56, 48), ringMat);
  ring.position.copy(base); ring.quaternion.copy(q);
  group.add(ring);

  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.46, 32),
    new THREE.MeshBasicMaterial({
      color: 0xd8f6e2, transparent: true, opacity: 0.7,
      depthWrite: false, side: THREE.DoubleSide,
    })
  );
  inner.position.copy(dir.clone().multiplyScalar(R * 1.0012));
  inner.quaternion.copy(q);
  group.add(inner);

  // A soft ground glow, so the settlement is findable on the night side too.
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(2.9, 40),
    new THREE.MeshBasicMaterial({
      color: 0x9be8b4, transparent: true, opacity: 0.085,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  glow.position.copy(dir.clone().multiplyScalar(R * 1.0008));
  glow.quaternion.copy(q);
  group.add(glow);

  // Upright tick: gives the marker a position in space, not just on a map.
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6),
    new THREE.MeshBasicMaterial({ color: 0xd6ffe2, transparent: true, opacity: 0.55, depthWrite: false })
  );
  stem.position.copy(dir.clone().multiplyScalar(R + 1.2));
  stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  group.add(stem);

  // The click target. Kept invisible and generously sized so selection
  // stays as forgiving as it was when the marker was a solid ball.
  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 12, 12),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.copy(dir.clone().multiplyScalar(R + 1.4));
  group.add(hit);

  return { group, hit };
}

/**
 * An unsettled location: surveyed, named, not built.
 *
 * A thin open ring with no glow and no upright. It has to read as
 * "potential" — if it looked like Veridian Cap, the planet would appear
 * to have ten cities on it, which is the opposite of the truth.
 */
function surveyMarker(dir, R) {
  const group = new THREE.Group();
  const q = tangentQuat(dir);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.05, 1.22, 32),
    new THREE.MeshBasicMaterial({
      color: 0x8fb6c4, transparent: true, opacity: 0.42,
      depthWrite: false, side: THREE.DoubleSide,
    })
  );
  ring.position.copy(dir.clone().multiplyScalar(R * 1.001));
  ring.quaternion.copy(q);
  group.add(ring);

  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 16),
    new THREE.MeshBasicMaterial({
      color: 0xa8ccd8, transparent: true, opacity: 0.5,
      depthWrite: false, side: THREE.DoubleSide,
    })
  );
  dot.position.copy(dir.clone().multiplyScalar(R * 1.0012));
  dot.quaternion.copy(q);
  group.add(dot);

  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 10, 10),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.copy(dir.clone().multiplyScalar(R + 0.9));
  group.add(hit);

  return { group, hit };
}

export function buildStars() {
  const starCount = 4000;
  const positions = new Float32Array(starCount * 3);
  const sizes = new Float32Array(starCount);
  const colors = new Float32Array(starCount * 3);
  const r = 2200;
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    sizes[i] = 0.5 + Math.random() * 1.5;
    const warmth = Math.random();
    colors[i * 3] = 0.8 + warmth * 0.2;
    colors[i * 3 + 1] = 0.8 + warmth * 0.1;
    colors[i * 3 + 2] = 0.8 + (1 - warmth) * 0.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 1.6,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: false,
    depthWrite: false,
  });
  state.stars = new THREE.Points(geo, mat);
  const stars = state.stars;
  stars.frustumCulled = false;
  scene.add(stars);
}

/**
 * Cloud deck: latitude-banded streaks rather than scattered blobs.
 * Banding is what makes a cloud layer read as weather on a rotating
 * body instead of as static noise painted on a ball.
 */
function makeCloudTex() {
  const w = 1024, h = 512;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;

  const hash = (x, y) => {
    let v = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let xf = x - xi, yf = y - yi;
    xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), cc = hash(xi, yi + 1), dd = hash(xi + 1, yi + 1);
    return (a * (1 - xf) + b * xf) * (1 - yf) + (cc * (1 - xf) + dd * xf) * yf;
  };
  const fb = (x, y, o) => {
    let v = 0, a = 1, f = 1, n = 0;
    for (let i = 0; i < o; i++) { v += a * vn(x * f, y * f); n += a; a *= 0.5; f *= 2.17; }
    return v / n;
  };

  for (let y = 0; y < h; y++) {
    const lat = 90 - (y + 0.5) / h * 180;
    // Three broad bands: equatorial convergence and two mid-latitude belts.
    const band =
      Math.exp(-Math.pow(lat / 13, 2)) * 0.75 +
      Math.exp(-Math.pow((Math.abs(lat) - 46) / 15, 2)) * 0.8 +
      0.18;
    for (let x = 0; x < w; x++) {
      // Stretched horizontally so clouds shear into streaks.
      const n = fb(x * 0.016, y * 0.055, 4);
      let v = (n - 0.46) * 3.4 * band;
      v = Math.max(0, Math.min(1, v));
      v = v * v * (3 - 2 * v);
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(v * 255);
      // Red channel carries coverage; alpha is unused by the shader but
      // keeping them equal makes the texture legible when inspected.
      d[i] = Math.round(v * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function pickPin(x, y) {
  const r = new THREE.Raycaster();
  r.setFromCamera(new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1), camera);
  let best = null, bestD = Infinity;
  for (const p of pins) {
    const hits = r.intersectObject(p.mesh);
    if (hits.length && hits[0].distance < bestD) { bestD = hits[0].distance; best = p; }
  }
  return best;
}

// Test aid: project a pin's world position to screen coords so an automated
// test can click it exactly.
export function getPinScreen(name) {
  const pin = pins.find(p => p.data.name === name);
  if (!pin) return null;
  const world = pin.mesh.getWorldPosition(new THREE.Vector3());
  const v = world.clone().project(camera);
  // A pin on the far side of the planet projects to a valid screen point but
  // is not clickable, so report facing as well as frustum membership.
  const toCam = camera.position.clone().sub(world).normalize();
  const outward = world.clone().normalize();
  const facing = outward.dot(toCam) > 0.12;
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: -(v.y * 0.5 - 0.5) * window.innerHeight,
    visible: v.z < 1 && facing,
  };
}

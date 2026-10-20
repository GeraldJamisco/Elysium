import * as THREE from 'three';
import { scene, renderer } from './scene.js';
import { ATMOS } from './config.js';

// ============================================================
// ATMOSPHERE — Phase 5E
//
// One canonical sun vector (ATMOS.sunDir) drives BOTH the sky
// shader and the DirectionalLight, so the visible sun disc and
// the cast shadows agree.  Amarine sits in warm late-afternoon
// light: high enough (~41 degrees) that street-level facades
// read, low enough that massing casts legible shadows.
//
// Illumination model:
//   sun   — directional key, warm white, casts shadows
//   hemi  — sky/ground bounce, the reason shadowed facades stay
//           readable instead of crushing to black
//   amb   — small cool floor so nothing is ever pure black
// ============================================================

export const skyState = { material: null, mesh: null, sun: null, hemi: null, fog: null };

export function buildAtmosphere() {
  const sunDir = new THREE.Vector3(...ATMOS.sunDir).normalize();

  // ---- Shader sky dome ----
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith:  { value: new THREE.Color(ATMOS.zenith) },
      uMid:     { value: new THREE.Color(ATMOS.skyMid) },
      uHorizon: { value: new THREE.Color(ATMOS.horizon) },
      uSun:     { value: new THREE.Color(ATMOS.sunColor) },
      uSunDir:  { value: sunDir.clone() },
      uHaze:    { value: new THREE.Color(ATMOS.hazeColor) },
    },
    vertexShader: `
      varying vec3 vW;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon;
      uniform vec3 uSun; uniform vec3 uSunDir; uniform vec3 uHaze;
      varying vec3 vW;
      void main(){
        vec3 d = normalize(vW);
        float h = d.y;

        // Three-stop vertical gradient: horizon -> mid -> zenith.
        float tLow  = smoothstep(-0.06, 0.28, h);
        float tHigh = smoothstep(0.16, 0.78, h);
        vec3 c = mix(uHorizon, uMid, tLow);
        c = mix(c, uZenith, tHigh);

        // Sun disc + forward-scatter halo.
        float sd = max(0.0, dot(d, uSunDir));
        c += uSun * pow(sd, 900.0) * 6.0;
        c += uSun * pow(sd, 22.0) * 0.22;
        c += uSun * pow(sd, 3.0) * 0.07;

        // Warm haze thickening toward the horizon line, kept thin enough
        // that the ridge silhouettes stay readable against it.
        float band = exp(-max(h, 0.0) * 8.0);
        c = mix(c, uHaze, band * 0.42);

        // Below the horizon fades into ground haze so the terrain
        // edge never reads as a hard cut against the sky.
        c = mix(c, uHaze * 0.82, smoothstep(0.0, -0.12, h));

        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  // Radius 11000: inside the camera's 12000 far plane and outside the
  // 7 km reach of the terrain, so the dome is always BEHIND the
  // landscape rather than cutting through it.  The shader is a function
  // of view direction only, so radius changes nothing about how it looks.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(11000, 48, 32), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);
  skyState.material = skyMat;
  skyState.mesh = sky;

  // ---- Key light ----
  const sun = new THREE.DirectionalLight(ATMOS.sunColor, ATMOS.sunIntensity);
  sun.position.copy(sunDir).multiplyScalar(260);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 4096;
  sun.shadow.mapSize.height = 4096;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 620;
  // Box centred a little east of the settlement so the avenue keeps shadows.
  const R = 150;
  sun.shadow.camera.left = -R;
  sun.shadow.camera.right = R;
  sun.shadow.camera.top = R;
  sun.shadow.camera.bottom = -R;
  // normalBias is what stops shadow acne on the many flat boxes without
  // the peter-panning that a large constant bias would cause.
  // PCFSoftShadowMap was removed in three r186; softness comes from the
  // filter radius instead, which also keeps the shadow map cost flat.
  sun.shadow.radius = 2.2;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  sun.target.position.set(30, 0, 0);
  sun.position.add(new THREE.Vector3(30, 0, 0));
  scene.add(sun);
  scene.add(sun.target);
  skyState.sun = sun;

  // ---- Sky / ground bounce ----
  const hemi = new THREE.HemisphereLight(ATMOS.skyBounce, ATMOS.groundBounce, ATMOS.hemiIntensity);
  scene.add(hemi);
  skyState.hemi = hemi;

  // ---- Minimum ambient floor ----
  scene.add(new THREE.AmbientLight(ATMOS.ambientColor, ATMOS.ambientIntensity));

  // ---- Aerial perspective ----
  skyState.fog = new THREE.FogExp2(ATMOS.fogColor, ATMOS.fogDensity);
  scene.fog = skyState.fog;

  // ---- Image-based lighting from the sky itself ----
  // Glass and metal need something to reflect.  Without an environment
  // map a metallic MeshStandardMaterial resolves to black, which is why
  // every window read as a dark hole.  Pre-filtering the sky dome costs
  // one texture, once, and makes glazing behave like glazing: pale where
  // it catches the sky, dark where it faces the ground.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene();
  skyScene.add(sky);
  const env = pmrem.fromScene(skyScene, 0.04);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.85;
  scene.add(sky);          // return the dome to the live scene
  pmrem.dispose();
}

// ============================================================
// CHUNK MANAGER — Phase 7
//
// Keeps the world around the camera populated with deterministic
// procedural content while never doing too much work in one frame.
//
// The world is divided into a grid of 200×200 unit chunks, materialised
// lazily as the camera approaches and released as it leaves:
//
//   LOD 0 (< 200 m)   full buildings with collision, roads, land cover,
//                     planting
//   LOD 1 (< 500 m)   building masses and roofs, roads, land cover
//   LOD 2 (< 2000 m)  land cover only
//   OFF   (> maxGen)  not generated
//
// Chunk (0,0) is skipped: it is Veridian Cap's authored territory, and
// the parcel layer additionally refuses to place anything inside the
// settlement's authored radius, so procedural buildings can never spill
// into the town regardless of where the chunk edges fall.
//
// Phase 7 visual sanitation changed what a chunk does, not how it is
// scheduled.  Roads are no longer generated here — they belong to the
// global network in roads.js, which is what makes them continuous across
// chunk boundaries — and buildings are no longer placed on a grid, but
// enumerated from the road frontage that passes through the chunk.
//
// One thing is new in the schedule: before a chunk can be built, the
// settlements whose development reaches it must have had their street
// networks generated.  That work is done at most one settlement per
// frame, because generating a city's streets is the single largest
// piece of work in the system and doing two in a frame is visible.
// ============================================================

import * as THREE from 'three';
import { PROC } from '../config.js';
import { ground } from '../city/layout.js';
import { collisionRegistry } from '../city/collision.js';
import { allSettlements, buildSettlements } from './settlement.js';
import { getChunkAcc, finalizeChunk, accPart, accSlab, releaseChunkAcc } from './accProc.js';
import {
  generateHighways, segmentsForChunk, buildRoadGeometry,
  clearRoads, ensureSettlementRoads, settlementRoadsReady,
} from './roads.js';
import { buildParcelBuilding, buildLOD1Volume, setCollisionTracker, setNearSegments } from './buildingfam.js';
import { parcelsForSegment, farmsteadsForChunk } from './parcels.js';
import { buildChunkLandscape, buildSettlementCore } from './landscape.js';
import { buildJunctions, buildJunctionGeometry, clearJunctions } from './junctions.js';
import { buildRegionalMass } from './regional.js';
import { buildIndustrialGround } from './ruralinfra.js';

// Frame budget, in units of "one full-detail chunk".  A LOD 2 chunk is
// land cover and roads only, so a frame can afford several of them; a
// LOD 0 chunk with its buildings and planting is the expensive case and
// stays at two per frame, as it was before the cover distance grew.
const FRAME_BUDGET = 2;
const LOD_COST = [1, 1, 0.25];
const CHUNK = PROC.chunkSize;      // 200

// Frontage that serves a chunk can start outside it, so segments are
// gathered with a margin wide enough to cover the deepest plot.
const FRONTAGE_MARGIN = 70;

export class ProceduralWorld {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'procedural-world';
    this.chunks = new Map();        // key "cx,cz" -> { cx, cz, group, lod, collisionBodies }
    this.queue = [];                // pending chunk builds, nearest first
    this.pending = new Set();       // keys already queued
    this.initialized = false;
    this._settlementWork = 0;       // settlements generated this frame
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    clearRoads();
    clearJunctions();
    buildSettlements(PROC.procSeed);
    generateHighways(PROC.procSeed);
    ground.add(this.group);
  }

  /**
   * Per-frame update, called from the main loop.
   * @param {THREE.Vector3} camPos  camera position (world)
   * @param {string} stage          'orbit' | 'eagle' | 'walk'
   */
  update(camPos, stage) {
    if (!this.initialized) this.init();
    this._settlementWork = 0;

    const px = camPos.x;
    const pz = camPos.z;
    const pchX = Math.floor(px / CHUNK);
    const pchZ = Math.floor(pz / CHUNK);

    // ---- Desired LOD for every chunk within generation range ----
    // The regional radius applies to Eagle only (see config).
    const range = stage === 'eagle'
      ? Math.max(PROC.maxGenDistance, PROC.regionalGenDistance)
      : PROC.maxGenDistance;
    const keep = stage === 'eagle'
      ? Math.max(PROC.unloadDistance, PROC.regionalGenDistance)
      : PROC.unloadDistance;
    const scan = Math.ceil(range / CHUNK);
    for (let dz = -scan; dz <= scan; dz++) {
      for (let dx = -scan; dx <= scan; dx++) {
        const cx = pchX + dx;
        const cz = pchZ + dz;
        if (cx === 0 && cz === 0) continue;   // Veridian Cap
        const key = cx + ',' + cz;

        const ccx = (cx + 0.5) * CHUNK;
        const ccz = (cz + 0.5) * CHUNK;
        const d = Math.hypot(px - ccx, pz - ccz);

        if (d > keep) { this._unload(key); continue; }

        const desired = d < PROC.lod0Dist ? 0 : d < PROC.lod1Dist ? 1 : 2;
        const cur = this.chunks.get(key);
        if (!cur) {
          if (!this.pending.has(key)) {
            this.pending.add(key);
            this.queue.push({ cx, cz, key, d, desired });
          }
        } else if (desired < cur.lod) {
          // The camera moved closer than the chunk was last built — the
          // chunk is rebuilt at the finer LOD.
          this._remove(key, cur);
          this.chunks.delete(key);
          if (!this.pending.has(key)) {
            this.pending.add(key);
            this.queue.push({ cx, cz, key, d, desired });
          }
        }
      }
    }

    // ---- Drain the pending queue within the frame budget ----
    this.queue.sort((a, b) => a.d - b.d);
    let spent = 0;
    let guard = 0;
    while (this.queue.length && spent < FRAME_BUDGET && guard++ < 64) {
      const item = this.queue[0];
      if (this.chunks.has(item.key)) { this.queue.shift(); this.pending.delete(item.key); continue; }

      // A chunk cannot be built before the settlements that reach into
      // it have streets.  If generating them would blow the frame
      // budget, the chunk waits — it will be first in the queue next
      // frame, so nothing is lost but a frame of latency.
      if (!this._ensureRoadsFor(item.cx, item.cz)) break;

      this.queue.shift();
      this.pending.delete(item.key);
      this._build(item.cx, item.cz, item.key, item.desired);
      spent += LOD_COST[item.desired];
    }
  }

  /**
   * Make sure every settlement whose development reaches this chunk has
   * generated its street network.  Returns false if the work had to be
   * deferred to keep the frame budget.
   */
  _ensureRoadsFor(cx, cz) {
    const ccx = (cx + 0.5) * CHUNK;
    const ccz = (cz + 0.5) * CHUNK;
    const reach = CHUNK * 0.75 + FRONTAGE_MARGIN;

    for (const s of allSettlements()) {
      if (settlementRoadsReady(s)) continue;
      // Only settlements that can actually touch this chunk.
      const d = Math.hypot(s.x - ccx, s.z - ccz);
      if (d > s.edgeR * 1.4 + reach) continue;
      if (this._settlementWork >= 1) return false;
      ensureSettlementRoads(s);
      // The junction model is derived from the road graph, so it has to
      // be rebuilt whenever a settlement adds roads to that graph.
      clearJunctions();
      this._settlementWork++;
    }
    return true;
  }

  // ---- materialise one chunk at the given LOD ----
  _build(cx, cz, key, lod) {
    getChunkAcc(key);

    const minX = cx * CHUNK, maxX = minX + CHUNK;
    const minZ = cz * CHUNK, maxZ = minZ + CHUNK;
    const bounds = { minX, minZ, maxX, maxZ };
    const io = { accPart, accSlab, chunkKey: key };

    // Collision bodies created anywhere in this chunk, so they can all be
    // unregistered together when it unloads.
    const collisionBodies = [];
    const collisionBodiesEarly = collisionBodies;

    // Segments near the chunk drive land cover masking, frontage and
    // planting; the chunk only draws the ones it owns, so a segment
    // crossing a boundary is drawn exactly once.
    const nearSegs = segmentsForChunk(cx, cz, CHUNK, FRONTAGE_MARGIN);
    const mySegs = nearSegs.filter(s => {
      const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2;
      return mx >= minX && mx < maxX && mz >= minZ && mz < maxZ;
    });

    // ---- Land cover ----
    buildChunkLandscape(key, bounds, nearSegs, lod, io);

    // ---- Roads ----
    buildRoadGeometry(mySegs, key, accPart, accSlab);

    // ---- Junction control ----
    // Signals, crossings and the gateway roundabout, for the junctions
    // whose centre falls in this chunk.
    buildJunctionGeometry(key, bounds, accPart, accSlab, lod, collisionBodiesEarly);

    // ---- Settlement centres ----
    for (const s of allSettlements()) {
      if (s.x >= minX && s.x < maxX && s.z >= minZ && s.z < maxZ) {
        buildSettlementCore(key, s, bounds, io);
      }
    }

    // ---- Buildings ----
    setCollisionTracker(collisionBodies);

    if (lod >= 2 && PROC.regionalMass) {
      // Regional mass: the only building content beyond the detail
      // radius.  Without it these chunks carried roads and fields and
      // nothing else, which is what made the world stop at 500 m.
      buildRegionalMass(key, bounds, nearSegs, accPart);
    }

    if (lod <= 1) {
      const parcels = [];
      for (const seg of nearSegs) parcelsForSegment(seg, bounds, nearSegs, parcels);
      farmsteadsForChunk(bounds, nearSegs, parcels);

      const budget = PROC.maxBuildingsPerChunk;
      const n = Math.min(parcels.length, budget);
      // Plot boundaries are checked against these before they are built.
      setNearSegments(nearSegs);
      for (let i = 0; i < n; i++) {
        const p = parcels[i];
        if (lod === 0) buildParcelBuilding(p, io, 2);
        else buildLOD1Volume(p, accSlab, accPart, key);
      }

      // Phase 9C: the ground an industrial cluster works on.  Runs from
      // the parcel list so the yard is squared to the building that
      // stands on it rather than re-deriving where the works is.
      buildIndustrialGround(key, bounds, parcels.slice(0, n), accPart);
    }

    setCollisionTracker(null);
    setNearSegments(null);

    // ---- Finalize ----
    const meshes = finalizeChunk(key, { castShadow: lod === 0 });
    if (!meshes.length) {
      this.chunks.set(key, { cx, cz, group: null, lod, collisionBodies: [] });
      return;
    }
    const g = new THREE.Group();
    g.name = 'chunk-' + key;
    meshes.forEach(m => g.add(m));
    this.group.add(g);
    this.chunks.set(key, { cx, cz, group: g, lod, collisionBodies });
  }

  _remove(key, entry) {
    if (!entry) return;
    if (entry.group) {
      entry.group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
      });
      this.group.remove(entry.group);
    }
    const coll = entry.collisionBodies;
    if (coll && coll.length) {
      for (let i = coll.length - 1; i >= 0; i--) collisionRegistry.removeBody(coll[i]);
    }
    try { releaseChunkAcc(key); } catch (_) { /* accumulator already consumed */ }
  }

  _unload(key) {
    const cur = this.chunks.get(key);
    if (cur) { this._remove(key, cur); this.chunks.delete(key); }
  }

  /** Count of materialised chunks — diagnostic / budget check. */
  getChunkCount() { return this.chunks.size; }
}

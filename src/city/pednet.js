// ============================================================
// PEDESTRIAN NETWORK — Phase 10A
//
// Where a person can walk, derived from what already exists.
//
// The Phase 8.5 road graph is a graph of CARRIAGEWAYS.  It knows that
// two streets meet; it does not know which side of the street you are on,
// and a pedestrian who does not know that will cut diagonally across a
// junction.  So this builds a second, smaller graph on top of it — one
// that is about walking — and it builds it from data that is already
// there rather than inventing a parallel model:
//
//   sidewalk nodes   road segment + footway offset, both sides
//   crossing edges   ONLY at junctions Phase 8.6 already chose to mark
//   door nodes       district.buildings[].entrance, which already exists
//   park nodes       inside MC.world.parkBounds
//
// Nothing here modifies the road graph.  It reads it.
//
// The hierarchy the brief asks for falls out of the graph's shape:
//
//   door -> front path -> sidewalk -> ... -> crossing -> ... -> door
//
// because a door node's ONLY edge is to its own frontage sidewalk, and
// the two sides of a street are ONLY joined where a crossing exists.
// A route cannot skip a step it has no edge for.
// ============================================================

import { TOWN } from '../config.js';
import { authoredStreetSegments } from './layout.js';
import { district } from './district.js';
import { collisionRegistry } from './collision.js';

// How far from the carriageway centreline a person walks.
const FOOTWAY = { street: 2.2, lane: 2.2, authored: 2.6, arterial: 2.8, collector: 2.8 };
const SIDEWALK_STEP = 7;        // node spacing along a footway
const SNAP = 3.2;               // nodes closer than this are the same node

let _net = null;

function key(x, z) { return `${Math.round(x / SNAP)}:${Math.round(z / SNAP)}`; }

class Net {
  constructor() {
    this.nodes = [];            // { x, z, kind, ref }
    this.adj = [];              // adjacency: array of arrays of node indices
    this.index = new Map();     // spatial key -> node index
  }

  add(x, z, kind, ref) {
    const k = key(x, z);
    const hit = this.index.get(k);
    if (hit !== undefined) return hit;
    const i = this.nodes.length;
    this.nodes.push({ x, z, kind, ref: ref || null });
    this.adj.push([]);
    this.index.set(k, i);
    return i;
  }

  link(a, b) {
    if (a === b || a === undefined || b === undefined) return;
    if (!this.adj[a].includes(b)) this.adj[a].push(b);
    if (!this.adj[b].includes(a)) this.adj[b].push(a);
  }

  nearest(x, z, kinds) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (kinds && !kinds.includes(n.kind)) continue;
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /**
   * Shortest walk between two nodes.
   *
   * Breadth-first over the graph, weighted by real distance — the same
   * approach qa/walkability.cjs already proved on this world, rather than
   * steering, which this project has been misled by once before.
   */
  route(from, to) {
    if (from < 0 || to < 0) return null;
    if (from === to) return [from];
    const N = this.nodes.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    dist[from] = 0;
    // Small graph (hundreds of nodes): a simple linear-scan Dijkstra is
    // faster than building a heap and far easier to be sure of.
    const done = new Uint8Array(N);
    for (;;) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < N; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
      if (u < 0) break;
      if (u === to) break;
      done[u] = 1;
      const a = this.nodes[u];
      for (const v of this.adj[u]) {
        if (done[v]) continue;
        const b = this.nodes[v];
        const w = Math.hypot(b.x - a.x, b.z - a.z);
        if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
      }
    }
    if (!isFinite(dist[to])) return null;
    const path = [];
    for (let v = to; v >= 0; v = prev[v]) path.push(v);
    return path.reverse();
  }
}

/**
 * Build the network.  Deterministic: a pure function of the authored
 * street layout, the district model and the junction list.
 */
export function buildPedNet(junctions) {
  if (_net) return _net;
  const net = new Net();

  // ---- 1. Sidewalks ----
  //
  // Two lines of nodes per street, one each side, offset from the
  // centreline by half the carriageway plus half the footway — which is
  // where the pavement actually is, not where the road is.
  const segs = authoredStreetSegments();
  const sideRuns = [];
  for (const s of segs) {
    const fw = FOOTWAY[s.type] || 2.4;
    const off = s.width / 2 + fw / 2;
    const dx = (s.x2 - s.x1) / s.len, dz = (s.z2 - s.z1) / s.len;
    const nx = -dz, nz = dx;
    for (const side of [-1, 1]) {
      const run = [];
      const n = Math.max(1, Math.round(s.len / SIDEWALK_STEP));
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * s.len;
        // The footway carries lamps, tree pits and seats.  A node laid on
        // one puts a person inside it — one agent was standing in a lamp
        // column.  Nudge along the pavement, then across it, and take the
        // first clear spot; the run stays connected either way.
        let x = s.x1 + dx * t + nx * side * off;
        let z = s.z1 + dz * t + nz * side * off;
        const blocked = (px, pz) =>
          collisionRegistry.query(px, pz, 0.85).some(b => b.type !== 'interior');
        if (blocked(x, z)) {
          const tries = [[1.4, 0], [-1.4, 0], [2.8, 0], [-2.8, 0], [0, 0.8], [0, -0.8]];
          for (const [along, across] of tries) {
            const px = x + dx * along + nx * side * across;
            const pz = z + dz * along + nz * side * across;
            if (!blocked(px, pz)) { x = px; z = pz; break; }
          }
        }
        run.push(net.add(x, z, 'sidewalk', { street: s.name, side }));
      }
      for (let i = 1; i < run.length; i++) net.link(run[i - 1], run[i]);
      sideRuns.push({ seg: s, side, run, off });
    }
  }

  // ---- 2. Crossings ----
  //
  // The two sides of a street are joined ONLY where Phase 8.6 decided a
  // crossing belongs.  This is the whole reason a pedestrian does not
  // wander diagonally over a major road: there is no edge to do it with.
  let crossings = 0;
  for (const j of (junctions || [])) {
    if (!j.control || String(j.control).toUpperCase() === 'NONE') continue;
    // Join sidewalk nodes on opposite sides, near the junction.
    const near = [];
    for (let i = 0; i < net.nodes.length; i++) {
      const n = net.nodes[i];
      if (n.kind !== 'sidewalk') continue;
      if (Math.hypot(n.x - j.x, n.z - j.z) < 16) near.push(i);
    }
    for (let a = 0; a < near.length; a++) {
      for (let b = a + 1; b < near.length; b++) {
        const A = net.nodes[near[a]], B = net.nodes[near[b]];
        if (A.ref && B.ref && A.ref.side === B.ref.side) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 6 || d > 20) continue;     // roughly the width of a road
        // The crossing has to be AT the junction.  Linking any opposite
        // pair within range of it laid diagonal crossings mid-block, and
        // an agent walking one was in the carriageway with no crossing
        // under it — seven of them, found by qa/human-presence.cjs.
        const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
        if (Math.hypot(mx - j.x, mz - j.z) > 7) continue;
        net.link(near[a], near[b]);
        crossings++;
      }
    }
  }

  // ---- 3. Doors ----
  //
  // Every building already knows where its door is and which way a
  // person faces leaving it.  A door's only edge is to the pavement of
  // the street it fronts, so "front path -> sidewalk" is not a rule the
  // agent has to obey: it is the only way out.
  let doors = 0;
  for (const b of district.buildings) {
    const e = b.entrance;
    if (!e) continue;
    const di = net.add(e.x + e.dx * 1.5, e.z + e.dz * 1.5, 'door', { building: b.id, tag: b.tag, purpose: b.purpose });
    // The pavement this door belongs to: nearest sidewalk node along the
    // entrance axis, not merely nearest in space, so a door never
    // attaches itself to the street behind the block.
    let best = -1, bd = Infinity;
    for (let i = 0; i < net.nodes.length; i++) {
      const n = net.nodes[i];
      if (n.kind !== 'sidewalk') continue;
      const vx = n.x - e.x, vz = n.z - e.z;
      const along = vx * e.dx + vz * e.dz;
      if (along < 0) continue;                   // behind the facade
      const d = Math.hypot(vx, vz);
      if (d < bd && d < 26) { bd = d; best = i; }
    }
    if (best >= 0) { net.link(di, best); doors++; }
  }

  // ---- 4. The green ----
  //
  // A ring of nodes inside the park with a path across it, joined to the
  // pavement wherever the two come close.  The park is a destination and
  // a route, which is what makes people cross it rather than only skirt it.
  const P = { minX: -21, maxX: 21, minZ: -19, maxZ: 19 };
  const parkNodes = [];
  for (let x = P.minX + 4; x <= P.maxX - 4; x += 7) {
    for (let z = P.minZ + 4; z <= P.maxZ - 4; z += 7) {
      // Not on top of the furniture.  A lattice laid blindly over the
      // plaza put nodes inside the basin, and three people ended up
      // standing in the fountain — found by qa/human-presence.cjs, which
      // is exactly the check it exists for.
      if (collisionRegistry.query(x, z, 1.3).some(b => b.type !== 'interior')) continue;
      parkNodes.push({ i: net.add(x, z, 'park', null), x, z });
    }
  }
  for (const a of parkNodes) {
    for (const b of parkNodes) {
      if (a.i === b.i) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) <= 7.5) net.link(a.i, b.i);
    }
  }
  // Join the park to the pavement around it.
  for (const a of parkNodes) {
    for (let i = 0; i < net.nodes.length; i++) {
      const n = net.nodes[i];
      if (n.kind !== 'sidewalk') continue;
      if (Math.hypot(n.x - a.x, n.z - a.z) < 9) net.link(a.i, i);
    }
  }

  net.stats = { nodes: net.nodes.length, doors, crossings, park: parkNodes.length };
  _net = net;
  return net;
}

export function pedNet() { return _net; }
export function clearPedNet() { _net = null; }

// ============================================================
// COLLISION REGISTRY — Phase 4: World Traversal & Integrity
//
// Singleton registry of axis-aligned bounding boxes for solid
// world geometry.  Walk movement queries this module every frame
// to resolve penetration and produce natural sliding.
//
// Player is modelled as a vertical cylinder (radius 0.4) with
// fixed Y — collision is a 2D circle-vs-AABB problem in XZ.
//
// Bodies carry Y ranges (minY/maxY) for future use by
// stepping/height-aware logic; the current check treats all
// bodies as full-height since the camera Y is fixed.
// ============================================================

const EPSILON = 1e-6;
export const PLAYER_RADIUS = 0.4;

export class CollisionRegistry {
  constructor() {
    this.bodies = [];
  }

  /**
   * Register a collision body.
   * @param {object} b  { minX, maxX, minY, maxY, minZ, maxZ, type, tag }
   * @returns {CollisionRegistry}  this (for chaining)
   */
  registerBody(b) {
    this.bodies.push(b);
    return this;
  }

  /** Return all registered bodies. */
  getBodies() { return this.bodies; }

  /**
   * Debug / QA: find bodies whose XZ rectangle overlaps a circle.
   */
  query(cx, cz, radius) {
    const r2 = radius * radius;
    return this.bodies.filter(b => {
      const cxClamp = Math.max(b.minX, Math.min(cx, b.maxX));
      const czClamp = Math.max(b.minZ, Math.min(cz, b.maxZ));
      const dx = cx - cxClamp;
      const dz = cz - czClamp;
      return dx * dx + dz * dz < r2;
    });
  }

  /**
   * Core contact test: closest-point-on-AABB circle test.
   * Returns null if no contact, or { pen, nx, nz }.
   *   nx,nz = unit normal from the AABB's closest point toward the circle center.
   *   pen   = penetration depth (positive).
   *
   * When the circle center is directly over the closest point (dist < EPSILON),
   * falls back to an axis-aligned push toward the nearest face.
   */
  circleVsBody(cx, cz, radius, body) {
    const closestX = Math.max(body.minX, Math.min(cx, body.maxX));
    const closestZ = Math.max(body.minZ, Math.min(cz, body.maxZ));
    const dx = cx - closestX;
    const dz = cz - closestZ;
    const dist2 = dx * dx + dz * dz;

    if (dist2 >= radius * radius) return null;  // no contact

    const dist = Math.sqrt(dist2);

    if (dist < EPSILON) {
      // Circle center is at (or extremely close to) the closest point.
      // This happens when the circle center is inside the body or exactly
      // on the face/corner.  Find the nearest face and push outward.
      const oxL = cx - body.minX;
      const oxR = body.maxX - cx;
      const ozL = cz - body.minZ;
      const ozR = body.maxZ - cz;
      const overlapX = Math.min(oxL, oxR);
      const overlapZ = Math.min(ozL, ozR);

      if (overlapX < overlapZ) {
        return {
          pen: radius + overlapX,
          nx: oxL < oxR ? -1 : 1,
          nz: 0,
        };
      } else {
        return {
          pen: radius + overlapZ,
          nx: 0,
          nz: ozL < ozR ? -1 : 1,
        };
      }
    }

    const pen = radius - dist;
    const nx = dx / dist;
    const nz = dz / dist;
    return { pen, nx, nz };
  }

  /**
   * Axis-separated sweep: try X displacement first, then Z from the
   * resolved X position.  Each axis advances incrementally so the
   * circle never fully crosses a body's face — preventing the
   * closest-point normal from pointing INTO the body.
   *
   * @param {number} fromX  start X
   * @param {number} fromZ  start Z
   * @param {number} toX    desired X
   * @param {number} toZ    desired Z
   * @param {number} radius player radius
   * @returns {{ x, z, collided }}
   */
  checkMovement(fromX, fromZ, toX, toZ, radius, bodyFilter) {
    let cx = fromX;
    let cz = fromZ;
    let collided = false;
    const maxStep = radius * 0.5;   // 0.2 — same as preventTunneling
    const relevant = bodyFilter ? this.bodies.filter(bodyFilter) : this.bodies;

    // ---- X pass (incremental, starting from fromX) ----
    const dx = toX - fromX;
    if (dx !== 0) {
      const xFwd = dx > 0 ? 1 : -1;
      const xDist = Math.abs(dx);
      const xSteps = Math.ceil(xDist / maxStep);
      const stepDx = dx / xSteps;
      for (let s = 0; s < xSteps; s++) {
        const targetX = cx + stepDx;
        cx = targetX;
        for (let iter = 0; iter < 4; iter++) {
          let pushed = false;
          for (const body of relevant) {
            const c = this.circleVsBody(cx, cz, radius, body);
            if (!c) continue;
            collided = true;
            pushed = true;
            if (xFwd > 0 && c.nx < 0 && cx + c.nx * c.pen < cx) {
              cx = body.minX - radius;
            } else if (xFwd < 0 && c.nx > 0 && cx + c.nx * c.pen > cx) {
              cx = body.maxX + radius;
            } else {
              cx += c.nx * c.pen;
            }
          }
          if (!pushed) break;
        }
      }
    }

    // ---- Z pass (incremental, starting from current cz) ----
    const dz = toZ - fromZ;
    if (dz !== 0) {
      const zFwd = dz > 0 ? 1 : -1;
      const zDist = Math.abs(dz);
      const zSteps = Math.ceil(zDist / maxStep);
      const stepDz = dz / zSteps;
      for (let s = 0; s < zSteps; s++) {
        // Advance one sub-step from the last resolved position
        const targetZ = cz + stepDz;
        cz = targetZ;
        for (let iter = 0; iter < 4; iter++) {
          let pushed = false;
          for (const body of relevant) {
            const c = this.circleVsBody(cx, cz, radius, body);
            if (!c) continue;
            collided = true;
            pushed = true;
            // Clamp if the normal would push INTO the movement direction
            if (zFwd < 0 && c.nz > 0 && cz + c.nz * c.pen > cz) {
              cz = body.maxZ + radius;
            } else if (zFwd > 0 && c.nz < 0 && cz + c.nz * c.pen < cz) {
              cz = body.minZ - radius;
            } else {
              cz += c.nz * c.pen;
            }
          }
          if (!pushed) break;
        }
        // If we didn't advance at all, stop early
        if (cz === targetZ - stepDz && (zFwd > 0 ? cz >= targetZ : cz <= targetZ)) break;
      }
    }

    return { x: cx, z: cz, collided };
  }

  /**
   * Tunneling-safe movement: subdivide the displacement so no single
   * step exceeds radius * 0.5.  Steps toward the absolute target in
   * bounded increments; if a collision stalls progress (a hard wall),
   * it stops there instead of recursing — the old recursive branch could
   * never shrink its remaining displacement against a hard block and blew
   * the stack, which is what let a player pass (or hang) at a wall.
   */
  preventTunneling(fromX, fromZ, dx, dz, radius, bodyFilter) {
    const maxStep = radius * 0.5;   // 0.2 units
    const targetX = fromX + dx;
    const targetZ = fromZ + dz;
    let cx = fromX;
    let cz = fromZ;
    let collided = false;

    // Bounded loop guarantees termination even when a body is directly ahead:
    // each pass advances ≤ maxStep toward the target; if nothing advances we stop.
    for (let guard = 0; guard < 300; guard++) {
      const remX = targetX - cx;
      const remZ = targetZ - cz;
      const dist = Math.sqrt(remX * remX + remZ * remZ);
      if (dist <= 1e-4) break;

      const clamp = Math.min(1, maxStep / dist);
      const result = this.checkMovement(
        cx, cz,
        cx + remX * clamp, cz + remZ * clamp,
        radius, bodyFilter
      );
      if (result.collided) collided = true;
      if (Math.abs(result.x - cx) + Math.abs(result.z - cz) < 1e-4) break;
      cx = result.x;
      cz = result.z;
    }

    return { x: cx, z: cz, collided };
  }

  /**
   * Remove overlap from all bodies at the given position.
   * Bounded iteration (max 8) — pushes out of the deepest penetrating
   * body each iteration.
   *
   * @returns {{ x, z } | null}  the corrected position, or null if no overlap
   */
  resolveOverlap(x, z, radius) {
    let px = x, pz = z;
    let resolved = false;

    for (let iter = 0; iter < 8; iter++) {
      let bestPen = 0;
      let pushX = 0, pushZ = 0;

      for (const body of this.bodies) {
        const c = this.circleVsBody(px, pz, radius, body);
        if (!c) continue;
        if (c.pen > bestPen) {
          bestPen = c.pen;
          pushX = c.nx * c.pen;
          pushZ = c.nz * c.pen;
        }
      }

      if (bestPen <= EPSILON) break;
      resolved = true;
      px += pushX;
      pz += pushZ;
    }

    return resolved ? { x: px, z: pz } : null;
  }

  removeBody(body) {
    const idx = this.bodies.indexOf(body);
    if (idx !== -1) this.bodies.splice(idx, 1);
  }

  getDebugInfo() {
    return { count: this.bodies.length, bodies: this.bodies };
  }
}

/** Application-wide singleton. */
export const collisionRegistry = new CollisionRegistry();
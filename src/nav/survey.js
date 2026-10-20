import { sitesByRegion, siteById, registerSummary, settledSite, sites } from './places.js';
import { drawChart, drawSwatch } from './chart.js';
import { locate } from './locator.js';
import { captureAll } from './viewfinder.js';

// ============================================================
// ELYSIUM NAVIGATION — THE SURVEY
//
// Four layers, each answering exactly one question, and never
// more than one of them competing for attention:
//
//   LOCATOR   (top)     Where am I?
//   REGISTER  (left)    What worlds and sites exist?
//   WORLD     (centre)  What is Amarine, and what is on it?
//   SITE CARD (right)   What is that place, and do I want to go?
//
// The three ways into a site — its mark on the planet, its label
// on the planet, and its row in the register — all converge on
// one selection, so the globe and the list stay two views of a
// single thing rather than two parallel interfaces.
//
// PREVIEWS
// A settled place shows a PHOTOGRAPH rendered from the real
// world; an unsettled one shows a survey CHART drawn from the
// terrain model. You can photograph what has been built and only
// chart what has been scanned, and the interface says so.
//
// LAYOUT
// Panels are pinned to the outer edges and their containers are
// pointer-transparent; only controls take input. The planet keeps
// the middle of the screen, which is the calmer composition and
// also what keeps every part of the globe directly clickable.
// ============================================================

const el = {};
let hooks = {};
let selectedId = null;
let open = true;
let lastStage = null;
let shots = {};
let labelHost = null;
const labels = new Map();

/**
 * @param {object} h
 *   h.onFocus(site)     hover/keyboard preview — ease the planet to face it
 *   h.onSelect(site)    a site was selected (null when cleared)
 *   h.onDescend(site)   the player committed to entering the world
 *   h.planetFacts       [{k, v}] world-level attributes for the centre panel
 */
export function initSurvey(h) {
  hooks = h || {};
  buildLocator();
  buildRegister();
  buildWorldPanel();
  buildCard();
  buildLabels();
  setStage('orbit');
}

/** Capture the preview imagery. Must run while the surface world is visible. */
export function capturePreviews() {
  const cap = settledSite();
  if (!cap) return;
  const spec = {};
  if (cap.hero) spec[`${cap.id}:hero`] = { ...cap.hero, w: 560, h: 340 };
  for (const hl of cap.highlights) {
    spec[`${cap.id}:${hl.id}`] = { ...hl.shot, w: 224, h: 150 };
  }
  shots = captureAll(spec);
}

// ============================================================
// LOCATOR
// ============================================================

function buildLocator() {
  const host = document.getElementById('hud');
  if (!host) return;
  const line = document.createElement('div');
  line.id = 'nav-locator';
  line.innerHTML =
    `<span class="mark"></span><span class="place"></span>` +
    `<span class="sep">·</span><span class="ctx"></span>`;
  host.appendChild(line);
  const way = document.createElement('div');
  way.id = 'nav-waypoint';
  way.innerHTML =
    `<span class="wp-arrow" aria-hidden="true"></span>` +
    `<span class="wp-name"></span><span class="wp-dist"></span>` +
    `<button class="wp-drop" type="button" aria-label="Clear waypoint">×</button>`;
  host.appendChild(way);
  el.waypoint = way;
  el.wpArrow = way.querySelector('.wp-arrow');
  el.wpName = way.querySelector('.wp-name');
  el.wpDist = way.querySelector('.wp-dist');
  el.wpDrop = way.querySelector('.wp-drop');
  el.locator = line;
  el.locPlace = line.querySelector('.place');
  el.locCtx = line.querySelector('.ctx');
  el.locSep = line.querySelector('.sep');
}

let waypoint = null;

/** Guide the player toward a place without moving them to it. */
export function setWaypoint(place, onClear) {
  waypoint = place;
  if (!el.waypoint) return;
  el.waypoint.classList.toggle('is-on', !!place);
  if (place) {
    el.wpName.textContent = place.name;
    el.wpDrop.onclick = () => { setWaypoint(null); if (onClear) onClear(); };
  }
}

export function getWaypoint() { return waypoint; }

/**
 * Update the waypoint readout from the player's position and facing.
 * Arrival clears it — a guide that will not stop pointing at a place you
 * are already standing in is just clutter.
 */
function updateWaypoint(camera) {
  if (!waypoint || !el.waypoint || !camera) return;
  const dx = waypoint.at[0] - camera.position.x;
  const dz = waypoint.at[1] - camera.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 7) { setWaypoint(null); return; }
  el.wpDist.textContent = dist < 1000 ? Math.round(dist) + ' m' : '';
  // Bearing relative to where the player is looking, so the arrow points
  // the way they would have to turn.
  const fwd = Math.atan2(-dx, -dz);
  const yaw = Math.atan2(
    2 * (camera.quaternion.w * camera.quaternion.y),
    1 - 2 * (camera.quaternion.y * camera.quaternion.y)
  );
  let rel = fwd - yaw;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  el.wpArrow.style.transform = 'rotate(' + (rel * 180 / Math.PI) + 'deg)';
}

/** Called every frame while walking; only writes to the DOM on change. */
export function updateLocator(ctx) {
  if (!el.locator) return;
  const r = locate(ctx);
  const place = r.place || '';
  const context = r.context || '';
  if (el.locPlace.textContent !== place) el.locPlace.textContent = place;
  if (el.locCtx.textContent !== context) el.locCtx.textContent = context;
  el.locSep.style.display = context ? '' : 'none';
  updateWaypoint(ctx.camera);
}

// ============================================================
// REGISTER — the left rail
// ============================================================

function buildRegister() {
  const panel = document.createElement('aside');
  panel.id = 'nav-register';
  const sum = registerSummary();

  const groups = sitesByRegion().map(g => `
    <section class="reg-group">
      <h4>${g.region}</h4>
      ${g.list.map(s => `
        <button class="reg-site${s.settled ? ' is-settled' : ''}" data-id="${s.id}" type="button">
          <canvas class="reg-thumb" width="40" height="40" data-thumb="${s.id}"></canvas>
          <span class="reg-text">
            <span class="reg-name">${s.name}</span>
            <span class="reg-epithet">${s.epithet}</span>
          </span>
          <span class="reg-state"><span class="glyph"></span></span>
        </button>`).join('')}
    </section>`).join('');

  panel.innerHTML = `
    <button id="nav-reg-toggle" type="button" aria-expanded="true">
      <span class="bars" aria-hidden="true"></span>
      <span class="lbl">REGISTER</span>
    </button>
    <div class="reg-body">
      <header>
        <div class="eyebrow">AMARINE</div>
        <h3>Survey Register</h3>
        <p class="reg-meta">${sum.total} sites charted · ${sum.settled} settled</p>
        <div class="reg-bar"><span style="width:${(sum.settled / sum.total) * 100}%"></span></div>
      </header>
      <div class="reg-scroll">${groups}</div>
      <footer class="reg-foot">Select a site to preview it</footer>
    </div>`;
  document.body.appendChild(panel);
  el.register = panel;

  panel.querySelectorAll('.reg-site').forEach(btn => {
    const site = siteById(btn.dataset.id);
    btn.addEventListener('mouseenter', () => hooks.onFocus && hooks.onFocus(site));
    btn.addEventListener('focus', () => hooks.onFocus && hooks.onFocus(site));
    btn.addEventListener('click', () => select(site.id, true));
  });

  // Row thumbnails: the list has to be scannable by eye, not only readable
  // by name. Surveyed sites get a terrain swatch; the settled one gets a
  // photograph, so the place that exists looks like it.
  requestAnimationFrame(() => {
    panel.querySelectorAll('.reg-thumb').forEach(c => {
      const site = siteById(c.dataset.thumb);
      if (!site) return;
      const photo = shots[site.id + ':hero'];
      if (site.settled && photo) {
        const img = new Image();
        img.onload = () => {
          const S = c.clientWidth || 34;
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          c.width = Math.round(S * dpr);
          c.height = Math.round(S * dpr);
          const g = c.getContext('2d');
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.save();
          g.beginPath();
          g.arc(S / 2, S / 2, S / 2 - 0.5, 0, Math.PI * 2);
          g.clip();
          const k = Math.max(S / img.width, S / img.height);
          g.drawImage(img, (S - img.width * k) / 2, (S - img.height * k) / 2,
                      img.width * k, img.height * k);
          g.restore();
          g.strokeStyle = 'rgba(79,224,172,0.55)';
          g.lineWidth = 1;
          g.beginPath();
          g.arc(S / 2, S / 2, S / 2 - 0.5, 0, Math.PI * 2);
          g.stroke();
        };
        img.src = photo;
      } else {
        drawSwatch(c, site);
      }
    });
  });

  el.regToggle = panel.querySelector('#nav-reg-toggle');
  el.regToggle.addEventListener('click', () => setRegisterOpen(!open));
  setRegisterOpen(true);
}

function setRegisterOpen(v) {
  open = v;
  el.register.classList.toggle('is-open', v);
  el.regToggle.setAttribute('aria-expanded', String(v));
}

// ============================================================
// WORLD PANEL — what Amarine itself is
// ============================================================

function buildWorldPanel() {
  const facts = hooks.planetFacts || [];
  const panel = document.createElement('section');
  panel.id = 'nav-world';
  panel.innerHTML = `
    <div class="w-id">
      <h1 class="w-name">AMARINE</h1>
      <p class="w-tag">A living world · green, temperate, largely unvisited</p>
    </div>
    <ul class="w-facts">
      ${facts.map(f => `<li><span class="w-dot"></span><span>${f}</span></li>`).join('')}
    </ul>`;
  document.body.appendChild(panel);
  el.world = panel;

  const hint = document.createElement('p');
  hint.id = 'nav-hint';
  hint.textContent = 'Drag to rotate · Scroll to zoom';
  document.body.appendChild(hint);
  el.worldHint = hint;
}

// ============================================================
// GLOBE LABELS — names pinned to the planet's surface
// ============================================================

function buildLabels() {
  labelHost = document.createElement('div');
  labelHost.id = 'nav-labels';
  document.body.appendChild(labelHost);

  for (const s of sites()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'globe-label' + (s.settled ? ' is-settled' : '');
    b.dataset.id = s.id;
    b.innerHTML = `<span class="gl-pin"></span><span class="gl-name">${s.name}</span>`;
    b.addEventListener('click', e => { e.stopPropagation(); select(s.id, true); });
    b.addEventListener('mouseenter', () => hooks.onFocus && hooks.onFocus(s));
    labelHost.appendChild(b);
    labels.set(s.id, b);
  }
}

/**
 * Position the labels each frame from projected pin positions.
 * @param {Array} projected [{id, x, y, visible}]
 */
export function updateLabels(projected) {
  if (!labelHost) return;
  for (const p of projected) {
    const node = labels.get(p.id);
    if (!node) continue;
    // Unsettled labels only appear once selected: ten names over a planet is
    // a map legend, not a view of a world.
    const wanted = p.visible && (p.id === selectedId || labelIsSettled(p.id));
    node.classList.toggle('is-on', wanted);
    node.classList.toggle('is-active', p.id === selectedId);
    if (wanted) node.style.transform = `translate(-50%,-50%) translate(${p.x}px, ${p.y}px)`;
  }
}

function labelIsSettled(id) {
  const s = siteById(id);
  return !!(s && s.settled);
}

// ============================================================
// SITE CARD — the right panel
// ============================================================

function buildCard() {
  const card = document.createElement('aside');
  card.id = 'nav-card';
  card.innerHTML = `
    <button class="card-close" type="button" aria-label="Close">×</button>
    <figure class="c-hero">
      <img class="c-photo" alt="" hidden>
      <canvas class="c-chart" width="300" height="182"></canvas>
      <figcaption class="c-badge"></figcaption>
      <span class="c-kind"></span>
    </figure>
    <div class="card-body">
      <h2 class="c-name"></h2>
      <p class="c-sub"></p>
      <p class="c-blurb"></p>
      <ul class="c-pills"></ul>
      <div class="c-stats"></div>
      <button class="c-go" type="button"></button>
      <p class="c-note"></p>
      <div class="c-places">
        <h5>Featured places</h5>
        <ul class="c-place-list"></ul>
      </div>
      <dl class="c-gauges"></dl>
    </div>`;
  document.body.appendChild(card);
  el.card = card;
  el.cName = card.querySelector('.c-name');
  el.cSub = card.querySelector('.c-sub');
  el.cBadge = card.querySelector('.c-badge');
  el.cKind = card.querySelector('.c-kind');
  el.cPhoto = card.querySelector('.c-photo');
  el.cChart = card.querySelector('.c-chart');
  el.cBlurb = card.querySelector('.c-blurb');
  el.cPills = card.querySelector('.c-pills');
  el.cStats = card.querySelector('.c-stats');
  el.cGo = card.querySelector('.c-go');
  el.cNote = card.querySelector('.c-note');
  el.cPlaces = card.querySelector('.c-places');
  el.cPlaceList = card.querySelector('.c-place-list');
  el.cGauges = card.querySelector('.c-gauges');

  card.querySelector('.card-close').addEventListener('click', () => clearSelection());
  el.cGo.addEventListener('click', () => {
    const s = siteById(selectedId);
    if (s && s.settled && hooks.onDescend) hooks.onDescend(s);
  });
}

function statBlock(v, k) {
  return `<div class="c-stat"><b>${v}</b><span>${k}</span></div>`;
}

/**
 * Select a site and show its card.
 * @param {string} id
 * @param {boolean} focus  also ease the planet to face it
 */
export function select(id, focus) {
  const s = siteById(id);
  if (!s) return;
  selectedId = id;

  el.register.querySelectorAll('.reg-site').forEach(b => {
    b.classList.toggle('is-active', b.dataset.id === id);
  });

  el.cName.textContent = s.name;
  el.cSub.textContent = s.settled
    ? `${s.epithet} · ${s.region}`
    : `${s.epithet} · ${s.region}`;
  el.cBlurb.textContent = s.blurb;
  el.cBadge.textContent = s.settled ? 'PRIMARY SETTLEMENT' : 'SURVEYED FROM ORBIT';
  el.cBadge.classList.toggle('is-settled', s.settled);

  // Photograph if it exists, chart if it does not.
  const photo = shots[`${s.id}:hero`];
  if (s.settled && photo) {
    el.cPhoto.src = photo;
    el.cPhoto.hidden = false;
    el.cChart.hidden = true;
    el.cKind.textContent = 'VIEW';
  } else {
    el.cPhoto.hidden = true;
    el.cChart.hidden = false;
    el.cKind.textContent = 'CHART';
    requestAnimationFrame(() => drawChart(el.cChart, s));
  }

  el.cPills.innerHTML = s.character.map(c => `<li>${c}</li>`).join('');

  el.cStats.innerHTML = s.settled
    ? statBlock(hooks.buildingCount || '—', 'Buildings')
      + statBlock(s.highlights.length, 'Places')
      + statBlock(s.coord.split('  ')[0], 'Latitude')
    : statBlock(s.band, 'Relief')
      + statBlock(s.terrain.split(' ')[0], 'Cover')
      + statBlock(s.coord.split('  ')[0], 'Latitude');

  if (s.settled) {
    el.cGo.textContent = `Enter ${s.name}`;
    el.cGo.disabled = false;
    el.cNote.textContent = 'Arrive at survey altitude, then walk in.';
  } else {
    el.cGo.textContent = 'No landing site';
    el.cGo.disabled = true;
    el.cNote.textContent = s.lockNote;
  }

  // Featured places: the second tier of discovery. Choosing a world is only
  // half the decision; this is what tells a player the place has anything
  // in it worth the trip.
  if (s.highlights.length) {
    el.cPlaces.hidden = false;
    el.cPlaceList.innerHTML = s.highlights.map(hl => {
      const img = shots[`${s.id}:${hl.id}`];
      return `<li class="c-place">
        ${img ? `<img src="${img}" alt="">` : `<span class="c-place-blank"></span>`}
        <span class="c-place-text">
          <b>${hl.name}</b>
          <span>${hl.note}</span>
        </span>
      </li>`;
    }).join('');
  } else {
    el.cPlaces.hidden = true;
  }

  el.cGauges.innerHTML = s.gauges.map(g => `
    <div class="c-gauge">
      <dt>${g.k}</dt>
      <dd><span class="bar"><i style="width:${Math.round(g.v * 100)}%"></i></span></dd>
    </div>`).join('');

  el.card.classList.add('is-open');
  el.card.scrollTop = 0;
  const foot = el.register.querySelector('.reg-foot');
  if (foot) foot.textContent = s.settled ? 'Ready to enter' : 'Surveyed · no landing site';

  if (focus && hooks.onFocus) hooks.onFocus(s);
  if (hooks.onSelect) hooks.onSelect(s);
}

export function clearSelection() {
  selectedId = null;
  const foot = el.register && el.register.querySelector('.reg-foot');
  if (foot) foot.textContent = 'Select a site to preview it';
  el.card && el.card.classList.remove('is-open');
  el.register && el.register.querySelectorAll('.reg-site')
    .forEach(b => b.classList.remove('is-active'));
  if (hooks.onSelect) hooks.onSelect(null);
}

/** The preview image captured for one place, if there is one. */
export function previewFor(siteId, placeId) {
  return shots[siteId + ':' + placeId] || null;
}

export function hasSelection() { return !!selectedId; }
export function selectedSite() { return siteById(selectedId); }

/**
 * The navigation layer follows the stage.
 * Orbit is where choosing happens, so that is the only stage the register
 * and the world panel appear in; from the ground they would be an index of
 * places the player is not.
 */
export function setStage(stage) {
  if (stage === lastStage) return;
  lastStage = stage;
  document.body.dataset.navStage = stage;
  if (stage !== 'orbit') clearSelection();
}

/** Hide the navigation layer during camera flights. */
export function setNavBusy(busy) {
  document.body.classList.toggle('nav-busy', !!busy);
}

export function focusSettled() {
  const s = settledSite();
  if (s) select(s.id, true);
}

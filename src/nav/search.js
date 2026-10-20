import { settledSite } from './places.js';
import { previewFor } from './survey.js';

// ============================================================
// ELYSIUM NAVIGATION — PLACE SEARCH
//
// Finding a named place once you are already in the world.
//
// The register answers "which world, which settlement". This
// answers the next question down: "where is the Community Hall
// from here". It is therefore only available on the ground and
// from the survey view — in orbit the register already does the
// job better.
//
// SCOPE
// The four named places of Veridian Cap. Every other building in
// the settlement is real but anonymous, and a search that
// returned "Building 17" would be pretending to know something
// it does not.
//
// MATCHING
// Names rank above notes, and notes are only searched from two
// characters on. A single letter matched against the prose
// descriptions filters nothing at all — every note contains an
// "e" and a "t" — so one-character queries match names only,
// which is what makes the first keystroke feel like it did
// something.
// ============================================================

const el = {};
let hooks = {};
let items = [];
let results = [];
let cursor = 0;
let isOpen = false;

export function initSearch(h) {
  hooks = h || {};
  const site = settledSite();
  items = site
    ? site.highlights.map(p => ({ ...p, siteId: site.id }))
    : [];

  const host = document.createElement('div');
  host.id = 'nav-search';
  host.innerHTML = `
    <button id="ns-toggle" type="button" aria-label="Find a place" aria-expanded="false">
      <span class="ns-glass" aria-hidden="true"></span>
      <span class="ns-label">FIND A PLACE</span>
    </button>
    <div class="ns-panel" role="dialog" aria-label="Find a place">
      <div class="ns-field">
        <span class="ns-glass" aria-hidden="true"></span>
        <input id="ns-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="Search places in Veridian Cap">
        <button class="ns-clear" type="button" aria-label="Close">esc</button>
      </div>
      <ul class="ns-results" role="listbox"></ul>
      <p class="ns-empty" hidden>No place by that name.</p>
    </div>`;
  document.body.appendChild(host);

  el.host = host;
  el.toggle = host.querySelector('#ns-toggle');
  el.panel = host.querySelector('.ns-panel');
  el.input = host.querySelector('#ns-input');
  el.list = host.querySelector('.ns-results');
  el.empty = host.querySelector('.ns-empty');

  el.toggle.addEventListener('click', () => setOpen(!isOpen));
  host.querySelector('.ns-clear').addEventListener('click', () => setOpen(false));
  el.input.addEventListener('input', () => render(el.input.value));
  el.input.addEventListener('keydown', onKey);

  render('');
}

/** Rank a place against a query. Returns a score, or -1 for no match. */
function score(place, q) {
  const name = place.name.toLowerCase();
  const note = place.note.toLowerCase();
  if (name.startsWith(q)) return 0;
  // "green" should find "The Green": match any word's start, not just the first.
  if (name.split(/\s+/).some(w => w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (q.length >= 2 && note.includes(q)) return 3;
  return -1;
}

function render(raw) {
  const q = raw.trim().toLowerCase();
  results = q
    ? items
        .map(p => ({ p, s: score(p, q) }))
        .filter(r => r.s >= 0)
        .sort((a, b) => a.s - b.s || a.p.name.localeCompare(b.p.name))
        .map(r => r.p)
    // An empty query lists everything: with four places, the full list is
    // more useful than an invitation to guess at names.
    : items.slice();

  cursor = 0;
  el.empty.hidden = results.length > 0;
  el.list.innerHTML = results.map((p, i) => {
    const img = previewFor(p.siteId, p.id);
    return `<li class="ns-item${i === 0 ? ' is-cursor' : ''}" role="option" data-i="${i}">
      ${img ? `<img src="${img}" alt="">` : `<span class="ns-blank"></span>`}
      <span class="ns-text"><b>${p.name}</b><span>${p.note}</span></span>
      <span class="ns-go" aria-hidden="true"></span>
    </li>`;
  }).join('');

  el.list.querySelectorAll('.ns-item').forEach(li => {
    li.addEventListener('mouseenter', () => setCursor(+li.dataset.i));
    li.addEventListener('click', () => commit(+li.dataset.i));
  });
}

function setCursor(i) {
  cursor = Math.max(0, Math.min(results.length - 1, i));
  el.list.querySelectorAll('.ns-item').forEach(li => {
    li.classList.toggle('is-cursor', +li.dataset.i === cursor);
  });
  const active = el.list.querySelector('.ns-item.is-cursor');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(cursor + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(cursor - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); commit(cursor); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
}

function commit(i) {
  const place = results[i];
  if (!place) return;
  setOpen(false);
  if (hooks.onGo) hooks.onGo(place);
}

export function setOpen(v) {
  isOpen = v;
  el.host.classList.toggle('is-open', v);
  el.toggle.setAttribute('aria-expanded', String(v));
  if (v) {
    el.input.value = '';
    render('');
    // Focus after the panel is laid out, or the caret lands before the
    // element is focusable and the first keystroke goes to the world.
    requestAnimationFrame(() => el.input.focus());
  } else {
    el.input.blur();
  }
}

export function searchIsOpen() { return isOpen; }

/** Opened and closed by the host; search never owns a stage transition. */
export function setSearchStage(stage) {
  if (stage !== 'eagle' && stage !== 'walk') setOpen(false);
}

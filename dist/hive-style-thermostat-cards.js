/*!
 * Hive-style thermostat cards for Home Assistant
 * https://github.com/xtrendmaster/hive-style-thermostat-cards
 * MIT licence. Not affiliated with or endorsed by Hive / Centrica.
 *
 * Cards:
 *   custom:hive-temp-picker    - hold-to-scroll temperature wheel, background follows the temperature
 *   custom:hive-schedule-card  - per-day heating schedule viewer + editor (Scheduler component)
 *   write gate                 - batches temperature changes so Hive's servers don't block them
 *                                (buttons: tap_action fire-dom-event with hive_nudge / hive_set)
 */
const HSTC_VERSION = '1.6.0-beta.1';
console.info(`%c HIVE-STYLE-THERMOSTAT-CARDS %c v${HSTC_VERSION} `, 'background:#E8642E;color:#fff;font-weight:600', 'background:#4350E6;color:#fff');

// Fonts used by the cards and the example dashboard (DM Serif Display + Inter, SIL OFL).
if (!document.getElementById('hstc-fonts')) {
  const l = document.createElement('link');
  l.id = 'hstc-fonts';
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@300;400;500;600&display=swap';
  document.head.appendChild(l);
}

/* ------------------------------------------------------------------ */
/* Write gate: be gentle with cloud thermostats (Hive)                  */
/*  - waits until you stop tapping/scrolling (2 s), then sends ONE change */
/*  - never more than one change per thermostat every 10 s              */
/*  - shows a small "Setting 19.5 deg" bubble while a change is waiting  */
/* Hive's servers answer bursts of changes with HTTP 403 "Token expired  */
/* or forbidden" for a few minutes; this prevents that.                  */
/* ------------------------------------------------------------------ */
(() => {
  if (window.__hiveGate) return;
  const DEBOUNCE = 2000;
  const GAP = 10000;
  const G = { pending: {}, timers: {}, last: {}, busy: {} };
  window.__hiveGate = G;

  const root = () => document.querySelector('home-assistant');
  const hass = () => (root() ? root().hass : null);
  const toast = (message) => {
    const r = root();
    if (r) r.dispatchEvent(new CustomEvent('hass-notification', { detail: { message }, bubbles: true, composed: true }));
  };

  // ---- pending bubble ----
  const css = document.createElement('style');
  css.textContent = `
#hive-gate-bubble{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 118px);transform:translate(-50%,12px);z-index:20;
  display:flex;align-items:center;gap:10px;padding:10px 18px;border-radius:22px;background:rgba(30,30,40,.86);color:#fff;
  font:500 15px Inter,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}
#hive-gate-bubble.on{opacity:1;transform:translate(-50%,0)}
#hive-gate-bubble i{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:hgspin .8s linear infinite}
@keyframes hgspin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(css);
  let bubble = null;
  const show = (text) => {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.id = 'hive-gate-bubble';
      bubble.innerHTML = '<i></i><span></span>';
      document.body.appendChild(bubble);
    }
    bubble.querySelector('span').textContent = text;
    requestAnimationFrame(() => bubble.classList.add('on'));
  };
  const hide = () => { if (bubble && !Object.keys(G.pending).length && !Object.values(G.busy).some(Boolean)) bubble.classList.remove('on'); };

  const clamp = (entity, t) => {
    const h = hass();
    const st = h && h.states[entity];
    const lo = st ? parseFloat(st.attributes.min_temp) || 5 : 5;
    const hi = st ? parseFloat(st.attributes.max_temp) || 32 : 32;
    return Math.min(hi, Math.max(lo, Math.round(t * 2) / 2));
  };

  const flush = (entity) => {
    const v = G.pending[entity];
    if (v == null) return;
    const wait = (G.last[entity] || 0) + GAP - Date.now();
    if (wait > 0) { G.timers[entity] = setTimeout(() => flush(entity), wait); return; }
    delete G.pending[entity];
    G.last[entity] = Date.now();
    const h = hass();
    if (!h) { hide(); return; }
    const st = h.states[entity];
    const cur = st ? parseFloat(st.attributes.temperature) : NaN;
    if (v === cur) { hide(); return; }
    G.busy[entity] = true;
    h.callService('climate', 'set_temperature', { entity_id: entity, temperature: v })
      .catch((e) => toast(`Couldn't set ${v}°: ${e && e.message ? e.message : e}`))
      .finally(() => { G.busy[entity] = false; hide(); });
  };

  G.set = (entity, temp) => {
    const v = clamp(entity, temp);
    G.pending[entity] = v;
    show(`Setting ${v.toFixed(1)}°`);
    clearTimeout(G.timers[entity]);
    const wait = Math.max(DEBOUNCE, (G.last[entity] || 0) + GAP - Date.now());
    G.timers[entity] = setTimeout(() => flush(entity), wait);
  };

  G.nudge = (entity, delta) => {
    const h = hass();
    const st = h && h.states[entity];
    if (!st || st.state === 'unavailable') return;
    const base = G.pending[entity] != null ? G.pending[entity] : parseFloat(st.attributes.temperature);
    G.set(entity, (isNaN(base) ? 18 : base) + delta);
  };

  // Dashboard buttons use: tap_action: { action: fire-dom-event, hive_nudge: { entity_id, delta } }
  // If the entity id arrives un-rendered (template text), take it from the button-card that fired the event.
  const resolve = (id, e) => {
    if (id && /^[a-z_]+\.[a-z0-9_]+$/.test(id)) return id;
    for (const n of e.composedPath()) {
      const c = n && (n._config || n.config);
      if (c && typeof c.entity === 'string') return c.entity;
    }
    return null;
  };
  window.addEventListener('ll-custom', (e) => {
    const d = e.detail || {};
    if (d.hive_nudge) { const id = resolve(d.hive_nudge.entity_id, e); if (id) G.nudge(id, parseFloat(d.hive_nudge.delta) || 0); }
    if (d.hive_set) { const id = resolve(d.hive_set.entity_id, e); if (id) G.set(id, parseFloat(d.hive_set.temperature)); }
  });
  window.hiveSetTemp = G.set;
})();

/* ------------------------------------------------------------------ */
/* Appearance: Light / Dark / Auto (input_select.hive_appearance)       */
/* The cards and the dashboard use --hs-* colour variables with light   */
/* fallbacks; in dark mode they are set on the page.                    */
/* ------------------------------------------------------------------ */
(() => {
  if (window.__hsTheme || window.__hiveSignature4) return;
  window.__hsTheme = true;
  const DARK = {
    '--hs-page': '#111217', '--hs-bg2': '#111217', '--hs-card': '#1C1D24', '--hs-text': '#ECECF1', '--hs-sub': '#9C9DAA',
    '--hs-line': '#2B2C36', '--hs-pill': '#E2E5FB', '--hs-pill2': '#1C1D24', '--hs-ring': '#262A4D',
    '--hs-modebar': 'rgba(43,44,54,0.92)', '--hs-nav': 'rgba(28,29,36,0.97)', '--hs-scheme': 'dark',
  };
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let last = null;
  const apply = () => {
    const ha = document.querySelector('home-assistant');
    const s = ha && ha.hass && ha.hass.states['input_select.hive_appearance'];
    const mode = s ? s.state : 'Light';
    const dark = mode === 'Dark' || (mode === 'Auto' && !!(mq && mq.matches));
    if (dark === last) return;
    last = dark;
    const r = document.documentElement.style;
    Object.keys(DARK).forEach((k) => { if (dark) r.setProperty(k, DARK[k]); else r.removeProperty(k); });
  };
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  setInterval(apply, 1000);
  apply();
})();

/* ------------------------------------------------------------------ */
/* Shared: temperature -> colour (blue at 5 deg ... orange ... red at 30 deg) */
/* ------------------------------------------------------------------ */
const HIVE_HUE = [[5, 222], [9, 250], [13, 300], [16, 350], [18.5, 376], [22, 368], [30, 358]];
function hiveHue(t) {
  const c = Math.max(5, Math.min(30, t));
  for (let i = 0; i < HIVE_HUE.length - 1; i++) {
    const [a, ha] = HIVE_HUE[i], [b, hb] = HIVE_HUE[i + 1];
    if (c <= b) return ha + (hb - ha) * (c - a) / (b - a);
  }
  return 358;
}
function hiveGradient(t) {
  const h = hiveHue(t);
  return `linear-gradient(180deg,hsl(${(h % 360).toFixed(0)},76%,56%) 0%,hsl(${((h + 14) % 360).toFixed(0)},80%,64%) 100%)`;
}
window.hiveGradient = hiveGradient;

/* ------------------------------------------------------------------ */
/* custom:hive-temp-picker                                             */
/* ------------------------------------------------------------------ */
const ITEM_H = 133;

class HiveTempPicker extends HTMLElement {
  setConfig(c) {
    if (!c || !c.entity) throw new Error('hive-temp-picker: entity is required');
    this._c = Object.assign({ min: 5, max: 30, step: 0.5, name: '', back_path: '', insights_path: '' }, c);
    this._built = false;
    this._pending = null;
  }
  getCardSize() { return 12; }
  static getStubConfig() { return { entity: 'climate.hive_thermostat', name: 'Thermostat' }; }
  set hass(h) {
    this._hass = h;
    const st = h.states[this._c.entity];
    if (!this._built) { this._build(st); return; }
    if (!this._photoUrl) this._applyPhoto();
    const gate = window.__hiveGate;
    if (gate && gate.pending[this._c.entity] != null) return;
    if (st && !this._touching && this._pending == null) {
      const t = parseFloat(st.attributes.temperature);
      if (!isNaN(t) && t !== this._value) this._scrollTo(t, true);
    }
  }
  // Photo behind the colour: photo: <url> wins, otherwise the picture set on the entity's Area (Settings > Areas)
  _areaPicture() {
    const h = this._hass;
    if (!h || this._c.area_photo === false) return null;
    const e = h.entities && h.entities[this._c.entity];
    let a = e && e.area_id;
    if (!a && e && e.device_id && h.devices && h.devices[e.device_id]) a = h.devices[e.device_id].area_id;
    const ar = a && h.areas && h.areas[a];
    return (ar && ar.picture) || null;
  }
  _applyPhoto() {
    if (!this._phEl) return;
    const url = this._c.photo || this._areaPicture();
    if (!url || url === this._photoUrl) return;
    this._photoUrl = url;
    this._phEl.style.backgroundImage = `url("${url}")`;
    this._wrapEl.classList.add('hasph');
  }
  _vals() {
    const a = [];
    for (let v = this._c.max; v >= this._c.min - 1e-9; v -= this._c.step) a.push(Math.round(v * 2) / 2);
    return a;
  }
  _fmt(v) {
    const p = v.toFixed(1).split('.');
    return `<span class="n">${p[0]}</span><span class="s"><span class="r"></span>${p[1] !== '0' ? `<span class="d">.${p[1]}</span>` : ''}</span>`;
  }
  _build(st) {
    this._built = true;
    this._list_vals = this._vals();
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    const name = this._c.name || (st && st.attributes.friendly_name) || '';
    root.innerHTML = `
<style>
  :host { display: block; }
  .wrap { position: relative; height: 100vh; height: 100dvh; overflow: hidden; font-family: Inter, sans-serif; color: #fff; -webkit-user-select: none; user-select: none; }
  .bg { position: absolute; inset: 0; transition: background 0.2s linear; }
  .ph { position: absolute; inset: 0; background-repeat: no-repeat; background-size: cover; background-position: center; }
  .wrap.hasph .bg { opacity: 0.55; }
  .hdr { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: calc(env(safe-area-inset-top) + 10px) 16px 0; height: 64px; }
  button { all: unset; cursor: pointer; display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; }
  .back { width: 46px; height: 46px; border-radius: 50%; background: rgba(255,255,255,0.22); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.45); }
  .title { font-size: 19px; white-space: nowrap; }
  .pill { justify-self: end; display: flex; width: 84px; height: 44px; border-radius: 22px; background: rgba(255,255,255,0.22); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.45); }
  .pill button { flex: 1; }
  ha-icon { --mdc-icon-size: 22px; color: #fff; }
  .back ha-icon { --mdc-icon-size: 24px; }
  .list { position: absolute; inset: 0; z-index: 2; overflow-y: scroll; scroll-snap-type: y mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding: calc(50vh - ${ITEM_H / 2}px) 0; padding: calc(50dvh - ${ITEM_H / 2}px) 0; box-sizing: border-box; }
  .list::-webkit-scrollbar { display: none; }
  .item { height: ${ITEM_H}px; scroll-snap-align: center; display: flex; align-items: center; justify-content: center; font-family: 'DM Serif Display', serif; color: #fff; line-height: 0.8; opacity: 0.12; will-change: opacity, transform; transition: text-shadow 0.15s; }
  .item.sel { text-shadow: 0 2px 22px rgba(255,255,255,0.45), 0 1px 3px rgba(0,0,0,0.12); }
  .item.sel .r { box-shadow: 0 0 10px rgba(255,255,255,0.5); }
  .n { font-size: 86px; letter-spacing: -2px; }
  .s { display: flex; flex-direction: column; justify-content: space-between; height: 64px; margin-left: 4px; align-self: center; }
  .r { display: block; width: 15px; height: 15px; border: 3px solid #fff; border-radius: 50%; box-sizing: border-box; margin-top: -2px; }
  .d { font-size: 36px; }
</style>
<div class="wrap">
  <div class="ph"></div>
  <div class="bg"></div>
  <div class="hdr">
    <button class="back" aria-label="Back"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
    <div class="title"></div>
    <div class="pill"><button class="chart" aria-label="Insights"><ha-icon icon="mdi:chart-box-outline"></ha-icon></button><button class="gear" aria-label="Settings"><ha-icon icon="mdi:cog-outline"></ha-icon></button></div>
  </div>
  <div class="list">${this._list_vals.map((v, i) => `<div class="item" data-i="${i}">${this._fmt(v)}</div>`).join('')}</div>
</div>`;
    root.querySelector('.title').textContent = name;
    this._bg = root.querySelector('.bg');
    this._phEl = root.querySelector('.ph'); this._wrapEl = root.querySelector('.wrap'); this._applyPhoto();
    this._list = root.querySelector('.list');
    this._items = Array.from(root.querySelectorAll('.item'));
    this._list.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this._list.addEventListener('touchstart', () => { this._touching = true; this._userMoved = true; }, { passive: true });
    ['wheel', 'pointerdown', 'keydown'].forEach((ev) => this._list.addEventListener(ev, () => { this._userMoved = true; }, { passive: true }));
    this._list.addEventListener('touchend', () => { this._touching = false; }, { passive: true });
    this._items.forEach((el) => el.addEventListener('click', () => {
      this._userMoved = true;
      this._scrollTo(this._list_vals[parseInt(el.dataset.i, 10)], true);
    }));
    root.querySelector('.back').addEventListener('click', () => this._leave());
    root.querySelector('.chart').addEventListener('click', () => { if (this._c.insights_path) this._navigate(this._c.insights_path); });
    root.querySelector('.gear').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: this._c.entity }, bubbles: true, composed: true }));
    });
    const t = st ? parseFloat(st.attributes.temperature) : NaN;
    this._value = isNaN(t) ? 18.5 : t;
    requestAnimationFrame(() => requestAnimationFrame(() => { this._scrollTo(this._value, false); this._paint(); }));
  }
  connectedCallback() {
    this._userMoved = false;
    clearTimeout(this._applyT);
    this._pending = null;
    if (this._built && this._list) requestAnimationFrame(() => {
      const st = this._hass && this._hass.states[this._c.entity];
      const t = st ? parseFloat(st.attributes.temperature) : NaN;
      if (!isNaN(t)) { this._value = t; this._scrollTo(t, false); }
      this._paint();
    });
  }
  _index(v) {
    const i = Math.round((this._c.max - v) / this._c.step);
    return Math.max(0, Math.min(this._list_vals.length - 1, i));
  }
  _scrollTo(v, smooth) {
    if (this._list) this._list.scrollTo({ top: this._index(v) * ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
  }
  _onScroll() {
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = null; this._paint(); });
    clearTimeout(this._endT);
    this._endT = setTimeout(() => this._settle(), 160);
  }
  _paint() {
    if (!this._list) return;
    const f = this._list.scrollTop / ITEM_H;
    const sel = Math.round(f);
    for (let i = 0; i < this._items.length; i++) {
      const el = this._items[i];
      const d = Math.abs(i - f);
      el.classList.toggle('sel', i === sel);
      if (d > 4) { el.style.opacity = '0.1'; el.style.transform = 'scale(0.82)'; continue; }
      el.style.opacity = String(d <= 1 ? 1 - d * 0.72 : Math.max(0.1, 0.28 - (d - 1) * 0.07));
      el.style.transform = `scale(${d <= 1 ? 1.08 - d * 0.2 : Math.max(0.82, 0.88 - (d - 1) * 0.03)})`;
    }
    this._bg.style.background = hiveGradient(this._c.max - f * this._c.step);
  }
  _settle() {
    if (this._touching) { this._endT = setTimeout(() => this._settle(), 160); return; }
    // Safety: ignore scroll positions the browser set by itself (re-render, reconnect, view change)
    if (!this._userMoved) { this._paint(); return; }
    const v = this._list_vals[this._index(this._c.max - (this._list.scrollTop / ITEM_H) * this._c.step)];
    this._value = v;
    const st = this._hass && this._hass.states[this._c.entity];
    const cur = st ? parseFloat(st.attributes.temperature) : NaN;
    clearTimeout(this._applyT);
    if (isNaN(cur) || !st || st.state === 'unavailable' || st.state === 'unknown') { this._pending = null; return; }
    if (v === cur && !(window.__hiveGate && window.__hiveGate.pending[this._c.entity] != null)) { this._pending = null; return; }
    this._pending = v;
    this._applyT = setTimeout(() => this._apply(), 300);
  }
  _apply() {
    if (this._pending == null || !this._hass) return;
    const v = this._pending;
    this._pending = null;
    this._userMoved = false;
    const st = this._hass.states[this._c.entity];
    if (!st || st.state === 'unavailable' || st.state === 'unknown') return;
    if (window.__hiveGate) { window.__hiveGate.set(this._c.entity, v); return; }
    this._hass.callService('climate', 'set_temperature', { entity_id: this._c.entity, temperature: v }).catch((e) => {
      this.dispatchEvent(new CustomEvent('hass-notification', { detail: { message: `Couldn't set ${v}°: ${e && e.message ? e.message : e}` }, bubbles: true, composed: true }));
    });
  }
  _leave() {
    clearTimeout(this._applyT);
    if (this._userMoved || this._pending != null) this._apply();
    if (this._c.back_path) this._navigate(this._c.back_path); else history.back();
  }
  _navigate(path) {
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
  }
}

/* ------------------------------------------------------------------ */
/* custom:hive-schedule-card (light/dark via --hs-* CSS variables)      */
/* ------------------------------------------------------------------ */
const HS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HS_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HS_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const HS_OFF = 7;
const HS_ON = 99;   // hot water 'on' slot

function hsToMin(s, isEnd) {
  if (!s) return isEnd ? 1440 : 0;
  const p = String(s).split(':');
  const m = parseInt(p[0], 10) * 60 + parseInt(p[1] || '0', 10);
  return (isEnd && m === 0) ? 1440 : m;
}
function hsFromMin(m) {
  m = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
const hsSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HiveScheduleCard extends HTMLElement {
  static getStubConfig() { return { entity: 'climate.hive_thermostat', title: 'Thermostat' }; }
  setConfig(c) {
    this._c = Object.assign({
      entity: 'climate.hive_thermostat', title: 'Thermostat', tag: 'hive_heating',
      back_path: '/hive-heating/thermostat', edit_path: '/hive-heating/schedule-edit',
      mode_entity: 'input_boolean.hive_ha_schedule', default_temp: 18.5,
    }, c || {});
    this._day = (new Date().getDay() + 6) % 7;
    this._overlay = null;
    this._sig = '';
  }
  getCardSize() { return 12; }
  set hass(h) {
    this._hass = h;
    if (!this._root) this._init();
    const sig = this._signature();
    if (sig !== this._sig) { this._sig = sig; this._renderMain(); }
  }

  // ---------- data ----------
  _schedules() {
    const tag = this._c.tag;
    return Object.keys(this._hass.states).filter((k) => k.startsWith('switch.')).map((k) => this._hass.states[k])
      .filter((s) => Array.isArray(s.attributes.tags) && s.attributes.tags.includes(tag));
  }
  _covers(s, key) {
    const w = s.attributes.weekdays || [];
    return w.includes(key) || w.includes('daily') ||
      (w.includes('workday') && ['mon', 'tue', 'wed', 'thu', 'fri'].includes(key)) ||
      (w.includes('weekend') && (key === 'sat' || key === 'sun'));
  }
  _schedFor(di) {
    const key = HS_DAYS[(di + 7) % 7];
    const all = this._schedules().filter((s) => this._covers(s, key));
    return all.find((s) => (s.attributes.weekdays || []).length === 1) || all[0] || null;
  }
  _water() { return String(this._c.entity || '').startsWith('water_heater.'); }

  _periods(di) {
    const s = this._schedFor(di);
    if (!s) return [];
    const ts = s.attributes.timeslots || [];
    const ac = s.attributes.actions || [];
    const out = [];
    ts.forEach((t, i) => {
      const p = String(t).split(' - ');
      const a = ac.length > 1 ? ac[i] : ac[0];
      const d = (a && (a.data || a.service_data)) || {};
      if (this._water()) {
        if (d.operation_mode !== 'on') return;
        out.push({ start: hsToMin(p[0], false), end: hsToMin(p[1], true), temp: HS_ON });
        return;
      }
      const temp = parseFloat(d.temperature);
      if (d.hvac_mode === 'off' || isNaN(temp) || temp <= HS_OFF) return;
      out.push({ start: hsToMin(p[0], false), end: hsToMin(p[1], true), temp });
    });
    return out.sort((a, b) => a.start - b.start);
  }
  _signature() {
    const parts = this._schedules().map((s) => s.entity_id + JSON.stringify(s.attributes.weekdays) + JSON.stringify(s.attributes.timeslots) + JSON.stringify(s.attributes.actions) + s.state);
    const th = this._hass.states[this._c.entity];
    const md = this._hass.states[this._c.mode_entity];
    return parts.join('|') + (th ? th.state : '') + (md ? md.state : '') + this._day;
  }

  // ---------- saving ----------
  _slot(start, end, temp) {
    return {
      start: hsFromMin(start), stop: hsFromMin(end),
      conditions: [{ entity_id: this._c.mode_entity, value: 'on', match_type: 'is' }],
      condition_type: 'and', track_conditions: true,
      actions: this._water()
        ? [{ service: 'water_heater.set_operation_mode', entity_id: this._c.entity, service_data: { operation_mode: temp > HS_OFF ? 'on' : 'off' } }]
        : [{ service: 'climate.set_temperature', entity_id: this._c.entity, service_data: { temperature: temp, hvac_mode: 'heat' } }],
    };
  }
  _buildTimeslots(periods) {
    const ps = periods.slice().sort((a, b) => a.start - b.start);
    const out = [];
    let cur = 0;
    ps.forEach((p) => {
      if (p.start > cur) out.push(this._slot(cur, p.start, HS_OFF));
      out.push(this._slot(p.start, p.end, p.temp));
      cur = p.end;
    });
    if (cur < 1440) out.push(this._slot(cur, 1440, HS_OFF));
    if (!out.length) out.push(this._slot(0, 1439, HS_OFF));
    return out;
  }
  async _saveDay(di, periods) {
    const key = HS_DAYS[di];
    const s = this._schedFor(di);
    const timeslots = this._buildTimeslots(periods);
    if (s && (s.attributes.weekdays || []).length === 1 && s.attributes.weekdays[0] === key) {
      await this._hass.callService('scheduler', 'edit', { entity_id: s.entity_id, timeslots });
      return;
    }
    if (s) {
      // shared schedule (e.g. Tue-Fri): take this day out of it, then give the day its own schedule
      let w = (s.attributes.weekdays || []).slice();
      if (w.includes('daily')) w = HS_DAYS.slice();
      if (w.includes('workday')) w = w.filter((x) => x !== 'workday').concat(['mon', 'tue', 'wed', 'thu', 'fri']);
      if (w.includes('weekend')) w = w.filter((x) => x !== 'weekend').concat(['sat', 'sun']);
      w = w.filter((x) => x !== key);
      if (w.length) await this._hass.callService('scheduler', 'edit', { entity_id: s.entity_id, weekdays: w });
      else await this._hass.callService('scheduler', 'remove', { entity_id: s.entity_id });
    }
    await this._hass.callService('scheduler', 'add', { name: `${this._water() ? 'Hot water' : 'Heating'} ${HS_NAMES[di]}`, weekdays: [key], repeat_type: 'repeat', tags: [this._c.tag], timeslots });
  }
  _toast(msg) {
    this.dispatchEvent(new CustomEvent('hass-notification', { detail: { message: msg }, bubbles: true, composed: true }));
  }
  _navigate(path) {
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
  }

  // ---------- rendering ----------
  _init() {
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `
<style>
  :host { display: block; color-scheme: var(--hs-scheme, light); }
  * { box-sizing: border-box; }
  .page { position: relative; min-height: 100vh; min-height: 100dvh; background: var(--hs-bg2, #fff); font-family: Inter, sans-serif; color: var(--hs-text, #2F2F33); padding-bottom: 120px; -webkit-user-select: none; user-select: none; }
  button { all: unset; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .hdr { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: calc(env(safe-area-inset-top) + 10px) 20px 0; height: calc(env(safe-area-inset-top) + 74px); }
  .round { width: 46px; height: 46px; border-radius: 50%; background: var(--hs-card, #fff); box-shadow: 0 2px 8px rgba(0,0,0,0.10), inset 0 0 0 1px var(--hs-line, #ECECF0); display: flex; align-items: center; justify-content: center; }
  .round ha-icon { --mdc-icon-size: 24px; color: var(--hs-text, #2F2F33); }
  .title { font-size: 19px; white-space: nowrap; }
  .right { justify-self: end; }
  .status { padding: 14px 20px 18px; font-size: 15px; }
  .days { background: var(--hs-pill2, #F2F3FB); display: grid; grid-template-columns: repeat(7, 1fr); padding: 12px 8px; }
  .day { width: 40px; height: 40px; border-radius: 50%; margin: 0 auto; display: flex; align-items: center; justify-content: center; font-size: 18px; }
  .day.sel { background: #4350E6; color: #fff; }
  .day.today:not(.sel) { box-shadow: inset 0 0 0 1.5px #4350E6; color: #4350E6; }
  .list { padding: 16px 22px; }
  .row { display: flex; align-items: center; gap: 26px; padding: 12px 0; width: 100%; }
  .circ { width: 56px; height: 56px; flex: none; border-radius: 50%; border: 3px solid #7B80EA; display: flex; align-items: center; justify-content: center; font-size: 17px; }
  .circ.on { border-color: #E8642E; font-size: 15px; }
  .time { font-size: 19px; }
  .empty { padding: 30px 4px; color: var(--hs-sub, #66666B); font-size: 16px; line-height: 1.5; }
  .fab { position: fixed; right: 22px; bottom: calc(env(safe-area-inset-bottom) + 34px); width: 56px; height: 56px; border-radius: 50%; background: #4350E6; box-shadow: 0 0 0 6px var(--hs-ring, #E5E7FB); display: flex; align-items: center; justify-content: center; z-index: 5; }
  .fab ha-icon { --mdc-icon-size: 26px; color: #fff; }
  .ov { position: fixed; inset: 0; z-index: 20; background: var(--hs-bg2, #fff); display: flex; flex-direction: column; font-family: Inter, sans-serif; color: var(--hs-text, #2F2F33); }
  .ov .body { padding: 8px 20px; flex: 1; overflow-y: auto; }
  .box { border-radius: 18px; background: var(--hs-card, #fff); box-shadow: 0 1px 10px rgba(40,40,80,0.08); overflow: hidden; }
  .field { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; height: 64px; font-size: 18px; }
  .sep { height: 2px; background: var(--hs-line, #F0F0F3); }
  .field input, .field select { -webkit-appearance: none; appearance: none; border: none; background: transparent; color: #4350E6; font: inherit; font-size: 18px; text-align: right; direction: rtl; min-width: 90px; outline: none; }
  .field input::-webkit-date-and-time-value { text-align: right; }
  .err { color: #D9342B; font-size: 14px; padding: 12px 4px; min-height: 20px; }
  .done { margin: 0 24px calc(env(safe-area-inset-bottom) + 24px); height: 54px; border-radius: 14px; background: var(--hs-line, #F6F6F8); color: var(--hs-sub, #A0A0A6); display: flex; align-items: center; justify-content: center; font-size: 19px; }
  .done.ready { background: #4350E6; color: #fff; }
  .sheetbg { position: fixed; inset: 0; z-index: 15; background: rgba(0,0,0,0.25); }
  .sheet { position: fixed; left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom) + 12px); z-index: 16; background: var(--hs-card, #fff); border-radius: 20px; overflow: hidden; font-family: Inter, sans-serif; }
  .opt { display: flex; align-items: center; gap: 14px; padding: 18px 20px; font-size: 17px; color: var(--hs-text, #2F2F33); border-bottom: 1px solid var(--hs-line, #F0F0F3); width: 100%; }
  .opt ha-icon { --mdc-icon-size: 22px; color: #4350E6; }
  .opt.cancel { justify-content: center; color: var(--hs-sub, #66666B); border-bottom: none; }
  .chk { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; height: 56px; font-size: 18px; width: 100%; }
  .tick { width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--hs-sub, #C9CAD6); display: flex; align-items: center; justify-content: center; }
  .tick.on { background: #4350E6; border-color: #4350E6; }
  .tick ha-icon { --mdc-icon-size: 18px; color: #fff; }
</style>
<div class="page">
  <div class="hdr"><button class="round back"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="title"></div><div></div></div>
  <div class="status"></div>
  <div class="days"></div>
  <div class="list"></div>
  <button class="fab"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>
</div>
<div class="layer"></div>`;
    this._root.querySelector('.title').textContent = this._c.title;
    this._root.querySelector('.back').addEventListener('click', () => this._navigate(this._c.back_path));
    this._root.querySelector('.fab').addEventListener('click', () => this._openMenu());
    this._layer = this._root.querySelector('.layer');
  }

  _rows(di) {
    const ps = this._periods(di);
    if (!ps.length) return [];
    const next = this._periods(di + 1);
    const rows = [];
    ps.forEach((p, i) => {
      rows.push({ on: true, idx: i, start: p.start, end: p.end, temp: p.temp, label: `${hsFromMin(p.start)} - ${p.end === 1440 ? '00:00' : hsFromMin(p.end)}` });
      const nxt = ps[i + 1];
      if (nxt) {
        if (nxt.start > p.end) rows.push({ on: false, start: p.end, end: nxt.start, label: `${hsFromMin(p.end)} - ${hsFromMin(nxt.start)}` });
      } else if (p.end < 1440) {
        const nd = (di + 1) % 7;
        const ne = next.length ? next[0].start : 0;
        const lbl = next.length ? `${hsFromMin(ne)} (${HS_SHORT[nd]})` : '00:00';
        rows.push({ on: false, start: p.end, end: 1440, label: `${hsFromMin(p.end)} - ${lbl}` });
      }
    });
    return rows;
  }

  _renderMain() {
    if (!this._root) return;
    const th = this._hass.states[this._c.entity];
    const md = this._hass.states[this._c.mode_entity];
    let status = 'Manual mode – schedule paused';
    if (this._water()) {
      status = md && md.state === 'on' ? 'Hot water schedule is active'
        : (th && th.state === 'eco' ? 'Hive is running its own hot water schedule' : 'Hot water schedule paused');
    } else if (md && md.state === 'on' && th && th.state === 'heat') status = 'Heating schedule is active';
    else if (th && th.state === 'off') status = 'Heating is off – schedule paused';
    else if (th && th.state === 'auto') status = 'Hive is running its own schedule';
    this._root.querySelector('.status').textContent = status;
    const today = (new Date().getDay() + 6) % 7;
    const days = this._root.querySelector('.days');
    days.innerHTML = HS_LETTERS.map((l, i) => `<button class="day${i === this._day ? ' sel' : ''}${i === today ? ' today' : ''}" data-d="${i}">${l}</button>`).join('');
    days.querySelectorAll('.day').forEach((b) => b.addEventListener('click', () => { this._day = parseInt(b.dataset.d, 10); this._sig = ''; this._renderMain(); }));
    const rows = this._rows(this._day);
    const list = this._root.querySelector('.list');
    if (!rows.length) {
      list.innerHTML = this._water() ? `<div class="empty">No hot water on ${HS_NAMES[this._day]}.<br>Tap <b>•••</b> to add a hot water period.</div>` : `<div class="empty">No heating on ${HS_NAMES[this._day]}.<br>Tap <b>•••</b> to add a heating period.</div>`;
      return;
    }
    list.innerHTML = rows.map((r, i) => `<button class="row" data-r="${i}"><div class="circ${r.on ? ' on' : ''}">${r.on ? (this._water() ? 'On' : r.temp.toFixed(1) + '°') : 'Off'}</div><div class="time">${r.label}</div></button>`).join('');
    list.querySelectorAll('.row').forEach((b) => b.addEventListener('click', () => {
      const r = rows[parseInt(b.dataset.r, 10)];
      if (r.on) this._openEditor(this._day, r.idx);
      else {
        const s = r.start, e = Math.min(r.end, s + 120);
        this._openEditor(this._day, -1, { start: s, end: e, temp: this._water() ? HS_ON : this._c.default_temp });
      }
    }));
  }

  _closeLayer() { this._layer.innerHTML = ''; this._sig = ''; this._renderMain(); }

  _tempOptions(sel) {
    let o = '';
    for (let t = 5; t <= 30.001; t += 0.5) {
      const v = (Math.round(t * 2) / 2).toFixed(1);
      o += `<option value="${v}"${Math.abs(parseFloat(v) - sel) < 0.01 ? ' selected' : ''}>${v}°</option>`;
    }
    return o;
  }

  _openEditor(di, idx, preset) {
    const periods = this._periods(di);
    const isNew = idx < 0;
    const p = isNew ? preset : periods[idx];
    const orig = { start: p.start, end: p.end, temp: p.temp };
    this._layer.innerHTML = `
<div class="ov">
  <div class="hdr"><button class="round x-back"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="title">${HS_NAMES[di]}</div>${isNew ? '<div></div>' : '<button class="round right x-del"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>'}</div>
  <div class="body">
    <div class="box">
      <label class="field"><span>Start Time</span><input class="x-start" type="time" step="60" value="${hsFromMin(p.start)}"></label>
      <label class="field"><span>End Time</span><input class="x-end" type="time" step="60" value="${hsFromMin(p.end)}"></label>
      ${this._water() ? `<input class="x-temp" type="hidden" value="${HS_ON}">` : `<div class="sep"></div>
      <label class="field"><span>Temperature</span><select class="x-temp">${this._tempOptions(p.temp)}</select></label>`}
    </div>
    <div class="err"></div>
  </div>
  <button class="done${isNew ? ' ready' : ''}">${isNew ? 'Add' : 'Done'}</button>
</div>`;
    const q = (s) => this._layer.querySelector(s);
    const read = () => ({ start: hsToMin(q('.x-start').value, false), end: hsToMin(q('.x-end').value, true), temp: parseFloat(q('.x-temp').value) });
    const changed = () => { const v = read(); return isNew || v.start !== orig.start || v.end !== orig.end || v.temp !== orig.temp; };
    const upd = () => q('.done').classList.toggle('ready', changed());
    ['.x-start', '.x-end', '.x-temp'].forEach((s) => { q(s).addEventListener('input', upd); q(s).addEventListener('change', upd); });
    q('.x-back').addEventListener('click', () => this._closeLayer());
    if (!isNew) q('.x-del').addEventListener('click', async () => {
      const rest = periods.filter((_, i) => i !== idx);
      try { await this._saveDay(di, rest); this._closeLayer(); } catch (e) { q('.err').textContent = `Couldn't save: ${e.message || e}`; }
    });
    q('.done').addEventListener('click', async () => {
      if (!changed()) { this._closeLayer(); return; }
      const v = read();
      if (!(v.end > v.start)) { q('.err').textContent = 'End time must be after the start time.'; return; }
      const others = periods.filter((_, i) => i !== idx);
      const clash = others.find((o) => v.start < o.end && v.end > o.start);
      if (clash) { q('.err').textContent = `Overlaps ${hsFromMin(clash.start)} - ${clash.end === 1440 ? '00:00' : hsFromMin(clash.end)}. Change the times or delete that period first.`; return; }
      q('.done').textContent = 'Saving…';
      try { await this._saveDay(di, others.concat([v])); this._closeLayer(); }
      catch (e) { q('.done').textContent = isNew ? 'Add' : 'Done'; q('.err').textContent = `Couldn't save: ${e.message || e}`; }
    });
  }

  _openMenu() {
    const di = this._day;
    this._layer.innerHTML = `
<div class="sheetbg"></div>
<div class="sheet">
  <button class="opt o-add"><ha-icon icon="mdi:plus-circle-outline"></ha-icon>Add ${this._water() ? 'hot water' : 'heating'} period</button>
  <button class="opt o-copy"><ha-icon icon="mdi:content-copy"></ha-icon>Copy ${HS_NAMES[di]} to other days</button>
  ${this._c.edit_path ? '<button class="opt o-adv"><ha-icon icon="mdi:tune-variant"></ha-icon>Advanced editor</button>' : ''}
  <button class="opt cancel o-cancel">Cancel</button>
</div>`;
    const q = (s) => this._layer.querySelector(s);
    q('.sheetbg').addEventListener('click', () => this._closeLayer());
    q('.o-cancel').addEventListener('click', () => this._closeLayer());
    if (q('.o-adv')) q('.o-adv').addEventListener('click', () => { this._layer.innerHTML = ''; this._navigate(this._c.edit_path); });
    q('.o-add').addEventListener('click', () => {
      const ps = this._periods(di);
      let s = 18 * 60;
      for (let c = 6 * 60; c < 22 * 60; c += 30) { if (!ps.find((p) => c < p.end && c + 60 > p.start)) { s = c; break; } }
      this._openEditor(di, -1, { start: s, end: Math.min(s + 120, 1440), temp: this._water() ? HS_ON : this._c.default_temp });
    });
    q('.o-copy').addEventListener('click', () => this._openCopy(di));
  }

  _openCopy(di) {
    const sel = new Set();
    const draw = () => {
      this._layer.innerHTML = `
<div class="ov">
  <div class="hdr"><button class="round x-back"><ha-icon icon="mdi:chevron-left"></ha-icon></button><div class="title">Copy ${HS_NAMES[di]}</div><div></div></div>
  <div class="body"><div class="box">${HS_NAMES.map((n, i) => i === di ? '' : `<button class="chk" data-d="${i}"><span>${n}</span><span class="tick${sel.has(i) ? ' on' : ''}">${sel.has(i) ? '<ha-icon icon="mdi:check"></ha-icon>' : ''}</span></button>`).join('<div class="sep"></div>').replace(/^<div class="sep"><\/div>|<div class="sep"><\/div>(?=<div class="sep">)/g, '')}</div><div class="err"></div></div>
  <button class="done${sel.size ? ' ready' : ''}">Copy to ${sel.size} day${sel.size === 1 ? '' : 's'}</button>
</div>`;
      const q = (s) => this._layer.querySelector(s);
      q('.x-back').addEventListener('click', () => this._closeLayer());
      this._layer.querySelectorAll('.chk').forEach((b) => b.addEventListener('click', () => { const d = parseInt(b.dataset.d, 10); if (sel.has(d)) sel.delete(d); else sel.add(d); draw(); }));
      q('.done').addEventListener('click', async () => {
        if (!sel.size) return;
        const src = this._periods(di);
        q('.done').textContent = 'Copying…';
        try {
          for (const d of Array.from(sel).sort()) {
            await this._saveDay(d, src);
            await hsSleep(900);
          }
          this._closeLayer();
        } catch (e) { q('.err').textContent = `Couldn't copy: ${e.message || e}`; }
      });
    };
    draw();
  }
}

/* ------------------------------------------------------------------ */
/* custom:hive-setup-card                                              */
/*  Pick the thermostat, hot water and radiator valves from lists;     */
/*  it creates the helpers, timers and scripts and builds the whole    */
/*  heating dashboard (one page per radiator). No YAML to edit.        */
/* ------------------------------------------------------------------ */
const HS_DASHBOARD = {"button_card_templates":{"hive_advance":{"icon":"mdi:chevron-double-right","name":"Advance to next","styles":{"card":[{"opacity":"[[[ return entity.state==='on' ? '1' : '0.45' ]]]"}]},"tap_action":{"action":"perform-action","perform_action":"script.hive_advance_to_next"},"template":"hive_pill_link"},"hive_arrow_down":{"icon":"mdi:menu-down","tap_action":{"action":"fire-dom-event","hive_nudge":{"entity_id":"[[[ return entity.entity_id ]]]","delta":-0.5},"haptic":"light"},"template":"hive_arrow_up"},"hive_arrow_up":{"icon":"mdi:menu-up","show_icon":true,"styles":{"card":[{"width":"90px"},{"height":"56px"},{"visibility":"[[[ return entity.state==='off' ? 'hidden' : 'visible' ]]]"}],"icon":[{"width":"64px"},{"color":"rgba(255,255,255,0.5)"}]},"tap_action":{"action":"fire-dom-event","hive_nudge":{"entity_id":"[[[ return entity.entity_id ]]]","delta":0.5},"haptic":"light"},"template":"hive_clear"},"hive_away":{"custom_fields":{"k":"[[[ return `<div style='width:28px;height:28px;border-radius:50%;background:#FFFFFF;box-shadow:0 1px 4px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center'><ha-icon icon='mdi:walk' style='--mdc-icon-size:17px;color:#333'></ha-icon></div>`; ]]]"},"styles":{"card":[{"width":"56px"},{"height":"32px"},{"border-radius":"16px"},{"overflow":"visible"},{"background":"[[[ return entity.state==='on' ? '#4350E6' : 'var(--hs-line,#E7E7EC)' ]]]"},{"box-shadow":"inset 0 0 0 1px rgba(128,128,140,0.35)"}],"custom_fields":{"k":[{"position":"absolute"},{"top":"2px"},{"left":"[[[ return entity.state==='on' ? '26px' : '2px' ]]]"},{"transition":"left 0.2s ease"}]},"grid":[{"grid-template-areas":"\"k\""},{"grid-template-columns":"1fr"}]},"tap_action":{"action":"toggle"},"template":"hive_clear"},"hive_back":{"icon":"mdi:chevron-left","show_icon":true,"styles":{"card":[{"width":"46px"},{"height":"46px"},{"border-radius":"50%"},{"background":"rgba(255,255,255,0.22)"},{"box-shadow":"inset 0 0 0 1.5px rgba(255,255,255,0.45)"}],"icon":[{"width":"24px"},{"color":"#FFFFFF"}]},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/home"},"template":"hive_clear"},"hive_back_dark":{"icon":"mdi:chevron-left","show_icon":true,"styles":{"card":[{"width":"46px"},{"height":"46px"},{"border-radius":"50%"},{"background":"var(--hs-card,#FFFFFF)"},{"box-shadow":"0 2px 8px rgba(0,0,0,0.10), inset 0 0 0 1px var(--hs-line,#ECECF0)"}],"icon":[{"width":"24px"},{"color":"var(--hs-text,#2F2F33)"}]},"template":"hive_clear"},"hive_boost_big":{"icon":"mdi:bullseye","name":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+eid.split('.')[1]]; const boost=bs?!!(states[bs]&&states[bs].state==='on'):(tm?tm.state==='active':entity.attributes.preset_mode==='boost'); return boost?'Boosting \u00b7 tap to stop':'Boost'; ]]]","show_icon":true,"show_name":true,"styles":{"card":[{"padding":"6px 10px"},{"border-radius":"18px"},{"background":"none !important"},{"background-color":"transparent !important"},{"backdrop-filter":"none !important"},{"-webkit-backdrop-filter":"none !important"},{"box-shadow":"none !important"}],"icon":[{"width":"34px"},{"color":"#FFFFFF"}],"name":[{"font-size":"17px"},{"color":"#FFFFFF"},{"padding-top":"8px"}]},"tap_action":{"action":"perform-action","data":{"entity_id":"entity"},"perform_action":"script.hive_boost"},"template":"hive_clear","triggers_update":["binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost","timer.boost_study_radiator"],"extra_styles":"ha-card, ha-card::before, ha-card::after { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_boost_pill":{"icon":"mdi:bullseye","layout":"icon_name","name":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+eid.split('.')[1]]; const boost=bs?!!(states[bs]&&states[bs].state==='on'):(tm?tm.state==='active':entity.attributes.preset_mode==='boost'); return boost?'Boosting':'Boost'; ]]]","show_icon":true,"show_name":true,"styles":{"card":[{"width":"122px"},{"height":"44px"},{"border-radius":"14px"},{"padding":"0 12px"},{"background":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+eid.split('.')[1]]; const boost=bs?!!(states[bs]&&states[bs].state==='on'):(tm?tm.state==='active':entity.attributes.preset_mode==='boost'); return boost?'#4350E6':'var(--hs-pill,#EEF0FD)'; ]]]"}],"grid":[{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"8px"}],"icon":[{"width":"22px"},{"color":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+eid.split('.')[1]]; const boost=bs?!!(states[bs]&&states[bs].state==='on'):(tm?tm.state==='active':entity.attributes.preset_mode==='boost'); return boost?'#FFFFFF':'#4350E6'; ]]]"}],"name":[{"font-size":"17px"},{"color":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+eid.split('.')[1]]; const boost=bs?!!(states[bs]&&states[bs].state==='on'):(tm?tm.state==='active':entity.attributes.preset_mode==='boost'); return boost?'#FFFFFF':'#4350E6'; ]]]"}]},"tap_action":{"action":"perform-action","data":{"entity_id":"entity"},"perform_action":"script.hive_boost"},"template":"hive_clear","triggers_update":["binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost","timer.boost_study_radiator"]},"hive_clear":{"hold_action":{"action":"none"},"show_icon":false,"show_label":false,"show_name":false,"show_state":false,"styles":{"card":[{"background":"none"},{"box-shadow":"none"},{"border":"none"},{"border-radius":"0"},{"padding":"0"},{"font-family":"Inter, sans-serif"},{"--ha-ripple-color":"transparent"},{"--ha-ripple-hover-opacity":"0"},{"--ha-ripple-pressed-opacity":"0"},{"-webkit-tap-highlight-color":"transparent"},{"backdrop-filter":"none"},{"-webkit-backdrop-filter":"none"},{"--ha-card-background":"transparent"},{"--card-background-color":"transparent"},{"--ha-card-backdrop-filter":"none"},{"--ha-card-border-width":"0"}]},"tap_action":{"action":"none"}},"hive_day":{"show_name":true,"styles":{"card":[{"height":"40px"},{"width":"40px"},{"border-radius":"50%"},{"margin":"0 auto"},{"background":"[[[ return entity.state===variables.day ? '#4350E6' : 'transparent' ]]]"}],"name":[{"font-size":"18px"},{"color":"[[[ return entity.state===variables.day ? '#FFFFFF' : 'var(--hs-text,#2F2F33)' ]]]"}]},"template":"hive_clear"},"hive_detail":{"custom_fields":{"home":"[[[ if (entity.entity_id.startsWith('water_heater.')) return ''; const findBatt = (eid, override) => { if (override) return override; const e = hass.entities && hass.entities[eid]; if (!e || !e.device_id) return null; for (const x of Object.values(hass.entities)) { if (x.device_id === e.device_id) { const s = states[x.entity_id]; if (s && s.attributes.device_class === 'battery' && !isNaN(parseFloat(s.state))) return x.entity_id; } } return null; }; const c = parseFloat(entity.attributes.current_temperature); const bid = findBatt(entity.entity_id, variables.battery); const b = bid && states[bid] ? parseFloat(states[bid].state) : NaN; let bh = ''; if (!isNaN(b)) { const r = Math.round(b); const lvl = Math.min(100, Math.max(10, Math.round(r / 10) * 10)); const ic = r < 15 ? 'mdi:battery-alert-variant-outline' : (lvl === 100 ? 'mdi:battery' : 'mdi:battery-' + lvl); const col = r < 15 ? '#FFB3AD' : '#FFFFFF'; bh = `<span style='opacity:.45;margin:0 4px'>\u00b7</span><ha-icon icon='${ic}' style='--mdc-icon-size:20px;color:${col}'></ha-icon><span style='font-size:16px;color:${col}'>${r}%</span>`; } return `<div style='display:inline-flex;align-items:center;gap:8px;white-space:nowrap;color:#FFFFFF;font-size:19px'><ha-icon icon='mdi:home-outline' style='--mdc-icon-size:24px'></ha-icon>${isNaN(c) ? '--' : c.toFixed(1)}\u00b0${bh}</div>`; ]]]","num":"[[[ const eid=entity.entity_id; const st=entity.state; const big=(x)=>`<div style='font-family:DM Serif Display,serif;color:#FFFFFF;font-size:96px;line-height:1;letter-spacing:-2px'>${x}</div>`; if(eid.startsWith('water_heater.')){ const hw=states['binary_sensor.hive_hot_water_state']; return big(st==='off'?'Off':((hw&&hw.state==='on')?'On':'Off')); } const t=parseFloat(entity.attributes.temperature); if(st==='off'||isNaN(t)) return big('Off'); const p=t.toFixed(1).split('.'); return `<div style='display:flex;align-items:flex-start;font-family:DM Serif Display,serif;color:#FFFFFF;line-height:0.8'><span style='font-size:112px;letter-spacing:-3px'>${p[0]}</span><span style='display:flex;flex-direction:column;justify-content:space-between;height:84px;margin-left:4px'><span style='display:block;width:19px;height:19px;border:4px solid #FFFFFF;border-radius:50%;box-sizing:border-box;margin-top:-4px'></span><span style='font-size:46px'>.${p[1]}</span></span></div>`; ]]]","ruler":"[[[ const st=entity.state; if(entity.entity_id.startsWith('water_heater.')||st==='off') return ''; const t=parseFloat(entity.attributes.temperature); const cur=parseFloat(entity.attributes.current_temperature); if(isNaN(t)) return ''; const house=isNaN(cur)?null:Math.round(cur*2)/2; const step=47, mid=235; const dash=`<div style='width:13px;height:3px;border-radius:2px;background:rgba(255,255,255,0.55)'></div>`; let h=''; for(let i=-5;i<=5;i++){ const v=Math.round((t+i*0.5)*2)/2; const y=mid-i*step; let el; if(i===0) el=`<div style='width:58px;height:5px;border-radius:3px;background:var(--hs-card,#FFFFFF)'></div>`; else if(house!==null&&v===house) el=`<div style='display:flex;align-items:center;gap:6px'>${dash}<ha-icon icon='mdi:home' style='--mdc-icon-size:22px;color:rgba(255,255,255,0.7)'></ha-icon></div>`; else if(Math.abs((v%1)-0.5)<0.01) el=`<div style='font-size:20px;font-weight:600;letter-spacing:-0.3px;color:rgba(255,255,255,0.72)'>${v.toFixed(1)}\u00b0</div>`; else el=dash; h+=`<div style='position:absolute;left:0;top:${y}px;transform:translateY(-50%);display:flex;align-items:center'>${el}</div>`; } return `<div style='position:relative;height:${mid*2}px;width:100%;-webkit-mask-image:linear-gradient(transparent 0%,#000 14%,#000 86%,transparent 100%);mask-image:linear-gradient(transparent 0%,#000 14%,#000 86%,transparent 100%)'>${h}</div>`; ]]]","title":"[[[ return `<div style='font-size:19px;color:#FFFFFF;white-space:nowrap'>${variables.name||entity.attributes.friendly_name}</div>`; ]]]"},"hold_action":{"action":"none"},"show_icon":false,"show_name":false,"show_state":false,"styles":{"card":[{"min-height":"100vh"},{"border-radius":"0"},{"border":"none"},{"box-shadow":"none"},{"padding":"calc(env(safe-area-inset-top) + 10px) 16px 40px"},{"font-family":"Inter, sans-serif"},{"background":"[[[ const st=entity.state; const ph=variables.bg_photo; const a=ph?0.55:1; const ga=ph?0.6:1; const grey=`linear-gradient(180deg,rgba(142,151,172,${ga}) 0%,rgba(186,193,207,${ga}) 100%)`; let g; if(entity.entity_id.startsWith('water_heater.')) g = st==='off'?grey:'linear-gradient(180deg,#3E7FE0 0%,#5E9EEC 55%,#7DB7F2 100%)'; else if(st==='off') g = grey; else { const t=parseFloat(entity.attributes.temperature); const H=[[5,222],[9,250],[13,300],[16,350],[18.5,376],[22,368],[30,358]]; const c=Math.max(5,Math.min(30,isNaN(t)?18.5:t)); let h=358; for(let i=0;i<H.length-1;i++){ if(c<=H[i+1][0]){ h=H[i][1]+(H[i+1][1]-H[i][1])*(c-H[i][0])/(H[i+1][0]-H[i][0]); break; } } g=`linear-gradient(180deg,hsla(${(h%360).toFixed(0)},76%,56%,${a}) 0%,hsla(${((h+14)%360).toFixed(0)},80%,64%,${a}) 100%)`; } return ph ? `${g}, url(\"${ph}\")` : g; ]]]"},{"transition":"background 0.4s ease"},{"background-repeat":"no-repeat"},{"background-size":"[[[ return variables.bg_photo ? (variables.bg_pan ? '100% 100%, auto 100%' : '100% 100%, cover') : 'auto'; ]]]"},{"animation":"[[[ return (variables.bg_photo && variables.bg_pan) ? `hive-pan ${variables.bg_pan}s ease-in-out infinite alternate` : 'none'; ]]]"},{"background-position":"[[[ return variables.bg_photo ? '0 0, center' : 'center'; ]]]"}],"custom_fields":{"actions":[{"margin":"22px 18px 0"}],"back":[{"justify-self":"start"}],"boost":[{"align-self":"center"},{"justify-self":"center"}],"down":[{"align-self":"start"},{"justify-self":"center"}],"home":[{"margin-top":"22px"},{"justify-self":"center"}],"modes":[{"margin":"20px 8px 0"},{"background":"var(--hs-modebar,#F1F2FB)"},{"border-radius":"24px"},{"padding":"4px"}],"num":[{"align-self":"center"},{"justify-self":"center"}],"ruler":[{"align-self":"start"},{"justify-self":"stretch"},{"height":"470px"}],"title":[{"justify-self":"center"}],"tools":[{"justify-self":"end"},{"width":"84px"},{"background":"rgba(255,255,255,0.22)"},{"border-radius":"22px"},{"box-shadow":"inset 0 0 0 1.5px rgba(255,255,255,0.45)"},{"padding":"3px 4px"}],"up":[{"align-self":"end"},{"justify-self":"center"}]},"grid":[{"grid-template-areas":"\"back title tools\" \"ruler up .\" \"ruler num .\" \"ruler down .\" \"ruler boost .\" \"home home home\" \"modes modes modes\" \"actions actions actions\""},{"grid-template-columns":"1fr auto 1fr"},{"grid-template-rows":"64px 185px 100px 60px 125px auto auto auto"},{"align-content":"start"}]},"tap_action":{"action":"none"},"triggers_update":["input_boolean.hive_ha_schedule","binary_sensor.hive_hot_water_state","binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost"],"variables":{"name":"","bg_photo":""},"extra_styles":"@keyframes hive-pan { 0% { background-position: 0 0, 0% 50%; } 100% { background-position: 0 0, 100% 50%; } }"},"hive_device":{"custom_fields":{"head":"[[[ const eid=entity.entity_id; const t=parseFloat(entity.attributes.temperature); let right; if(eid.startsWith('water_heater.')){ const hw=states['binary_sensor.hive_hot_water_state']; right=(hw&&hw.state==='on')?'On':'Off'; } else if(entity.state==='off'||isNaN(t)||t<=7){ right='Off'; } else { const cur=parseFloat(entity.attributes.current_temperature); const ic=entity.attributes.hvac_action==='heating'?`<ha-icon icon='mdi:fire' style='--mdc-icon-size:20px;color:#E8642E;margin-left:8px'></ha-icon>`:(cur>=t?`<ha-icon icon='mdi:check-circle-outline' style='--mdc-icon-size:20px;color:var(--hs-text,#2F2F33);margin-left:8px'></ha-icon>`:''); right=`Target&nbsp;<span style='font-weight:600'>${t.toFixed(1)}\u00b0</span>${ic}`; } return `<div style='display:flex;align-items:center;gap:12px'><div style='width:30px;height:30px;border-radius:9px;background:var(--hs-line,#F2F2F5);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='${variables.icon}' style='--mdc-icon-size:17px;color:var(--hs-text,#3A3A3E)'></ha-icon></div><div style='flex:1;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left'>${variables.name||entity.attributes.friendly_name}</div><div style='font-size:17px;display:flex;align-items:center;white-space:nowrap'>${right}</div></div>`; ]]]","temp":"[[[ if(entity.entity_id.startsWith('water_heater.')) return `<div style='height:44px'></div>`; const c=parseFloat(entity.attributes.current_temperature); return `<div style='text-align:left'><div style='font-size:46px;font-weight:500;letter-spacing:-1px;line-height:1;color:var(--hs-text,#2F2F33)'>${isNaN(c)?'--':c.toFixed(1)}\u00b0</div><div style='font-size:13px;color:var(--hs-sub,#55555B);margin-top:6px'>Actual</div></div>`; ]]]","batt":"[[[ const findBatt = (eid, override) => { if (override) return override; const e = hass.entities && hass.entities[eid]; if (!e || !e.device_id) return null; for (const x of Object.values(hass.entities)) { if (x.device_id === e.device_id) { const s = states[x.entity_id]; if (s && s.attributes.device_class === 'battery' && !isNaN(parseFloat(s.state))) return x.entity_id; } } return null; }; const bid = findBatt(entity.entity_id, variables.battery); const b = bid && states[bid] ? parseFloat(states[bid].state) : NaN; if (isNaN(b) || b >= 15) return ''; return `<div style='width:22px;height:22px;border-radius:50%;background:#D9342B;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--hs-card,#FFFFFF)'><ha-icon icon='mdi:battery-alert-variant-outline' style='--mdc-icon-size:14px;color:#FFFFFF'></ha-icon></div>`; ]]]"},"hold_action":{"action":"more-info"},"show_icon":false,"show_name":false,"show_state":false,"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"border":"none"},{"padding":"16px 16px 16px 18px"},{"color":"var(--hs-text,#2F2F33)"},{"font-family":"Inter, sans-serif"}],"custom_fields":{"boost":[{"justify-self":"end"},{"align-self":"center"}],"head":[{"justify-self":"stretch"}],"temp":[{"justify-self":"start"},{"align-self":"end"}],"batt":[{"position":"absolute"},{"top":"10px"},{"left":"44px"},{"z-index":"3"},{"pointer-events":"none"}]},"grid":[{"grid-template-areas":"\"head head\" \"temp boost\""},{"grid-template-columns":"1fr auto"},{"row-gap":"14px"}]},"triggers_update":["input_boolean.hive_ha_schedule","binary_sensor.hive_hot_water_state","binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost"],"variables":{"icon":"mdi:thermometer","name":""}},"hive_icon_white":{"show_icon":true,"styles":{"card":[{"height":"38px"},{"border-radius":"22px"},{"background":"none !important"},{"background-color":"transparent !important"},{"backdrop-filter":"none !important"},{"-webkit-backdrop-filter":"none !important"},{"box-shadow":"none !important"}],"icon":[{"width":"22px"},{"color":"#FFFFFF"}]},"template":"hive_clear","extra_styles":"ha-card, ha-card::before, ha-card::after { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_menu":{"icon":"mdi:dots-horizontal","show_icon":true,"styles":{"card":[{"width":"40px"},{"height":"40px"}],"icon":[{"width":"28px"},{"color":"var(--hs-text,#2B2B2E)"}]},"tap_action":{"action":"navigate","navigation_path":"/dashboard-test1"},"template":"hive_clear","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_mode_base":{"show_name":true,"styles":{"card":[{"height":"34px"},{"border-radius":"20px"},{"background":"[[[ const st=entity.state; const hs=states['input_boolean.hive_ha_schedule']; const ha=!!(hs&&hs.state==='on'); const hw=states['input_boolean.hive_ha_water_schedule']; const wa=entity.entity_id.startsWith('water_heater.')&&!!(hw&&hw.state==='on'); const mode=wa?'schedule':(st==='off'?'off':((st==='auto'||st==='eco'||(st==='heat'&&ha&&entity.entity_id==='climate.hive_thermostat'))?'schedule':'manual')); return mode===variables.m?'#4350E6 !important':'transparent !important'; ]]]"},{"backdrop-filter":"none !important"},{"-webkit-backdrop-filter":"none !important"},{"box-shadow":"none !important"},{"border":"none !important"}],"name":[{"font-size":"16px"},{"color":"[[[ const st=entity.state; const hs=states['input_boolean.hive_ha_schedule']; const ha=!!(hs&&hs.state==='on'); const hw=states['input_boolean.hive_ha_water_schedule']; const wa=entity.entity_id.startsWith('water_heater.')&&!!(hw&&hw.state==='on'); const mode=wa?'schedule':(st==='off'?'off':((st==='auto'||st==='eco'||(st==='heat'&&ha&&entity.entity_id==='climate.hive_thermostat'))?'schedule':'manual')); return mode===variables.m?'#FFFFFF':'var(--hs-text,#2F2F33)'; ]]]"}]},"template":"hive_clear","triggers_update":["input_boolean.hive_ha_schedule","input_boolean.hive_ha_water_schedule"],"extra_styles":"ha-card { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_mode_manual":{"name":"Manual","tap_action":{"action":"perform-action","data":{"entity_id":"entity","mode":"manual"},"perform_action":"script.hive_set_mode"},"template":"hive_mode_base","variables":{"m":"manual"}},"hive_mode_off":{"name":"Off","tap_action":{"action":"perform-action","data":{"entity_id":"entity","mode":"off"},"perform_action":"script.hive_set_mode"},"template":"hive_mode_base","variables":{"m":"off"}},"hive_mode_schedule":{"name":"Schedule","tap_action":{"action":"perform-action","data":{"entity_id":"entity","mode":"schedule"},"perform_action":"script.hive_set_mode"},"template":"hive_mode_base","variables":{"m":"schedule"}},"hive_page_title":{"show_name":true,"styles":{"card":[{"padding":"22px 4px 8px"}],"name":[{"font-family":"DM Serif Display, serif"},{"font-size":"31px"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"},{"letter-spacing":"-0.3px"}]},"template":"hive_clear","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_pill_link":{"show_icon":true,"show_name":true,"styles":{"card":[{"height":"38px"},{"border-radius":"13px"},{"background":"rgba(255,255,255,0.55)"}],"grid":[{"grid-template-areas":"\"n i\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}],"icon":[{"width":"20px"},{"color":"#2F2F33"}],"name":[{"font-size":"16px"},{"color":"#2F2F33"}]},"template":"hive_clear"},"hive_sched_header":{"custom_fields":{"status":"[[[ const hs=states['input_boolean.hive_ha_schedule']; const th=states['climate.hive_thermostat']; let txt; if(variables.status) txt=variables.status; else if(hs&&hs.state==='on'&&th&&th.state==='heat') txt='Heating schedule is active'; else if(th&&th.state==='auto') txt='Hive is still running its own schedule (not yet moved to Home Assistant)'; else if(th&&th.state==='off') txt='Heating is off'; else txt='Manual mode \u2013 schedule paused'; return `<div style='font-size:15px;color:var(--hs-text,#2F2F33);text-align:left;margin-top:12px'>${txt}</div>`; ]]]","title":"[[[ return `<div style='font-size:19px;color:var(--hs-text,#2F2F33);white-space:nowrap'>${variables.title||'Thermostat'}</div>`; ]]]"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"padding":"calc(env(safe-area-inset-top) + 10px) 20px 18px"}],"custom_fields":{"back":[{"justify-self":"start"}],"status":[{"justify-self":"start"}],"title":[{"justify-self":"center"}]},"grid":[{"grid-template-areas":"\"back title .\" \"status status status\""},{"grid-template-columns":"1fr auto 1fr"},{"grid-template-rows":"64px auto"}]},"template":"hive_clear","triggers_update":["input_boolean.hive_ha_schedule","climate.hive_thermostat"]},"hive_sched_list":{"custom_fields":{"list":"[[[ const names=['Mon','Tue','Wed','Thu','Fri','Sat','Sun']; const keys=['mon','tue','wed','thu','fri','sat','sun']; let di=names.indexOf(entity.state); if(di<0) di=0; const scheds=Object.keys(states).filter(k=>k.startsWith('switch.')).map(k=>states[k]).filter(s=>Array.isArray(s.attributes.tags)&&s.attributes.tags.includes('hive_heating')); const covers=(s,k)=>{const w=s.attributes.weekdays||[]; return w.includes(k)||w.includes('daily')||(w.includes('workday')&&keys.slice(0,5).includes(k))||(w.includes('weekend')&&(k==='sat'||k==='sun'));}; const val=(a)=>{ if(!a) return 'off'; const d=a.data||a.service_data||{}; if(d.hvac_mode==='off') return 'off'; const t=parseFloat(d.temperature); return (isNaN(t)||t<=7)?'off':t; }; const slots=(i)=>{ const k=keys[(i+7)%7]; const s=scheds.find(x=>x.state!=='off'&&covers(x,k))||scheds.find(x=>covers(x,k)); if(!s) return []; const ts=s.attributes.timeslots||[]; const ac=s.attributes.actions||[]; return ts.map((t,j)=>{ const p=String(t).split(' - '); return {start:p[0].slice(0,5), end:(p[1]||'').slice(0,5), v:val(ac.length>1?ac[j]:ac[0])}; }).sort((a,b)=>a.start.localeCompare(b.start)); }; let cur=slots(di); const prev=slots(di-1); const next=slots(di+1); if(cur.length>1&&cur[0].start==='00:00'&&prev.length&&prev[prev.length-1].v===cur[0].v) cur=cur.slice(1); if(cur.length){ const L=Object.assign({},cur[cur.length-1]); if((L.end==='00:00'||L.end==='23:59'||L.end==='')&&next.length&&next[0].start==='00:00'&&next[0].v===L.v){ L.end=`${next[0].end} (${names[(di+1)%7]})`; } cur[cur.length-1]=L; } if(!cur.length) return `<div style='padding:36px 4px;color:var(--hs-sub,#66666B);font-size:16px;line-height:1.5;text-align:left'>No Home Assistant heating schedule for this day yet.<br>Tap <b>\u2022\u2022\u2022</b> to create one.</div>`; return cur.map(s=>{ const on=s.v!=='off'; const c=on?'#E8642E':'#7B80EA'; const txt=on?`${Number(s.v).toFixed(1)}\u00b0`:'Off'; return `<div style='display:flex;align-items:center;gap:26px;padding:12px 0'><div style='width:56px;height:56px;flex:none;border-radius:50%;border:3px solid ${c};box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:${on?15:17}px;color:var(--hs-text,#2F2F33)'>${txt}</div><div style='font-size:19px;color:var(--hs-text,#2F2F33)'>${s.start} - ${s.end}</div></div>`; }).join(''); ]]]"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"padding":"16px 22px 130px"}],"custom_fields":{"list":[{"justify-self":"stretch"}]},"grid":[{"grid-template-areas":"\"list\""},{"grid-template-columns":"1fr"}]},"template":"hive_clear","triggers_update":"all"},"hive_view_schedule":{"icon":"mdi:chevron-right","name":"View Schedule","tap_action":{"action":"navigate","navigation_path":"/hive-heating/schedule"},"template":"hive_pill_link"},"hive_section_title":{"template":"hive_clear","show_name":true,"styles":{"card":[{"padding":"14px 4px 2px"}],"name":[{"font-family":"DM Serif Display, serif"},{"font-size":"21px"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"}]},"extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_sensor":{"variables":{"name":"","icon":"mdi:thermometer","humidity":""},"show_icon":false,"show_name":false,"show_state":false,"tap_action":{"action":"more-info"},"hold_action":{"action":"none"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"border":"none"},{"padding":"14px 16px 16px"},{"color":"var(--hs-text,#2F2F33)"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"head\" \"temp\""},{"grid-template-columns":"1fr"},{"row-gap":"12px"}],"custom_fields":{"head":[{"justify-self":"stretch"}],"temp":[{"justify-self":"start"}]}},"custom_fields":{"head":"[[[ return `<div style='display:flex;align-items:center;gap:10px'><div style='width:30px;height:30px;border-radius:9px;background:var(--hs-line,#F2F2F5);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='${variables.icon}' style='--mdc-icon-size:17px;color:var(--hs-text,#3A3A3E)'></ha-icon></div><div style='font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left'>${variables.name||entity.attributes.friendly_name}</div></div>`; ]]]","temp":"[[[ const v=parseFloat(entity.state); const hs=variables.humidity?states[variables.humidity]:null; const h=hs?parseFloat(hs.state):NaN; const sub=isNaN(h)?'Actual':`<ha-icon icon='mdi:water-percent' style='--mdc-icon-size:15px;color:#7B80EA'></ha-icon>${Math.round(h)}% humidity`; return `<div style='text-align:left'><div style='font-size:34px;font-weight:500;letter-spacing:-0.8px;line-height:1;color:var(--hs-text,#2F2F33)'>${isNaN(v)?'--':v.toFixed(1)}\u00b0</div><div style='font-size:13px;color:var(--hs-sub,#55555B);margin-top:6px;display:flex;align-items:center;gap:4px'>${sub}</div></div>`; ]]]"}}},"kiosk_mode":{"hide_header":true},"views":[{"background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"home","sections":[{"cards":[{"custom_fields":{"away":{"card":{"entity":"input_boolean.heating_away_mode","template":"hive_away","type":"custom:button-card"}},"menu":{"card":{"template":"hive_menu","type":"custom:button-card"}}},"grid_options":{"columns":"full"},"name":"[[[ const h=new Date().getHours(); return h<12?'Good Morning':(h<18?'Good Afternoon':'Good Evening'); ]]]","show_name":true,"styles":{"card":[{"padding":"18px 2px 8px"},{"overflow":"visible"}],"grid":[{"grid-template-areas":"\"n away menu\""},{"grid-template-columns":"1fr auto auto"},{"column-gap":"16px"},{"align-items":"center"}],"name":[{"font-family":"DM Serif Display, serif"},{"font-size":"31px"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"},{"letter-spacing":"-0.3px"}]},"template":"hive_clear","triggers_update":["sun.sun"],"type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"custom_fields":{"boost":{"card":{"entity":"climate.hive_thermostat","template":"hive_boost_pill","type":"custom:button-card"}}},"entity":"climate.hive_thermostat","grid_options":{"columns":"full"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/thermostat"},"template":"hive_device","type":"custom:button-card","variables":{"icon":"mdi:thermometer","name":"Thermostat"}},{"custom_fields":{"boost":{"card":{"entity":"water_heater.hive_hot_water","template":"hive_boost_pill","type":"custom:button-card"}}},"entity":"water_heater.hive_hot_water","grid_options":{"columns":"full"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/hot-water"},"template":"hive_device","type":"custom:button-card","variables":{"icon":"mdi:faucet","name":"Hot Water"},"hs_requires":"hot_water"},{"custom_fields":{"boost":{"card":{"entity":"climate.bedroom_radiator","template":"hive_boost_pill","type":"custom:button-card"}}},"entity":"climate.bedroom_radiator","grid_options":{"columns":"full"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/bedroom"},"template":"hive_device","type":"custom:button-card","variables":{"icon":"mdi:radiator","name":"Bedroom radiator"},"hs_per_valve":"hive"},{"type":"custom:button-card","template":"hive_device","entity":"climate.study_radiator","variables":{"name":"Study radiator","icon":"mdi:radiator"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/study"},"custom_fields":{"boost":{"card":{"type":"custom:button-card","template":"hive_boost_pill","entity":"climate.study_radiator"}}},"grid_options":{"columns":"full"},"hs_per_valve":"other"},{"grid_options":{"columns":"full"},"styles":{"card":[{"height":"150px"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"desktop":{"position":"bottom","show_labels":true},"mobile":{"mode":"floating","show_labels":true,"safe_area":true},"routes":[{"icon":"mdi:view-agenda-outline","icon_selected":"mdi:view-agenda","label":"Home","url":"/hive-heating/home"},{"icon":"mdi:chart-line","label":"Insights","url":"/hive-heating/insights"},{"icon":"mdi:calendar-clock","label":"Schedule","url":"/hive-heating/schedule"},{"icon":"mdi:cog-outline","label":"Manage","url":"/hive-heating/manage","icon_selected":"mdi:cog"}],"type":"custom:navbar-card","styles":"\n.navbar {\n  --navbar-primary-color: #4350E6;\n  --navbar-background-color: var(--hs-nav,rgba(255,255,255,0.97));\n  --navbar-border-radius: 34px;\n  --navbar-route-icon-size: 26px;\n  --navbar-box-shadow-mobile-floating: 0 4px 18px rgba(30,30,60,0.12);\n  --navbar-box-shadow-desktop: 0 4px 18px rgba(30,30,60,0.12);\n}\n.navbar-card {\n  background: var(--hs-nav,rgba(255,255,255,0.97)) !important;\n  border: 1px solid var(--hs-line,#E3E3E8) !important;\n  border-radius: 34px !important;\n}\n.navbar .route,\n.navbar .route .button,\n.navbar .route .icon,\n.navbar .route .button .icon {\n  opacity: 1 !important;\n  filter: none !important;\n}\n.navbar .route .icon,\n.navbar .route .button .icon {\n  color: var(--hs-text,#2B2B2E) !important;\n  --icon-primary-color: var(--hs-text,#2B2B2E) !important;\n  --mdc-icon-color: var(--hs-text,#2B2B2E);\n}\n.navbar .route .label {\n  color: var(--hs-text,#2B2B2E) !important;\n  opacity: 1 !important;\n  font-family: Inter, sans-serif;\n}\n.navbar .route .button.active {\n  background: var(--hs-line,#E9E9EE) !important;\n}\n.navbar .route .button.active .icon,\n.navbar .route .icon.active,\n.navbar .route .button .icon.active {\n  color: #4350E6 !important;\n  --icon-primary-color: #4350E6 !important;\n  --mdc-icon-color: #4350E6;\n}\n.navbar .route .label.active {\n  color: #4350E6 !important;\n}\n"}],"type":"grid"}],"title":"Home","type":"sections"},{"back_path":"/hive-heating/home","cards":[{"custom_fields":{"actions":{"card":{"cards":[{"template":"hive_view_schedule","type":"custom:button-card"},{"entity":"input_boolean.hive_ha_schedule","template":"hive_advance","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"back":{"card":{"template":"hive_back","type":"custom:button-card"}},"boost":{"card":{"entity":"climate.hive_thermostat","template":"hive_boost_big","type":"custom:button-card"}},"down":{"card":{"entity":"climate.hive_thermostat","template":"hive_arrow_down","type":"custom:button-card"}},"modes":{"card":{"cards":[{"entity":"climate.hive_thermostat","template":"hive_mode_manual","type":"custom:button-card"},{"entity":"climate.hive_thermostat","template":"hive_mode_schedule","type":"custom:button-card"},{"entity":"climate.hive_thermostat","template":"hive_mode_off","type":"custom:button-card"}],"columns":3,"square":false,"type":"grid"}},"tools":{"card":{"cards":[{"icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"},"template":"hive_icon_white","type":"custom:button-card"},{"entity":"climate.hive_thermostat","icon":"mdi:cog-outline","tap_action":{"action":"more-info"},"template":"hive_icon_white","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"up":{"card":{"entity":"climate.hive_thermostat","template":"hive_arrow_up","type":"custom:button-card"}}},"entity":"climate.hive_thermostat","template":"hive_detail","type":"custom:button-card","variables":{"name":"Thermostat"},"hold_action":{"action":"navigate","navigation_path":"/hive-heating/thermostat-picker"}}],"path":"thermostat","subview":true,"title":"Thermostat","type":"panel"},{"back_path":"/hive-heating/home","cards":[{"custom_fields":{"back":{"card":{"template":"hive_back","type":"custom:button-card"}},"boost":{"card":{"entity":"water_heater.hive_hot_water","template":"hive_boost_big","type":"custom:button-card"}},"modes":{"card":{"cards":[{"entity":"water_heater.hive_hot_water","template":"hive_mode_manual","type":"custom:button-card"},{"entity":"water_heater.hive_hot_water","template":"hive_mode_schedule","type":"custom:button-card"},{"entity":"water_heater.hive_hot_water","template":"hive_mode_off","type":"custom:button-card"}],"columns":3,"square":false,"type":"grid"}},"tools":{"card":{"cards":[{"icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"},"template":"hive_icon_white","type":"custom:button-card"},{"entity":"water_heater.hive_hot_water","icon":"mdi:cog-outline","tap_action":{"action":"more-info"},"template":"hive_icon_white","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"actions":{"card":{"type":"grid","columns":1,"square":false,"cards":[{"type":"custom:button-card","template":"hive_view_schedule","tap_action":{"action":"navigate","navigation_path":"/hive-heating/water-schedule"}}]}}},"entity":"water_heater.hive_hot_water","template":"hive_detail","type":"custom:button-card","variables":{"name":"Hot Water"}}],"path":"hot-water","subview":true,"title":"Hot Water","type":"panel","hs_requires":"hot_water"},{"back_path":"/hive-heating/home","cards":[{"custom_fields":{"back":{"card":{"template":"hive_back","type":"custom:button-card"}},"boost":{"card":{"entity":"climate.bedroom_radiator","template":"hive_boost_big","type":"custom:button-card"}},"down":{"card":{"entity":"climate.bedroom_radiator","template":"hive_arrow_down","type":"custom:button-card"}},"modes":{"card":{"cards":[{"entity":"climate.bedroom_radiator","template":"hive_mode_manual","type":"custom:button-card"},{"entity":"climate.bedroom_radiator","template":"hive_mode_schedule","type":"custom:button-card"},{"entity":"climate.bedroom_radiator","template":"hive_mode_off","type":"custom:button-card"}],"columns":3,"square":false,"type":"grid"}},"tools":{"card":{"cards":[{"icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"},"template":"hive_icon_white","type":"custom:button-card"},{"entity":"climate.bedroom_radiator","icon":"mdi:cog-outline","tap_action":{"action":"more-info"},"template":"hive_icon_white","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"up":{"card":{"entity":"climate.bedroom_radiator","template":"hive_arrow_up","type":"custom:button-card"}}},"entity":"climate.bedroom_radiator","template":"hive_detail","type":"custom:button-card","variables":{"name":"Bedroom radiator"},"hold_action":{"action":"navigate","navigation_path":"/hive-heating/bedroom-picker"}}],"path":"bedroom","subview":true,"title":"Bedroom radiator","type":"panel","hs_per_valve":"hive"},{"title":"Study radiator","path":"study","type":"panel","subview":true,"back_path":"/hive-heating/home","cards":[{"type":"custom:button-card","template":"hive_detail","entity":"climate.study_radiator","variables":{"name":"Study radiator"},"hold_action":{"action":"navigate","navigation_path":"/hive-heating/study-picker"},"custom_fields":{"back":{"card":{"type":"custom:button-card","template":"hive_back","tap_action":{"action":"navigate","navigation_path":"/hive-heating/home"}}},"tools":{"card":{"type":"grid","columns":2,"square":false,"cards":[{"type":"custom:button-card","template":"hive_icon_white","icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"}},{"type":"custom:button-card","template":"hive_icon_white","icon":"mdi:cog-outline","entity":"climate.study_radiator","tap_action":{"action":"more-info"}}]}},"up":{"card":{"type":"custom:button-card","template":"hive_arrow_up","entity":"climate.study_radiator"}},"down":{"card":{"type":"custom:button-card","template":"hive_arrow_down","entity":"climate.study_radiator"}},"boost":{"card":{"type":"custom:button-card","template":"hive_boost_big","entity":"climate.study_radiator"}},"modes":{"card":{"type":"grid","columns":3,"square":false,"cards":[{"type":"custom:button-card","template":"hive_mode_manual","entity":"climate.study_radiator"},{"type":"custom:button-card","template":"hive_mode_schedule","entity":"climate.study_radiator"},{"type":"custom:button-card","template":"hive_mode_off","entity":"climate.study_radiator"}]}}}}],"hs_per_valve":"other"},{"back_path":"/hive-heating/thermostat","background":"var(--hs-card,#FFFFFF)","cards":[{"type":"custom:hive-schedule-card","entity":"climate.hive_thermostat","title":"Thermostat","tag":"hive_heating","back_path":"/hive-heating/thermostat","edit_path":"/hive-heating/schedule-edit","mode_entity":"input_boolean.hive_ha_schedule","default_temp":18.5}],"path":"schedule","subview":true,"title":"Schedule","type":"panel"},{"back_path":"/hive-heating/schedule","background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"schedule-edit","sections":[{"cards":[{"custom_fields":{"back":{"card":{"tap_action":{"action":"navigate","navigation_path":"/hive-heating/schedule"},"template":"hive_back_dark","type":"custom:button-card"}}},"grid_options":{"columns":"full"},"name":"Edit schedule","show_name":true,"styles":{"card":[{"padding":"14px 2px 6px"}],"grid":[{"grid-template-areas":"\"back n\""},{"grid-template-columns":"auto 1fr"},{"column-gap":"16px"},{"align-items":"center"}],"name":[{"font-family":"DM Serif Display, serif"},{"font-size":"28px"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"discover_existing":false,"grid_options":{"columns":"full"},"include":["climate.hive_thermostat"],"tags":["hive_heating"],"title":"Thermostat","type":"custom:scheduler-card","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"content":"Schedules shown here carry the tag **hive_heating** \u2014 that's what the Hive-style schedule view reads. Off slots are stored as 7 \u00b0C (Hive's frost setting).","grid_options":{"columns":"full"},"type":"markdown","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}}],"type":"grid"}],"subview":true,"title":"Edit schedule","type":"sections"},{"title":"Hot water schedule","path":"water-schedule","subview":true,"type":"panel","back_path":"/hive-heating/hot-water","background":"var(--hs-card,#FFFFFF)","cards":[{"type":"custom:hive-schedule-card","entity":"water_heater.hive_hot_water","title":"Hot Water","tag":"hive_hot_water","back_path":"/hive-heating/hot-water","mode_entity":"input_boolean.hive_ha_water_schedule"}],"hs_requires":"hot_water"},{"background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"insights","sections":[{"cards":[{"grid_options":{"columns":"full"},"name":"Insights","template":"hive_page_title","type":"custom:button-card"},{"type":"custom:button-card","template":"hive_section_title","name":"Temperatures","grid_options":{"columns":"full"}},{"apex_config":{"chart":{"height":240,"foreColor":"#8E8F9A"},"grid":{"borderColor":"rgba(128,128,140,0.22)"},"legend":{"show":false}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"graph_span":"24h","grid_options":{"columns":"full"},"header":{"colorize_states":true,"show":true,"show_states":true,"title":"Thermostat \u00b7 last 24 h"},"series":[{"color":"#E8642E","entity":"climate.hive_thermostat","group_by":{"duration":"10min","func":"avg"},"name":"Actual","stroke_width":3,"attribute":"current_temperature"},{"color":"#4350E6","curve":"stepline","entity":"climate.hive_thermostat","name":"Target","stroke_width":2,"attribute":"temperature"}],"type":"custom:apexcharts-card"},{"apex_config":{"chart":{"height":240,"foreColor":"#8E8F9A"},"grid":{"borderColor":"rgba(128,128,140,0.22)"},"legend":{"show":true}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"graph_span":"24h","grid_options":{"columns":"full"},"header":{"colorize_states":true,"show":true,"show_states":true,"title":"Rooms \u00b7 last 24 h"},"series":[{"attribute":"current_temperature","color":"#7B80EA","entity":"climate.bedroom_radiator","group_by":{"duration":"10min","func":"avg"},"name":"Bedroom","stroke_width":2,"hs_per_valve":"any"}],"type":"custom:apexcharts-card"},{"grid_options":{"columns":"full"},"styles":{"card":[{"height":"150px"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"desktop":{"position":"bottom","show_labels":true},"mobile":{"mode":"floating","show_labels":true,"safe_area":true},"routes":[{"icon":"mdi:view-agenda-outline","icon_selected":"mdi:view-agenda","label":"Home","url":"/hive-heating/home"},{"icon":"mdi:chart-line","label":"Insights","url":"/hive-heating/insights"},{"icon":"mdi:calendar-clock","label":"Schedule","url":"/hive-heating/schedule"},{"icon":"mdi:cog-outline","label":"Manage","url":"/hive-heating/manage","icon_selected":"mdi:cog"}],"type":"custom:navbar-card","styles":"\n.navbar {\n  --navbar-primary-color: #4350E6;\n  --navbar-background-color: var(--hs-nav,rgba(255,255,255,0.97));\n  --navbar-border-radius: 34px;\n  --navbar-route-icon-size: 26px;\n  --navbar-box-shadow-mobile-floating: 0 4px 18px rgba(30,30,60,0.12);\n  --navbar-box-shadow-desktop: 0 4px 18px rgba(30,30,60,0.12);\n}\n.navbar-card {\n  background: var(--hs-nav,rgba(255,255,255,0.97)) !important;\n  border: 1px solid var(--hs-line,#E3E3E8) !important;\n  border-radius: 34px !important;\n}\n.navbar .route,\n.navbar .route .button,\n.navbar .route .icon,\n.navbar .route .button .icon {\n  opacity: 1 !important;\n  filter: none !important;\n}\n.navbar .route .icon,\n.navbar .route .button .icon {\n  color: var(--hs-text,#2B2B2E) !important;\n  --icon-primary-color: var(--hs-text,#2B2B2E) !important;\n  --mdc-icon-color: var(--hs-text,#2B2B2E);\n}\n.navbar .route .label {\n  color: var(--hs-text,#2B2B2E) !important;\n  opacity: 1 !important;\n  font-family: Inter, sans-serif;\n}\n.navbar .route .button.active {\n  background: var(--hs-line,#E9E9EE) !important;\n}\n.navbar .route .button.active .icon,\n.navbar .route .icon.active,\n.navbar .route .button .icon.active {\n  color: #4350E6 !important;\n  --icon-primary-color: #4350E6 !important;\n  --mdc-icon-color: #4350E6;\n}\n.navbar .route .label.active {\n  color: #4350E6 !important;\n}\n"}],"type":"grid"}],"title":"Insights","type":"sections"},{"background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"manage","sections":[{"cards":[{"grid_options":{"columns":"full"},"name":"Manage","template":"hive_page_title","type":"custom:button-card"},{"entity":"input_boolean.hive_ha_schedule","grid_options":{"columns":"full"},"name":"Home Assistant runs the heating schedule","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"entity":"input_boolean.heating_away_mode","grid_options":{"columns":"full"},"name":"Away / holiday mode","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"type":"custom:button-card","entity":"input_select.hive_appearance","show_name":false,"show_icon":false,"show_state":false,"tap_action":{"action":"none"},"hold_action":{"action":"none"},"grid_options":{"columns":"full"},"custom_fields":{"t":"[[[ const m = entity.state; const sub = m === 'Auto' ? 'Follows each device (phone, tablet) light or dark setting' : (m === 'Dark' ? 'Dark background on every screen' : 'Light background on every screen'); return `<div style='display:flex;align-items:center;gap:14px;text-align:left'><div style='width:42px;height:42px;border-radius:50%;background:var(--hs-line,#ECECF0);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='mdi:theme-light-dark' style='--mdc-icon-size:22px;color:var(--hs-text,#2B2B2E)'></ha-icon></div><div><div style='font-size:17px;font-weight:500;color:var(--hs-text,#2B2B2E)'>Appearance</div><div style='font-size:14px;color:var(--hs-sub,#66666B);margin-top:2px;white-space:normal'>${sub}</div></div></div>`; ]]]","o":{"card":{"type":"horizontal-stack","cards":[{"type":"custom:button-card","entity":"input_select.hive_appearance","name":"Light","icon":"mdi:white-balance-sunny","show_state":false,"layout":"icon_name","tap_action":{"action":"perform-action","perform_action":"input_select.select_option","target":{"entity_id":"input_select.hive_appearance"},"data":{"option":"Light"}},"styles":{"card":[{"height":"46px"},{"border-radius":"14px"},{"box-shadow":"none"},{"border":"none"},{"padding":"0 10px"},{"background":"[[[ return entity.state === 'Light' ? '#4350E6' : 'var(--hs-line,#ECECF0)'; ]]]"}],"name":[{"font-family":"Inter, sans-serif"},{"font-size":"15px"},{"font-weight":"500"},{"color":"[[[ return entity.state === 'Light' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"icon":[{"width":"18px"},{"color":"[[[ return entity.state === 'Light' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}]}},{"type":"custom:button-card","entity":"input_select.hive_appearance","name":"Dark","icon":"mdi:weather-night","show_state":false,"layout":"icon_name","tap_action":{"action":"perform-action","perform_action":"input_select.select_option","target":{"entity_id":"input_select.hive_appearance"},"data":{"option":"Dark"}},"styles":{"card":[{"height":"46px"},{"border-radius":"14px"},{"box-shadow":"none"},{"border":"none"},{"padding":"0 10px"},{"background":"[[[ return entity.state === 'Dark' ? '#4350E6' : 'var(--hs-line,#ECECF0)'; ]]]"}],"name":[{"font-family":"Inter, sans-serif"},{"font-size":"15px"},{"font-weight":"500"},{"color":"[[[ return entity.state === 'Dark' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"icon":[{"width":"18px"},{"color":"[[[ return entity.state === 'Dark' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}]}},{"type":"custom:button-card","entity":"input_select.hive_appearance","name":"Auto","icon":"mdi:theme-light-dark","show_state":false,"layout":"icon_name","tap_action":{"action":"perform-action","perform_action":"input_select.select_option","target":{"entity_id":"input_select.hive_appearance"},"data":{"option":"Auto"}},"styles":{"card":[{"height":"46px"},{"border-radius":"14px"},{"box-shadow":"none"},{"border":"none"},{"padding":"0 10px"},{"background":"[[[ return entity.state === 'Auto' ? '#4350E6' : 'var(--hs-line,#ECECF0)'; ]]]"}],"name":[{"font-family":"Inter, sans-serif"},{"font-size":"15px"},{"font-weight":"500"},{"color":"[[[ return entity.state === 'Auto' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"icon":[{"width":"18px"},{"color":"[[[ return entity.state === 'Auto' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}]}}]}}},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"border":"none"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"padding":"16px"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"t\" \"o\""},{"grid-template-columns":"1fr"},{"row-gap":"14px"}],"custom_fields":{"t":[{"justify-self":"stretch"}],"o":[{"justify-self":"stretch"}]}}},{"type":"custom:button-card","entity":"climate.hive_thermostat","show_icon":false,"show_name":false,"show_state":false,"tap_action":{"action":"navigate","navigation_path":"/hive-heating/thermostat"},"hold_action":{"action":"more-info"},"triggers_update":["input_boolean.hive_ha_schedule","input_boolean.heating_away_eco_active"],"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"border":"none"},{"padding":"16px"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"head\" \"modes\""},{"grid-template-columns":"1fr"},{"row-gap":"14px"}],"custom_fields":{"head":[{"justify-self":"stretch"}],"modes":[{"justify-self":"stretch"},{"background":"var(--hs-modebar,#F1F2FB)"},{"border-radius":"24px"},{"padding":"4px"}]}},"custom_fields":{"head":"[[[ const st=entity.state; const hs=states['input_boolean.hive_ha_schedule']; const ha=!!(hs&&hs.state==='on');\nconst cur=parseFloat(entity.attributes.current_temperature); const t=parseFloat(entity.attributes.temperature);\nlet mode, col='var(--hs-sub,#55555B)', warn='';\nif(st==='off'){ mode='Off'; }\nelse if(st==='heat' && ha && states['input_boolean.heating_away_eco_active'] && states['input_boolean.heating_away_eco_active'].state==='on'){ mode='Away eco \u2013 nobody home'; col='#2E9E5B'; }\nelse if(st==='heat' && ha){ mode='Schedule (Home Assistant)'; col='#4350E6'; }\nelse if(st==='auto'){ mode=\"Hive's own schedule\"; col='#D9342B'; warn=`<div style='font-size:12px;color:#D9342B;margin-top:4px'>Tap Schedule to hand control back to Home Assistant</div>`; }\nelse { mode='Manual'; }\nlet tgt='';\nif(st!=='off' && !isNaN(t)) tgt = t<=7 ? ' \u00b7 off until next slot' : ` \u00b7 target ${t.toFixed(1)}\u00b0`;\nconst heating = entity.attributes.hvac_action==='heating' ? `<ha-icon icon='mdi:fire' style='--mdc-icon-size:16px;color:#E8642E;margin-left:4px'></ha-icon>` : '';\nreturn `<div style='display:flex;align-items:center;gap:12px;text-align:left'><div style='width:40px;height:40px;border-radius:50%;background:var(--hs-line,#F2F2F5);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='mdi:thermostat' style='--mdc-icon-size:22px;color:var(--hs-text,#3A3A3E)'></ha-icon></div><div style='flex:1;min-width:0'><div style='font-size:17px;font-weight:500;color:var(--hs-text,#2F2F33)'>Thermostat</div><div style='font-size:14px;color:${col};display:flex;align-items:center;flex-wrap:wrap'>${mode}<span style='color:var(--hs-sub,#55555B)'>&nbsp;\u00b7 ${isNaN(cur)?'--':cur.toFixed(1)}\u00b0${tgt}</span>${heating}</div>${warn}</div></div>`; ]]]","modes":{"card":{"type":"grid","columns":3,"square":false,"cards":[{"type":"custom:button-card","template":"hive_mode_manual","entity":"climate.hive_thermostat"},{"type":"custom:button-card","template":"hive_mode_schedule","entity":"climate.hive_thermostat"},{"type":"custom:button-card","template":"hive_mode_off","entity":"climate.hive_thermostat"}]}}},"grid_options":{"columns":"full"}},{"entity":"water_heater.hive_hot_water","features":[{"type":"water-heater-operation-modes"}],"grid_options":{"columns":"full"},"name":"Hot Water","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_requires":"hot_water"},{"entity":"climate.bedroom_radiator","grid_options":{"columns":6},"name":"Bedroom radiator","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_per_valve":"hive"},{"entity":"climate.study_radiator","grid_options":{"columns":6},"name":"Study radiator","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_per_valve":"other"},{"entity":"binary_sensor.hive_hub_status","grid_options":{"columns":6},"name":"Hive hub","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_requires":"hub"},{"type":"custom:button-card","show_name":false,"show_icon":false,"show_state":false,"tap_action":{"action":"none"},"hold_action":{"action":"none"},"grid_options":{"columns":"full"},"triggers_update":["sensor.hive_thermostat_battery_level","sensor.bedroom_radiator_battery_level","sensor.study_radiator_battery"],"custom_fields":{"list":"[[[ const findBatt = (eid, override) => { if (override) return override; const e = hass.entities && hass.entities[eid]; if (!e || !e.device_id) return null; for (const x of Object.values(hass.entities)) { if (x.device_id === e.device_id) { const s = states[x.entity_id]; if (s && s.attributes.device_class === 'battery' && !isNaN(parseFloat(s.state))) return x.entity_id; } } return null; }; const items = variables.items || []; let h = `<div style='display:flex;align-items:center;gap:14px;text-align:left;margin-bottom:6px'><div style='width:42px;height:42px;border-radius:50%;background:var(--hs-line,#ECECF0);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='mdi:battery-heart-variant' style='--mdc-icon-size:22px;color:var(--hs-text,#2B2B2E)'></ha-icon></div><div><div style='font-size:17px;font-weight:500;color:var(--hs-text,#2B2B2E)'>Batteries</div><div style='font-size:14px;color:var(--hs-sub,#66666B);margin-top:2px'>Valves and thermostat</div></div></div>`; items.forEach(([n, eid, ov]) => { if (!states[eid]) return; const bid = findBatt(eid, ov); const b = bid && states[bid] ? parseFloat(states[bid].state) : NaN; const r = isNaN(b) ? null : Math.round(b); const col = r === null ? 'var(--hs-sub,#9A9AA2)' : (r < 15 ? '#D9342B' : (r < 30 ? '#E8A33A' : '#2E9E5B')); const lvl = r === null ? 0 : Math.min(100, Math.max(10, Math.round(r / 10) * 10)); const ic = r === null ? 'mdi:battery-unknown' : (r < 15 ? 'mdi:battery-alert-variant-outline' : (lvl === 100 ? 'mdi:battery' : 'mdi:battery-' + lvl)); h += `<div style='display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--hs-line,#EFEFF3)'><ha-icon icon='${ic}' style='--mdc-icon-size:22px;color:${col};flex:none'></ha-icon><div style='flex:1;min-width:0;text-align:left;font-size:15px;color:var(--hs-text,#2B2B2E)'>${n}</div><div style='width:90px;height:6px;border-radius:3px;background:var(--hs-line,#ECECF0);overflow:hidden;flex:none'><div style='height:100%;width:${r === null ? 0 : r}%;background:${col}'></div></div><div style='width:44px;text-align:right;font-size:15px;font-weight:500;color:${col}'>${r === null ? '--' : r + '%'}</div></div>`; }); return h; ]]]"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"border":"none"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"padding":"16px 16px 6px"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"list\""},{"grid-template-columns":"1fr"}],"custom_fields":{"list":[{"justify-self":"stretch"}]}},"variables":{"items":[["Thermostat","climate.hive_thermostat","sensor.hive_thermostat_battery_level"],["Bedroom radiator","climate.bedroom_radiator",""],["Study radiator","climate.study_radiator",""]]},"hs_batteries":true},{"type":"button","name":"Heating setup (thermostat, hot water, valves)","icon":"mdi:cog-refresh-outline","show_name":true,"show_icon":true,"show_state":false,"icon_height":"28px","tap_action":{"action":"navigate","navigation_path":"/hive-heating/setup"},"grid_options":{"columns":"full"},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"type":"button","name":"Edit heating schedule","icon":"mdi:calendar-edit","show_name":true,"show_icon":true,"show_state":false,"icon_height":"28px","tap_action":{"action":"navigate","navigation_path":"/hive-heating/schedule-edit"},"grid_options":{"columns":6},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"type":"button","name":"Hive integration","icon":"mdi:hexagon-outline","show_name":true,"show_icon":true,"show_state":false,"icon_height":"28px","tap_action":{"action":"navigate","navigation_path":"/config/integrations/integration/hive"},"grid_options":{"columns":6},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"grid_options":{"columns":"full"},"styles":{"card":[{"height":"150px"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"desktop":{"position":"bottom","show_labels":true},"mobile":{"mode":"floating","show_labels":true,"safe_area":true},"routes":[{"icon":"mdi:view-agenda-outline","icon_selected":"mdi:view-agenda","label":"Home","url":"/hive-heating/home"},{"icon":"mdi:chart-line","label":"Insights","url":"/hive-heating/insights"},{"icon":"mdi:calendar-clock","label":"Schedule","url":"/hive-heating/schedule"},{"icon":"mdi:cog-outline","label":"Manage","url":"/hive-heating/manage","icon_selected":"mdi:cog"}],"type":"custom:navbar-card","styles":"\n.navbar {\n  --navbar-primary-color: #4350E6;\n  --navbar-background-color: var(--hs-nav,rgba(255,255,255,0.97));\n  --navbar-border-radius: 34px;\n  --navbar-route-icon-size: 26px;\n  --navbar-box-shadow-mobile-floating: 0 4px 18px rgba(30,30,60,0.12);\n  --navbar-box-shadow-desktop: 0 4px 18px rgba(30,30,60,0.12);\n}\n.navbar-card {\n  background: var(--hs-nav,rgba(255,255,255,0.97)) !important;\n  border: 1px solid var(--hs-line,#E3E3E8) !important;\n  border-radius: 34px !important;\n}\n.navbar .route,\n.navbar .route .button,\n.navbar .route .icon,\n.navbar .route .button .icon {\n  opacity: 1 !important;\n  filter: none !important;\n}\n.navbar .route .icon,\n.navbar .route .button .icon {\n  color: var(--hs-text,#2B2B2E) !important;\n  --icon-primary-color: var(--hs-text,#2B2B2E) !important;\n  --mdc-icon-color: var(--hs-text,#2B2B2E);\n}\n.navbar .route .label {\n  color: var(--hs-text,#2B2B2E) !important;\n  opacity: 1 !important;\n  font-family: Inter, sans-serif;\n}\n.navbar .route .button.active {\n  background: var(--hs-line,#E9E9EE) !important;\n}\n.navbar .route .button.active .icon,\n.navbar .route .icon.active,\n.navbar .route .button .icon.active {\n  color: #4350E6 !important;\n  --icon-primary-color: #4350E6 !important;\n  --mdc-icon-color: #4350E6;\n}\n.navbar .route .label.active {\n  color: #4350E6 !important;\n}\n"}],"type":"grid"}],"title":"Manage","type":"sections"},{"title":"Thermostat temperature","path":"thermostat-picker","type":"panel","subview":true,"back_path":"/hive-heating/thermostat","cards":[{"type":"custom:hive-temp-picker","entity":"climate.hive_thermostat","name":"Thermostat","back_path":"/hive-heating/thermostat","insights_path":"/hive-heating/insights"}]},{"title":"Bedroom radiator temperature","path":"bedroom-picker","type":"panel","subview":true,"back_path":"/hive-heating/bedroom","cards":[{"type":"custom:hive-temp-picker","entity":"climate.bedroom_radiator","name":"Bedroom radiator","back_path":"/hive-heating/bedroom","insights_path":"/hive-heating/insights"}],"hs_per_valve":"hive"},{"title":"Study radiator temperature","path":"study-picker","type":"panel","subview":true,"back_path":"/hive-heating/study","cards":[{"type":"custom:hive-temp-picker","entity":"climate.study_radiator","name":"Study radiator","back_path":"/hive-heating/study","insights_path":"/hive-heating/insights"}],"hs_per_valve":"other"},{"title":"Heating setup","path":"setup","subview":true,"back_path":"/hive-heating/manage","type":"sections","max_columns":1,"background":"var(--hs-page,#F4F5FA)","sections":[{"type":"grid","cards":[{"type":"custom:hive-setup-card","grid_options":{"columns":"full"}}]}]}]};
const HS_PACKAGE = {"input_boolean":{"hive_ha_schedule":{"name":"Home Assistant runs the heating schedule","icon":"mdi:calendar-clock"},"heating_away_mode":{"name":"Away / holiday mode","icon":"mdi:airplane"},"hive_ha_water_schedule":{"name":"Home Assistant runs the hot water schedule","icon":"mdi:water-boiler-auto"}},"input_select":{"hive_appearance":{"name":"Heating dashboard appearance","icon":"mdi:theme-light-dark","options":["Light","Dark","Auto"]}},"script":{"hive_boost":{"alias":"Hive - toggle boost","description":"Starts a boost, or cancels it if one is running. Hive thermostat and hot water use Hive's own boost. Hive radiator valves use Hive's boost but are cancelled by restoring a snapshot (the Hive integration's boost_heating_off fails on TRVs). Other valves are boosted by Home Assistant with timer.boost_<object id>. (Managed by Hive-style heating setup.)","icon":"mdi:bullseye","mode":"parallel","fields":{"entity_id":{"name":"Entity","required":true,"selector":{"entity":{"domain":["climate","water_heater"]}}},"minutes":{"name":"Minutes","default":60,"selector":{"number":{"min":30,"max":360,"step":30}}},"temperature":{"name":"Temperature","default":21,"selector":{"number":{"min":7,"max":30,"step":0.5}}}},"sequence":[{"variables":{"temp":"{{ temperature | default(21) | float }}","period":"{{ '%02d:%02d:00' % ((minutes | default(60) | int) // 60, (minutes | default(60) | int) % 60) }}","is_water":"{{ entity_id.startswith('water_heater.') }}","is_main":"{{ entity_id == 'climate.hive_thermostat' }}","is_hive":"{{ entity_id.startswith('water_heater.') or 'boost' in (state_attr(entity_id, 'preset_modes') or []) }}","boost_timer":"timer.boost_{{ entity_id.split('.')[1] }}","restore_scene":"scene.hive_boost_{{ entity_id.split('.')[1] }}","restore_scene_id":"hive_boost_{{ entity_id.split('.')[1] }}","boosting":"{% if entity_id == 'climate.hive_thermostat' %}{{ is_state('binary_sensor.hive_thermostat_boost', 'on') }} {% elif entity_id == 'water_heater.hive_hot_water' %}{{ is_state('binary_sensor.hive_hot_water_boost', 'on') }} {% elif 'boost' in (state_attr(entity_id, 'preset_modes') or []) %}{{ is_state_attr(entity_id, 'preset_mode', 'boost') }} {% else %}{{ is_state('timer.boost_' ~ entity_id.split('.')[1], 'active') }}{% endif %}"}},{"choose":[{"alias":"Hot water","conditions":"{{ is_water }}","sequence":[{"action":"hive.boost_hot_water","data":{"entity_id":"{{ entity_id }}","time_period":"{{ period }}","on_off":"{{ 'off' if boosting else 'on' }}"}}]},{"alias":"Main thermostat boosting - cancel","conditions":"{{ boosting and is_main }}","sequence":[{"action":"hive.boost_heating_off","data":{"entity_id":"{{ entity_id }}"}}]},{"alias":"Non-Hive valve boosting - cancel","conditions":"{{ boosting and not is_hive }}","sequence":[{"action":"timer.cancel","target":{"entity_id":"{{ boost_timer }}"}},{"if":"{{ restore_scene in (states.scene | map(attribute='entity_id') | list) }}","then":[{"action":"scene.turn_on","target":{"entity_id":"{{ restore_scene }}"}}],"else":[{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"off"}}]}]},{"alias":"Hive radiator valve boosting - cancel by restoring the snapshot","conditions":"{{ boosting }}","sequence":[{"if":"{{ restore_scene in (states.scene | map(attribute='entity_id') | list) }}","then":[{"action":"scene.turn_on","target":{"entity_id":"{{ restore_scene }}"}}],"else":[{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"off"}}]}]},{"alias":"Non-Hive valve - start a Home Assistant boost","conditions":"{{ not is_hive }}","sequence":[{"action":"scene.create","data":{"scene_id":"{{ restore_scene_id }}","snapshot_entities":["{{ entity_id }}"]}},{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"heat"}},{"action":"climate.set_temperature","target":{"entity_id":"{{ entity_id }}"},"data":{"temperature":"{{ temp }}"}},{"action":"timer.start","target":{"entity_id":"{{ boost_timer }}"},"data":{"duration":"{{ period }}"}}]}],"default":[{"if":"{{ not is_main }}","then":[{"action":"scene.create","data":{"scene_id":"{{ restore_scene_id }}","snapshot_entities":["{{ entity_id }}"]}}]},{"action":"hive.boost_heating_on","target":{"entity_id":"{{ entity_id }}"},"data":{"time_period":"{{ period }}","temperature":"{{ temp }}"}}]}]},"hive_adjust_target":{"alias":"Hive - nudge target temperature","description":"Moves the target by delta, clamped to the device's range. Kept for automations and voice; the dashboard arrows use the card's write gate instead (one change after you stop tapping), because Hive blocks bursts of changes. Don't call this many times in a row. (Managed by Hive-style heating setup.)","icon":"mdi:thermometer-plus","mode":"queued","max":10,"fields":{"entity_id":{"name":"Entity","required":true,"selector":{"entity":{"domain":"climate"}}},"delta":{"name":"Delta","default":0.5,"selector":{"number":{"min":-5,"max":5,"step":0.5}}}},"sequence":[{"action":"climate.set_temperature","target":{"entity_id":"{{ entity_id }}"},"data":{"temperature":"{{ [[ (state_attr(entity_id, 'temperature') | float(18)) + (delta | float(0.5)),\n      state_attr(entity_id, 'min_temp') | float(5) ] | max,\n    state_attr(entity_id, 'max_temp') | float(32) ] | min }}"}},{"delay":{"milliseconds":700}}]},"hive_set_mode":{"alias":"Hive - set mode (Manual / Schedule / Off)","description":"For the main thermostat, Schedule hands control to the Home Assistant schedule once a schedule tagged hive_heating exists; otherwise it falls back to Hive's own schedule. (Managed by Hive-style heating setup.)","icon":"mdi:thermostat-cog","mode":"queued","fields":{"entity_id":{"name":"Entity","required":true,"selector":{"entity":{"domain":["climate","water_heater"]}}},"mode":{"name":"Mode","required":true,"selector":{"select":{"options":["manual","schedule","off"]}}}},"sequence":[{"variables":{"is_main":"{{ entity_id == 'climate.hive_thermostat' }}","ha_schedule_ready":"{{ states.switch | selectattr('attributes.tags', 'defined')\n   | selectattr('attributes.tags', 'contains', 'hive_heating') | list | count > 0 }}","ha_water_ready":"{{ states.switch | selectattr('attributes.tags', 'defined')\n   | selectattr('attributes.tags', 'contains', 'hive_hot_water') | list | count > 0 }}"}},{"choose":[{"alias":"Hot water on the Home Assistant schedule","conditions":"{{ entity_id.startswith('water_heater.') and mode == 'schedule' and ha_water_ready }}","sequence":[{"action":"input_boolean.turn_on","target":{"entity_id":"input_boolean.hive_ha_water_schedule"}},{"action":"script.hive_apply_water_schedule_now"}]},{"alias":"Hot water","conditions":"{{ entity_id.startswith('water_heater.') }}","sequence":[{"action":"input_boolean.turn_off","target":{"entity_id":"input_boolean.hive_ha_water_schedule"}},{"action":"water_heater.set_operation_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"operation_mode":"{{ {'manual': 'on', 'schedule': 'eco', 'off': 'off'}[mode] }}"}}]},{"alias":"Main thermostat on the Home Assistant schedule","conditions":"{{ is_main and mode == 'schedule' and ha_schedule_ready }}","sequence":[{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"heat"}},{"action":"input_boolean.turn_on","target":{"entity_id":"input_boolean.hive_ha_schedule"}},{"action":"script.hive_apply_schedule_now"}]}],"default":[{"if":"{{ is_main }}","then":[{"action":"input_boolean.turn_off","target":{"entity_id":"input_boolean.hive_ha_schedule"}}]},{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"{{ {'manual': 'heat', 'schedule': 'auto', 'off': 'off'}[mode] }}"}}]}]},"hive_apply_schedule_now":{"alias":"Hive - apply current schedule slot now","description":"Re-applies today's Home Assistant schedule slot (schedules tagged hive_heating). (Managed by Hive-style heating setup.)","icon":"mdi:calendar-sync","mode":"single","sequence":[{"condition":"state","entity_id":"input_boolean.hive_ha_schedule","state":"on"},{"variables":{"day":"{{ now().strftime('%a') | lower }}","sched":"{% set ns = namespace(single='', any='') %} {% for s in states.switch | selectattr('attributes.tags', 'defined')\n     | selectattr('attributes.tags', 'contains', 'hive_heating') | selectattr('state', 'eq', 'on') %}\n  {% set w = s.attributes.weekdays | default([]) %}\n  {% if day in w or 'daily' in w %}\n    {% if w | count == 1 %}{% set ns.single = s.entity_id %}{% else %}{% set ns.any = s.entity_id %}{% endif %}\n  {% endif %}\n{% endfor %}{{ ns.single or ns.any }}"}},{"condition":"template","value_template":"{{ sched != '' }}"},{"action":"scheduler.run_action","data":{"entity_id":"{{ sched }}","time":"{{ now().strftime('%H:%M:%S') }}"}}]},"hive_apply_water_schedule_now":{"alias":"Hive - apply current hot water slot now","description":"Re-applies today's Home Assistant hot water schedule slot (schedules tagged hive_hot_water). (Managed by Hive-style heating setup.)","icon":"mdi:water-boiler-auto","mode":"single","sequence":[{"condition":"state","entity_id":"input_boolean.hive_ha_water_schedule","state":"on"},{"variables":{"day":"{{ now().strftime('%a') | lower }}","sched":"{% set ns = namespace(single='', any='') %} {% for s in states.switch | selectattr('attributes.tags', 'defined')\n     | selectattr('attributes.tags', 'contains', 'hive_hot_water') | selectattr('state', 'eq', 'on') %}\n  {% set w = s.attributes.weekdays | default([]) %}\n  {% if day in w or 'daily' in w %}\n    {% if w | count == 1 %}{% set ns.single = s.entity_id %}{% else %}{% set ns.any = s.entity_id %}{% endif %}\n  {% endif %}\n{% endfor %}{{ ns.single or ns.any }}"}},{"condition":"template","value_template":"{{ sched != '' }}"},{"action":"scheduler.run_action","data":{"entity_id":"{{ sched }}","time":"{{ now().strftime('%H:%M:%S') }}"}}]},"hive_advance_to_next":{"alias":"Hive - advance to next schedule slot","description":"Hive-style \"Advance to next\" - applies the next Home Assistant schedule slot now. (Managed by Hive-style heating setup.)","icon":"mdi:skip-next","mode":"single","sequence":[{"condition":"state","entity_id":"input_boolean.hive_ha_schedule","state":"on"},{"variables":{"sched":"{% set ns = namespace(best='', t=none) %} {% for s in states.switch | selectattr('attributes.tags', 'defined')\n     | selectattr('attributes.tags', 'contains', 'hive_heating') | selectattr('state', 'eq', 'on') %}\n  {% set nt = as_datetime(s.attributes.next_trigger) if s.attributes.next_trigger is defined and s.attributes.next_trigger else none %}\n  {% if nt is not none and (ns.t is none or nt < ns.t) %}{% set ns.t = nt %}{% set ns.best = s.entity_id %}{% endif %}\n{% endfor %}{{ ns.best }}"}},{"condition":"template","value_template":"{{ sched != '' }}"},{"action":"scheduler.run_action","data":{"entity_id":"{{ sched }}","time":"{{ (as_datetime(state_attr(sched, 'next_trigger')) + timedelta(minutes=1)).strftime('%H:%M:%S') }}"}}]}},"automation":[{"id":"hive_style_end_valve_boost","alias":"Hive-style - end Home Assistant boost on non-Hive valves","description":"When a timer.boost_* finishes, put that valve back to its pre-boost mode and temperature. (Managed by Hive-style heating setup.)","mode":"parallel","triggers":[{"trigger":"event","event_type":"timer.finished"}],"conditions":["{{ trigger.event.data.entity_id.startswith('timer.boost_') }}"],"actions":[{"action":"scene.turn_on","target":{"entity_id":"scene.hive_boost_{{ trigger.event.data.entity_id.split('.')[1][6:] }}"},"continue_on_error":true}]}]};
const HS_T = {
  main: 'climate.hive_thermostat',
  water: 'water_heater.hive_hot_water',
  mainBoost: 'binary_sensor.hive_thermostat_boost',
  waterBoost: 'binary_sensor.hive_hot_water_boost',
  waterState: 'binary_sensor.hive_hot_water_state',
  hub: 'binary_sensor.hive_hub_status',
  battery: 'sensor.hive_thermostat_battery_level',
};
// The example dashboard's two radiator pages: a Hive valve and any other valve
const HS_VALVE_T = {
  hive: { eid: 'climate.bedroom_radiator', word: 'bedroom', Word: 'Bedroom' },
  other: { eid: 'climate.study_radiator', word: 'study', Word: 'Study' },
};

const hsEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hsJ = (s) => JSON.stringify(String(s)).slice(1, -1);              // text safe inside a JSON string
const hsSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'room';
const hsObj = (eid) => eid.split('.')[1];
const hsSplitAll = (s, a, b) => s.split(a).join(b);
const hsName = (hass, eid) => { const st = hass.states[eid]; return (st && st.attributes.friendly_name) || hsObj(eid); };
const hsIsHiveValve = (hass, eid) => { const st = hass.states[eid]; return !!(st && (st.attributes.preset_modes || []).includes('boost')); };
function hsBattery(hass, eid) {
  for (const x of hsDeviceEntities(hass, eid)) {
    const st = hass.states[x];
    if (x.startsWith('sensor.') && st && (st.attributes.device_class === 'battery' || /battery/.test(x)) && !isNaN(parseFloat(st.state))) return x;
  }
  return '';
}
const hsPlatform = (hass, eid) => (hass.entities && hass.entities[eid] && hass.entities[eid].platform) || '';

function hsDeviceName(hass, eid) {
  const e = hass.entities && hass.entities[eid];
  const d = e && e.device_id && hass.devices && hass.devices[e.device_id];
  return (d && (d.name_by_user || d.name)) || hsName(hass, eid);
}
const hsSameDevice = (hass, a, b) => { const x = hass.entities && hass.entities[a], y = hass.entities && hass.entities[b]; return !!(x && y && x.device_id && x.device_id === y.device_id); };
const hsZ2MDefaults = (hass, main) => ({
  backend: hsPlatform(hass, main) === 'mqtt' ? 'z2m' : 'hive',
  z2mTopic: 'zigbee2mqtt/' + hsDeviceName(hass, main),
  z2mCh: /_heat$/.test(main) ? '_heat' : '',
});

function hsDeviceEntities(hass, eid) {
  const e = hass.entities && hass.entities[eid];
  if (!e || !e.device_id) return [];
  return Object.values(hass.entities).filter((x) => x.device_id === e.device_id && hass.states[x.entity_id]).map((x) => x.entity_id);
}

// Find the Hive boost / state / battery / hub entities that belong with the chosen thermostat and hot water
function hsDetect(hass, main, water) {
  const md = main ? hsDeviceEntities(hass, main) : [];
  const wd = water ? hsDeviceEntities(hass, water) : [];
  const hw = (id) => /hot_?water/.test(id);
  const pick = (list, f) => list.find(f) || '';
  const bin = (id) => id.startsWith('binary_sensor.');
  const waterOnly = (id) => wd.includes(id) && !md.includes(id);
  const wl = [...wd, ...md.filter((x) => !wd.includes(x))];
  const all = Object.keys(hass.states);
  return {
    mainBoost: pick(md, (id) => bin(id) && id.includes('boost') && !hw(id)),
    waterBoost: water ? pick(wl, (id) => bin(id) && id.includes('boost') && (hw(id) || waterOnly(id))) : '',
    waterState: water ? pick(wl, (id) => bin(id) && /state/.test(id) && (hw(id) || waterOnly(id))) : '',
    battery: pick(md, (id) => id.startsWith('sensor.') && (id.includes('battery') || (hass.states[id].attributes || {}).device_class === 'battery')),
    hub: pick(all, (id) => bin(id) && id.includes('hub') && hsPlatform(hass, id) === 'hive') || pick(all, (id) => bin(id) && /^binary_sensor\.hive.*hub/.test(id)),
  };
}

// Build the dashboard config from the template and the choices
function hsGenerate(c, urlPath) {
  const d = JSON.parse(JSON.stringify(HS_DASHBOARD));
  const valves = c.valves || [];
  const timers = valves.filter((v) => !v.hive).map((v) => 'timer.boost_' + hsObj(v.entity));
  if (c.backend === 'z2m') timers.push('timer.boost_' + hsObj(c.main));
  const have = { hot_water: !!c.water, hub: !!c.hub, battery: !!c.battery };

  const cloneFor = (tmpl, kind, v) => {
    const t = HS_VALVE_T[kind];
    const slug = v.slug || hsSlug(v.name);
    let s = JSON.stringify(tmpl);
    s = hsSplitAll(s, t.eid, v.entity);
    s = hsSplitAll(s, 'timer.boost_' + hsObj(t.eid), 'timer.boost_' + hsObj(v.entity));
    s = hsSplitAll(s, `/hive-heating/${t.word}-picker`, `/hive-heating/${slug}-picker`);
    s = hsSplitAll(s, `/hive-heating/${t.word}"`, `/hive-heating/${slug}"`);
    s = hsSplitAll(s, `"${t.word}-picker"`, `"${slug}-picker"`);
    s = hsSplitAll(s, `"${t.word}"`, `"${slug}"`);
    s = hsSplitAll(s, `${t.Word} radiator`, hsJ(v.name));
    s = hsSplitAll(s, t.Word, hsJ(v.name));
    const o = JSON.parse(s);
    delete o.hs_per_valve;
    return o;
  };

  const walk = (node) => {
    if (Array.isArray(node)) {
      const out = [];
      for (let i = 0; i < node.length; i++) {
        const el = node[i];
        if (el && typeof el === 'object' && el.hs_per_valve) {
          // a run of per-valve elements (e.g. the Hive valve page + the other valve page)
          const run = [];
          while (i < node.length && node[i] && node[i].hs_per_valve) run.push(node[i++]);
          i--;
          const hiveT = run.find((x) => x.hs_per_valve === 'hive' || x.hs_per_valve === 'any');
          const otherT = run.find((x) => x.hs_per_valve === 'other') || hiveT;
          for (const v of valves) {
            const useHive = v.hive || !otherT || otherT === hiveT;
            const tmpl = useHive ? hiveT : otherT;
            if (!tmpl) continue;
            const kind = tmpl.hs_per_valve === 'other' ? 'other' : 'hive';
            out.push(walk(cloneFor(tmpl, kind, v)));
          }
          continue;
        }
        if (el && typeof el === 'object' && el.hs_requires) {
          if (!have[el.hs_requires]) continue;
          const o = Object.assign({}, el); delete o.hs_requires;
          out.push(walk(o));
          continue;
        }
        out.push(walk(el));
      }
      return out;
    }
    if (node && typeof node === 'object' && node.hs_batteries) {
      const o = JSON.parse(JSON.stringify(node));
      delete o.hs_batteries;
      o.variables = Object.assign({}, o.variables, { items: [['Thermostat', c.main, c.battery || ''], ...valves.map((v) => [v.name, v.entity, v.battery || ''])] });
      o.triggers_update = [c.battery, ...valves.map((v) => v.battery)].filter(Boolean);
      return o;
    }
    if (node && typeof node === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'triggers_update' && Array.isArray(v)) {
          o[k] = [...v.filter((x) => typeof x !== 'string' || !x.startsWith('timer.boost_' + hsObj(HS_VALVE_T.other.eid))), ...timers];
        } else o[k] = walk(v);
      }
      return o;
    }
    return node;
  };

  let s = JSON.stringify(walk(d));
  s = hsSplitAll(s, HS_T.mainBoost, c.mainBoost || 'binary_sensor.none');
  s = hsSplitAll(s, HS_T.waterBoost, c.waterBoost || 'binary_sensor.none');
  s = hsSplitAll(s, HS_T.waterState, c.waterState || 'binary_sensor.none');
  s = hsSplitAll(s, HS_T.hub, c.hub || 'binary_sensor.none');
  s = hsSplitAll(s, HS_T.battery, c.battery || 'sensor.none');
  s = hsSplitAll(s, HS_T.main, c.main);
  s = hsSplitAll(s, HS_T.water, c.water || 'water_heater.none');
  s = hsSplitAll(s, '/hive-heating/', `/${urlPath}/`);
  // no boost sensor: the cards read the boost from the timer (Zigbee2MQTT) or the thermostat itself
  s = hsSplitAll(s, "?'binary_sensor.none':", "?'':");
  const out = JSON.parse(s);
  // drop placeholder entities (a part of Hive you don't have) from the cards' update lists
  const tidy = (o) => { if (Array.isArray(o)) o.forEach(tidy); else if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (k === 'triggers_update' && Array.isArray(o[k])) o[k] = o[k].filter((x) => !/\.none$/.test(x)); else tidy(o[k]); } };
  tidy(out);
  out.hive_style_setup = c;
  return out;
}

function hsPackageFor(c) {
  let s = JSON.stringify(HS_PACKAGE);
  s = hsSplitAll(s, HS_T.mainBoost, c.mainBoost || 'binary_sensor.none');
  s = hsSplitAll(s, HS_T.waterBoost, c.waterBoost || 'binary_sensor.none');
  s = hsSplitAll(s, HS_T.main, c.main);
  s = hsSplitAll(s, HS_T.water, c.water || 'water_heater.none');
  // no main-thermostat boost sensor picked: read the boost from the thermostat itself
  if (!c.mainBoost) s = hsSplitAll(s, "is_state('binary_sensor.none', 'on')", "is_state_attr(entity_id, 'preset_mode', 'boost')");
  const p = JSON.parse(s);
  if (!c.water) hsStripWater(p);
  if (c.backend === 'z2m') hsZ2M(p, c);
  return p;
}

// Zigbee2MQTT (local) receiver: Boost uses the receiver's own timed boost over MQTT. A Home Assistant
// timer is the boost state, and when it's cancelled or runs out the receiver is put back how it was.
// (Thanks to Matt for testing the MQTT messages on a real receiver.)
function hsZ2M(p, c) {
  const MARK = '(Managed by Hive-style heating setup.)';
  const main = c.main, obj = hsObj(main);
  const timer = 'timer.boost_' + obj, scene = 'scene.hive_boost_' + obj, sceneId = 'hive_boost_' + obj;
  const topic = String(c.z2mTopic || '').trim().replace(/\/set$/, '').replace(/\/+$/, '');
  const k = (n) => `'${n}${c.z2mCh || ''}'`;
  p.script.hive_z2m_end_boost = {
    alias: 'Hive - end Zigbee2MQTT receiver boost',
    description: `Cancels the receiver's own timed boost, then puts the heating back: the settings from before the boost, then the Home Assistant schedule if it's on. ${MARK}`,
    icon: 'mdi:bullseye', mode: 'single',
    sequence: [
      { action: 'timer.cancel', target: { entity_id: timer } },
      { action: 'mqtt.publish', data: { topic: topic + '/set', payload: `{{ {${k('temperature_setpoint_hold')}: false, ${k('system_mode')}: 'auto'} | to_json }}` } },
      { delay: { seconds: 1 } },
      { if: [{ condition: 'template', value_template: `{{ '${scene}' in (states.scene | map(attribute='entity_id') | list) }}` }],
        then: [{ action: 'scene.turn_on', target: { entity_id: scene } }] },
      { if: [{ condition: 'state', entity_id: 'input_boolean.hive_ha_schedule', state: 'on' }],
        then: [{ action: 'script.hive_apply_schedule_now' }] },
    ],
  };
  const b = p.script.hive_boost;
  const v = b.sequence[0].variables;
  v.is_z2m = `{{ entity_id == '${main}' }}`;
  v.boosting = v.boosting.replace(new RegExp(`^(\\{% if entity_id == '${main.replace(/\./g, '\\.')}' %\\})\\{\\{[^}]*\\}\\}`), `$1{{ is_state('${timer}', 'active') }}`);
  const ch = b.sequence[1].choose;
  ch.unshift(
    { alias: 'Zigbee2MQTT receiver boosting - cancel', conditions: '{{ is_z2m and boosting }}', sequence: [{ action: 'script.hive_z2m_end_boost' }] },
    { alias: 'Zigbee2MQTT receiver - start boost', conditions: '{{ is_z2m }}', sequence: [
      { if: [{ condition: 'state', entity_id: main, state: 'auto' }],
        then: [{ action: 'scene.delete', target: { entity_id: scene }, continue_on_error: true }],
        else: [{ action: 'scene.create', data: { scene_id: sceneId, snapshot_entities: [main] } }] },
      { action: 'mqtt.publish', data: { topic: topic + '/set',
        payload: `{{ {${k('system_mode')}: 'emergency_heating', ${k('temperature_setpoint_hold_duration')}: (minutes | default(60) | int), ${k('temperature_setpoint_hold')}: true, ${k('occupied_heating_setpoint')}: temp} | to_json }}` } },
      { action: 'timer.start', target: { entity_id: timer }, data: { duration: '{{ period }}' } },
    ] });
  // the valve clean-up automation must leave the receiver's timer to its own automation
  for (const a of p.automation) if (a.id === 'hive_style_end_valve_boost') a.conditions = [...(a.conditions || []), `{{ trigger.event.data.entity_id != '${timer}' }}`];
  p.automation.push({
    id: 'hive_style_end_z2m_boost', alias: 'Hive-style - end Zigbee2MQTT receiver boost',
    description: `When the receiver's boost timer runs out, cancel the receiver's own boost and put the heating back. ${MARK}`,
    mode: 'single',
    triggers: [{ trigger: 'event', event_type: 'timer.finished', event_data: { entity_id: timer } }],
    actions: [{ action: 'script.hive_z2m_end_boost' }],
  });
}

// Heating-only homes: leave every hot water part out of the scripts (no placeholder entities)
function hsStripWater(p) {
  delete p.input_boolean.hive_ha_water_schedule;
  delete p.script.hive_apply_water_schedule_now;
  const notWater = (b) => !/^Hot water/.test(b.alias || '');
  for (const id of ['hive_boost', 'hive_set_mode']) {
    const sc = p.script[id];
    if (!sc) continue;
    if (sc.fields && sc.fields.entity_id) sc.fields.entity_id.selector = { entity: { domain: 'climate' } };
    for (const step of sc.sequence) {
      if (step.variables) {
        delete step.variables.is_water;
        delete step.variables.ha_water_ready;
        for (const k of Object.keys(step.variables)) {
          if (typeof step.variables[k] !== 'string') continue;
          step.variables[k] = step.variables[k]
            .replace(/entity_id\.startswith\('water_heater\.'\) or /g, '')
            .replace(/\{% elif entity_id == 'water_heater\.none' %\}[\s\S]*?(?=\{% (elif|else)\b)/g, '');
        }
      }
      if (step.choose) step.choose = step.choose.filter(notWater);
    }
  }
}

class HiveSetupCard extends HTMLElement {
  setConfig(c) { this._c = c || {}; }
  getCardSize() { return 12; }
  static getStubConfig() { return {}; }

  set hass(h) {
    this._hass = h;
    if (!this._built) {
      this._built = true;
      this.attachShadow({ mode: 'open' });
      this._init();
    }
  }

  _urlPath() {
    const p = (location.pathname.split('/')[1] || 'lovelace');
    return p;
  }

  async _init() {
    const h = this._hass;
    let saved = null;
    try {
      const cfg = await h.callWS({ type: 'lovelace/config', url_path: this._urlPath() === 'lovelace' ? null : this._urlPath() });
      saved = cfg && cfg.hive_style_setup;
    } catch (e) { /* new dashboard */ }
    const climates = Object.keys(h.states).filter((e) => e.startsWith('climate.')).sort((a, b) => hsName(h, a).localeCompare(hsName(h, b)));
    const waters = Object.keys(h.states).filter((e) => e.startsWith('water_heater.'));
    let main = saved && h.states[saved.main] ? saved.main : '';
    if (!main) {
      // a Hive thermostat: Hive climate without its own boost preset
      main = climates.find((e) => hsPlatform(h, e) === 'hive' && !hsIsHiveValve(h, e)) || climates.find((e) => /thermostat/.test(e)) || climates[0] || '';
    }
    let water = saved ? (saved.water && h.states[saved.water] ? saved.water : '') : (waters.find((e) => hsPlatform(h, e) === 'hive') || waters[0] || '');
    const savedValves = saved && saved.valves ? Object.fromEntries(saved.valves.map((v) => [v.entity, v])) : null;
    this._s = {
      climates, waters, main, water, saved: !!saved,
      valves: climates.filter((e) => e !== main).map((e) => {
        const sv = savedValves && savedValves[e];
        const guess = hsIsHiveValve(h, e) || /radiator|trv|valve|rad\b|_rad$/.test(e + ' ' + hsName(h, e).toLowerCase());
        return { entity: e, name: sv ? sv.name : hsName(h, e), on: savedValves ? !!sv : guess };
      }),
      det: hsDetect(h, main, water),
      ...hsZ2MDefaults(h, main),
      log: [], busy: false, done: false,
      // scripts already there (an earlier setup, or your own): leave them alone unless you untick this
      replaceOwn: false,
    };
    if (saved && saved.backend) Object.assign(this._s, { backend: saved.backend, z2mTopic: saved.z2mTopic || this._s.z2mTopic, z2mCh: saved.z2mCh || '' });
    if (saved) Object.assign(this._s.det, { mainBoost: saved.mainBoost || this._s.det.mainBoost, waterBoost: saved.waterBoost || this._s.det.waterBoost, waterState: saved.waterState || this._s.det.waterState, hub: saved.hub || '', battery: saved.battery || '' });
    this._render();
  }

  _checks() {
    const h = this._hass;
    return [
      ['button-card', !!customElements.get('button-card')],
      ['card-mod (or UIX)', !!customElements.get('card-mod') || !!customElements.get('uix-node') || !!window.UIX || !!window.uix],
      ['navbar-card', !!customElements.get('navbar-card')],
      ['apexcharts-card (charts)', !!customElements.get('apexcharts-card')],
      ['Scheduler card', !!customElements.get('scheduler-card')],
      ['Scheduler component (integration)', !!(h.services && h.services.scheduler)],
    ];
  }

  _opt(list, sel, none) {
    const h = this._hass;
    return (none ? `<option value="">${hsEsc(none)}</option>` : '') +
      list.map((e) => `<option value="${hsEsc(e)}" ${e === sel ? 'selected' : ''}>${hsEsc(hsName(h, e))} (${hsEsc(e)})</option>`).join('');
  }

  _render() {
    const h = this._hass, s = this._s;
    if (!h.user || !h.user.is_admin) {
      this.shadowRoot.innerHTML = `<style>${this._css()}</style><div class="wrap"><div class="box"><h2>Heating setup</h2><p>Please open this page as a Home Assistant administrator.</p></div></div>`;
      return;
    }
    const checks = this._checks();
    const bins = Object.keys(h.states).filter((e) => e.startsWith('binary_sensor.'));
    const sens = Object.keys(h.states).filter((e) => e.startsWith('sensor.'));
    const z2m = s.backend === 'z2m';
    const valves = s.valves.filter((v) => v.entity !== s.main && !(z2m && hsSameDevice(h, v.entity, s.main)));
    this.shadowRoot.innerHTML = `<style>${this._css()}</style>
<div class="wrap">
  <div class="head"><div class="title">Heating setup</div>
    <div class="sub">Pick your thermostat, hot water and radiator valves. This builds the whole heating dashboard for you: no YAML to edit.</div></div>

  <div class="box">
    <div class="h">Before you start</div>
    ${checks.map(([n, ok]) => `<div class="chk ${ok ? 'ok' : 'no'}"><span>${ok ? '✓' : '✗'}</span>${hsEsc(n)}${ok ? '' : ' <em>not found - install it from HACS</em>'}</div>`).join('')}
  </div>

  <div class="box">
    <div class="h">Main thermostat</div>
    <div class="note">The thermostat that switches your boiler on.</div>
    <select id="main">${this._opt(s.climates, s.main)}</select>
    <div class="lab">Connected through</div>
    <select id="backend"><option value="hive" ${z2m ? '' : 'selected'}>Hive hub (Hive integration)</option><option value="z2m" ${z2m ? 'selected' : ''}>Zigbee2MQTT (local) - beta</option></select>
    ${z2m ? `<div class="lab">Receiver's Zigbee2MQTT topic</div><input id="z2mTopic" class="v-name" value="${hsEsc(s.z2mTopic)}">
    <div class="lab">Receiver</div>
    <select id="z2mCh"><option value="" ${s.z2mCh ? '' : 'selected'}>Single channel, heating only (SLR1)</option><option value="_heat" ${s.z2mCh ? 'selected' : ''}>Dual channel, heating + hot water (SLR2) - not tested yet</option></select>
    <div class="note">Boost uses the receiver's own timed boost. Home Assistant keeps a timer and puts the heating back when the boost ends. Hot water over Zigbee2MQTT isn't supported yet: choose "No hot water".</div>` : ''}
    <div class="h">Hot water</div>
    <div class="note">Heating only? Choose "No hot water" and the hot water pages and settings are left out.</div>
    <select id="water">${this._opt(s.waters, s.water, 'No hot water')}</select>
  </div>

  <div class="box">
    <div class="h">Radiator valves</div>
    <div class="note">Tick the valves to show. Each gets its own page with Boost. You can rename them.</div>
    ${valves.length ? valves.map((v, i) => `
      <div class="valve">
        <label class="tick"><input type="checkbox" data-i="${i}" class="v-on" ${v.on ? 'checked' : ''}></label>
        <div class="vbody">
          <input class="v-name" data-i="${i}" value="${hsEsc(v.name)}">
          <div class="vid">${hsEsc(v.entity)} · ${hsIsHiveValve(h, v.entity) ? 'Hive boost' : 'Home Assistant boost'}</div>
        </div>
      </div>`).join('') : '<div class="note">No other climate entities found.</div>'}
  </div>

  <details class="box">
    <summary class="h">Advanced (found automatically)</summary>
    <div class="lab">Heating boost sensor</div><select id="mainBoost">${this._opt(bins, s.det.mainBoost, 'None')}</select>
    ${s.water ? `<div class="lab">Hot water boost sensor</div><select id="waterBoost">${this._opt(bins, s.det.waterBoost, 'None')}</select>
    <div class="lab">Hot water on/off sensor</div><select id="waterState">${this._opt(bins, s.det.waterState, 'None')}</select>` : ''}
    <div class="lab">Thermostat battery</div><select id="battery">${this._opt(sens, s.det.battery, 'None')}</select>
    <div class="lab">Hive hub status</div><select id="hub">${this._opt(bins, s.det.hub, 'None')}</select>
    <label class="chk2"><input type="checkbox" id="replaceOwn" ${s.replaceOwn ? 'checked' : ''}> Also replace heating scripts I made myself (normally they're left as they are)</label>
  </details>

  <div class="warn">This replaces everything on <b>this</b> dashboard with the heating dashboard. Your other dashboards aren't touched. You can come back here any time from Manage → Heating setup.</div>
  ${s.log.length ? `<div class="box log">${s.log.map((l) => `<div class="${l[0]}">${hsEsc(l[1])}</div>`).join('')}</div>` : ''}
  ${s.done
    ? `<div class="btn go" id="open">Open my heating dashboard</div>`
    : `<div class="btn ${s.busy ? 'busy' : ''}" id="create">${s.busy ? 'Setting up…' : (s.saved ? 'Update my heating dashboard' : 'Create my heating dashboard')}</div>`}
</div>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    $('main').onchange = (e) => { s.main = e.target.value; s.det = hsDetect(h, s.main, s.water); Object.assign(s, hsZ2MDefaults(h, s.main)); this._render(); };
    $('backend').onchange = (e) => { s.backend = e.target.value; this._render(); };
    if ($('z2mTopic')) $('z2mTopic').oninput = (e) => { s.z2mTopic = e.target.value; };
    if ($('z2mCh')) $('z2mCh').onchange = (e) => { s.z2mCh = e.target.value; };
    $('water').onchange = (e) => { s.water = e.target.value; s.det = hsDetect(h, s.main, s.water); this._render(); };
    ['mainBoost', 'waterBoost', 'waterState', 'battery', 'hub'].forEach((k) => { const el = $(k); if (el) el.onchange = (e) => { s.det[k] = e.target.value; }; });
    $('replaceOwn').onchange = (e) => { s.replaceOwn = e.target.checked; };
    this.shadowRoot.querySelectorAll('.v-on').forEach((el) => { el.onchange = () => { valves[+el.dataset.i].on = el.checked; }; });
    this.shadowRoot.querySelectorAll('.v-name').forEach((el) => { el.oninput = () => { valves[+el.dataset.i].name = el.value; }; });
    if ($('create')) $('create').onclick = () => this._install();
    if ($('open')) $('open').onclick = () => this._go(`/${this._urlPath()}/home`);
  }

  _go(path) {
    // full reload so Home Assistant picks up the new dashboard straight away
    location.assign(path);
  }

  async _install() {
    const h = this._hass, s = this._s;
    if (s.busy) return;
    if (this.preview || this.editMode || /[?&]edit=1/.test(location.search)) {
      s.log = [['err', 'Save this card and leave edit mode (tap Done) first, then press the button on the dashboard itself.']];
      this._render(); return;
    }
    if (!s.main) { s.log = [['err', 'Pick your main thermostat first.']]; this._render(); return; }
    s.busy = true; s.log = []; this._render();
    const log = (cls, msg) => { s.log.push([cls, msg]); this._render(); };
    const used = new Set();
    const z2m = s.backend === 'z2m';
    if (z2m && !/^[^#+]+$/.test(String(s.z2mTopic || '').trim())) { s.log = [['err', "Enter the receiver's Zigbee2MQTT topic, e.g. zigbee2mqtt/Hive Receiver"]]; this._render(); return; }
    const valves = s.valves.filter((v) => v.on && v.entity !== s.main && !(z2m && hsSameDevice(h, v.entity, s.main))).map((v) => {
      let slug = hsSlug(v.name || hsObj(v.entity));
      if (['home', 'thermostat', 'hot-water', 'schedule', 'schedule-edit', 'water-schedule', 'insights', 'manage', 'setup', 'thermostat-picker'].includes(slug)) slug += '-room';
      while (used.has(slug)) slug += '-2';
      used.add(slug);
      return { entity: v.entity, name: (v.name || hsName(h, v.entity)).trim(), slug, hive: hsIsHiveValve(h, v.entity), battery: hsBattery(h, v.entity) };
    });
    const c = { version: HSTC_VERSION, main: s.main, water: s.water || '', valves, ...s.det, backend: z2m ? 'z2m' : 'hive' };
    if (z2m) Object.assign(c, { z2mTopic: String(s.z2mTopic).trim(), z2mCh: s.z2mCh || '', mainBoost: '', hub: '' });
    const pkg = hsPackageFor(c);
    try {
      const MARK = '(Managed by Hive-style heating setup.)';
      // 1. Switches and the appearance setting (only ones that don't exist yet)
      for (const [id, cfg] of Object.entries(pkg.input_boolean)) {
        if (id === 'hive_ha_water_schedule' && !c.water) continue;
        if (h.states['input_boolean.' + id]) { log('ok', `✓ ${cfg.name}: already there`); continue; }
        await h.callWS({ type: 'input_boolean/create', name: id, icon: cfg.icon });
        await h.callWS({ type: 'input_boolean/update', input_boolean_id: id, name: cfg.name, icon: cfg.icon });
        log('ok', `✓ Created switch: ${cfg.name}`);
      }
      for (const [id, cfg] of Object.entries(pkg.input_select || {})) {
        if (h.states['input_select.' + id]) { log('ok', `✓ ${cfg.name}: already there`); continue; }
        await h.callWS({ type: 'input_select/create', name: id, icon: cfg.icon, options: cfg.options });
        await h.callWS({ type: 'input_select/update', input_select_id: id, name: cfg.name, icon: cfg.icon, options: cfg.options });
        log('ok', `✓ Created setting: ${cfg.name}`);
      }
      // 2. Boost timers for valves without Hive's own boost
      const timerFor = valves.filter((x) => !x.hive).map((x) => ({ entity: x.entity, name: x.name }));
      if (z2m) timerFor.unshift({ entity: c.main, name: 'heating' });
      for (const v of timerFor) {
        const id = 'boost_' + hsObj(v.entity);
        if (h.states['timer.' + id]) { log('ok', `✓ Boost timer for ${v.name}: already there`); continue; }
        const t = { name: id, icon: 'mdi:bullseye', duration: '01:00:00', restore: true };
        await h.callWS(Object.assign({ type: 'timer/create' }, t));
        await h.callWS(Object.assign({ type: 'timer/update', timer_id: id }, t, { name: 'Boost ' + v.name }));
        log('ok', `✓ Created boost timer for ${v.name}`);
      }
      // 3. Scripts: new ones are created; existing ones are only replaced if this setup made them
      //    (or you ticked "replace my own scripts")
      const own = (cfg) => !!(cfg && typeof cfg.description === 'string' && cfg.description.includes(MARK));
      for (const [id, cfg] of Object.entries(pkg.script)) {
        let cur = null;
        try { cur = await h.callApi('GET', `config/script/config/${id}`); } catch (e) { cur = null; }
        if (!cur && h.states['script.' + id]) { log('info', `• ${cfg.alias}: set up in YAML - left as it is`); continue; }
        if (cur && !own(cur) && !s.replaceOwn) { log('info', `• ${cfg.alias}: your own version - left as it is`); continue; }
        await h.callApi('POST', `config/script/config/${id}`, cfg);
        log('ok', `✓ ${cur ? 'Updated' : 'Created'} script: ${cfg.alias}`);
      }
      // 4. Automation (same rule)
      for (const a of pkg.automation) {
        let cur = null;
        try { cur = await h.callApi('GET', `config/automation/config/${a.id}`); } catch (e) { cur = null; }
        const exists = Object.values(h.states).some((st) => st.entity_id.startsWith('automation.') && st.attributes.id === a.id);
        if (!cur && exists) { log('info', `• ${a.alias}: set up in YAML - left as it is`); continue; }
        if (cur && !own(cur) && !s.replaceOwn) { log('info', `• ${a.alias}: your own version - left as it is`); continue; }
        const body = Object.assign({}, a); delete body.id;
        await h.callApi('POST', `config/automation/config/${a.id}`, body);
        log('ok', `✓ ${cur ? 'Updated' : 'Created'} automation: ${a.alias}`);
      }
      // 5. Dashboard
      const url = this._urlPath();
      const dash = hsGenerate(c, url);
      await h.callWS({ type: 'lovelace/config/save', url_path: url === 'lovelace' ? null : url, config: dash });
      log('ok', `✓ Built the dashboard: ${valves.length} radiator page${valves.length === 1 ? '' : 's'}${c.water ? ', hot water' : ''}`);
      log('ok', 'All done!');
      s.done = true;
    } catch (e) {
      log('err', '✗ Something went wrong: ' + ((e && (e.message || e.body && e.body.message)) || JSON.stringify(e)));
      log('err', 'Nothing on your dashboard was changed. Check Settings → System → Logs, or open an Issue on GitHub.');
    }
    s.busy = false;
    this._render();
  }

  _css() {
    return `
:host { display: block; }
.wrap { font-family: Inter, sans-serif; color: var(--hs-text,#2B2B2E); padding: 6px 2px 140px; }
.head { padding: 14px 4px 10px; }
.title { font-family: 'DM Serif Display', serif; font-size: 31px; }
.sub { color: var(--hs-sub,#66666B); font-size: 15px; line-height: 1.45; margin-top: 6px; }
.box { background: var(--hs-card,#fff); border-radius: 20px; padding: 16px 18px; margin: 12px 0; box-shadow: 0 1px 8px rgba(40,40,80,0.06); }
.h { font-size: 17px; font-weight: 600; margin: 6px 0 8px; }
summary.h { cursor: pointer; }
.note { color: var(--hs-sub,#66666B); font-size: 14px; margin: -2px 0 10px; line-height: 1.4; }
.lab { color: var(--hs-sub,#66666B); font-size: 13px; margin: 12px 0 4px; }
select, .v-name { width: 100%; box-sizing: border-box; font: inherit; font-size: 15px; color: var(--hs-text,#2B2B2E); background: var(--hs-bg2,#F4F5FA); border: 1px solid var(--hs-line,#E3E3E8); border-radius: 12px; padding: 11px 12px; margin-bottom: 8px; }
.chk { display: flex; gap: 10px; align-items: baseline; font-size: 15px; padding: 4px 0; }
.chk span { font-weight: 700; width: 14px; }
.chk.ok span { color: #2E9E5B; } .chk.no span { color: #D9342B; }
.chk em { color: #D9342B; font-style: normal; font-size: 13px; }
.valve { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--hs-line,#ECECF0); }
.valve:first-of-type { border-top: none; }
.tick input { width: 22px; height: 22px; margin-top: 10px; accent-color: #4350E6; }
.vbody { flex: 1; min-width: 0; }
.vid { color: var(--hs-sub,#8E8F9A); font-size: 12px; overflow-wrap: anywhere; }
.chk2 { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: var(--hs-sub,#66666B); margin-top: 14px; line-height: 1.4; }
.chk2 input { width: 20px; height: 20px; flex: none; accent-color: #4350E6; }
.warn { color: var(--hs-sub,#66666B); font-size: 13px; line-height: 1.45; margin: 14px 6px; }
.log { font-size: 14px; line-height: 1.6; }
.log .ok { color: #2E9E5B; } .log .err { color: #D9342B; } .log .info { color: var(--hs-sub,#66666B); }
.btn { margin: 10px 0; height: 54px; border-radius: 16px; background: #4350E6; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 600; cursor: pointer; user-select: none; }
.btn.busy { opacity: 0.6; pointer-events: none; }
.btn.go { background: #2E9E5B; }
`;
  }
}

if (!customElements.get('hive-temp-picker')) customElements.define('hive-temp-picker', HiveTempPicker);
if (!customElements.get('hive-schedule-card')) customElements.define('hive-schedule-card', HiveScheduleCard);
if (!customElements.get('hive-setup-card')) customElements.define('hive-setup-card', HiveSetupCard);
window.customCards = window.customCards || [];
window.customCards.push(
  { type: 'hive-temp-picker', name: 'Hive-style temperature picker', description: 'Hold-to-scroll temperature wheel; the background follows the temperature.', documentationURL: 'https://github.com/xtrendmaster/hive-style-thermostat-cards' },
  { type: 'hive-schedule-card', name: 'Hive-style heating schedule', description: 'Per-day heating or hot water schedule viewer and editor for the Scheduler component.', documentationURL: 'https://github.com/xtrendmaster/hive-style-thermostat-cards' },
  { type: 'hive-setup-card', name: 'Hive-style heating setup', description: 'Pick your thermostat, hot water and radiator valves; builds the whole heating dashboard for you.', documentationURL: 'https://github.com/xtrendmaster/hive-style-thermostat-cards' },
);

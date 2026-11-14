/*!
 * Hive-style thermostat cards for Home Assistant
 * https://github.com/xtrendmaster/hive-style-thermostat-cards
 * MIT licence. Not affiliated with or endorsed by Hive / Centrica.
 *
 * Cards:
 *   custom:hive-temp-picker    - hold-to-scroll temperature wheel, background follows the temperature
 *   custom:hive-schedule-card  - per-day heating schedule viewer + editor (Scheduler component)
 *   write gate                 - batches temperature changes so Hive's servers don't block them
 *   boost sheet                - tap Boost to pick temperature and how long (fire-dom-event hive_boost)
 *                                (buttons: tap_action fire-dom-event with hive_nudge / hive_set)
 */
const HSTC_VERSION = '1.7.1';
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
/* Appearance: Light / Dark / Auto / Noir (input_select.hive_appearance) */
/* The cards and the dashboard use --hs-* colour variables with light   */
/* fallbacks; Dark and Noir set them on the page.                       */
/* Noir: near-black with a soft gold glow, gold accent, thin numbers,   */
/* gold trim on the cards and no blurred shadows (light for wall panels) */
/* ------------------------------------------------------------------ */
(() => {
  if (window.__hsTheme || window.__hiveSignature4) return;
  window.__hsTheme = true;
  const DARK = {
    '--hs-page': '#111217', '--hs-bg2': '#111217', '--hs-card': '#1C1D24', '--hs-text': '#ECECF1', '--hs-sub': '#9C9DAA',
    '--hs-line': '#2B2C36', '--hs-pill': '#E2E5FB', '--hs-pill2': '#1C1D24', '--hs-ring': '#262A4D',
    '--hs-modebar': 'rgba(43,44,54,0.92)', '--hs-nav': 'rgba(28,29,36,0.97)', '--hs-scheme': 'dark',
  };
  const NOIR = {
    '--hs-page': 'radial-gradient(900px 520px at -10% -10%, rgba(233,196,106,0.10), transparent 60%), radial-gradient(800px 480px at 110% 0%, rgba(94,196,182,0.06), transparent 60%), linear-gradient(180deg, #0C0E13 0%, #07080B 100%)',
    '--hs-bg2': '#0B0D12', '--hs-card': '#171B23', '--hs-text': '#F2EFE9', '--hs-sub': '#8B909B',
    '--hs-line': 'rgba(255,255,255,0.07)', '--hs-pill': 'rgba(233,196,106,0.16)', '--hs-pill2': '#14171E', '--hs-ring': 'rgba(233,196,106,0.18)',
    '--hs-modebar': 'rgba(255,255,255,0.04)', '--hs-nav': 'rgba(18,21,28,0.97)', '--hs-scheme': 'dark',
    '--hs-accent': '#B8913F', '--hs-accent2': '#D9B36A',
    '--hs-serif': 'Inter, sans-serif', '--hs-serif-w': '200',
    '--hs-pilllink': 'rgba(255,255,255,0.06)', '--hs-pilllink-border': '1px solid rgba(255,255,255,0.10)', '--hs-pilllink-text': '#F2EFE9',
    '--hs-trim': '1px solid rgba(233,196,106,0.38)', '--hs-trim-heat': '1px solid rgba(255,138,91,0.6)',
    '--hs-shadow': 'inset 0 1px 0 rgba(255,255,255,0.05)', '--hs-radius': '22px',
    '--hs-boost-bg': 'transparent', '--hs-boost-text': '#E9C46A', '--hs-boost-border': '1px solid rgba(233,196,106,0.55)',
    '--hs-num-w': '300', '--hs-num-ls': '-1.5px',
    '--hs-cap-size': '10.5px', '--hs-cap-ls': '1.6px', '--hs-cap-tt': 'uppercase', '--hs-cap-w': '500',
    '--hs-target-c': '#8B909B', '--hs-target-size': '15px', '--hs-target-w': '500', '--hs-tick': '#8B909B', '--hs-tick-o': '0.7',
    '--hs-nav-icon': 'rgba(242,239,233,0.62)', '--hs-nav-active': 'rgba(233,196,106,0.14)', '--hs-nav-accent': '#E9C46A',
    '--hs-greet': 'Italiana, serif', '--hs-greet-size': 'min(28px, 7.2vw)', '--hs-greet-w': '400', '--hs-greet-ls': '0px',
  };
  const KEYS = Array.from(new Set([...Object.keys(DARK), ...Object.keys(NOIR)]));
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const fonts = () => {
    if (document.getElementById('hs-noir-fonts')) return;
    const l = document.createElement('link');
    l.id = 'hs-noir-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Italiana&family=Inter:wght@200;300;400;500;600&display=swap';
    document.head.appendChild(l);
  };
  const apply = () => {
    const ha = document.querySelector('home-assistant');
    const s = ha && ha.hass && ha.hass.states['input_select.hive_appearance'];
    const mode = s ? s.state : 'Light';
    const noir = mode === 'Noir';
    window.__hsNoir = noir;
    if (noir) fonts();
    const want = noir ? NOIR : ((mode === 'Dark' || (mode === 'Auto' && !!(mq && mq.matches))) ? DARK : {});
    const r = document.documentElement.style;
    if (!r || typeof r.getPropertyValue !== 'function') return;
    // checked every second, so the page never stays half-set
    KEYS.forEach((k) => {
      const v = want[k];
      if (v === undefined) { if (r.getPropertyValue(k)) r.removeProperty(k); }
      else if (r.getPropertyValue(k) !== v) r.setProperty(k, v);
    });
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
  // Noir: dark page with the temperature colour as a soft glow
  const ha = document.querySelector('home-assistant'), ap = ha && ha.hass && ha.hass.states['input_select.hive_appearance'];
  if (window.__hsNoir || (ap && ap.state === 'Noir')) return `radial-gradient(120% 60% at 50% 40%,hsla(${(h % 360).toFixed(0)},80%,58%,0.34) 0%,hsla(${(h % 360).toFixed(0)},80%,58%,0.08) 45%,transparent 75%),linear-gradient(180deg,#0E1015 0%,#07080B 100%)`;
  return `linear-gradient(180deg,hsl(${(h % 360).toFixed(0)},76%,56%) 0%,hsl(${((h + 14) % 360).toFixed(0)},80%,64%) 100%)`;
}
window.hiveGradient = hiveGradient;

/* ------------------------------------------------------------------ */
/* Boost sheet: tap Boost to choose the temperature and how long,       */
/* like the Hive app. Tap again while boosting to stop the boost.       */
/*  Buttons: tap_action: { action: fire-dom-event, hive_boost: { entity_id } } */
/* ------------------------------------------------------------------ */
(() => {
  if (window.__hiveBoostSheet) return;
  window.__hiveBoostSheet = true;
  const hass = () => { const r = document.querySelector('home-assistant'); return r ? r.hass : null; };
  const toast = (message) => { const r = document.querySelector('home-assistant'); if (r) r.dispatchEvent(new CustomEvent('hass-notification', { detail: { message }, bubbles: true, composed: true })); };
  const resolve = (id, e) => {
    if (id && /^[a-z_]+\.[a-z0-9_]+$/.test(id)) return id;
    for (const n of e.composedPath()) { const c = n && (n._config || n.config); if (c && typeof c.entity === 'string') return c.entity; }
    return null;
  };
  const MINS = [30, 60, 120, 180];
  const label = (m) => (m < 60 ? `${m} min` : `${m / 60} hr`);
  const store = { get(k) { try { return JSON.parse(localStorage.getItem('hive-boost:' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('hive-boost:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } } };

  // boost timer / snapshot name: timer.boost_<object id> (hot water: timer.boost_water_<object id>,
  // so a thermostat and hot water with the same object id don't share one)
  const tkey = (id) => (id.startsWith('water_heater.') ? 'water_' : '') + id.split('.')[1];
  // Is this thermostat, valve or hot water boosting now? (same rules as the Boost buttons)
  const boosting = (h, id, sensor) => {
    const st = h.states[id];
    if (!st) return false;
    const obj = id.split('.')[1];
    const tm = h.states['timer.boost_' + tkey(id)];
    if (tm && tm.state === 'active') return true;
    if (sensor && h.states[sensor]) return h.states[sensor].state === 'on';
    // Hive devices also have a timer (used when Hive's boost actions are missing), so read Hive's own boost too
    const hiveDev = id.startsWith('water_heater.') || !!(h.entities && h.entities[id] && h.entities[id].platform === 'hive');
    if (tm && !hiveDev) return false;
    if (id.startsWith('climate.') && (st.attributes.preset_modes || []).includes('boost')) return st.attributes.preset_mode === 'boost';
    const water = id.startsWith('water_heater.');
    const ent = h.entities && h.entities[id];
    const dev = ent && ent.device_id ? Object.values(h.entities).filter((x) => x.device_id === ent.device_id).map((x) => x.entity_id) : [];
    const near = Object.keys(h.states).filter((x) => x.startsWith('binary_sensor.' + obj));
    const b = [...dev, ...near].find((x) => x.startsWith('binary_sensor.') && x.includes('boost') && (water ? /hot_?water/.test(x) : !/hot_?water/.test(x)));
    return !!(b && h.states[b] && h.states[b].state === 'on');
  };

  const css = document.createElement('style');
  css.textContent = `
#hive-boost-sheet{position:fixed;inset:0;z-index:30;display:flex;align-items:flex-end;justify-content:center;background:rgba(10,10,20,0);transition:background .25s;font-family:Inter,sans-serif}
#hive-boost-sheet.on{background:rgba(10,10,20,.45)}
#hive-boost-sheet .s{width:100%;max-width:520px;background:var(--hs-card,#fff);color:var(--hs-text,#2B2B2E);border-radius:26px 26px 0 0;
  padding:20px 22px calc(env(safe-area-inset-bottom) + 22px);box-sizing:border-box;transform:translateY(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1);color-scheme:var(--hs-scheme,light)}
#hive-boost-sheet.on .s{transform:none}
#hive-boost-sheet .grab{width:40px;height:5px;border-radius:3px;background:var(--hs-line,#E3E3E8);margin:0 auto 14px}
#hive-boost-sheet .t{font-family:var(--hs-serif,'DM Serif Display',serif);font-weight:var(--hs-serif-w,400);font-size:26px;text-align:center}
#hive-boost-sheet .n{color:var(--hs-sub,#66666B);font-size:15px;text-align:center;margin-top:2px}
#hive-boost-sheet .lab{color:var(--hs-sub,#66666B);font-size:14px;margin:20px 2px 10px}
#hive-boost-sheet .temp{display:flex;align-items:center;justify-content:space-between;gap:14px}
#hive-boost-sheet .rb{all:unset;cursor:pointer;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--hs-bg2,#F4F5FA);
  box-shadow:inset 0 0 0 1px var(--hs-line,#E3E3E8);font-size:30px;line-height:1;color:var(--hs-text,#2B2B2E);-webkit-tap-highlight-color:transparent}
#hive-boost-sheet .val{flex:1;height:76px;border-radius:22px;display:flex;align-items:center;justify-content:center;color:#fff;font:300 44px Inter,sans-serif;letter-spacing:-1px;transition:background .3s}
#hive-boost-sheet .mins{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
#hive-boost-sheet .m{all:unset;cursor:pointer;text-align:center;padding:13px 0;border-radius:14px;font-size:16px;background:var(--hs-bg2,#F4F5FA);box-shadow:inset 0 0 0 1px var(--hs-line,#E3E3E8);-webkit-tap-highlight-color:transparent}
#hive-boost-sheet .m.sel{background:var(--hs-accent,#4350E6);color:#fff;box-shadow:none}
#hive-boost-sheet .all{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:18px;padding:14px 16px;border-radius:16px;background:var(--hs-bg2,#F4F5FA);box-shadow:inset 0 0 0 1px var(--hs-line,#E3E3E8);cursor:pointer}
#hive-boost-sheet .all span{display:flex;flex-direction:column;gap:2px;font-size:16px}
#hive-boost-sheet .all b{font-weight:500}
#hive-boost-sheet .all small{color:var(--hs-sub,#66666B);font-size:13px}
#hive-boost-sheet .allcb{appearance:none;-webkit-appearance:none;flex:none;width:50px;height:30px;border-radius:15px;background:var(--hs-line,#D9DAE2);position:relative;cursor:pointer;transition:background .2s;margin:0}
#hive-boost-sheet .allcb::after{content:'';position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}
#hive-boost-sheet .allcb:checked{background:var(--hs-accent,#4350E6)}
#hive-boost-sheet .allcb:checked::after{transform:translateX(20px)}
#hive-boost-sheet .go{all:unset;cursor:pointer;display:block;width:100%;box-sizing:border-box;text-align:center;margin-top:24px;padding:16px 0;border-radius:16px;background:var(--hs-accent,#4350E6);color:#fff;font-size:17px;font-weight:600}
#hive-boost-sheet .no{all:unset;cursor:pointer;display:block;width:100%;text-align:center;margin-top:8px;padding:12px 0;color:var(--hs-sub,#66666B);font-size:16px}`;
  document.head.appendChild(css);

  // The radiators that belong with a main thermostat: from the setup page (hive_style_setup), or a
  // hand-built dashboard's hive_style_boost_group: { main: climate.x, valves: [climate.a, ...] }
  let groupCache = null;
  const groupFor = async (h, id) => {
    try {
      if (!groupCache) {
        const p = location.pathname.split('/')[1] || 'lovelace';
        const cfg = await h.callWS({ type: 'lovelace/config', url_path: p === 'lovelace' ? null : p });
        groupCache = { cfg };
      }
      const c = groupCache.cfg || {};
      const g = c.hive_style_setup || c.hive_style_boost_group;
      if (g && g.main !== id) { const v = (g.valves || []).find((x) => x && x.entity === id); groupCache.title = v && v.name ? v.name : ''; }
      if (!g || g.main !== id) return [];
      groupCache.title = 'Thermostat';
      return (g.valves || []).map((v) => (typeof v === 'string' ? v : v.entity)).filter((v) => v && v !== id && h.states[v]);
    } catch (e) { return []; }
  };
  const isHive = (h, x) => { const e = h.entities && h.entities[x]; return !!(e && e.platform === 'hive'); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Hive's boost actions can be missing (e.g. Hive Custom Component 2026.10.x). Then Hive devices are
  // boosted by Home Assistant instead: a snapshot, the boost temperature and a timer.boost_<object id>.
  const hiveActions = (h) => !!(h.services && h.services.hive && h.services.hive.boost_heating_on);
  const haBoost = (h, eid) => {
    if (!(eid.startsWith('water_heater.') || isHive(h, eid))) return false;
    const tm = h.states['timer.boost_' + tkey(eid)];
    return !hiveActions(h) || !!(tm && tm.state === 'active');
  };
  const ensureTimer = async (h, eid) => {
    const id = 'boost_' + tkey(eid);
    if (h.states['timer.' + id]) return true;
    if (!(h.user && h.user.is_admin)) return false;
    try {
      const t = { name: id, icon: 'mdi:bullseye', duration: '01:00:00', restore: true };
      await h.callWS(Object.assign({ type: 'timer/create' }, t));
      const st = h.states[eid];
      await h.callWS(Object.assign({ type: 'timer/update', timer_id: id }, t, { name: 'Boost ' + ((st && st.attributes.friendly_name) || eid.split('.')[1].replace(/_/g, ' ')) }));
      for (let i = 0; i < 20 && !hass().states['timer.' + id]; i++) await sleep(150);
      return true;
    } catch (e) { return false; }
  };
  // Hive's servers block bursts of changes, so Hive devices are boosted a few seconds apart
  const runAll = async (h, calls) => {
    let lastHive = 0;
    for (let [eid, data] of calls) {
      if (isHive(h, eid)) { const wait = lastHive + 4000 - Date.now(); if (wait > 0) await sleep(wait); lastHive = Date.now(); }
      if (haBoost(h, eid)) {
        if (!(await ensureTimer(h, eid))) { toast(`Boost needs a timer for ${(h.states[eid] && h.states[eid].attributes.friendly_name) || eid}: open Heating setup and press Update`); continue; }
        data = Object.assign({}, data, { ha_boost: true });
      }
      try { await h.callService('script', 'hive_boost', data); } catch (e) { toast(`Couldn't boost ${(h.states[eid] && h.states[eid].attributes.friendly_name) || eid}: ${e && e.message ? e.message : e}`); }
    }
  };

  const open = async (h, id, title) => {
    const st = h.states[id];
    const group = id.startsWith('climate.') ? await groupFor(h, id) : [];
    if (!title && groupCache && groupCache.title) title = groupCache.title;
    if (groupCache) groupCache.title = '';
    const water = id.startsWith('water_heater.');
    const name = (title || (water ? 'Hot water' : '') || st.attributes.friendly_name || id.split('.')[1]).replace(/\s+$/, '');
    const lo = Math.max(7, parseFloat(st.attributes.min_temp) || 7), hi = Math.min(30, parseFloat(st.attributes.max_temp) || 30);
    const last = store.get(id) || {};
    const cur = parseFloat(st.attributes.temperature);
    let temp = last.temp != null ? last.temp : Math.max(21, isNaN(cur) ? 21 : Math.ceil((cur + 1) * 2) / 2);
    temp = Math.min(hi, Math.max(lo, temp));
    let mins = MINS.includes(last.mins) ? last.mins : 60;
    let all = !!last.all;
    const el = document.createElement('div');
    el.id = 'hive-boost-sheet';
    el.innerHTML = `<div class="s" role="dialog" aria-label="Boost">
      <div class="grab"></div><div class="t">Boost</div><div class="n"></div>
      ${water ? '' : `<div class="lab">Temperature</div><div class="temp"><button class="rb" data-d="-0.5" aria-label="Lower">−</button><div class="val"></div><button class="rb" data-d="0.5" aria-label="Higher">+</button></div>`}
      <div class="lab">How long</div><div class="mins">${MINS.map((m) => `<button class="m" data-m="${m}">${label(m)}</button>`).join('')}</div>
      ${group.length ? `<label class="all"><span><b>Boost all radiators too</b><small>${group.length} radiator${group.length === 1 ? '' : 's'} with smart valves</small></span><input type="checkbox" class="allcb"></label>` : ''}
      <button class="go">Start boost</button><button class="no">Cancel</button></div>`;
    el.querySelector('.n').textContent = name;
    const paint = () => {
      const v = el.querySelector('.val');
      if (v) { v.textContent = temp.toFixed(1) + '°'; v.style.background = window.hiveGradient ? window.hiveGradient(temp) : '#E8642E'; }
      el.querySelectorAll('.m').forEach((b) => b.classList.toggle('sel', +b.dataset.m === mins));
      el.querySelector('.go').textContent = water ? `Boost hot water for ${label(mins)}` : `Boost ${all && group.length ? 'everywhere ' : ''}to ${temp.toFixed(1)}° for ${label(mins)}`;
      const cb = el.querySelector('.allcb'); if (cb) cb.checked = all;
    };
    const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 260); };
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    el.querySelectorAll('.rb').forEach((b) => { b.onclick = () => { temp = Math.min(hi, Math.max(lo, temp + parseFloat(b.dataset.d))); paint(); }; });
    el.querySelectorAll('.m').forEach((b) => { b.onclick = () => { mins = +b.dataset.m; paint(); }; });
    el.querySelector('.no').onclick = close;
    const cb = el.querySelector('.allcb');
    if (cb) cb.onchange = () => { all = cb.checked; paint(); };
    el.querySelector('.go').onclick = () => {
      store.set(id, { temp, mins, all });
      const data = water ? { entity_id: id, minutes: mins } : { entity_id: id, minutes: mins, temperature: temp };
      const calls = [[id, data]];
      if (all && group.length) {
        // only radiators that aren't already boosting; remember them so stopping the main boost stops them too
        const extra = group.filter((v) => !boosting(h, v));
        extra.forEach((v) => calls.push([v, { entity_id: v, minutes: mins, temperature: temp }]));
        store.set('group:' + id, { valves: extra, until: Date.now() + mins * 60000 });
      } else store.set('group:' + id, null);
      runAll(h, calls);
      close();
    };
    paint();
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  };

  window.addEventListener('ll-custom', (e) => {
    const d = (e.detail || {}).hive_boost;
    if (!d) return;
    const h = hass();
    const id = resolve(d.entity_id, e);
    if (!h || !id || !h.states[id]) return;
    if (boosting(h, id, d.boost_sensor)) {
      const calls = [[id, { entity_id: id }]];
      const g = store.get('group:' + id);
      if (g && g.valves && g.until > Date.now()) g.valves.filter((v) => h.states[v] && boosting(h, v)).forEach((v) => calls.push([v, { entity_id: v }]));
      store.set('group:' + id, null);
      runAll(h, calls);
      return;
    }
    const title = typeof d.name === 'string' && d.name && !d.name.startsWith('[[[') ? d.name : '';
    open(h, id, title);
  });
  window.hiveOpenBoost = (id, title) => { const h = hass(); if (h && h.states[id]) open(h, id, title); };
})();

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
  .item { height: ${ITEM_H}px; scroll-snap-align: center; display: flex; align-items: center; justify-content: center; font-family: var(--hs-serif, 'DM Serif Display', serif); font-weight: var(--hs-serif-w, 400); color: #fff; line-height: 0.8; opacity: 0.12; will-change: opacity, transform; transition: text-shadow 0.15s; }
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
  // Room mode (config house_tag): a radiator's own schedule. A day without its own times follows the
  // house schedule; editing that day gives the room its own times, starting from the house ones.
  _room() { return !!this._c.house_tag; }
  _schedules(tag) {
    tag = tag || this._c.tag;
    return Object.keys(this._hass.states).filter((k) => k.startsWith('switch.')).map((k) => this._hass.states[k])
      .filter((s) => Array.isArray(s.attributes.tags) && s.attributes.tags.includes(tag));
  }
  _covers(s, key) {
    const w = s.attributes.weekdays || [];
    return w.includes(key) || w.includes('daily') ||
      (w.includes('workday') && ['mon', 'tue', 'wed', 'thu', 'fri'].includes(key)) ||
      (w.includes('weekend') && (key === 'sat' || key === 'sun'));
  }
  _schedFor(di, tag) {
    const key = HS_DAYS[(di + 7) % 7];
    const all = this._schedules(tag).filter((s) => this._covers(s, key));
    return all.find((s) => (s.attributes.weekdays || []).length === 1) || all[0] || null;
  }
  _water() { return String(this._c.entity || '').startsWith('water_heater.'); }

  _inherits(di) { return this._room() && !this._schedFor(di); }
  _periods(di) {
    const s = this._schedFor(di) || (this._room() ? this._schedFor(di, this._c.house_tag) : null);
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
    const parts = this._schedules().concat(this._room() ? this._schedules(this._c.house_tag) : []).map((s) => s.entity_id + JSON.stringify(s.attributes.weekdays) + JSON.stringify(s.attributes.timeslots) + JSON.stringify(s.attributes.actions) + s.state);
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
    await this._hass.callService('scheduler', 'add', { name: `${this._room() ? this._c.title : (this._water() ? 'Hot water' : 'Heating')} ${HS_NAMES[di]}`, weekdays: [key], repeat_type: 'repeat', tags: [this._c.tag], timeslots });
  }
  // Room mode: take a day out of the room's own schedule, so it follows the house schedule again
  async _dropDay(di) {
    const key = HS_DAYS[di];
    const s = this._schedFor(di);
    if (!s) return;
    let w = (s.attributes.weekdays || []).slice();
    if (w.includes('daily')) w = HS_DAYS.slice();
    if (w.includes('workday')) w = w.filter((x) => x !== 'workday').concat(['mon', 'tue', 'wed', 'thu', 'fri']);
    if (w.includes('weekend')) w = w.filter((x) => x !== 'weekend').concat(['sat', 'sun']);
    w = w.filter((x) => x !== key);
    if (w.length) await this._hass.callService('scheduler', 'edit', { entity_id: s.entity_id, weekdays: w });
    else await this._hass.callService('scheduler', 'remove', { entity_id: s.entity_id });
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
  .day.sel { background: var(--hs-accent,#4350E6); color: #fff; }
  .day.today:not(.sel) { box-shadow: inset 0 0 0 1.5px var(--hs-accent,#4350E6); color: var(--hs-accent,#4350E6); }
  .list { padding: 16px 22px; }
  .row { display: flex; align-items: center; gap: 26px; padding: 12px 0; width: 100%; }
  .circ { width: 56px; height: 56px; flex: none; border-radius: 50%; border: 3px solid var(--hs-accent2,#7B80EA); display: flex; align-items: center; justify-content: center; font-size: 17px; }
  .circ.on { border-color: #E8642E; font-size: 15px; }
  .time { font-size: 19px; }
  .note { margin: 0 0 8px; padding: 12px 14px; border-radius: 14px; background: var(--hs-pill2, #F2F3FB); color: var(--hs-sub, #66666B); font-size: 14px; line-height: 1.45; }
  .empty { padding: 30px 4px; color: var(--hs-sub, #66666B); font-size: 16px; line-height: 1.5; }
  .fab { position: fixed; right: 22px; bottom: calc(env(safe-area-inset-bottom) + 34px); width: 56px; height: 56px; border-radius: 50%; background: var(--hs-accent,#4350E6); box-shadow: 0 0 0 6px var(--hs-ring, #E5E7FB); display: flex; align-items: center; justify-content: center; z-index: 5; }
  .fab ha-icon { --mdc-icon-size: 26px; color: #fff; }
  .ov { position: fixed; inset: 0; z-index: 20; background: var(--hs-bg2, #fff); display: flex; flex-direction: column; font-family: Inter, sans-serif; color: var(--hs-text, #2F2F33); }
  .ov .body { padding: 8px 20px; flex: 1; overflow-y: auto; }
  .box { border-radius: 18px; background: var(--hs-card, #fff); box-shadow: 0 1px 10px rgba(40,40,80,0.08); overflow: hidden; }
  .field { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; height: 64px; font-size: 18px; }
  .sep { height: 2px; background: var(--hs-line, #F0F0F3); }
  .field input, .field select { -webkit-appearance: none; appearance: none; border: none; background: transparent; color: var(--hs-accent,#4350E6); font: inherit; font-size: 18px; text-align: right; direction: rtl; min-width: 90px; outline: none; }
  .field input::-webkit-date-and-time-value { text-align: right; }
  .err { color: #D9342B; font-size: 14px; padding: 12px 4px; min-height: 20px; }
  .done { margin: 0 24px calc(env(safe-area-inset-bottom) + 24px); height: 54px; border-radius: 14px; background: var(--hs-line, #F6F6F8); color: var(--hs-sub, #A0A0A6); display: flex; align-items: center; justify-content: center; font-size: 19px; }
  .done.ready { background: var(--hs-accent,#4350E6); color: #fff; }
  .sheetbg { position: fixed; inset: 0; z-index: 15; background: rgba(0,0,0,0.25); }
  .sheet { position: fixed; left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom) + 12px); z-index: 16; background: var(--hs-card, #fff); border-radius: 20px; overflow: hidden; font-family: Inter, sans-serif; }
  .opt { display: flex; align-items: center; gap: 14px; padding: 18px 20px; font-size: 17px; color: var(--hs-text, #2F2F33); border-bottom: 1px solid var(--hs-line, #F0F0F3); width: 100%; }
  .opt ha-icon { --mdc-icon-size: 22px; color: var(--hs-accent,#4350E6); }
  .opt.cancel { justify-content: center; color: var(--hs-sub, #66666B); border-bottom: none; }
  .chk { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; height: 56px; font-size: 18px; width: 100%; box-sizing: border-box; }
  .tick { width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--hs-sub, #C9CAD6); display: flex; align-items: center; justify-content: center; }
  .tick.on { background: var(--hs-accent,#4350E6); border-color: var(--hs-accent,#4350E6); }
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
    if (this._room()) {
      const on = md && md.state === 'on';
      const own = !this._inherits((new Date().getDay() + 6) % 7);
      status = !on ? 'Not on Schedule – tap Schedule on the room page to use these times'
        : (th && th.state === 'off' ? 'Radiator is off' : (own ? 'Room schedule is active' : 'Following the house schedule today'));
    } else if (this._water()) {
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
    const note = this._inherits(this._day) ? `<div class="note">${HS_NAMES[this._day]} follows the <b>house schedule</b>. Change or add a period to give this room its own times.</div>` : '';
    if (!rows.length && note) { list.innerHTML = note + `<div class="empty">No heating on ${HS_NAMES[this._day]}.<br>Tap <b>•••</b> to add a heating period.</div>`; return; }
    if (!rows.length) {
      list.innerHTML = this._water() ? `<div class="empty">No hot water on ${HS_NAMES[this._day]}.<br>Tap <b>•••</b> to add a hot water period.</div>` : `<div class="empty">No heating on ${HS_NAMES[this._day]}.<br>Tap <b>•••</b> to add a heating period.</div>`;
      return;
    }
    list.innerHTML = note + rows.map((r, i) => `<button class="row" data-r="${i}"><div class="circ${r.on ? ' on' : ''}">${r.on ? (this._water() ? 'On' : r.temp.toFixed(1) + '°') : 'Off'}</div><div class="time">${r.label}</div></button>`).join('');
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
      if (v.end === v.start) { q('.err').textContent = 'Start and end time are the same.'; return; }
      const others = periods.filter((_, i) => i !== idx);
      // the new times win: periods they overlap are trimmed (or split), like adding a slot in the Hive app
      const carve = (list, a, b) => list.flatMap((o) => (o.end <= a || o.start >= b) ? [o]
        : [o.start < a ? { start: o.start, end: a, temp: o.temp } : null, o.end > b ? { start: b, end: o.end, temp: o.temp } : null].filter(Boolean));
      // Overnight (e.g. 22:00 - 05:00): the part after midnight goes on the next day
      if (v.end < v.start) {
        const nd = (di + 1) % 7;
        const today = carve(others, v.start, 1440).concat([{ start: v.start, end: 1440, temp: v.temp }]);
        const tomorrow = carve(this._periods(nd), 0, v.end).concat([{ start: 0, end: v.end, temp: v.temp }]);
        q('.done').textContent = 'Saving…';
        try {
          await this._saveDay(di, today);
          await hsSleep(900);
          await this._saveDay(nd, tomorrow);
          this._closeLayer();
          this._toast(`Saved ${hsFromMin(v.start)} - ${hsFromMin(v.end)}: ${HS_NAMES[di]} until midnight, then ${HS_NAMES[nd]} morning`);
        } catch (e) { q('.done').textContent = isNew ? 'Add' : 'Done'; q('.err').textContent = `Couldn't save: ${e.message || e}`; }
        return;
      }
      q('.done').textContent = 'Saving…';
      try { await this._saveDay(di, carve(others, v.start, v.end).concat([v])); this._closeLayer(); }
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
  ${this._room() && !this._inherits(di) ? `<button class="opt o-house"><ha-icon icon="mdi:home-clock-outline"></ha-icon>Follow the house schedule on ${HS_NAMES[di]}</button>` : ''}
  ${this._c.edit_path ? '<button class="opt o-adv"><ha-icon icon="mdi:tune-variant"></ha-icon>Advanced editor</button>' : ''}
  <button class="opt cancel o-cancel">Cancel</button>
</div>`;
    const q = (s) => this._layer.querySelector(s);
    q('.sheetbg').addEventListener('click', () => this._closeLayer());
    q('.o-cancel').addEventListener('click', () => this._closeLayer());
    if (q('.o-house')) q('.o-house').addEventListener('click', async () => {
      try { await this._dropDay(di); this._closeLayer(); } catch (e) { this._toast(`Couldn't save: ${e.message || e}`); this._closeLayer(); }
    });
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
  <div class="body"><div class="box"><button class="chk c-all"><span>All days</span><span class="tick${sel.size === 6 ? ' on' : ''}">${sel.size === 6 ? '<ha-icon icon="mdi:check"></ha-icon>' : ''}</span></button></div><div class="box" style="margin-top:12px">${HS_NAMES.map((n, i) => i === di ? '' : `<button class="chk" data-d="${i}"><span>${n}</span><span class="tick${sel.has(i) ? ' on' : ''}">${sel.has(i) ? '<ha-icon icon="mdi:check"></ha-icon>' : ''}</span></button>`).join('<div class="sep"></div>').replace(/^<div class="sep"><\/div>|<div class="sep"><\/div>(?=<div class="sep">)/g, '')}</div><div class="err"></div></div>
  <button class="done${sel.size ? ' ready' : ''}">Copy to ${sel.size} day${sel.size === 1 ? '' : 's'}</button>
</div>`;
      const q = (s) => this._layer.querySelector(s);
      q('.x-back').addEventListener('click', () => this._closeLayer());
      q('.c-all').addEventListener('click', () => { if (sel.size === 6) sel.clear(); else HS_NAMES.forEach((_, i) => { if (i !== di) sel.add(i); }); draw(); });
      this._layer.querySelectorAll('.chk[data-d]').forEach((b) => b.addEventListener('click', () => { const d = parseInt(b.dataset.d, 10); if (sel.has(d)) sel.delete(d); else sel.add(d); draw(); }));
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
const HS_DASHBOARD = {"button_card_templates":{"hive_advance":{"icon":"mdi:chevron-double-right","name":"Advance to next","styles":{"card":[{"opacity":"[[[ return entity.state==='on' ? '1' : '0.45' ]]]"}]},"tap_action":{"action":"perform-action","perform_action":"script.hive_advance_to_next"},"template":"hive_pill_link"},"hive_arrow_down":{"icon":"mdi:menu-down","tap_action":{"action":"fire-dom-event","hive_nudge":{"entity_id":"[[[ return entity.entity_id ]]]","delta":-0.5},"haptic":"light"},"template":"hive_arrow_up"},"hive_arrow_up":{"icon":"mdi:menu-up","show_icon":true,"styles":{"card":[{"width":"90px"},{"height":"56px"},{"visibility":"[[[ return entity.state==='off' ? 'hidden' : 'visible' ]]]"}],"icon":[{"width":"64px"},{"color":"rgba(255,255,255,0.5)"}]},"tap_action":{"action":"fire-dom-event","hive_nudge":{"entity_id":"[[[ return entity.entity_id ]]]","delta":0.5},"haptic":"light"},"template":"hive_clear"},"hive_away":{"custom_fields":{"k":"[[[ return `<div style='width:28px;height:28px;border-radius:50%;background:#FFFFFF;box-shadow:0 1px 4px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center'><ha-icon icon='mdi:walk' style='--mdc-icon-size:17px;color:#333'></ha-icon></div>`; ]]]"},"styles":{"card":[{"width":"56px"},{"height":"32px"},{"border-radius":"16px"},{"overflow":"visible"},{"background":"[[[ return entity.state==='on' ? 'var(--hs-accent,#4350E6)' : 'var(--hs-line,#E7E7EC)' ]]]"},{"box-shadow":"inset 0 0 0 1px rgba(128,128,140,0.35)"}],"custom_fields":{"k":[{"position":"absolute"},{"top":"2px"},{"left":"[[[ return entity.state==='on' ? '26px' : '2px' ]]]"},{"transition":"left 0.2s ease"}]},"grid":[{"grid-template-areas":"\"k\""},{"grid-template-columns":"1fr"}]},"tap_action":{"action":"toggle"},"template":"hive_clear"},"hive_back":{"icon":"mdi:chevron-left","show_icon":true,"styles":{"card":[{"width":"46px"},{"height":"46px"},{"border-radius":"50%"},{"background":"rgba(255,255,255,0.22)"},{"box-shadow":"inset 0 0 0 1.5px rgba(255,255,255,0.45)"}],"icon":[{"width":"24px"},{"color":"#FFFFFF"}]},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/home"},"template":"hive_clear"},"hive_back_dark":{"icon":"mdi:chevron-left","show_icon":true,"styles":{"card":[{"width":"46px"},{"height":"46px"},{"border-radius":"50%"},{"background":"var(--hs-card,#FFFFFF)"},{"box-shadow":"0 2px 8px rgba(0,0,0,0.10), inset 0 0 0 1px var(--hs-line,#ECECF0)"}],"icon":[{"width":"24px"},{"color":"var(--hs-text,#2F2F33)"}]},"template":"hive_clear"},"hive_boost_big":{"icon":"mdi:bullseye","name":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+(eid.startsWith('water_heater.')?'water_':'')+eid.split('.')[1]]; const boost=!!(tm&&tm.state==='active')||(bs?!!(states[bs]&&states[bs].state==='on'):entity.attributes.preset_mode==='boost'); return boost?'Boosting \u00b7 tap to stop':'Boost'; ]]]","show_icon":true,"show_name":true,"styles":{"card":[{"padding":"6px 10px"},{"border-radius":"18px"},{"background":"none !important"},{"background-color":"transparent !important"},{"backdrop-filter":"none !important"},{"-webkit-backdrop-filter":"none !important"},{"box-shadow":"none !important"}],"icon":[{"width":"34px"},{"color":"#FFFFFF"}],"name":[{"font-size":"17px"},{"color":"#FFFFFF"},{"padding-top":"8px"}]},"tap_action":{"action":"fire-dom-event","hive_boost":{"entity_id":"[[[ return entity.entity_id ]]]","name":"[[[ return (variables && variables.name) || '' ]]]"},"haptic":"light"},"template":"hive_clear","triggers_update":["binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost","timer.boost_study_radiator"],"extra_styles":"ha-card, ha-card::before, ha-card::after { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }","hold_action":{"action":"perform-action","perform_action":"script.hive_boost","data":{"entity_id":"entity"}}},"hive_boost_pill":{"icon":"mdi:bullseye","layout":"icon_name","name":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+(eid.startsWith('water_heater.')?'water_':'')+eid.split('.')[1]]; const boost=!!(tm&&tm.state==='active')||(bs?!!(states[bs]&&states[bs].state==='on'):entity.attributes.preset_mode==='boost'); return boost?'Boosting':'Boost'; ]]]","show_icon":true,"show_name":true,"styles":{"card":[{"width":"122px"},{"height":"44px"},{"border-radius":"14px"},{"padding":"0 12px"},{"background":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+(eid.startsWith('water_heater.')?'water_':'')+eid.split('.')[1]]; const boost=!!(tm&&tm.state==='active')||(bs?!!(states[bs]&&states[bs].state==='on'):entity.attributes.preset_mode==='boost'); return boost?'var(--hs-accent,#4350E6)':'var(--hs-boost-bg,var(--hs-pill,#EEF0FD))'; ]]]"},{"border":"var(--hs-boost-border,none)"}],"grid":[{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"8px"}],"icon":[{"width":"22px"},{"color":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+(eid.startsWith('water_heater.')?'water_':'')+eid.split('.')[1]]; const boost=!!(tm&&tm.state==='active')||(bs?!!(states[bs]&&states[bs].state==='on'):entity.attributes.preset_mode==='boost'); return boost?'#FFFFFF':'var(--hs-boost-text,var(--hs-accent,#4350E6))'; ]]]"}],"name":[{"font-size":"17px"},{"color":"[[[ const eid=entity.entity_id; const bs=eid==='climate.hive_thermostat'?'binary_sensor.hive_thermostat_boost':(eid==='water_heater.hive_hot_water'?'binary_sensor.hive_hot_water_boost':''); const tm=states['timer.boost_'+(eid.startsWith('water_heater.')?'water_':'')+eid.split('.')[1]]; const boost=!!(tm&&tm.state==='active')||(bs?!!(states[bs]&&states[bs].state==='on'):entity.attributes.preset_mode==='boost'); return boost?'#FFFFFF':'var(--hs-boost-text,var(--hs-accent,#4350E6))'; ]]]"}]},"tap_action":{"action":"fire-dom-event","hive_boost":{"entity_id":"[[[ return entity.entity_id ]]]","name":"[[[ return (variables && variables.name) || '' ]]]"},"haptic":"light"},"template":"hive_clear","triggers_update":["binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost","timer.boost_study_radiator"],"hold_action":{"action":"perform-action","perform_action":"script.hive_boost","data":{"entity_id":"entity"}}},"hive_clear":{"hold_action":{"action":"none"},"show_icon":false,"show_label":false,"show_name":false,"show_state":false,"styles":{"card":[{"background":"none"},{"box-shadow":"none"},{"border":"none"},{"border-radius":"0"},{"padding":"0"},{"font-family":"Inter, sans-serif"},{"--ha-ripple-color":"transparent"},{"--ha-ripple-hover-opacity":"0"},{"--ha-ripple-pressed-opacity":"0"},{"-webkit-tap-highlight-color":"transparent"},{"backdrop-filter":"none"},{"-webkit-backdrop-filter":"none"},{"--ha-card-background":"transparent"},{"--card-background-color":"transparent"},{"--ha-card-backdrop-filter":"none"},{"--ha-card-border-width":"0"}]},"tap_action":{"action":"none"}},"hive_day":{"show_name":true,"styles":{"card":[{"height":"40px"},{"width":"40px"},{"border-radius":"50%"},{"margin":"0 auto"},{"background":"[[[ return entity.state===variables.day ? 'var(--hs-accent,#4350E6)' : 'transparent' ]]]"}],"name":[{"font-size":"18px"},{"color":"[[[ return entity.state===variables.day ? '#FFFFFF' : 'var(--hs-text,#2F2F33)' ]]]"}]},"template":"hive_clear"},"hive_detail":{"custom_fields":{"home":"[[[ if (entity.entity_id.startsWith('water_heater.')) return ''; const findBatt = (eid, override) => { if (override) return override; const e = hass.entities && hass.entities[eid]; if (!e || !e.device_id) return null; for (const x of Object.values(hass.entities)) { if (x.device_id === e.device_id) { const s = states[x.entity_id]; if (s && s.attributes.device_class === 'battery' && !isNaN(parseFloat(s.state))) return x.entity_id; } } return null; }; const c = parseFloat(entity.attributes.current_temperature); const bid = findBatt(entity.entity_id, variables.battery); const b = bid && states[bid] ? parseFloat(states[bid].state) : NaN; let bh = ''; if (!isNaN(b)) { const r = Math.round(b); const lvl = Math.min(100, Math.max(10, Math.round(r / 10) * 10)); const ic = r < 15 ? 'mdi:battery-alert-variant-outline' : (lvl === 100 ? 'mdi:battery' : 'mdi:battery-' + lvl); const col = r < 15 ? '#FFB3AD' : '#FFFFFF'; bh = `<span style='opacity:.45;margin:0 4px'>\u00b7</span><ha-icon icon='${ic}' style='--mdc-icon-size:20px;color:${col}'></ha-icon><span style='font-size:16px;color:${col}'>${r}%</span>`; } return `<div style='display:inline-flex;align-items:center;gap:8px;white-space:nowrap;color:#FFFFFF;font-size:19px'><ha-icon icon='mdi:home-outline' style='--mdc-icon-size:24px'></ha-icon>${isNaN(c) ? '--' : c.toFixed(1)}\u00b0${bh}</div>`; ]]]","num":"[[[ const eid=entity.entity_id; const st=entity.state; const big=(x)=>`<div style='font-family:var(--hs-serif,DM Serif Display,serif);font-weight:var(--hs-serif-w,400);color:#FFFFFF;font-size:96px;line-height:1;letter-spacing:-2px'>${x}</div>`; if(eid.startsWith('water_heater.')){ const hw=states['binary_sensor.hive_hot_water_state']; return big(st==='off'?'Off':((hw&&hw.state==='on')?'On':'Off')); } const t=parseFloat(entity.attributes.temperature); if(st==='off'||isNaN(t)) return big('Off'); const p=t.toFixed(1).split('.'); return `<div style='display:flex;align-items:flex-start;font-family:var(--hs-serif,DM Serif Display,serif);font-weight:var(--hs-serif-w,400);color:#FFFFFF;line-height:0.8'><span style='font-size:112px;letter-spacing:-3px'>${p[0]}</span><span style='display:flex;flex-direction:column;justify-content:space-between;height:84px;margin-left:4px'><span style='display:block;width:19px;height:19px;border:4px solid #FFFFFF;border-radius:50%;box-sizing:border-box;margin-top:-4px'></span><span style='font-size:46px'>.${p[1]}</span></span></div>`; ]]]","ruler":"[[[ const st=entity.state; if(entity.entity_id.startsWith('water_heater.')||st==='off') return ''; const t=parseFloat(entity.attributes.temperature); const cur=parseFloat(entity.attributes.current_temperature); if(isNaN(t)) return ''; const house=isNaN(cur)?null:Math.round(cur*2)/2; const step=47, mid=235; const dash=`<div style='width:13px;height:3px;border-radius:2px;background:rgba(255,255,255,0.55)'></div>`; let h=''; for(let i=-5;i<=5;i++){ const v=Math.round((t+i*0.5)*2)/2; const y=mid-i*step; let el; if(i===0) el=`<div style='width:58px;height:5px;border-radius:3px;background:var(--hs-card,#FFFFFF)'></div>`; else if(house!==null&&v===house) el=`<div style='display:flex;align-items:center;gap:6px'>${dash}<ha-icon icon='mdi:home' style='--mdc-icon-size:22px;color:rgba(255,255,255,0.7)'></ha-icon></div>`; else if(Math.abs((v%1)-0.5)<0.01) el=`<div style='font-size:20px;font-weight:600;letter-spacing:-0.3px;color:rgba(255,255,255,0.72)'>${v.toFixed(1)}\u00b0</div>`; else el=dash; h+=`<div style='position:absolute;left:0;top:${y}px;transform:translateY(-50%);display:flex;align-items:center'>${el}</div>`; } return `<div style='position:relative;height:${mid*2}px;width:100%;-webkit-mask-image:linear-gradient(transparent 0%,#000 14%,#000 86%,transparent 100%);mask-image:linear-gradient(transparent 0%,#000 14%,#000 86%,transparent 100%)'>${h}</div>`; ]]]","title":"[[[ return `<div style='font-size:19px;color:#FFFFFF;white-space:nowrap'>${variables.name||entity.attributes.friendly_name}</div>`; ]]]"},"hold_action":{"action":"none"},"show_icon":false,"show_name":false,"show_state":false,"styles":{"card":[{"min-height":"100vh"},{"border-radius":"0"},{"border":"none"},{"box-shadow":"none"},{"padding":"calc(env(safe-area-inset-top) + 10px) 16px 40px"},{"font-family":"Inter, sans-serif"},{"background":"[[[ const st=entity.state; const ph=variables.bg_photo; const a=ph?0.55:1; const ga=ph?0.6:1; const noir=((states['input_select.hive_appearance']||{}).state==='Noir'); const grey=noir?`radial-gradient(120% 60% at 50% 40%,rgba(233,196,106,0.08) 0%,transparent 70%),linear-gradient(180deg,rgba(18,21,28,${ph?0.6:1}) 0%,rgba(7,8,11,${ph?0.85:1}) 100%)`:`linear-gradient(180deg,rgba(142,151,172,${ga}) 0%,rgba(186,193,207,${ga}) 100%)`; let g; if(entity.entity_id.startsWith('water_heater.')) g = st==='off'?grey:(noir?`radial-gradient(120% 60% at 50% 40%,rgba(94,158,236,0.30) 0%,rgba(94,158,236,0.07) 45%,transparent 75%),linear-gradient(180deg,rgba(14,16,21,${ph?0.6:1}) 0%,rgba(7,8,11,${ph?0.85:1}) 100%)`:'linear-gradient(180deg,#3E7FE0 0%,#5E9EEC 55%,#7DB7F2 100%)'); else if(st==='off') g = grey; else { const t=parseFloat(entity.attributes.temperature); const H=[[5,222],[9,250],[13,300],[16,350],[18.5,376],[22,368],[30,358]]; const c=Math.max(5,Math.min(30,isNaN(t)?18.5:t)); let h=358; for(let i=0;i<H.length-1;i++){ if(c<=H[i+1][0]){ h=H[i][1]+(H[i+1][1]-H[i][1])*(c-H[i][0])/(H[i+1][0]-H[i][0]); break; } } g=noir?`radial-gradient(120% 60% at 50% 40%,hsla(${(h%360).toFixed(0)},80%,58%,0.34) 0%,hsla(${(h%360).toFixed(0)},80%,58%,0.08) 45%,transparent 75%),linear-gradient(180deg,rgba(14,16,21,${ph?0.6:1}) 0%,rgba(7,8,11,${ph?0.85:1}) 100%)`:`linear-gradient(180deg,hsla(${(h%360).toFixed(0)},76%,56%,${a}) 0%,hsla(${((h+14)%360).toFixed(0)},80%,64%,${a}) 100%)`; } return ph ? `${g}, url(\"${ph}\")` : g; ]]]"},{"transition":"background 0.4s ease"},{"background-repeat":"no-repeat"},{"background-size":"[[[ return variables.bg_photo ? (variables.bg_pan ? '100% 100%, auto 100%' : '100% 100%, cover') : 'auto'; ]]]"},{"animation":"[[[ return (variables.bg_photo && variables.bg_pan) ? `hive-pan ${variables.bg_pan}s ease-in-out infinite alternate` : 'none'; ]]]"},{"background-position":"[[[ return variables.bg_photo ? '0 0, center' : 'center'; ]]]"}],"custom_fields":{"actions":[{"margin":"22px 18px 0"}],"back":[{"justify-self":"start"}],"boost":[{"align-self":"center"},{"justify-self":"center"}],"down":[{"align-self":"start"},{"justify-self":"center"}],"home":[{"margin-top":"22px"},{"justify-self":"center"}],"modes":[{"margin":"20px 8px 0"},{"background":"var(--hs-modebar,#F1F2FB)"},{"border-radius":"24px"},{"padding":"4px"}],"num":[{"align-self":"center"},{"justify-self":"center"}],"ruler":[{"align-self":"start"},{"justify-self":"stretch"},{"height":"470px"}],"title":[{"justify-self":"center"}],"tools":[{"justify-self":"end"},{"width":"84px"},{"background":"rgba(255,255,255,0.22)"},{"border-radius":"22px"},{"box-shadow":"inset 0 0 0 1.5px rgba(255,255,255,0.45)"},{"padding":"3px 4px"}],"up":[{"align-self":"end"},{"justify-self":"center"}]},"grid":[{"grid-template-areas":"\"back title tools\" \"ruler up .\" \"ruler num .\" \"ruler down .\" \"ruler boost .\" \"home home home\" \"modes modes modes\" \"actions actions actions\""},{"grid-template-columns":"1fr auto 1fr"},{"grid-template-rows":"64px 185px 100px 60px 125px auto auto auto"},{"align-content":"start"}]},"tap_action":{"action":"none"},"triggers_update":["input_boolean.hive_ha_schedule","binary_sensor.hive_hot_water_state","binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost"],"variables":{"name":"","bg_photo":""},"extra_styles":"@keyframes hive-pan { 0% { background-position: 0 0, 0% 50%; } 100% { background-position: 0 0, 100% 50%; } }"},"hive_device":{"custom_fields":{"head":"[[[ const eid=entity.entity_id; const t=parseFloat(entity.attributes.temperature); let right; if(eid.startsWith('water_heater.')){ const hw=states['binary_sensor.hive_hot_water_state']; right=(hw&&hw.state==='on')?'On':'Off'; } else if(entity.state==='off'||isNaN(t)||t<=7){ right='Off'; } else { const cur=parseFloat(entity.attributes.current_temperature); const ic=((s=>s?s.state==='on':entity.attributes.hvac_action==='heating')((hass.entities&&(hass.entities[entity.entity_id]||{}).platform==='hive')?states['binary_sensor.'+entity.entity_id.split('.')[1]+'_state']:null))?`<ha-icon icon='mdi:fire' style='--mdc-icon-size:20px;color:${((m)=>{const s=states[m];const b=(hass.entities&&(hass.entities[m]||{}).platform==='hive')?states['binary_sensor.'+m.split('.')[1]+'_state']:null;return b?b.state==='on':(s&&s.attributes.hvac_action!==undefined?s.attributes.hvac_action==='heating':true);})('climate.hive_thermostat')?'#E8642E':'#8E8F9A'};margin-left:8px'></ha-icon>`:(cur>=t?`<ha-icon icon='mdi:check-circle-outline' style='--mdc-icon-size:20px;color:var(--hs-tick,var(--hs-text,#2F2F33));opacity:var(--hs-tick-o,1);margin-left:8px'></ha-icon>`:''); right=`<span style='color:var(--hs-target-c,inherit);font-size:var(--hs-target-size,inherit)'>Target</span>&nbsp;<span style='font-weight:var(--hs-target-w,600);font-variant-numeric:tabular-nums'>${t.toFixed(1)}\u00b0</span>${ic}`; } const sc=(()=>{ if(eid.startsWith('water_heater.')){ const w=states['input_boolean.hive_ha_water_schedule']; return (w&&w.state==='on')?'house':(entity.state==='auto'||entity.state==='eco'?'house':''); } if(eid==='climate.hive_thermostat'){ const h=states['input_boolean.hive_ha_schedule']; return ((h&&h.state==='on'&&entity.state!=='off')||entity.state==='auto'||entity.state==='eco')?'house':''; } const o=eid.split('.')[1]; const f=states['input_boolean.hive_room_schedule_'+o]; if(f&&f.state==='on'&&entity.state!=='off'){ const d=['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()]; const we=(d==='sat'||d==='sun'); const own=Object.keys(states).some(k=>{ if(!k.startsWith('switch.')) return false; const s=states[k]; const a=s.attributes||{}; if(!Array.isArray(a.tags)||!a.tags.includes('hive_room_'+o)||['off','unavailable','unknown'].includes(s.state)) return false; const w=a.weekdays||[]; return w.includes(d)||w.includes('daily')||(w.includes('workday')&&!we)||(w.includes('weekend')&&we); }); return own?'own':'house'; } return (entity.state==='auto'||entity.state==='eco')?'own':''; })(); if(sc) right=`<ha-icon icon='mdi:clock-outline' title='${sc==='own'?'Own schedule today':'Following the house schedule'}' style='--mdc-icon-size:18px;color:${sc==='own'?'var(--hs-sub,#66666B)':'#1FA971'};margin-right:8px'></ha-icon>`+right; return `<div style='display:flex;align-items:center;gap:12px'><div style='width:30px;height:30px;border-radius:9px;background:var(--hs-line,#F2F2F5);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='${variables.icon}' style='--mdc-icon-size:17px;color:var(--hs-text,#3A3A3E)'></ha-icon></div><div style='flex:1;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left'>${variables.name||entity.attributes.friendly_name}</div><div style='font-size:17px;display:flex;align-items:center;white-space:nowrap'>${right}</div></div>`; ]]]","temp":"[[[ if(entity.entity_id.startsWith('water_heater.')) return `<div style='height:44px'></div>`; const c=parseFloat(entity.attributes.current_temperature); return `<div style='text-align:left'><div style='font-size:46px;font-weight:var(--hs-num-w,500);letter-spacing:var(--hs-num-ls,-1px);line-height:1;font-variant-numeric:tabular-nums;color:var(--hs-text,#2F2F33)'>${isNaN(c)?'--':c.toFixed(1)}\u00b0</div><div style='font-size:var(--hs-cap-size,13px);letter-spacing:var(--hs-cap-ls,normal);text-transform:var(--hs-cap-tt,none);font-weight:var(--hs-cap-w,400);color:var(--hs-sub,#55555B);margin-top:6px'>Actual</div></div>`; ]]]","batt":"[[[ const findBatt = (eid, override) => { if (override) return override; const e = hass.entities && hass.entities[eid]; if (!e || !e.device_id) return null; for (const x of Object.values(hass.entities)) { if (x.device_id === e.device_id) { const s = states[x.entity_id]; if (s && s.attributes.device_class === 'battery' && !isNaN(parseFloat(s.state))) return x.entity_id; } } return null; }; const bid = findBatt(entity.entity_id, variables.battery); const b = bid && states[bid] ? parseFloat(states[bid].state) : NaN; if (isNaN(b) || b >= 15) return ''; if (((states['input_select.hive_appearance']||{}).state)==='Noir') return `<div title='Battery low' style='width:9px;height:9px;border-radius:50%;background:#FF5A5F;margin:3px 0 0 -2px;box-shadow:0 0 0 2px var(--hs-card,#FFFFFF)'></div>`; return `<div style='width:22px;height:22px;border-radius:50%;background:#D9342B;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--hs-card,#FFFFFF)'><ha-icon icon='mdi:battery-alert-variant-outline' style='--mdc-icon-size:14px;color:#FFFFFF'></ha-icon></div>`; ]]]"},"hold_action":{"action":"more-info"},"show_icon":false,"show_name":false,"show_state":false,"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"var(--hs-radius,20px)"},{"box-shadow":"var(--hs-shadow,0 1px 8px rgba(40,40,80,0.06))"},{"border":"[[[ return ((s=>s?s.state==='on':entity.attributes.hvac_action==='heating')((hass.entities&&(hass.entities[entity.entity_id]||{}).platform==='hive')?states['binary_sensor.'+entity.entity_id.split('.')[1]+'_state']:null)) ? 'var(--hs-trim-heat,var(--hs-trim,none))' : 'var(--hs-trim,none)'; ]]]"},{"padding":"16px 16px 16px 18px"},{"color":"var(--hs-text,#2F2F33)"},{"font-family":"Inter, sans-serif"}],"custom_fields":{"boost":[{"justify-self":"end"},{"align-self":"center"}],"head":[{"justify-self":"stretch"}],"temp":[{"justify-self":"start"},{"align-self":"end"}],"batt":[{"position":"absolute"},{"top":"10px"},{"left":"44px"},{"z-index":"3"},{"pointer-events":"none"}]},"grid":[{"grid-template-areas":"\"head head\" \"temp boost\""},{"grid-template-columns":"1fr auto"},{"row-gap":"14px"}]},"triggers_update":["input_boolean.hive_ha_schedule","binary_sensor.hive_hot_water_state","binary_sensor.hive_thermostat_boost","binary_sensor.hive_hot_water_boost","climate.hive_thermostat"],"variables":{"icon":"mdi:thermometer","name":""}},"hive_icon_white":{"show_icon":true,"styles":{"card":[{"height":"38px"},{"border-radius":"22px"},{"background":"none !important"},{"background-color":"transparent !important"},{"backdrop-filter":"none !important"},{"-webkit-backdrop-filter":"none !important"},{"box-shadow":"none !important"}],"icon":[{"width":"22px"},{"color":"#FFFFFF"}]},"template":"hive_clear","extra_styles":"ha-card, ha-card::before, ha-card::after { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_menu":{"icon":"mdi:dots-horizontal","show_icon":true,"styles":{"card":[{"width":"40px"},{"height":"40px"}],"icon":[{"width":"28px"},{"color":"var(--hs-text,#2B2B2E)"}]},"tap_action":{"action":"navigate","navigation_path":"/dashboard-test1"},"template":"hive_clear","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_mode_base":{"show_name":true,"styles":{"card":[{"height":"34px"},{"border-radius":"20px"},{"background":"[[[ const st=entity.state; const hs=states['input_boolean.hive_ha_schedule']; const ha=!!(hs&&hs.state==='on'); const hw=states['input_boolean.hive_ha_water_schedule']; const wa=entity.entity_id.startsWith('water_heater.')&&!!(hw&&hw.state==='on'); const mode=wa?'schedule':((st==='off'||(entity.entity_id.startsWith('climate.')&&!(entity.attributes.hvac_modes||['off']).includes('off')&&parseFloat(entity.attributes.temperature)<=parseFloat(entity.attributes.min_temp||5)))?'off':((st==='auto'||st==='eco'||(st==='heat'&&((ha&&entity.entity_id==='climate.hive_thermostat')||((states['input_boolean.hive_room_schedule_'+entity.entity_id.split('.')[1]]||{}).state==='on'))))?'schedule':'manual')); return mode===variables.m?'var(--hs-accent,#4350E6) !important':'transparent !important'; ]]]"},{"backdrop-filter":"none !important"},{"-webkit-backdrop-filter":"none !important"},{"box-shadow":"none !important"},{"border":"none !important"}],"name":[{"font-size":"16px"},{"color":"[[[ const st=entity.state; const hs=states['input_boolean.hive_ha_schedule']; const ha=!!(hs&&hs.state==='on'); const hw=states['input_boolean.hive_ha_water_schedule']; const wa=entity.entity_id.startsWith('water_heater.')&&!!(hw&&hw.state==='on'); const mode=wa?'schedule':((st==='off'||(entity.entity_id.startsWith('climate.')&&!(entity.attributes.hvac_modes||['off']).includes('off')&&parseFloat(entity.attributes.temperature)<=parseFloat(entity.attributes.min_temp||5)))?'off':((st==='auto'||st==='eco'||(st==='heat'&&((ha&&entity.entity_id==='climate.hive_thermostat')||((states['input_boolean.hive_room_schedule_'+entity.entity_id.split('.')[1]]||{}).state==='on'))))?'schedule':'manual')); return mode===variables.m?'#FFFFFF':'var(--hs-text,#2F2F33)'; ]]]"}]},"template":"hive_clear","triggers_update":["input_boolean.hive_ha_schedule","input_boolean.hive_ha_water_schedule"],"extra_styles":"ha-card { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_mode_manual":{"name":"Manual","tap_action":{"action":"perform-action","data":{"entity_id":"entity","mode":"manual"},"perform_action":"script.hive_set_mode"},"template":"hive_mode_base","variables":{"m":"manual"}},"hive_mode_off":{"name":"Off","tap_action":{"action":"perform-action","data":{"entity_id":"entity","mode":"off"},"perform_action":"script.hive_set_mode"},"template":"hive_mode_base","variables":{"m":"off"}},"hive_mode_schedule":{"name":"Schedule","tap_action":{"action":"perform-action","data":{"entity_id":"entity","mode":"schedule"},"perform_action":"script.hive_set_mode"},"template":"hive_mode_base","variables":{"m":"schedule"}},"hive_page_title":{"show_name":true,"styles":{"card":[{"padding":"22px 4px 8px"}],"name":[{"font-family":"var(--hs-serif,DM Serif Display, serif)"},{"font-size":"31px"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"},{"letter-spacing":"-0.3px"},{"font-weight":"var(--hs-serif-w,400)"}]},"template":"hive_clear","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_pill_link":{"show_icon":true,"show_name":true,"styles":{"card":[{"height":"38px"},{"border-radius":"13px"},{"background":"var(--hs-pilllink,rgba(255,255,255,0.55))"},{"border":"var(--hs-pilllink-border,none)"}],"grid":[{"grid-template-areas":"\"n i\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}],"icon":[{"width":"20px"},{"color":"var(--hs-pilllink-text,#2F2F33)"}],"name":[{"font-size":"16px"},{"color":"var(--hs-pilllink-text,#2F2F33)"}]},"template":"hive_clear"},"hive_sched_header":{"custom_fields":{"status":"[[[ const hs=states['input_boolean.hive_ha_schedule']; const th=states['climate.hive_thermostat']; let txt; if(variables.status) txt=variables.status; else if(hs&&hs.state==='on'&&th&&th.state==='heat') txt='Heating schedule is active'; else if(th&&th.state==='auto') txt='Hive is still running its own schedule (not yet moved to Home Assistant)'; else if(th&&th.state==='off') txt='Heating is off'; else txt='Manual mode \u2013 schedule paused'; return `<div style='font-size:15px;color:var(--hs-text,#2F2F33);text-align:left;margin-top:12px'>${txt}</div>`; ]]]","title":"[[[ return `<div style='font-size:19px;color:var(--hs-text,#2F2F33);white-space:nowrap'>${variables.title||'Thermostat'}</div>`; ]]]"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"padding":"calc(env(safe-area-inset-top) + 10px) 20px 18px"}],"custom_fields":{"back":[{"justify-self":"start"}],"status":[{"justify-self":"start"}],"title":[{"justify-self":"center"}]},"grid":[{"grid-template-areas":"\"back title .\" \"status status status\""},{"grid-template-columns":"1fr auto 1fr"},{"grid-template-rows":"64px auto"}]},"template":"hive_clear","triggers_update":["input_boolean.hive_ha_schedule","climate.hive_thermostat"]},"hive_sched_list":{"custom_fields":{"list":"[[[ const names=['Mon','Tue','Wed','Thu','Fri','Sat','Sun']; const keys=['mon','tue','wed','thu','fri','sat','sun']; let di=names.indexOf(entity.state); if(di<0) di=0; const scheds=Object.keys(states).filter(k=>k.startsWith('switch.')).map(k=>states[k]).filter(s=>Array.isArray(s.attributes.tags)&&s.attributes.tags.includes('hive_heating')); const covers=(s,k)=>{const w=s.attributes.weekdays||[]; return w.includes(k)||w.includes('daily')||(w.includes('workday')&&keys.slice(0,5).includes(k))||(w.includes('weekend')&&(k==='sat'||k==='sun'));}; const val=(a)=>{ if(!a) return 'off'; const d=a.data||a.service_data||{}; if(d.hvac_mode==='off') return 'off'; const t=parseFloat(d.temperature); return (isNaN(t)||t<=7)?'off':t; }; const slots=(i)=>{ const k=keys[(i+7)%7]; const s=scheds.find(x=>x.state!=='off'&&covers(x,k))||scheds.find(x=>covers(x,k)); if(!s) return []; const ts=s.attributes.timeslots||[]; const ac=s.attributes.actions||[]; return ts.map((t,j)=>{ const p=String(t).split(' - '); return {start:p[0].slice(0,5), end:(p[1]||'').slice(0,5), v:val(ac.length>1?ac[j]:ac[0])}; }).sort((a,b)=>a.start.localeCompare(b.start)); }; let cur=slots(di); const prev=slots(di-1); const next=slots(di+1); if(cur.length>1&&cur[0].start==='00:00'&&prev.length&&prev[prev.length-1].v===cur[0].v) cur=cur.slice(1); if(cur.length){ const L=Object.assign({},cur[cur.length-1]); if((L.end==='00:00'||L.end==='23:59'||L.end==='')&&next.length&&next[0].start==='00:00'&&next[0].v===L.v){ L.end=`${next[0].end} (${names[(di+1)%7]})`; } cur[cur.length-1]=L; } if(!cur.length) return `<div style='padding:36px 4px;color:var(--hs-sub,#66666B);font-size:16px;line-height:1.5;text-align:left'>No Home Assistant heating schedule for this day yet.<br>Tap <b>\u2022\u2022\u2022</b> to create one.</div>`; return cur.map(s=>{ const on=s.v!=='off'; const c=on?'#E8642E':'var(--hs-accent2,#7B80EA)'; const txt=on?`${Number(s.v).toFixed(1)}\u00b0`:'Off'; return `<div style='display:flex;align-items:center;gap:26px;padding:12px 0'><div style='width:56px;height:56px;flex:none;border-radius:50%;border:3px solid ${c};box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:${on?15:17}px;color:var(--hs-text,#2F2F33)'>${txt}</div><div style='font-size:19px;color:var(--hs-text,#2F2F33)'>${s.start} - ${s.end}</div></div>`; }).join(''); ]]]"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"padding":"16px 22px 130px"}],"custom_fields":{"list":[{"justify-self":"stretch"}]},"grid":[{"grid-template-areas":"\"list\""},{"grid-template-columns":"1fr"}]},"template":"hive_clear","triggers_update":"all"},"hive_view_schedule":{"icon":"mdi:chevron-right","name":"View Schedule","tap_action":{"action":"navigate","navigation_path":"/hive-heating/schedule"},"template":"hive_pill_link"},"hive_section_title":{"template":"hive_clear","show_name":true,"styles":{"card":[{"padding":"14px 4px 2px"}],"name":[{"font-family":"var(--hs-serif,DM Serif Display, serif)"},{"font-size":"21px"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"},{"font-weight":"var(--hs-serif-w,400)"}]},"extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},"hive_sensor":{"variables":{"name":"","icon":"mdi:thermometer","humidity":""},"show_icon":false,"show_name":false,"show_state":false,"tap_action":{"action":"more-info"},"hold_action":{"action":"none"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"border":"none"},{"padding":"14px 16px 16px"},{"color":"var(--hs-text,#2F2F33)"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"head\" \"temp\""},{"grid-template-columns":"1fr"},{"row-gap":"12px"}],"custom_fields":{"head":[{"justify-self":"stretch"}],"temp":[{"justify-self":"start"}]}},"custom_fields":{"head":"[[[ return `<div style='display:flex;align-items:center;gap:10px'><div style='width:30px;height:30px;border-radius:9px;background:var(--hs-line,#F2F2F5);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='${variables.icon}' style='--mdc-icon-size:17px;color:var(--hs-text,#3A3A3E)'></ha-icon></div><div style='font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left'>${variables.name||entity.attributes.friendly_name}</div></div>`; ]]]","temp":"[[[ const v=parseFloat(entity.state); const hs=variables.humidity?states[variables.humidity]:null; const h=hs?parseFloat(hs.state):NaN; const sub=isNaN(h)?'Actual':`<ha-icon icon='mdi:water-percent' style='--mdc-icon-size:15px;color:var(--hs-accent2,#7B80EA)'></ha-icon>${Math.round(h)}% humidity`; return `<div style='text-align:left'><div style='font-size:34px;font-weight:500;letter-spacing:-0.8px;line-height:1;color:var(--hs-text,#2F2F33)'>${isNaN(v)?'--':v.toFixed(1)}\u00b0</div><div style='font-size:13px;color:var(--hs-sub,#55555B);margin-top:6px;display:flex;align-items:center;gap:4px'>${sub}</div></div>`; ]]]"}}},"kiosk_mode":{"hide_header":true},"views":[{"background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"home","sections":[{"cards":[{"custom_fields":{"away":{"card":{"entity":"input_boolean.heating_away_mode","template":"hive_away","type":"custom:button-card"}},"menu":{"card":{"template":"hive_menu","type":"custom:button-card"}}},"grid_options":{"columns":"full"},"name":"[[[ const h=new Date().getHours(); return h<12?'Good Morning':(h<18?'Good Afternoon':'Good Evening'); ]]]","show_name":true,"styles":{"card":[{"padding":"18px 2px 8px"},{"overflow":"visible"}],"grid":[{"grid-template-areas":"\"n away menu\""},{"grid-template-columns":"1fr auto auto"},{"column-gap":"16px"},{"align-items":"center"}],"name":[{"font-family":"var(--hs-greet,var(--hs-serif,DM Serif Display, serif))"},{"font-size":"var(--hs-greet-size,31px)"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"},{"letter-spacing":"var(--hs-greet-ls,-0.3px)"},{"font-weight":"var(--hs-greet-w,var(--hs-serif-w,400))"},{"white-space":"nowrap"},{"min-width":"0"}]},"template":"hive_clear","triggers_update":["sun.sun"],"type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"type":"custom:button-card","template":"hive_clear","entity":"input_boolean.heating_away_mode","show_icon":true,"icon":"mdi:airplane","show_name":true,"name":"[[[ const t=(states['input_number.hive_away_temperature']||{}).state; return `Away mode is on \u00b7 rooms held at ${t||'\u2013'}\u00b0` + (states['water_heater.hive_hot_water'] ? ', hot water off' : ''); ]]]","tap_action":{"action":"none"},"visibility":[{"condition":"state","entity":"input_boolean.heating_away_mode","state":"on"}],"grid_options":{"columns":"full"},"styles":{"card":[{"padding":"12px 16px"},{"border-radius":"16px"},{"background":"var(--hs-card,#FFFFFF)"},{"border":"1px solid var(--hs-accent,#4350E6)"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto 1fr"},{"column-gap":"10px"},{"align-items":"center"}],"icon":[{"width":"20px"},{"color":"var(--hs-accent,#4350E6)"}],"name":[{"font-size":"15px"},{"font-weight":"500"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"},{"white-space":"normal"},{"text-align":"left"}]},"hs_requires":"hot_water"},{"custom_fields":{"boost":{"card":{"entity":"climate.hive_thermostat","template":"hive_boost_pill","type":"custom:button-card"}}},"entity":"climate.hive_thermostat","grid_options":{"columns":"full"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/thermostat"},"template":"hive_device","type":"custom:button-card","variables":{"icon":"mdi:thermometer","name":"Thermostat"}},{"custom_fields":{"boost":{"card":{"entity":"water_heater.hive_hot_water","template":"hive_boost_pill","type":"custom:button-card"}}},"entity":"water_heater.hive_hot_water","grid_options":{"columns":"full"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/hot-water"},"template":"hive_device","type":"custom:button-card","variables":{"icon":"mdi:faucet","name":"Hot Water"},"hs_requires":"hot_water"},{"custom_fields":{"boost":{"card":{"entity":"climate.bedroom_radiator","template":"hive_boost_pill","type":"custom:button-card"}}},"entity":"climate.bedroom_radiator","grid_options":{"columns":"full"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/bedroom"},"template":"hive_device","type":"custom:button-card","variables":{"icon":"mdi:radiator","name":"Bedroom radiator"},"hs_per_valve":"hive"},{"type":"custom:button-card","template":"hive_device","entity":"climate.study_radiator","variables":{"name":"Study radiator","icon":"mdi:radiator"},"tap_action":{"action":"navigate","navigation_path":"/hive-heating/study"},"custom_fields":{"boost":{"card":{"type":"custom:button-card","template":"hive_boost_pill","entity":"climate.study_radiator"}}},"grid_options":{"columns":"full"},"hs_per_valve":"other"},{"grid_options":{"columns":"full"},"styles":{"card":[{"height":"150px"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"desktop":{"position":"bottom","show_labels":true},"mobile":{"mode":"floating","show_labels":true,"safe_area":true},"routes":[{"icon":"mdi:view-agenda-outline","icon_selected":"mdi:view-agenda","label":"Home","url":"/hive-heating/home"},{"icon":"mdi:chart-line","label":"Insights","url":"/hive-heating/insights"},{"icon":"mdi:calendar-clock","label":"Schedule","url":"/hive-heating/schedule"},{"icon":"mdi:cog-outline","label":"Manage","url":"/hive-heating/manage","icon_selected":"mdi:cog"}],"type":"custom:navbar-card","styles":"\n.navbar {\n  --navbar-primary-color: var(--hs-accent,#4350E6);\n  --navbar-background-color: var(--hs-nav,rgba(255,255,255,0.97));\n  --navbar-border-radius: 34px;\n  --navbar-route-icon-size: 26px;\n  --navbar-box-shadow-mobile-floating: 0 4px 18px rgba(30,30,60,0.12);\n  --navbar-box-shadow-desktop: 0 4px 18px rgba(30,30,60,0.12);\n}\n.navbar-card {\n  background: var(--hs-nav,rgba(255,255,255,0.97)) !important;\n  border: 1px solid var(--hs-line,#E3E3E8) !important;\n  border-radius: 34px !important;\n}\n.navbar .route,\n.navbar .route .button,\n.navbar .route .icon,\n.navbar .route .button .icon {\n  opacity: 1 !important;\n  filter: none !important;\n}\n.navbar .route .icon,\n.navbar .route .button .icon {\n  color: var(--hs-nav-icon,var(--hs-text,#2B2B2E)) !important;\n  --icon-primary-color: var(--hs-nav-icon,var(--hs-text,#2B2B2E)) !important;\n  --mdc-icon-color: var(--hs-nav-icon,var(--hs-text,#2B2B2E));\n}\n.navbar .route .label {\n  color: var(--hs-text,#2B2B2E) !important;\n  opacity: 1 !important;\n  font-family: Inter, sans-serif;\n}\n.navbar .route .button.active {\n  background: var(--hs-nav-active,var(--hs-line,#E9E9EE)) !important;\n}\n.navbar .route .button.active .icon,\n.navbar .route .icon.active,\n.navbar .route .button .icon.active {\n  color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n  --icon-primary-color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n  --mdc-icon-color: var(--hs-nav-accent,var(--hs-accent,#4350E6));\n}\n.navbar .route .label.active {\n  color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n}\n"}],"type":"grid"}],"title":"Home","type":"sections"},{"back_path":"/hive-heating/home","cards":[{"custom_fields":{"actions":{"card":{"cards":[{"template":"hive_view_schedule","type":"custom:button-card"},{"entity":"input_boolean.hive_ha_schedule","template":"hive_advance","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"back":{"card":{"template":"hive_back","type":"custom:button-card"}},"boost":{"card":{"entity":"climate.hive_thermostat","template":"hive_boost_big","type":"custom:button-card"}},"down":{"card":{"entity":"climate.hive_thermostat","template":"hive_arrow_down","type":"custom:button-card"}},"modes":{"card":{"cards":[{"entity":"climate.hive_thermostat","template":"hive_mode_manual","type":"custom:button-card"},{"entity":"climate.hive_thermostat","template":"hive_mode_schedule","type":"custom:button-card"},{"entity":"climate.hive_thermostat","template":"hive_mode_off","type":"custom:button-card"}],"columns":3,"square":false,"type":"grid"}},"tools":{"card":{"cards":[{"icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"},"template":"hive_icon_white","type":"custom:button-card"},{"entity":"climate.hive_thermostat","icon":"mdi:cog-outline","tap_action":{"action":"more-info"},"template":"hive_icon_white","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"up":{"card":{"entity":"climate.hive_thermostat","template":"hive_arrow_up","type":"custom:button-card"}}},"entity":"climate.hive_thermostat","template":"hive_detail","type":"custom:button-card","variables":{"name":"Thermostat"},"hold_action":{"action":"navigate","navigation_path":"/hive-heating/thermostat-picker"}}],"path":"thermostat","subview":true,"title":"Thermostat","type":"panel"},{"back_path":"/hive-heating/home","cards":[{"custom_fields":{"back":{"card":{"template":"hive_back","type":"custom:button-card"}},"boost":{"card":{"entity":"water_heater.hive_hot_water","template":"hive_boost_big","type":"custom:button-card"}},"modes":{"card":{"cards":[{"entity":"water_heater.hive_hot_water","template":"hive_mode_manual","type":"custom:button-card"},{"entity":"water_heater.hive_hot_water","template":"hive_mode_schedule","type":"custom:button-card"},{"entity":"water_heater.hive_hot_water","template":"hive_mode_off","type":"custom:button-card"}],"columns":3,"square":false,"type":"grid"}},"tools":{"card":{"cards":[{"icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"},"template":"hive_icon_white","type":"custom:button-card"},{"entity":"water_heater.hive_hot_water","icon":"mdi:cog-outline","tap_action":{"action":"more-info"},"template":"hive_icon_white","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"actions":{"card":{"type":"grid","columns":1,"square":false,"cards":[{"type":"custom:button-card","template":"hive_view_schedule","tap_action":{"action":"navigate","navigation_path":"/hive-heating/water-schedule"}}]}}},"entity":"water_heater.hive_hot_water","template":"hive_detail","type":"custom:button-card","variables":{"name":"Hot Water"}}],"path":"hot-water","subview":true,"title":"Hot Water","type":"panel","hs_requires":"hot_water"},{"back_path":"/hive-heating/home","cards":[{"custom_fields":{"back":{"card":{"template":"hive_back","type":"custom:button-card"}},"boost":{"card":{"entity":"climate.bedroom_radiator","template":"hive_boost_big","type":"custom:button-card"}},"down":{"card":{"entity":"climate.bedroom_radiator","template":"hive_arrow_down","type":"custom:button-card"}},"modes":{"card":{"cards":[{"entity":"climate.bedroom_radiator","template":"hive_mode_manual","type":"custom:button-card"},{"entity":"climate.bedroom_radiator","template":"hive_mode_schedule","type":"custom:button-card"},{"entity":"climate.bedroom_radiator","template":"hive_mode_off","type":"custom:button-card"}],"columns":3,"square":false,"type":"grid"}},"tools":{"card":{"cards":[{"icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"},"template":"hive_icon_white","type":"custom:button-card"},{"entity":"climate.bedroom_radiator","icon":"mdi:cog-outline","tap_action":{"action":"more-info"},"template":"hive_icon_white","type":"custom:button-card"}],"columns":2,"square":false,"type":"grid"}},"up":{"card":{"entity":"climate.bedroom_radiator","template":"hive_arrow_up","type":"custom:button-card"}},"actions":{"card":{"type":"grid","columns":1,"square":false,"cards":[{"type":"custom:button-card","template":"hive_view_schedule","tap_action":{"action":"navigate","navigation_path":"/hive-heating/bedroom-schedule"}}]}}},"entity":"climate.bedroom_radiator","template":"hive_detail","type":"custom:button-card","variables":{"name":"Bedroom radiator"},"hold_action":{"action":"navigate","navigation_path":"/hive-heating/bedroom-picker"}}],"path":"bedroom","subview":true,"title":"Bedroom radiator","type":"panel","hs_per_valve":"hive"},{"title":"Study radiator","path":"study","type":"panel","subview":true,"back_path":"/hive-heating/home","cards":[{"type":"custom:button-card","template":"hive_detail","entity":"climate.study_radiator","variables":{"name":"Study radiator"},"hold_action":{"action":"navigate","navigation_path":"/hive-heating/study-picker"},"custom_fields":{"back":{"card":{"type":"custom:button-card","template":"hive_back","tap_action":{"action":"navigate","navigation_path":"/hive-heating/home"}}},"tools":{"card":{"type":"grid","columns":2,"square":false,"cards":[{"type":"custom:button-card","template":"hive_icon_white","icon":"mdi:chart-box-outline","tap_action":{"action":"navigate","navigation_path":"/hive-heating/insights"}},{"type":"custom:button-card","template":"hive_icon_white","icon":"mdi:cog-outline","entity":"climate.study_radiator","tap_action":{"action":"more-info"}}]}},"up":{"card":{"type":"custom:button-card","template":"hive_arrow_up","entity":"climate.study_radiator"}},"down":{"card":{"type":"custom:button-card","template":"hive_arrow_down","entity":"climate.study_radiator"}},"boost":{"card":{"type":"custom:button-card","template":"hive_boost_big","entity":"climate.study_radiator"}},"modes":{"card":{"type":"grid","columns":3,"square":false,"cards":[{"type":"custom:button-card","template":"hive_mode_manual","entity":"climate.study_radiator"},{"type":"custom:button-card","template":"hive_mode_schedule","entity":"climate.study_radiator"},{"type":"custom:button-card","template":"hive_mode_off","entity":"climate.study_radiator"}]}},"actions":{"card":{"type":"grid","columns":1,"square":false,"cards":[{"type":"custom:button-card","template":"hive_view_schedule","tap_action":{"action":"navigate","navigation_path":"/hive-heating/study-schedule"}}]}}}}],"hs_per_valve":"other"},{"back_path":"/hive-heating/thermostat","background":"var(--hs-card,#FFFFFF)","cards":[{"type":"custom:hive-schedule-card","entity":"climate.hive_thermostat","title":"Thermostat","tag":"hive_heating","back_path":"/hive-heating/thermostat","edit_path":"/hive-heating/schedule-edit","mode_entity":"input_boolean.hive_ha_schedule","default_temp":18.5}],"path":"schedule","subview":true,"title":"Schedule","type":"panel"},{"back_path":"/hive-heating/schedule","background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"schedule-edit","sections":[{"cards":[{"custom_fields":{"back":{"card":{"tap_action":{"action":"navigate","navigation_path":"/hive-heating/schedule"},"template":"hive_back_dark","type":"custom:button-card"}}},"grid_options":{"columns":"full"},"name":"Edit schedule","show_name":true,"styles":{"card":[{"padding":"14px 2px 6px"}],"grid":[{"grid-template-areas":"\"back n\""},{"grid-template-columns":"auto 1fr"},{"column-gap":"16px"},{"align-items":"center"}],"name":[{"font-family":"var(--hs-serif,DM Serif Display, serif)"},{"font-size":"28px"},{"color":"var(--hs-text,#2B2B2E)"},{"justify-self":"start"},{"font-weight":"var(--hs-serif-w,400)"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"discover_existing":false,"grid_options":{"columns":"full"},"include":["climate.hive_thermostat"],"tags":["hive_heating"],"title":"Thermostat","type":"custom:scheduler-card","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"content":"Schedules shown here carry the tag **hive_heating** \u2014 that's what the Hive-style schedule view reads. Off slots are stored as 7 \u00b0C (Hive's frost setting).","grid_options":{"columns":"full"},"type":"markdown","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}}],"type":"grid"}],"subview":true,"title":"Edit schedule","type":"sections"},{"title":"Hot water schedule","path":"water-schedule","subview":true,"type":"panel","back_path":"/hive-heating/hot-water","background":"var(--hs-card,#FFFFFF)","cards":[{"type":"custom:hive-schedule-card","entity":"water_heater.hive_hot_water","title":"Hot Water","tag":"hive_hot_water","back_path":"/hive-heating/hot-water","mode_entity":"input_boolean.hive_ha_water_schedule"}],"hs_requires":"hot_water"},{"background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"insights","sections":[{"cards":[{"grid_options":{"columns":"full"},"name":"Insights","template":"hive_page_title","type":"custom:button-card"},{"type":"custom:button-card","template":"hive_section_title","name":"Temperatures","grid_options":{"columns":"full"}},{"apex_config":{"chart":{"height":240,"foreColor":"#8E8F9A"},"grid":{"borderColor":"rgba(128,128,140,0.22)"},"legend":{"show":false}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"graph_span":"24h","grid_options":{"columns":"full"},"header":{"colorize_states":true,"show":true,"show_states":true,"title":"Thermostat \u00b7 last 24 h"},"series":[{"color":"#E8642E","entity":"climate.hive_thermostat","group_by":{"duration":"10min","func":"avg"},"name":"Actual","stroke_width":3,"attribute":"current_temperature"},{"color":"#4350E6","curve":"stepline","entity":"climate.hive_thermostat","name":"Target","stroke_width":2,"attribute":"temperature"}],"type":"custom:apexcharts-card"},{"apex_config":{"chart":{"height":240,"foreColor":"#8E8F9A"},"grid":{"borderColor":"rgba(128,128,140,0.22)"},"legend":{"show":true}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"graph_span":"24h","grid_options":{"columns":"full"},"header":{"colorize_states":true,"show":true,"show_states":true,"title":"Rooms \u00b7 last 24 h"},"series":[{"attribute":"current_temperature","color":"#7B80EA","entity":"climate.bedroom_radiator","group_by":{"duration":"10min","func":"avg"},"name":"Bedroom","stroke_width":2,"hs_per_valve":"any"}],"type":"custom:apexcharts-card"},{"grid_options":{"columns":"full"},"styles":{"card":[{"height":"150px"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"desktop":{"position":"bottom","show_labels":true},"mobile":{"mode":"floating","show_labels":true,"safe_area":true},"routes":[{"icon":"mdi:view-agenda-outline","icon_selected":"mdi:view-agenda","label":"Home","url":"/hive-heating/home"},{"icon":"mdi:chart-line","label":"Insights","url":"/hive-heating/insights"},{"icon":"mdi:calendar-clock","label":"Schedule","url":"/hive-heating/schedule"},{"icon":"mdi:cog-outline","label":"Manage","url":"/hive-heating/manage","icon_selected":"mdi:cog"}],"type":"custom:navbar-card","styles":"\n.navbar {\n  --navbar-primary-color: var(--hs-accent,#4350E6);\n  --navbar-background-color: var(--hs-nav,rgba(255,255,255,0.97));\n  --navbar-border-radius: 34px;\n  --navbar-route-icon-size: 26px;\n  --navbar-box-shadow-mobile-floating: 0 4px 18px rgba(30,30,60,0.12);\n  --navbar-box-shadow-desktop: 0 4px 18px rgba(30,30,60,0.12);\n}\n.navbar-card {\n  background: var(--hs-nav,rgba(255,255,255,0.97)) !important;\n  border: 1px solid var(--hs-line,#E3E3E8) !important;\n  border-radius: 34px !important;\n}\n.navbar .route,\n.navbar .route .button,\n.navbar .route .icon,\n.navbar .route .button .icon {\n  opacity: 1 !important;\n  filter: none !important;\n}\n.navbar .route .icon,\n.navbar .route .button .icon {\n  color: var(--hs-nav-icon,var(--hs-text,#2B2B2E)) !important;\n  --icon-primary-color: var(--hs-nav-icon,var(--hs-text,#2B2B2E)) !important;\n  --mdc-icon-color: var(--hs-nav-icon,var(--hs-text,#2B2B2E));\n}\n.navbar .route .label {\n  color: var(--hs-text,#2B2B2E) !important;\n  opacity: 1 !important;\n  font-family: Inter, sans-serif;\n}\n.navbar .route .button.active {\n  background: var(--hs-nav-active,var(--hs-line,#E9E9EE)) !important;\n}\n.navbar .route .button.active .icon,\n.navbar .route .icon.active,\n.navbar .route .button .icon.active {\n  color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n  --icon-primary-color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n  --mdc-icon-color: var(--hs-nav-accent,var(--hs-accent,#4350E6));\n}\n.navbar .route .label.active {\n  color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n}\n"}],"type":"grid"}],"title":"Insights","type":"sections"},{"background":"var(--hs-page,#F4F5FA)","max_columns":1,"path":"manage","sections":[{"cards":[{"grid_options":{"columns":"full"},"name":"Manage","template":"hive_page_title","type":"custom:button-card"},{"entity":"input_boolean.hive_ha_schedule","grid_options":{"columns":"full"},"name":"Home Assistant runs the heating schedule","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"entity":"input_boolean.heating_away_mode","grid_options":{"columns":"full"},"name":"Away / holiday mode","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"entity":"input_number.hive_away_temperature","grid_options":{"columns":"full"},"name":"Away / holiday temperature","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"features":[{"type":"numeric-input","style":"buttons"}]},{"entity":"input_boolean.hive_eco_when_nobody_home","grid_options":{"columns":"full"},"name":"Lower to 16\u00b0 when nobody's home (30 min)","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"entity":"input_boolean.hive_warm_up_approaching","grid_options":{"columns":"full"},"name":"Warm up when approaching home","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"type":"custom:button-card","entity":"input_select.hive_appearance","show_name":false,"show_icon":false,"show_state":false,"tap_action":{"action":"none"},"hold_action":{"action":"none"},"grid_options":{"columns":"full"},"custom_fields":{"t":"[[[ const m = entity.state; const sub = m === 'Noir' ? 'Black and gold, light on wall panels' : m === 'Auto' ? 'Follows each device (phone, tablet) light or dark setting' : (m === 'Dark' ? 'Dark background on every screen' : 'Light background on every screen'); return `<div style='display:flex;align-items:center;gap:14px;text-align:left'><div style='width:42px;height:42px;border-radius:50%;background:var(--hs-line,#ECECF0);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='mdi:theme-light-dark' style='--mdc-icon-size:22px;color:var(--hs-text,#2B2B2E)'></ha-icon></div><div><div style='font-size:17px;font-weight:500;color:var(--hs-text,#2B2B2E)'>Appearance</div><div style='font-size:14px;color:var(--hs-sub,#66666B);margin-top:2px;white-space:normal'>${sub}</div></div></div>`; ]]]","o":{"card":{"type":"horizontal-stack","cards":[{"type":"custom:button-card","entity":"input_select.hive_appearance","name":"Light","icon":"mdi:white-balance-sunny","show_state":false,"layout":"icon_name","tap_action":{"action":"perform-action","perform_action":"input_select.select_option","target":{"entity_id":"input_select.hive_appearance"},"data":{"option":"Light"}},"styles":{"card":[{"height":"46px"},{"border-radius":"14px"},{"box-shadow":"none"},{"border":"none"},{"padding":"0 10px"},{"background":"[[[ return entity.state === 'Light' ? 'var(--hs-accent,#4350E6)' : 'var(--hs-line,#ECECF0)'; ]]]"}],"name":[{"font-family":"Inter, sans-serif"},{"font-size":"15px"},{"font-weight":"500"},{"color":"[[[ return entity.state === 'Light' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"icon":[{"width":"18px"},{"color":"[[[ return entity.state === 'Light' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}]}},{"type":"custom:button-card","entity":"input_select.hive_appearance","name":"Dark","icon":"mdi:weather-night","show_state":false,"layout":"icon_name","tap_action":{"action":"perform-action","perform_action":"input_select.select_option","target":{"entity_id":"input_select.hive_appearance"},"data":{"option":"Dark"}},"styles":{"card":[{"height":"46px"},{"border-radius":"14px"},{"box-shadow":"none"},{"border":"none"},{"padding":"0 10px"},{"background":"[[[ return entity.state === 'Dark' ? 'var(--hs-accent,#4350E6)' : 'var(--hs-line,#ECECF0)'; ]]]"}],"name":[{"font-family":"Inter, sans-serif"},{"font-size":"15px"},{"font-weight":"500"},{"color":"[[[ return entity.state === 'Dark' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"icon":[{"width":"18px"},{"color":"[[[ return entity.state === 'Dark' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}]}},{"type":"custom:button-card","entity":"input_select.hive_appearance","name":"Auto","icon":"mdi:theme-light-dark","show_state":false,"layout":"icon_name","tap_action":{"action":"perform-action","perform_action":"input_select.select_option","target":{"entity_id":"input_select.hive_appearance"},"data":{"option":"Auto"}},"styles":{"card":[{"height":"46px"},{"border-radius":"14px"},{"box-shadow":"none"},{"border":"none"},{"padding":"0 10px"},{"background":"[[[ return entity.state === 'Auto' ? 'var(--hs-accent,#4350E6)' : 'var(--hs-line,#ECECF0)'; ]]]"}],"name":[{"font-family":"Inter, sans-serif"},{"font-size":"15px"},{"font-weight":"500"},{"color":"[[[ return entity.state === 'Auto' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"icon":[{"width":"18px"},{"color":"[[[ return entity.state === 'Auto' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}]}},{"type":"custom:button-card","entity":"input_select.hive_appearance","name":"Noir","icon":"mdi:star-four-points-outline","show_state":false,"layout":"icon_name","tap_action":{"action":"perform-action","perform_action":"input_select.select_option","target":{"entity_id":"input_select.hive_appearance"},"data":{"option":"Noir"}},"styles":{"card":[{"height":"46px"},{"border-radius":"14px"},{"box-shadow":"none"},{"border":"none"},{"padding":"0 10px"},{"background":"[[[ return entity.state === 'Noir' ? 'var(--hs-accent,#4350E6)' : 'var(--hs-line,#ECECF0)'; ]]]"}],"name":[{"font-family":"Inter, sans-serif"},{"font-size":"15px"},{"font-weight":"500"},{"color":"[[[ return entity.state === 'Noir' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"icon":[{"width":"18px"},{"color":"[[[ return entity.state === 'Noir' ? '#FFFFFF' : 'var(--hs-text,#2B2B2E)'; ]]]"}],"grid":[{"grid-template-areas":"\"i n\""},{"grid-template-columns":"auto auto"},{"justify-content":"center"},{"column-gap":"6px"}]}}]}}},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"border":"none"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"padding":"16px"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"t\" \"o\""},{"grid-template-columns":"1fr"},{"row-gap":"14px"}],"custom_fields":{"t":[{"justify-self":"stretch"}],"o":[{"justify-self":"stretch"}]}}},{"type":"custom:button-card","entity":"climate.hive_thermostat","show_icon":false,"show_name":false,"show_state":false,"tap_action":{"action":"navigate","navigation_path":"/hive-heating/thermostat"},"hold_action":{"action":"more-info"},"triggers_update":["input_boolean.hive_ha_schedule","input_boolean.heating_away_eco_active"],"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"border":"none"},{"padding":"16px"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"head\" \"modes\""},{"grid-template-columns":"1fr"},{"row-gap":"14px"}],"custom_fields":{"head":[{"justify-self":"stretch"}],"modes":[{"justify-self":"stretch"},{"background":"var(--hs-modebar,#F1F2FB)"},{"border-radius":"24px"},{"padding":"4px"}]}},"custom_fields":{"head":"[[[ const st=entity.state; const hs=states['input_boolean.hive_ha_schedule']; const ha=!!(hs&&hs.state==='on');\nconst cur=parseFloat(entity.attributes.current_temperature); const t=parseFloat(entity.attributes.temperature);\nlet mode, col='var(--hs-sub,#55555B)', warn='';\nif(st==='off'){ mode='Off'; }\nelse if(st==='heat' && ha && states['input_boolean.heating_away_eco_active'] && states['input_boolean.heating_away_eco_active'].state==='on'){ mode='Away eco \u2013 nobody home'; col='#2E9E5B'; }\nelse if(st==='heat' && ha){ mode='Schedule (Home Assistant)'; col='var(--hs-accent,#4350E6)'; }\nelse if(st==='auto'){ mode=\"Hive's own schedule\"; col='#D9342B'; warn=`<div style='font-size:12px;color:#D9342B;margin-top:4px'>Tap Schedule to hand control back to Home Assistant</div>`; }\nelse { mode='Manual'; }\nlet tgt='';\nif(st!=='off' && !isNaN(t)) tgt = t<=7 ? ' \u00b7 off until next slot' : ` \u00b7 target ${t.toFixed(1)}\u00b0`;\nconst heating = ((s=>s?s.state==='on':entity.attributes.hvac_action==='heating')((hass.entities&&(hass.entities[entity.entity_id]||{}).platform==='hive')?states['binary_sensor.'+entity.entity_id.split('.')[1]+'_state']:null)) ? `<ha-icon icon='mdi:fire' style='--mdc-icon-size:16px;color:#E8642E;margin-left:4px'></ha-icon>` : '';\nreturn `<div style='display:flex;align-items:center;gap:12px;text-align:left'><div style='width:40px;height:40px;border-radius:50%;background:var(--hs-line,#F2F2F5);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='mdi:thermostat' style='--mdc-icon-size:22px;color:var(--hs-text,#3A3A3E)'></ha-icon></div><div style='flex:1;min-width:0'><div style='font-size:17px;font-weight:500;color:var(--hs-text,#2F2F33)'>Thermostat</div><div style='font-size:14px;color:${col};display:flex;align-items:center;flex-wrap:wrap'>${mode}<span style='color:var(--hs-sub,#55555B)'>&nbsp;\u00b7 ${isNaN(cur)?'--':cur.toFixed(1)}\u00b0${tgt}</span>${heating}</div>${warn}</div></div>`; ]]]","modes":{"card":{"type":"grid","columns":3,"square":false,"cards":[{"type":"custom:button-card","template":"hive_mode_manual","entity":"climate.hive_thermostat"},{"type":"custom:button-card","template":"hive_mode_schedule","entity":"climate.hive_thermostat"},{"type":"custom:button-card","template":"hive_mode_off","entity":"climate.hive_thermostat"}]}}},"grid_options":{"columns":"full"}},{"entity":"water_heater.hive_hot_water","features":[{"type":"water-heater-operation-modes"}],"grid_options":{"columns":"full"},"name":"Hot Water","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_requires":"hot_water"},{"entity":"climate.bedroom_radiator","grid_options":{"columns":6},"name":"Bedroom radiator","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_per_valve":"hive"},{"entity":"climate.study_radiator","grid_options":{"columns":6},"name":"Study radiator","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_per_valve":"other"},{"entity":"binary_sensor.hive_hub_status","grid_options":{"columns":6},"name":"Hive hub","type":"tile","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"hs_requires":"hub"},{"type":"custom:button-card","show_name":false,"show_icon":false,"show_state":false,"tap_action":{"action":"none"},"hold_action":{"action":"none"},"grid_options":{"columns":"full"},"triggers_update":["sensor.hive_thermostat_battery_level","sensor.bedroom_radiator_battery_level","sensor.study_radiator_battery"],"custom_fields":{"list":"[[[ const findBatt = (eid, override) => { if (override) return override; const e = hass.entities && hass.entities[eid]; if (!e || !e.device_id) return null; for (const x of Object.values(hass.entities)) { if (x.device_id === e.device_id) { const s = states[x.entity_id]; if (s && s.attributes.device_class === 'battery' && !isNaN(parseFloat(s.state))) return x.entity_id; } } return null; }; const items = variables.items || []; let h = `<div style='display:flex;align-items:center;gap:14px;text-align:left;margin-bottom:6px'><div style='width:42px;height:42px;border-radius:50%;background:var(--hs-line,#ECECF0);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='mdi:battery-heart-variant' style='--mdc-icon-size:22px;color:var(--hs-text,#2B2B2E)'></ha-icon></div><div><div style='font-size:17px;font-weight:500;color:var(--hs-text,#2B2B2E)'>Batteries</div><div style='font-size:14px;color:var(--hs-sub,#66666B);margin-top:2px'>Valves and thermostat</div></div></div>`; items.forEach(([n, eid, ov]) => { if (!states[eid]) return; const bid = findBatt(eid, ov); const b = bid && states[bid] ? parseFloat(states[bid].state) : NaN; const r = isNaN(b) ? null : Math.round(b); const col = r === null ? 'var(--hs-sub,#9A9AA2)' : (r < 15 ? '#D9342B' : (r < 30 ? '#E8A33A' : '#2E9E5B')); const lvl = r === null ? 0 : Math.min(100, Math.max(10, Math.round(r / 10) * 10)); const ic = r === null ? 'mdi:battery-unknown' : (r < 15 ? 'mdi:battery-alert-variant-outline' : (lvl === 100 ? 'mdi:battery' : 'mdi:battery-' + lvl)); h += `<div style='display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--hs-line,#EFEFF3)'><ha-icon icon='${ic}' style='--mdc-icon-size:22px;color:${col};flex:none'></ha-icon><div style='flex:1;min-width:0;text-align:left;font-size:15px;color:var(--hs-text,#2B2B2E)'>${n}</div><div style='width:90px;height:6px;border-radius:3px;background:var(--hs-line,#ECECF0);overflow:hidden;flex:none'><div style='height:100%;width:${r === null ? 0 : r}%;background:${col}'></div></div><div style='width:44px;text-align:right;font-size:15px;font-weight:500;color:${col}'>${r === null ? '--' : r + '%'}</div></div>`; }); return h; ]]]"},"styles":{"card":[{"background":"var(--hs-card,#FFFFFF)"},{"border-radius":"20px"},{"border":"none"},{"box-shadow":"0 1px 8px rgba(40,40,80,0.06)"},{"padding":"16px 16px 6px"},{"font-family":"Inter, sans-serif"}],"grid":[{"grid-template-areas":"\"list\""},{"grid-template-columns":"1fr"}],"custom_fields":{"list":[{"justify-self":"stretch"}]}},"variables":{"items":[["Thermostat","climate.hive_thermostat","sensor.hive_thermostat_battery_level"],["Bedroom radiator","climate.bedroom_radiator",""],["Study radiator","climate.study_radiator",""]]},"hs_batteries":true},{"type":"button","name":"Heating setup (thermostat, hot water, valves)","icon":"mdi:cog-refresh-outline","show_name":true,"show_icon":true,"show_state":false,"icon_height":"28px","tap_action":{"action":"navigate","navigation_path":"/hive-heating/setup"},"grid_options":{"columns":"full"},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"type":"button","name":"Edit heating schedule","icon":"mdi:calendar-edit","show_name":true,"show_icon":true,"show_state":false,"icon_height":"28px","tap_action":{"action":"navigate","navigation_path":"/hive-heating/schedule-edit"},"grid_options":{"columns":6},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"type":"button","name":"Hive integration","icon":"mdi:hexagon-outline","show_name":true,"show_icon":true,"show_state":false,"icon_height":"28px","tap_action":{"action":"navigate","navigation_path":"/config/integrations/integration/hive"},"grid_options":{"columns":6},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); --state-inactive-color: var(--hs-sub,#9A9AA2); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"}},{"grid_options":{"columns":"full"},"styles":{"card":[{"height":"150px"}]},"template":"hive_clear","type":"custom:button-card","extra_styles":"ha-card { background: none !important; background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; } #ripple, ha-ripple, mwc-ripple { display: none !important; } ha-card::before, ha-card::after { content: none !important; display: none !important; background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: none !important; box-shadow: none !important; } :host { background: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; border: none !important; }"},{"desktop":{"position":"bottom","show_labels":true},"mobile":{"mode":"floating","show_labels":true,"safe_area":true},"routes":[{"icon":"mdi:view-agenda-outline","icon_selected":"mdi:view-agenda","label":"Home","url":"/hive-heating/home"},{"icon":"mdi:chart-line","label":"Insights","url":"/hive-heating/insights"},{"icon":"mdi:calendar-clock","label":"Schedule","url":"/hive-heating/schedule"},{"icon":"mdi:cog-outline","label":"Manage","url":"/hive-heating/manage","icon_selected":"mdi:cog"}],"type":"custom:navbar-card","styles":"\n.navbar {\n  --navbar-primary-color: var(--hs-accent,#4350E6);\n  --navbar-background-color: var(--hs-nav,rgba(255,255,255,0.97));\n  --navbar-border-radius: 34px;\n  --navbar-route-icon-size: 26px;\n  --navbar-box-shadow-mobile-floating: 0 4px 18px rgba(30,30,60,0.12);\n  --navbar-box-shadow-desktop: 0 4px 18px rgba(30,30,60,0.12);\n}\n.navbar-card {\n  background: var(--hs-nav,rgba(255,255,255,0.97)) !important;\n  border: 1px solid var(--hs-line,#E3E3E8) !important;\n  border-radius: 34px !important;\n}\n.navbar .route,\n.navbar .route .button,\n.navbar .route .icon,\n.navbar .route .button .icon {\n  opacity: 1 !important;\n  filter: none !important;\n}\n.navbar .route .icon,\n.navbar .route .button .icon {\n  color: var(--hs-nav-icon,var(--hs-text,#2B2B2E)) !important;\n  --icon-primary-color: var(--hs-nav-icon,var(--hs-text,#2B2B2E)) !important;\n  --mdc-icon-color: var(--hs-nav-icon,var(--hs-text,#2B2B2E));\n}\n.navbar .route .label {\n  color: var(--hs-text,#2B2B2E) !important;\n  opacity: 1 !important;\n  font-family: Inter, sans-serif;\n}\n.navbar .route .button.active {\n  background: var(--hs-nav-active,var(--hs-line,#E9E9EE)) !important;\n}\n.navbar .route .button.active .icon,\n.navbar .route .icon.active,\n.navbar .route .button .icon.active {\n  color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n  --icon-primary-color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n  --mdc-icon-color: var(--hs-nav-accent,var(--hs-accent,#4350E6));\n}\n.navbar .route .label.active {\n  color: var(--hs-nav-accent,var(--hs-accent,#4350E6)) !important;\n}\n"}],"type":"grid"}],"title":"Manage","type":"sections"},{"title":"Thermostat temperature","path":"thermostat-picker","type":"panel","subview":true,"back_path":"/hive-heating/thermostat","cards":[{"type":"custom:hive-temp-picker","entity":"climate.hive_thermostat","name":"Thermostat","back_path":"/hive-heating/thermostat","insights_path":"/hive-heating/insights"}]},{"title":"Bedroom radiator temperature","path":"bedroom-picker","type":"panel","subview":true,"back_path":"/hive-heating/bedroom","cards":[{"type":"custom:hive-temp-picker","entity":"climate.bedroom_radiator","name":"Bedroom radiator","back_path":"/hive-heating/bedroom","insights_path":"/hive-heating/insights"}],"hs_per_valve":"hive"},{"title":"Study radiator temperature","path":"study-picker","type":"panel","subview":true,"back_path":"/hive-heating/study","cards":[{"type":"custom:hive-temp-picker","entity":"climate.study_radiator","name":"Study radiator","back_path":"/hive-heating/study","insights_path":"/hive-heating/insights"}],"hs_per_valve":"other"},{"title":"Bedroom schedule","path":"bedroom-schedule","type":"panel","subview":true,"back_path":"/hive-heating/bedroom","background":"var(--hs-card,#FFFFFF)","cards":[{"type":"custom:hive-schedule-card","entity":"climate.bedroom_radiator","title":"Bedroom","tag":"hive_room_bedroom_radiator","house_tag":"hive_heating","back_path":"/hive-heating/bedroom","edit_path":"","mode_entity":"input_boolean.hive_room_schedule_bedroom_radiator","default_temp":18}],"hs_per_valve":"hive"},{"title":"Study schedule","path":"study-schedule","type":"panel","subview":true,"back_path":"/hive-heating/study","background":"var(--hs-card,#FFFFFF)","cards":[{"type":"custom:hive-schedule-card","entity":"climate.study_radiator","title":"Study","tag":"hive_room_study_radiator","house_tag":"hive_heating","back_path":"/hive-heating/study","edit_path":"","mode_entity":"input_boolean.hive_room_schedule_study_radiator","default_temp":18}],"hs_per_valve":"other"},{"title":"Heating setup","path":"setup","subview":true,"back_path":"/hive-heating/manage","type":"sections","max_columns":1,"background":"var(--hs-page,#F4F5FA)","sections":[{"type":"grid","cards":[{"type":"custom:hive-setup-card","grid_options":{"columns":"full"}}]}]}]};
const HS_PACKAGE = {"input_boolean":{"hive_ha_schedule":{"name":"Home Assistant runs the heating schedule","icon":"mdi:calendar-clock"},"heating_away_mode":{"name":"Away / holiday mode","icon":"mdi:airplane"},"hive_eco_when_nobody_home":{"name":"Lower to 16\u00b0 when nobody's home (30 min)","icon":"mdi:home-export-outline"},"hive_warm_up_approaching":{"name":"Warm up when approaching home","icon":"mdi:home-import-outline"},"hive_away_eco_active":{"name":"Heating lowered - nobody home","icon":"mdi:leaf"},"hive_ha_water_schedule":{"name":"Home Assistant runs the hot water schedule","icon":"mdi:water-boiler-auto"},"hive_room_schedule_study_radiator":{"name":"Study radiator follows the heating schedule","icon":"mdi:calendar-sync"}},"input_select":{"hive_appearance":{"name":"Heating dashboard appearance","icon":"mdi:theme-light-dark","options":["Light","Dark","Auto","Noir"]}},"input_number":{"hive_away_temperature":{"name":"Away / holiday temperature","icon":"mdi:snowflake-thermometer","min":7,"max":18,"step":0.5,"unit_of_measurement":"\u00b0C","mode":"slider"}},"script":{"hive_boost":{"alias":"Hive - toggle boost","description":"Starts a boost, or cancels it if one is running. Hive thermostat and hot water use Hive's own boost. Hive radiator valves use Hive's boost but are cancelled by restoring a snapshot (the Hive integration's boost_heating_off fails on TRVs). Other valves are boosted by Home Assistant with timer.boost_<object id>. When the Hive integration has no boost actions (the dashboard sends ha_boost: true), Hive devices are boosted by Home Assistant the same way. (Managed by Hive-style heating setup.)","icon":"mdi:bullseye","mode":"parallel","fields":{"entity_id":{"name":"Entity","required":true,"selector":{"entity":{"domain":["climate","water_heater"]}}},"minutes":{"name":"Minutes","default":60,"selector":{"number":{"min":30,"max":360,"step":30}}},"temperature":{"name":"Temperature","default":21,"selector":{"number":{"min":7,"max":30,"step":0.5}}},"cancel_only":{"name":"Only cancel","description":"Cancel a running boost, but never start one (used by Away mode).","default":false,"selector":{"boolean":{}}},"ha_boost":{"name":"Home Assistant boost","description":"Boost with a Home Assistant timer even on Hive devices (for when Hive's boost actions are missing).","default":false,"selector":{"boolean":{}}}},"sequence":[{"variables":{"temp":"{{ temperature | default(21) | float }}","period":"{{ '%02d:%02d:00' % ((minutes | default(60) | int) // 60, (minutes | default(60) | int) % 60) }}","is_water":"{{ entity_id.startswith('water_heater.') }}","is_main":"{{ entity_id == 'climate.hive_thermostat' }}","is_hive":"{{ (entity_id.startswith('water_heater.') or entity_id in integration_entities('hive')) and not (ha_boost | default(false) | bool) }}","key":"{{ ('water_' if entity_id.startswith('water_heater.') else '') ~ entity_id.split('.')[1] }}","boost_timer":"timer.boost_{{ key }}","restore_scene":"scene.hive_boost_{{ key }}","restore_scene_id":"hive_boost_{{ key }}","boosting":"{% if is_state(boost_timer, 'active') %}true {% elif entity_id == 'climate.hive_thermostat' %}{{ is_state('binary_sensor.hive_thermostat_boost', 'on') }} {% elif entity_id == 'water_heater.hive_hot_water' %}{{ is_state('binary_sensor.hive_hot_water_boost', 'on') }} {% elif entity_id in integration_entities('hive') %}{{ is_state_attr(entity_id, 'preset_mode', 'boost') }} {% else %}{{ is_state('timer.boost_' ~ entity_id.split('.')[1], 'active') }}{% endif %}"}},{"if":"{{ (cancel_only | default(false) | bool) and not (boosting | bool) }}","then":[{"stop":"Nothing to cancel"}]},{"choose":[{"alias":"Hot water","conditions":"{{ is_water and is_hive }}","sequence":[{"action":"hive.boost_hot_water","data":{"entity_id":"{{ entity_id }}","time_period":"{{ period }}","on_off":"{{ 'off' if boosting else 'on' }}"}}]},{"alias":"Main thermostat boosting - cancel","conditions":"{{ boosting and is_main and is_hive }}","sequence":[{"action":"hive.boost_heating_off","data":{"entity_id":"{{ entity_id }}"}}]},{"alias":"Non-Hive valve boosting - cancel","conditions":"{{ boosting and not is_hive }}","sequence":[{"action":"timer.cancel","target":{"entity_id":"{{ boost_timer }}"}},{"if":"{{ restore_scene in (states.scene | map(attribute='entity_id') | list) }}","then":[{"action":"scene.turn_on","target":{"entity_id":"{{ restore_scene }}"}}],"else":[{"if":"{{ is_water }}","then":[{"action":"water_heater.set_operation_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"operation_mode":"off"}},{"stop":"Hot water boost cancelled"}]},{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"off"}}]}]},{"alias":"Hive radiator valve boosting - cancel by restoring the snapshot","conditions":"{{ boosting }}","sequence":[{"if":"{{ restore_scene in (states.scene | map(attribute='entity_id') | list) }}","then":[{"action":"scene.turn_on","target":{"entity_id":"{{ restore_scene }}"}}],"else":[{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"off"}}]}]},{"alias":"Non-Hive valve - start a Home Assistant boost","conditions":"{{ not is_hive }}","sequence":[{"action":"scene.create","data":{"scene_id":"{{ restore_scene_id }}","snapshot_entities":["{{ entity_id }}"]}},{"if":"{{ is_water }}","then":[{"action":"water_heater.set_operation_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"operation_mode":"on"}}],"else":[{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"heat"}},{"action":"climate.set_temperature","target":{"entity_id":"{{ entity_id }}"},"data":{"temperature":"{{ temp }}"}}]},{"action":"timer.start","target":{"entity_id":"{{ boost_timer }}"},"data":{"duration":"{{ period }}"}}]}],"default":[{"if":"{{ not is_main }}","then":[{"action":"scene.create","data":{"scene_id":"{{ restore_scene_id }}","snapshot_entities":["{{ entity_id }}"]}}]},{"action":"hive.boost_heating_on","target":{"entity_id":"{{ entity_id }}"},"data":{"time_period":"{{ period }}","temperature":"{{ temp }}"}}]},{"alias":"Boost cancelled on a room that's on Schedule - catch up with the schedule","if":"{{ boosting and entity_id.startswith('climate.') and is_state('input_boolean.hive_room_schedule_' ~ entity_id.split('.')[1], 'on') }}","then":[{"delay":{"seconds":5}},{"action":"script.hive_rooms_follow_schedule","data":{"only":"{{ entity_id }}"}}]}]},"hive_adjust_target":{"alias":"Hive - nudge target temperature","description":"Moves the target by delta, clamped to the device's range. Kept for automations and voice; the dashboard arrows use the card's write gate instead (one change after you stop tapping), because Hive blocks bursts of changes. Don't call this many times in a row. (Managed by Hive-style heating setup.)","icon":"mdi:thermometer-plus","mode":"queued","max":10,"fields":{"entity_id":{"name":"Entity","required":true,"selector":{"entity":{"domain":"climate"}}},"delta":{"name":"Delta","default":0.5,"selector":{"number":{"min":-5,"max":5,"step":0.5}}}},"sequence":[{"action":"climate.set_temperature","target":{"entity_id":"{{ entity_id }}"},"data":{"temperature":"{{ [[ (state_attr(entity_id, 'temperature') | float(18)) + (delta | float(0.5)),\n      state_attr(entity_id, 'min_temp') | float(5) ] | max,\n    state_attr(entity_id, 'max_temp') | float(32) ] | min }}"}},{"delay":{"milliseconds":700}}]},"hive_set_mode":{"alias":"Hive - set mode (Manual / Schedule / Off)","description":"For the main thermostat, Schedule hands control to the Home Assistant schedule once a schedule tagged hive_heating exists; otherwise it falls back to Hive's own schedule. For a radiator, Schedule makes the room follow the main heating schedule's temperature (input_boolean.hive_room_schedule_<valve>); without a Home Assistant schedule it uses the valve's own schedule. (Managed by Hive-style heating setup.)","icon":"mdi:thermostat-cog","mode":"queued","fields":{"entity_id":{"name":"Entity","required":true,"selector":{"entity":{"domain":["climate","water_heater"]}}},"mode":{"name":"Mode","required":true,"selector":{"select":{"options":["manual","schedule","off"]}}}},"sequence":[{"variables":{"is_main":"{{ entity_id == 'climate.hive_thermostat' }}","room_flag":"input_boolean.hive_room_schedule_{{ entity_id.split('.')[1] }}","ha_schedule_ready":"{{ states.switch | selectattr('attributes.tags', 'defined')\n   | selectattr('attributes.tags', 'contains', 'hive_heating') | list | count > 0 }}","ha_water_ready":"{{ states.switch | selectattr('attributes.tags', 'defined')\n   | selectattr('attributes.tags', 'contains', 'hive_hot_water') | list | count > 0 }}"}},{"choose":[{"alias":"Hot water on the Home Assistant schedule","conditions":"{{ entity_id.startswith('water_heater.') and mode == 'schedule' and ha_water_ready }}","sequence":[{"action":"input_boolean.turn_on","target":{"entity_id":"input_boolean.hive_ha_water_schedule"}},{"action":"script.hive_apply_water_schedule_now"}]},{"alias":"Hot water","conditions":"{{ entity_id.startswith('water_heater.') }}","sequence":[{"action":"input_boolean.turn_off","target":{"entity_id":"input_boolean.hive_ha_water_schedule"}},{"action":"water_heater.set_operation_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"operation_mode":"{{ {'manual': 'on', 'schedule': 'eco', 'off': 'off'}[mode] }}"}}]},{"alias":"Main thermostat on the Home Assistant schedule","conditions":"{{ is_main and mode == 'schedule' and ha_schedule_ready }}","sequence":[{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"heat"}},{"action":"input_boolean.turn_on","target":{"entity_id":"input_boolean.hive_ha_schedule"}},{"action":"script.hive_apply_schedule_now"}]},{"alias":"Radiator follows the Home Assistant heating schedule","conditions":"{{ not is_main and entity_id.startswith('climate.') and mode == 'schedule' and ha_schedule_ready and states(room_flag) in ['on', 'off'] }}","sequence":[{"action":"input_boolean.turn_on","target":{"entity_id":"{{ room_flag }}"}},{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"heat"}},{"action":"script.hive_rooms_follow_schedule","data":{"only":"{{ entity_id }}"}}]}],"default":[{"if":"{{ is_main }}","then":[{"action":"input_boolean.turn_off","target":{"entity_id":"input_boolean.hive_ha_schedule"}}]},{"if":"{{ not is_main and is_state(room_flag, 'on') }}","then":[{"action":"input_boolean.turn_off","target":{"entity_id":"{{ room_flag }}"}}]},{"alias":"Valve without an Off mode (e.g. Hive valve on Zigbee2MQTT) - Off sets frost protection","if":"{{ mode == 'off' and 'off' not in (state_attr(entity_id, 'hvac_modes') or ['off']) }}","then":[{"action":"climate.set_temperature","target":{"entity_id":"{{ entity_id }}"},"data":{"temperature":"{{ state_attr(entity_id, 'min_temp') | float(5) }}"}}],"else":[{"action":"climate.set_hvac_mode","target":{"entity_id":"{{ entity_id }}"},"data":{"hvac_mode":"{% set m = {'manual': 'heat', 'schedule': 'auto', 'off': 'off'}[mode] %}{{ m if m in (state_attr(entity_id, 'hvac_modes') or [m]) else 'heat' }}"}}]}]}]},"hive_apply_schedule_now":{"alias":"Hive - apply current schedule slot now","description":"Re-applies today's Home Assistant schedule slot (schedules tagged hive_heating). (Managed by Hive-style heating setup.)","icon":"mdi:calendar-sync","mode":"single","sequence":[{"alias":"Not while Away / holiday mode is on","condition":"state","entity_id":"input_boolean.heating_away_mode","state":"off"},{"condition":"state","entity_id":"input_boolean.hive_ha_schedule","state":"on"},{"variables":{"day":"{{ now().strftime('%a') | lower }}","sched":"{% set ns = namespace(single='', any='') %} {% for s in states.switch | selectattr('attributes.tags', 'defined')\n     | selectattr('attributes.tags', 'contains', 'hive_heating') | rejectattr('state', 'in', ['off', 'unavailable', 'unknown']) %}\n  {% set w = s.attributes.weekdays | default([]) %}\n  {% if day in w or 'daily' in w %}\n    {% if w | count == 1 %}{% set ns.single = s.entity_id %}{% else %}{% set ns.any = s.entity_id %}{% endif %}\n  {% endif %}\n{% endfor %}{{ ns.single or ns.any }}"}},{"condition":"template","value_template":"{{ sched != '' }}"},{"action":"scheduler.run_action","data":{"entity_id":"{{ sched }}","time":"{{ now().strftime('%H:%M:%S') }}"}}]},"hive_rooms_follow_schedule":{"alias":"Hive - rooms on Schedule follow the heating schedule","description":"Sets every radiator that's on Schedule (input_boolean.hive_room_schedule_<valve> on) to its current schedule slot: the room's own schedule (schedules tagged hive_room_<valve>) if it has times for today, otherwise the house heating schedule (tagged hive_heating). Leaves alone rooms that are off or boosting. A room you nudge keeps your change until the next schedule slot, like Hive. (Managed by Hive-style heating setup.)","icon":"mdi:home-thermometer","mode":"restart","fields":{"only":{"name":"Only this radiator","description":"Leave empty for every room on Schedule.","selector":{"entity":{"domain":"climate"}}},"include_own":{"name":"Include rooms with their own schedule","description":"Rooms with their own times normally change on their own slots; turn on to set them now too.","default":false,"selector":{"boolean":null}}},"sequence":[{"alias":"Not while Away / holiday mode is on","condition":"state","entity_id":"input_boolean.heating_away_mode","state":"off"},{"condition":"state","entity_id":"input_boolean.hive_ha_schedule","state":"on"},{"variables":{"rooms":"{%- macro slot(tag) -%} {%- set day = now().strftime('%a') | lower -%} {%- set t = now().strftime('%H:%M') -%} {%- set ns = namespace(single=none, any=none, temp='') -%} {%- for s in states.switch | selectattr('attributes.tags', 'defined') | selectattr('attributes.tags', 'contains', tag) | rejectattr('state', 'in', ['off', 'unavailable', 'unknown']) -%}\n  {%- set w = s.attributes.weekdays | default([]) -%}\n  {%- if day in w or 'daily' in w or ('workday' in w and day in ['mon','tue','wed','thu','fri']) or ('weekend' in w and day in ['sat','sun']) -%}\n    {%- if w | count == 1 and w[0] == day -%}{%- set ns.single = s -%}{%- else -%}{%- set ns.any = s -%}{%- endif -%}\n  {%- endif -%}\n{%- endfor -%} {%- set sw = ns.single or ns.any -%} {%- if sw -%}{%- for sl in sw.attributes.timeslots | default([]) -%}\n  {%- set a = sl.split(' - ') -%}{%- set stop = '24:00' if a[1] == '00:00' else a[1] -%}\n  {%- if a[0] <= t < stop -%}\n    {%- set acts = sw.attributes.actions | default([]) -%}\n    {%- set act = acts[loop.index0] if acts | count > 1 else acts[0] -%}\n    {%- set ns.temp = (act.data or act.service_data or {}).temperature -%}\n  {%- endif -%}\n{%- endfor -%}{%- endif -%} {{- ns.temp -}} {%- endmacro -%} {%- set house = slot('hive_heating') -%} {%- set ns2 = namespace(r=[]) -%} {%- for b in states.input_boolean | selectattr('state', 'eq', 'on') -%}\n  {%- if b.object_id.startswith('hive_room_schedule_') -%}\n    {%- set o = b.object_id[19:] -%}{%- set e = 'climate.' ~ o -%}{%- set st = states[e] -%}\n    {%- if st and st.state not in ['off', 'unavailable', 'unknown'] and (not (only | default('')) or e == only)\n          and st.attributes.preset_mode | default('') != 'boost' and not is_state('timer.boost_' ~ o, 'active') -%}\n      {%- set own = slot('hive_room_' ~ o) -%}\n      {%- set tt = own if own != '' else house -%}\n      {%- if tt != '' and (own == '' or (only | default('')) or (include_own | default(false))) -%}{%- set ns2.r = ns2.r + [[e, tt | float, own != '']] -%}{%- endif -%}\n    {%- endif -%}\n  {%- endif -%}\n{%- endfor -%} {{ ns2.r }}"}},{"repeat":{"for_each":"{{ rooms }}","sequence":[{"variables":{"t":"{{ [[repeat.item[1] | float, state_attr(repeat.item[0], 'min_temp') | float(5)] | max,\n    state_attr(repeat.item[0], 'max_temp') | float(32)] | min }}"}},{"if":"{{ (state_attr(repeat.item[0], 'temperature') | float(-1)) != t }}","then":[{"action":"climate.set_temperature","target":{"entity_id":"{{ repeat.item[0] }}"},"data":{"temperature":"{{ t }}"},"continue_on_error":true},{"delay":{"seconds":"{{ 4 if repeat.item[0] in integration_entities('hive') else 0 }}"}}]}]}}]},"hive_apply_water_schedule_now":{"alias":"Hive - apply current hot water slot now","description":"Re-applies today's Home Assistant hot water schedule slot (schedules tagged hive_hot_water). (Managed by Hive-style heating setup.)","icon":"mdi:water-boiler-auto","mode":"single","sequence":[{"alias":"Not while Away / holiday mode is on","condition":"state","entity_id":"input_boolean.heating_away_mode","state":"off"},{"condition":"state","entity_id":"input_boolean.hive_ha_water_schedule","state":"on"},{"variables":{"day":"{{ now().strftime('%a') | lower }}","sched":"{% set ns = namespace(single='', any='') %} {% for s in states.switch | selectattr('attributes.tags', 'defined')\n     | selectattr('attributes.tags', 'contains', 'hive_hot_water') | rejectattr('state', 'in', ['off', 'unavailable', 'unknown']) %}\n  {% set w = s.attributes.weekdays | default([]) %}\n  {% if day in w or 'daily' in w %}\n    {% if w | count == 1 %}{% set ns.single = s.entity_id %}{% else %}{% set ns.any = s.entity_id %}{% endif %}\n  {% endif %}\n{% endfor %}{{ ns.single or ns.any }}"}},{"condition":"template","value_template":"{{ sched != '' }}"},{"action":"scheduler.run_action","data":{"entity_id":"{{ sched }}","time":"{{ now().strftime('%H:%M:%S') }}"}}]},"hive_advance_to_next":{"alias":"Hive - advance to next schedule slot","description":"Hive-style \"Advance to next\" - applies the next Home Assistant schedule slot now. (Managed by Hive-style heating setup.)","icon":"mdi:skip-next","mode":"single","sequence":[{"alias":"Not while Away / holiday mode is on","condition":"state","entity_id":"input_boolean.heating_away_mode","state":"off"},{"condition":"state","entity_id":"input_boolean.hive_ha_schedule","state":"on"},{"variables":{"sched":"{% set ns = namespace(best='', t=none) %} {% for s in states.switch | selectattr('attributes.tags', 'defined')\n     | selectattr('attributes.tags', 'contains', 'hive_heating') | rejectattr('state', 'in', ['off', 'unavailable', 'unknown']) %}\n  {% set nt = as_datetime(s.attributes.next_trigger) if s.attributes.next_trigger is defined and s.attributes.next_trigger else none %}\n  {% if nt is not none and (ns.t is none or nt < ns.t) %}{% set ns.t = nt %}{% set ns.best = s.entity_id %}{% endif %}\n{% endfor %}{{ ns.best }}"}},{"condition":"template","value_template":"{{ sched != '' }}"},{"action":"scheduler.run_action","data":{"entity_id":"{{ sched }}","time":"{{ (as_datetime(state_attr(sched, 'next_trigger')) + timedelta(minutes=1)).strftime('%H:%M:%S') }}"}}]}},"automation":[{"id":"hive_style_rooms_follow_schedule","alias":"Hive-style - rooms on Schedule follow the heating schedule","description":"When the main heating schedule changes temperature, rooms on Schedule follow it. Also runs every time a heating schedule slot starts, even when the thermostat is already at that temperature - e.g. while a room is calling the boiler - so a schedule change is never missed. (Managed by Hive-style heating setup.)","mode":"restart","triggers":[{"trigger":"state","entity_id":"climate.hive_thermostat","attribute":"temperature"},{"trigger":"state","entity_id":"input_boolean.hive_ha_schedule","to":"on"},{"alias":"A heating schedule slot starts (even when the thermostat is already at that temperature)","trigger":"template","value_template":"{{ states.switch | selectattr('attributes.tags', 'defined')\n   | selectattr('attributes.tags', 'contains', 'hive_heating')\n   | selectattr('state', 'eq', 'triggered') | list | count > 0 }}"}],"actions":[{"delay":{"seconds":15}},{"action":"script.hive_rooms_follow_schedule"}]},{"id":"hive_style_end_valve_boost","alias":"Hive-style - end Home Assistant boost on non-Hive valves","description":"When a timer.boost_* finishes, put that valve back to its pre-boost mode and temperature. (Managed by Hive-style heating setup.)","mode":"parallel","triggers":[{"trigger":"event","event_type":"timer.finished"}],"conditions":["{{ trigger.event.data.entity_id.startswith('timer.boost_') }}"],"actions":[{"action":"scene.turn_on","target":{"entity_id":"scene.hive_boost_{{ trigger.event.data.entity_id.split('.')[1][6:] }}"},"continue_on_error":true},{"if":"{{ is_state('input_boolean.hive_room_schedule_' ~ trigger.event.data.entity_id.split('.')[1][6:], 'on') }}","then":[{"delay":{"seconds":5}},{"action":"script.hive_rooms_follow_schedule","data":{"only":"climate.{{ trigger.event.data.entity_id.split('.')[1][6:] }}"}}]}]},{"id":"hive_style_boost_end_back_to_schedule","alias":"Hive-style - back to the schedule when a heating boost ends","description":"When the main thermostat's boost ends, put it on the temperature the Home Assistant schedule wants now (not the one from before the boost), then let the rooms on Schedule follow. (Managed by Hive-style heating setup.)","mode":"restart","triggers":[{"trigger":"state","entity_id":"binary_sensor.hive_thermostat_boost","from":"on","to":"off","for":{"seconds":30}},{"trigger":"event","event_type":"timer.finished"}],"conditions":[{"alias":"Only the main thermostat's own boost timer","condition":"template","value_template":"{{ trigger.platform != 'event'\n   or trigger.event.data.entity_id == 'timer.boost_' ~ 'climate.hive_thermostat'.split('.')[1] }}"},{"condition":"state","entity_id":"input_boolean.hive_ha_schedule","state":"on"},{"condition":"state","entity_id":"input_boolean.heating_away_mode","state":"off"},{"condition":"state","entity_id":"input_boolean.hive_away_eco_active","state":"off"},{"condition":"state","entity_id":"climate.hive_thermostat","state":"heat"}],"actions":[{"delay":{"seconds":10}},{"action":"script.hive_apply_schedule_now"},{"delay":{"seconds":20}},{"action":"script.hive_rooms_follow_schedule"}]},{"id":"hive_style_presence_eco","alias":"Hive-style - lower the heating when nobody's home","description":"When nobody has been home for 30 minutes, holds the main thermostat at 16\u00b0 at most (it only lowers, Off stays off; rooms on Schedule follow it). When someone comes home, or enters the \"Approaching home\" zone with warm-up on, the current schedule slot is put back. Needs Home Assistant to run the heating schedule. Turn it on or off on the Manage page. (Managed by Hive-style heating setup.)","mode":"queued","max":10,"conditions":[{"alias":"Away / holiday mode takes over while it's on","condition":"state","entity_id":"input_boolean.heating_away_mode","state":"off"}],"triggers":[{"trigger":"numeric_state","entity_id":"zone.home","below":1,"for":{"minutes":30},"id":"away"},{"trigger":"state","entity_id":"climate.hive_thermostat","attribute":"temperature","id":"enforce"},{"trigger":"numeric_state","entity_id":"zone.home","above":0,"id":"home"},{"trigger":"numeric_state","entity_id":"zone.approaching_home","above":0,"id":"approaching"}],"actions":[{"choose":[{"alias":"Nobody home for 30 min - lower to 16","conditions":[{"condition":"trigger","id":"away"},{"condition":"state","entity_id":"input_boolean.hive_eco_when_nobody_home","state":"on"},{"condition":"state","entity_id":"input_boolean.hive_ha_schedule","state":"on"},{"condition":"state","entity_id":"climate.hive_thermostat","state":"heat"},{"condition":"numeric_state","entity_id":"zone.home","below":1}],"sequence":[{"action":"input_boolean.turn_on","target":{"entity_id":"input_boolean.hive_away_eco_active"}},{"if":[{"condition":"numeric_state","entity_id":"climate.hive_thermostat","attribute":"temperature","above":16}],"then":[{"action":"climate.set_temperature","target":{"entity_id":"climate.hive_thermostat"},"data":{"temperature":16}}]}]},{"alias":"The schedule raised the target while nobody's home - hold at 16","conditions":[{"condition":"trigger","id":"enforce"},{"condition":"state","entity_id":"input_boolean.hive_away_eco_active","state":"on"},{"condition":"numeric_state","entity_id":"climate.hive_thermostat","attribute":"temperature","above":16},"{% set e = 'climate.hive_thermostat' %}{{ not is_state_attr(e, 'preset_mode', 'boost') and not is_state('timer.boost_' ~ e.split('.')[1], 'active') }}"],"sequence":[{"action":"climate.set_temperature","target":{"entity_id":"climate.hive_thermostat"},"data":{"temperature":16}}]},{"alias":"Someone home, or approaching with warm-up on - put the schedule back","conditions":[{"condition":"state","entity_id":"input_boolean.hive_away_eco_active","state":"on"},{"condition":"or","conditions":[{"condition":"trigger","id":"home"},{"condition":"and","conditions":[{"condition":"trigger","id":"approaching"},{"condition":"state","entity_id":"input_boolean.hive_warm_up_approaching","state":"on"}]}]}],"sequence":[{"action":"input_boolean.turn_off","target":{"entity_id":"input_boolean.hive_away_eco_active"}},{"action":"script.hive_apply_schedule_now"}]}]}]},{"id":"hive_style_away_mode","alias":"Hive-style - Away / holiday mode","description":"Away on: saves every radiator, the thermostat and the hot water, cancels running boosts, sets the thermostat and every radiator to the away temperature and turns the hot water off. While away, schedules are paused and anything that raises a temperature is put back down (a boost you start yourself is left alone until it ends). Away off: puts Manual rooms back the way they were and re-applies the current schedule slots. (Managed by Hive-style heating setup.)","mode":"queued","max":5,"triggers":[{"trigger":"state","entity_id":"input_boolean.heating_away_mode","to":"on","id":"on"},{"trigger":"state","entity_id":"input_boolean.heating_away_mode","to":"off","from":"on","id":"off"},{"trigger":"state","entity_id":"climate.hive_thermostat","attribute":"temperature","id":"enforce"},{"trigger":"state","entity_id":"input_number.hive_away_temperature","id":"enforce"},{"trigger":"time_pattern","minutes":"/2","id":"enforce"},{"trigger":"homeassistant","event":"start","id":"enforce"}],"variables":{"main":"climate.hive_thermostat","water":"water_heater.hive_hot_water","main_boost":"binary_sensor.hive_thermostat_boost","water_boost":"binary_sensor.hive_hot_water_boost","away_t":"{{ states('input_number.hive_away_temperature') | float(12) }}","devices":"{{ [main] + (states.input_boolean | map(attribute='object_id') | select('match', '^hive_room_schedule_')\n   | map('regex_replace', '^hive_room_schedule_', 'climate.') | select('has_value') | list) }}"},"actions":[{"choose":[{"alias":"Away switched on - cancel boosts, then save everything","conditions":[{"condition":"trigger","id":"on"}],"sequence":[{"repeat":{"for_each":"{{ devices + ([water] if has_value(water) else []) }}","sequence":[{"action":"script.hive_boost","data":{"entity_id":"{{ repeat.item }}","cancel_only":true,"ha_boost":"{{ is_state('timer.boost_' ~ ('water_' if repeat.item.startswith('water_heater.') else '') ~ repeat.item.split('.')[1], 'active') }}"},"continue_on_error":true}]}},{"delay":{"seconds":8}},{"action":"scene.create","data":{"scene_id":"hive_away_restore","snapshot_entities":"{{ devices + ([water] if has_value(water) else []) }}"}}]},{"alias":"Away switched off - put Manual rooms back, re-apply the schedules","conditions":[{"condition":"trigger","id":"off"}],"sequence":[{"action":"scene.turn_on","target":{"entity_id":"scene.hive_away_restore"},"continue_on_error":true},{"delay":{"seconds":5}},{"action":"script.hive_apply_schedule_now","continue_on_error":true},{"action":"script.hive_rooms_follow_schedule","data":{"include_own":true},"continue_on_error":true},{"alias":"Away - hot water back on its schedule","action":"script.hive_apply_water_schedule_now","continue_on_error":true},{"stop":"Away mode ended"}]}]},{"condition":"state","entity_id":"input_boolean.heating_away_mode","state":"on"},{"alias":"Hold every radiator and the thermostat at the away temperature","repeat":{"for_each":"{% set ns = namespace(l=[]) %} {% for e in devices %}\n  {% set o = e.split('.')[1] %}\n  {% set t = state_attr(e, 'temperature') %}\n  {% set boosting = is_state_attr(e, 'preset_mode', 'boost') or is_state('timer.boost_' ~ o, 'active')\n     or (e == main and is_state(main_boost, 'on')) %}\n  {% if states(e) not in ['off', 'unavailable', 'unknown'] and not boosting\n     and (t is none or (t | float(0) - away_t) | abs > 0.1) %}\n    {% set ns.l = ns.l + [e] %}\n  {% endif %}\n{% endfor %}{{ ns.l }}","sequence":[{"action":"climate.set_temperature","target":{"entity_id":"{{ repeat.item }}"},"data":{"temperature":"{{ [[away_t, state_attr(repeat.item, 'min_temp') | float(5)] | max, state_attr(repeat.item, 'max_temp') | float(32)] | min }}"},"continue_on_error":true},{"delay":{"seconds":"{{ 4 if repeat.item in integration_entities('hive') else 0 }}"}}]}},{"alias":"Away - hot water off","if":"{{ has_value(water) and states(water) != 'off' and not is_state(water_boost, 'on') and not is_state('timer.boost_water_' ~ water.split('.')[1], 'active') }}","then":[{"action":"water_heater.set_operation_mode","target":{"entity_id":"{{ water }}"},"data":{"operation_mode":"off"},"continue_on_error":true}]}]}]};
const HS_OCTO = {"banner":{"type":"custom:button-card","template":"hive_clear","entity":"calendar.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session","show_name":false,"show_icon":false,"show_state":false,"triggers_update":["calendar.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session","calendar.octopus_energy_YOUR_ACCOUNT_octoplus_saving_sessions","sun.sun"],"grid_options":{"columns":"full"},"tap_action":{"action":"more-info"},"custom_fields":{"b":"[[[ const now=new Date(); const pick=(id,kind)=>{const s=states[id]; if(!s||!s.attributes.start_time) return null; const st=new Date(String(s.attributes.start_time).replace(' ','T')); const en=new Date(String(s.attributes.end_time||s.attributes.start_time).replace(' ','T')); if(isNaN(st)||en<now||st-now>7*864e5) return null; return {kind,st,en,on:s.state==='on'||(st<=now&&en>now)};}; const ev=pick('calendar.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session','free')||pick('calendar.octopus_energy_YOUR_ACCOUNT_octoplus_saving_sessions','saving'); if(!ev) return ''; const t=(d)=>d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); const day=(d)=>d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); const free=ev.kind==='free'; const bg=free?'linear-gradient(135deg,#1FA971,#46CF97)':'linear-gradient(135deg,#4350E6,#7B80EA)'; const icon=free?'mdi:lightning-bolt':'mdi:piggy-bank-outline'; const title=free?(ev.on?'Free electricity now':'Free electricity coming up'):(ev.on?'Octopus Saving Session now':'Octopus Saving Session coming up'); const sub=ev.on?('Until '+t(ev.en)+(free?' \\u00b7 turn things on!':' \\u00b7 use less to earn points')):(day(ev.st)+', '+t(ev.st)+'\\u2013'+t(ev.en)); return `<div style='display:flex;align-items:center;gap:14px;padding:14px 18px;border-radius:20px;background:${bg};color:#fff;box-shadow:0 4px 14px rgba(30,30,60,0.15);font-family:Inter,sans-serif'><div style='width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.22);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='${icon}' style='--mdc-icon-size:24px;color:#fff'></ha-icon></div><div style='text-align:left;line-height:1.3'><div style='font-size:17px;font-weight:600'>${title}</div><div style='font-size:14px;opacity:0.92'>${sub}</div></div></div>`; ]]]"},"styles":{"card":[{"display":"[[[ const now=new Date(); const pick=(id,kind)=>{const s=states[id]; if(!s||!s.attributes.start_time) return null; const st=new Date(String(s.attributes.start_time).replace(' ','T')); const en=new Date(String(s.attributes.end_time||s.attributes.start_time).replace(' ','T')); if(isNaN(st)||en<now||st-now>7*864e5) return null; return {kind,st,en,on:s.state==='on'||(st<=now&&en>now)};}; const ev=pick('calendar.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session','free')||pick('calendar.octopus_energy_YOUR_ACCOUNT_octoplus_saving_sessions','saving'); return ev ? 'block' : 'none'; ]]]"},{"padding":"0"},{"background":"none"},{"box-shadow":"none"},{"overflow":"visible"}],"grid":[{"grid-template-areas":"\"b\""}],"custom_fields":{"b":[{"justify-self":"stretch"}]}}},"spend":[{"type":"custom:button-card","template":"hive_section_title","name":"Spend","grid_options":{"columns":"full"}},{"type":"statistic","entity":"sensor.octopus_energy_gas_YOUR_METER_current_accumulative_cost","name":"Gas today","icon":"mdi:fire","stat_type":"change","period":{"calendar":{"period":"day"}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistic","entity":"sensor.octopus_energy_electricity_YOUR_METER_current_accumulative_cost","name":"Electricity today","icon":"mdi:flash","stat_type":"change","period":{"calendar":{"period":"day"}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistic","entity":"sensor.octopus_energy_gas_YOUR_METER_current_accumulative_cost","name":"Gas yesterday","icon":"mdi:fire","stat_type":"change","period":{"calendar":{"period":"day","offset":-1}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistic","entity":"sensor.octopus_energy_electricity_YOUR_METER_current_accumulative_cost","name":"Electricity yesterday","icon":"mdi:flash","stat_type":"change","period":{"calendar":{"period":"day","offset":-1}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistic","entity":"sensor.octopus_energy_gas_YOUR_METER_current_accumulative_cost","name":"Gas this month","icon":"mdi:fire","stat_type":"change","period":{"calendar":{"period":"month"}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistic","entity":"sensor.octopus_energy_electricity_YOUR_METER_current_accumulative_cost","name":"Electricity this month","icon":"mdi:flash","stat_type":"change","period":{"calendar":{"period":"month"}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistic","entity":"sensor.octopus_energy_gas_YOUR_METER_current_accumulative_cost","name":"Gas last month","icon":"mdi:fire","stat_type":"change","period":{"calendar":{"period":"month","offset":-1}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistic","entity":"sensor.octopus_energy_electricity_YOUR_METER_current_accumulative_cost","name":"Electricity last month","icon":"mdi:flash","stat_type":"change","period":{"calendar":{"period":"month","offset":-1}},"card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":6}},{"type":"statistics-graph","title":"Daily spend \u00b7 last 30 days","entities":[{"entity":"sensor.octopus_energy_gas_YOUR_METER_current_accumulative_cost","name":"Gas","color":"#E8642E"},{"entity":"sensor.octopus_energy_electricity_YOUR_METER_current_accumulative_cost","name":"Electricity","color":"#4350E6"}],"stat_types":["change"],"period":"day","days_to_show":30,"chart_type":"bar","card_mod":{"style":"ha-card { --primary-text-color: var(--hs-text,#2B2B2E); --secondary-text-color: var(--hs-sub,#66666B); --card-background-color: var(--hs-card,#FFFFFF); --ha-card-background: var(--hs-card,#FFFFFF); background: var(--hs-card,#FFFFFF) !important; color: var(--hs-text,#2B2B2E) !important; border: none !important; border-radius: 20px !important; box-shadow: 0 1px 8px rgba(40,40,80,0.06) !important; font-family: Inter, sans-serif; }"},"grid_options":{"columns":"full","rows":5}}],"alerts":{"id":"hive_style_octopus_alerts","alias":"Octopus - free electricity & saving session alerts","description":"Phone alerts for Octoplus events: a new Free Electricity session announced, 1 hour before and when it starts; 1 hour before a Saving Session or Power Down. (Managed by Hive-style heating setup.)","mode":"queued","max":10,"triggers":[{"trigger":"state","entity_id":"event.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session_events","id":"free_announced"},{"trigger":"calendar","entity_id":"calendar.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session","event":"start","offset":"-1:00:00","id":"free_soon"},{"trigger":"calendar","entity_id":"calendar.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session","event":"start","offset":"0:00:00","id":"free_now"},{"trigger":"calendar","entity_id":"calendar.octopus_energy_YOUR_ACCOUNT_octoplus_saving_sessions","event":"start","offset":"-1:00:00","id":"saving_soon"},{"trigger":"calendar","entity_id":"calendar.octopus_energy_YOUR_ACCOUNT_octoplus_power_down","event":"start","offset":"-1:00:00","id":"power_down_soon"}],"actions":[{"choose":[{"conditions":[{"condition":"trigger","id":"free_announced"}],"sequence":[{"variables":{"new_list":"{% set to = trigger.to_state.attributes if trigger.to_state is not none else {} %}{% set fr = trigger.from_state.attributes if trigger.from_state is not none else {} %}{% set old = ((fr.get('events') or []) + (fr.get('available_events') or [])) | map(attribute='start') | map('string') | list %}{% set ns = namespace(out=[]) %}{% for e in (to.get('events') or []) + (to.get('available_events') or []) %}{% if e.start is defined and (e.start | string) not in old and as_datetime(e.start | string) is not none and as_datetime(e.start | string) > now() %}{% set ns.out = ns.out + [as_local(as_datetime(e.start | string)).strftime('%a %-d %b, %H:%M') ~ ((' to ' ~ as_local(as_datetime(e.end | string)).strftime('%H:%M')) if e.end is defined else '')] %}{% endif %}{% endfor %}{{ ns.out }}"}},{"condition":"template","value_template":"{{ new_list | count > 0 }}"},{"action":"notify.mobile_app_YOUR_PHONE","data":{"title":"\u26a1 Free electricity announced","message":"Octopus free electricity: {{ new_list | join(' \u00b7 ') }}. Plan the washing, dishwasher or car charging for then.","data":{"tag":"octopus-free-electricity"}}}]},{"conditions":[{"condition":"trigger","id":"free_soon"}],"sequence":[{"action":"notify.mobile_app_YOUR_PHONE","data":{"title":"\u26a1 Free electricity in 1 hour","message":"Free from {{ as_local(as_datetime(trigger.calendar_event.start)).strftime('%H:%M') }} to {{ as_local(as_datetime(trigger.calendar_event.end)).strftime('%H:%M') }}. Get the washing, dishwasher or car ready.","data":{"tag":"octopus-free-electricity"}}}]},{"conditions":[{"condition":"trigger","id":"free_now"}],"sequence":[{"action":"notify.mobile_app_YOUR_PHONE","data":{"title":"\u26a1 Free electricity now","message":"Electricity is free until {{ as_local(as_datetime(trigger.calendar_event.end)).strftime('%H:%M') }}. Turn things on!","data":{"tag":"octopus-free-electricity","push":{"interruption-level":"time-sensitive"}}}}]},{"conditions":[{"condition":"trigger","id":"saving_soon"}],"sequence":[{"action":"notify.mobile_app_YOUR_PHONE","data":{"title":"\ud83d\udcb7 Octopus Saving Session in 1 hour","message":"{{ as_local(as_datetime(trigger.calendar_event.start)).strftime('%H:%M') }} to {{ as_local(as_datetime(trigger.calendar_event.end)).strftime('%H:%M') }}: use less electricity to earn Octopoints.","data":{"tag":"octopus-saving-session"}}}]},{"conditions":[{"condition":"trigger","id":"power_down_soon"}],"sequence":[{"action":"notify.mobile_app_YOUR_PHONE","data":{"title":"\ud83d\udd0c Octopus Power Down in 1 hour","message":"{{ as_local(as_datetime(trigger.calendar_event.start)).strftime('%H:%M') }} to {{ as_local(as_datetime(trigger.calendar_event.end)).strftime('%H:%M') }}: use less electricity during this time.","data":{"tag":"octopus-power-down"}}}]}]}]}};
const HS_ROOMS = {"photo":{"variables":{"name":"","icon":"mdi:radiator","photo_a":"[[[ const e = hass.entities && entity ? hass.entities[entity.entity_id] : null; let a = e && e.area_id; if (!a && e && e.device_id && hass.devices && hass.devices[e.device_id]) a = hass.devices[e.device_id].area_id; const ar = a && hass.areas ? hass.areas[a] : null; return (ar && ar.picture) || ''; ]]]","photo_b":"","room_temp":"","room_humidity":""},"show_icon":false,"show_name":false,"show_state":false,"hold_action":{"action":"more-info"},"triggers_update":[],"styles":{"card":[{"background":"#2A2B33"},{"border-radius":"22px"},{"box-shadow":"0 6px 18px rgba(30,30,60,0.18)"},{"border":"none"},{"padding":"16px 16px 16px 18px"},{"color":"#FFFFFF"},{"font-family":"Inter, sans-serif"},{"overflow":"hidden"},{"position":"relative"},{"isolation":"isolate"},{"min-height":"156px"}],"grid":[{"grid-template-areas":"\"head head\" \"temp boost\""},{"grid-template-columns":"1fr auto"},{"row-gap":"16px"}],"custom_fields":{"bg":[{"position":"absolute"},{"top":"0"},{"left":"0"},{"right":"0"},{"bottom":"0"},{"z-index":"0"},{"pointer-events":"none"}],"head":[{"position":"relative"},{"z-index":"1"},{"justify-self":"stretch"}],"temp":[{"position":"relative"},{"z-index":"1"},{"justify-self":"start"},{"align-self":"end"}],"boost":[{"position":"relative"},{"z-index":"1"},{"justify-self":"end"},{"align-self":"center"}]}},"custom_fields":{"bg":"[[[ const eid=entity.entity_id; const st=entity.state; const obj=eid.split('.')[1];\nconst tm=states['timer.boost_'+obj]; const hb=states['binary_sensor.'+obj+'_boost'];\n        const boost = !!(tm&&tm.state==='active') || entity.attributes.preset_mode==='boost' || !!(hb&&hb.state==='on');\nconst heating = ((m)=>{const s=states[m];const b=(hass.entities&&(hass.entities[m]||{}).platform==='hive')?states['binary_sensor.'+m.split('.')[1]+'_state']:null;return b?b.state==='on':(s&&s.attributes.hvac_action!==undefined?s.attributes.hvac_action==='heating':true);})('climate.hive_thermostat') && ((s=>s?s.state==='on':entity.attributes.hvac_action==='heating')((hass.entities&&(hass.entities[entity.entity_id]||{}).platform==='hive')?states['binary_sensor.'+obj+'_state']:null));\nconst t=parseFloat(entity.attributes.temperature);\nconst off = st==='off' || isNaN(t) || t<=7;\nlet tint, filt;\nif(boost){ tint='linear-gradient(105deg,rgba(214,78,28,.88) 0%,rgba(232,100,46,.58) 55%,rgba(240,150,70,.25) 100%)'; filt='saturate(1.15)'; }\nelse if(heating){ tint='linear-gradient(105deg,rgba(110,38,12,.86) 0%,rgba(200,85,35,.48) 60%,rgba(232,120,60,.18) 100%)'; filt='saturate(1.1)'; }\nelse if(off){ tint='linear-gradient(105deg,rgba(16,20,38,.88) 0%,rgba(28,34,66,.62) 60%,rgba(40,48,90,.32) 100%)'; filt='grayscale(.75) brightness(.85)'; }\nelse { tint='linear-gradient(105deg,rgba(22,22,28,.84) 0%,rgba(22,22,28,.48) 60%,rgba(22,22,28,.18) 100%)'; filt='none'; }\nconst d = obj.length % 7;\nconst layer = (u, anim) => u ? `<div style=\"position:absolute;inset:-6%;background:url('${u}') center/cover no-repeat;filter:${filt};animation:${anim};animation-delay:-${d}s;transition:filter .6s\"></div>` : '';\nreturn `<style>@keyframes hpZoom{0%{transform:scale(1)}50%{transform:scale(1.07) translate(-1.5%,-1%)}100%{transform:scale(1)}}@keyframes hpFade{0%,40%{opacity:1}50%,90%{opacity:0}100%{opacity:1}}@media (prefers-reduced-motion:reduce){div{animation:none!important}}</style><div style=\"position:absolute;inset:0;overflow:hidden;border-radius:22px\">${variables.photo_b ? layer(variables.photo_b,'hpZoom 26s ease-in-out infinite') + layer(variables.photo_a,'hpZoom 26s ease-in-out infinite, hpFade 18s ease-in-out infinite') : layer(variables.photo_a,'hpZoom 26s ease-in-out infinite')}<div style=\"position:absolute;inset:0;background:${tint};transition:background .6s\"></div></div>`; ]]]","head":"[[[ const eid=entity.entity_id; const obj=eid.split('.')[1];\nconst tm=states['timer.boost_'+obj]; const hb=states['binary_sensor.'+obj+'_boost'];\n        const boost = !!(tm&&tm.state==='active') || entity.attributes.preset_mode==='boost' || !!(hb&&hb.state==='on');\nconst t=parseFloat(entity.attributes.temperature);\nconst sh='text-shadow:0 1px 4px rgba(0,0,0,.45)';\nlet right;\nif(entity.state==='off' || isNaN(t) || t<=7){ right='Off'; }\nelse {\n  const cur=parseFloat(entity.attributes.current_temperature);\n  const ic = (boost || ((s=>s?s.state==='on':entity.attributes.hvac_action==='heating')((hass.entities&&(hass.entities[entity.entity_id]||{}).platform==='hive')?states['binary_sensor.'+obj+'_state']:null))) ? `<ha-icon icon='mdi:fire' style='--mdc-icon-size:20px;color:${((m)=>{const s=states[m];const b=(hass.entities&&(hass.entities[m]||{}).platform==='hive')?states['binary_sensor.'+m.split('.')[1]+'_state']:null;return b?b.state==='on':(s&&s.attributes.hvac_action!==undefined?s.attributes.hvac_action==='heating':true);})('climate.hive_thermostat')?'#FFB27A':'#D0D1DA'};margin-left:8px'></ha-icon>` : (cur>=t ? `<ha-icon icon='mdi:check-circle-outline' style='--mdc-icon-size:20px;color:#FFFFFF;margin-left:8px'></ha-icon>` : '');\n  right = `Target&nbsp;<span style='font-weight:600'>${t.toFixed(1)}\u00b0</span>${ic}`;\n}\nreturn `<div style='display:flex;align-items:center;gap:12px;color:#FFFFFF;${sh}'><div style='width:30px;height:30px;border-radius:9px;background:rgba(255,255,255,.2);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;flex:none'><ha-icon icon='${variables.icon}' style='--mdc-icon-size:17px;color:#FFFFFF'></ha-icon></div><div style='flex:1;font-size:17px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left'>${variables.name||entity.attributes.friendly_name}</div><div style='font-size:17px;display:flex;align-items:center;white-space:nowrap'>${right}</div></div>`; ]]]","temp":"[[[ const obj=entity.entity_id.split('.')[1];\nconst tm=states['timer.boost_'+obj]; const hb=states['binary_sensor.'+obj+'_boost'];\n        const boost = !!(tm&&tm.state==='active') || entity.attributes.preset_mode==='boost' || !!(hb&&hb.state==='on');\nconst rs = variables.room_temp ? states[variables.room_temp] : null;\nconst rt = rs ? parseFloat(rs.state) : NaN;\nconst c = !isNaN(rt) ? rt : parseFloat(entity.attributes.current_temperature);\nconst hs = variables.room_humidity ? states[variables.room_humidity] : null;\nconst h = hs ? parseFloat(hs.state) : NaN;\nlet sub = 'Actual';\nif(!isNaN(h)) sub += ` \u00b7 ${Math.round(h)}% humidity`;\nif(boost) sub += ' \u00b7 Boosting'; else if(((s=>s?s.state==='on':entity.attributes.hvac_action==='heating')((hass.entities&&(hass.entities[entity.entity_id]||{}).platform==='hive')?states['binary_sensor.'+obj+'_state']:null))) sub += (((m)=>{const s=states[m];const b=(hass.entities&&(hass.entities[m]||{}).platform==='hive')?states['binary_sensor.'+m.split('.')[1]+'_state']:null;return b?b.state==='on':(s&&s.attributes.hvac_action!==undefined?s.attributes.hvac_action==='heating':true);})('climate.hive_thermostat')?' \u00b7 Heating':' \u00b7 Waiting for the boiler');\nreturn `<div style='text-align:left;color:#FFFFFF;text-shadow:0 2px 8px rgba(0,0,0,.45)'><div style='font-size:46px;font-weight:500;letter-spacing:-1px;line-height:1'>${isNaN(c)?'--':c.toFixed(1)}\u00b0</div><div style='font-size:13px;opacity:.9;margin-top:6px'>${sub}</div></div>`; ]]]"},"tap_action":{"action":"more-info"}},"call":{"input_boolean":{"room_heat_call_active":{"name":"Room heat call active","icon":"mdi:radiator"},"rooms_can_call_the_boiler_any_time":{"name":"Rooms can call the boiler any time","icon":"mdi:radiator-disabled"}},"input_number":{"room_heat_call_restore_temperature":{"name":"Room heat call restore temperature","min":0,"max":35,"step":0.5,"mode":"box","unit_of_measurement":"\u00b0C"},"room_heat_call_set_temperature":{"name":"Room heat call set temperature","min":0,"max":35,"step":0.5,"mode":"box","unit_of_measurement":"\u00b0C"}},"automation":{"id":"hive_style_rooms_call_boiler","alias":"Hive-style - rooms call the boiler","description":"Boosted radiator valves (and rooms on their own schedule) fire the boiler through the main thermostat, then put it back to the schedule. (Managed by Hive-style heating setup.)","mode":"single","max_exceeded":"silent","triggers":[{"trigger":"state","entity_id":["climate.bedroom_radiator","binary_sensor.bedroom_radiator_state","binary_sensor.bedroom_radiator_boost","climate.study_radiator","timer.boost_study_radiator","input_boolean.rooms_can_call_the_boiler_any_time","input_boolean.hive_away_eco_active","input_boolean.heating_away_mode"]},{"trigger":"state","entity_id":"climate.hive_thermostat","attribute":"temperature"},{"trigger":"state","entity_id":"climate.hive_thermostat","to":null},{"trigger":"time_pattern","minutes":"/2"},{"trigger":"homeassistant","event":"start"}],"actions":[{"variables":{"main":"climate.hive_thermostat","boost_temp":21,"rooms":["climate.bedroom_radiator","climate.study_radiator"]}},{"variables":{"any_time":"{{ is_state('input_boolean.rooms_can_call_the_boiler_any_time', 'on') }}","main_ok":"{{ states(main) in ['heat', 'auto']\n   and not is_state('input_boolean.hive_away_eco_active', 'on')\n   and not is_state('input_boolean.heating_away_mode', 'on') }}","T":"{{ state_attr(main, 'temperature') | float(0) }}","C":"{{ state_attr(main, 'current_temperature') | float(0) }}","active":"{{ is_state('input_boolean.room_heat_call_active', 'on') }}","ours":"{{ states('input_number.room_heat_call_set_temperature') | float(0) }}","saved":"{{ states('input_number.room_heat_call_restore_temperature') | float(0) }}","sched":"{%- set ns = namespace(single=none, any=none, temp='') -%} {%- if is_state('input_boolean.hive_ha_schedule', 'on') -%} {%- set day = now().strftime('%a') | lower -%}{%- set t = now().strftime('%H:%M') -%} {%- for s in states.switch | selectattr('attributes.tags', 'defined') | selectattr('attributes.tags', 'contains', 'hive_heating') | rejectattr('state', 'in', ['off', 'unavailable', 'unknown']) -%}\n  {%- set w = s.attributes.weekdays | default([]) -%}\n  {%- if day in w or 'daily' in w or ('workday' in w and day in ['mon','tue','wed','thu','fri']) or ('weekend' in w and day in ['sat','sun']) -%}\n    {%- if w | count == 1 and w[0] == day -%}{%- set ns.single = s -%}{%- else -%}{%- set ns.any = s -%}{%- endif -%}\n  {%- endif -%}\n{%- endfor -%} {%- set sw = ns.single or ns.any -%} {%- if sw -%}{%- for sl in sw.attributes.timeslots | default([]) -%}\n  {%- set a = sl.split(' - ') -%}{%- set stop = '24:00' if a[1] == '00:00' else a[1] -%}\n  {%- if a[0] <= t < stop -%}\n    {%- set acts = sw.attributes.actions | default([]) -%}\n    {%- set act = acts[loop.index0] if acts | count > 1 else acts[0] -%}\n    {%- set ns.temp = (act.data or act.service_data or {}).temperature -%}\n  {%- endif -%}\n{%- endfor -%}{%- endif -%} {%- endif -%}{{ ns.temp }}"}},{"variables":{"restore":"{{ sched | float if sched not in ['', none] else saved }}"}},{"variables":{"calling":"{% set ns = namespace(c=[]) %} {% for e in rooms %}{% set s = states[e] %}\n  {% if s is not none and s.state not in ['unavailable', 'unknown'] %}\n    {% set o = e.split('.')[1] %}\n    {% set d = states['binary_sensor.' ~ o ~ '_state'] %}\n    {% set cur = s.attributes.current_temperature | float(99) %}\n    {% set t = s.attributes.temperature | float(0) %}\n    {% set boosting = s.attributes.preset_mode == 'boost'\n         or is_state('binary_sensor.' ~ o ~ '_boost', 'on')\n         or is_state('timer.boost_' ~ o, 'active') %}\n    {% if d is not none %}\n      {# Hive reports boost/demand late: a boosted room below the boost temperature needs heat #}\n      {% set demand = d.state == 'on' or (boosting and cur < ([t, boost_temp] | max) - 0.3) %}\n    {% else %}\n      {# 0.5 deg below target, so a small dip in one room doesn't fire the boiler #}\n      {% set demand = s.state != 'off' and cur < t - 0.5 %}\n    {% endif %}\n    {# on Schedule, with its own times today #}\n    {% set ns2 = namespace(own=false) %}\n    {% if is_state('input_boolean.hive_room_schedule_' ~ o, 'on') %}\n      {% set day = now().strftime('%a') | lower %}\n      {% for sw in states.switch | selectattr('attributes.tags', 'defined') | selectattr('attributes.tags', 'contains', 'hive_room_' ~ o) | rejectattr('state', 'in', ['off', 'unavailable', 'unknown']) %}\n        {% set w = sw.attributes.weekdays | default([]) %}\n        {% if day in w or 'daily' in w or ('workday' in w and day in ['mon','tue','wed','thu','fri']) or ('weekend' in w and day in ['sat','sun']) %}{% set ns2.own = true %}{% endif %}\n      {% endfor %}\n    {% endif %}\n    {% set own_sched = ns2.own %}\n    {# 'any time' / own-schedule calls only while the house is not already 1 deg above its target, so it never overheats the house; a boosted room always calls #}\n    {% if (boosting or ((any_time or own_sched) and C < restore + 1)) and demand %}{% set ns.c = ns.c + [e] %}{% endif %}\n  {% endif %}\n{% endfor %}{{ ns.c }}","new_temp":"{{ [[restore + 0.5, ((C + 1) * 2) | round(0) / 2] | max, 30] | min }}"}},{"choose":[{"alias":"A room needs heat","conditions":[{"condition":"template","value_template":"{{ calling | count > 0 and main_ok }}"}],"sequence":[{"if":[{"condition":"template","value_template":"{{ not active }}"}],"then":[{"action":"input_number.set_value","target":{"entity_id":"input_number.room_heat_call_restore_temperature"},"data":{"value":"{{ T }}"}},{"action":"input_number.set_value","target":{"entity_id":"input_number.room_heat_call_set_temperature"},"data":{"value":0}},{"action":"input_boolean.turn_on","target":{"entity_id":"input_boolean.room_heat_call_active"}},{"action":"logbook.log","data":{"name":"Rooms call the boiler","message":"started for {{ calling | map('state_attr', 'friendly_name') | join(', ') }} (main thermostat was {{ T }}\u00b0)","entity_id":"input_boolean.room_heat_call_active"}}],"else":[{"if":[{"condition":"template","value_template":"{{ (T - ours) | abs > 0.1 }}"}],"then":[{"action":"input_number.set_value","target":{"entity_id":"input_number.room_heat_call_restore_temperature"},"data":{"value":"{{ T }}"}}]}]},{"if":[{"condition":"template","value_template":"{{ T <= C + 0.2 and (T - new_temp) | abs > 0.1 }}"}],"then":[{"action":"input_number.set_value","target":{"entity_id":"input_number.room_heat_call_set_temperature"},"data":{"value":"{{ new_temp }}"}},{"action":"climate.set_temperature","target":{"entity_id":"climate.hive_thermostat"},"data":{"temperature":"{{ new_temp }}"},"continue_on_error":true},{"wait_template":"{{ (state_attr('climate.hive_thermostat', 'temperature') | float(0) - new_temp) | abs < 0.1 }}","timeout":"00:01:30","continue_on_timeout":true}]}]},{"alias":"No room needs heat any more - put the main thermostat back","conditions":[{"condition":"state","entity_id":"input_boolean.room_heat_call_active","state":"on"}],"sequence":[{"variables":{"put_back":"{{ main_ok and ours > 0 and (T - ours) | abs < 0.1 }}"}},{"if":[{"condition":"template","value_template":"{{ put_back }}"}],"then":[{"action":"climate.set_temperature","target":{"entity_id":"climate.hive_thermostat"},"data":{"temperature":"{{ restore }}"},"continue_on_error":true},{"wait_template":"{{ (state_attr('climate.hive_thermostat', 'temperature') | float(0) - restore) | abs < 0.1 }}","timeout":"00:01:30","continue_on_timeout":true}]},{"action":"input_boolean.turn_off","target":{"entity_id":"input_boolean.room_heat_call_active"}},{"action":"logbook.log","data":{"name":"Rooms call the boiler","message":"finished, main thermostat {{ 'back to ' ~ restore if put_back else 'left at ' ~ T }}\u00b0","entity_id":"input_boolean.room_heat_call_active"}}]}]}]}}};
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
// "Our Our Bedroom" -> "Our Bedroom": some integrations put the device name in front of an entity name that already has it
const hsDedupe = (n) => { const w = String(n || '').trim().split(/\s+/); for (let k = Math.floor(w.length / 2); k >= 1; k--) { if (w.slice(0, k).join(' ').toLowerCase() === w.slice(k, 2 * k).join(' ').toLowerCase()) return w.slice(k).join(' '); } return w.join(' '); };
const hsName = (hass, eid) => { const st = hass.states[eid]; return hsDedupe((st && st.attributes.friendly_name) || hsObj(eid)); };
// one colour per radiator in the Insights chart (readable on light and dark)
const HS_PALETTE = ['#4350E6', '#E8642E', '#1FA971', '#D9342B', '#9B59D0', '#E8A33A', '#2BA8C8', '#C2185B', '#7A8B3C', '#8D6E63', '#5C6BC0', '#00897B'];
// A Hive radiator valve: from the Hive integration and with Hive's boost preset. (Other valves - Tuya,
// Moes, Sonoff... - can have a 'boost' preset of their own; they get a Home Assistant boost.)
const hsIsHiveValve = (hass, eid) => {
  const st = hass.states[eid];
  if (!st || !(st.attributes.preset_modes || []).includes('boost')) return false;
  const p = hass.entities && hass.entities[eid] && hass.entities[eid].platform;
  return p ? p === 'hive' : true;
};
// Air con / not a radiator, or not working right now: shown in the list but left unticked
const hsNotRad = (hass, eid) => { const st = hass.states[eid]; if (!st || st.state === 'unavailable' || st.state === 'unknown') return 'unavailable right now'; const m = (st.attributes.hvac_modes || []).map(String); return m.some((x) => /^(cool|dry|fan_only|heat_cool)$/.test(x)) ? 'can cool (air con?) - probably not a radiator' : ''; };
const hsLooksLikeValve = (hass, eid) => /radiator|trv|valve|\brad\b|_rad$/i.test(eid + ' ' + hsName(hass, eid));
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
  backend: !main ? 'hive' : hsPlatform(hass, main) === 'hive' ? 'hive' : hsPlatform(hass, main) === 'mqtt' ? 'z2m' : 'other',
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
  // every device gets a boost timer: valves without Hive's own boost always use it, and Hive devices
  // fall back to it when the Hive integration has no boost actions
  const timers = valves.map((v) => 'timer.boost_' + hsObj(v.entity));
  timers.push('timer.boost_' + hsObj(c.main));
  if (c.water) timers.push('timer.boost_water_' + hsObj(c.water));
  const have = { hot_water: !!c.water, hub: !!c.hub, battery: !!c.battery };

  const cloneFor = (tmpl, kind, v) => {
    const t = HS_VALVE_T[kind];
    const slug = v.slug || hsSlug(v.name);
    let s = JSON.stringify(tmpl);
    s = hsSplitAll(s, t.eid, v.entity);
    s = hsSplitAll(s, 'timer.boost_' + hsObj(t.eid), 'timer.boost_' + hsObj(v.entity));
    s = hsSplitAll(s, 'hive_room_schedule_' + hsObj(t.eid), 'hive_room_schedule_' + hsObj(v.entity));
    s = hsSplitAll(s, 'hive_room_' + hsObj(t.eid), 'hive_room_' + hsObj(v.entity));
    s = hsSplitAll(s, `/hive-heating/${t.word}-schedule`, `/hive-heating/${slug}-schedule`);
    s = hsSplitAll(s, `"${t.word}-schedule"`, `"${slug}-schedule"`);
    s = hsSplitAll(s, `/hive-heating/${t.word}-picker`, `/hive-heating/${slug}-picker`);
    s = hsSplitAll(s, `/hive-heating/${t.word}"`, `/hive-heating/${slug}"`);
    s = hsSplitAll(s, `"${t.word}-picker"`, `"${slug}-picker"`);
    s = hsSplitAll(s, `"${t.word}"`, `"${slug}"`);
    // via a placeholder, so a name that contains the template word ("Our Bedroom") isn't replaced twice
    const PH = '\u0001HSNAME\u0001';
    s = hsSplitAll(s, `${t.Word} radiator`, PH);
    s = hsSplitAll(s, t.Word, PH);
    s = hsSplitAll(s, PH, hsJ(v.name));
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
          // (a run holds one Hive and one other version; the next kind of page starts a new run)
          const run = [];
          while (i < node.length && node[i] && node[i].hs_per_valve && !run.some((x) => x.hs_per_valve === node[i].hs_per_valve)) run.push(node[i++]);
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
      o.variables = Object.assign({}, o.variables, { items: [[c.mainName || 'Thermostat', c.main, c.battery || ''], ...valves.map((v) => [v.name, v.entity, v.battery || ''])] });
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
  // Hive valves report heating late in hvac_action; the cards read their State sensor too
  const hiveStates = valves.filter((v) => v.hive).map((v) => 'binary_sensor.' + hsObj(v.entity) + '_state');
  const flags = valves.map((v) => 'input_boolean.hive_room_schedule_' + hsObj(v.entity));
  const tidy = (o) => { if (Array.isArray(o)) o.forEach(tidy); else if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (k === 'triggers_update' && Array.isArray(o[k])) { o[k] = o[k].filter((x) => !/\.none$/.test(x) && !/^input_boolean\.hive_room_schedule_/.test(x)); if (o[k].includes('input_boolean.hive_ha_schedule')) o[k].push(...flags, ...hiveStates); } else tidy(o[k]); } };
  tidy(out);
  const vids = new Set(valves.map((v) => v.entity));
  const paint = (o) => { if (Array.isArray(o)) o.forEach(paint); else if (o && typeof o === 'object') { if (o.type === 'custom:apexcharts-card' && Array.isArray(o.series)) { let n = 0; o.series.forEach((se) => { if (se && vids.has(se.entity)) se.color = HS_PALETTE[n++ % HS_PALETTE.length]; }); } else Object.values(o).forEach(paint); } };
  paint(out);
  const mn = String(c.mainName || '').replace(/[`$\\]/g, '').trim();
  if (mn && mn !== 'Thermostat') {
    const ren = (o) => { if (Array.isArray(o)) { o.forEach((x, i) => { if (typeof x === 'string') { if (x === 'Thermostat') o[i] = mn; } else ren(x); }); } else if (o && typeof o === 'object') for (const k of Object.keys(o)) { const x = o[k]; if (typeof x === 'string') { if (x === 'Thermostat') o[k] = mn; else if (x === 'Thermostat · last 24 h' || x === 'Thermostat temperature') o[k] = mn + x.slice(10); else if (x.includes('>Thermostat</div>')) o[k] = x.split('>Thermostat</div>').join('>' + hsEsc(mn).replace(/'/g, '&#39;') + '</div>'); } else ren(x); } };
    ren(out);
  }
  if (!c.approach) { const mg = out.views.find((v) => v.path === 'manage'); if (mg) mg.sections.forEach((se) => { se.cards = se.cards.filter((x) => x.entity !== 'input_boolean.hive_warm_up_approaching'); }); }
  if (c.octopus && HS_OCTO) hsAddOctopus(out, c.octopus);
  if (c.rooms && HS_ROOMS && valves.length) hsAddRooms(out, c, urlPath);
  if (c.roomCall && HS_ROOMS && valves.length) hsAddRoomCallTile(out);
  out.hive_style_setup = c;
  return out;
}

// ---------- Octopus Energy (optional, found automatically) ----------
function hsOctoDetect(hass) {
  const ids = Object.keys(hass.states);
  const one = (re) => ids.filter((e) => re.test(e)).sort()[0] || '';
  return {
    free: one(/^calendar\.octopus_energy_.+_octoplus_free_electricity_session$/),
    saving: one(/^calendar\.octopus_energy_.+_octoplus_saving_sessions$/),
    powerDown: one(/^calendar\.octopus_energy_.+_octoplus_power_down$/),
    events: one(/^event\.octopus_energy_.+_octoplus_free_electricity_session_events$/),
    gas: one(/^sensor\.octopus_energy_gas_.+_current_accumulative_cost$/),
    elec: ids.filter((e) => /^sensor\.octopus_energy_electricity_.+_current_accumulative_cost$/.test(e) && !/export/.test(e)).sort()[0] || '',
  };
}
const hsOctoAny = (o) => !!(o && (o.free || o.saving || o.gas || o.elec));
function hsOctoFill(obj, o) {
  let s = JSON.stringify(obj);
  s = hsSplitAll(s, 'calendar.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session', o.free || 'calendar.none');
  s = hsSplitAll(s, 'calendar.octopus_energy_YOUR_ACCOUNT_octoplus_saving_sessions', o.saving || 'calendar.none');
  s = hsSplitAll(s, 'calendar.octopus_energy_YOUR_ACCOUNT_octoplus_power_down', o.powerDown || 'calendar.none');
  s = hsSplitAll(s, 'event.octopus_energy_YOUR_ACCOUNT_octoplus_free_electricity_session_events', o.events || 'event.none');
  s = hsSplitAll(s, 'sensor.octopus_energy_gas_YOUR_METER_current_accumulative_cost', o.gas || 'sensor.none');
  s = hsSplitAll(s, 'sensor.octopus_energy_electricity_YOUR_METER_current_accumulative_cost', o.elec || 'sensor.none');
  if (o.notify) s = hsSplitAll(s, 'notify.mobile_app_YOUR_PHONE', o.notify);
  return JSON.parse(s);
}
function hsAddOctopus(d, o) {
  const home = d.views.find((v) => v.path === 'home');
  if (home && (o.free || o.saving)) {
    const b = hsOctoFill(HS_OCTO.banner, o);
    b.triggers_update = (b.triggers_update || []).filter((x) => !/\.none$/.test(x));
    home.sections[0].cards.splice(1, 0, b);
  }
  const ins = d.views.find((v) => v.path === 'insights');
  if (ins && (o.gas || o.elec)) {
    let cards = hsOctoFill(HS_OCTO.spend, o);
    // only the fuels you have
    cards = cards.filter((x) => x.type !== 'statistic' || !/\.none$/.test(x.entity));
    cards.forEach((x) => { if (x.entities) x.entities = x.entities.filter((e) => !/\.none$/.test(e.entity)); });
    const list = ins.sections[0].cards;
    let at = list.findIndex((x) => x.type === 'custom:navbar-card');
    if (at < 0) at = list.length;
    while (at > 0 && list[at - 1].template === 'hive_clear' && !list[at - 1].name) at--;
    list.splice(at, 0, ...cards);
  }
}
function hsOctoAlerts(o) {
  const a = hsOctoFill(HS_OCTO.alerts, o);
  const keep = { free_announced: !!o.events, free_soon: !!o.free, free_now: !!o.free, saving_soon: !!o.saving, power_down_soon: !!o.powerDown };
  a.triggers = a.triggers.filter((t) => keep[t.id]);
  a.actions[0].choose = a.actions[0].choose.filter((b) => keep[b.conditions[0].id]);
  return a;
}

// ---------- Rooms page (room photos) and radiators calling the boiler ----------
const HS_AREA_PHOTO = "[[[ const e = hass.entities && entity ? hass.entities[entity.entity_id] : null; let a = e && e.area_id; if (!a && e && e.device_id && hass.devices && hass.devices[e.device_id]) a = hass.devices[e.device_id].area_id; const ar = a && hass.areas ? hass.areas[a] : null; return (ar && ar.picture) || ''; ]]]";
function hsAreaOf(hass, eid) {
  const e = hass.entities && hass.entities[eid];
  if (!e) return '';
  return e.area_id || (e.device_id && hass.devices && hass.devices[e.device_id] && hass.devices[e.device_id].area_id) || '';
}
const hsIsTemp = (hass, id) => { const st = hass.states[id]; return !!(st && id.startsWith('sensor.') && st.attributes.device_class === 'temperature' && !/battery|cpu|processor|chip|_rad_|radiator|trv|valve|boiler|flow|outdoor|outside|weather|forecast|dew/i.test(id + ' ' + (st.attributes.friendly_name || ''))); };
// A temperature sensor in the radiator's room (same Area), not part of the valve or the thermostat
function hsRoomSensor(hass, valve, main) {
  const a = hsAreaOf(hass, valve);
  if (!a) return '';
  return Object.keys(hass.states).filter((id) => hsIsTemp(hass, id) && hsAreaOf(hass, id) === a && !hsSameDevice(hass, id, valve) && !(main && hsSameDevice(hass, id, main))).sort()[0] || '';
}
function hsHumidityFor(hass, temp) {
  if (!temp) return '';
  return hsDeviceEntities(hass, temp).find((x) => x.startsWith('sensor.') && (hass.states[x].attributes || {}).device_class === 'humidity') || '';
}
function hsRoomsView(out, c, urlPath) {
  const valves = c.valves || [];
  const nav = (() => { for (const v of out.views) for (const se of v.sections || []) for (const x of se.cards || []) if (x.type === 'custom:navbar-card') return x; return null; })();
  const card = (v) => {
    const o = hsObj(v.entity);
    const tu = ['timer.boost_' + o, 'input_boolean.hive_room_schedule_' + o, v.roomTemp, v.roomHum, c.main, 'binary_sensor.' + hsObj(c.main) + '_state', ...(v.hive ? ['binary_sensor.' + o + '_state', 'binary_sensor.' + o + '_boost'] : [])].filter(Boolean);
    return {
      type: 'custom:button-card', template: 'hive_photo_device', entity: v.entity,
      variables: { name: v.name, icon: 'mdi:radiator', room_temp: v.roomTemp || '', room_humidity: v.roomHum || '' },
      tap_action: { action: 'navigate', navigation_path: `/${urlPath}/${v.slug}` },
      custom_fields: { boost: { card: { type: 'custom:button-card', template: 'hive_boost_pill', entity: v.entity } } },
      grid_options: { columns: 'full' }, triggers_update: tu,
    };
  };
  const sensors = [];
  for (const v of valves) if (v.roomTemp && !sensors.some((x) => x.entity === v.roomTemp)) sensors.push({ entity: v.roomTemp, name: v.name.replace(/\s+(radiator|rad|trv|valve)$/i, '') || v.name, hum: v.roomHum });
  const cards = [
    { type: 'custom:button-card', template: 'hive_page_title', name: 'Rooms', grid_options: { columns: 'full' } },
    ...valves.map(card),
  ];
  if (sensors.length) {
    cards.push({ type: 'custom:button-card', template: 'hive_section_title', name: 'Room temperatures', grid_options: { columns: 'full' } });
    for (const x of sensors) cards.push({ type: 'custom:button-card', template: 'hive_sensor', entity: x.entity, variables: { name: x.name, icon: 'mdi:home-thermometer-outline', humidity: x.hum || '' }, grid_options: { columns: 6 }, triggers_update: x.hum ? [x.hum] : [] });
  }
  cards.push({ type: 'custom:button-card', template: 'hive_clear', grid_options: { columns: 'full' }, styles: { card: [{ height: '150px' }] } });
  if (nav) cards.push(JSON.parse(JSON.stringify(nav)));
  return { title: 'Rooms', path: 'rooms', type: 'sections', max_columns: 1, background: 'var(--hs-page,#F4F5FA)', sections: [{ type: 'grid', cards }] };
}
function hsAddRooms(out, c, urlPath) {
  out.button_card_templates = out.button_card_templates || {};
  out.button_card_templates.hive_photo_device = JSON.parse(hsSplitAll(JSON.stringify(HS_ROOMS.photo), HS_T.main, c.main));
  // the room's photo behind its own page too (the scroll wheel finds it by itself)
  const det = out.button_card_templates.hive_detail;
  if (det) det.variables = Object.assign({}, det.variables, { bg_photo: HS_AREA_PHOTO });
  const view = hsRoomsView(out, c, urlPath);
  const at = out.views.findIndex((v) => v.path === 'insights');
  out.views.splice(at < 0 ? 1 : at, 0, view);
  // a Rooms button on the bottom menu, after Home
  const route = { icon: 'mdi:floor-plan', label: 'Rooms', url: `/${urlPath}/rooms` };
  const fix = (o) => { if (Array.isArray(o)) o.forEach(fix); else if (o && typeof o === 'object') { if (o.type === 'custom:navbar-card' && Array.isArray(o.routes) && !o.routes.some((r) => r.label === 'Rooms')) { const i = o.routes.findIndex((r) => /\/home$/.test(r.url || '')); o.routes.splice(i + 1, 0, Object.assign({}, route)); } else Object.values(o).forEach(fix); } };
  fix(out.views);
}
function hsAddRoomCallTile(out) {
  const mg = out.views.find((v) => v.path === 'manage');
  if (!mg) return;
  const cards = mg.sections[0].cards;
  const i = cards.findIndex((x) => x.entity === 'input_boolean.hive_eco_when_nobody_home');
  const like = cards[i] || cards.find((x) => x.type === 'tile');
  const t = Object.assign({}, like ? JSON.parse(JSON.stringify(like)) : { type: 'tile', grid_options: { columns: 'full' } }, { entity: 'input_boolean.rooms_can_call_the_boiler_any_time', name: 'Rooms can call the boiler any time' });
  cards.splice(i < 0 ? cards.length : i + 1, 0, t);
}
function hsRoomCallAutomation(c) {
  const valves = c.valves || [];
  let s = JSON.stringify(HS_ROOMS.call.automation);
  s = hsSplitAll(s, HS_T.main, c.main);
  const a = JSON.parse(s);
  const trig = [];
  for (const v of valves) {
    const o = hsObj(v.entity);
    trig.push(v.entity, 'input_boolean.hive_room_schedule_' + o);
    trig.push(...(v.hive ? ['binary_sensor.' + o + '_state', 'binary_sensor.' + o + '_boost'] : []), 'timer.boost_' + o);
  }
  trig.push('input_boolean.rooms_can_call_the_boiler_any_time', 'input_boolean.hive_away_eco_active', 'input_boolean.heating_away_mode');
  a.triggers[0].entity_id = trig;
  a.actions[0].variables.rooms = valves.map((v) => v.entity);
  return a;
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
  // one "follows the heating schedule" switch per radiator (in place of the example one)
  for (const k of Object.keys(p.input_boolean)) if (k.startsWith('hive_room_schedule_')) delete p.input_boolean[k];
  for (const v of c.valves || []) p.input_boolean['hive_room_schedule_' + hsObj(v.entity)] = { name: `${v.name} follows the heating schedule`, icon: 'mdi:calendar-sync' };
  if (!c.water) hsStripWater(p);
  if (c.backend === 'z2m') hsZ2M(p, c);
  if (c.backend === 'other') hsOtherMain(p, c);
  if (c.backend !== 'hive' && !c.water && !(c.valves || []).some((v) => v.hive)) hsStripHiveIntegration(p);
  if (c.roomCall && HS_ROOMS && (c.valves || []).length) {
    Object.assign(p.input_boolean, HS_ROOMS.call.input_boolean);
    p.input_number = Object.assign({}, p.input_number, HS_ROOMS.call.input_number);
    p.automation.push(hsRoomCallAutomation(c));
  }
  if (c.octopus && c.octopus.notify && HS_OCTO && (c.octopus.free || c.octopus.saving || c.octopus.powerDown)) p.automation.push(hsOctoAlerts(c.octopus));
  // no "Approaching home" zone: leave the warm-up switch and its trigger out
  if (!c.approach) {
    delete p.input_boolean.hive_warm_up_approaching;
    const pe = p.automation.find((x) => x.id === 'hive_style_presence_eco');
    if (pe) {
      pe.triggers = pe.triggers.filter((t) => t.id !== 'approaching');
      const back = pe.actions[0].choose[2];
      back.conditions = [back.conditions[0], { condition: 'trigger', id: 'home' }];
    }
  }
  return p;
}

// Any other thermostat (Netatmo, Tado, Nest, generic_thermostat...): Boost works like the valves:
// a snapshot, the boost temperature, and a Home Assistant timer that puts it back when it ends.
function hsOtherMain(p, c) {
  const main = c.main, timer = 'timer.boost_' + hsObj(main);
  const b = p.script.hive_boost, v = b.sequence[0].variables;
  v.boosting = v.boosting.replace(new RegExp(`(\\{% (?:el)?if entity_id == '${main.replace(/\./g, '\\.')}' %\\})\\{\\{[^}]*\\}\\}`), `$1{{ is_state('${timer}', 'active') }}`);
  v.is_hive = v.is_hive.replace(/^\{\{\s*/, `{{ entity_id != '${main}' and (`).replace(/\s*\}\}$/, ') }}');
  { const cs = b.sequence.find((x) => x.choose); cs.choose = cs.choose.filter((x) => x.alias !== 'Main thermostat boosting - cancel'); }
}

// Fully local (no Hive integration): leave out every step that calls a hive.* action,
// so tools like Spook don't flag actions that don't exist on this system.
function hsStripHiveIntegration(p) {
  const usesHive = (o) => /"action":"hive\./.test(JSON.stringify(o));
  for (const sc of Object.values(p.script)) {
    for (const step of sc.sequence || []) {
      if (!step.choose) continue;
      step.choose = step.choose.filter((b) => !usesHive(b));
      if (step.default && usesHive(step.default)) delete step.default;
    }
    if (sc.description) sc.description = sc.description.replace(/Hive thermostat and hot water use[\s\S]*?TRVs\)\. /, '');
  }
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
      { delay: { seconds: 3 } },
      { if: [{ condition: 'template', value_template: `{{ '${scene}' in (states.scene | map(attribute='entity_id') | list) }}` }],
        then: [{ action: 'scene.turn_on', target: { entity_id: scene } }] },
      // some receivers come out of boost late with a silly target (e.g. 1 degC): check again and put it right
      { delay: { seconds: 6 } },
      { if: [{ condition: 'template', value_template: `{{ '${scene}' in (states.scene | map(attribute='entity_id') | list) and (state_attr('${main}', 'temperature') | float(0)) < 5 }}` }],
        then: [{ action: 'scene.turn_on', target: { entity_id: scene } }] },
      { if: [{ condition: 'state', entity_id: 'input_boolean.hive_ha_schedule', state: 'on' }],
        then: [{ action: 'script.hive_apply_schedule_now' }] },
    ],
  };
  const b = p.script.hive_boost;
  const v = b.sequence[0].variables;
  v.is_z2m = `{{ entity_id == '${main}' }}`;
  v.boosting = v.boosting.replace(new RegExp(`(\\{% (?:el)?if entity_id == '${main.replace(/\./g, '\\.')}' %\\})\\{\\{[^}]*\\}\\}`), `$1{{ is_state('${timer}', 'active') }}`);
  const ch = b.sequence.find((x) => x.choose).choose;
  ch.unshift(
    { alias: 'Zigbee2MQTT receiver boosting - cancel', conditions: '{{ is_z2m and boosting }}', sequence: [{ action: 'script.hive_z2m_end_boost' }] },
    { alias: 'Zigbee2MQTT receiver - start boost', conditions: '{{ is_z2m }}', sequence: [
      { action: 'scene.create', data: { scene_id: sceneId, snapshot_entities: [main] } },
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
  // Away mode without hot water
  const aw = (p.automation || []).find((x) => x.id === 'hive_style_away_mode');
  if (aw) {
    delete aw.variables.water; delete aw.variables.water_boost;
    const dropW = (list) => (Array.isArray(list) ? list.filter((x) => !/^Away - hot water/.test((x && x.alias) || '')).map((x) => {
      if (x && typeof x === 'object') for (const k of ['sequence', 'then', 'else']) if (Array.isArray(x[k])) x[k] = dropW(x[k]);
      if (x && Array.isArray(x.choose)) x.choose.forEach((c) => { c.sequence = dropW(c.sequence); });
      return x;
    }) : list);
    aw.actions = dropW(aw.actions);
    const noW = (o) => { if (Array.isArray(o)) return o.map(noW); if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = noW(o[k]); return o; } return typeof o === 'string' ? o.split(" + ([water] if has_value(water) else [])").join('').split("('water_' if repeat.item.startswith('water_heater.') else '') ~ ").join('') : o; };
    aw.actions = noW(aw.actions);
  }
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
            .replace(/\('water_' if entity_id\.startswith\('water_heater\.'\) else ''\) ~ /g, '')
            .replace(/\{% elif entity_id == 'water_heater\.none' %\}[\s\S]*?(?=\{% (elif|else)\b)/g, '');
        }
      }
      if (step.choose) step.choose = step.choose.filter(notWater);
    }
    // "if hot water ... else ..." steps inside the branches: keep only the heating side
    const unwater = (list) => (Array.isArray(list) ? list.flatMap((x) => {
      if (x && x.if === '{{ is_water }}') return unwater(x.else || []);
      if (x && typeof x === 'object') {
        for (const k of ['sequence', 'then', 'else', 'default']) if (Array.isArray(x[k])) x[k] = unwater(x[k]);
        if (Array.isArray(x.choose)) x.choose.forEach((c) => { if (Array.isArray(c.sequence)) c.sequence = unwater(c.sequence); });
      }
      return [x];
    }) : list);
    sc.sequence = unwater(sc.sequence);
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
      main = climates.find((e) => hsPlatform(h, e) === 'hive' && !hsLooksLikeValve(h, e) && !/hot.?tub|spa|pool/i.test(e + hsName(h, e)))
        || climates.find((e) => hsPlatform(h, e) === 'hive' && !hsLooksLikeValve(h, e))
        || climates.find((e) => /thermostat/.test(e) && !/hot.?tub|spa|pool/i.test(e + hsName(h, e)))
        || climates[0] || '';
    }
    let water = saved ? (saved.water && h.states[saved.water] ? saved.water : '') : (waters.find((e) => hsPlatform(h, e) === 'hive') || waters[0] || '');
    const savedValves = saved && saved.valves ? Object.fromEntries(saved.valves.map((v) => [v.entity, v])) : null;
    this._s = {
      climates, waters, main, water, saved: !!saved,
      valves: climates.filter((e) => e !== main).map((e) => {
        const sv = savedValves && savedValves[e];
        const guess = hsIsHiveValve(h, e) || /radiator|trv|valve|rad\b|_rad$/.test(e + ' ' + hsName(h, e).toLowerCase());
        return { entity: e, name: sv ? hsDedupe(sv.name) : hsName(h, e), on: savedValves ? !!sv : (guess && !hsNotRad(h, e)), roomTemp: sv && sv.roomTemp !== undefined ? sv.roomTemp : hsRoomSensor(h, e, main) };
      }),
      det: hsDetect(h, main, water),
      ...hsZ2MDefaults(h, main),
      octo: hsOctoDetect(h), octoOn: true, octoNotify: '',
      mainName: (saved && saved.mainName) || 'Thermostat',
      // free since 1.7.0: on unless you turned them off here before
      rooms: !(saved && saved.rooms === false), roomCall: !(saved && saved.roomCall === false),
      log: [], busy: false, done: false,
      // scripts already there (an earlier setup, or your own): leave them alone unless you untick this
      replaceOwn: false,
    };
    // Octopus: on unless you turned it off here before (dashboards set up before Octopus was offered get it ticked)
    if (saved && saved.octopus !== undefined) { const s0 = saved.octopus; this._s.octoOn = !!s0; this._s.octoNotify = (s0 && s0.notify) || ''; }
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
    const temps = sens.filter((e) => (h.states[e].attributes || {}).device_class === 'temperature').sort((a, b) => hsName(h, a).localeCompare(hsName(h, b)));
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
    <div class="lab">Name on the dashboard</div>
    <input id="mainName" class="v-name" value="${hsEsc(s.mainName)}" placeholder="Thermostat">
    <div class="lab">Connected through</div>
    <select id="backend"><option value="hive" ${s.backend === 'hive' ? 'selected' : ''}>Hive hub (Hive integration)</option><option value="z2m" ${z2m ? 'selected' : ''}>Zigbee2MQTT (local) - beta</option><option value="other" ${s.backend === 'other' ? 'selected' : ''}>Another thermostat (Home Assistant boost)</option></select>
    ${s.backend === 'other' ? `<div class="note">Any thermostat in Home Assistant works. Boost sets the temperature you pick and a Home Assistant timer puts the thermostat back how it was when the boost ends.</div>` : ''}
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
          <div class="vid">${hsEsc(v.entity)} · ${hsIsHiveValve(h, v.entity) ? 'Hive boost' : 'Home Assistant boost'}</div>${hsNotRad(h, v.entity) ? `<div class="vwarn">⚠ ${hsNotRad(h, v.entity)}</div>` : ''}
          ${s.rooms && v.on ? `<div class="lab">Room temperature sensor (optional, shown on the Rooms page)</div><select class="v-room" data-i="${i}">${this._opt(temps, v.roomTemp, 'None (use the valve)')}</select>` : ''}
        </div>
      </div>`).join('') : '<div class="note">No other climate entities found.</div>'}
  </div>

  <div class="box">
    <div class="h">Rooms</div>
    <label class="chk2"><input type="checkbox" id="roomsOn" ${s.rooms ? 'checked' : ''}> <span><b>Rooms page with room photos.</b> Every radiator as a card with its room's picture, and the photo behind each room's page. Photos come from Settings → Areas → (room) → picture; a room without one shows a plain card.</span></label>
    <label class="chk2"><input type="checkbox" id="roomCall" ${s.roomCall ? 'checked' : ''}> <span><b>Radiators can turn the boiler on.</b> Boost one radiator while the heating is off and the boiler fires just for it (the thermostat is raised a little, then put back to the schedule). A room on its own schedule does the same. Manage gets a "Rooms can call the boiler any time" switch.</span></label>
  </div>

  ${this._octoBox()}

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
    if ($('mainName')) $('mainName').oninput = (e) => { s.mainName = e.target.value; };
    if ($('z2mCh')) $('z2mCh').onchange = (e) => { s.z2mCh = e.target.value; };
    $('water').onchange = (e) => { s.water = e.target.value; s.det = hsDetect(h, s.main, s.water); this._render(); };
    ['mainBoost', 'waterBoost', 'waterState', 'battery', 'hub'].forEach((k) => { const el = $(k); if (el) el.onchange = (e) => { s.det[k] = e.target.value; }; });
    $('replaceOwn').onchange = (e) => { s.replaceOwn = e.target.checked; };
    if ($('octoOn')) $('octoOn').onchange = (e) => { s.octoOn = e.target.checked; this._render(); };
    if ($('octoNotify')) $('octoNotify').onchange = (e) => { s.octoNotify = e.target.value; };
    this.shadowRoot.querySelectorAll('.v-on').forEach((el) => { el.onchange = () => { valves[+el.dataset.i].on = el.checked; if (s.rooms) this._render(); }; });
    this.shadowRoot.querySelectorAll('.v-room').forEach((el) => { el.onchange = () => { valves[+el.dataset.i].roomTemp = el.value; }; });
    if ($('roomsOn')) $('roomsOn').onchange = (e) => { s.rooms = e.target.checked; this._render(); };
    if ($('roomCall')) $('roomCall').onchange = (e) => { s.roomCall = e.target.checked; };
    this.shadowRoot.querySelectorAll('.v-name[data-i]').forEach((el) => { el.oninput = () => { valves[+el.dataset.i].name = el.value; }; });
    if ($('create')) $('create').onclick = () => this._install();
    if ($('open')) $('open').onclick = () => this._go(`/${this._urlPath()}/home`);
  }

  _octoBox() {
    const h = this._hass, s = this._s, o = s.octo;
    const phones = Object.keys((h.services && h.services.notify) || {}).filter((n) => n.startsWith('mobile_app_')).sort();
    if (!hsOctoAny(o)) return `<div class="box"><div class="h">Octopus Energy</div><div class="note">Not found. With the <b>Octopus Energy</b> integration (from HACS) the dashboard can show a free-electricity / Saving Session banner, your gas and electricity spend, and send phone alerts. For the banner and alerts, also enable its "Octoplus Free Electricity" and "Saving Sessions" entities (they're off by default), then come back here.</div></div>`;
    const found = [o.free && 'free electricity', o.saving && 'Saving Sessions', o.powerDown && 'Power Downs', o.gas && 'gas spend', o.elec && 'electricity spend'].filter(Boolean).join(', ');
    return `<div class="box"><div class="h">Octopus Energy</div>
    <div class="note">Found: ${hsEsc(found)}.</div>
    <label class="chk2"><input type="checkbox" id="octoOn" ${s.octoOn ? 'checked' : ''}> Add Octopus to the dashboard (${o.free || o.saving ? 'banner on Home' : ''}${(o.free || o.saving) && (o.gas || o.elec) ? ', ' : ''}${o.gas || o.elec ? 'spend on Insights' : ''})</label>
    ${s.octoOn && (o.free || o.saving || o.powerDown) ? `<div class="lab">Phone alerts (free electricity, Saving Sessions, Power Downs)</div>
    ${phones.length ? '' : '<div class="note">No phone found: install the Home Assistant app on your phone to get alerts.</div>'}
    <select id="octoNotify"><option value="">No alerts</option>${phones.map((n) => `<option value="notify.${n}" ${s.octoNotify === 'notify.' + n ? 'selected' : ''}>${hsEsc(n.replace(/^mobile_app_/, '').replace(/_/g, ' '))}</option>`).join('')}</select>` : ''}
    ${!o.free && !o.saving ? '<div class="note">For the banner and alerts, enable the integration\'s "Octoplus Free Electricity" and "Saving Sessions" entities (off by default).</div>' : ''}
    </div>`;
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
      if (['home', 'thermostat', 'hot-water', 'schedule', 'schedule-edit', 'water-schedule', 'insights', 'manage', 'setup', 'thermostat-picker', 'rooms'].includes(slug) || /-(picker|schedule)$/.test(slug)) slug += '-room';
      while (used.has(slug)) slug += '-2';
      used.add(slug);
      const roomTemp = v.roomTemp && h.states[v.roomTemp] ? v.roomTemp : '';
      return { entity: v.entity, name: (v.name || hsName(h, v.entity)).trim(), slug, hive: hsIsHiveValve(h, v.entity), battery: hsBattery(h, v.entity), roomTemp, roomHum: hsHumidityFor(h, roomTemp) };
    });
    const other = s.backend === 'other';
    const c = { version: HSTC_VERSION, main: s.main, mainName: String(s.mainName || '').trim() || 'Thermostat', water: s.water || '', valves, ...s.det, backend: z2m ? 'z2m' : (other ? 'other' : 'hive'), approach: !!h.states['zone.approaching_home'], rooms: !!s.rooms, roomCall: !!s.roomCall };
    if (other) c.mainBoost = '';
    if (hsOctoAny(s.octo)) c.octopus = s.octoOn ? Object.assign({}, s.octo, { notify: s.octoNotify || '' }) : false;
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
      for (const [id, cfg] of Object.entries(pkg.input_number || {})) {
        if (h.states['input_number.' + id]) { log('ok', `✓ ${cfg.name}: already there`); continue; }
        const nb = { name: id, icon: cfg.icon, min: cfg.min, max: cfg.max, step: cfg.step, unit_of_measurement: cfg.unit_of_measurement, mode: cfg.mode };
        await h.callWS(Object.assign({ type: 'input_number/create' }, nb));
        await h.callWS(Object.assign({ type: 'input_number/update', input_number_id: id }, nb, { name: cfg.name }));
        // starting value (not 'initial', which would reset it on every restart)
        if (id === 'hive_away_temperature') { for (let i = 0; i < 20 && !this._hass.states['input_number.' + id]; i++) await new Promise((r) => setTimeout(r, 150)); try { await h.callService('input_number', 'set_value', { entity_id: 'input_number.' + id, value: 12 }); } catch (e) {} }
        log('ok', `✓ Created setting: ${cfg.name}`);
      }
      for (const [id, cfg] of Object.entries(pkg.input_select || {})) {
        const cur = h.states['input_select.' + id];
        if (cur) {
          const have = (cur.attributes.options || []).map(String);
          const add = (cfg.options || []).filter((o) => !have.includes(o));
          if (add.length) {
            try { await h.callWS(Object.assign({ type: 'input_select/update', input_select_id: id, name: cur.attributes.friendly_name || cfg.name, options: [...have, ...add] }, cur.attributes.icon ? { icon: cur.attributes.icon } : {})); log('ok', `✓ ${cfg.name}: added ${add.join(', ')}`); }
            catch (e) { log('info', `• ${cfg.name}: set up in YAML - add ${add.join(', ')} to its options yourself`); }
          } else log('ok', `✓ ${cfg.name}: already there`);
          continue;
        }
        await h.callWS({ type: 'input_select/create', name: id, icon: cfg.icon, options: cfg.options });
        await h.callWS({ type: 'input_select/update', input_select_id: id, name: cfg.name, icon: cfg.icon, options: cfg.options });
        log('ok', `✓ Created setting: ${cfg.name}`);
      }
      // 2. Boost timers: valves without Hive's own boost always use them; Hive devices use them
      //    when the Hive integration has no boost actions
      const timerFor = valves.map((x) => ({ entity: x.entity, name: x.name }));
      timerFor.unshift({ entity: c.main, name: 'heating' });
      if (c.water) timerFor.push({ entity: c.water, name: 'hot water' });
      for (const v of timerFor) {
        const id = 'boost_' + (v.entity.startsWith('water_heater.') ? 'water_' : '') + hsObj(v.entity);
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
.vwarn { font-size: 13px; color: #C2410C; margin-top: 2px; }
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

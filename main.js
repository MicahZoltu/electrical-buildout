/* main.js — simulation loop + slider wiring + persistence + config modal.
   Loaded as an ES module. Replaces the old slider-driven update() with a
   requestAnimationFrame clock loop (1 day ≈ 48s real time).
*/
import {
  CONST,
  computeIrradiance, mpptPowerKW, mpptVmp, totalSolarKW,
  computeStateSim, stepBatteries,
} from './model.js';
import { DEFAULT_CONFIG } from './config.js';
import { init, render, attachTooltips } from './render.js';

/* ---------- DOM ---------- */
const svg = document.getElementById('diagram');
const tip = document.getElementById('tooltip');
const summary = document.getElementById('summary');

const S = {
  clock: document.getElementById('clockSlider'),
  delta: document.getElementById('deltaSlider'),
  wye:   document.getElementById('wyeSlider'),
  one:   document.getElementById('oneSlider'),
  overcast: document.getElementById('overcastBtn'),
  config: document.getElementById('configBtn'),
};
const V = {
  clock: document.getElementById('clockVal'),
  phase: document.getElementById('phaseVal'),
  delta: document.getElementById('deltaVal'),
  wye:   document.getElementById('wyeVal'),
  one:   document.getElementById('oneVal'),
};

// Configure load slider maxes from CONST
S.delta.max = CONST.loads.delta.kw.toFixed(1);
S.wye.max   = CONST.loads.wye.kw.toFixed(1);
S.one.max   = CONST.loads.one.kw.toFixed(1);

/* ---------- PERSISTENCE ---------- */
const LS = {
  config: 'eb_config',
  soc:    'eb_soc',
  simHour:'eb_simHour',
  loads:  'eb_loads',
  overcast:'eb_overcast',
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// Deep clone so we never mutate the imported DEFAULT_CONFIG.
function cloneConfig(cfg) {
  return {
    mppts: cfg.mppts.map(m => ({ ...m, orientation: { ...m.orientation } })),
    banks: cfg.banks.map(b => ({ ...b })),
  };
}

let config = loadJSON(LS.config, null) || cloneConfig(DEFAULT_CONFIG);
let simHour = (() => {
  const h = loadJSON(LS.simHour, 0);
  return clampNum(h, 0, 24, 0);
})();
let overcast = !!loadJSON(LS.overcast, false);
const persistedLoads = loadJSON(LS.loads, { delta:0, wye:0, one:0 });

// Live bank SoC — read from config banks on first load (their `soc` field),
// or from persisted eb_soc array if present.
let banks = config.banks.map((b, i) => {
  const persistedSoc = loadJSON(LS.soc, null);
  const soc = Array.isArray(persistedSoc) && persistedSoc[i] != null
    ? clampNum(persistedSoc[i], 0, 100, b.soc ?? 50)
    : (b.soc ?? 50);
  return { ...b, soc };
});

// Load slider initial values from persistence
S.delta.value = persistedLoads.delta ?? 0;
S.wye.value   = persistedLoads.wye ?? 0;
S.one.value   = persistedLoads.one ?? 0;
S.clock.value = simHour;
updateOvercastBtn();

/* ---------- INIT RENDER ---------- */
init(svg, config);
attachTooltips(tip);

/* ---------- SIMULATION LOOP ---------- */
const MS_PER_HOUR = 2000;   // 1 hour simulated = 2000 ms real → 1 day ≈ 48s
let lastFrame = performance.now();
let lastPersist = 0;
let scrubbing = false;

function readLoads() {
  return {
    delta: Number(S.delta.value),
    wye:   Number(S.wye.value),
    one:   Number(S.one.value),
  };
}

function frame(now) {
  // dt → simulated hours, clamped to avoid huge jumps on tab refocus
  let dtHours = (now - lastFrame) / MS_PER_HOUR;
  dtHours = Math.max(0, Math.min(0.5, dtHours));
  lastFrame = now;

  if (!scrubbing) {
    simHour = (simHour + dtHours) % 24;
    S.clock.value = simHour;
  }

  tick(dtHours, now);
  requestAnimationFrame(frame);
}

function tick(dtHours, now) {
  // 1. irradiance + solar
  const irradiance = computeIrradiance(simHour, overcast);
  const solarTotalKW = totalSolarKW(config, irradiance);

  // per-MPPT power + Vmp (for rendering labels)
  const perMpptKW = config.mppts.map(m => mpptPowerKW(m, irradiance));
  const vmpByMppt = config.mppts.map(m => mpptVmp(m, irradiance));

  // 2. loads
  const loads = readLoads();

  // 3. regime + per-bank kW
  const state = computeStateSim({
    solarTotalKW,
    loads,
    banks,
    config,
  });

  // 4. step batteries (mutate SoC)
  const stepped = stepBatteries(state, dtHours);
  stepped.forEach(p => {
    const b = banks.find(bb => bb.id === p.id);
    if (b) b.soc = p.soc;
  });
  state.perBank = stepped;

  // attach display arrays for render
  state.perMpptKW = perMpptKW;
  state.vmpByMppt = vmpByMppt;
  state.irradiance = irradiance;
  state.simHour = simHour;
  state.overcast = overcast;

  // 5. persist (throttled ~1s real)
  if (now - lastPersist > 1000) {
    lastPersist = now;
    saveJSON(LS.simHour, round(simHour, 3));
    saveJSON(LS.soc, banks.map(b => round(b.soc, 2)));
    saveJSON(LS.loads, loads);
    saveJSON(LS.overcast, overcast);
    saveJSON(LS.config, config);
  }

  // 6. render + labels
  render(state);
  updateLabels(state, loads);
}

function updateLabels(state, loads) {
  // clock
  V.clock.textContent = formatTime(simHour);
  V.phase.textContent = phaseLabel(simHour);
  // loads
  V.delta.textContent = loads.delta.toFixed(1) + ' kW';
  V.wye.textContent   = loads.wye.toFixed(1) + ' kW';
  V.one.textContent   = loads.one.toFixed(1) + ' kW';

  // side panel summary
  const perMppt = config.mppts.map((m, i) => `${m.id}: ${m.enabled===false?'off':(state.perMpptKW[i]||0).toFixed(1)+' kW'}`).join(' · ');
  const bankLines = banks.map(b => {
    const p = state.perBank.find(pp => pp.id === b.id);
    const soc = p ? p.soc : b.soc;
    const mode = p ? p.mode : (b.enabled===false?'off':'idle');
    const kw = p ? p.kw : 0;
    const vBat = p ? p.vBat : 0;
    const modeTag = { charge:'CHG', discharge:'DIS', idle:'IDLE', off:'OFF' }[mode] || mode;
    return `<div class="row"><span class="lbl">Bank ${b.id}</span><span>${soc.toFixed(0)}% · ${vBat ? Math.round(vBat):'–'}V · ${modeTag} ${kw>0?kw.toFixed(1)+' kW':''}</span></div>`;
  }).join('');
  const phaseStr = phaseLabel(simHour);
  const lines = [
    `<div class="sec">
      <div class="row"><span class="lbl">Time</span><span>${formatTime(simHour)} · ${phaseStr}${overcast?' · overcast':''}</span></div>
      <div class="row"><span class="lbl">Regime</span><span style="color:var(--${regColor(state.regime)})">${state.regime} · ${state.busV}V</span></div>
    </div>`,
    `<div class="sec">
      <div class="row"><span class="lbl">Irradiance</span><span>${Math.round(state.irradiance)} W/m²</span></div>
      <div class="row"><span class="lbl">Solar total</span><span style="color:var(--solar)">${state.solarTotalKW.toFixed(1)} kW</span></div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px">${perMppt}</div>
    </div>`,
    `<div class="sec">
      <div class="row"><span class="lbl">Charge</span><span style="color:var(--solar)">${state.chargeKW.toFixed(1)} kW</span></div>
      <div class="row"><span class="lbl">Discharge</span><span style="color:var(--battery)">${state.dischargeKW.toFixed(1)} kW</span></div>
      <div class="row"><span class="lbl">Grid</span><span style="color:var(--grid)">${state.gridKW>0?state.gridKW.toFixed(1)+' kW':'off'}</span></div>
    </div>`,
    `<div class="sec">${bankLines}</div>`,
    `<div class="sec">
      <div class="row"><span class="lbl">Load total</span><span>${state.totalLoad.toFixed(1)} kW</span></div>
      <div class="row"><span class="lbl">Δ / Y / 1φ</span><span>${loads.delta.toFixed(1)} / ${loads.wye.toFixed(1)} / ${loads.one.toFixed(1)}</span></div>
    </div>`,
  ];
  summary.innerHTML = lines.join('');
}

function updateOvercastBtn() {
  S.overcast.classList.toggle('on', overcast);
  S.overcast.textContent = overcast ? 'Overcast' : 'Clear';
}

function regColor(r){
  return { idle:'muted', surplus:'solar', discharge:'battery', grid:'grid' }[r] || 'muted';
}

function formatTime(h) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
}
function phaseLabel(h) {
  if (h < 5.5 || h >= 19) return 'night';
  if (h < 7) return 'dawn';
  if (h < 17) return 'day';
  return 'dusk';
}

/* ---------- CONTROL WIRING ---------- */
// Day/night slider: scrub while dragging, resume auto-advance on release.
S.clock.addEventListener('pointerdown', () => { scrubbing = true; });
S.clock.addEventListener('pointerup',   () => { scrubbing = false; lastFrame = performance.now(); });
S.clock.addEventListener('pointercancel', () => { scrubbing = false; lastFrame = performance.now(); });
S.clock.addEventListener('input', () => {
  scrubbing = true;
  simHour = clampNum(Number(S.clock.value), 0, 24, simHour);
  // immediate visual feedback even before next frame
  V.clock.textContent = formatTime(simHour);
  V.phase.textContent = phaseLabel(simHour);
});

// Load sliders — apply instantly on next sim step (no handler needed beyond
// the read in tick), but update labels immediately for responsiveness.
[S.delta, S.wye, S.one].forEach(s => s.addEventListener('input', () => {
  V[s.id].textContent = Number(s.value).toFixed(1) + ' kW';
}));

// Overcast toggle — immediate effect on next frame.
S.overcast.addEventListener('click', () => {
  overcast = !overcast;
  updateOvercastBtn();
  saveJSON(LS.overcast, overcast);
});

S.config.addEventListener('click', openConfigModal);

/* ---------- CONFIG MODAL ---------- */
const modal = document.getElementById('configModal');
const mpptTableBody = document.querySelector('#mpptTable tbody');
const bankTableBody = document.querySelector('#bankTable tbody');
const cfgErr = document.getElementById('cfgErr');

// We edit a working copy; only commit to `config` on Save.
let editing = null;

function openConfigModal() {
  editing = cloneConfig(config);
  cfgErr.textContent = '';
  renderConfigTables();
  modal.classList.add('open');
}
function closeConfigModal() {
  modal.classList.remove('open');
  editing = null;
}

function renderConfigTables() {
  // MPPTs
  mpptTableBody.innerHTML = '';
  editing.mppts.forEach((m, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-kind="mppt" data-i="${i}" data-f="enabled" ${m.enabled?'checked':''}></td>
      <td>${m.id}</td>
      <td><input type="number" min="1" data-kind="mppt" data-i="${i}" data-f="panels" value="${m.panels}"></td>
      <td><input type="number" min="1" data-kind="mppt" data-i="${i}" data-f="series" value="${m.series}"></td>
      <td><input type="number" min="1" data-kind="mppt" data-i="${i}" data-f="parallel" value="${m.parallel}"></td>
      <td><input type="number" min="1" data-kind="mppt" data-i="${i}" data-f="wattSTC" value="${m.wattSTC}"></td>
      <td><input type="number" min="1" data-kind="mppt" data-i="${i}" data-f="vmpSTC" value="${m.vmpSTC}"></td>
      <td><input type="number" min="1" data-kind="mppt" data-i="${i}" data-f="vocSTC" value="${m.vocSTC}"></td>
    `;
    mpptTableBody.appendChild(tr);
  });
  // Banks
  bankTableBody.innerHTML = '';
  editing.banks.forEach((b, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-kind="bank" data-i="${i}" data-f="enabled" ${b.enabled?'checked':''}></td>
      <td>${b.id}</td>
      <td><input type="number" min="300" max="500" data-kind="bank" data-i="${i}" data-f="nominalV" value="${b.nominalV}"></td>
      <td><input type="number" min="10" max="20" data-kind="bank" data-i="${i}" data-f="kwh" value="${b.kwh}"></td>
      <td><input type="number" min="1" data-kind="bank" data-i="${i}" data-f="maxChargeA" value="${b.maxChargeA}"></td>
      <td><input type="number" min="1" data-kind="bank" data-i="${i}" data-f="maxDischargeA" value="${b.maxDischargeA}"></td>
      <td><input type="number" min="0" max="100" data-kind="bank" data-i="${i}" data-f="soc" value="${b.soc}"></td>
    `;
    bankTableBody.appendChild(tr);
  });
}

// Delegate input changes to the editing copy
[mpptTableBody, bankTableBody].forEach(tb => {
  tb.addEventListener('input', e => {
    const inp = e.target;
    const kind = inp.dataset.kind;
    const i = Number(inp.dataset.i);
    const f = inp.dataset.f;
    if (!kind || isNaN(i) || !f || !editing) return;
    const target = kind === 'mppt' ? editing.mppts[i] : editing.banks[i];
    if (f === 'enabled') target[f] = inp.checked;
    else target[f] = Number(inp.value);
  });
});

function validateConfig(cfg) {
  const errs = [];
  cfg.mppts.forEach((m, i) => {
    if (m.series * m.parallel !== m.panels) {
      errs.push(`${m.id}: series × parallel (${m.series}×${m.parallel}=${m.series*m.parallel}) ≠ panels (${m.panels}).`);
    }
    if (m.panels < 1 || m.series < 1 || m.parallel < 1) errs.push(`${m.id}: panels/series/parallel must be ≥ 1.`);
    if (m.wattSTC < 1) errs.push(`${m.id}: wattSTC must be ≥ 1.`);
    if (m.vmpSTC < 1 || m.vocSTC < 1) errs.push(`${m.id}: Vmp/Voc STC must be ≥ 1.`);
  });
  cfg.banks.forEach(b => {
    if (b.nominalV < 300 || b.nominalV > 500) errs.push(`Bank ${b.id}: nominalV must be 300–500.`);
    if (b.kwh < 10 || b.kwh > 20) errs.push(`Bank ${b.id}: kwh must be 10–20.`);
    if (b.maxChargeA < 1 || b.maxDischargeA < 1) errs.push(`Bank ${b.id}: max charge/discharge A must be ≥ 1.`);
    if (b.soc < 0 || b.soc > 100) errs.push(`Bank ${b.id}: SoC must be 0–100.`);
  });
  return errs;
}

document.getElementById('cfgSave').addEventListener('click', () => {
  const errs = validateConfig(editing);
  if (errs.length) { cfgErr.textContent = errs.join('\n'); return; }
  cfgErr.textContent = '';
  // Commit: hot-reload without restarting the clock.
  config = cloneConfig(editing);
  // carry over live SoC for banks that still exist (by id), else use new soc
  const newBanks = config.banks.map(b => {
    const old = banks.find(bb => bb.id === b.id);
    return { ...b, soc: old ? old.soc : b.soc };
  });
  banks = newBanks;
  saveJSON(LS.config, config);
  saveJSON(LS.soc, banks.map(b => round(b.soc, 2)));
  // re-init render with new config (rebuilds static boxes/SoC tracks); init()
  // clears previous content internally. Clock keeps running.
  init(svg, config);
  attachTooltips(tip);
  closeConfigModal();
});

document.getElementById('cfgCancel').addEventListener('click', closeConfigModal);
document.getElementById('cfgReset').addEventListener('click', () => {
  editing = cloneConfig(DEFAULT_CONFIG);
  renderConfigTables();
  cfgErr.textContent = '';
});
modal.addEventListener('click', e => {
  if (e.target === modal) closeConfigModal();
});

/* ---------- HELPERS ---------- */
function clampNum(v, lo, hi, fallback) {
  v = Number(v);
  if (!isFinite(v)) v = fallback;
  return Math.max(lo, Math.min(hi, v));
}
function round(v, d) { const m = Math.pow(10, d); return Math.round(v * m) / m; }

// render.js re-uses gNodes/gFlows/gLabels internally on re-init; expose nothing.

/* ---------- START ---------- */
requestAnimationFrame(frame);

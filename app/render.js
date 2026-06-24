/* render.js — SVG rendering from model state. Kept simple, untested.
   init(svg, config) draws static boxes once (config-driven). render(state)
   updates persistent dynamic elements in place every sim tick — elements are
   created lazily with stable IDs and never recreated while active, so the CSS
   dash animation on flow lines stays continuous instead of resetting at 60fps.
*/
import { CONST, PARTS, mpptVmp, totalSolarKW } from './model.js';
import { DEFAULT_CONFIG } from './config.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/* ---------- LAYOUT GRID ---------- */
const LAY = {
  W: 1320, H: 880,
  src: 120, dcdc: 330, bus: 480, dcac: 660, load: 881,
  busTop: 70, busBot: 770,
};

const SOLAR = [
  { id:'sol1', name:'Sub-array 1', x:LAY.src, y:90 },
  { id:'sol2', name:'Sub-array 2', x:LAY.src, y:165 },
  { id:'sol3', name:'Sub-array 3', x:LAY.src, y:240 },
  { id:'sol4', name:'Sub-array 4', x:LAY.src, y:315 },
];
const MPPT = [
  { id:'mppt1', sub:'sol1', name:'MPPT 1', x:LAY.dcdc, y:90,  idx:0 },
  { id:'mppt2', sub:'sol2', name:'MPPT 2', x:LAY.dcdc, y:165, idx:1 },
  { id:'mppt3', sub:'sol3', name:'MPPT 3', x:LAY.dcdc, y:240, idx:2 },
  { id:'mppt4', sub:'sol4', name:'MPPT 4', x:LAY.dcdc, y:315, idx:3 },
];

const BANKS = [
  { id:'A', x:LAY.src, y:430 },
  { id:'B', x:LAY.src, y:510 },
  { id:'C', x:LAY.src, y:590 },
  { id:'D', x:LAY.src, y:670 },
];
const DCDC = [
  { id:'dcdcA', bank:'A', x:LAY.dcdc, y:430 },
  { id:'dcdcB', bank:'B', x:LAY.dcdc, y:510 },
  { id:'dcdcC', bank:'C', x:LAY.dcdc, y:590 },
  { id:'dcdcD', bank:'D', x:LAY.dcdc, y:670 },
];

const GRID = { id:'grid', x:LAY.src, y:740 };
const ACDC = { id:'acdc', x:LAY.dcdc, y:740 };

const BUS = { x:LAY.bus, w:88 };

// DC-AC converters: name kept for tooltip mapping; box shows 2 info lines only.
const DCAC = [
  { id:'dcacDelta', x:LAY.dcac, y:280, line1:'230V · 3φ Δ', v:230, kind:'3d' },
  { id:'dcacWye',   x:LAY.dcac, y:380, line1:'400V · 3φ Y', v:400, kind:'3y' },
  { id:'dcacOne',   x:LAY.dcac, y:560, line1:'230V · 1φ',   v:230, kind:'1'  },
];
const LOADS = [
  { id:'loadDelta', name:'3φ Delta Loads', x:LAY.load, y:280, color:'var(--ac3)', kind:'3d' },
  { id:'loadWye',   name:'3φ Wye Loads',   x:LAY.load, y:380, color:'var(--ac3)', kind:'3y' },
  { id:'loadOne',   name:'1φ Loads',       x:LAY.load, y:560, color:'var(--ac1)', kind:'1'  },
];

const BS = { srcW:160, srcH:62, dcdcW:118, dcdcH:54, invW:140, invH:50, loadW:160, loadH:54 };

/* ---------- SVG HELPERS ---------- */
function el(tag, attrs={}, children=[]) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  children.forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
}
function rect(x,y,w,h,fill,stroke,r=9){ return el('rect',{x,y,width:w,height:h,rx:r,ry:r,fill,stroke,'stroke-width':1.5}); }
function text(x,y,txt,cls='',attrs={}){ return el('text',{x,y,...attrs,class:cls},[txt]); }

function box({id,x,y,w,h,name,sub,accent,color}) {
  const g = el('g', { id:'node-'+id });
  const bx=x-w/2, by=y-h/2;
  g.appendChild(rect(bx,by,w,h,'var(--panel)',color));
  g.appendChild(rect(bx+8,by,w-16,3,color,color,2));
  g.appendChild(text(x,by+20,name,'box-title',{'text-anchor':'middle'}));
  if (sub) g.appendChild(text(x,by+34,sub,'box-label',{'text-anchor':'middle'}));
  if (accent) g.appendChild(text(x,by+h-10,accent,'box-label',{'text-anchor':'middle','fill':color}));
  return g;
}

/* edges */
const right = (n,w=BS.srcW) => n.x + w/2;
const left  = (n,w=BS.srcW) => n.x - w/2;
const dcdcLeft  = n => n.x - BS.dcdcW/2;
const dcdcRight = n => n.x + BS.dcdcW/2;
const busLeft  = () => BUS.x - BUS.w/2;
const busRight = () => BUS.x + BUS.w/2;
const invLeft  = n => n.x - BS.invW/2;
const invRight = n => n.x + BS.invW/2;
const loadLeft = l => l.x - BS.loadW/2;

/* ---------- STATE ---------- */
let gNodes, gFlows, gLabels;
let activeConfig = DEFAULT_CONFIG;
let svgRoot = null;

export function init(svg, config) {
  activeConfig = config || DEFAULT_CONFIG;
  svgRoot = svg;
  gFlows  = svg.querySelector('#g-flows');
  gNodes  = svg.querySelector('#g-nodes');
  gLabels = svg.querySelector('#g-labels');
  if (gFlows)  gFlows.innerHTML = '';
  if (gNodes)  gNodes.innerHTML = '';
  if (gLabels) gLabels.innerHTML = '';
  drawStatic();
}

/* ---------- PERSISTENT ELEMENT HELPERS ---------- */
// Get-or-create an element by id under a parent; sets static attrs once.
function ensure(parent, tag, id, attrs) {
  let e = document.getElementById(id);
  if (!e) {
    e = el(tag, { id, ...attrs });
    parent.appendChild(e);
  }
  return e;
}
function show(e){ e.style.display = ''; }
function hide(e){ e.style.display = 'none'; }

// Persistent flow line. Position set once; stroke/class updated each frame.
function flowLine(id, x1, y1, x2, y2) {
  return ensure(gFlows, 'line', id, { x1, y1, x2, y2, 'stroke-width':3.5 });
}
function setFlow(ln, color, w=3.5, animated=true, reverse=false) {
  const cls = 'flow' + (animated ? (' dash' + (reverse ? ' rev' : '')) : '');
  ln.setAttribute('stroke', color);
  ln.setAttribute('stroke-width', w);
  // Only touch the class when it actually changes — reassigning it can restart
  // the dash animation and freeze the flow motion at 60fps.
  if (ln.getAttribute('class') !== cls) ln.setAttribute('class', cls);
  show(ln);
}
// Persistent text label under gLabels.
function label(id, x, y, attrs) {
  return ensure(gLabels, 'text', id, { x, y, 'text-anchor':'middle', ...attrs });
}
function setLabel(t, content, fill) {
  t.textContent = content;
  if (fill) t.setAttribute('fill', fill);
  show(t);
}

/* ---------- dim / disable ---------- */
function clearStates() {
  document.querySelectorAll('[id^="node-"]').forEach(n => {
    n.classList.remove('node-off');
    n.classList.remove('node-disabled');
  });
}
function dim(id){ const n=document.getElementById('node-'+id); if(n){n.classList.add('node-off'); n.classList.remove('node-disabled');} }
function disable(id){ const n=document.getElementById('node-'+id); if(n){n.classList.add('node-disabled'); n.classList.remove('node-off');} }
function undim(id){ const n=document.getElementById('node-'+id); if(n){n.classList.remove('node-off'); n.classList.remove('node-disabled');} }

/* ---------- STATIC RENDER ---------- */
function drawStatic() {
  // DC Bus
  gNodes.appendChild(rect(BUS.x-BUS.w/2, LAY.busTop, BUS.w, LAY.busBot-LAY.busTop, 'var(--panel2)', 'var(--dc)', 12));
  gNodes.appendChild(text(BUS.x, LAY.busTop+20, 'DC BUS', 'box-title', {'text-anchor':'middle','id':'node-dcbus'}));
  gNodes.appendChild(text(BUS.x, LAY.busTop+36, '~400V DC', 'box-label', {'text-anchor':'middle'}));
  gNodes.appendChild(text(BUS.x, LAY.busBot-22, 'no phases', 'box-label', {'text-anchor':'middle','fill':'var(--dc)'}));
  gNodes.appendChild(text(BUS.x, LAY.busBot-8, 'single rail', 'box-label', {'text-anchor':'middle','fill':'var(--dc)'}));

  // Solar sub-arrays — title + dynamic kW line + solar-yield bar
  SOLAR.forEach((s, i) => {
    const g = box({ id:s.id, x:s.x, y:s.y, w:BS.srcW, h:BS.srcH, name:s.name, color:'var(--solar)' });
    g.appendChild(el('text', { id:'sol-kw-'+s.id, x:s.x, y:s.y-BS.srcH/2+38, 'text-anchor':'middle', class:'box-label', 'font-size':11, 'font-weight':600, fill:'var(--solar)' }, ['0 kW']));
    const bx = s.x - BS.srcW/2 + 10;
    const by = s.y + BS.srcH/2 - 12;
    g.appendChild(el('rect',{ id:'solTrack-'+s.id, x:bx, y:by, width:BS.srcW-20, height:6, rx:3, ry:3, fill:'var(--off)' }));
    g.appendChild(el('rect',{ id:'solFill-'+s.id, x:bx, y:by, width:0, height:6, rx:3, ry:3, fill:'var(--solar)' }));
    gNodes.appendChild(g);
  });
  // MPPTs
  MPPT.forEach((m, i) => {
    const cfg = activeConfig.mppts[i];
    const sub = cfg ? `${cfg.panels}p · ${cfg.series}s${cfg.parallel}p` : 'tracks MPP';
    gNodes.appendChild(box({ id:m.id, x:m.x, y:m.y, w:BS.dcdcW, h:BS.dcdcH, name:m.name, sub, color:'var(--solar)', accent:'isolated' }));
  });

  // Battery banks — title + dynamic value slot + SoC bar (no nominalV/kWh/SoC→ lines)
  activeConfig.banks.forEach((b, i) => {
    const g = box({ id:'bank'+b.id, x:BANKS[i].x, y:BANKS[i].y, w:BS.srcW, h:BS.srcH, name:'Battery Bank '+b.id, color:'var(--battery)' });
    // dynamic value text (line 2) — updated each frame
    g.appendChild(el('text', { id:'bank-val-'+b.id, x:BANKS[i].x, y:BANKS[i].y-BS.srcH/2+38, 'text-anchor':'middle', class:'box-label', 'font-size':11, 'font-weight':600, fill:'var(--battery)' }, ['']));
    gNodes.appendChild(g);
    // SoC fill bar
    const bx = BANKS[i].x - BS.srcW/2 + 10;
    const by = BANKS[i].y + BS.srcH/2 - 12;
    gNodes.appendChild(el('rect',{ id:'socTrack-'+b.id, x:bx, y:by, width:BS.srcW-20, height:6, rx:3, ry:3, fill:'var(--off)' }));
    gNodes.appendChild(el('rect',{ id:'socFill-'+b.id, x:bx, y:by, width:0, height:6, rx:3, ry:3, fill:'var(--battery)' }));
  });
  // DC-DC converters
  DCDC.forEach(d => gNodes.appendChild(box({ id:d.id, x:d.x, y:d.y, w:BS.dcdcW, h:BS.dcdcH, name:'DC-DC '+d.id.slice(-1), sub:'bi-dir', color:'var(--battery)', accent:'profile-locked' })));

  // Grid + AC-DC charger
  {
    const g = box({ id:'grid', x:GRID.x, y:GRID.y, w:BS.srcW, h:BS.srcH, name:'Grid', sub:'230V 1φ 60Hz', color:'var(--grid)' });
    g.appendChild(el('text', { id:'grid-kw', x:GRID.x, y:GRID.y-BS.srcH/2+50, 'text-anchor':'middle', class:'box-label', 'font-size':11, 'font-weight':700, fill:'var(--grid)' }, ['']));
    gNodes.appendChild(g);
  }
  gNodes.appendChild(box({ id:'acdc', x:ACDC.x, y:ACDC.y, w:BS.dcdcW, h:BS.dcdcH, name:'AC-DC', sub:'rectifier', color:'var(--grid)' }));

  // DC-AC converters — 2 lines only: line1 = voltage+phase+wye/delta, line2 = amps (dynamic)
  DCAC.forEach(d => {
    const g = el('g', { id:'node-'+d.id });
    const bx=d.x-BS.invW/2, by=d.y-BS.invH/2;
    g.appendChild(rect(bx,by,BS.invW,BS.invH,'var(--panel)', d.kind==='1'?'var(--ac1)':'var(--ac3)'));
    g.appendChild(rect(bx+8,by,BS.invW-16,3, d.kind==='1'?'var(--ac1)':'var(--ac3)', d.kind==='1'?'var(--ac1)':'var(--ac3)', 2));
    g.appendChild(text(d.x,by+20, d.line1, 'box-title', {'text-anchor':'middle'}));
    g.appendChild(el('text',{ id:'dcac-amps-'+d.id, x:d.x, y:by+36, 'text-anchor':'middle', class:'box-label', 'font-size':11, 'font-weight':600, fill: d.kind==='1'?'var(--ac1)':'var(--ac3)' }, ['0A']));
    gNodes.appendChild(g);
  });

  // Loads — title + dynamic kW inside the box (text currently sits outside; moved in)
  LOADS.forEach(l => {
    const g = el('g', { id:'node-'+l.id });
    const bx=l.x-BS.loadW/2, by=l.y-BS.loadH/2;
    g.appendChild(rect(bx,by,BS.loadW,BS.loadH,'var(--panel)', l.color));
    g.appendChild(rect(bx+8,by,BS.loadW-16,3, l.color, l.color, 2));
    g.appendChild(text(l.x,by+20, l.name, 'box-title', {'text-anchor':'middle'}));
    g.appendChild(el('text',{ id:'load-kw-'+l.id, x:l.x, y:by+38, 'text-anchor':'middle', class:'box-label', 'font-size':11, 'font-weight':600, fill: l.color }, ['0 kW']));
    gNodes.appendChild(g);
  });

  // (trunk boxes removed — DC-AC connects directly to loads)

  // SKELETON (dim) lines — always present, behind dynamic flows
  const skel = (x1,y1,x2,y2) => gFlows.appendChild(el('line',{ x1,y1,x2,y2, class:'flow', stroke:'var(--off)', 'stroke-width':1.5 }));
  MPPT.forEach((m,i) => skel(right(SOLAR[i]), SOLAR[i].y, dcdcLeft(m), m.y));
  DCDC.forEach((d,i) => skel(right(BANKS[i], BS.srcW), BANKS[i].y, dcdcLeft(d), d.y));
  skel(right(GRID, BS.srcW), GRID.y, dcdcLeft(ACDC), ACDC.y);
  DCAC.forEach(d => skel(busRight(), d.y, invLeft(d), d.y));
  DCAC.forEach((d,i) => skel(invRight(d), d.y, loadLeft(LOADS[i]), LOADS[i].y));
}

/* ---------- amps helpers ---------- */
function acAmps(loadKW, kind) {
  const kw = Math.max(0, loadKW || 0);
  if (kind === '3d') return kw * 1000 / (Math.sqrt(3) * 230);
  if (kind === '3y') return kw * 1000 / (Math.sqrt(3) * 400);
  return kw * 1000 / 230;  // 1φ
}
function fmtVA(v, a) {
  if (!isFinite(v) || v <= 0) return '';
  const A = isFinite(a) ? a : 0;
  return Math.round(v) + 'V @ ' + Math.round(A) + 'A';
}

/* ---------- DYNAMIC RENDER ---------- */
export function render(state) {
  clearStates();
  const perMpptKW = state.perMpptKW || [];
  const vmpByMppt = state.vmpByMppt || [];
  const perBankById = {};
  (state.perBank || []).forEach(p => { perBankById[p.id] = p; });
  const loads = [state.loads.delta, state.loads.wye, state.loads.one];

  // ---- Solar yield bar (system-wide, fills relative to peak yield) ----
  const maxSolar = totalSolarKW(activeConfig, CONST.irradiancePeak);
  const yieldFrac = maxSolar > 0 ? Math.max(0, Math.min(1, state.solarTotalKW / maxSolar)) : 0;
  SOLAR.forEach((s, i) => {
    // each sub-array's own bar fills by its share of peak (same frac under uniform irradiance)
    const fill = document.getElementById('solFill-'+s.id);
    const track = document.getElementById('solTrack-'+s.id);
    if (fill && track) {
      const w = parseFloat(track.getAttribute('width')) || (BS.srcW - 20);
      fill.setAttribute('width', (w * yieldFrac).toFixed(1));
    }
  });

  // ---- Solar sub-arrays → MPPT → bus ----
  MPPT.forEach((m, i) => {
    const s = SOLAR[i];
    const cfg = activeConfig.mppts[i];
    const disabled = cfg && cfg.enabled === false;
    const kw = perMpptKW[i] || 0;
    const vmp = vmpByMppt[i];
    const lSol = flowLine('fl-sol-'+i, right(s), s.y, dcdcLeft(m), m.y);
    const lMppt = flowLine('fl-mppt-'+i, dcdcRight(m), m.y, busLeft(), m.y);
    const lbVA = label('lb-sol-va-'+i, (right(s)+dcdcLeft(m))/2, s.y-8, {'font-size':9});
    const kwEl = document.getElementById('sol-kw-'+s.id);

    if (disabled) {
      disable(s.id); disable(m.id);
      hide(lSol); hide(lMppt); hide(lbVA);
      if (kwEl) kwEl.textContent = '';
      return;
    }
    if (kw <= 0) {
      dim(s.id); dim(m.id);
      hide(lSol); hide(lMppt); hide(lbVA);
      if (kwEl) { kwEl.textContent = '0 kW'; kwEl.setAttribute('fill','var(--muted)'); }
      return;
    }
    undim(s.id); undim(m.id);
    setFlow(lSol, 'var(--solar)');
    setFlow(lMppt, 'var(--solar)');
    if (kwEl) { kwEl.textContent = kw.toFixed(1)+' kW'; kwEl.setAttribute('fill','var(--solar)'); }
    setLabel(lbVA, fmtVA(vmp, kw*1000/vmp), 'var(--muted)');
  });

  // ---- Batteries → DC-DC → bus ----
  activeConfig.banks.forEach((b, i) => {
    const bankNode = BANKS[i], d = DCDC[i];
    const p = perBankById[b.id];
    const soc = p ? p.soc : (b.enabled === false ? 0 : (b.soc || 0));
    setSocBar(b.id, soc);

    const valEl = document.getElementById('bank-val-'+b.id);
    const lBank = flowLine('fl-bank-'+i, right(bankNode, BS.srcW), bankNode.y, dcdcLeft(d), d.y);
    const lDcdc = flowLine('fl-dcdc-'+i, dcdcRight(d), d.y, busLeft(), d.y);
    const lbVA = label('lb-bank-va-'+i, (right(bankNode, BS.srcW)+dcdcLeft(d))/2, bankNode.y-8, {'font-size':9});

    if (b.enabled === false) {
      disable('bank'+b.id); disable(d.id);
      if (valEl) valEl.textContent = '';
      hide(lBank); hide(lDcdc); hide(lbVA);
      return;
    }
    if (!p || p.mode === 'idle' || p.kw <= 0) {
      dim('bank'+b.id); dim(d.id);
      if (valEl) { valEl.textContent = (p ? Math.round(p.vBat) : '')+'V'; valEl.setAttribute('fill','var(--muted)'); }
      hide(lBank); hide(lDcdc); hide(lbVA);
      return;
    }
    undim('bank'+b.id); undim(d.id);
    const color = p.mode === 'charge' ? 'var(--solar)' : 'var(--battery)';
    const rev = p.mode === 'charge';
    setFlow(lBank, color, 3.5, true, rev);
    setFlow(lDcdc, color, 3.5, true, rev);
    if (valEl) {
      const sign = p.mode === 'charge' ? '+' : '';
      valEl.textContent = Math.round(p.vBat)+'V · '+sign+p.kw.toFixed(1)+' kW';
      valEl.setAttribute('fill', color);
    }
    setLabel(lbVA, fmtVA(p.vBat, p.kw*1000/p.vBat), color);
  });

  // ---- Grid / AC-DC → bus ----
  const lG1 = flowLine('fl-grid-1', right(GRID, BS.srcW), GRID.y, dcdcLeft(ACDC), ACDC.y);
  const lG2 = flowLine('fl-grid-2', dcdcRight(ACDC), ACDC.y, busLeft(), ACDC.y);
  const lbGAc = label('lb-grid-ac', (GRID.x+ACDC.x)/2, GRID.y-8, {'font-size':9});
  const gridKwEl = document.getElementById('grid-kw');
  if (state.gridKW > 0) {
    undim('grid'); undim('acdc');
    setFlow(lG1, 'var(--grid)');
    setFlow(lG2, 'var(--grid)');
    if (gridKwEl) { gridKwEl.textContent = state.gridKW.toFixed(1)+' kW'; gridKwEl.setAttribute('fill','var(--grid)'); show(gridKwEl); }
    setLabel(lbGAc, '230V AC', 'var(--muted)');
  } else {
    dim('grid'); dim('acdc');
    hide(lG1); hide(lG2); hide(lbGAc);
    if (gridKwEl) { gridKwEl.textContent = ''; }
  }

  // ---- Bus → DC-AC converters (always energized) ----
  DCAC.forEach((d, i) => {
    const l = flowLine('fl-busdcac-'+i, busRight(), d.y, invLeft(d), d.y);
    setFlow(l, 'var(--dc)', 3, true, false);
    undim(d.id);
  });

  // ---- DC-AC → loads (AC lines, solid) + V@A labels + box amps + load kW ----
  const acColors = ['var(--ac3)','var(--ac3)','var(--ac1)'];
  DCAC.forEach((d, i) => {
    const ld = LOADS[i];
    const kw = loads[i] || 0;
    const amps = acAmps(kw, d.kind);
    const lAc = flowLine('fl-dcacload-'+i, invRight(d), d.y, loadLeft(ld), ld.y);
    const lbVA = label('lb-ac-va-'+i, (d.x+ld.x)/2, d.y-8, {'font-size':10,'font-weight':600});
    const ampsEl = document.getElementById('dcac-amps-'+d.id);
    const loadKwEl = document.getElementById('load-kw-'+ld.id);

    if (ampsEl) ampsEl.textContent = Math.round(amps)+'A';
    if (loadKwEl) loadKwEl.textContent = kw.toFixed(1)+' kW';

    setFlow(lAc, acColors[i], 3, false, false);
    setLabel(lbVA, fmtVA(d.v, amps), acColors[i]);

    if (kw <= 0) { dim(ld.id); } else { undim(ld.id); }
  });

  // ---- Bus voltage label ----
  let busVText = document.getElementById('busVLabel');
  if (!busVText) { busVText = el('text',{id:'busVLabel', x:BUS.x, y:LAY.busTop+56, 'text-anchor':'middle', fill:'#fff', 'font-size':13, 'font-weight':700}); gNodes.appendChild(busVText); }
  busVText.textContent = state.busV+'V';

  // ---- Regime label ----
  const regColors = { idle:'var(--muted)', surplus:'var(--solar)', discharge:'var(--battery)', grid:'var(--grid)' };
  let regLabel = document.getElementById('regimeLabel');
  if (!regLabel) { regLabel = el('text',{id:'regimeLabel', x:BUS.x, y:LAY.busBot-38, 'text-anchor':'middle', 'font-size':11, 'font-weight':700}); gNodes.appendChild(regLabel); }
  regLabel.setAttribute('fill', regColors[state.regime] || 'var(--muted)');
  regLabel.textContent = state.regime.toUpperCase();
}

function setSocBar(bankId, soc) {
  const fill = document.getElementById('socFill-'+bankId);
  const track = document.getElementById('socTrack-'+bankId);
  if (!fill || !track) return;
  const w = parseFloat(track.getAttribute('width')) || (BS.srcW - 20);
  fill.setAttribute('width', (w * Math.max(0, Math.min(100, soc)) / 100).toFixed(1));
  const color = soc > 50 ? 'var(--battery)' : (soc >= 20 ? 'var(--solar)' : 'var(--warn)');
  fill.setAttribute('fill', color);
}

/* ---------- TOOLTIPS ---------- */
export function attachTooltips(tipEl) {
  const map = {
    'node-sol1':PARTS.mppt,'node-sol2':PARTS.mppt,'node-sol3':PARTS.mppt,'node-sol4':PARTS.mppt,
    'node-mppt1':PARTS.mppt,'node-mppt2':PARTS.mppt,'node-mppt3':PARTS.mppt,'node-mppt4':PARTS.mppt,
    'node-bankA':PARTS.bank,'node-bankB':PARTS.bank,'node-bankC':PARTS.bank,'node-bankD':PARTS.bank,
    'node-dcdcA':PARTS.dcdc,'node-dcdcB':PARTS.dcdc,'node-dcdcC':PARTS.dcdc,'node-dcdcD':PARTS.dcdc,
    'node-grid':PARTS.acdc,'node-acdc':PARTS.acdc,
    'node-dcacDelta':PARTS.dcac3,'node-dcacWye':PARTS.dcac3,'node-dcacOne':PARTS.dcac1,
    'node-dcbus':PARTS.dcbus,
    'node-loadDelta':PARTS.acpanel,'node-loadWye':PARTS.acpanel,'node-loadOne':PARTS.acpanel,
  };
  Object.entries(map).forEach(([id, info]) => {
    const n = document.getElementById(id); if (!n) return;
    n.style.cursor = 'help';
    n.addEventListener('mousemove', e => {
      const stage = document.getElementById('stage');
      const r = stage.getBoundingClientRect();
      tipEl.style.display = 'block';
      tipEl.style.left = (e.clientX - r.left + 14) + 'px';
      tipEl.style.top = (e.clientY - r.top + 14) + 'px';
      tipEl.innerHTML = '<b>'+info.title+'</b><br>'+info.desc;
    });
    n.addEventListener('mouseleave', () => tipEl.style.display = 'none');
  });
}

/* render.js — SVG rendering from model state. Kept simple, untested.
   Exposes init(svg, config) to draw static boxes once (config-driven, so
   enabled/disabled MPPTs and banks render correctly), and render(state) to
   redraw the dynamic layer (flows, voltages, SoC bars, dimming) on every
   sim tick. Also exposes attachTooltips(tooltipEl) for hover handling.
*/
import { CONST, PARTS, mpptVmp } from './model.js';
import { DEFAULT_CONFIG } from './config.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/* ---------- LAYOUT GRID ----------
   Solar (4 MPPTs) stacked top, batteries (4) middle, grid bottom — left side.
   DC bus vertical rail. 3 DC-AC converters (delta, wye, 1-phase) right.
*/
const LAY = {
  W: 1320, H: 880,
  src: 120, dcdc: 330, bus: 480, dcac: 660, comb: 810, trunk: 940, load: 1110,
  busTop: 70, busBot: 770,
};

// Solar sub-arrays + MPPTs (4 each)
const SOLAR = [
  { id:'sol1', name:'Sub-array 1', sub:'Roof A · 20 panels', x:LAY.src, y:90 },
  { id:'sol2', name:'Sub-array 2', sub:'Roof B · 20 panels', x:LAY.src, y:165 },
  { id:'sol3', name:'Sub-array 3', sub:'Roof C · 20 panels', x:LAY.src, y:240 },
  { id:'sol4', name:'Sub-array 4', sub:'Future · 20 panels', x:LAY.src, y:315 },
];
const MPPT = [
  { id:'mppt1', sub:'sol1', name:'MPPT 1', x:LAY.dcdc, y:90,  bankIdx: 0 },
  { id:'mppt2', sub:'sol2', name:'MPPT 2', x:LAY.dcdc, y:165, bankIdx: 1 },
  { id:'mppt3', sub:'sol3', name:'MPPT 3', x:LAY.dcdc, y:240, bankIdx: 2 },
  { id:'mppt4', sub:'sol4', name:'MPPT 4', x:LAY.dcdc, y:315, bankIdx: 3 },
];

// Battery banks (4: A/B/C/D) + DC-DC converters — D added in Session 3.
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

// DC-AC converters (3: delta 3φ, wye 3φ, 1φ)
const DCAC = [
  { id:'dcacDelta', name:'DC-AC Delta', sub:'230V 3φ grid-forming',  x:LAY.dcac, y:280 },
  { id:'dcacWye',   name:'DC-AC Wye',   sub:'400V 3φ grid-forming',  x:LAY.dcac, y:380 },
  { id:'dcacOne',   name:'DC-AC 1φ',    sub:'230V 1φ grid-forming',   x:LAY.dcac, y:560 },
];

const TRUNKS = [
  { id:'trunkDelta', name:'3φ Delta Trunk', sub:'230V Δ @ 60A', x:LAY.trunk, y:280, kw:CONST.loads.delta.kw },
  { id:'trunkWye',   name:'3φ Wye Trunk',   sub:'400V Y @ 60A',  x:LAY.trunk, y:380, kw:CONST.loads.wye.kw },
  { id:'trunkOne',   name:'1φ Trunk',        sub:'230V @ 120A',   x:LAY.trunk, y:560, kw:CONST.loads.one.kw },
];
const LOADS = [
  { id:'loadDelta', name:'3φ Delta Loads', x:LAY.load, y:280, kw:CONST.loads.delta.kw },
  { id:'loadWye',   name:'3φ Wye Loads',   x:LAY.load, y:380, kw:CONST.loads.wye.kw },
  { id:'loadOne',   name:'1φ Loads',       x:LAY.load, y:560, kw:CONST.loads.one.kw },
];

// Box sizes
const BS = { srcW:160, srcH:62, dcdcW:118, dcdcH:54, invW:130, invH:50, trunkW:120, trunkH:54, loadW:150, loadH:54 };

/* ---------- SVG HELPERS ---------- */
function el(tag, attrs={}, children=[]) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  children.forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
}
function rect(x,y,w,h,fill,stroke,r=9){ return el('rect',{x,y,width:w,height:h,rx:r,ry:r,fill,stroke,'stroke-width':1.5}); }
function text(x,y,txt,cls='',attrs={}){ return el('text',{x,y,...attrs,class:cls},[txt]); }
function line(x1,y1,x2,y2,color,w=3,cls='flow',animated=true,reverse=false){
  const c = cls + (animated ? (' dash' + (reverse ? ' rev' : '')) : '');
  return el('line',{x1,y1,x2,y2,class:c,stroke:color,'stroke-width':w});
}
function box({id,x,y,w,h,name,sub,color,accent}) {
  const g = el('g', { id:'node-'+id });
  const bx=x-w/2, by=y-h/2;
  g.appendChild(rect(bx,by,w,h,'var(--panel)',color));
  g.appendChild(rect(bx+8,by,w-16,3,color,color,2));
  g.appendChild(text(x,by+20,name,'box-title',{'text-anchor':'middle'}));
  g.appendChild(text(x,by+34,sub,'box-label',{'text-anchor':'middle'}));
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
const trunkLeft  = t => t.x - BS.trunkW/2;
const trunkRight = t => t.x + BS.trunkW/2;
const loadLeft   = l => l.x - BS.loadW/2;

/* ---------- STATE ---------- */
let gNodes, gFlows, gLabels, dynLayer=null;
let activeConfig = DEFAULT_CONFIG;

export function init(svg, config) {
  activeConfig = config || DEFAULT_CONFIG;
  gFlows  = svg.querySelector('#g-flows');
  gNodes  = svg.querySelector('#g-nodes');
  gLabels = svg.querySelector('#g-labels');
  // Clear any previous static content (supports hot re-init on config save).
  if (gFlows)  gFlows.innerHTML = '';
  if (gNodes)  gNodes.innerHTML = '';
  if (gLabels) gLabels.innerHTML = '';
  dynLayer = null;
  drawStatic();
}

/* ---------- STATIC RENDER ---------- */
function drawStatic() {
  // DC Bus
  gNodes.appendChild(rect(BUS.x-BUS.w/2, LAY.busTop, BUS.w, LAY.busBot-LAY.busTop, 'var(--panel2)', 'var(--dc)', 12));
  gNodes.appendChild(text(BUS.x, LAY.busTop+20, 'DC BUS', 'box-title', {'text-anchor':'middle','id':'node-dcbus'}));
  gNodes.appendChild(text(BUS.x, LAY.busTop+36, '~400V DC', 'box-label', {'text-anchor':'middle'}));
  gNodes.appendChild(text(BUS.x, LAY.busBot-22, 'no phases', 'box-label', {'text-anchor':'middle','fill':'var(--dc)'}));
  gNodes.appendChild(text(BUS.x, LAY.busBot-8, 'single rail', 'box-label', {'text-anchor':'middle','fill':'var(--dc)'}));

  // Solar sub-arrays
  SOLAR.forEach(s => gNodes.appendChild(box({
    id:s.id, x:s.x, y:s.y, w:BS.srcW, h:BS.srcH, name:s.name, sub:s.sub, color:'var(--solar)',
  })));
  // MPPTs — sub label driven by config (panels / Vmp)
  MPPT.forEach((m, i) => {
    const cfg = activeConfig.mppts[i];
    const sub = cfg ? `${cfg.panels}p · ${cfg.series}s${cfg.parallel}p` : 'tracks MPP';
    gNodes.appendChild(box({
      id:m.id, x:m.x, y:m.y, w:BS.dcdcW, h:BS.dcdcH, name:m.name, sub, color:'var(--solar)', accent:'isolated',
    }));
  });

  // Battery banks (config-driven: nominalV / kWh + SoC bar placeholder slot)
  activeConfig.banks.forEach((b, i) => {
    gNodes.appendChild(box({
      id:'bank'+b.id, x:BANKS[i].x, y:BANKS[i].y, w:BS.srcW, h:BS.srcH,
      name:'Battery Bank '+b.id, sub:`${b.nominalV}V · ${b.kwh}kWh`, color:'var(--battery)', accent:'SoC →',
    }));
    // SoC fill bar background (track)
    const bx = BANKS[i].x - BS.srcW/2 + 10;
    const by = BANKS[i].y + BS.srcH/2 - 12;
    gNodes.appendChild(el('rect',{id:'socTrack-'+b.id, x:bx, y:by, width:BS.srcW-20, height:6, rx:3, ry:3, fill:'var(--off)'}));
    gNodes.appendChild(el('rect',{id:'socFill-'+b.id, x:bx, y:by, width:0, height:6, rx:3, ry:3, fill:'var(--battery)'}));
  });
  // DC-DC converters (4)
  DCDC.forEach(d => gNodes.appendChild(box({
    id:d.id, x:d.x, y:d.y, w:BS.dcdcW, h:BS.dcdcH, name:'DC-DC '+d.id.slice(-1), sub:'bi-dir', color:'var(--battery)', accent:'profile-locked',
  })));

  // Grid + AC-DC charger
  gNodes.appendChild(box({id:'grid', x:GRID.x, y:GRID.y, w:BS.srcW, h:BS.srcH, name:'Grid', sub:'230V 1φ 60Hz', color:'var(--grid)'}));
  gNodes.appendChild(box({id:'acdc', x:ACDC.x, y:ACDC.y, w:BS.dcdcW, h:BS.dcdcH, name:'AC-DC', sub:'programmable', color:'var(--grid)', accent:'V<V_charge'}));

  // DC-AC converters
  DCAC.forEach(d => gNodes.appendChild(box({
    id:d.id, x:d.x, y:d.y, w:BS.invW, h:BS.invH, name:d.name, sub:d.sub,
    color: d.id==='dcacOne' ? 'var(--ac1)' : 'var(--ac3)',
    accent:d.id==='dcacOne'?'1φ':'3φ',
  })));

  // Trunks
  TRUNKS.forEach(t => gNodes.appendChild(box({
    id:t.id, x:t.x, y:t.y, w:BS.trunkW, h:BS.trunkH, name:t.name, sub:t.sub,
    color: t.id==='trunkOne' ? 'var(--ac1)' : 'var(--ac3)',
  })));
  // Loads
  LOADS.forEach(l => gNodes.appendChild(box({
    id:l.id, x:l.x, y:l.y, w:BS.loadW, h:BS.loadH, name:l.name, sub:'loads', color:l.id==='loadOne'?'var(--ac1)':'var(--ac3)',
  })));

  // trunk note
  gLabels.appendChild(text(TRUNKS[2].x, TRUNKS[2].y+BS.trunkH/2+18, '12-wire trunk · 25mm²', 'box-label', {'text-anchor':'middle','fill':'var(--muted)'}));
  gLabels.appendChild(text(TRUNKS[2].x, TRUNKS[2].y+BS.trunkH/2+32, 'repurposed — no new wire', 'box-label', {'text-anchor':'middle','fill':'var(--muted)'}));

  // SKELETON (dim) lines — always present
  const skel = (x1,y1,x2,y2) => gFlows.appendChild(line(x1,y1,x2,y2,'var(--off)',1.5,'flow',false));
  // solar → mppt
  MPPT.forEach((m,i) => skel(right(SOLAR[i]), SOLAR[i].y, dcdcLeft(m), m.y));
  // battery → dcdc (now 4)
  DCDC.forEach((d,i) => skel(right(BANKS[i], BS.srcW), BANKS[i].y, dcdcLeft(d), d.y));
  // grid → acdc
  skel(right(GRID, BS.srcW), GRID.y, dcdcLeft(ACDC), ACDC.y);
  // bus → dcac (all three)
  DCAC.forEach(d => skel(busRight(), d.y, invLeft(d), d.y));
  // dcac → trunk (each)
  DCAC.forEach((d,i) => skel(invRight(d), d.y, trunkLeft(TRUNKS[i]), TRUNKS[i].y));
  // trunk → load
  TRUNKS.forEach((t,i) => skel(trunkRight(t), t.y, loadLeft(LOADS[i]), LOADS[i].y));
}

/* ---------- DYNAMIC RENDER ---------- */
function clearDyn(){ if (dynLayer) { dynLayer.remove(); dynLayer=null; } }
function dynLine(x1,y1,x2,y2,color,w=3.5,animated=true,reverse=false){ return line(x1,y1,x2,y2,color,w,'flow',animated,reverse); }
function dim(id){ const n=document.getElementById(id); if(n) n.classList.add('node-off'); }
function unDim(id){ const n=document.getElementById(id); if(n) n.classList.remove('node-off'); }

// Set the SoC fill bar width + color for a bank (by id).
function setSocBar(bankId, soc) {
  const fill = document.getElementById('socFill-'+bankId);
  const track = document.getElementById('socTrack-'+bankId);
  if (!fill || !track) return;
  const w = parseFloat(track.getAttribute('width')) || (BS.srcW - 20);
  fill.setAttribute('width', (w * clamp(soc, 0, 100) / 100).toFixed(1));
  const color = soc > 50 ? 'var(--battery)' : (soc >= 20 ? 'var(--solar)' : 'var(--warn)');
  fill.setAttribute('fill', color);
}

export function render(state) {
  clearDyn();
  dynLayer = el('g',{id:'dyn'}); gFlows.appendChild(dynLayer);
  document.querySelectorAll('[id^="node-"]').forEach(n => n.classList.remove('node-off'));

  const C = CONST;
  const perMpptKW = state.perMpptKW || [];   // from sim: per-MPPT power kW
  const vmpByMppt = state.vmpByMppt || [];   // per-MPPT Vmp display volts
  const perBankById = {};                    // index perBank by id for quick lookup
  (state.perBank || []).forEach(p => { perBankById[p.id] = p; });

  // ---- Solar sub-arrays → MPPT → bus ----
  MPPT.forEach((m, i) => {
    const s = SOLAR[i];
    const cfg = activeConfig.mppts[i];
    const disabled = cfg && cfg.enabled === false;
    const kw = perMpptKW[i] || 0;
    if (disabled || kw <= 0) {
      dim('node-'+s.id); dim('node-'+m.id);
      if (disabled) {
        // disabled tag on MPPT
        dynLayer.appendChild(text(m.x, m.y+BS.dcdcH/2+12, 'disabled', 'box-label', {'text-anchor':'middle','fill':'var(--warn)','font-size':9}));
      }
      return;
    }
    dynLayer.appendChild(dynLine(right(s), s.y, dcdcLeft(m), m.y, 'var(--solar)'));
    dynLayer.appendChild(dynLine(dcdcRight(m), m.y, busLeft(), m.y, 'var(--solar)'));
    dynLayer.appendChild(text(s.x, s.y-BS.srcH/2-8, kw.toFixed(1)+' kW', 'box-label', {'text-anchor':'middle','fill':'var(--solar)','font-size':11,'font-weight':700}));
    // dynamic Vmp label (replaces the old static "~Vmp")
    const vmp = vmpByMppt[i];
    const vmpTxt = (vmp != null) ? Math.round(vmp)+'V' : '~Vmp';
    dynLayer.appendChild(text((s.x+m.x)/2, s.y-8, vmpTxt, 'box-label', {'text-anchor':'middle','fill':'var(--muted)','font-size':9}));
  });

  // ---- Batteries → DC-DC → bus ----
  activeConfig.banks.forEach((b, i) => {
    const bankNode = BANKS[i], d = DCDC[i];
    const p = perBankById[b.id];
    // Update SoC bar for every bank (even disabled, shows 0)
    const soc = p ? p.soc : (b.enabled === false ? 0 : (b.soc || 0));
    setSocBar(b.id, soc);
    if (b.enabled === false) {
      dim('node-bank'+b.id); dim('node-'+d.id);
      dynLayer.appendChild(text(bankNode.x, bankNode.y+BS.srcH/2+12, 'disabled', 'box-label', {'text-anchor':'middle','fill':'var(--warn)','font-size':9}));
      return;
    }
    if (!p || p.mode === 'idle') { dim('node-bank'+b.id); dim('node-'+d.id); return; }
    const color = p.mode === 'charge' ? 'var(--solar)' : 'var(--battery)';
    const rev = p.mode === 'charge';   // charging: current flows bus → battery (right to left)
    dynLayer.appendChild(dynLine(right(bankNode, BS.srcW), bankNode.y, dcdcLeft(d), d.y, color, 3.5, true, rev));
    dynLayer.appendChild(dynLine(dcdcRight(d), d.y, busLeft(), d.y, color, 3.5, true, rev));
    const tag = p.mode === 'charge' ? '+'+p.kw.toFixed(1)+' kW →' : p.kw.toFixed(1)+' kW ←';
    dynLayer.appendChild(text(bankNode.x, bankNode.y-BS.srcH/2-8, Math.round(p.vBat)+'V · '+tag, 'box-label', {'text-anchor':'middle','fill':color,'font-size':10,'font-weight':600}));
  });

  // ---- Grid / AC-DC → bus ----
  if (state.gridKW > 0) {
    dynLayer.appendChild(dynLine(right(GRID, BS.srcW), GRID.y, dcdcLeft(ACDC), ACDC.y, 'var(--grid)'));
    dynLayer.appendChild(dynLine(dcdcRight(ACDC), ACDC.y, busLeft(), ACDC.y, 'var(--grid)'));
    dynLayer.appendChild(text(GRID.x, GRID.y-BS.srcH/2-8, state.gridKW.toFixed(1)+' kW', 'box-label', {'text-anchor':'middle','fill':'var(--grid)','font-size':12,'font-weight':700}));
    dynLayer.appendChild(text((GRID.x+ACDC.x)/2, GRID.y-8, '230V AC', 'box-label', {'text-anchor':'middle','fill':'var(--muted)','font-size':9}));
  } else {
    dim('node-grid'); dim('node-acdc');
  }

  // ---- Bus → DC-AC converters ----
  DCAC.forEach(d => {
    dynLayer.appendChild(dynLine(busRight(), d.y, invLeft(d), d.y, 'var(--dc)'));
  });

  // ---- DC-AC → trunks (AC, colored) ----
  const acColors = ['var(--ac3)','var(--ac3)','var(--ac1)'];
  const acVolts = ['230V Δ','400V Y','230V 1φ'];
  DCAC.forEach((d, i) => {
    const t = TRUNKS[i];
    dynLayer.appendChild(dynLine(invRight(d), d.y, trunkLeft(t), t.y, acColors[i], 3, false));
    dynLayer.appendChild(text((d.x+t.x)/2, d.y-8, acVolts[i], 'box-label', {'text-anchor':'middle','fill':acColors[i],'font-size':10,'font-weight':600}));
  });

  // ---- Trunks → loads ----
  const loads = [state.loads.delta, state.loads.wye, state.loads.one];
  TRUNKS.forEach((t, i) => {
    if (loads[i] <= 0) { dim('node-'+LOADS[i].id); return; }
    dynLayer.appendChild(dynLine(trunkRight(t), t.y, loadLeft(LOADS[i]), LOADS[i].y, acColors[i]));
    dynLayer.appendChild(text((t.x+LOADS[i].x)/2, t.y+18, loads[i].toFixed(1)+' kW', 'box-label', {'text-anchor':'middle','fill':acColors[i],'font-size':10,'font-weight':600}));
  });

  // ---- Bus voltage label (dynamic) ----
  const busVText = document.getElementById('busVLabel');
  if (busVText) busVText.remove();
  const busV = el('text', {id:'busVLabel', x:BUS.x, y:LAY.busTop+56, 'text-anchor':'middle', fill:'#fff', 'font-size':13, 'font-weight':700});
  busV.textContent = state.busV+'V';
  gNodes.appendChild(busV);

  // ---- Regime label ----
  const regColors = { idle:'var(--muted)', surplus:'var(--solar)', discharge:'var(--battery)', grid:'var(--grid)' };
  const regLabel = document.getElementById('regimeLabel');
  if (regLabel) regLabel.remove();
  const rl = el('text', {id:'regimeLabel', x:BUS.x, y:LAY.busBot-38, 'text-anchor':'middle', fill:regColors[state.regime], 'font-size':11, 'font-weight':700});
  rl.textContent = state.regime.toUpperCase();
  gNodes.appendChild(rl);
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
    'node-trunkDelta':PARTS.trunk,'node-trunkWye':PARTS.trunk,'node-trunkOne':PARTS.trunk,
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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

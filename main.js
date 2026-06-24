/* main.js — wire slider inputs → model → render. Loaded as ES module. */
import { CONST, computeState } from './model.js';
import { init, render, attachTooltips } from './render.js';

const svg = document.getElementById('diagram');
const tip = document.getElementById('tooltip');
const summary = document.getElementById('summary');

init(svg);
attachTooltips(tip);

// Slider references
const S = {
  solar:  document.getElementById('solarSlider'),
  delta:  document.getElementById('deltaSlider'),
  wye:    document.getElementById('wyeSlider'),
  one:    document.getElementById('oneSlider'),
  socA:   document.getElementById('socA'),
  socB:   document.getElementById('socB'),
  socC:   document.getElementById('socC'),
};
// Value labels
const V = {
  solar: document.getElementById('solarVal'),
  delta: document.getElementById('deltaVal'),
  wye:   document.getElementById('wyeVal'),
  one:   document.getElementById('oneVal'),
  socA:  document.getElementById('socAVal'),
  socB:  document.getElementById('socBVal'),
  socC:  document.getElementById('socCVal'),
};

// Configure slider maxes
S.solar.max = CONST.solarMax;
S.delta.max = CONST.loads.delta.kw.toFixed(1);
S.wye.max   = CONST.loads.wye.kw.toFixed(1);
S.one.max   = CONST.loads.one.kw.toFixed(1);

function read() {
  return {
    solarTotal: Number(S.solar.value),
    load: { delta: Number(S.delta.value), wye: Number(S.wye.value), one: Number(S.one.value) },
    soc: [Number(S.socA.value), Number(S.socB.value), Number(S.socC.value)],
  };
}

function update() {
  const st = computeState(read());
  // update value labels
  V.solar.textContent = st.solarTotal.toFixed(1)+' kW';
  V.delta.textContent = st.loads.delta.toFixed(1)+' kW';
  V.wye.textContent   = st.loads.wye.toFixed(1)+' kW';
  V.one.textContent   = st.loads.one.toFixed(1)+' kW';
  V.socA.textContent  = st.perBank[0].soc.toFixed(0)+'% ('+st.perBank[0].vBat+'V)';
  V.socB.textContent  = st.perBank[1].soc.toFixed(0)+'% ('+st.perBank[1].vBat+'V)';
  V.socC.textContent  = st.perBank[2].soc.toFixed(0)+'% ('+st.perBank[2].vBat+'V)';
  // summary
  const lines = [
    `<b>Regime:</b> <span style="color:var(--${regColor(st.regime)})">${st.regime}</span> · bus ${st.busV}V`,
    `<b>Solar:</b> ${st.solarTotal} kW → load ${st.solarToLoad} kW${st.chargeKW>0?` + charge ${st.chargeKW} kW`:''}`,
    `<b>Battery:</b> ${st.dischargeKW>0?`discharge ${st.dischargeKW} kW`:''}${st.chargeKW>0?`charge ${st.chargeKW} kW`:''}${(st.dischargeKW===0&&st.chargeKW===0)?'idle':''}`,
    `<b>Grid:</b> ${st.gridKW>0?`${st.gridKW} kW`:'off'}`,
    `<b>Load:</b> ${st.totalLoad} kW (Δ${st.loads.delta} / Y${st.loads.wye} / 1φ${st.loads.one})`,
  ];
  summary.innerHTML = lines.join('<br>');
  render(st);
}

function regColor(r){
  return { idle:'muted', surplus:'solar', discharge:'battery', grid:'grid' }[r];
}

Object.values(S).forEach(s => s.addEventListener('input', update));

// initial render
update();

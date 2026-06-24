/* model.js — pure electrical model. No DOM, no I/O. Fully unit-tested.

   Exports pure functions + a CONSTANTS/PARTS object. All functions take
   plain data and return plain data. Side-effect free. Bun:test covers it.
*/

/* ============================ CONSTANTS ============================ */

export const CONST = {
  // DC bus voltage setpoints (coordination via voltage bands)
  Vsolar: 420,        // solar holds the bus here when producing
  Vcharge: 410,       // bus above this → batteries may charge
  Vdischarge: 390,    // bus below this → batteries may discharge
  Vgrid: 380,         // grid holds the bus here when engaged

  // SoC limits
  SoCfloor: 0,        // percent
  SoCfull: 100,       // percent

  // Solar: 4 MPPTs × 8 kW each (20 panels × ~400 W, 10s2p)
  solarMax: 32,
  mpptCount: 4,

  // Solar simulation constants (Session 1)
  irradiancePeak: 1000,   // W/m² at Standard Test Conditions
  overcastFactor: 0.15,   // heavy cloud → ~15% of clear-sky irradiance
  mpptEfficiency: 0.97,   // MPPT conversion + wiring loss (fixed)
  sunrise: 6,             // hours
  sunset: 18,             // hours

  // Grid (tooltip/sizing context only — regime math is in kW on DC side)
  grid: { v: 230, phase: '1φ', hz: 60 },

  // Load trunks (3 separate, each its own AC island) — kW values
  loads: {
    delta: { id:'delta', v:230,  a:60,  type:'3φ', config:'delta', kw: Math.sqrt(3)*230*60/1000 },   // ~23.9 kW
    wye:   { id:'wye',   v:400,  a:60,  type:'3φ', config:'wye',   kw: Math.sqrt(3)*400*60/1000 },   // ~41.6 kW
    one:   { id:'one',   v:230,  a:120, type:'1φ', config:'single',kw: 230*120/1000 },               // 27.6 kW
  },

  // Battery banks (4: A/B/C enabled, D disabled by default — all within
  // 300–500V nominal, 10–20 kWh). Bank D is a placeholder slot for future
  // expansion; `enabled:false` keeps it out of regime math in computeState.
  banks: [
    { id:'A', nominalV:350, kwh:15, maxChargeKW:10, maxDischargeKW:15, sub:'older · LiFePO4' },
    { id:'B', nominalV:400, kwh:20, maxChargeKW:12, maxDischargeKW:18, sub:'newer · NMC/LFP' },
    { id:'C', nominalV:480, kwh:10, maxChargeKW:8,  maxDischargeKW:12, sub:'future · TBD'   },
    { id:'D', nominalV:400, kwh:15, maxChargeKW:10, maxDischargeKW:15, enabled:false, sub:'future · TBD' },
  ],
};

/* ============================ PARTS (tooltip spec) ============================ */

export const PARTS = {
  mppt: {
    title: 'MPPT Charge Controller (standalone DC-DC)',
    desc: 'Tracks this sub-array\'s maximum power point and converts its floating panel voltage to the regulated DC bus voltage (~400V). One per sub-array (4 total, each 20 panels 10s2p). Galvanic isolation recommended. Comms for monitoring/curtailment.',
  },
  bank: {
    title: 'Battery Bank',
    desc: 'High-voltage bank with integrated BMS. A: 350V/15kWh older LiFePO4 · B: 400V/20kWh newer · C: 480V/10kWh future. Voltage varies with SoC; each bank connects to the bus only through its own bidirectional DC-DC converter.',
  },
  dcdc: {
    title: 'Bidirectional DC-DC Converter (battery PCS)',
    desc: 'Two DC ports (battery + bus), same path both directions — not separate load/supply terminals. Programmable charge/discharge profile, obeys the bank\'s BMS via CAN/RS485, isolated. One per bank. Enables mixing different voltages/ages/chemistries without cross-charging.',
  },
  acdc: {
    title: 'Programmable AC-DC Charger (rectifier)',
    desc: 'AC input: 230V 1-phase 60Hz from grid. DC output to bus at ~400V. Voltage setpoint set BELOW V_charge (380V) so the grid can never charge the batteries. Power-factor corrected, reverse-power blocking (no back-feed), programmable current limit. Sized for worst-case deficit.',
  },
  dcac3: {
    title: 'Standalone Grid-Forming DC-AC Converter (3-phase)',
    desc: 'Voltage-source / island-capable: establishes this 3-phase trunk\'s voltage and frequency (there is no upstream grid to follow — the DC bus has no phase). One per 3-phase trunk (delta + wye = 2 units). Sine-wave, surge-rated for motor inrush; battery on the bus supplies the energy.',
  },
  dcac1: {
    title: 'Standalone Grid-Forming DC-AC Converter (1-phase)',
    desc: 'Voltage-source / island-capable: establishes the 1-phase trunk\'s 230V/60Hz. Separate island from the grid and from the 3-phase trunks (the DC-AC converter sets frequency, not the grid). Sized for full 1-phase load; battery buffers bursty inrush.',
  },
  dcbus: {
    title: 'Common DC Bus (~400V)',
    desc: 'Regulated DC rail — no phases, no frequency. Coordination is via voltage setpoints: each source converter has a band, priority falls out of where the bus voltage sits. DC-rated busbars/breakers/fuses/contactors only (DC arcs do not self-extinguish). Contained in the equipment room.',
  },
  trunk: {
    title: 'Existing 12-Wire Trunk (25mm² each)',
    desc: 'Already run around the property — no new wire. Repurposed to carry mixed AC: delta 3φ (3+PE=4), wye 3φ (3+N+PE=5), 1φ (L+N=2, PE shared) = 11 wires, 1 spare. All downstream wiring is standard AC; no DC-rated gear needed on the trunk.',
  },
  acpanel: {
    title: 'AC Distribution Panel',
    desc: 'Standard AC breakers and protection downstream of the DC-AC converters. One per trunk (3 total). No DC-rated equipment needed here — the DC bus stays in the equipment room.',
  },
};

/* ============================ BATTERY VOLTAGE (plateau with droop) ============================ */

// V = nominalV × factor(soc). Plateau 10–90% ~flat, droop at extremes.
// 0%  → 0.90   (deep discharge floor)
// 10% → 0.97   (knee)
// 90% → 1.00   (knee)
// 100%→ 1.10   (full charge ceiling)
export function batteryVoltage(nominalV, soc) {
  soc = clamp(soc, 0, 100);
  let f;
  if (soc <= 10)      f = lerp(0.90, 0.97, soc / 10);
  else if (soc <= 90) f = lerp(0.97, 1.00, (soc - 10) / 80);   // gentle rise across plateau
  else                f = lerp(1.00, 1.10, (soc - 90) / 10);
  return round(nominalV * f, 1);
}

/* ============================ BATTERY MODE ============================ */

// Returns 'charge' | 'discharge' | 'idle' based on bus voltage band + SoC.
export function batteryMode(busV, soc) {
  soc = clamp(soc, 0, 100);
  if (soc <= 0)  return soc > 0 ? 'discharge' : 'idle';   // empty → can't discharge
  if (soc >= 100) return 'idle';                          // full → can't charge
  if (busV >= CONST.Vcharge)     return 'charge';
  if (busV <= CONST.Vdischarge)  return 'discharge';
  return 'idle';
}

/* ============================ SOLAR SPLIT ============================ */

// Equal split across N MPPTs.
export function solarSplit(solarTotal) {
  solarTotal = clamp(solarTotal, 0, CONST.solarMax);
  const n = CONST.mpptCount;
  const per = solarTotal / n;
  return Array.from({length:n}, () => round(per, 1));
}

/* ============================ LOAD PER TRUNK ============================ */

// Pass slider values; clamped to each trunk's max.
export function loadPerTrunk({ delta, wye, one } = {}) {
  return {
    delta: clampNum(delta, 0, CONST.loads.delta.kw),
    wye:   clampNum(wye,   0, CONST.loads.wye.kw),
    one:   clampNum(one,   0, CONST.loads.one.kw),
  };
}

/* ============================ CORE REGIME ============================ */

// Inputs: { solarTotal, load:{delta,wye,one}, soc:[a,b,c] }
// Returns the full system state for rendering.
export function computeState({ solarTotal, load, soc }) {
  solarTotal = clamp(solarTotal, 0, CONST.solarMax);
  const loads = loadPerTrunk(load);
  const totalLoad = loads.delta + loads.wye + loads.one;
  const net = solarTotal - totalLoad;     // +surplus, -deficit

  // First pass: decide bus voltage + regime from net + battery availability.
  // Disabled banks (enabled === false) contribute nothing and stay idle.
  const socs = CONST.banks.map((b, i) =>
    b.enabled === false ? 0 : clamp(soc[i], 0, 100));
  const canDischargeTotal = CONST.banks.reduce((sum, b, i) =>
    sum + (b.enabled === false ? 0 : (socs[i] > 0 ? b.maxDischargeKW : 0)), 0);
  const canChargeTotal = CONST.banks.reduce((sum, b, i) =>
    sum + (b.enabled === false ? 0 : (socs[i] < 100 ? b.maxChargeKW : 0)), 0);

  let busV, regime, chargeKW = 0, dischargeKW = 0, gridKW = 0;

  if (net > 0) {
    // SURPLUS: solar holds bus high; batteries charge if they can.
    regime = 'surplus';
    // bus rises with surplus magnitude, capped at Vsolar + a little
    busV = clamp(CONST.Vcharge + Math.min(net, 20), CONST.Vcharge, CONST.Vsolar + 5);
    chargeKW = Math.min(net, canChargeTotal);
  } else if (net < 0) {
    const deficit = -net;
    if (canDischargeTotal >= deficit) {
      // Batteries cover it: bus sags to Vdischarge.
      regime = 'discharge';
      busV = CONST.Vdischarge;
      dischargeKW = deficit;
    } else {
      // Batteries insufficient: grid engages at Vgrid, batteries discharge what they can alongside.
      regime = 'grid';
      busV = CONST.Vgrid;
      dischargeKW = canDischargeTotal;     // batteries give all they can
      gridKW = deficit - canDischargeTotal; // grid tops up the rest
    }
  } else {
    // net == 0: nothing flowing. Bus sits nominal between bands → banks idle.
    regime = 'idle';
    busV = 400;
  }

  // Per-bank distribution of charge/discharge (proportional to capacity, capped per bank).
  // Disabled banks are omitted from perBank entirely (kept out of rendering + guarantees).
  const perBank = [];
  CONST.banks.forEach((b, i) => {
    if (b.enabled === false) return;   // disabled: idle, contributes nothing
    const mode = batteryMode(busV, socs[i]);
    const vBat = batteryVoltage(b.nominalV, socs[i]);
    let kw = 0;
    if (mode === 'charge' && chargeKW > 0) {
      // proportional to bank's max charge share
      kw = Math.min(b.maxChargeKW, chargeKW * (b.maxChargeKW / canChargeTotal));
    } else if (mode === 'discharge' && dischargeKW > 0) {
      kw = Math.min(b.maxDischargeKW, dischargeKW * (b.maxDischargeKW / canDischargeTotal));
    }
    perBank.push({ id: b.id, mode, vBat, kw: round(kw, 1), soc: socs[i] });
  });

  // Round summary numbers
  chargeKW = round(perBank.filter(p => p.mode === 'charge').reduce((s,p)=>s+p.kw,0), 1);
  dischargeKW = round(perBank.filter(p => p.mode === 'discharge').reduce((s,p)=>s+p.kw,0), 1);

  return {
    solarTotal: round(solarTotal, 1),
    solarPerMppt: solarSplit(solarTotal),
    loads,
    totalLoad: round(totalLoad, 1),
    net: round(net, 1),
    regime,
    busV: round(busV, 1),
    chargeKW,
    dischargeKW,
    gridKW: round(gridKW, 1),
    perBank,
    // derived display values
    solarToLoad: round(Math.min(solarTotal, totalLoad), 1),
    solarToCharge: chargeKW,
  };
}

/* ============================ IRRADIANCE (equatorial equinox) ============================ */

// Equatorial-equinox solar irradiance: simple sine over daylight hours.
//   hourOfDay ∈ [0, 24). 0 at night (<sunrise or >sunset); peaks at irradiancePeak
//   (1000 W/m²) at noon; 0 at sunrise/sunset. Overcast multiplies by overcastFactor.
//   sunAngle = (hourOfDay - 12) / 6  →  -1 at sunrise, 0 at noon, +1 at sunset.
//   irradiance = irradiancePeak * cos(sunAngle * π/2)
export function computeIrradiance(hourOfDay, overcast = false) {
  const h = ((Number(hourOfDay) % 24) + 24) % 24;   // normalize to [0, 24)
  let irr;
  if (h < CONST.sunrise || h > CONST.sunset) {
    irr = 0;                                         // night
  } else {
    const sunAngle = (h - 12) / 6;
    irr = CONST.irradiancePeak * Math.cos(sunAngle * Math.PI / 2);
    if (irr < 0) irr = 0;                            // guard tiny fp negatives at endpoints
  }
  if (overcast) irr *= CONST.overcastFactor;
  return round(irr, 2);
}

/* ============================ PER-MPPT POWER ============================ */

// Per-MPPT output power in kW, scaling ~linearly with irradiance below STC
// (no temperature derate). Disabled MPPTs produce 0.
//   perPanelW = wattSTC * (irradiance / irradiancePeak)
//   mpptPowerW = perPanelW * panels * mpptEfficiency
export function mpptPowerKW(mpptConfig, irradiance) {
  if (!mpptConfig || mpptConfig.enabled === false) return 0;
  const irr = Math.max(0, Number(irradiance) || 0);   // solar output never negative
  const perPanelW = mpptConfig.wattSTC * (irr / CONST.irradiancePeak);
  const mpptPowerW = perPanelW * mpptConfig.panels * CONST.mpptEfficiency;
  return round(mpptPowerW / 1000, 2);
}

/* ============================ PER-MPPT VOLTAGE (display) ============================ */

// Panel-string Vmp, weakly dependent on irradiance (drops slightly at low sun).
//   vmp = vmpSTC * series * (0.85 + 0.15 * (irradiance / irradiancePeak))
// At full sun: ≈ vmpSTC × series (nominal). At 200 W/m²: ≈ × 0.88.
export function mpptVmp(mpptConfig, irradiance) {
  const irr = Math.max(0, Number(irradiance) || 0);   // non-physical below 0
  const f = 0.85 + 0.15 * (irr / CONST.irradiancePeak);
  return round(mpptConfig.vmpSTC * mpptConfig.series * f, 1);
}

/* ============================ TOTAL SOLAR ============================ */

// Sum of enabled MPPTs' mpptPowerKW at a given irradiance.
export function totalSolarKW(config, irradiance) {
  const mppts = (config && config.mppts) || [];
  const total = mppts.reduce((sum, m) => sum + mpptPowerKW(m, irradiance), 0);
  return round(total, 2);
}

/* ============================ HELPERS ============================ */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clampNum(v, lo, hi) { v = Number(v); if (!isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function round(v, d) { const m = Math.pow(10, d); return Math.round(v * m) / m; }

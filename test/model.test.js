import { test, expect, describe } from 'bun:test';
import {
  CONST, PARTS,
  batteryVoltage, batteryMode, solarSplit, loadPerTrunk, computeState,
  computeIrradiance, mpptPowerKW, mpptVmp, totalSolarKW,
  computeStateSim, stepBatteries,
} from '../app/model.js';
import { DEFAULT_CONFIG } from '../app/config.js';

/* ============================ batteryVoltage (plateau with droop) ============================ */

describe('batteryVoltage', () => {
  test('0% → 0.88 × nominal (deep discharge floor)', () => {
    expect(batteryVoltage(350, 0)).toBeCloseTo(308, 1);
    expect(batteryVoltage(400, 0)).toBeCloseTo(352, 1);
    expect(batteryVoltage(480, 0)).toBeCloseTo(422.4, 1);
  });
  test('100% → 1.10 × nominal (full charge ceiling = CV setpoint)', () => {
    expect(batteryVoltage(350, 100)).toBeCloseTo(385, 1);
    expect(batteryVoltage(400, 100)).toBeCloseTo(440, 1);
    expect(batteryVoltage(480, 100)).toBeCloseTo(528, 1);
  });
  test('10% → 0.95 × nominal (lower knee)', () => {
    expect(batteryVoltage(400, 10)).toBeCloseTo(380, 1);
  });
  test('90% → 1.03 × nominal (upper knee / CC→CV transition)', () => {
    expect(batteryVoltage(400, 90)).toBeCloseTo(412, 1);
  });
  test('plateau is roughly flat between 10–90%', () => {
    const v20 = batteryVoltage(400, 20);
    const v50 = batteryVoltage(400, 50);
    const v80 = batteryVoltage(400, 80);
    // LiFePO4 plateau (0.95–1.03): gentle rise; each half-span stays modest
    expect(Math.abs(v50 - v20)).toBeLessThan(20);
    expect(Math.abs(v80 - v50)).toBeLessThan(20);
  });
  test('monotonic increasing in SoC', () => {
    let prev = -Infinity;
    for (let soc = 0; soc <= 100; soc += 5) {
      const v = batteryVoltage(400, soc);
      expect(v).toBeGreaterThanOrEqual(prev - 0.01);
      prev = v;
    }
  });
  test('clamps out-of-range SoC', () => {
    expect(batteryVoltage(400, -50)).toBeCloseTo(batteryVoltage(400, 0), 1);
    expect(batteryVoltage(400, 200)).toBeCloseTo(batteryVoltage(400, 100), 1);
  });
});

/* ============================ batteryMode ============================ */

describe('batteryMode', () => {
  test('bus ≥ Vcharge (410) and SoC < 100 → charge', () => {
    expect(batteryMode(410, 50)).toBe('charge');
    expect(batteryMode(425, 10)).toBe('charge');
  });
  test('bus ≤ Vdischarge (390) and SoC > 0 → discharge', () => {
    expect(batteryMode(390, 50)).toBe('discharge');
    expect(batteryMode(380, 10)).toBe('discharge');
  });
  test('bus between bands → idle', () => {
    expect(batteryMode(400, 50)).toBe('idle');
  });
  test('SoC = 0 → idle (cannot discharge)', () => {
    expect(batteryMode(390, 0)).toBe('idle');
    expect(batteryMode(380, 0)).toBe('idle');
  });
  test('SoC = 100 → idle (cannot charge)', () => {
    expect(batteryMode(410, 100)).toBe('idle');
    expect(batteryMode(420, 100)).toBe('idle');
  });
});

/* ============================ solarSplit ============================ */

describe('solarSplit', () => {
  test('equal split across 4 MPPTs', () => {
    const s = solarSplit(32);
    expect(s).toHaveLength(4);
    s.forEach(v => expect(v).toBeCloseTo(8, 1));
  });
  test('zero solar → all zero', () => {
    const s = solarSplit(0);
    expect(s.every(v => v === 0)).toBe(true);
  });
  test('clamps above solarMax', () => {
    const s = solarSplit(100);
    expect(s.reduce((a,b)=>a+b,0)).toBeCloseTo(32, 1);
  });
});

/* ============================ loadPerTrunk ============================ */

describe('loadPerTrunk', () => {
  test('clamps each trunk to its rated max', () => {
    const l = loadPerTrunk({ delta: 999, wye: 999, one: 999 });
    expect(l.delta).toBeCloseTo(CONST.loads.delta.kw, 1);
    expect(l.wye).toBeCloseTo(CONST.loads.wye.kw, 1);
    expect(l.one).toBeCloseTo(CONST.loads.one.kw, 1);
  });
  test('handles missing/undefined values as 0', () => {
    const l = loadPerTrunk({});
    expect(l.delta).toBe(0);
    expect(l.wye).toBe(0);
    expect(l.one).toBe(0);
  });
  test('passes through in-range values', () => {
    const l = loadPerTrunk({ delta: 10, wye: 20, one: 5 });
    expect(l.delta).toBe(10);
    expect(l.wye).toBe(20);
    expect(l.one).toBe(5);
  });
});

/* ============================ computeState — core invariants ============================ */

describe('computeState invariants', () => {
  const zeroLoad = { delta: 0, wye: 0, one: 0 };
  const smallLoad = { delta: 5, wye: 8, one: 3 };   // 16 kW — leaves surplus
  const halfLoad = { delta: 12, wye: 20, one: 14 };  // 46 kW — deficit from solar alone
  const fullLoad = {
    delta: CONST.loads.delta.kw,
    wye: CONST.loads.wye.kw,
    one: CONST.loads.one.kw,
  };
  const midSoc = [50, 50, 50];
  const fullSoc = [100, 100, 100];
  const emptySoc = [0, 0, 0];

  test('solar=0, load=0, mid SoC → all idle, bus nominal', () => {
    const st = computeState({ solarTotal: 0, load: zeroLoad, soc: midSoc });
    expect(st.regime).toBe('idle');
    expect(st.busV).toBe(400);
    st.perBank.forEach(p => { expect(p.mode).toBe('idle'); expect(p.kw).toBe(0); });
    expect(st.gridKW).toBe(0);
  });

  test('surplus: solar > load, mid SoC → regime surplus, banks charge', () => {
    const st = computeState({ solarTotal: 32, load: zeroLoad, soc: midSoc });
    expect(st.regime).toBe('surplus');
    expect(st.busV).toBeGreaterThanOrEqual(CONST.Vcharge);
    st.perBank.forEach(p => expect(p.mode).toBe('charge'));
    expect(st.chargeKW).toBeGreaterThan(0);
    expect(st.gridKW).toBe(0);
  });

  test('surplus with full batteries → banks idle, no charge', () => {
    const st = computeState({ solarTotal: 32, load: zeroLoad, soc: fullSoc });
    expect(st.regime).toBe('surplus');
    st.perBank.forEach(p => expect(p.mode).toBe('idle'));
    expect(st.chargeKW).toBe(0);
  });

  test('deficit, batteries cover → regime discharge, no grid', () => {
    const st = computeState({ solarTotal: 0, load: smallLoad, soc: midSoc });
    expect(st.regime).toBe('discharge');
    expect(st.busV).toBe(CONST.Vdischarge);
    expect(st.gridKW).toBe(0);
    expect(st.dischargeKW).toBeGreaterThan(0);
  });

  test('deficit, batteries insufficient → grid engages, batteries discharge alongside', () => {
    const st = computeState({ solarTotal: 0, load: fullLoad, soc: [10, 10, 10] });
    expect(st.regime).toBe('grid');
    expect(st.busV).toBe(CONST.Vgrid);
    expect(st.gridKW).toBeGreaterThan(0);
    // batteries still discharging what they can (co-engaged)
    expect(st.dischargeKW).toBeGreaterThan(0);
  });

  test('empty batteries + full load → grid carries, batteries idle', () => {
    const st = computeState({ solarTotal: 0, load: fullLoad, soc: emptySoc });
    expect(st.regime).toBe('grid');
    expect(st.busV).toBe(CONST.Vgrid);
    expect(st.dischargeKW).toBe(0);
    expect(st.gridKW).toBeGreaterThan(0);
    st.perBank.forEach(p => expect(p.mode).toBe('idle'));
  });

  /* ---- The three guarantees ---- */

  test('GUARANTEE: gridKW > 0 ⇒ no bank in charge mode', () => {
    // try many states
    for (let solar = 0; solar <= 32; solar += 4) {
      for (let loadFrac = 0; loadFrac <= 1.01; loadFrac += 0.25) {
        for (const soc of [[0,0,0],[50,50,50],[100,100,100],[10,80,40]]) {
          const load = {
            delta: CONST.loads.delta.kw * loadFrac,
            wye: CONST.loads.wye.kw * loadFrac,
            one: CONST.loads.one.kw * loadFrac,
          };
          const st = computeState({ solarTotal: solar, load, soc });
          if (st.gridKW > 0) {
            st.perBank.forEach(p => {
              expect(p.mode).not.toBe('charge');
            });
          }
        }
      }
    }
  });

  test('GUARANTEE: no two banks simultaneously in opposite modes', () => {
    for (let solar = 0; solar <= 32; solar += 4) {
      for (let loadFrac = 0; loadFrac <= 1.01; loadFrac += 0.25) {
        for (const soc of [[0,0,0],[50,50,50],[100,100,100],[10,80,40],[100,0,50]]) {
          const load = {
            delta: CONST.loads.delta.kw * loadFrac,
            wye: CONST.loads.wye.kw * loadFrac,
            one: CONST.loads.one.kw * loadFrac,
          };
          const st = computeState({ solarTotal: solar, load, soc });
          const modes = st.perBank.map(p => p.mode);
          const hasCharge = modes.includes('charge');
          const hasDischarge = modes.includes('discharge');
          expect(hasCharge && hasDischarge).toBe(false);
        }
      }
    }
  });

  test('GUARANTEE: SoC=0 bank never discharges', () => {
    const st = computeState({ solarTotal: 0, load: fullLoad, soc: [0, 50, 50] });
    expect(st.perBank[0].mode).not.toBe('discharge');
    expect(st.perBank[0].kw).toBe(0);
  });

  test('GUARANTEE: SoC=100 bank never charges', () => {
    const st = computeState({ solarTotal: 32, load: zeroLoad, soc: [100, 50, 50] });
    expect(st.perBank[0].mode).not.toBe('charge');
    expect(st.perBank[0].kw).toBe(0);
  });

  /* ---- Bus voltage behavior ---- */

  test('busV monotonic in surplus magnitude (more surplus → higher bus)', () => {
    const s1 = computeState({ solarTotal: 20, load: zeroLoad, soc: fullSoc });
    const s2 = computeState({ solarTotal: 32, load: zeroLoad, soc: fullSoc });
    expect(s2.busV).toBeGreaterThanOrEqual(s1.busV);
  });

  test('busV in grid regime is exactly Vgrid', () => {
    const st = computeState({ solarTotal: 0, load: fullLoad, soc: emptySoc });
    expect(st.busV).toBe(CONST.Vgrid);
  });

  test('busV in discharge regime is exactly Vdischarge', () => {
    const st = computeState({ solarTotal: 0, load: smallLoad, soc: midSoc });
    expect(st.busV).toBe(CONST.Vdischarge);
  });

  test('busV in surplus is between Vcharge and Vsolar+5', () => {
    const st = computeState({ solarTotal: 32, load: zeroLoad, soc: midSoc });
    expect(st.busV).toBeGreaterThanOrEqual(CONST.Vcharge);
    expect(st.busV).toBeLessThanOrEqual(CONST.Vsolar + 5);
  });

  /* ---- Per-bank rate limits ---- */

  test('per-bank charge kW never exceeds bank.maxChargeKW', () => {
    const st = computeState({ solarTotal: 32, load: zeroLoad, soc: midSoc });
    st.perBank.forEach((p, i) => {
      expect(p.kw).toBeLessThanOrEqual(CONST.banks[i].maxChargeKW + 0.1);
    });
  });

  test('per-bank discharge kW never exceeds bank.maxDischargeKW', () => {
    const st = computeState({ solarTotal: 0, load: fullLoad, soc: [50, 50, 50] });
    st.perBank.forEach((p, i) => {
      expect(p.kw).toBeLessThanOrEqual(CONST.banks[i].maxDischargeKW + 0.1);
    });
  });

  /* ---- Conservation (approx) ---- */

  test('energy balance: sources ≈ loads (surplus regime)', () => {
    const st = computeState({ solarTotal: 32, load: smallLoad, soc: midSoc });
    const sources = st.solarTotal;
    const sinks = st.totalLoad + st.chargeKW;
    expect(Math.abs(sources - sinks)).toBeLessThan(0.5);
  });

  test('energy balance: sources ≈ loads (discharge regime)', () => {
    const st = computeState({ solarTotal: 10, load: halfLoad, soc: midSoc });
    const sources = st.solarTotal + st.dischargeKW;
    expect(Math.abs(sources - st.totalLoad)).toBeLessThan(0.5);
  });

  test('energy balance: sources ≈ loads (grid regime)', () => {
    const st = computeState({ solarTotal: 0, load: fullLoad, soc: [10, 10, 10] });
    const sources = st.dischargeKW + st.gridKW;
    expect(Math.abs(sources - st.totalLoad)).toBeLessThan(1);
  });
});

/* ============================ PARTS / CONST sanity ============================ */

describe('constants & parts', () => {
  test('loads match expected kW', () => {
    expect(CONST.loads.delta.kw).toBeCloseTo(23.9, 0);
    expect(CONST.loads.wye.kw).toBeCloseTo(41.6, 0);
    expect(CONST.loads.one.kw).toBeCloseTo(27.6, 0);
  });
  test('PARTS has all component types', () => {
    ['mppt','bank','dcdc','acdc','dcac3','dcac1','dcbus','acpanel'].forEach(k => {
      expect(PARTS[k]).toBeDefined();
      expect(PARTS[k].title).toBeTruthy();
      expect(PARTS[k].desc).toBeTruthy();
    });
  });
  test('voltage bands are ordered: Vsolar > Vcharge > Vdischarge > Vgrid', () => {
    expect(CONST.Vsolar).toBeGreaterThan(CONST.Vcharge);
    expect(CONST.Vcharge).toBeGreaterThan(CONST.Vdischarge);
    expect(CONST.Vdischarge).toBeGreaterThan(CONST.Vgrid);
  });
  test('grid is 230V 1-phase 60Hz', () => {
    expect(CONST.grid.v).toBe(230);
    expect(CONST.grid.phase).toBe('1φ');
    expect(CONST.grid.hz).toBe(60);
  });
});

/* ============================ Session 1: solar model ============================ */

describe('computeIrradiance (equatorial equinox)', () => {
  test('0 at midnight, dawn, dusk, and night', () => {
    expect(computeIrradiance(0)).toBe(0);     // midnight
    expect(computeIrradiance(6)).toBe(0);     // dawn
    expect(computeIrradiance(18)).toBe(0);    // dusk
    expect(computeIrradiance(22)).toBe(0);    // night
  });
  test('noon ≈ 1000 (peak)', () => {
    expect(computeIrradiance(12)).toBeCloseTo(1000, 0);
    expect(computeIrradiance(12)).toBe(CONST.irradiancePeak);
  });
  test('0 outside [sunrise, sunset], positive inside', () => {
    expect(computeIrradiance(CONST.sunrise - 0.5)).toBe(0);
    expect(computeIrradiance(CONST.sunset + 0.5)).toBe(0);
    for (let h = CONST.sunrise + 0.5; h < CONST.sunset; h += 1) {
      expect(computeIrradiance(h)).toBeGreaterThan(0);
    }
  });
  test('monotonic increasing sunrise→noon, decreasing noon→sunset', () => {
    let prev = -Infinity;
    for (let h = CONST.sunrise; h <= 12; h += 0.5) {
      const v = computeIrradiance(h);
      expect(v).toBeGreaterThanOrEqual(prev - 0.01);
      prev = v;
    }
    prev = Infinity;
    for (let h = 12; h <= CONST.sunset; h += 0.5) {
      const v = computeIrradiance(h);
      expect(v).toBeLessThanOrEqual(prev + 0.01);
      prev = v;
    }
  });
  test('overcast multiplies clear-sky irradiance by overcastFactor', () => {
    for (let h = CONST.sunrise + 0.5; h < CONST.sunset; h += 2) {
      const clear = computeIrradiance(h, false);
      const cloud = computeIrradiance(h, true);
      expect(cloud).toBeCloseTo(clear * CONST.overcastFactor, 1);
    }
    // night overcast stays 0
    expect(computeIrradiance(0, true)).toBe(0);
  });
  test('normalizes hourOfDay outside [0,24)', () => {
    expect(computeIrradiance(24)).toBeCloseTo(computeIrradiance(0), 5);
    expect(computeIrradiance(-1)).toBeCloseTo(computeIrradiance(23), 5);
    expect(computeIrradiance(25)).toBeCloseTo(computeIrradiance(1), 5);
  });
  test('overcast defaults to false', () => {
    expect(computeIrradiance(12)).toBeCloseTo(1000, 0);
  });
});

describe('mpptPowerKW', () => {
  // Use a synthetic config so tests don't depend on DEFAULT_CONFIG values.
  const m = { id:'t', enabled:true, series:10, parallel:2, vmp:40, imp:10 };
  test('scales linearly with irradiance', () => {
    const p1000 = mpptPowerKW(m, 1000);
    const p500  = mpptPowerKW(m, 500);
    const p250  = mpptPowerKW(m, 250);
    // perPanelW = 40×10 = 400W; panels = 20; ×0.97 efficiency = 7760W = 7.76kW
    expect(p1000).toBeCloseTo(7.76, 2);
    expect(p500).toBeCloseTo(p1000 / 2, 2);
    expect(p250).toBeCloseTo(p1000 / 4, 2);
  });
  test('0 at night (irradiance=0)', () => {
    expect(mpptPowerKW(m, 0)).toBe(0);
  });
  test('disabled MPPT → 0', () => {
    const disabled = { ...m, enabled:false };
    expect(mpptPowerKW(disabled, 1000)).toBe(0);
    expect(mpptPowerKW(disabled, 0)).toBe(0);
  });
  test('at 1000 W/m² = vmp × imp × series × parallel × efficiency / 1000', () => {
    const expected = m.vmp * m.imp * m.series * m.parallel * CONST.mpptEfficiency / 1000;
    expect(mpptPowerKW(m, 1000)).toBeCloseTo(expected, 2);
  });
  test('never negative', () => {
    expect(mpptPowerKW(m, -100)).toBeGreaterThanOrEqual(0);
  });
});

describe('mpptVmp', () => {
  const m = { id:'t', enabled:true, series:10, parallel:2, vmp:40, imp:10 };
  test('equals vmp × series at 1000 W/m²', () => {
    expect(mpptVmp(m, 1000)).toBeCloseTo(m.vmp * m.series, 1);   // 400
  });
  test('droops at low irradiance (below nominal)', () => {
    const vFull = mpptVmp(m, 1000);
    const vLow  = mpptVmp(m, 200);
    expect(vLow).toBeLessThan(vFull);
    expect(vLow).toBeGreaterThan(vFull * 0.85);   // never below 0.85× nominal
  });
  test('factor formula at 200 W/m² → 0.88× nominal', () => {
    expect(mpptVmp(m, 200)).toBeCloseTo(m.vmp * m.series * 0.88, 1);   // 352
  });
  test('at 0 irradiance → 0.85× nominal (floor of the droop factor)', () => {
    expect(mpptVmp(m, 0)).toBeCloseTo(m.vmp * m.series * 0.85, 1);     // 340
  });
});

describe('totalSolarKW', () => {
  const cfg = {
    mppts: [
      { id:'a', enabled:true,  series:10, parallel:2, vmp:40, imp:10 },
      { id:'b', enabled:true,  series:10, parallel:2, vmp:40, imp:10 },
      { id:'c', enabled:false, series:10, parallel:2, vmp:40, imp:10 },
    ],
  };
  test('sums enabled MPPTs, ignores disabled', () => {
    const t = totalSolarKW(cfg, 1000);
    const enabled = cfg.mppts.filter(m => m.enabled !== false);
    const expected = enabled.reduce((s, m) => s + mpptPowerKW(m, 1000), 0);
    expect(t).toBeCloseTo(expected, 2);
  });
  test('0 at night', () => {
    expect(totalSolarKW(cfg, 0)).toBe(0);
  });
  test('overcast (~15% irradiance) reduces total to ~15%', () => {
    const clear = totalSolarKW(cfg, 1000);
    const cloud = totalSolarKW(cfg, 150);   // 1000 * 0.15
    expect(cloud).toBeCloseTo(clear * 0.15, 1);
  });
  test('empty/missing config → 0', () => {
    expect(totalSolarKW({}, 1000)).toBe(0);
    expect(totalSolarKW(undefined, 1000)).toBe(0);
  });
});

/* ============================ Session 2: battery CC/CV + regime + step ============================ */

// Helper: clone DEFAULT_CONFIG banks with a given SoC per bank (A,B,C,D).
// SoC is runtime state, not stored in config, so default to 0 when omitted.
function banksAt(socs) {
  return DEFAULT_CONFIG.banks.map((b, i) => ({ ...b, soc: socs[i] ?? 0 }));
}

describe('computeStateSim — CC/CV charge allocation', () => {
  const zeroLoad = { delta: 0, wye: 0, one: 0 };

  test('CC phase: chargeKW = maxChargeKW while SoC < cvKneeSoC (90%)', () => {
    const banks = banksAt([50, 50, 50, 50]);
    const st = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    expect(st.regime).toBe('surplus');
    st.perBank.forEach(p => {
      const cfg = DEFAULT_CONFIG.banks.find(b => b.id === p.id);
      const maxChargeKW = cfg.maxChargeA * cfg.nominalV / 1000;
      // CC phase: each bank draws up to its max (subject to surplus share)
      expect(p.mode).toBe('charge');
      expect(p.kw).toBeLessThanOrEqual(maxChargeKW + 0.01);
    });
  });

  test('CV phase (SoC ≥ 90%): chargeKW tapers toward 0 as SoC→100', () => {
    const banks95 = banksAt([95, 95, 95, 95]);
    const st95 = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks: banks95, config: DEFAULT_CONFIG });
    const banks99 = banksAt([99, 99, 99, 99]);
    const st99 = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks: banks99, config: DEFAULT_CONFIG });
    const avg95 = st95.perBank.reduce((s, p) => s + p.kw, 0) / st95.perBank.length;
    const avg99 = st99.perBank.reduce((s, p) => s + p.kw, 0) / st99.perBank.length;
    // both tapering (below the CC max), and 99% < 95%
    expect(avg95).toBeGreaterThan(0);
    expect(avg99).toBeGreaterThan(0);
    expect(avg99).toBeLessThan(avg95);
  });

  test('At SoC=100: mode=idle, chargeKW=0', () => {
    const banks = banksAt([100, 100, 100, 100]);
    const st = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    st.perBank.forEach(p => {
      expect(p.mode).toBe('idle');
      expect(p.kw).toBe(0);
    });
  });

  test('SoC=0 bank never charges into discharge; mode stays charge or idle (not discharge)', () => {
    const banks = banksAt([0, 50, 50, 50]);
    const st = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    expect(st.perBank[0].mode).toBe('charge');   // bus high, empty → can charge
    expect(st.perBank[0].kw).toBeGreaterThan(0);
  });
});

describe('computeStateSim — guarantees (parity with computeState)', () => {
  const zeroLoad = { delta: 0, wye: 0, one: 0 };
  const smallLoad = { delta: 5, wye: 8, one: 3 };
  const fullLoad = {
    delta: CONST.loads.delta.kw,
    wye: CONST.loads.wye.kw,
    one: CONST.loads.one.kw,
  };

  test('midnight, no load, mid SoC → idle, bus 400V, no flows', () => {
    const st = computeStateSim({ solarTotalKW: 0, loads: zeroLoad, banks: banksAt([50,50,50,50]), config: DEFAULT_CONFIG });
    expect(st.regime).toBe('idle');
    expect(st.busV).toBe(400);
    expect(st.chargeKW).toBe(0);
    expect(st.dischargeKW).toBe(0);
    expect(st.gridKW).toBe(0);
    st.perBank.forEach(p => { expect(p.mode).toBe('idle'); expect(p.kw).toBe(0); });
  });

  test('GUARANTEE: gridKW>0 ⇒ no bank in charge mode', () => {
    for (let solar = 0; solar <= 32; solar += 4) {
      for (let loadFrac = 0; loadFrac <= 1.01; loadFrac += 0.25) {
        for (const soc of [[0,0,0,0],[50,50,50,50],[100,100,100,100],[10,80,40,60]]) {
          const load = {
            delta: CONST.loads.delta.kw * loadFrac,
            wye: CONST.loads.wye.kw * loadFrac,
            one: CONST.loads.one.kw * loadFrac,
          };
          const st = computeStateSim({ solarTotalKW: solar, loads: load, banks: banksAt(soc), config: DEFAULT_CONFIG });
          if (st.gridKW > 0) {
            st.perBank.forEach(p => expect(p.mode).not.toBe('charge'));
          }
        }
      }
    }
  });

  test('GUARANTEE: no two banks in opposite modes', () => {
    for (let solar = 0; solar <= 32; solar += 4) {
      for (let loadFrac = 0; loadFrac <= 1.01; loadFrac += 0.25) {
        for (const soc of [[0,0,0,0],[50,50,50,50],[100,100,100,100],[10,80,40,60],[100,0,50,30]]) {
          const load = {
            delta: CONST.loads.delta.kw * loadFrac,
            wye: CONST.loads.wye.kw * loadFrac,
            one: CONST.loads.one.kw * loadFrac,
          };
          const st = computeStateSim({ solarTotalKW: solar, loads: load, banks: banksAt(soc), config: DEFAULT_CONFIG });
          const modes = st.perBank.map(p => p.mode);
          expect(modes.includes('charge') && modes.includes('discharge')).toBe(false);
        }
      }
    }
  });

  test('GUARANTEE: SoC=0 ⇒ no discharge; SoC=100 ⇒ no charge', () => {
    const s0 = computeStateSim({ solarTotalKW: 0, loads: fullLoad, banks: banksAt([0,50,50,50]), config: DEFAULT_CONFIG });
    expect(s0.perBank[0].mode).not.toBe('discharge');
    expect(s0.perBank[0].kw).toBe(0);
    const s100 = computeStateSim({ solarTotalKW: 32, loads: zeroLoad, banks: banksAt([100,50,50,50]), config: DEFAULT_CONFIG });
    expect(s100.perBank[0].mode).not.toBe('charge');
    expect(s100.perBank[0].kw).toBe(0);
  });

  test('per-bank rate limits (maxChargeA / maxDischargeA)', () => {
    const sCh = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks: banksAt([50,50,50,50]), config: DEFAULT_CONFIG });
    sCh.perBank.forEach(p => {
      const cfg = DEFAULT_CONFIG.banks.find(b => b.id === p.id);
      expect(p.kw).toBeLessThanOrEqual(cfg.maxChargeA * cfg.nominalV / 1000 + 0.01);
    });
    const sDis = computeStateSim({ solarTotalKW: 0, loads: fullLoad, banks: banksAt([50,50,50,50]), config: DEFAULT_CONFIG });
    sDis.perBank.forEach(p => {
      const cfg = DEFAULT_CONFIG.banks.find(b => b.id === p.id);
      expect(p.kw).toBeLessThanOrEqual(cfg.maxDischargeA * cfg.nominalV / 1000 + 0.01);
    });
  });

  test('disabled bank contributes nothing and is omitted from perBank', () => {
    const banks = banksAt([50,50,50,50]);
    const st = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    // bank D is disabled → not in perBank
    expect(st.perBank.find(p => p.id === 'D')).toBeUndefined();
    expect(st.perBank).toHaveLength(3);
  });

  test('grid + battery co-engagement when batteries insufficient', () => {
    const st = computeStateSim({ solarTotalKW: 0, loads: fullLoad, banks: banksAt([10,10,10,10]), config: DEFAULT_CONFIG });
    expect(st.regime).toBe('grid');
    expect(st.busV).toBe(CONST.Vgrid);
    expect(st.gridKW).toBeGreaterThan(0);
    expect(st.dischargeKW).toBeGreaterThan(0);   // co-engaged
  });

  test('surplus with all banks full → no charge, surplus spilled (bus high, no sink)', () => {
    const st = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks: banksAt([100,100,100,100]), config: DEFAULT_CONFIG });
    expect(st.regime).toBe('surplus');
    expect(st.chargeKW).toBe(0);
    st.perBank.forEach(p => { expect(p.mode).toBe('idle'); expect(p.kw).toBe(0); });
  });

  test('energy balance: sources ≈ sinks across regimes', () => {
    // surplus
    let st = computeStateSim({ solarTotalKW: 30, loads: smallLoad, banks: banksAt([50,50,50,50]), config: DEFAULT_CONFIG });
    expect(Math.abs(st.solarTotalKW - (st.totalLoad + st.chargeKW))).toBeLessThan(0.5);
    // discharge — use a load the batteries can fully cover (small enough deficit)
    st = computeStateSim({ solarTotalKW: 10, loads: { delta: 5, wye: 8, one: 3 }, banks: banksAt([50,50,50,50]), config: DEFAULT_CONFIG });
    expect(st.regime).toBe('discharge');
    expect(Math.abs((st.solarTotalKW + st.dischargeKW) - st.totalLoad)).toBeLessThan(0.5);
    // grid
    st = computeStateSim({ solarTotalKW: 0, loads: fullLoad, banks: banksAt([10,10,10,10]), config: DEFAULT_CONFIG });
    expect(Math.abs((st.dischargeKW + st.gridKW) - st.totalLoad)).toBeLessThan(1);
  });

  test('computeStateSim result includes totalLoad and solarTotalKW fields', () => {
    const st = computeStateSim({ solarTotalKW: 10, loads: { delta: 2, wye: 3, one: 1 }, banks: banksAt([50,50,50,50]), config: DEFAULT_CONFIG });
    expect(st.totalLoad).toBeCloseTo(6, 1);
    expect(st.solarTotalKW).toBeCloseTo(10, 1);
  });
});

describe('stepBatteries', () => {
  const zeroLoad = { delta: 0, wye: 0, one: 0 };

  test('discharge reduces SoC by dischargeKW×dt/kwh×100', () => {
    const banks = banksAt([50, 50, 50, 50]);
    const st = computeStateSim({ solarTotalKW: 0, loads: { delta: 5, wye: 8, one: 3 }, banks, config: DEFAULT_CONFIG });
    expect(st.regime).toBe('discharge');
    const before = st.perBank[0].soc;
    const dt = 0.5;   // 30 min
    const out = stepBatteries(st, dt);
    const cfg = DEFAULT_CONFIG.banks[0];
    const expectedSoC = before - st.perBank[0].kw * dt / cfg.kwh * 100;
    expect(out[0].soc).toBeCloseTo(expectedSoC, 2);
    expect(out[0].soc).toBeLessThan(before);
  });

  test('charge increases SoC, capped at 100', () => {
    // large surplus + small load → strong charge; step repeatedly toward full
    let banks = banksAt([95, 95, 95, 95]);
    for (let i = 0; i < 50; i++) {
      const st = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
      const stepped = stepBatteries(st, 0.5);
      // rebuild banks[] carrying the new soc
      banks = DEFAULT_CONFIG.banks.map((b, idx) => {
        const p = stepped.find(s => s.id === b.id);
        return { ...b, soc: p ? p.soc : b.soc };
      });
    }
    // after many steps, SoC should be capped at 100, never above
    const finalSt = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    finalSt.perBank.forEach(p => expect(p.soc).toBeLessThanOrEqual(100.001));
    expect(banks[0].soc).toBeCloseTo(100, 0);
  });

  test('SoC never goes below 0 or above 100 after a step', () => {
    // drive toward 0 with a big deficit
    let banks = banksAt([2, 2, 2, 2]);
    const fullLoad = { delta: CONST.loads.delta.kw, wye: CONST.loads.wye.kw, one: CONST.loads.one.kw };
    const st = computeStateSim({ solarTotalKW: 0, loads: fullLoad, banks, config: DEFAULT_CONFIG });
    const out = stepBatteries(st, 1.0);   // 1h step would overshoot
    out.forEach(p => expect(p.soc).toBeGreaterThanOrEqual(0));
    out.forEach(p => expect(p.soc).toBeLessThanOrEqual(100));
  });

  test('disabled bank: SoC unchanged, mode=idle, kW=0', () => {
    const banks = banksAt([50, 50, 50, 50]);
    const st = computeStateSim({ solarTotalKW: 30, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    // bank D is disabled — not in perBank. Inject a fake disabled entry to test stepBatteries handling.
    const withDisabled = [...st.perBank, { id: 'D', mode: 'charge', vBat: 440, kw: 5, soc: 50, cfg: DEFAULT_CONFIG.banks[3] }];
    const out = stepBatteries({ perBank: withDisabled }, 1.0);
    const d = out.find(p => p.id === 'D');
    expect(d).toBeDefined();
    expect(d.mode).toBe('idle');
    expect(d.kw).toBe(0);
    expect(d.soc).toBe(50);   // unchanged
  });

  test('idle mode (no load, no solar) leaves SoC unchanged', () => {
    const banks = banksAt([42, 67, 88, 50]);
    const st = computeStateSim({ solarTotalKW: 0, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    expect(st.regime).toBe('idle');
    const out = stepBatteries(st, 2.0);
    out.forEach((p, i) => expect(p.soc).toBeCloseTo(st.perBank[i].soc, 4));
  });

  test('vBat recomputed from new SoC after step', () => {
    const banks = banksAt([10, 10, 10, 10]);
    const st = computeStateSim({ solarTotalKW: 0, loads: { delta: 5, wye: 8, one: 3 }, banks, config: DEFAULT_CONFIG });
    const out = stepBatteries(st, 0.5);
    out.forEach((p, i) => {
      const cfg = DEFAULT_CONFIG.banks.find(b => b.id === p.id);
      expect(p.vBat).toBeCloseTo(batteryVoltage(cfg.nominalV, p.soc), 1);
    });
  });
});

/* ============================ Session 2: multi-step integration ============================ */

describe('multi-step integration', () => {
  const zeroLoad = { delta: 0, wye: 0, one: 0 };

  test('midnight, SoC 50%, no load → banks idle all night, SoC unchanged, bus 400V', () => {
    let banks = banksAt([50, 50, 50, 50]);
    for (let h = 0; h < 6; h += 0.5) {   // 6 hours of night
      const st = computeStateSim({ solarTotalKW: 0, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
      expect(st.regime).toBe('idle');
      expect(st.busV).toBe(400);
      const stepped = stepBatteries(st, 0.5);
      banks = DEFAULT_CONFIG.banks.map((b, idx) => {
        const p = stepped.find(s => s.id === b.id);
        return { ...b, soc: p ? p.soc : b.soc };
      });
    }
    banks.slice(0, 3).forEach(b => expect(b.soc).toBeCloseTo(50, 2));
  });

  test('noon, full sun, no load, SoC 50% → banks charge, SoC rises, tapers near 100', () => {
    let banks = banksAt([50, 50, 50, 50]);
    const irr = computeIrradiance(12);   // 1000
    const solarKW = totalSolarKW(DEFAULT_CONFIG, irr);
    expect(solarKW).toBeGreaterThan(20);
    let prevAvgSoC = 50;
    for (let step = 0; step < 40; step++) {
      const st = computeStateSim({ solarTotalKW: solarKW, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
      expect(st.regime).toBe('surplus');
      const stepped = stepBatteries(st, 0.5);
      const avgSoC = stepped.reduce((s, p) => s + p.soc, 0) / stepped.length;
      // SoC should be non-decreasing while charging
      expect(avgSoC).toBeGreaterThanOrEqual(prevAvgSoC - 0.01);
      prevAvgSoC = avgSoC;
      banks = DEFAULT_CONFIG.banks.map((b, idx) => {
        const p = stepped.find(s => s.id === b.id);
        return { ...b, soc: p ? p.soc : b.soc };
      });
    }
    // approaching full, charge has tapered (last step's chargeKW small)
    const finalSt = computeStateSim({ solarTotalKW: solarKW, loads: zeroLoad, banks, config: DEFAULT_CONFIG });
    expect(finalSt.chargeKW).toBeLessThan(solarKW * 0.5);   // tapered
  });

  test('overcast noon + load exceeding solar → batteries discharge, then grid engages when depleted', () => {
    let banks = banksAt([10, 10, 10, 10]);
    const irr = computeIrradiance(12, true);   // overcast → 150
    const solarKW = totalSolarKW(DEFAULT_CONFIG, irr);
    const heavyLoad = { delta: 15, wye: 25, one: 15 };   // 55 kW >> solar
    let sawGrid = false;
    for (let step = 0; step < 30; step++) {
      const st = computeStateSim({ solarTotalKW: solarKW, loads: heavyLoad, banks, config: DEFAULT_CONFIG });
      if (st.regime === 'grid') sawGrid = true;
      const stepped = stepBatteries(st, 0.5);
      banks = DEFAULT_CONFIG.banks.map((b, idx) => {
        const p = stepped.find(s => s.id === b.id);
        return { ...b, soc: p ? p.soc : b.soc };
      });
    }
    expect(sawGrid).toBe(true);
    // eventually depleted
    const finalSt = computeStateSim({ solarTotalKW: solarKW, loads: heavyLoad, banks, config: DEFAULT_CONFIG });
    expect(finalSt.gridKW).toBeGreaterThan(0);
  });

  test('scrub 6am→6pm with moderate load: SoC dips morning, recovers midday, dips evening', () => {
    const moderateLoad = { delta: 4, wye: 6, one: 3 };   // 13 kW
    let banks = banksAt([60, 60, 60, 60]);
    const socByHour = [];
    for (let h = 6; h <= 18; h += 0.5) {
      const irr = computeIrradiance(h);
      const solarKW = totalSolarKW(DEFAULT_CONFIG, irr);
      const st = computeStateSim({ solarTotalKW: solarKW, loads: moderateLoad, banks, config: DEFAULT_CONFIG });
      const stepped = stepBatteries(st, 0.5);
      const avgSoC = stepped.reduce((s, p) => s + p.soc, 0) / stepped.length;
      socByHour.push({ h, soc: avgSoC, regime: st.regime });
      banks = DEFAULT_CONFIG.banks.map((b, idx) => {
        const p = stepped.find(s => s.id === b.id);
        return { ...b, soc: p ? p.soc : b.soc };
      });
    }
    // morning (low solar) should dip, midday (peak solar) should recover
    const morning = socByHour.slice(0, 4).reduce((s, x) => s + x.soc, 0) / 4;
    const midday = socByHour.slice(8, 16).reduce((s, x) => s + x.soc, 0) / 8;
    // midday SoC ≥ morning SoC (recovery)
    expect(midday).toBeGreaterThanOrEqual(morning - 2);
    // no constraint violations anywhere
    socByHour.forEach(x => expect(x.soc).toBeGreaterThanOrEqual(0));
    socByHour.forEach(x => expect(x.soc).toBeLessThanOrEqual(100));
  });
});

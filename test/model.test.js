import { test, expect, describe } from 'bun:test';
import {
  CONST, PARTS,
  batteryVoltage, batteryMode, solarSplit, loadPerTrunk, computeState,
  computeIrradiance, mpptPowerKW, mpptVmp, totalSolarKW,
} from '../model.js';
import { DEFAULT_CONFIG } from '../config.js';

/* ============================ batteryVoltage (plateau with droop) ============================ */

describe('batteryVoltage', () => {
  test('0% → 0.90 × nominal (deep discharge floor)', () => {
    expect(batteryVoltage(350, 0)).toBeCloseTo(315, 1);
    expect(batteryVoltage(400, 0)).toBeCloseTo(360, 1);
    expect(batteryVoltage(480, 0)).toBeCloseTo(432, 1);
  });
  test('100% → 1.10 × nominal (full charge ceiling)', () => {
    expect(batteryVoltage(350, 100)).toBeCloseTo(385, 1);
    expect(batteryVoltage(400, 100)).toBeCloseTo(440, 1);
    expect(batteryVoltage(480, 100)).toBeCloseTo(528, 1);
  });
  test('10% → 0.97 × nominal (lower knee)', () => {
    expect(batteryVoltage(400, 10)).toBeCloseTo(388, 1);
  });
  test('90% → 1.00 × nominal (upper knee)', () => {
    expect(batteryVoltage(400, 90)).toBeCloseTo(400, 1);
  });
  test('plateau is roughly flat between 10–90%', () => {
    const v20 = batteryVoltage(400, 20);
    const v50 = batteryVoltage(400, 50);
    const v80 = batteryVoltage(400, 80);
    // within ~3% across the plateau
    expect(Math.abs(v50 - v20)).toBeLessThan(12);
    expect(Math.abs(v80 - v50)).toBeLessThan(12);
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
  test('4 banks (D disabled by default), all within 300–500V and 10–20 kWh', () => {
    expect(CONST.banks).toHaveLength(4);
    CONST.banks.forEach(b => {
      expect(b.nominalV).toBeGreaterThanOrEqual(300);
      expect(b.nominalV).toBeLessThanOrEqual(500);
      expect(b.kwh).toBeGreaterThanOrEqual(10);
      expect(b.kwh).toBeLessThanOrEqual(20);
    });
    // bank D is the disabled expansion slot
    expect(CONST.banks[3].id).toBe('D');
    expect(CONST.banks[3].enabled).toBe(false);
  });
  test('PARTS has all component types', () => {
    ['mppt','bank','dcdc','acdc','dcac3','dcac1','dcbus','trunk','acpanel'].forEach(k => {
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
  const m = DEFAULT_CONFIG.mppts[0];   // enabled, 20 panels, 400W STC
  test('scales linearly with irradiance', () => {
    const p1000 = mpptPowerKW(m, 1000);
    const p500  = mpptPowerKW(m, 500);
    const p250  = mpptPowerKW(m, 250);
    expect(p1000).toBeCloseTo(7.76, 2);
    expect(p500).toBeCloseTo(p1000 / 2, 2);
    expect(p250).toBeCloseTo(p1000 / 4, 2);
  });
  test('0 at night (irradiance=0)', () => {
    expect(mpptPowerKW(m, 0)).toBe(0);
  });
  test('disabled MPPT → 0', () => {
    const disabled = DEFAULT_CONFIG.mppts[3];   // mppt4 enabled:false
    expect(disabled.enabled).toBe(false);
    expect(mpptPowerKW(disabled, 1000)).toBe(0);
    expect(mpptPowerKW(disabled, 0)).toBe(0);
  });
  test('at 1000 W/m² = wattSTC * panels * efficiency / 1000', () => {
    const expected = m.wattSTC * m.panels * CONST.mpptEfficiency / 1000;
    expect(mpptPowerKW(m, 1000)).toBeCloseTo(expected, 2);
  });
  test('never negative', () => {
    expect(mpptPowerKW(m, -100)).toBeGreaterThanOrEqual(0);
  });
});

describe('mpptVmp', () => {
  const m = DEFAULT_CONFIG.mppts[0];   // vmpSTC 40, series 10 → nominal 400V
  test('equals vmpSTC * series at 1000 W/m²', () => {
    expect(mpptVmp(m, 1000)).toBeCloseTo(m.vmpSTC * m.series, 1);   // 400
  });
  test('droops at low irradiance (below nominal)', () => {
    const vFull = mpptVmp(m, 1000);
    const vLow  = mpptVmp(m, 200);
    expect(vLow).toBeLessThan(vFull);
    expect(vLow).toBeGreaterThan(vFull * 0.85);   // never below 0.85× nominal
  });
  test('factor formula at 200 W/m² → 0.88× nominal', () => {
    expect(mpptVmp(m, 200)).toBeCloseTo(m.vmpSTC * m.series * 0.88, 1);   // 352
  });
  test('at 0 irradiance → 0.85× nominal (floor of the droop factor)', () => {
    expect(mpptVmp(m, 0)).toBeCloseTo(m.vmpSTC * m.series * 0.85, 1);     // 340
  });
});

describe('totalSolarKW', () => {
  test('sums enabled MPPTs, ignores disabled', () => {
    const t = totalSolarKW(DEFAULT_CONFIG, 1000);
    const enabled = DEFAULT_CONFIG.mppts.filter(m => m.enabled !== false);
    const expected = enabled.reduce((s, m) => s + mpptPowerKW(m, 1000), 0);
    expect(t).toBeCloseTo(expected, 2);
    // 3 enabled × 7.76 kW = 23.28 kW; disabled mppt4 contributes 0
    expect(t).toBeCloseTo(23.28, 2);
  });
  test('0 at night', () => {
    expect(totalSolarKW(DEFAULT_CONFIG, 0)).toBe(0);
  });
  test('overcast (~15% irradiance) reduces total to ~15%', () => {
    const clear = totalSolarKW(DEFAULT_CONFIG, 1000);
    const cloud = totalSolarKW(DEFAULT_CONFIG, 150);   // 1000 * 0.15
    expect(cloud).toBeCloseTo(clear * 0.15, 1);
  });
  test('empty/missing config → 0', () => {
    expect(totalSolarKW({}, 1000)).toBe(0);
    expect(totalSolarKW(undefined, 1000)).toBe(0);
  });
});

/* ============================ Session 1: DEFAULT_CONFIG sanity ============================ */

describe('DEFAULT_CONFIG', () => {
  test('4 MPPTs, mppt4 disabled by default', () => {
    expect(DEFAULT_CONFIG.mppts).toHaveLength(4);
    expect(DEFAULT_CONFIG.mppts[3].enabled).toBe(false);
    DEFAULT_CONFIG.mppts.slice(0, 3).forEach(m => {
      expect(m.enabled).toBe(true);
      expect(m.series * m.parallel).toBe(m.panels);
    });
  });
  test('4 banks, bank D disabled by default', () => {
    expect(DEFAULT_CONFIG.banks).toHaveLength(4);
    expect(DEFAULT_CONFIG.banks[3].id).toBe('D');
    expect(DEFAULT_CONFIG.banks[3].enabled).toBe(false);
    DEFAULT_CONFIG.banks.slice(0, 3).forEach(b => {
      expect(b.enabled).toBe(true);
      expect(b.nominalV).toBeGreaterThanOrEqual(300);
      expect(b.nominalV).toBeLessThanOrEqual(500);
      expect(b.kwh).toBeGreaterThanOrEqual(10);
      expect(b.kwh).toBeLessThanOrEqual(20);
      expect(b.soc).toBeGreaterThanOrEqual(0);
      expect(b.soc).toBeLessThanOrEqual(100);
    });
  });
  test('sim solar constants present on CONST', () => {
    expect(CONST.irradiancePeak).toBe(1000);
    expect(CONST.overcastFactor).toBeCloseTo(0.15, 2);
    expect(CONST.mpptEfficiency).toBeCloseTo(0.97, 2);
    expect(CONST.sunrise).toBe(6);
    expect(CONST.sunset).toBe(18);
  });
});

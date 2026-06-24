# PLAN: Full Intra-Day Simulation

Adds a continuous, time-driven simulation to the existing modular DC-bus
visualization. Time advances automatically; the user can scrub the day/night
slider, toggle overcast, and adjust load in real time. Batteries charge and
discharge with realistic CC/CV curves; solar output follows an equatorial
equinox irradiance curve.

This plan is split into **3 sessions** (see §14). Each session is
self-contained: it ends with `bun test` green and leaves the app in a
working (if incomplete) state.

---

## 1. Scope & Non-Goals

**In scope:**
- Continuous time advancement (~2s real = 1h simulated; 1 day ≈ 48s).
- Equatorial-equinox solar irradiance: simple sine, 6:00–18:00, peak at noon.
- Per-MPPT configurable panels (W, Vmp, Voc, count, series/parallel, tilt orientation).
- Per-battery configurable banks (nominalV, kWh, maxChargeA, maxDischargeA, enable/disable), 4 banks (A/B/C/D).
- CC/CV battery charging with current taper near full; realistic LiFePO4-style SoC↔voltage curve.
- DC bus voltage computed live from the regime (surplus/discharge/grid/idle).
- Overcast binary toggle (heavy cloud, ~15% of clear-sky irradiance).
- Day/night slider auto-advances, user-draggable to scrub.
- Load sliders (3 trunks: delta/wye/1φ) adjusted live during simulation.
- Persistence of SoC + config + sim state to localStorage (survives reload).
- Config panel UI to edit each MPPT's panels and each bank's specs.

**Non-goals:**
- No temperature model (irradiance-only).
- No equipment degradation over time.
- No dynamic MPPT/battery count (fixed 4 + 4; each enable/disable only).
- No multi-day weather patterns (single binary overcast).
- No grid outages / generator (grid always available at 230V 1φ 60Hz).

---

## 2. Background — What This System Models

(Read `README.md` first for project goals. This section bridges README → plan.)

The page visualizes a **modular solar+battery electrical system** for a
medium property. The core architectural idea: all generation (solar MPPTs),
all storage (battery banks via bidirectional DC-DC converters), and the grid
(AC-DC charger) feed a **single common ~400V DC bus**. Three separate
grid-forming DC-AC converters draw from that bus to power three AC trunks:
a 230V 3-phase delta trunk, a 400V 3-phase wye trunk, and a 230V 1-phase
trunk. The existing 12-wire property trunk carries all three AC services
downstream.

**Why a DC bus?** DC has no phases, so the phase-balancing problem (uneven
1-phase loads stressing a 3-phase inverter) disappears by construction. Each
DC-AC converter sees only its own balanced load.

**Why per-bank DC-DC converters?** Each battery bank has its own
bidirectional DC-DC converter that enforces that bank's charge/discharge
profile. This lets banks of different voltages, ages, and chemistries share
one bus without overcharging each other or "fighting."

**How is priority coordinated?** The DC bus *voltage* is the coordination
signal. Each source converter has a voltage setpoint band:
- Solar MPPT holds the bus high (~420V) when producing.
- Batteries charge when bus ≥ 410V; discharge when bus ≤ 390V.
- Grid AC-DC charger engages at 380V (below the charge band — so the grid
  can never charge the batteries).

Because the bands don't overlap, the rules "solar first, then batteries,
then grid" and "grid never charges batteries" and "banks never cross-charge"
fall out of the setpoints automatically — no central scheduler.

This plan adds a **time-driven simulation** so you can watch these dynamics
play out over a simulated day instead of dragging sliders manually.

---

## 3. Current State of the Code

The app currently (`electrical-buildout/`) has:
- `model.js` — pure electrical model with `computeState({solarTotal, load, soc})`
  returning regime/busV/per-bank state. 42 passing tests in `test/model.test.js`.
  Banks are currently 3 (A/B/C); this plan extends to 4 (A/B/C/D).
- `render.js` — SVG rendering: static boxes + dynamic animated flow lines
  with voltage labels and charge/discharge direction reversal.
- `main.js` — wires 7 sliders (solar, 3 loads, 3 SoCs) to model→render.
- `index.html` — scaffold with sliders + SVG + side panel.

The current model is **slider-driven** (user sets solar kW and SoC directly).
This plan replaces that with a **simulation-driven** model where solar comes
from the clock + irradiance, and SoC mutates over time via charge/discharge.

Key existing functions to preserve (used by existing tests):
`batteryVoltage`, `batteryMode`, `solarSplit`, `loadPerTrunk`, `computeState`.
New sim functions are *additive* — they reuse these as building blocks.

---

## 4. File Structure (target)

```
electrical-buildout/
  index.html              # scaffold + sliders + config modal + overcast toggle
  model.js                # pure electrical model (existing, extended)
  render.js               # SVG rendering (existing, extended for SoC/time display)
  main.js                 # simulation loop + slider wiring (rewritten in Session 3)
  config.js               # default panel/battery config (new, Session 1)
  test/model.test.js      # existing tests + new sim tests (sessions 1 & 2)
  README.md               # project goals (new)
  PLAN.md                 # this file
```

`config.js` holds only default configuration — no logic. Easy to tweak
defaults without touching model/render code.

---

## 5. Configuration (`config.js`) — Session 1

A single exported `DEFAULT_CONFIG` object. Persisted to localStorage on first
load; subsequent loads read from localStorage and fall back to
`DEFAULT_CONFIG` if absent/corrupt.

```js
export const DEFAULT_CONFIG = {
  mppts: [
    { id:'mppt1', enabled:true,  panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{azimuth:180, tilt:15} },
    { id:'mppt2', enabled:true,  panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{azimuth:180, tilt:15} },
    { id:'mppt3', enabled:true,  panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{azimuth:180, tilt:15} },
    { id:'mppt4', enabled:false, panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{azimuth:180, tilt:15} },
  ],
  banks: [
    { id:'A', enabled:true, nominalV:350, kwh:15, maxChargeA:30, maxDischargeA:45, soc:50 },
    { id:'B', enabled:true, nominalV:400, kwh:20, maxChargeA:35, maxDischargeA:50, soc:50 },
    { id:'C', enabled:true, nominalV:480, kwh:10, maxChargeA:20, maxDischargeA:30, soc:50 },
    { id:'D', enabled:false,nominalV:400, kwh:15, maxChargeA:30, maxDischargeA:45, soc:50 },
  ],
};
```

**Field meanings:**
- `panels`, `series`, `parallel`: array topology (must satisfy series×parallel=panels).
- `wattSTC`: per-panel wattage at Standard Test Conditions (1000 W/m², 25°C).
- `vmpSTC`, `vocSTC`: per-panel max-power voltage / open-circuit voltage at STC.
- `nominalV`: bank nominal DC voltage (≈ rest voltage at SoC=50%).
- `kwh`: usable energy capacity.
- `maxChargeA` / `maxDischargeA`: per-bank current limits at the *battery port*
  (the DC-DC converter translates these to bus-side kW via `A × nominalV / 1000`).
- `soc`: starting SoC (%) on first load; persisted thereafter.
- `enabled`: if false, that MPPT/bank is grayed out and produces/consumes nothing.
- `orientation`: accepted but equatorial-equinox sim treats all arrays as
  south-facing @ optimal tilt → uniform sine curve. Kept for future
  extensibility; not used in this plan's math.

**Config modal UI** (built in Session 3): a form listing each MPPT and bank
with editable fields. On save: validates (series×parallel=panels, nominalV in
300–500, kwh 10–20, etc.), writes to localStorage, and hot-reloads the
simulation with the new config without restarting the clock.

---

## 6. Solar Model (`model.js` additions) — Session 1

### 6.1 Irradiance (equatorial equinox)
```
hourOfDay ∈ [0, 24)
if hourOfDay < 6 || hourOfDay > 18:
  irradiance = 0                            // night
else:
  sunAngle = (hourOfDay - 12) / 6           // -1 at 6am, 0 at noon, +1 at 6pm
  irradiance = 1000 * cos(sunAngle * π/2)   // W/m², peaks 1000 at noon, 0 at 6/18
```
Overcast toggle multiplies irradiance by `0.15` (heavy cloud).

Export as `computeIrradiance(hourOfDay, overcast=false)`.

### 6.2 Per-MPPT power
At STC (1000 W/m²) a panel produces `wattSTC` at `vmpSTC`. Off-STC, output
scales approximately linearly with irradiance below 1000 W/m² (standard
approximation; no temperature derate per scope):
```
perPanelW = wattSTC * (irradiance / 1000)
mpptPowerW = perPanelW * panels * efficiencyFactor
```
where `efficiencyFactor ≈ 0.97` (MPPT conversion + wiring loss, fixed constant).

`mpptPowerKW = mpptPowerW / 1000`

Export as `mpptPowerKW(mpptConfig, irradiance)`.

### 6.3 Per-MPPT voltage (for display on the panel→MPPT line)
Panel voltage is weakly dependent on irradiance (Vmp drops slightly at low
irradiance). Standard approximation:
```
vmp = vmpSTC * series * (0.85 + 0.15 * (irradiance/1000))
```
At full sun (1000 W/m²): `vmp ≈ vmpSTC × series` (nominal).
At 200 W/m²: `vmp ≈ vmpSTC × series × 0.88` (slight droop).
Displayed as the "~Vmp" label on the diagram, now dynamic.

Export as `mpptVmp(mpptConfig, irradiance)`.

### 6.4 Total solar
`totalSolarKW = sum of enabled MPPTs' mpptPowerKW`

Helper: `totalSolarKW(config, irradiance)`.

### 6.5 Constants to add to `CONST`
```
irradiancePeak: 1000,     // W/m² at STC
overcastFactor: 0.15,
mpptEfficiency: 0.97,
sunrise: 6, sunset: 18,   // hours
```

---

## 7. Battery Model (`model.js` additions) — Session 2

### 7.1 SoC ↔ Voltage (LiFePO4-style plateau)
Replace the current plateau function with one parameterized by `nominalV`,
using a typical LiFePO4 discharge curve shape (flat 10–90%, droop at ends):

```
SoC%    Voltage factor (× nominalV)
 0%     0.88   (deep discharge cutoff)
10%     0.95   (lower knee)
90%     1.03   (upper knee)
100%    1.10   (full charge ceiling)
```
Linear interpolation between these breakpoints. Plateau 10–90% sits at
~0.95–1.03 × nominalV (≈flat). This is the *rest* voltage; under charge the
terminal voltage is held at the CV setpoint (see 7.3).

Update existing `batteryVoltage(nominalV, soc)` to use these new breakpoints
(0.88/0.95/1.03/1.10 instead of current 0.90/0.97/1.00/1.10). Existing tests
that assert the old breakpoints must be updated to match.

### 7.2 Discharge
When regime demands discharge from a bank:
```
dischargeKW = min(bankShare, maxDischargeKW)
maxDischargeKW = maxDischargeA * nominalV / 1000
```
`bankShare` allocated proportionally to each enabled bank's `maxDischargeKW`
(as in current model). SoC decreases over the timestep:
```
deltaSoC = (dischargeKW * dtHours) / kwh * 100
```

### 7.3 Charge — CC/CV with taper
Charging is the key new behavior. When a bank is charging:

**Phase 1 — Constant Current (CC):** while bank voltage < CV setpoint
(CV setpoint = 1.10 × nominalV, the full-charge voltage). In practice this
means SoC < 90% (the upper knee where voltage reaches CV setpoint):
```
chargeKW = min(bankShare, maxChargeKW)
maxChargeKW = maxChargeA * nominalV / 1000
```
SoC rises linearly with the charge current.

**Phase 2 — Constant Voltage (CV):** once SoC ≥ 90% (upper knee), hold
voltage constant and taper current:
```
taperFactor = (100 - SoC) / (100 - 90)     // 1.0 at 90%, → 0 at 100%
chargeKW = maxChargeKW * taperFactor
```
Current drops toward zero as SoC→100%. Bank reaches 100% → mode flips to
`idle` (cannot charge).

The transition from CC→CV happens automatically at the SoC knee (90%), since
the voltage curve crosses the CV setpoint there. This produces the
characteristic charge slowdown near full.

**Important:** the existing `batteryMode(busV, soc)` already returns
`'charge'` when `busV >= Vcharge` and `soc < 100`. The CC/CV distinction is
purely about *how much* current flows — it's computed inside the per-bank kW
allocation, not a new mode. `batteryMode` still returns just `charge`.

### 7.4 Per-timestep update
`stepBatteries(state, dtHours)` mutates each enabled bank's SoC based on the
computed per-bank kW (which already encodes CC vs CV):
- charge: add `chargeKW * dtHours / kwh * 100` to SoC (capped at 100).
- discharge: subtract `dischargeKW * dtHours / kwh * 100` (floored at 0).
- idle: no change.

Returns the updated `perBank` array with new SoC, voltage, mode, kW. This is
the function the simulation loop calls every frame.

### 7.5 Constants to add to `CONST`
```
cvKneeSoC: 90,            // % — CC→CV transition
cvSetpointFactor: 1.10,   // × nominalV — full-charge voltage
```

---

## 8. Regime & Bus Voltage (`model.js`) — Session 2

Existing regime logic in `computeState` is preserved. Add a sim-oriented
variant `computeStateSim({ solarTotalKW, loads, banks, config })` that takes
**live SoC** (mutated each tick by `stepBatteries`) and the config object,
returning `{ regime, busV, chargeKW, dischargeKW, gridKW, perBank[] }`.

- **Surplus** (solar > load): bus 410–425V; enabled banks with SoC<100 charge (CC/CV).
- **Discharge** (solar < load, batteries cover): bus 390V; enabled banks with SoC>0 discharge.
- **Grid** (batteries insufficient): bus 380V; grid tops up, batteries discharge what they can alongside (co-engagement).
- **Idle** (solar=0, load=0): bus 400V; banks idle.

`computeStateSim` differs from `computeState` in that:
- It reads SoC from `banks[i].soc` (live, mutated) instead of a `soc` input array.
- It respects each bank's `enabled` flag (disabled banks contribute 0, stay idle).
- It applies CC/CV per-bank charge kW allocation (7.3) instead of proportional-only.

**Guarantees preserved** (existing tests cover these for `computeState`; new
tests cover them for `computeStateSim`):
- gridKW>0 ⇒ no bank charges.
- No two banks in opposite modes.
- SoC=0 ⇒ no discharge; SoC=100 ⇒ no charge.
- Per-bank rate limits enforced (maxChargeA/maxDischargeA).

---

## 9. Time & Simulation Loop (`main.js`) — Session 3

### 9.1 Clock
- `simHour`: float in [0, 24). Starts at 0 (midnight) on first load; persisted.
- `dt`: each animation frame, real elapsed ms → simulated hours via
  `1 hour = 2000 ms` → `dtHours = realMs / 2000`.
- Loop via `requestAnimationFrame`; clamp dt to [0, 0.5] to avoid huge jumps
  on tab refocus (max 0.5 sim-hours per frame).

### 9.2 Per-frame step
```
1. dtHours = clamp((now - lastFrame) / 2000, 0, 0.5)
2. simHour = (simHour + dtHours) % 24
3. irradiance = computeIrradiance(simHour, overcast)
4. solarTotalKW = totalSolarKW(config, irradiance)
5. loads = read from load sliders (delta/wye/one)
6. state = computeStateSim({ solarTotalKW, loads, banks, config })
7. banks = stepBatteries(state, dtHours)   // mutates SoC in banks[]
8. persist simHour + bank SoCs + loads + overcast to localStorage (throttled ~1s real)
9. render(state) + update clock/SoC labels
```

### 9.3 Day/night slider
- Range 0–24, step 0.1, bound to `simHour`.
- Auto-advances each frame (slider thumb visibly moves).
- User can grab and drag — on `input`, set `simHour` directly (scrubbing);
  normal auto-advance resumes on release (`pointerup`).
- Label shows formatted time (e.g. "14:30 · daytime" / "21:00 · night").

### 9.4 Overcast toggle
- Checkbox/button in the controls bar.
- On: `overcast=true` passed to `computeIrradiance` (×0.15). Off: ×1.0.
- Effect is immediate (next frame).

### 9.5 Load sliders
- Unchanged from current (3 sliders: delta/wye/1φ).
- Adjustments apply instantly to the next sim step.
- Persisted to localStorage so reload keeps last load settings.

### 9.6 Persistence
- localStorage keys: `eb_config`, `eb_soc`, `eb_simHour`, `eb_loads`, `eb_overcast`.
- SoC persisted as array `[A,B,C,D]` per enabled bank.
- On load: read localStorage → fall back to `DEFAULT_CONFIG` / 50% SoC / midnight / no load / not overcast.
- Write throttled to once per real second (avoid storage thrash).

---

## 10. Rendering (`render.js` additions) — Session 3

### 10.1 Existing boxes
- 4 MPPT slots, 4 battery slots (D added). Disabled ones grayed out + "disabled" label.
- Battery boxes show live SoC% + voltage (updates each frame).

### 10.2 New/changed labels
- **Solar panel→MPPT line**: dynamic "~Vmp" replaced with computed `mpptVmp`V (e.g. "398V").
- **MPPT→bus line**: shows `mpptPowerKW` kW (dynamic, scales with irradiance).
- **Battery→DC-DC line**: shows `vBat`V + kW + arrow direction (charge/discharge) — already exists, now SoC-driven.
- **Bus center**: live `busV`V + regime label — already exists.
- **Clock display**: top of controls bar, "Day · 14:30 · ☀" / "Day · 22:00 · 🌙".

### 10.3 SoC gauge on each battery box
Small horizontal bar inside each bank box showing SoC fill (0–100%), colored:
- green >50%, amber 20–50%, red <20%.
Gives at-a-glance bank state without reading numbers.

### 10.4 Disabled component rendering
Disabled MPPTs/banks: `node-off` class + a small "disabled" tag. Skeleton
lines to them remain dim. No dynamic flows drawn.

---

## 11. UI Layout (`index.html`) — Session 3

### 11.1 Controls bar (top)
- **Clock + day/night slider** (auto-advancing, scrubable) — leftmost.
- **Overcast toggle** button.
- **Config** button (opens modal).
- **Load sliders** (3: delta/wye/1φ) — unchanged.
- **Solar slider removed** — solar is now simulation-driven, not user-set.

### 11.2 Config modal
- Overlay panel with two sections: MPPTs (4) and Banks (4).
- Each row: enable/disable checkbox + spec fields.
- Save / Cancel / Reset-to-defaults buttons.
- Validation errors shown inline (e.g. "series × parallel ≠ panels").

### 11.3 Side panel (right)
- Replaces current "System state" with live **simulation state**:
  - Sim time, day phase (dawn/day/dusk/night), overcast status.
  - Solar total kW (sum) + per-MPPT breakdown.
  - Per-bank: SoC%, voltage, mode (CHG/DIS/IDLE), kW.
  - Grid kW (or "off").
  - Load total + per-trunk.
- Updates each frame.

---

## 12. Tests (`test/model.test.js` additions) — Sessions 1 & 2

Existing 42 tests remain (some breakpoint values updated for the new voltage
curve per §7.1). New tests added per session.

### Session 1 tests (solar model)
- `computeIrradiance(0)` = 0 (midnight); `(6)` = 0 (dawn); `(12)` ≈ 1000 (noon); `(18)` = 0 (dusk); `(22)` = 0.
- `computeIrradiance` is 0 outside [6,18], positive inside, monotonic up to noon then down.
- `computeIrradiance(h, true)` = `computeIrradiance(h, false) * 0.15`.
- `mpptPowerKW` scales linearly with irradiance; 0 at night (irradiance=0).
- `mpptPowerKW` for disabled MPPT = 0.
- `mpptPowerKW` at 1000 W/m² = `wattSTC * panels * 0.97 / 1000`.
- `mpptVmp` droops slightly at low irradiance; equals `vmpSTC * series` at 1000 W/m².
- `totalSolarKW` sums enabled MPPTs; ignores disabled.

### Session 2 tests (battery CC/CV + regime)
- CC phase: chargeKW = maxChargeKW while SoC < 90%.
- CV phase (SoC ≥ 90%): chargeKW tapers toward 0 as SoC→100.
- At SoC=100: mode=idle, chargeKW=0.
- `stepBatteries` with discharge reduces SoC by `dischargeKW×dt/kwh×100`.
- `stepBatteries` with charge increases SoC, capped at 100.
- SoC never goes below 0 or above 100 after a step.
- Disabled bank: SoC unchanged, mode=idle, kW=0.
- maxChargeA/maxDischargeA enforced (chargeKW ≤ maxChargeA×nominalV/1000).
- `computeStateSim` preserves all guarantees (grid⇒no charge, no opposite modes, SoC limits).
- Grid+battery co-engagement when batteries insufficient.
- Surplus with all banks full → no charge, surplus spilled (bus high, no sink).

### Session 2 integration tests (multi-step)
- Start at midnight, SoC 50%, no load: banks idle all night, SoC unchanged, bus 400V.
- Start at noon, full sun, no load, SoC 50%: banks charge, SoC rises, tapers near 100.
- Overcast noon + load exceeding solar: batteries discharge, then grid engages when depleted.
- Scrub clock from 6am→6pm with moderate load: SoC dips morning, recovers midday, dips evening.

---

## 13. Acceptance Criteria (whole project)

1. On page load: simulation starts at midnight (or persisted time), runs indefinitely, 1 day ≈ 48s.
2. Day/night slider auto-advances; user can scrub; auto-advance resumes after release.
3. Solar output follows sine curve 6am–6pm; 0 at night; peaks at noon.
4. Overcast toggle cuts solar to ~15% immediately; untoggling restores.
5. Batteries charge with CC/CV: full current until ~90% SoC, then taper to 100%.
6. Batteries discharge when solar < load; stop at SoC=0.
7. Grid engages when batteries can't cover; co-discharges with batteries.
8. DC bus voltage visibly moves between bands (420 surplus / 390 discharge / 380 grid / 400 idle) as conditions change.
9. Config modal edits MPPT/bank specs; changes apply hot (no restart); persisted to localStorage.
10. Disabled MPPTs/banks are grayed and inactive.
11. Reloading the page restores SoC, config, load settings, and sim time.
12. All existing + new tests pass via `bun test`.
13. No external dependencies added.

---

## 14. Session Split

Three sessions. Each ends with `bun test` green. Sessions 1 and 2 are pure
model work (no DOM); session 3 is the UI/simulation-loop layer built on the
stable model from sessions 1–2.

### Session 1 — Solar model + config foundation

**Goal:** Solar production becomes simulation-ready (clock-driven) instead of
slider-driven. Config file created. No UI changes yet — the app still runs
the old slider UI, but the solar model functions exist and are tested.

**Deliverables:**
1. Create `config.js` with `DEFAULT_CONFIG` (4 MPPTs, 4 banks, D disabled).
2. Add to `CONST` in `model.js`: `irradiancePeak`, `overcastFactor`,
   `mpptEfficiency`, `sunrise`, `sunset`, and extend `banks` array from 3 → 4
   (add bank D, disabled by default).
3. Add to `model.js`: `computeIrradiance(hourOfDay, overcast)`,
   `mpptPowerKW(mpptConfig, irradiance)`, `mpptVmp(mpptConfig, irradiance)`,
   `totalSolarKW(config, irradiance)`.
4. Update `test/model.test.js`: add Session 1 solar tests (§12). Update the
   bank-count test to expect 4 banks. Do **not** change existing regime
   tests — `computeState` still works with 3 banks (bank D disabled).
5. Run `bun test` — all green.

**Out of scope for Session 1:** battery CC/CV, `stepBatteries`,
`computeStateSim`, any UI/main.js/render.js changes, localStorage.

**Why this boundary:** Pure functions, no DOM, fully testable in isolation.
The solar model is the simplest new subsystem and has no dependencies on the
battery work. Ends with a clean, green test suite.

---

### Session 2 — Battery CC/CV + simulation regime + step function

**Goal:** Batteries gain realistic charge/discharge dynamics over time. The
regime logic adapts to live SoC and per-bank config. Still no UI — the model
functions exist and are tested, including multi-step integration.

**Deliverables:**
1. Update `batteryVoltage` in `model.js` to the new LiFePO4 breakpoints
   (0.88/0.95/1.03/1.10). Update existing voltage tests to match.
2. Add to `CONST`: `cvKneeSoC` (90), `cvSetpointFactor` (1.10).
3. Add to `model.js`: `stepBatteries(state, dtHours)` — mutates SoC per §7.4,
   applying CC/CV charge allocation per §7.3.
4. Add to `model.js`: `computeStateSim({solarTotalKW, loads, banks, config})`
   per §8 — respects `enabled` flags, live SoC, CC/CV allocation.
5. Update `test/model.test.js`: add Session 2 tests (§12) — CC/CV, step
   function, `computeStateSim` guarantees, multi-step integration.
6. Run `bun test` — all green.

**Out of scope for Session 2:** any UI/main.js/render.js/index.html changes,
localStorage, the simulation clock loop.

**Why this boundary:** The CC/CV transition + per-timestep SoC mutation is
the trickiest logic in the project (the knee transition, current taper math,
ensuring the voltage curve crosses the CV setpoint exactly at the knee).
Pairing it with UI work would split focus. This session keeps the model
pure and fully tested before any DOM wiring begins.

**Risk note:** If CC/CV surfaces unexpected issues, this session may itself
split (CC/CV as one sub-session, `stepBatteries` + integration as another).
Flag mid-session rather than committing to it now.

---

### Session 3 — Simulation loop + UI + persistence + rendering

**Goal:** Wire the model from sessions 1–2 into a live, time-driven
simulation with full UI. The app transforms from slider-driven to
clock-driven.

**Deliverables:**
1. Rewrite `main.js`: `requestAnimationFrame` clock loop (§9), replacing the
   slider-driven `update()`. Remove solar slider; add day/night slider,
   overcast toggle, config button.
2. Add localStorage persistence (§9.6): load on startup, throttled save
   each frame for `simHour`/SoC/loads/overcast/config.
3. Extend `render.js` (§10): 4th battery slot + DC-DC, SoC fill bars in bank
   boxes, dynamic `mpptVmp` labels, disabled-component rendering, clock display.
4. Restructure `index.html` (§11): new controls bar (clock slider, overcast,
   config, 3 load sliders), config modal markup, 4th battery slot in SVG
   scaffold, live simulation-state side panel.
5. Wire config modal: open/close, edit fields, validate, save to localStorage,
   hot-reload sim without restarting clock.
6. Manual verification against acceptance criteria §13 (1–11). Run `bun test`
   to confirm no model regressions (model.js untouched this session).

**Out of scope for Session 3:** any model.js logic changes (model is frozen
from session 2), new electrical behaviors.

**Why this boundary:** All DOM/timing/glue work. With sessions 1–2 solid and
green, this layer is mostly wiring + visual polish on a stable model
foundation. If the model is correct, UI bugs here are cosmetic, not
electrical — much safer to iterate on.

---

## 15. Migration Summary (per file, per session)

| File | Session 1 | Session 2 | Session 3 |
|---|---|---|---|
| `config.js` | **create** | — | — |
| `model.js` | +solar funcs, +bank D, +CONST sim consts | +CC/CV, +stepBatteries, +computeStateSim, update batteryVoltage | (frozen) |
| `test/model.test.js` | +solar tests, update bank count | +CC/CV/step/sim tests, update voltage breakpoints | — |
| `render.js` | — | — | +4th slot, +SoC bars, +dynamic Vmp, +disabled rendering |
| `main.js` | — | — | **rewrite** (sim loop, persistence, config wiring) |
| `index.html` | — | — | restructure controls, +config modal, +4th slot |

---

## 16. Open Items (deferred, noted for future)

- Temperature model (explicitly out of scope now).
- Multi-day weather patterns (only binary overcast).
- Generator / grid outage simulation.
- Dynamic MPPT/battery count (fixed at 4+4).
- Real-world latitude/day-length variation (equatorial equinox only).
- Panel orientation effects (all arrays treated as south-facing optimal; `orientation` field stored but unused).

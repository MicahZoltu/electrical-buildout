# Electrical Buildout — Solar + Battery DC Bus Coupling

This project visualizes a proposed modular electrical system for a medium-sized property with a mix of 3-phase and 1-phase loads. The goal is to illustrate how a **common DC bus** architecture solves problems that are inherently difficult on the AC side — particularly phase balancing with uneven, bursty single-phase loads.

## What it shows

An interactive diagram of a solar + battery + grid system where every component is a discrete, swappable module:

- **Solar panels** feed the bus through individual **MPPT charge controllers** (one per sub-array), so panels of different ages, orientations, or shade profiles don't drag each other down.
- **Battery banks** each connect to the bus through their own **bidirectional DC-DC converter**, which enforces that bank's charge/discharge profile. This lets banks of different voltages, ages, and chemistries share one bus without overcharging each other or "fighting."
- The **grid** feeds the bus through a programmable **AC-DC charger**.
- Three **grid-forming DC-AC converters** draw from the bus to power three separate AC trunks: a 230V 3-phase delta trunk, a 400V 3-phase wye trunk, and a 230V 1-phase trunk.

## Why this architecture

The core insight: **DC has no phases.** By making the main trunk a common ~400V DC bus and placing separate converters for each AC load type on that bus, the phase-balancing problem disappears by construction rather than by compensation. The 3-phase converters only see balanced 3-phase loads; the 1-phase converter only sees 1-phase loads; neither is aware of the other.

## Design constraints addressed

- **Independent batteries** — each bank has its own DC-DC converter, so a weak or aging bank can't drag down a healthy one. Banks can be serviced or replaced without shutting down the system.
- **Shared bus** — all sources (solar, batteries, grid) and all sinks (the DC-AC converters) connect to one regulated DC rail. Coordination happens via voltage setpoints, not a central scheduler.
- **Replaceable parts** — every function (MPPT, battery DC-DC, AC-DC charger, DC-AC converter) is its own discrete box. No hybrid all-in-one inverters; a failed component is a box-swap, not a re-spec.
- **Easy expansion** — add a new battery bank later by installing one more DC-DC converter and connecting to the bus. Different voltage or chemistry is fine; the converter isolates it. Same story for adding solar: one more MPPT.

## How priority works

The DC bus voltage is the coordination signal. Each source converter has a voltage setpoint band:

- Solar holds the bus high (~420V) when producing.
- Batteries charge when the bus is ≥ 410V; discharge when ≤ 390V.
- The grid charger engages only at 380V — below the battery charge band, so the grid can never charge the batteries.

Because the bands don't overlap, "solar first, then batteries, then grid" and "batteries never cross-charge" fall out of the setpoints automatically.

## Running it

The app is static HTML/JS using ES modules, so it needs to be served over HTTP (not opened as a `file://` URL).  Any static file server will be sufficient, a very simple one is included if you have Bun:

```
bun server.mts
```

Then open the printed URL in a browser.

## Project layout

```
electrical-buildout/
  index.html        SVG scaffold + controls
  model.js          Pure electrical model (no DOM) — unit-tested
  render.js         SVG rendering from model state
  main.js           Wires controls to model to render
  config.js         Default panel/battery config (planned)
  test/model.test.js  bun:test suite — run with `bun test`
  README.md         This file
  PLAN.md           Detailed plan for the full simulation enhancement
```

The model is kept pure (no DOM access) so it can be unit-tested with `bun test` and iterated on independently of the rendering.

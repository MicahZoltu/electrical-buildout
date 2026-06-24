/* config.js — default panel/battery configuration. Pure data, no logic.
   Easy to tweak defaults without touching model/render code.

   Persisted to localStorage on first load (Session 3); edits here change the
   defaults for a fresh load only. Subsequent loads read from localStorage and
   fall back to DEFAULT_CONFIG if absent/corrupt.

   Note: `panels` is never stored — it's always derived as series × parallel
   on the fly by the model. `vmp`/`imp` are per-panel values at STC.
*/
export const DEFAULT_CONFIG = {
  mppts: [
    { id:'mppt1', enabled:true,  series:10, parallel:2, vmp:40, imp:14.1, orientation: { azimuth:180, tilt:15 } },
    { id:'mppt2', enabled:true,  series:10, parallel:2, vmp:40, imp:10.6, orientation: { azimuth:180, tilt:15 } },
    { id:'mppt3', enabled:true,  series:10, parallel:2, vmp:40, imp:10,   orientation: { azimuth:180, tilt:15 } },
    { id:'mppt4', enabled:false, series:10, parallel:2, vmp:40, imp:10,   orientation: { azimuth:180, tilt:15 } },
  ],
  banks: [
    { id:'A', enabled:true,  nominalV:350, kwh:20, maxChargeA:30,  maxDischargeA:15 },
    { id:'B', enabled:true,  nominalV:400, kwh:13, maxChargeA:100, maxDischargeA:50 },
    { id:'C', enabled:true,  nominalV:480, kwh:12, maxChargeA:20,  maxDischargeA:20 },
    { id:'D', enabled:false, nominalV:400, kwh:11, maxChargeA:30,  maxDischargeA:45 },
  ],
};

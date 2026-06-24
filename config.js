/* config.js — default panel/battery configuration. Pure data, no logic.
   Easy to tweak defaults without touching model/render code.

   Persisted to localStorage on first load (Session 3); edits here change the
   defaults for a fresh load only. Subsequent loads read from localStorage and
   fall back to DEFAULT_CONFIG if absent/corrupt.
*/
export const DEFAULT_CONFIG = {
  mppts: [
    { id:'mppt1', enabled:true,  panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{ azimuth:180, tilt:15 } },
    { id:'mppt2', enabled:true,  panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{ azimuth:180, tilt:15 } },
    { id:'mppt3', enabled:true,  panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{ azimuth:180, tilt:15 } },
    { id:'mppt4', enabled:false, panels:20, series:10, parallel:2,
      wattSTC:400, vmpSTC:40, vocSTC:48, orientation:{ azimuth:180, tilt:15 } },
  ],
  banks: [
    { id:'A', enabled:true,  nominalV:350, kwh:15, maxChargeA:30, maxDischargeA:45, soc:50 },
    { id:'B', enabled:true,  nominalV:400, kwh:20, maxChargeA:35, maxDischargeA:50, soc:50 },
    { id:'C', enabled:true,  nominalV:480, kwh:10, maxChargeA:20, maxDischargeA:30, soc:50 },
    { id:'D', enabled:false, nominalV:400, kwh:15, maxChargeA:30, maxDischargeA:45, soc:50 },
  ],
};

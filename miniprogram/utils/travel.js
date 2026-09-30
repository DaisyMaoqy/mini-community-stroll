// utils/travel.js —— 出行方式智能决策（PRD §4.5「出行方式智能决策」）
//
// 算法（严格对齐 PRD §4.5）：
//   d_walk  = 腾讯 walking API 实测步行距离（婴儿车步速 65 m/min → t_walk = d_walk/65）
//   t_bus   = 走到站 + 候车(~10min 高峰) + 车程 + 下车走（邨巴可达时）
//   若 d_walk ≤ WALK_MAX（600m，MVP 先验，待代表 OD 对 t_walk≈t_bus 交点回测）且 t_walk ≤ t_bus
//     → 主决策 = 步行（免费健康首选）
//   否则 → 主决策 = 邨巴
//
// 电动车（ebike）：仅当 t_ebike（250 m/min）明显更快且符合婴儿安全（§8.5）时，
//   以「可选替代」形式展示，不进入自动主决策。
//
// 本模块为纯函数，不依赖 wx / 云函数，便于单测；真实距离由调用方（route 云函数）提供，
// 传入 { walkM, walkMin, ebikeM, ebikeMin, bus:{ reachable, min } }。

const WALK_SPEED = 65;      // 婴儿车步速 m/min（PRD §4.5）
const WALK_MAX = 600;       // 步行阈值 m（MVP 先验）
const BUS_WAIT = 10;        // 邨巴候车 ~10min（高峰）
const EBIKE_SPEED = 250;    // 电动车 m/min（PRD §4.5）

// 步行分钟（婴儿车步速）；至少 1 分钟
function walkMinutes(m) {
  return Math.max(1, Math.round(m / WALK_SPEED));
}

// 邨巴总时长：走到站 + 候车 + 车程 + 下车走（车程按 250m/min 公交车速近似，MVP）
function busMinutes(walkToStation, rideM) {
  const ride = rideM != null && rideM > 0 ? rideM / 250 : 0;
  return Math.max(1, Math.round(walkToStation + BUS_WAIT + ride));
}

/**
 * 出行决策主函数。
 * @param {object} input
 *   - walkM   步行路线距离（米，腾讯 walking API；无则为 null）
 *   - ebikeM  电动车路线距离（米，腾讯 ebicycling API；无则为 null）
 *   - bus     邨巴信息 { reachable:boolean, walkToStationM:number, rideM:number, lineText:string, hubText:string }
 * @returns {object}
 *   { mode:'walk'|'bus', modeText:'步行'|'邨巴', min, distM,
 *     ebike:{ available:boolean, min, distM },          // 可选替代
 *     bus:{ reachable, min, text },                      // 邨巴详情（mode==='bus' 时填充）
 *     degraded:boolean }                                 // 是否降级（无路线数据，仅估算）
 */
function travelPlan(input) {
  const w = input && input.walkM;
  const e = input && input.ebikeM;
  const bus = (input && input.bus) || {};

  // 步行分钟
  const walkMin = w != null ? walkMinutes(w) : null;

  // 邨巴可达性 + 时长
  let busMin = null;
  if (bus.reachable && w != null) {
    const walkTo = bus.walkToStationM != null ? walkToStationMinutes(bus.walkToStationM) : 3;
    busMin = busMinutes(walkTo, bus.rideM);
  }

  // 主决策：步行 vs 邨巴
  let mode = 'walk';
  let min = walkMin;
  let distM = w;
  let degraded = w == null;

  if (w != null && bus.reachable && busMin != null) {
    // PRD §4.5：d_walk≤WALK_MAX 且 t_walk≤t_bus → 步行，否则邨巴
    if (w <= WALK_MAX && walkMin <= busMin) {
      mode = 'walk';
    } else {
      mode = 'bus';
      min = busMin;
      distM = w; // 展示仍用步行距离作参考（邨巴无实测车程时）
    }
  } else if (w == null) {
    // 无路线数据：不推荐邨巴，退回中性
    mode = 'walk';
    min = null;
    distM = null;
  }

  // 电动车可选替代（不进主决策）
  // 「明显更快」判据：比主决策快 ≥2 分钟（婴儿车步速下电动车天然快，须设显著阈值，
  // 否则任何距离都恒展示电动车胶囊，失去「可选替代」的意义，见 PRD §4.5）。
  let ebike = { available: false };
  if (e != null && e > 0) {
    const eMin = Math.max(1, Math.round(e / EBIKE_SPEED));
    const clearlyFaster = min != null ? min - eMin >= 2 : true;
    if (clearlyFaster) {
      ebike = { available: true, min: eMin, distM: e };
    }
  }

  const result = {
    mode,
    modeText: mode === 'walk' ? '步行' : '邨巴',
    min,
    distM,
    ebike,
    degraded,
  };
  if (bus.reachable) {
    result.bus = {
      reachable: true,
      min: busMin,
      text: bus.lineText || '',
      hub: bus.hubText || '',
    };
  }
  return result;
}

// 走到站分钟（婴儿车步速）
function walkToStationMinutes(m) {
  return Math.max(1, Math.round(m / WALK_SPEED));
}

module.exports = { travelPlan, walkMinutes, busMinutes, walkToStationMinutes, WALK_SPEED, WALK_MAX, BUS_WAIT, EBIKE_SPEED };

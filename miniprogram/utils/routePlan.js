// utils/routePlan.js —— 出行决策编排：板块坐标 → route 云函数 → travelPlan
//
// 供地图页 / 接种页复用。PRD §4.5：原点用「用户所选板块坐标」（非定位），
// 真实路线距离由 route 云函数（腾讯 walking/ebicycling）返回，降级时用 haversine 直线距离兜底。
const { callCloud } = require('./cloud.js');
const { blockCoord } = require('./blocks.js');
const { travelPlan, walkMinutes } = require('./travel.js');

// haversine 直线距离（route 云函数未配置/失败时的降级兜底）
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// 邨巴可达性：由 POI 的 bus 字段推断
//   bus.lines 非空 且 不含「交通中心换乘对外」类描述 → 邨巴直达可达
//   bus.lines 为空（如钟村，需换乘对外公交）→ 邨巴不可直达
function busReachable(spot) {
  const bus = spot && spot.bus;
  if (!bus) return false;
  // lines 为空 = 无邨巴直达（需换乘对外公交）
  if (!bus.lines) return false;
  return true;
}

// 构造邨巴信息（供 travelPlan）
function busInfo(spot) {
  const bus = (spot && spot.bus) || {};
  return {
    reachable: busReachable(spot),
    walkToStationM: null, // 走到站距离未知，travelPlan 用默认 3min
    rideM: null,          // 车程未知，travelPlan 用默认
    lineText: bus.busText || '',
    hubText: bus.hub || '',
  };
}

/**
 * 计算某 POI 的出行方案。
 * @param {string} blockName 用户所选板块名
 * @param {object} spot POI（含 coord.coordinates [lng,lat] 与 bus 字段）
 * @returns {Promise<object>} travelPlan 结果（含 mode/modeText/min/ebike/bus/degraded）
 */
async function planRoute(blockName, spot) {
  const from = blockCoord(blockName);
  return planRouteFrom(from, spot, blockName);
}

// 无板块名、直接用定位坐标作原点（定位回退）
async function planRouteBlockless(lat, lng, spot) {
  return planRouteFrom({ lat, lng, coordEstimated: false }, spot, '');
}

async function planRouteFrom(from, spot, blockName) {
  const coords = spot && spot.coord && spot.coord.coordinates;
  if (!coords || coords.length < 2) {
    return null;
  }
  const to = { lat: coords[1], lng: coords[0] };

  // 直线距离兜底（先算好，无论云函数成败都有底）
  const straight = haversine(from.lat, from.lng, to.lat, to.lng);

  let walkM = null;
  let ebikeM = null;
  let degraded = true;

  try {
    const r = await callCloud('route', { from: { lat: from.lat, lng: from.lng }, to: to });
    if (r && r.success && r.walk && r.walk.distance != null) {
      walkM = r.walk.distance;
    }
    if (r && r.success && r.ebike && r.ebike.distance != null) {
      ebikeM = r.ebike.distance;
    }
    degraded = !!(r && r.degraded);
  } catch (e) {
    // 云函数未部署/失败 → 降级直线距离
    walkM = null;
  }

  // 降级：用直线距离（×1.3 路径系数近似真实路线）
  if (walkM == null) {
    walkM = Math.round(straight * 1.3);
  }
  if (ebikeM == null) {
    ebikeM = Math.round(straight * 1.15);
  }

  const plan = travelPlan({
    walkM,
    ebikeM,
    bus: busInfo(spot),
  });
  plan.straightM = straight;
  plan.degraded = degraded || plan.degraded;
  plan.fromBlock = blockName;
  return plan;
}

module.exports = { planRoute, planRouteBlockless, haversine, busReachable, busInfo, walkMinutes };

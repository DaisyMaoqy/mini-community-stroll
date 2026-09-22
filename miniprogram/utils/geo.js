// utils/geo.js —— 地理计算纯函数（框架无关，便于单测）
// 与 pages/map 的距离口径保持一致：haversine(R=6371000) + 步行 ≈ 75m/min
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// 距离格式化：<1km 用米，否则一位小数公里
function fmtDist(m) {
  return m < 1000 ? m + ' m' : (m / 1000).toFixed(1) + ' km';
}

// 按距离推荐出行方式（与 PRD §4.5 距离驱动一致）：近距离步行、中距离骑行、远距离驾车
function travelByDist(m) {
  if (m <= 1200) return { mode: '步行', min: Math.max(1, Math.round(m / 75)) };
  if (m <= 3000) return { mode: '骑行', min: Math.max(1, Math.round(m / 200)) };
  return { mode: '驾车', min: Math.max(1, Math.round(m / 400)) };
}

module.exports = { haversine, fmtDist, travelByDist };

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

// 距离友好格式化（中文口径，2026-09-30 用户建议）：
//   <1km  → 「520 米」（具体米数，便于近距判断）
//   ≥1km  → 「1公里350米」；不足 1km 的尾数按 10m 取整（避免「1公里347米」的假精度），
//           尾数为 0 时省略（「2公里」）
function fmtDist(m) {
  if (m == null || isNaN(m)) return '';
  const v = Math.max(0, Math.round(m));
  if (v < 1000) return v + ' 米';
  const r10 = Math.round(v / 10) * 10;
  const km = Math.floor(r10 / 1000);
  const rem = r10 % 1000;
  return rem ? km + '公里' + rem + '米' : km + '公里';
}

// 按距离推荐出行方式（与 PRD §4.5 距离驱动一致）：近距离步行、中距离骑行、远距离驾车
function travelByDist(m) {
  if (m <= 1200) return { mode: '步行', min: Math.max(1, Math.round(m / 75)) };
  if (m <= 3000) return { mode: '骑行', min: Math.max(1, Math.round(m / 200)) };
  return { mode: '驾车', min: Math.max(1, Math.round(m / 400)) };
}

module.exports = { haversine, fmtDist, travelByDist };

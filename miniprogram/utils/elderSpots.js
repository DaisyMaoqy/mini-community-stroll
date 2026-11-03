// utils/elderSpots.js —— 关怀版两个列表页（接种 / 遛娃）共用的取数与文案工具
//
// 为什么单独抽出来：pages/elder-vac 与 pages/elder-map 的取数口径、距离回填、
// 「怎么去」一句话几乎一样，各写一份容易漂移（例如一边改了 fmtDist 口径另一边没改）。
// 这里只放纯函数，页面各自负责 setData 与串行调度。
const { fmtDist } = require('./geo.js');

// 「怎么去」一句话。plan 来自 utils/routePlan.js 的 planRoute / planRouteBlockless。
// 关怀版原则：只给一句话，不给多步骤路线 —— 老人不会读「先坐 2 号线到交通中心换乘」，
// 多层级也违背适老化设计（原型范式来自粤省事关怀版：字大、层级少、可拨可导航）。
function howText(plan) {
  if (!plan) return '';
  const min = plan.min != null ? plan.min : null;

  if (plan.mode === 'walk') {
    const d = plan.distM != null ? fmtDist(plan.distM) : '';
    if (d && min != null) return '走路约 ' + d + ' · 约 ' + min + ' 分钟';
    if (d) return '走路约 ' + d;
    return '走路可达';
  }

  // 邨巴：优先用种子里的 busText（含线路名与班次时间，信息最全）
  const busText = plan.bus && plan.bus.text ? plan.bus.text : '';
  if (busText) return '坐邨巴 · ' + busText;
  if (min != null) return '坐邨巴 · 约 ' + min + ' 分钟';
  return '建议坐邨巴';
}

// 从原始 POI 抽出关怀版卡片要用的字段。
//
// ⚠️ phone：种子数据目前**全部 POI 都没有该字段**（2026-11-03 核对 15 个点全部无 phone）。
// 原型里的 020-8477-xxxx 是演示假数据，不能当真实号码用。
// 这里按「有就显示、没有就不显示」处理，绝不编造号码；运营将来在 seed 里补了 phone，
// 电话按钮会自动出现，无需改代码。
function baseRow(s, nameKey) {
  const coords = (s && s.coord && s.coord.coordinates) || [];
  const bus = (s && s.bus) || {};
  return {
    id: (s && s._id) || '',
    // 接种点的展示名优先用 vacName（含「站」等正式后缀），遛娃点没有该字段则回落 name
    name: (nameKey && s[nameKey]) || (s && s.name) || '',
    address: (s && s.address) || '',
    subType: (s && s.subType) || '',
    how: '', // 由 howText 回填；回填前 wxml 显示「正在算怎么走…」
    phone: (s && s.phone) || '',
    lat: coords[1],
    lng: coords[0],
    external: !!(s && s.external),                     // 社区外（需换乘对外公交/地铁）
    stroller: !!(bus.stroller),                        // 推车路线可达
  };
}

module.exports = { howText, baseRow };

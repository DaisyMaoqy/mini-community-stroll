// utils/blocks.js —— 祈福新村 28 板块 → gcj02 坐标映射（出行决策原点）
//
// 坐标来源：PRD §7.1「各板块中心点经纬度在开发阶段由地图 geocoding / 人工标点确定」。
// 本项目暂无腾讯 geocoding 全量结果，故按「小区示意图（RAG img-estates-map-xhs959049965）相对位置
// + 现有 POI 真实坐标锚点」人工标点，均标 coordEstimated:true，待 geocoding 复核后替换。
//
// 锚点（真实 gcj02，来自 spots.seed.json；祈福湖/郊野公园 2026-09-29 人工拾取更新）：
//   祈福医院 113.32529,22.96911 · 祈福名都 113.32246,22.96476 · 千色园 113.32954,22.96488
//   棕榈园   113.33564,22.96195 · 祈福湖   113.33401,22.95531 · 延康     113.32913,22.95464
//   郊野公园 113.33995,22.96292 · 天湖居   113.34164,22.95957 · 欢乐广场 113.33254,22.96925
//   鳄鱼湖公园 113.31989,22.95843（暂用点，待采集端纠正）
// 注意：祈福湖锚点较旧版南移约 700m，凡注释以「祈福湖南/北」描述方位的板块质心，下次校准时需复核。
//
// 尺度：经度 0.001°≈102m、纬度 0.001°≈111m（纬度 22.96）。

const BLOCKS = {
  // —— 代表板块（中部干道祈福大道沿线 + 医院片区）——
  '蝶舞轩':     { lat: 22.9640, lng: 113.3225, coordEstimated: true }, // 康怡居南段/西延，祈福大道西
  '青怡居':     { lat: 22.9670, lng: 113.3240, coordEstimated: true }, // 祈福医院南、祈福大道东
  '康怡居':     { lat: 22.9650, lng: 113.3215, coordEstimated: true }, // 祈福大道西、青怡居西
  '倚湖湾':     { lat: 22.9560, lng: 113.3340, coordEstimated: true }, // 祈福大道最南、2号线总站；延康（千福街2号101）在西南约 520m
  '缤纷汇':     { lat: 22.9690, lng: 113.3320, coordEstimated: true }, // ABCDE区西、商业商圈
  '活力花园':   { lat: 22.9695, lng: 113.3220, coordEstimated: true }, // 祈福医院南、青怡居北

  // —— 半山七苑（西部山地，贴大夫山，自北向南台阶下降）——
  '山泉居':     { lat: 22.9705, lng: 113.3130, coordEstimated: true }, // 半山最北、毓正小学东
  '海晴居':     { lat: 22.9685, lng: 113.3140, coordEstimated: true }, // 山泉居南
  '迎风阁':     { lat: 22.9665, lng: 113.3145, coordEstimated: true }, // 海晴居南
  '康怡雅园':   { lat: 22.9650, lng: 113.3160, coordEstimated: true }, // 迎风阁南
  '倚云居':     { lat: 22.9635, lng: 113.3165, coordEstimated: true }, // 康怡雅园西/月明轩西
  '月明轩':     { lat: 22.9620, lng: 113.3180, coordEstimated: true }, // 半山中央、8号线总站
  '晓峰园':     { lat: 22.9600, lng: 113.3185, coordEstimated: true }, // 半山最南、紧邻大夫山

  // —— 湖畔板块（祈福湖周边）——
  '翠湖居':     { lat: 22.9600, lng: 113.3315, coordEstimated: true }, // 祈福湖南
  '湖畔豪庭':   { lat: 22.9595, lng: 113.3290, coordEstimated: true }, // 祈福湖西
  '福临居':     { lat: 22.9590, lng: 113.3310, coordEstimated: true }, // 倚湖湾北、祈福湖南
  '湖景居':     { lat: 22.9615, lng: 113.3325, coordEstimated: true }, // 祈福大道东、E区南
  '天湖居':     { lat: 22.9595, lng: 113.3415, coordEstimated: true }, // 西部天湖居湖心乐园

  // —— 大道沿线 · 其他 ——
  '绿怡居':     { lat: 22.9655, lng: 113.3260, coordEstimated: true }, // 青怡居北、独立于绿怡花园
  '绿怡花园':   { lat: 22.9660, lng: 113.3280, coordEstimated: true }, // 绿怡居东、祈福大道东
  '祈福名都':   { lat: 22.9647, lng: 113.3225, coordEstimated: true }, // 祈福大道东、青怡居西（真实锚点 113.32246,22.96476）
  '名望天下':   { lat: 22.9700, lng: 113.3335, coordEstimated: true }, // ABCDE区北、缤纷汇上盖
  '祈福半山臻品': { lat: 22.9580, lng: 113.3270, coordEstimated: true }, // 颐贤小学东、D区南

  // —— A–E 区（祈福大道以东、缤纷汇至市广路站）——
  'A区':        { lat: 22.9545, lng: 113.3210, coordEstimated: true }, // B区东、近郊野公园
  'B区':        { lat: 22.9535, lng: 113.3230, coordEstimated: true }, // C区东、A区西
  'C区':        { lat: 22.9525, lng: 113.3250, coordEstimated: true }, // 最西、邨巴C线总站
  'D区':        { lat: 22.9555, lng: 113.3240, coordEstimated: true }, // A区东、东南
  'E区':        { lat: 22.9600, lng: 113.3290, coordEstimated: true }, // C/B区南、湖景居北
};

// 社区中心兜底坐标（未选板块时用）
const CENTER = { lat: 22.963, lng: 113.33, coordEstimated: true };

// 板块名 → 坐标（含兜底：未选板块用社区中心）
function blockCoord(name) {
  if (name && BLOCKS[name]) return BLOCKS[name];
  return CENTER;
}

// 是否已配置该板块坐标
function hasBlock(name) {
  return !!(name && BLOCKS[name]);
}

module.exports = { BLOCKS, CENTER, blockCoord, hasBlock };

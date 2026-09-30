// utils/weather.js —— 天气 + 外出建议（三级来源，逐级降级）
//   1) 云函数 getWeather（部署后首选，无域名白名单问题）
//   2) 直连 Open-Meteo（开发期「不校验合法域名」可用；发布需在小程序后台加 request 合法域名 api.open-meteo.com + air-quality-api.open-meteo.com）
//   3) 本地估算（mock，UI 会诚实标注「估算值」）
// M6+（2026-09-24）：新增 uvIndex / aqi / hourly 三维度，供首页遛娃指数（utils/t6.js）与出门时段推算。
const { callCloud } = require('./cloud.js');
const { aqiChina } = require('./t6.js');

// WMO weather code → 中文描述（用于副文案，图标统一走 svg-icon）
const WMO = {
  0: '晴', 1: '多云', 2: '多云', 3: '阴', 45: '有雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '细雨', 61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '强阵雨',
  95: '雷阵雨', 96: '雷雨冰雹', 99: '强雷雨',
};

function wxGet(url) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: url,
      method: 'GET',
      timeout: 6000,
      success(res) {
        if (res.statusCode === 200 && res.data) resolve(res.data);
        else reject(new Error('HTTP ' + res.statusCode));
      },
      fail(e) { reject(e); },
    });
  });
}

// 归一化：补齐 icon（svg-icon 名）与 mock 标记；缺省字段用 null（t6 按缺省分处理）
function normalize(o) {
  const w = {
    tempC: o.tempC != null ? o.tempC : null,
    weatherCode: o.weatherCode != null ? o.weatherCode : 1,
    isDay: !!o.isDay,
    precipitation: o.precipitation != null ? o.precipitation : 0,
    rain2h: o.rain2h != null ? o.rain2h : 0,
    uvIndex: o.uvIndex != null ? o.uvIndex : null,
    aqi: o.aqi != null ? o.aqi : null,
    hourly: o.hourly || null,
    text: WMO[o.weatherCode] || '多云',
    source: o.source || 'open-meteo',
  };
  w.mock = w.source === 'mock';
  w.icon = w.rain2h >= 30 ? 'warn' : 'sun'; // 有雨风险用警示图标，否则晴天图标
  return w;
}

// 本地估算：按当前时段给确定性、可解释的兜底值（无网/云函数未部署时）
function mockWeather() {
  const h = new Date().getHours();
  const isDay = h >= 6 && h < 19;
  // 确定性 mock：UV 按正午峰值钟形曲线；温度按日变化正弦；AQI 固定良
  const uv = isDay ? Math.max(0, Math.round(7 * Math.sin(((h - 6) / 13) * Math.PI) * 10) / 10) : 0;
  const temp = Math.round(24 + 4 * Math.sin(((h - 6) / 13) * Math.PI));
  // 合成 24h hourly（今天 0~23 时），供出门时段推算的 mock 演示
  const time = [], tempA = [], uvA = [], ppA = [];
  for (let i = 0; i < 24; i++) {
    time.push('T' + ('0' + i).slice(-2) + ':00'); // 占位日期由 slotScores 用 time[0] 前缀，mock 直接用完整日期
    const dayUv = i >= 6 && i < 19 ? Math.max(0, Math.round(7 * Math.sin(((i - 6) / 13) * Math.PI) * 10) / 10) : 0;
    tempA.push(24 + 4 * Math.sin(((i - 6) / 13) * Math.PI));
    uvA.push(dayUv);
    ppA.push(0);
  }
  const d = new Date();
  const day = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  return normalize({
    tempC: temp,
    weatherCode: isDay ? 0 : 1,
    isDay: isDay,
    rain2h: 0,
    uvIndex: uv,
    aqi: 55,
    hourly: {
      time: time.map((x) => day + x),
      temp: tempA,
      uv: uvA,
      precipProb: ppA,
    },
    source: 'mock',
  });
}

const OPEN_METEO = (lat, lng) =>
  'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
  '&current=temperature_2m,weather_code,is_day,precipitation' +
  '&hourly=temperature_2m,uv_index,precipitation_probability' +
  '&forecast_days=2&timezone=Asia%2FShanghai';

// 空气质量独立 API（失败不阻塞，aqi 置 null）
const OPEN_METEO_AIR = (lat, lng) =>
  'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lat + '&longitude=' + lng +
  '&current=pm10,pm2_5&timezone=Asia%2FShanghai';

// 从 forecast 返回中提取当前小时 UV
function currentUv(j) {
  const hourly = (j && j.hourly) || {};
  const curTime = String((j && j.current && j.current.time) || '');
  if (!hourly.time || !hourly.uv_index) return null;
  let idx = hourly.time.findIndex((t) => t.slice(0, 13) === curTime.slice(0, 13));
  if (idx < 0) idx = 0;
  const v = hourly.uv_index[idx];
  return v != null && !isNaN(v) ? Math.round(v * 10) / 10 : null;
}

// ---------- 模块级共享缓存：跨页面复用（首页/接种页等共用一次请求） ----------
// 天气为社区级口径（PRD v1.9：社区尺度聚合，坐标差异无意义），故缓存不区分坐标。
const WX_TTL = 30 * 60 * 1000; // 30 分钟
let wxCache = null;  // { w, at }
let wxPending = null; // 进行中的请求 Promise（并发去重：多页同时首次进入只打一次接口）

async function getWeather(lat, lng) {
  const now = Date.now();
  if (wxCache && now - wxCache.at < WX_TTL) return wxCache.w;
  if (wxPending) return wxPending;
  wxPending = (async () => {
    try {
      const w = await fetchWeather(lat, lng);
      wxCache = { w, at: Date.now() };
      return w;
    } finally {
      wxPending = null;
    }
  })();
  return wxPending;
}

// 实际拉取：云函数 → 直连 Open-Meteo → 本地估算
async function fetchWeather(lat, lng) {
  // 1) 云函数
  try {
    const r = await callCloud('getWeather', { lat: lat, lng: lng });
    if (r && typeof r.tempC === 'number') return normalize(r);
  } catch (e) { /* 未部署/无网 → 降级 */ }
  // 2) 直连 Open-Meteo（天气 + 空气并行，空气失败不阻塞）
  try {
    const [wxJ, airJ] = await Promise.all([
      wxGet(OPEN_METEO(lat, lng)),
      wxGet(OPEN_METEO_AIR(lat, lng)).catch(() => null),
    ]);
    const cur = (wxJ && wxJ.current) || {};
    const hourly = (wxJ && wxJ.hourly) || {};
    const probs = hourly.precipitation_probability || [];
    const nowKey = String((cur && cur.time) || '').slice(0, 13);
    let idx = (hourly.time || []).findIndex((t) => t.slice(0, 13) === nowKey);
    if (idx < 0) idx = 0;
    const rain2h = probs.slice(idx, idx + 2).reduce((m, v) => Math.max(m, v == null ? 0 : v), 0);
    let aqi = null;
    if (airJ && airJ.current) {
      aqi = aqiChina(airJ.current.pm2_5, airJ.current.pm10);
    }
    return normalize({
      tempC: cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null,
      weatherCode: cur.weather_code,
      isDay: cur.is_day === 1,
      precipitation: cur.precipitation || 0,
      rain2h: rain2h,
      uvIndex: currentUv(wxJ),
      aqi: aqi,
      hourly: hourly.time
        ? { time: hourly.time, temp: hourly.temperature_2m || [], uv: hourly.uv_index || [], precipProb: probs }
        : null,
      source: 'open-meteo',
    });
  } catch (e) { /* 降级 */ }
  // 3) 本地估算
  return mockWeather();
}

// 顶部外出建议（结合降雨/气温）
function advice(w) {
  if (!w) return '';
  if (w.rain2h >= 50) return '2 小时内可能下雨，建议带伞或改日再约';
  if (w.rain2h >= 30) return '2 小时内或有阵雨，出门前留意天色';
  if (w.tempC >= 33) return '气温偏高，建议 09:00 前或 16:00 后前往，避开日晒';
  if (w.tempC >= 28) return '天气偏热，建议避开正午，上午前往更舒适';
  if (w.tempC <= 12) return '气温偏低，注意给宝宝保暖';
  return '2 小时内无雨，适合带宝宝外出接种';
}

// 每张接种卡的天气相关出行提示（纯文本；天气图标由顶部条承载，遵循 v15「图标用 SVG、不用 emoji」）
// queue: 'indoor' 室内候诊（社区卫生站/医院门诊，无需室外排队）
//        'outdoor' 室外排队（预留分支，当前种子数据暂无此类）
//        未传/其他 视为未知，用中性措辞（不预设排队方式）
function travelTip(w, queue) {
  if (!w) return '';
  const isIndoor = queue === 'indoor';
  const isOutdoor = queue === 'outdoor';
  if (w.rain2h >= 50) return isOutdoor ? '今日有雨，室外排队注意避雨' : '今日有雨，外出接种记得带伞避雨';
  if (w.rain2h >= 30) return isOutdoor ? '或有阵雨，室外排队留意天色' : '或有阵雨，外出带伞、留意天色';
  if (w.tempC >= 30) {
    if (isOutdoor) return '室外排队可能较久，建议 09:00 前到达避开日晒';
    if (isIndoor) return '天气炎热，室内候诊较舒适，外出注意防晒补水';
    return '天气炎热，外出注意防晒补水';
  }
  if (w.tempC <= 12) return '天冷，外出注意给宝宝保暖';
  return isOutdoor ? '室外排队约 10 分钟，注意防晒补水' : '候诊多为室内，外出注意防晒补水';
}

module.exports = { getWeather, advice, travelTip };

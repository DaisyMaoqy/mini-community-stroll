// utils/weather.js —— 天气 + 外出建议（三级来源，逐级降级）
//   1) 云函数 getWeather（部署后首选，无域名白名单问题）
//   2) 直连 Open-Meteo（开发期「不校验合法域名」可用；发布需在小程序后台加 request 合法域名 api.open-meteo.com）
//   3) 本地估算（mock，UI 会诚实标注「估算值」）
const { callCloud } = require('./cloud.js');

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

// 归一化：补齐 icon（svg-icon 名）与 mock 标记
function normalize(o) {
  const w = {
    tempC: o.tempC,
    weatherCode: o.weatherCode,
    isDay: !!o.isDay,
    rain2h: o.rain2h || 0,
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
  return normalize({ tempC: isDay ? 26 : 22, weatherCode: isDay ? 0 : 1, isDay: isDay, rain2h: 0, source: 'mock' });
}

const OPEN_METEO = (lat, lng) =>
  'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
  '&current=temperature_2m,weather_code,is_day,precipitation' +
  '&hourly=precipitation_probability&forecast_days=2&timezone=Asia%2FShanghai';

async function getWeather(lat, lng) {
  // 1) 云函数
  try {
    const r = await callCloud('getWeather', { lat: lat, lng: lng });
    if (r && typeof r.tempC === 'number') return normalize(r);
  } catch (e) { /* 未部署/无网 → 降级 */ }
  // 2) 直连 Open-Meteo
  try {
    const j = await wxGet(OPEN_METEO(lat, lng));
    const cur = (j && j.current) || {};
    const probs = (j && j.hourly && j.hourly.precipitation_probability) || [];
    const rain2h = probs.slice(0, 2).reduce((m, v) => Math.max(m, v == null ? 0 : v), 0);
    return normalize({
      tempC: Math.round(cur.temperature_2m),
      weatherCode: cur.weather_code,
      isDay: cur.is_day === 1,
      rain2h: rain2h,
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
function travelTip(w) {
  if (!w) return '';
  if (w.rain2h >= 50) return '今日有雨，室外排队注意避雨';
  if (w.rain2h >= 30) return '或有阵雨，室外排队留意天色';
  if (w.tempC >= 30) return '室外排队可能较久，建议 09:00 前到达避开日晒';
  if (w.tempC <= 12) return '天冷，排队注意给宝宝保暖';
  return '室外排队约 10 分钟，注意防晒补水';
}

module.exports = { getWeather, advice, travelTip };

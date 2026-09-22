// getWeather —— 天气云函数（Open-Meteo，免费且无需 key）
// 前端：wx.cloud.callFunction({ name:'getWeather', data:{ lat, lng } })
// 返回（扁平）：{ success, tempC, weatherCode, isDay, precipitation, rain2h, source:'open-meteo', updatedAt }
// 放在云函数（而非前端直连）可免去小程序后台「request 合法域名」白名单，也便于后续服务端缓存。
const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("解析失败: " + String(raw).slice(0, 120)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("请求超时")));
  });
}

// 取「当前小时起未来 hours 小时」的最大降水概率（%）
function nextHoursMaxProb(hourly, nowIsoHour, hours) {
  if (!hourly || !hourly.time || !hourly.precipitation_probability) return 0;
  let idx = hourly.time.findIndex((t) => t >= nowIsoHour);
  if (idx < 0) idx = 0;
  const slice = hourly.precipitation_probability.slice(idx, idx + hours);
  return slice.reduce((m, v) => Math.max(m, v == null ? 0 : v), 0);
}

exports.main = async (event) => {
  const lat = Number(event && event.lat) || 22.963; // 默认祈福新邨社区中心
  const lng = Number(event && event.lng) || 113.33;
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    lat +
    "&longitude=" +
    lng +
    "&current=temperature_2m,weather_code,is_day,precipitation" +
    "&hourly=precipitation_probability&forecast_days=2&timezone=Asia%2FShanghai";
  try {
    const j = await httpsGetJson(url);
    const cur = j.current || {};
    // current.time / hourly.time 均为本地时区 ISO（如 2026-09-22T17:30 / 2026-09-22T17:00）
    const nowIsoHour = String(cur.time || "").slice(0, 13) + ":00";
    const rain2h = nextHoursMaxProb(j.hourly, nowIsoHour, 2);
    return {
      success: true,
      code: "OK",
      tempC: Math.round(cur.temperature_2m),
      weatherCode: cur.weather_code,
      isDay: cur.is_day === 1,
      precipitation: cur.precipitation || 0,
      rain2h: rain2h,
      source: "open-meteo",
      updatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      success: false,
      code: "WEATHER_ERROR",
      message: String((e && e.message) || e),
    };
  }
};

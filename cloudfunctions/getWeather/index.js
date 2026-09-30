// getWeather —— 天气云函数（Open-Meteo，免费且无需 key；两个 API 并行）
// 前端：wx.cloud.callFunction({ name:'getWeather', data:{ lat, lng } })
// 返回（扁平）：{
//   success, tempC, weatherCode, isDay, precipitation, rain2h,
//   uvIndex,                 // 当前小时 UV 指数（forecast API hourly）
//   aqi, pm25, pm10,         // 中国 AQI（HJ 633-2012 按 24h 分级近似 1h 浓度，估算值）
//   hourly: { time[], temp[], uv[], precipProb[] },  // 未来 2 天逐小时（Asia/Shanghai），供出门时段推算
//   source:'open-meteo', updatedAt
// }
// 放在云函数（而非前端直连）可免去小程序后台「request 合法域名」白名单，也便于后续服务端缓存。
// M6+（2026-09-24）：新增 UV / AQI / hourly 三维度，供首页遛娃指数与出门时段推算。
const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const FORECAST_URL =
  (lat, lng) =>
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat +
    "&longitude=" + lng +
    "&current=temperature_2m,weather_code,is_day,precipitation" +
    "&hourly=temperature_2m,uv_index,precipitation_probability" +
    "&forecast_days=2&timezone=Asia%2FShanghai";

// 空气质量独立 API；pm 浓度单位 μg/m³
const AIR_URL =
  (lat, lng) =>
    "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat +
    "&longitude=" + lng +
    "&current=pm10,pm2_5" +
    "&timezone=Asia%2FShanghai";

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

// ---------- 中国 AQI（与前端 utils/t6.js 保持同一套断点，HJ 633-2012） ----------
const PM25_BP = [[0,35,0,50],[35,75,50,100],[75,115,100,150],[115,150,150,200],[150,250,200,300],[250,350,300,400],[350,500,400,500]];
const PM10_BP = [[0,50,0,50],[50,150,50,100],[150,250,100,150],[250,350,150,200],[350,420,200,300],[420,500,300,400],[500,600,400,500]];
function iaqi(bp, v) {
  if (v == null || isNaN(v)) return null;
  for (const seg of bp) {
    const cl = seg[0], ch = seg[1], il = seg[2], ih = seg[3];
    if (v <= ch) return Math.round(Math.max(0, Math.min(500, il + ((ih - il) * (v - cl)) / (ch - cl))));
  }
  return 500;
}
function aqiChina(pm25, pm10) {
  const arr = [iaqi(PM25_BP, pm25), iaqi(PM10_BP, pm10)].filter((x) => x != null);
  return arr.length ? Math.max.apply(null, arr) : null;
}

exports.main = async (event) => {
  const t0 = Date.now();
  const lat = Number(event && event.lat) || 22.963; // 默认祈福新邨社区中心
  const lng = Number(event && event.lng) || 113.33;

  // 空气质量失败不阻塞天气（aqi 置 null，前端按缺省分处理）
  const [wxRes, airRes] = await Promise.all([
    httpsGetJson(FORECAST_URL(lat, lng)).then(
      (j) => ({ ok: true, j }),
      (e) => ({ ok: false, err: e })
    ),
    httpsGetJson(AIR_URL(lat, lng)).then(
      (j) => ({ ok: true, j }),
      () => ({ ok: false })
    ),
  ]);

  if (!wxRes.ok) {
    return {
      success: false,
      code: "WEATHER_ERROR",
      message: String((wxRes.err && wxRes.err.message) || wxRes.err),
    };
  }
  const j = wxRes.j;
  const cur = j.current || {};
  const hourly = j.hourly || {};
  // current.time / hourly.time 均为本地时区 ISO（如 2026-09-22T17:30 / 2026-09-22T17:00）
  const nowIsoHour = String(cur.time || "").slice(0, 13) + ":00";
  const rain2h = nextHoursMaxProb(hourly, nowIsoHour, 2);

  // 当前小时 UV：从 hourly.time 定位（找不到取第 0 小时）
  let uvIndex = null;
  if (hourly.time && hourly.uv_index) {
    let idx = hourly.time.findIndex((t) => t === nowIsoHour);
    if (idx < 0) idx = 0;
    const v = hourly.uv_index[idx];
    if (v != null && !isNaN(v)) uvIndex = Math.round(v * 10) / 10;
  }

  // 中国 AQI（估算）：由 pm2.5 / pm10 浓度算 IAQI 取最大
  let aqi = null, pm25 = null, pm10 = null;
  if (airRes.ok) {
    const ac = (airRes.j && airRes.j.current) || {};
    pm25 = ac.pm2_5 != null && !isNaN(ac.pm2_5) ? Math.round(ac.pm2_5) : null;
    pm10 = ac.pm10 != null && !isNaN(ac.pm10) ? Math.round(ac.pm10) : null;
    aqi = aqiChina(pm25, pm10);
  }

  // 逐小时（原样转发，前端做窗口推算；只保留两个字段减小包体）
  const hourlyOut =
    hourly.time
      ? {
          time: hourly.time,
          temp: hourly.temperature_2m || [],
          uv: hourly.uv_index || [],
          precipProb: hourly.precipitation_probability || [],
        }
      : null;

  return {
    success: true,
    code: "OK",
    tempC: Math.round(cur.temperature_2m),
    weatherCode: cur.weather_code,
    isDay: cur.is_day === 1,
    precipitation: cur.precipitation || 0,
    rain2h: rain2h,
    uvIndex: uvIndex,
    aqi: aqi,
    pm25: pm25,
    pm10: pm10,
    hourly: hourlyOut,
    source: "open-meteo",
    updatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
  };
};

// route —— 腾讯位置服务路线规划代理（步行 walking + 电动车 ebicycling）
//
// 用途：前端/接种页/地图页做「步行 vs 邨巴」出行决策需要真实路线距离，
//       按 PRD §4.5「正式环境步行/电动车路线均调用腾讯位置服务路线规划 API，
//       密钥放云函数绝不进客户端」放到云函数端。
//
// 入参（扁平）：{ from:{lat,lng}, to:{lat,lng} }   // gcj02，与微信 <map> 同坐标系
// 返回（扁平）：{
//   success,
//   walk:  { distance, duration, degraded } | null,   // 步行路线（米/分钟）
//   ebike: { distance, duration, degraded } | null,   // 电动车路线
//   error  // 失败原因（success=false 时）
// }
//
// 密钥：腾讯 WebService key / SN SecretKey 走云函数「环境变量」GEO_KEY / GEO_SECRET
//   （云开发控制台 → 云函数 → route → 配置 → 环境变量），不落地代码。
// 未配置 key 时返回 degraded（前端降级为直线距离估算），不阻塞页面。
const cloud = require("wx-server-sdk");
const https = require("https");
const crypto = require("crypto");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const KEY = process.env.GEO_KEY || "";
const SECRET = process.env.GEO_SECRET || "";

// ---------- 腾讯 SN 签名（与 tools/geocode_bus_stations.js 同一算法） ----------
function md5lower(s) { return crypto.createHash("md5").update(s, "utf8").digest("hex"); }
function sign(path, params) {
  const keys = Object.keys(params).sort();
  const qs = keys.map((k) => `${k}=${params[k]}`).join("&");
  return md5lower(`${path}?${qs}${SECRET}`);
}
function buildSignedUrl(path, params) {
  const sig = sign(path, params);
  const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(String(params[k]))}`).join("&");
  return `https://apis.map.qq.com${path}?${qs}&sig=${sig}`;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("解析失败: " + String(raw).slice(0, 120))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("请求超时")));
  });
}

// 腾讯路线规划 API 路径：
//   walking    /ws/direction/v1/walking/
//   ebicycling /ws/direction/v1/bicycling/  （电动车用 ebicycling，PRD §4.5）
async function getRoute(mode, from, to) {
  const path = mode === "ebike" ? "/ws/direction/v1/bicycling/" : "/ws/direction/v1/walking/";
  const params = {
    key: KEY,
    from: `${from.lat},${from.lng}`,
    to: `${to.lat},${to.lng}`,
  };
  const url = buildSignedUrl(path, params);
  const j = await httpsGetJson(url);
  if (!j || j.status !== 0) {
    return { distance: null, duration: null, degraded: true, reason: (j && j.message) || "route failed" };
  }
  const route = (j.result && j.result.routes && j.result.routes[0]) || {};
  const distance = route.distance; // 米
  const duration = route.duration; // 分钟（腾讯已给分钟）
  if (distance == null || duration == null) {
    return { distance: null, duration: null, degraded: true, reason: "no route" };
  }
  return { distance: Math.round(distance), duration: Math.round(duration), degraded: false };
}

exports.main = async (event) => {
  const t0 = Date.now();
  const from = event && event.from;
  const to = event && event.to;
  if (!from || !to || from.lat == null || from.lng == null || to.lat == null || to.lng == null) {
    return { success: false, code: "BAD_PARAM", message: "缺少 from/to 坐标" };
  }

  // 未配置 key：直接降级（前端用直线距离兜底），不报错
  if (!KEY || !SECRET) {
    return {
      success: true,
      code: "NO_KEY",
      walk: { distance: null, duration: null, degraded: true, reason: "no key" },
      ebike: { distance: null, duration: null, degraded: true, reason: "no key" },
      degraded: true,
    };
  }

  try {
    // 步行 + 电动车并行；任一失败不影响另一个
    const [walkR, ebikeR] = await Promise.all([
      getRoute("walk", from, to).then((r) => ({ ok: true, r }), (e) => ({ ok: false, err: e })),
      getRoute("ebike", from, to).then((r) => ({ ok: true, r }), (e) => ({ ok: false, err: e })),
    ]);

    return {
      success: true,
      code: "OK",
      walk: walkR.ok ? walkR.r : { distance: null, duration: null, degraded: true, reason: "walk failed" },
      ebike: ebikeR.ok ? ebikeR.r : { distance: null, duration: null, degraded: true, reason: "ebike failed" },
      degraded: (walkR.ok ? walkR.r.degraded : true) && (ebikeR.ok ? ebikeR.r.degraded : true),
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      success: false,
      code: "ROUTE_ERROR",
      message: String((e && e.message) || e),
    };
  }
};

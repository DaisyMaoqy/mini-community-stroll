#!/usr/bin/env node
// 邨巴站点全量地理编码：把 seed / busRoutes 里的站点名解析为真实 GCJ-02 坐标。
// 用法：
//   GEO_KEY=你的KEY GEO_PROVIDER=tencent node tools/geocode_bus_stations.js
// 输出 tools/geo_results.json：{ results:{站名:[lng,lat]}, detail:{站名:{via,title,sim}}, unresolved:[...], log:[...] }
//
// 说明：
// - 腾讯(Tencent) WebService 返回 GCJ-02，与微信 <map> 组件坐标系一致，无需转换。
// - 本脚本只做"查询 + 落盘"，不修改任何项目源码；应用坐标由 tools/apply_geo.js 完成。
// - key 仅用于本次调用，不会写入任何产物文件。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PROVIDER = (process.env.GEO_PROVIDER || 'tencent').toLowerCase();
const KEY = process.env.GEO_KEY;
const SECRET = process.env.GEO_SECRET;

if (!KEY) {
  console.error('ERROR: 请设置环境变量 GEO_KEY（腾讯 WebService key）');
  process.exit(1);
}
if (!SECRET) {
  console.error('ERROR: 请设置环境变量 GEO_SECRET（腾讯 WebService 签名 SecretKey）');
  process.exit(1);
}

// ---------- 腾讯 SN 签名 ----------
// 腾讯官方算法：sig = md5( 请求路径 + "?" + 排序后的参数 + SecretKey )
//   - 参数按参数名 ASCII 升序排列，用 & 连接（原始值，不做 urlencode）
//   - 末尾直接拼接 SecretKey（不带 "SK=" 前缀）
//   - 实际请求时参数再做 urlencode，但签名用原始值
function md5lower(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function sign(path, params) {
  const keys = Object.keys(params).sort();
  const qs = keys.map((k) => `${k}=${params[k]}`).join('&');
  return md5lower(`${path}?${qs}${SECRET}`);
}
function buildSignedUrl(path, params) {
  const sig = sign(path, params);
  const qs = Object.keys(params).map((k) => `${k}=${enc(String(params[k]))}`).join('&');
  return `https://apis.map.qq.com${path}?${qs}&sig=${sig}`;
}

const seedPath = path.join(ROOT, 'cloudfunctions/initSpots/spots.seed.json');
const busPath = path.join(ROOT, 'miniprogram/pages/map/busRoutes.js');
const outPath = path.join(ROOT, 'tools/geo_results.json');

// ---------- 收集去重站名 ----------
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')).spots;
const busMod = require(busPath);
// 新版 busRoutes.js 导出 { routes: { '1': { inbound, outbound, ... } } }（示意图模式，无坐标）
const busRoutes = busMod.routes || {};
const names = new Set();
for (const s of seed) if (s.type === '邨巴') names.add(s.name);
for (const k in busRoutes) {
  const line = busRoutes[k];
  for (const st of (line.inbound || []).concat(line.outbound || [])) names.add(st.n);
}
const unique = [...names];
console.log(`待地理编码唯一站名数: ${unique.length}`);

// ---------- HTTP ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'mini-community-stroll/geo' } });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getJsonRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const j = await getJson(url);
      // 腾讯限流：status 121 / message 含"频率" -> 退避重试
      if (j && j.status !== undefined && j.status !== 0 && /频率|limit|quota/i.test(j.message || '')) {
        await sleep(1000 * (i + 1));
        continue;
      }
      return j;
    } catch (e) {
      if (i === tries - 1) return null;
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

const enc = encodeURIComponent;

// ---------- 腾讯 ----------
// 注意：腾讯 place search 的 location 为 {lat,lng}，geocoder 为 {lng,lat}，统一归一为 [lng,lat]
async function geoTencent(name) {
  const region = '广州';
  const cands = [
    // 1) 地点搜索（对命名地标最准），城市偏置 + 自动扩展
    { via: 'place+祈福', path: '/ws/place/v1/search', params: { boundary: `region(${region},1)`, keyword: '祈福新村' + name, key: KEY, page_size: 5, page_index: 1 } },
    { via: 'place', path: '/ws/place/v1/search', params: { boundary: `region(${region},1)`, keyword: name, key: KEY, page_size: 5, page_index: 1 } },
    // 2) 地理编码（兜底），加 region 偏置
    { via: 'geo+祈福', path: '/ws/geocoder/v1/', params: { key: KEY, region, address: '广州市番禺区祈福新村' + name } },
    { via: 'geo', path: '/ws/geocoder/v1/', params: { key: KEY, region, address: '广州市' + name } },
  ];
  for (const c of cands) {
    const url = buildSignedUrl(c.path, c.params);
    const j = await getJsonRetry(url);
    if (!j || j.status === undefined) continue;
    // place search
    if (j.status === 0 && Array.isArray(j.data) && j.data.length && j.data[0].location) {
      const d = j.data[0];
      return { c: [d.location.lng, d.location.lat], via: c.via, title: d.title, sim: null };
    }
    // geocoder
    if (j.status === 0 && j.result && j.result.location) {
      const loc = j.result.location;
      const lng = loc.lng !== undefined ? loc.lng : loc.lat; // 容错
      const lat = loc.lat !== undefined ? loc.lat : loc.lng;
      return { c: [lng, lat], via: c.via, title: j.result.title || null, sim: j.result.similarity };
    }
  }
  return null;
}

const geo = geoTencent; // 本次使用腾讯

// ---------- 执行 ----------
(async () => {
  const results = {};
  const detail = {};
  const unresolved = [];
  const log = [];
  let lowConf = 0;
  for (const name of unique) {
    let r = null;
    try { r = await geo(name); } catch (e) { r = null; }
    if (r && r.c && isFinite(r.c[0]) && isFinite(r.c[1])) {
      const c = [+r.c[0].toFixed(6), +r.c[1].toFixed(6)];
      results[name] = c;
      detail[name] = { via: r.via, title: r.title, sim: r.sim };
      const flag = (r.sim !== null && r.sim < 0.5) ? ' (LOW-SIM)' : '';
      if (flag) lowConf++;
      log.push(`OK   ${name} => [${c}] via=${r.via} title=${r.title}${flag}`);
    } else {
      unresolved.push(name);
      log.push(`MISS ${name}`);
    }
    await sleep(300); // 腾讯免费配额约 5 QPS，留余量
  }
  const out = { provider: PROVIDER, ts: new Date().toISOString(), results, detail, unresolved, log };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n完成：成功 ${Object.keys(results).length} / ${unique.length}，失败 ${unresolved.length}，低相似度 ${lowConf}`);
  console.log(`输出已写入 ${outPath}`);
  if (unresolved.length) console.log('未命中：\n  ' + unresolved.join('\n  '));
})();

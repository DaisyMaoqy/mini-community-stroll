#!/usr/bin/env node
// ⚠️ 已归档（2026-09-24）：spots.seed.json 中的 102 个邨巴 POI 已全部移除
//    （邨巴改由 miniprogram/pages/map/busRoutes.js「地铁式示意图」呈现），
//    本脚本已无作用，保留仅作历史追溯。
// ---- 原用途 ----
// 把 tools/geocode_bus_stations.js 的输出应用到项目：
//   1) 更新 cloudfunctions/initSpots/spots.seed.json 中邨巴 POI 的 coord(真实 GCJ-02) 并清 coordEstimated
// 同时做别名对齐（如 祈福交通中心≡交通中心）与边界 sanity check。
// 注：busRoutes.js 不再写入坐标 —— 邨巴已改为「地铁式线路示意图」，见正文末尾说明。
// 用法：node tools/apply_geo.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const seedPath = path.join(ROOT, 'cloudfunctions/initSpots/spots.seed.json');
const busPath = path.join(ROOT, 'miniprogram/pages/map/busRoutes.js');
const geoPath = path.join(ROOT, 'tools/geo_results.json');

if (!fs.existsSync(geoPath)) { console.error('ERROR: 先运行 tools/geocode_bus_stations.js 生成 geo_results.json'); process.exit(1); }

const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
const results = geo.results || {};
const unresolved = new Set(geo.unresolved || []);

// ---------- 别名对齐 ----------
// 1) 显式别名：短名直接继承长名坐标（确保 marker 与连线用同一坐标）
const ALIAS = {
  '交通中心': '祈福交通中心',
  '新邨学校': '祈福新邨学校',
};
for (const short in ALIAS) {
  const parent = ALIAS[short];
  if (results[parent]) {
    results[short] = results[parent];
    unresolved.delete(short);
    console.log(`别名对齐(显式): ${short} => 继承 ${parent} [${results[short]}]`);
  }
}
// 2) 后缀继承：短名未命中但它是某已命中长名的后缀
const resolvedNames = Object.keys(results);
for (const short of [...unresolved]) {
  const parent = resolvedNames.find((long) => long !== short && long.endsWith(short));
  if (parent) {
    results[short] = results[parent];
    unresolved.delete(short);
    console.log(`别名对齐(后缀): ${short} => 继承 ${parent} [${results[short]}]`);
  }
}

// ---------- 备份 ----------
const ts = Date.now();
fs.copyFileSync(seedPath, `/tmp/bus_seed_backup_${ts}.json`);
fs.copyFileSync(busPath, `/tmp/bus_routes_backup_${ts}.js`);
console.log(`已备份原文件到 /tmp/bus_seed_backup_${ts}.json 与 /tmp/bus_routes_backup_${ts}.js`);

// ---------- 边界 sanity（祈福新村大致范围） ----------
const BBOX = { lngMin: 113.30, lngMax: 113.345, latMin: 22.95, latMax: 22.98 };
function inBox(c) { return c[0] >= BBOX.lngMin && c[0] <= BBOX.lngMax && c[1] >= BBOX.latMin && c[1] <= BBOX.latMax; }

// ---------- 更新 seed ----------
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
let seedUpdated = 0, seedKeptEst = 0;
for (const s of seed.spots) {
  if (s.type !== '邨巴') continue;
  const c = results[s.name];
  if (c && inBox(c)) {
    s.coord = { type: 'Point', coordinates: [c[0], c[1]] };
    s.coordEstimated = false;
    seedUpdated++;
  } else {
    seedKeptEst++;
    if (c && !inBox(c)) console.log(`  越界保留估算: ${s.name} [${c}]`);
  }
}
fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2), 'utf8');
console.log(`seed 邨巴: 已应用真实坐标 ${seedUpdated} / 仍估算 ${seedKeptEst}`);

// ---------- busRoutes.js：不再写入坐标 ----------
// 邨巴已改为「地铁式线路示意图」（2026-09），busRoutes.js 只保留官方推文的线路/站点/时刻数据，
// 不再存储 GCJ-02 坐标：封闭小区无街/幢级 POI，geocoding 只能到小区级（±300~900m），
// 打点与 polyline 会误导用户。此处仅做存在性校验，不做任何写入。
const busExists = fs.existsSync(busPath);
console.log(`busRoutes.js: 跳过坐标写入（示意图模式${busExists ? '' : '，文件缺失请检查'}）`);

// ---------- 汇总 ----------
console.log('\n==== 应用完成 ====');
console.log(`真实坐标命中: ${Object.keys(results).length - unresolved.size} / ${Object.keys(results).length}`);
if (unresolved.size) console.log(`仍待人工标定(${unresolved.size}): ${[...unresolved].join(', ')}`);
console.log('下一步: 在微信开发者工具右键 cloudfunctions/initSpots -> 上传并部署 -> 运行，刷新 local_spots。');

// utils/t6.js —— 遛娃指数 T6 纯函数（PRD §4.1：温度/降水/UV/AQI 加权 → 优/良/一般/不宜）
// 纯函数、无 wx 依赖，便于 Node 单测。所有分项 0~100，加权合计即指数。
// 语义色按《竞品UI差异化分析》：优=绿 良=黄绿 一般=橙 不宜=灰红（档位色不随主题变，保证语义一致）。

const LEVELS = {
  good:    { key: 'good',    label: '优',   color: '#2FB67C' },
  fair:    { key: 'fair',    label: '良',   color: '#A8C256' },
  normal:  { key: 'normal',  label: '一般', color: '#E67E22' },
  bad:     { key: 'bad',     label: '不宜', color: '#C0392B' },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v) => Math.round(clamp(v, 0, 100));

// ---------- 中国 AQI（HJ 633-2012，按 24h 分级近似 1h 浓度，标注"估算"） ----------
const PM25_BP = [ [0,35,0,50], [35,75,50,100], [75,115,100,150], [115,150,150,200], [150,250,200,300], [250,350,300,400], [350,500,400,500] ];
const PM10_BP = [ [0,50,0,50], [50,150,50,100], [150,250,100,150], [250,350,150,200], [350,420,200,300], [420,500,300,400], [500,600,400,500] ];

function iaqi(bp, v) {
  if (v == null || isNaN(v)) return null;
  for (const [cl, ch, il, ih] of bp) {
    // 注意：AQI 是 0~500，不能复用模块级 round()（它 clamp 0~100，会把中重度污染全截成 100）
    if (v <= ch) return Math.round(Math.max(0, Math.min(500, il + ((ih - il) * (v - cl)) / (ch - cl))));
  }
  return 500;
}

// 返回 0~500 数值；无数据返回 null
function aqiChina(pm25, pm10) {
  const a = iaqi(PM25_BP, pm25);
  const b = iaqi(PM10_BP, pm10);
  const arr = [a, b].filter((x) => x != null);
  if (!arr.length) return null;
  return Math.max.apply(null, arr);
}

function aqiLevelText(aqi) {
  if (aqi == null) return '—';
  if (aqi <= 50) return '优';
  if (aqi <= 100) return '良';
  if (aqi <= 150) return '轻度';
  if (aqi <= 200) return '中度';
  if (aqi <= 300) return '重度';
  return '严重';
}

// ---------- 分项打分 ----------
// 温度：带娃舒适区 16~28℃ 满分，向两端递减（高温惩罚更陡：中暑风险 > 着凉风险）
function scoreTemp(t) {
  if (t == null || isNaN(t)) return 50;
  if (t >= 16 && t <= 28) return 100;
  if (t > 28 && t <= 33) return round(100 - (t - 28) * 12);   // 33℃ → 40
  if (t > 33) return round(Math.max(0, 40 - (t - 33) * 8));   // 38℃+ → 0
  if (t < 16 && t >= 8) return round(100 - (16 - t) * 7);     // 8℃ → 44
  return round(Math.max(0, 44 - (8 - t) * 9));                // 0℃ 以下 → 0
}

// 降水：未来 2h 最大降水概率（%），叠加当前实况（正在下雨直接压到 40 以下）
function scoreRain(rain2h, precipNow, weatherCode) {
  let s;
  if (rain2h == null || isNaN(rain2h)) s = 50;
  else if (rain2h <= 10) s = 100;
  else if (rain2h <= 30) s = 70;
  else if (rain2h <= 50) s = 40;
  else if (rain2h <= 70) s = 20;
  else s = 0;
  if (precipNow > 0) s = Math.min(s, 35);
  if ([95, 96, 99].indexOf(weatherCode) >= 0) s = Math.min(s, 10); // 雷雨
  else if ([61, 63, 65, 80, 81, 82].indexOf(weatherCode) >= 0) s = Math.min(s, 40); // 明显降雨
  return s;
}

// UV：WHO 等级（低<3 中3-6 高6-8 很高8-11 极端11+）
function scoreUV(uv) {
  if (uv == null || isNaN(uv)) return 50;
  if (uv < 3) return 100;
  if (uv < 6) return 75;
  if (uv < 8) return 50;
  if (uv < 11) return 25;
  return 0;
}

function uvLevelText(uv) {
  if (uv == null || isNaN(uv)) return '—';
  if (uv < 3) return '低';
  if (uv < 6) return '中';
  if (uv < 8) return '高';
  if (uv < 11) return '很高';
  return '极端';
}

// AQI：中国标准档位
function scoreAQI(aqi) {
  if (aqi == null || isNaN(aqi)) return 50;
  if (aqi <= 50) return 100;
  if (aqi <= 100) return 75;
  if (aqi <= 150) return 45;
  if (aqi <= 200) return 20;
  return 0;
}

// ---------- 综合 ----------
// 输入 w: { tempC, uvIndex, aqi, rain2h, precipitation, weatherCode }（均可能缺省）
// 输出: { score, levelKey, level, color, tip, items: [{k,v,s}] }
function scoreWeather(w) {
  w = w || {};
  const sT = scoreTemp(w.tempC);
  const sR = scoreRain(w.rain2h, w.precipitation, w.weatherCode);
  const sU = scoreUV(w.uvIndex);
  const sA = scoreAQI(w.aqi);

  const score = round(sT * 0.3 + sR * 0.3 + sU * 0.2 + sA * 0.2);
  const lv =
    score >= 80 ? LEVELS.good :
    score >= 60 ? LEVELS.fair :
    score >= 40 ? LEVELS.normal : LEVELS.bad;

  const tempCap =
    w.tempC == null ? '—'
    : w.tempC >= 33 ? '高温' : w.tempC >= 29 ? '偏热'
    : w.tempC >= 16 ? '体感舒适'
    : w.tempC >= 8 ? '微凉' : '寒冷';
  const uvCap = { '低': '弱 · 防晒', '中': '中 · 帽子', '高': '强 · 避午', '很高': '很强 · 避午', '极端': '极端 · 别出门' }[uvLevelText(w.uvIndex)] || '—';
  const rainCap =
    w.rain2h == null ? '—'
    : w.rain2h >= 50 ? '2h 易有雨' : w.rain2h >= 30 ? '2h 或有雨' : '2h 无雨';
  const airCap = '空气 ' + aqiLevelText(w.aqi);
  const items = [
    { icon: 'thermo', v: w.tempC != null ? Math.round(w.tempC) + '°C' : '—', k: tempCap, s: sT },
    { icon: 'wind',   v: w.aqi != null ? 'AQI ' + w.aqi : '—', k: airCap, s: sA },
    { icon: 'sun',    v: w.uvIndex != null ? 'UV ' + (Math.round(w.uvIndex * 10) / 10) : '—', k: uvCap, s: sU },
    { icon: 'drop',   v: w.rain2h != null ? Math.round(w.rain2h) + '%' : '—', k: rainCap, s: sR },
  ];

  // 建议文案：优先讲最短板
  const weakest = Math.min(sT, sR, sU, sA);
  let tip;
  if (w.precipitation > 0 || w.rain2h >= 50) tip = '在下雨或马上有雨，今天改约室内吧';
  else if (sR === weakest && w.rain2h >= 30) tip = '可能有阵雨，出门带伞，留个室内备选';
  else if (sA === weakest && (w.aqi || 0) > 100) tip = '空气质量一般，户外别太久，敏感宝宝戴口罩';
  else if (sU === weakest && (w.uvIndex || 0) >= 6) tip = '紫外线强，避开正午，防晒帽安排上';
  else if (sT === weakest && (w.tempC || 0) >= 29) tip = '天气偏热，上午或傍晚出门更舒服';
  else if (sT === weakest) tip = '气温偏低，注意保暖，戴好帽子再出门';
  else if (lv === LEVELS.good) tip = '天时不错，适合带娃出门撒欢';
  else tip = '可以出门，注意补水休息';

  // 一句话大标题（v15 指数卡右侧 h2）
  const headline =
    lv === LEVELS.good ? '现在出门很合适' :
    lv === LEVELS.fair ? '适合出门遛一遛' :
    lv === LEVELS.normal ? '挑好时段再出门' : '今天先别出门啦';

  return {
    score,
    levelKey: lv.key,
    level: lv.label,
    color: lv.color,
    headline,
    tip,
    items,
    est: w.aqi != null && w.pmSource === 'estimated', // AQI 由浓度估算时提示
  };
}

// ---------- 出门时段推算 ----------
// 输入 hourly: { time:['2026-09-24T07:00',...], temp:[], uv:[], precipProb:[] }（Asia/Shanghai 本地时）
// 三个窗口：清晨 07:00–08:30 / 上午 09:00–11:00 / 傍晚 17:00–18:30
// 窗口分 = 温度均分 50% + UV 峰分 25% + 降水峰分 25%；返回三行（含"已过"标记与 best 标记）
function slotScores(hourly, now) {
  const base = [
    { t: '清晨', from: 7, to: 9,   n: '凉爽·人少' },
    { t: '上午', from: 9, to: 11,  n: '自然光足·护眼' },
    { t: '傍晚', from: 17, to: 19, n: '避高温·落日' },
  ];
  if (!hourly || !hourly.time || !hourly.time.length) return null;

  const today = hourly.time[0].slice(0, 10);
  const nowH = now != null ? now : new Date().getHours();
  const idxOf = (h) => hourly.time.findIndex((x) => x === today + 'T' + ('0' + h).slice(-2) + ':00');

  const rows = base.map((w) => {
    const idx = [];
    for (let h = w.from; h < w.to; h++) { const i = idxOf(h); if (i >= 0) idx.push(i); }
    if (!idx.length) return { t: w.t, v: ('0' + w.from).slice(-2) + ':00 – ' + ('0' + (w.to - 1)).slice(-2) + ':30', n: w.n, s: 50 };
    const temps = idx.map((i) => hourly.temp && hourly.temp[i]).filter((x) => x != null);
    const uvs = idx.map((i) => hourly.uv && hourly.uv[i]).filter((x) => x != null);
    const rains = idx.map((i) => hourly.precipProb && hourly.precipProb[i]).filter((x) => x != null);
    const avgT = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    const maxUV = uvs.length ? Math.max.apply(null, uvs) : null;
    const maxR = rains.length ? Math.max.apply(null, rains) : null;
    const s = round(scoreTemp(avgT) * 0.5 + scoreUV(maxUV) * 0.25 + scoreRain(maxR, 0, null) * 0.25);
    // 降水硬约束：窗口内降水概率 ≥50% 时分数封顶 40（带娃出门宁可保守），
    // 否则 25% 的降水权重压不住"凉快+UV低"的高分，60% 雨概率的窗口也会标"不错"
    const capped = maxR != null && maxR >= 50 ? Math.min(s, 40) : s;
    const past = nowH >= w.to;
    return { t: w.t, v: ('0' + w.from).slice(-2) + ':00 – ' + ('0' + (w.to - 1)).slice(-2) + ':30', n: past ? '已过' : w.n, s: capped, past: !!past };
  });

  const future = rows.filter((r) => !r.past);
  const pool = future.length ? future : rows;
  let best = pool[0];
  for (const r of pool) if (r.s > best.s) best = r;
  best.best = true;

  // 文案：分数 → 口语点评
  for (const r of rows) {
    if (r.past) continue;
    if (r.s >= 80) r.n = '很舒适·推荐';
    else if (r.s >= 60) r.n = '不错';
    else if (r.s >= 40) r.n = '一般·注意防护';
    else r.n = '不建议';
  }
  return rows;
}

module.exports = { scoreWeather, slotScores, aqiChina, aqiLevelText, uvLevelText, LEVELS };

// pages/index/index.js 首页（M2：接 local_spots 真实数据；M6+：遛娃指数接真实天气/UV/AQI）
const app = getApp();
const { palette } = require('../../utils/theme.js');
const { getWeather } = require('../../utils/weather.js');
const t6 = require('../../utils/t6.js');

// 月龄/岁数文案：<36 月显示「N月龄」，≥36 显示「N岁M个月」/「N岁」
function ageText(birth) {
  const ma = app.monthAge(birth);
  if (ma == null) return '';
  if (ma < 36) return ma + '月龄';
  const y = Math.floor(ma / 12);
  const m = ma % 12;
  return m ? y + '岁' + m + '个月' : y + '岁';
}

// 所在板块候选——数据源：PRD §7.1 + 小区示意图原图（2026-09-25 逐图核对补齐）。
// 半山按七苑细分列出（山泉居/海晴居/迎风阁/康怡雅园/倚云居/月明轩/晓峰园）；祈福半山臻品为半山南延新组团，归「大道沿线」组。
const BLOCK_GROUPS = [
  { g: '代表板块', items: ['蝶舞轩', '青怡居', '康怡居', '倚湖湾', '缤纷汇', '活力花园'] },
  {
    g: '半山七苑',
    items: ['山泉居', '海晴居', '迎风阁', '康怡雅园', '倚云居', '月明轩', '晓峰园'],
  },
  { g: '湖畔板块', items: ['翠湖居', '湖畔豪庭', '福临居', '湖景居', '天湖居'] },
  { g: '大道沿线 · 其他', items: ['绿怡居', '绿怡花园', '祈福名都', '名望天下', '祈福半山臻品'] },
  { g: 'A–E 区', items: ['A区', 'B区', 'C区', 'D区', 'E区'] },
];

Page({
  data: {
    greeting: '你好',
    babyName: '',
    updatedAt: '',
    indexPercent: 0,        // 户外完成度 0~100（挪到户外计时卡展示）
    indexTip: '',
    // M6+ 遛娃指数（环中心 + 四分项）
    idxScore: null,         // 0~100；未取到天气前为 null
    idxLoading: true,       // 天气获取中：指数卡显示卡内骨架
    idxLevel: '—',
    indexH2: '',            // v15 一句话大标题（如「现在出门很合适」）
    idxColor: '#2FB67C',    // 档位语义色（优绿/良黄绿/一般橙/不宜灰红）
    idxItems: [],           // [{k,v,s}] 温度/降水/UV/空气
    weatherMock: false,     // 数据来源为本地估算时，UI 诚实标注
    timerRunning: false,
    sessionText: '00:00',     // 本次计时时长（mm:ss），计时中实时刷新
    outdoorMin: 0,          // 今日有效户外（分钟，环中心大数字）
    ringTip: '开始计时，攒够自然光吧',  // v15 环卡右侧建议文案
    goalMin: 60,
    slots: [
      { t: '清晨', v: '07:00 – 08:30', n: '凉爽·人少' },
      { t: '上午', v: '09:00 – 11:00', n: '最佳·自然光足', best: true },
      { t: '傍晚', v: '17:00 – 18:30', n: '避高温·落日' },
    ],
    ready: false, // 首屏骨架屏开关：onReady 后置 true，仅首次绘制显示骨架
    // 顶部定位栏（v9 板块 + v15 宝宝胶囊）
    block: '',
    blockGroups: BLOCK_GROUPS,
    blockSheetOpen: false,
    babyChip: '',           // 顶部右侧胶囊文案：昵称 · 月龄/岁数
    babySheetOpen: false,
    babies: [],             // [{ name, birth, age, cur }]
    curIdx: 0,
    newName: '',
    newBirth: '',
    today: '',              // 日期 picker 上限
  },

  onLoad() {
    this.refreshGreeting();
    this.syncTopbar();
    this.syncOutdoor();
    this.refreshWeather();
  },

  onReady() {
    // ready=true 后 canvas 节点才随真实内容渲染；必须在渲染完成回调里画环，
    // 否则 createSelectorQuery 查不到节点 → 静默 return → 再进入时环空白
    this.setData({ ready: true }, () => {
      this.drawRing();
      this.drawOutRing();
    });
  },

  onShow() {
    this.setData({ theme: app.resolveTheme() });
    this.syncTopbar(); // 我的页可能改过宝宝资料，回来时刷新顶栏
    this.syncOutdoor();
  },

  onHide() {
    // 切到其他 tabBar 页：关闭残留弹层（否则切回时 blockSheetOpen / babySheetOpen 仍为 true，
    // 既锁住滚动，又让 canvas 保持 0 尺寸 → onShow 的 syncOutdoor 重绘会崩）。
    // 关闭后重绘：此时页面通常已不可见，canvas 尺寸为 0，绘制被守卫跳过，无害。
    this.setData({ blockSheetOpen: false, babySheetOpen: false }, () => this._redrawRings());
  },

  onUnload() {
    // 离开页面：结算本次计时（不 reset 全局，时长已按时间戳实时落账）
    this.pauseTimer();
  },

  // M6+：拉天气 → 遛娃指数评分 + 出门时段推算
  // 缓存由 utils/weather.js 模块级统一管理（30 分钟 TTL + 并发去重，与接种页共享同一次请求）
  async refreshWeather() {
    try {
      const bp = app.globalData.babyProfile || {};
      // 祈福新邨社区中心（站点级定位无必要，天气网格 ~1km 足够）
      const w = await getWeather(bp.lat || 22.963, bp.lng || 113.33);
      const idx = t6.scoreWeather(w);
      const slots = t6.slotScores(w.hourly) || this.data.slots;
      this._wxData = w;
      this.setData({
        idxScore: idx.score,
        idxLevel: idx.level,
        indexH2: idx.headline || '',
        idxColor: idx.color,
        idxItems: idx.items,
        indexTip: idx.tip,
        weatherMock: !!w.mock,
        slots: slots,
        idxLoading: false,
      }, () => {
        // 渲染完成回调里画环：避免节点未就位导致绘制静默失败
        this.drawRing();
        this.drawOutRing();
      });
    } catch (e) {
      // 三级降级内部已兜底，这里防御：失败也要撤掉加载骨架
      console.error('refreshWeather failed', e);
      this.setData({ idxLoading: false, weatherMock: true });
    }
  },

  // ============ 顶部定位栏（v9 板块 + v15 宝宝档案） ============

  // 同步板块 / 宝宝胶囊 / 宝宝列表视图模型
  syncTopbar() {
    const g = app.globalData;
    const babies = g.babies.map((b, i) => ({
      idx: i,
      name: b.name || '宝宝',
      birth: b.birth || '',
      age: ageText(b.birth),
      cur: i === g.babyIdx,
    }));
    const cur = app.curBaby();
    const chip = cur
      ? (cur.name || '宝宝') + (ageText(cur.birth) ? ' · ' + ageText(cur.birth) : '')
      : '添加宝宝';
    const d = new Date();
    this.setData({
      block: g.block || '',
      babies,
      curIdx: g.babyIdx,
      babyChip: chip,
      today: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2),
    });
  },

  // ---- 板块切换 sheet（v9）----
  openBlockSheet() { this.setData({ blockSheetOpen: true }); },
  // 关闭 sheet 后重绘两环：canvas 隐藏期间尺寸为 0、绘制被守卫跳过，重新显形必须补画
  closeBlockSheet() { this.setData({ blockSheetOpen: false }, () => this._redrawRings()); },
  pickBlock(e) {
    const b = e.currentTarget.dataset.b;
    app.setBlock(b);
    this.setData({ block: b, blockSheetOpen: false }, () => this._redrawRings());
  },

  // ---- 宝宝档案 sheet（v15）----
  openBabySheet() { this.setData({ babySheetOpen: true, newName: '', newBirth: '' }); },
  closeBabySheet() { this.setData({ babySheetOpen: false }, () => this._redrawRings()); },
  pickBaby(e) {
    const i = +e.currentTarget.dataset.i;
    if (i === app.globalData.babyIdx) { this.closeBabySheet(); return; }
    app.setBabyIdx(i);
    this.setData({ theme: app.resolveTheme() }); // 月龄变了，主题可能跟着切
    this.syncTopbar();
    this.refreshGreeting();
    this.closeBabySheet(); // 内部回调会重绘两环 → 环色随新主题更新
  },
  delBaby(e) {
    const i = +e.currentTarget.dataset.i;
    const g = app.globalData;
    if (g.babies.length <= 1) return;
    const name = g.babies[i].name;
    wx.showModal({
      title: '删除宝宝档案',
      content: '确定删除「' + name + '」吗？',
      confirmColor: '#E26D5C',
      success: (r) => {
        if (!r.confirm) return;
        app.removeBaby(i);
        this.setData({ theme: app.resolveTheme() });
        this.syncTopbar();
        this.refreshGreeting();
      },
    });
  },
  onNewName(e) { this.setData({ newName: e.detail.value }); },
  onNewBirth(e) { this.setData({ newBirth: e.detail.value }); },
  addBaby() {
    const name = (this.data.newName || '').trim();
    const birth = this.data.newBirth;
    if (!name) { wx.showToast({ title: '先填宝宝小名', icon: 'none' }); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) { wx.showToast({ title: '选一下出生日期', icon: 'none' }); return; }
    app.addBaby({ name, birth });
    this.setData({ theme: app.resolveTheme() });
    this.syncTopbar();
    this.refreshGreeting();
    this.closeBabySheet();
    wx.showToast({ title: '已添加「' + name + '」', icon: 'none' });
  },

  // sheet 内容区阻止冒泡（点内容不关闭）
  noop() {},

  refreshGreeting() {
    const h = new Date().getHours();
    const timeGreet = h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    const bp = app.globalData.babyProfile;
    const babyName = bp && bp.name ? bp.name : '';
    const d = new Date();
    const updatedAt = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' 更新';
    this.setData({ greeting: timeGreet, babyName, updatedAt });
  },

  // 同步全局户外计时 + 环/文案（v15 ring-card 口径：环中心=有效户外分钟数）
  syncOutdoor() {
    const o = app.globalData.outdoor || { outdoor: 0, goal: 60 };
    const goal = o.goal || 60;
    // 跨天：新的一天户外时长归零重算
    const day = this._dayKey();
    if (o.day !== day) { o.day = day; o.outdoor = 0; }
    const goalSec = goal * 60;
    let pct = Math.round((o.outdoor / goalSec) * 100);
    if (pct > 100) pct = 100;
    const outMin = Math.floor((o.outdoor || 0) / 60);
    const remain = Math.max(0, goal - outMin);
    const ringTip =
      outMin <= 0 ? '点下方按钮开始计时，出门攒自然光吧'
      : remain > 0 ? '今日已凑够 ' + outMin + ' 分钟自然光，再 ' + remain + ' 分钟就达标💪'
      : '今日户外已达标 ' + outMin + ' 分钟，晒得太棒了💪';
    this.setData({
      outdoorMin: outMin,
      goalMin: goal,
      indexPercent: pct,
      ringTip,
    });
    if (app.persistOutdoor) app.persistOutdoor();
    this.drawOutRing();
    if (this.data.idxScore == null) this.drawRing(); // 天气未回包前，指数环先按完成度走
  },

  // 户外计时：单模式，基于时间戳累计真实时长（跨后台/切页不丢，跨天自动重置）
  toggleTimer() {
    if (this.data.timerRunning) this.pauseTimer();
    else this.startTimer();
  },
  // 开始/继续：记下起点时间戳，每秒把「已累计 + 本次已进行」写入 globalData.outdoor
  startTimer() {
    const o = app.globalData.outdoor;
    const day = this._dayKey();
    if (o.day !== day) { o.day = day; o.outdoor = 0; }
    this._segStart = Date.now();
    this._segBase = o.outdoor;
    this.setData({ timerRunning: true });
    if (this._timer) clearInterval(this._timer);
    const tick = () => {
      const o = app.globalData.outdoor;
      const sec = Math.floor((Date.now() - this._segStart) / 1000);
      o.outdoor = this._segBase + sec;
      this.setData({ sessionText: this._fmt(sec) });
      this.syncOutdoor();
    };
    tick();
    this._timer = setInterval(tick, 1000);
  },
  pauseTimer() {
    // 结束本次计时：把当前秒数落账，停表，文案回到建议
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._segStart = null;
    this._segBase = null;
    this.setData({ timerRunning: false, sessionText: '00:00' });
    this.syncOutdoor();
    wx.showToast({ title: '已暂停，本次户外已记入', icon: 'none' });
  },
  _dayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  },
  _fmt(sec) {
    sec = sec || 0;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2);
  },

  // canvas 环形进度（通用）：底环 + 圆头进度环；lw 随环径等比（84px→7 / 112px→8）
  _paintRing(id, pct, color, baseColor, lw) {
    lw = lw || 7;
    const q = wx.createSelectorQuery();
    q.select(id).fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const w = res[0].width;
      const h = res[0].height;
      // 守卫①：canvas 被 hidden="{{blockSheetOpen || babySheetOpen}}"（index.wxml:35/74）隐藏时
      //   尺寸为 0。此处必须提前 return —— 否则 r = 0 - lw/2 - 1 会算出负数（户外环 lw=8 → -5），
      //   arc 会抛 IndexSizeError。守卫放在 canvas.width / ctx.scale 之前，避免留下半初始化状态。
      if (!w || !h) return;
      const dpr = ((wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio) || 2;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - lw / 2 - 1;
      // 守卫②：极小尺寸下 r 仍可能 ≤ 0，直接不画，避免 arc 再次抛错。
      if (r <= 0) return;
      ctx.clearRect(0, 0, w, h);
      // 底环
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = baseColor;
      ctx.lineWidth = lw;
      ctx.stroke();
      // 进度环
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.stroke();
    });
  },

  // 指数环：v15 原型环进度固定主题绿（档位语义由中心大字 + 分数 + 文案承载），底环 #CFE6DA
  drawRing() {
    const pal = palette(this.data.theme);
    const pct = (this.data.idxScore != null ? this.data.idxScore : this.data.indexPercent) / 100;
    this._paintRing('#indexRing', pct, pal.green, '#CFE6DA');
  },

  // sheet 关闭后补画两环（canvas 隐藏期间尺寸为 0，绘制被守卫跳过，重新显形需主动重绘）
  _redrawRings() {
    this.drawRing();
    this.drawOutRing();
  },

  // 户外环（v15 ring-card 截图比例）：绿色 + sand 底，112px 环配 8px 描边
  drawOutRing() {
    const pal = palette(this.data.theme);
    this._paintRing('#outRing', (this.data.indexPercent || 0) / 100, pal.green, '#F4F2EC', 8);
  },

  goElder() { wx.navigateTo({ url: '/pages/elder/index' }); },
});

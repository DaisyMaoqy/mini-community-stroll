// pages/elder-map —— 关怀版「遛娃」页（大字列表 + 带我去）
//
// 数据源与标准版地图页一致：callCloud('spots', { action: 'list' }) 过滤 type === '遛娃'，
// 距离复用 utils/routePlan.js。**本页不渲染地图**（关怀版不给老人拖地图，只给列表 + 一键导航）。
//
// 与原型 v11 的差别（刻意取舍，不是漏做）：
//   ① 原型 #tab-map 顶部有「🌳遛娃 / 💉接种」筛选 seg。这里**不做** —— 接种已有独立 tab
//      （elder-tabbar 的「接种」），再放一个 seg 是重复入口，且加一层筛选违背关怀版「少层级」。
//   ② 原型点卡片弹路线 sheet（多步骤）。这里改成卡片上给一句话「怎么去」+「带我去」大按钮
//      直接开原生地图：老人不会读「先坐 2 号线到交通中心换乘」，一句话 + 开地图更实用。
//
// 三个 data-* 必须齐全，原因见 pages/elder-vac/index.js 顶部注释。
const app = getApp();
const { callCloud } = require('../../utils/cloud.js');
const { planRoute, planRouteBlockless } = require('../../utils/routePlan.js');
const { howText, baseRow } = require('../../utils/elderSpots.js');

Page({
  data: {
    efont: 'lg',       // 'std' | 'lg' | 'xl'
    econtrast: 'high', // 'high' | 'normal'
    block: '',
    loading: true,
    loadError: false,
    list: [],
  },

  _seq: 0,
  _raw: [],

  onLoad() {
    this.syncPrefs();
    this.load();
  },

  onShow() {
    this.syncPrefs();
  },

  syncPrefs() {
    const g = (app && app.globalData) || {};
    const f = (g.elderFont === 'std' || g.elderFont === 'xl') ? g.elderFont : 'lg';
    this.setData({
      efont: f,
      econtrast: g.elderContrast === false ? 'normal' : 'high',
      block: g.block || '',
    });
  },

  async load() {
    const seq = ++this._seq;
    this.setData({ loading: true, loadError: false });
    try {
      const res = await callCloud('spots', { action: 'list' });
      if (seq !== this._seq) return;
      const raw = ((res && res.list) || []).filter((s) => s.type === '遛娃');
      this._raw = raw;
      this.setData({ list: raw.map((s) => baseRow(s)), loading: false });
      await this.fillRoutes(seq);
    } catch (e) {
      console.error('[elder-map] 加载遛娃点失败', e);
      if (seq !== this._seq) return;
      this.setData({ loading: false, loadError: true });
    }
  },

  // 串行补「怎么去」：12 个点若并发打 route 云函数会被限流（照标准版 pages/map 的惯例）。
  // 每个点算完立即 setData 单条回填，让列表逐条「活起来」，不必等全部算完。
  async fillRoutes(seq) {
    // 直接读 globalData，不读 this.data.block：syncPrefs 是 setData（异步桥调用），
    // onLoad 里 syncPrefs() 紧接 load()，fillRoutes 执行时 this.data.block 未必已刷新。
    // 读成空串会退化成「用宝宝坐标而非板块坐标」算距离，且没有任何报错。
    const g = (app && app.globalData) || {};
    const block = g.block || this.data.block || '';
    const bp = (app && app.curBaby && app.curBaby()) || null;
    const raw = this._raw || [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      if (!s.coord || !s.coord.coordinates) continue;
      let plan = null;
      try {
        plan = block
          ? await planRoute(block, s)
          : await planRouteBlockless((bp && bp.lat) || 22.963, (bp && bp.lng) || 113.33, s);
      } catch (e) {
        // 单个点失败不影响整体
      }
      if (seq !== this._seq) return;
      if (!plan) continue;
      const patch = {};
      patch['list[' + i + '].how'] = howText(plan);
      this.setData(patch);
    }
  },

  onRetry() {
    this.load();
  },

  onNav(e) {
    const v = (this.data.list || [])[Number(e.currentTarget.dataset.idx)];
    if (!v || v.lat == null || v.lng == null) {
      wx.showToast({ title: '暂无坐标', icon: 'none' });
      return;
    }
    wx.openLocation({
      latitude: v.lat,
      longitude: v.lng,
      name: v.name,
      address: v.address || '',
      scale: 15,
    });
  },
});

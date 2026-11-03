// pages/elder-vac —— 关怀版「接种」页（大字列表 + 带我去 + 粤苗）
//
// 数据源与标准版接种页完全一致：callCloud('spots', { action: 'list' }) 过滤 type === '接种'，
// 距离复用 utils/routePlan.js（云函数 route 走腾讯 walking，失败降级 haversine×1.3）。
//
// 与标准版 pages/vaccine 的差别（按关怀版「少层级」原则刻意简化，不是缺功能）：
//   ① 不做「全部 / 儿童 / 成人」分类 tab —— 只有 3 个接种点，老人只需要「最近的在哪、怎么去」
//   ② 不展开多步骤路线，卡片上给一句话「怎么去」+ 一个「带我去」大按钮直接开原生地图
//   ③ 电话按钮只在 POI 有 phone 字段时出现。当前种子数据全部无 phone（不编造号码），
//      所以现阶段不会渲染；运营补了 phone 会自动出现
//
// 三个 data-* 必须齐全：styles/theme.wxss 的字号三档/对比度两档是复合属性选择器，
// 缺一个就整块不命中、字号掉回标准版 —— 关怀版核心诉求就是字大。
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

  _seq: 0,   // 请求序号：丢弃过期响应
  _raw: [],  // 原始 POI（与 data.list 同下标，供 fillRoutes 按下标回填 how）

  onLoad() {
    this.syncPrefs();
    this.load();
  },

  onShow() {
    // 在关怀版「我的」改完字号/对比度后返回本页要立即生效
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
      const raw = ((res && res.list) || []).filter((s) => s.type === '接种');
      this._raw = raw;
      // 先出列表（「怎么去」留空），再串行补距离 —— 先渲染能消除长时间白屏
      this.setData({ list: raw.map((s) => baseRow(s, 'vacName')), loading: false });
      await this.fillRoutes(seq);
    } catch (e) {
      console.error('[elder-vac] 加载接种点失败', e);
      if (seq !== this._seq) return;
      this.setData({ loading: false, loadError: true });
    }
  },

  // 串行补「怎么去」：route 是云函数，并发多了会限流（照标准版 pages/map 的惯例）
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
        // 单个点失败不影响整体：卡片其余信息照常显示
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

  // 带我去：调起原生地图（coord 已是 gcj02，与微信地图同坐标系）
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

  // 打电话：仅有真实号码时才渲染该按钮。用户点取消会走 fail，不提示（取消不是错误）
  onCall(e) {
    const v = (this.data.list || [])[Number(e.currentTarget.dataset.idx)];
    if (!v || !v.phone) return;
    wx.makePhoneCall({ phoneNumber: String(v.phone), fail: function () {} });
  },

  // 粤苗：跳外部小程序需要粤苗官方 appid + 用户授权，本轮未接
  onYueMiao() {
    wx.showToast({ title: '即将支持', icon: 'none' });
  },
});

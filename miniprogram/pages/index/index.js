// pages/index/index.js 首页（M2：接 local_spots 真实数据）
const app = getApp();
const { palette } = require('../../utils/theme.js');

function fmt(sec) {
  sec = sec || 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2);
}

Page({
  data: {
    greeting: '你好',
    babyName: '',
    updatedAt: '',
    indexPercent: 0,        // 户外完成度 0~100（环进度）
    indexTip: '',
    timerRunning: false,
    timerMode: 'outdoor',   // 当前计时模式：outdoor / indoor
    indoorText: '00:00',
    outdoorText: '00:00',
    goalMin: 60,
    slots: [
      { t: '清晨', v: '07:00 – 08:30', n: '凉爽·人少' },
      { t: '上午', v: '09:00 – 11:00', n: '最佳·自然光足', best: true },
      { t: '傍晚', v: '17:00 – 18:30', n: '避高温·落日' },
    ],
    ready: false, // 首屏骨架屏开关：onReady 后置 true，仅首次绘制显示骨架
  },

  onLoad() {
    this.refreshGreeting();
    this.syncOutdoor();
  },

  onReady() {
    this.drawRing();
    // 首屏布局/Canvas 就位后再切真实内容，首帧显示骨架而非空白
    this.setData({ ready: true });
  },

  onShow() {
    this.setData({ theme: app.resolveTheme() });
    this.syncOutdoor();
  },

  onUnload() {
    this.stopTimer();
  },

  refreshGreeting() {
    const h = new Date().getHours();
    const timeGreet = h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    const bp = app.globalData.babyProfile;
    const babyName = bp && bp.name ? bp.name : '';
    const d = new Date();
    const updatedAt = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' 更新';
    this.setData({ greeting: timeGreet, babyName, updatedAt });
  },

  // 同步全局户外计时 + 刷新环进度（indoor/outdoor 以秒计）
  syncOutdoor() {
    const o = app.globalData.outdoor || { indoor: 0, outdoor: 0, goal: 60 };
    const goalSec = (o.goal || 60) * 60;
    let pct = Math.round((o.outdoor / goalSec) * 100);
    if (pct > 100) pct = 100;
    const tip = pct >= 100 ? '今天户外达标，太棒了！'
      : pct >= 60 ? '还差一点就达标啦，出门转转～'
      : pct >= 30 ? '今天户外还不多，趁好天气出门吧'
      : '多带娃出门晒晒太阳吧';
    this.setData({
      indoorText: fmt(o.indoor),
      outdoorText: fmt(o.outdoor),
      indexPercent: pct,
      indexTip: tip,
      goalMin: o.goal || 60,
    });
    this.drawRing();
  },

  // 户外计时
  toggleTimer() {
    if (this.data.timerRunning) this.stopTimer();
    else this.startTimer();
  },
  startTimer() {
    this.setData({ timerRunning: true });
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      const o = app.globalData.outdoor;
      if (this.data.timerMode === 'outdoor') o.outdoor += 1;
      else o.indoor += 1;
      this.syncOutdoor();
    }, 1000);
  },
  stopTimer() {
    this.setData({ timerRunning: false });
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },
  switchMode() {
    const mode = this.data.timerMode === 'outdoor' ? 'indoor' : 'outdoor';
    this.setData({ timerMode: mode });
  },

  // canvas 环形进度（底环 + 进度环），84px 视口对齐 v15
  drawRing() {
    const q = wx.createSelectorQuery();
    q.select('#indexRing').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const w = res[0].width;
      const h = res[0].height;
      const dpr = ((wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio) || 2;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
      const pal = palette(this.data.theme);
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 7;
      ctx.clearRect(0, 0, w, h);
      // 底环
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = pal.greenL2; // --green-l2（随主题）
      ctx.lineWidth = 7;
      ctx.stroke();
      // 进度环
      const pct = this.data.indexPercent / 100;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
      ctx.strokeStyle = pal.greenD; // --green-d（随主题）
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.stroke();
    });
  },

  goElder() { wx.navigateTo({ url: '/pages/elder/index' }); },
});

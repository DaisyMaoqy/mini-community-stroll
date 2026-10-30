// pages/elder-map —— 关怀版「遛娃」页（本轮占位，下一轮填大字列表 + 路线）
// 三个 data-* 必须齐全，原因见 pages/elder-vac/index.js 顶部注释。
const app = getApp();

Page({
  data: {
    efont: 'lg',      // 'std' | 'lg' | 'xl'
    econtrast: 'high' // 'high' | 'normal'
  },

  onShow() {
    this.syncPrefs();
  },

  syncPrefs() {
    const g = (app && app.globalData) || {};
    const f = (g.elderFont === 'std' || g.elderFont === 'xl') ? g.elderFont : 'lg';
    this.setData({
      efont: f,
      econtrast: g.elderContrast === false ? 'normal' : 'high'
    });
  },

  goHome() {
    wx.redirectTo({ url: '/pages/elder-home/index' });
  }
});

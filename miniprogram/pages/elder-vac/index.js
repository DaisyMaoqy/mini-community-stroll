// pages/elder-vac —— 关怀版「接种」页（本轮占位，下一轮填大字列表 + 一键电话）
//
// 三个 data-* 必须齐全：styles/theme.wxss 里的字号三档与对比度两档是
// [data-theme="elder"][data-font="x"][data-contrast="y"] 复合属性选择器，缺一个就不命中，
// 字号会掉回标准版大小 —— 关怀版最核心的诉求就是字大，这里不能错。
const app = getApp();

Page({
  data: {
    efont: 'lg',      // 'std' | 'lg' | 'xl'
    econtrast: 'high' // 'high' | 'normal'
  },

  onShow() {
    this.syncPrefs();
  },

  // 从全局偏好同步（在关怀版「我的」改完字号/对比度后返回本页要立即生效）
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

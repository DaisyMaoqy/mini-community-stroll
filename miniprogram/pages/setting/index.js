// pages/setting/index.js 设置（本期：审核入口迁移 + 关于占位）
const app = getApp();
const { callCloud } = require('../../utils/cloud.js');

// 关于分组展示的版本号（本期仅做占位展示，不接入真实功能）
const APP_VERSION = '0.1.0';

Page({
  data: {
    // 当前视觉主题：随月龄/手动档解析（与「我的」页等保持一致）
    theme: 'toddler',
    // 版本号（「关于」分组展示）
    version: APP_VERSION,
    // 是否运营（审核入口显隐）：onShow 调 whoami 探测，非 admin 完全不渲染入口行
    isAdmin: false,
  },

  onShow() {
    // 主题随宝宝资料/手动档变化即时刷新
    this.setData({ theme: app.resolveTheme() });
    // 提权探测（独立于主题渲染，失败静默降级，不阻塞设置页其余内容）
    this.checkAdmin();
  },

  // 调 reports.whoami 探测是否运营；失败静默降级为 false（不显示入口）
  checkAdmin() {
    callCloud('reports', { action: 'whoami' })
      .then((res) => {
        this.setData({ isAdmin: !!(res && res.isAdmin) });
      })
      .catch(() => {
        this.setData({ isAdmin: false });
      });
  },

  // 进入纠错审核页（仅 admin 可见入口行）
  goReview() {
    wx.navigateTo({ url: '/pages/review/index' });
  },
});

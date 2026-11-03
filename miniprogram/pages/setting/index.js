// pages/setting/index.js 设置（本期：每日提醒设置 + 审核入口迁移 + 关于占位）
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
    // 每日提醒设定：{ on, time }；唯一数据源 = app.globalData.reminder（本页不直接读 storage，避免双源不一致）
    reminder: { on: false, time: '09:00' },
  },

  onShow() {
    // 提醒设定统一从 globalData 读回（setter 已写、冷启动由 loadPersisted 写回、云端覆盖由 applyCloudProfile 写回）
    const r = app.globalData.reminder || {};
    // 主题随宝宝资料/手动档变化即时刷新
    this.setData({
      theme: app.resolveTheme(),
      reminder: { on: !!r.on, time: r.time || '09:00' },
    });
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

  // 开/关每日提醒：e.detail.value 为布尔；调 app.setReminder 后用其返回值立刻回显
  onToggle(e) {
    const on = !!(e.detail && e.detail.value);
    this.setData({ reminder: app.setReminder({ on }) });
  },

  // 选择提醒时间：e.detail.value 为 'HH:mm'；app.setReminder 内部做白名单校验，非法回落 '09:00'
  onTimeChange(e) {
    const time = e.detail && e.detail.value;
    this.setData({ reminder: app.setReminder({ time }) });
  },

  // 进入纠错审核页（仅 admin 可见入口行）
  goReview() {
    wx.navigateTo({ url: '/pages/review/index' });
  },
});

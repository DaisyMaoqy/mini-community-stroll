// pages/elder-me —— 关怀版「我的」（设置）
//
// 版式对齐 UI原型_v11_关怀版 #tab-me：板块条 → 字号三档 / 高对比 / 语音播报 →
// 所在板块 → 家人帮忙 → 退出关怀版。
//
// 字号与对比度写全局偏好（app.setElderFont / setElderContrast），改完立刻 setData，
// 本页与其余三个关怀版页面都会在 onShow 里 syncPrefs 重新读一遍，所以返回即生效。
const app = getApp();

Page({
  data: {
    efont: 'lg',      // 'std' | 'lg' | 'xl'
    econtrast: 'high', // 'high' | 'normal'
    block: '',
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
      block: g.block || ''
    });
  },

  // 字号三档：setElderFont 内部有白名单兜底，非法值一律回落「大」
  setFont(e) {
    const f = e.currentTarget.dataset.f;
    if (app && app.setElderFont) app.setElderFont(f);
    const g = (app && app.globalData) || {};
    this.setData({ efont: (g.elderFont === 'std' || g.elderFont === 'xl') ? g.elderFont : 'lg' });
  },

  toggleContrast() {
    const next = !(this.data.econtrast === 'high');
    if (app && app.setElderContrast) app.setElderContrast(next);
    this.setData({ econtrast: next ? 'high' : 'normal' });
  },

  // 语音播报：小程序无原生 TTS，真朗读要接「微信同声传译」插件。本轮占位（开关恒为关且置灰）
  onSpeak() {
    wx.showToast({ title: '即将支持', icon: 'none' });
  },

  // 板块切换在标准版首页（那里有板块 sheet），关怀版不重复实现一份
  goBlock() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 家人帮忙（亲友代办）：PRD 里有但属 v15 缺口模块，本轮占位
  onInvite() {
    wx.showToast({ title: '即将支持', icon: 'none' });
  },

  // 退出关怀版：回到标准版首页。字号/对比度设置会保留（storage 不清），
  // 下次再进关怀版仍是上次的档位。
  onExit() {
    wx.showModal({
      title: '退出关怀版',
      content: '回到标准版界面？您的字号与对比度设置会保留，下次进来还在。',
      confirmText: '退出', // ⚠️ showModal 的 confirmText/cancelText 硬上限 4 个字符
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        if (app && app.setElderMode) app.setElderMode(false);
        wx.reLaunch({ url: '/pages/index/index' });
      },
    });
  },
});

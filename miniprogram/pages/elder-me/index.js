// pages/elder-me —— 关怀版「我的」（设置）
//
// 版式对齐 UI原型_v11_关怀版 #tab-me：板块条 → 字号三档 / 高对比 / 语音播报 →
// 所在板块 → 家人帮忙 → 退出关怀版。
//
// 字号与对比度写全局偏好（app.setElderFont / setElderContrast），改完立刻 setData，
// 本页与其余三个关怀版页面都会在 onShow 里 syncPrefs 重新读一遍，所以返回即生效。
const app = getApp();
const speech = require('../../utils/speech.js');

Page({
  data: {
    efont: 'lg',      // 'std' | 'lg' | 'xl'
    econtrast: 'high', // 'high' | 'normal'
    block: '',
    speechAvailable: false, // 插件未添加时为 false：开关保持置灰、不承诺能播
  },

  onShow() {
    this.syncPrefs();
    // 每次进页面重读一次（探测结果在 speech.js 内只做一次并缓存，开销可忽略）；
    // 后台添加插件并重新编译后，无需改本页代码，开关会自动变为可用。
    this.setData({ speechAvailable: speech.available() });
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

  // 语音播报试听：这里【不做】自动播报的持久化偏好 —— 项目铁律是偏好 setter
  // 必须与 loadPersisted() 成对，本期不扩张这块；不写 storage、不调 app.js 的偏好 setter。
  // 开关点一下只念一句示例，是否听首页播报由首页那次点击决定。
  onSpeak() {
    if (!speech.available()) {
      wx.showToast({ title: '语音播报暂未开通', icon: 'none' });
      return;
    }
    const ok = speech.speak('语音播报已开通，首页可以听今天的天气');
    if (!ok) {
      wx.showToast({ title: '播报没能开始，请稍后再点', icon: 'none' });
    }
  },

  // 板块切换在标准版首页（那里有板块 sheet），关怀版不重复实现一份
  goBlock() {
    wx.switchTab({ url: '/pages/index/index' });
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
        // 不写 elderMode：它是「我的」页「启用关怀模式」开关的持久偏好，退出关怀版不等于
        // 关掉关怀模式。写 false 会让「我的」页开关跟着关掉、字号/对比度设置区整块收起，
        // 用户以为设置被吞了。字号与对比度本身存在 elderFont / elderContrast，不受影响。
        wx.reLaunch({ url: '/pages/index/index' });
      },
    });
  },
});

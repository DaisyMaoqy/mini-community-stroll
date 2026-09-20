// pages/mine/index.js 我的（M5-lite：宝宝资料 + 成长主题）
const app = getApp();

function todayStr() {
  const d = new Date();
  const p = (n) => ('0' + n).slice(-2);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

Page({
  data: {
    babyName: '未设置宝宝',
    monthAgeText: '宝宝档案 · 设置提醒',
    profileName: '',
    birth: '',
    today: todayStr(),
    monthAge: null,
    theme: 'toddler',
    themeMode: 'auto',
  },

  onShow() {
    const bp = app.globalData.babyProfile;
    const profileName = (bp && bp.name) || '';
    const birth = (bp && bp.birth) || '';
    const monthAge = app.monthAge(birth);
    const themeMode = app.globalData.themeMode || 'auto';
    const monthAgeText = monthAge == null ? '宝宝档案 · 设置提醒' : ('当前 ' + monthAge + ' 月龄');
    this.setData({
      babyName: profileName || '未设置宝宝',
      profileName,
      birth,
      monthAge,
      monthAgeText,
      themeMode,
      theme: app.resolveTheme(),
    });
  },

  onNameInput(e) {
    this.setData({ profileName: e.detail.value });
  },

  onBirthChange(e) {
    const birth = e.detail.value;
    const monthAge = app.monthAge(birth);
    const patch = { birth, monthAge };
    // 自动档下，生日变化即时反映主题
    if ((app.globalData.themeMode || 'auto') === 'auto') {
      patch.theme = app.resolveTheme();
    }
    this.setData(patch);
  },

  saveProfile() {
    const profile = app.globalData.babyProfile || {};
    profile.name = this.data.profileName;
    profile.birth = this.data.birth;
    app.saveBabyProfile(profile);
    this.setData({ babyName: profile.name || '未设置宝宝', theme: app.resolveTheme() });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  onThemeTap(e) {
    const mode = e.currentTarget.dataset.mode;
    app.setThemeMode(mode);
    this.setData({ themeMode: mode, theme: app.resolveTheme() });
  },

  goElder() {
    wx.navigateTo({ url: '/pages/elder/index' });
  },
  goSetting() {
    wx.showToast({ title: '设置（M5 接入）', icon: 'none' });
  },
});

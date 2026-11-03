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
    // 关怀版偏好（M5）：只影响独立关怀版页面，标准版四个 tab 页不变
    elderMode: false,
    elderFont: 'lg',
    elderContrast: true,
    elderFontLabel: '大',
    elderContrastLabel: '高对比',
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
    const prefs = app.elderPrefs ? app.elderPrefs() : { mode: false, font: 'lg', contrast: true };
    const FONT_LABEL = { std: '标准', lg: '大', xl: '特大' };
    this.setData({
      elderMode: prefs.mode,
      elderFont: prefs.font,
      elderContrast: prefs.contrast,
      elderFontLabel: FONT_LABEL[prefs.font] || '大',
      elderContrastLabel: prefs.contrast ? '高对比' : '标准对比',
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

  // 关怀模式总开关（只落本地 storage，不进云端同步）
  onElderModeChange(e) {
    const on = !!(e.detail && e.detail.value);
    app.setElderMode(on);
    this.setData({ elderMode: on });
  },

  // 字号三档；开关关闭时禁止改动（pointer-events 在部分渲染器不可靠，必须 JS 守卫）
  onElderFontTap(e) {
    if (!this.data.elderMode) return;
    const f = e.currentTarget.dataset.font;
    if (f !== 'std' && f !== 'lg' && f !== 'xl') return;
    app.setElderFont(f);
    const FONT_LABEL = { std: '标准', lg: '大', xl: '特大' };
    this.setData({ elderFont: f, elderFontLabel: FONT_LABEL[f] });
  },

  // 高对比配色；同样带开关守卫
  onElderContrastChange(e) {
    if (!this.data.elderMode) return;
    const on = !!(e.detail && e.detail.value);
    app.setElderContrast(on);
    this.setData({ elderContrast: on, elderContrastLabel: on ? '高对比' : '标准对比' });
  },

  goElder() {
    // 只跳转，不写 elderMode —— elderMode 是本页开关「是否启用关怀模式」的持久偏好，
    // 进关怀版不等于启用它（用户也可能是从首页入口进来的）。详见 app.js setElderMode 上方注释。
    // 用 navigateTo 保留返回栈：我的页是 tab 页，这样从关怀版返回能直接回到标准版「我的」
    wx.navigateTo({ url: '/pages/elder-home/index' });
  },
  goSetting() {
    wx.navigateTo({ url: '/pages/setting/index' });
  },
});

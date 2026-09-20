// app.js
App({
  onLaunch: function () {
    this.globalData = {
      env: "cloud1-d1gxzmgkie0e81cac",
      // 宝宝档案（M5 我的页录入；M2 首页户外计时/个性化关联）
      babyProfile: null, // { name, birth, gender, ... }
      // 关怀大字模式开关（M5/M6 切换并写入 storage）
      elderMode: false,
      // 成长主题模式：'auto' 按月龄自动切换；'infant' / 'toddler' 为手动覆盖
      themeMode: 'auto',
      // 户外陪伴计时（M2 首页双环：室内/室外累计分钟 + 每日目标）
      outdoor: { indoor: 0, outdoor: 0, goal: 60 },
    };
    this.loadPersisted();
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
  },

  // 从本地存储恢复用户设置（M5）
  loadPersisted() {
    try {
      const babyProfile = wx.getStorageSync('babyProfile') || null;
      const themeMode = wx.getStorageSync('themeMode') || 'auto';
      const elderMode = wx.getStorageSync('elderMode') || false;
      this.globalData.babyProfile = babyProfile;
      this.globalData.themeMode = themeMode;
      this.globalData.elderMode = elderMode;
    } catch (e) {
      console.error('读取本地设置失败', e);
    }
  },

  // 由生日(YYYY-MM-DD)推算整月月龄；解析失败或为空返回 null
  monthAge(birth) {
    if (!birth) return null;
    let by, bm, bd;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
    if (m) {
      by = +m[1]; bm = +m[2]; bd = +m[3];
    } else {
      const d = new Date(birth);
      if (isNaN(d.getTime())) return null;
      by = d.getFullYear(); bm = d.getMonth() + 1; bd = d.getDate();
    }
    const now = new Date();
    let months = (now.getFullYear() - by) * 12 + (now.getMonth() + 1 - bm);
    if (now.getDate() < bd) months -= 1;
    return Math.max(0, months);
  },

  // 解析当前主题：auto 按月龄(<18 婴儿期 / ≥18 幼儿期)，否则用手动档；未设生日默认幼儿期(墨绿)
  resolveTheme() {
    const mode = this.globalData.themeMode || 'auto';
    if (mode === 'infant' || mode === 'toddler') return mode;
    const bp = this.globalData.babyProfile;
    const ma = this.monthAge(bp && bp.birth);
    if (ma == null) return 'toddler';
    return ma >= 18 ? 'toddler' : 'infant';
  },

  saveBabyProfile(profile) {
    this.globalData.babyProfile = profile;
    try { wx.setStorageSync('babyProfile', profile); } catch (e) { console.error(e); }
  },

  setThemeMode(mode) {
    this.globalData.themeMode = mode;
    try { wx.setStorageSync('themeMode', mode); } catch (e) { console.error(e); }
  },
});

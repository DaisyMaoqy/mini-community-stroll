// app.js
App({
  onLaunch: function () {
    this.globalData = {
      env: "cloud1-d1gxzmgkie0e81cac",
      // 宝宝档案（v15 活数据：多宝宝切换/添加/删除；babyProfile 恒指向当前宝宝，兼容旧页面）
      babies: [],        // [{ name, birth, gender?, lat?, lng? }]
      babyIdx: 0,        // 当前宝宝下标
      babyProfile: null, // 派生字段 = babies[babyIdx]（我的页等旧代码仍读写它）
      // 所在板块（v9 定位栏：首页顶部左侧，点击底部 sheet 切换）
      block: "",
      // 关怀大字模式开关（M5/M6 切换并写入 storage）
      elderMode: false,
      // 成长主题模式：'auto' 按月龄自动切换；'infant' / 'toddler' 为手动覆盖
      themeMode: 'auto',
      // 户外陪伴计时（M2 首页环：有效户外累计秒 + 每日目标；day 用于跨天重置）
      outdoor: { outdoor: 0, goal: 60, day: '' },
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

  // 从本地存储恢复用户设置（M5；多宝宝 + 板块，含旧单档案迁移）
  loadPersisted() {
    try {
      const themeMode = wx.getStorageSync('themeMode') || 'auto';
      const elderMode = wx.getStorageSync('elderMode') || false;
      const block = wx.getStorageSync('block') || '';
      // babies：优先新结构；否则迁移旧的单 babyProfile
      let babies = wx.getStorageSync('babies');
      if (!Array.isArray(babies)) {
        const legacy = wx.getStorageSync('babyProfile');
        babies = legacy && legacy.name ? [legacy] : [];
      }
      const babyIdx = Math.min(
        Math.max(0, +wx.getStorageSync('babyIdx') || 0),
        Math.max(0, babies.length - 1)
      );
      // outdoor：恢复今日户外累计（跨天由 index 页按 day 字段重置）
      const savedOutdoor = wx.getStorageSync('outdoor');
      if (savedOutdoor && typeof savedOutdoor === 'object') {
        this.globalData.outdoor = Object.assign(this.globalData.outdoor, savedOutdoor);
      }
      this.globalData.themeMode = themeMode;
      this.globalData.elderMode = elderMode;
      this.globalData.block = block;
      this.globalData.babies = babies;
      this.globalData.babyIdx = babyIdx;
      this.globalData.babyProfile = babies[babyIdx] || null;
    } catch (e) {
      console.error('读取本地设置失败', e);
    }
  },

  // 当前宝宝（快捷访问）
  curBaby() {
    const g = this.globalData;
    return g.babies[g.babyIdx] || null;
  },

  // 持久化宝宝列表 + 当前下标
  persistBabies() {
    try {
      wx.setStorageSync('babies', this.globalData.babies);
      wx.setStorageSync('babyIdx', this.globalData.babyIdx);
    } catch (e) { console.error(e); }
  },

  // 持久化今日户外计时（index 页每次 syncOutdoor 调用）
  persistOutdoor() {
    try { wx.setStorageSync('outdoor', this.globalData.outdoor); } catch (e) { console.error(e); }
  },

  // 切换当前宝宝（首页顶部胶囊 / 宝宝 sheet 调用）
  setBabyIdx(i) {
    const g = this.globalData;
    g.babyIdx = Math.min(Math.max(0, i), Math.max(0, g.babies.length - 1));
    g.babyProfile = g.babies[g.babyIdx] || null;
    this.persistBabies();
  },

  // 添加宝宝并设为当前（返回新下标）
  addBaby(profile) {
    const g = this.globalData;
    g.babies.push(profile);
    g.babyIdx = g.babies.length - 1;
    g.babyProfile = profile;
    this.persistBabies();
    return g.babyIdx;
  },

  // 删除宝宝；至少保留一个，删除成功返回 true
  removeBaby(i) {
    const g = this.globalData;
    if (g.babies.length <= 1) return false;
    g.babies.splice(i, 1);
    if (g.babyIdx >= g.babies.length) g.babyIdx = g.babies.length - 1;
    if (g.babyIdx > i && i < g.babyIdx) g.babyIdx -= 1;
    else if (g.babyIdx === i) g.babyIdx = Math.min(i, g.babies.length - 1);
    g.babyProfile = g.babies[g.babyIdx] || null;
    this.persistBabies();
    return true;
  },

  // 设置所在板块（v9 定位栏）
  setBlock(block) {
    this.globalData.block = block || '';
    try { wx.setStorageSync('block', this.globalData.block); } catch (e) { console.error(e); }
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

  // 保存当前宝宝资料（我的页兼容入口：写入 babies 当前位并持久化）
  saveBabyProfile(profile) {
    const g = this.globalData;
    if (g.babies.length) {
      g.babies[g.babyIdx] = profile;
    } else {
      g.babies.push(profile);
      g.babyIdx = 0;
    }
    g.babyProfile = profile;
    this.persistBabies();
  },

  setThemeMode(mode) {
    this.globalData.themeMode = mode;
    try { wx.setStorageSync('themeMode', mode); } catch (e) { console.error(e); }
  },
});

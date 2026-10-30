// app.js
const userSync = require('./utils/userSync.js');

// 生成宝宝稳定 id（b_<ts36>_<rand5>）：跨端同步以 id 为权威引用，解决下标错位改错人的问题
function genBabyId() {
  return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

App({
  onLaunch: function () {
    this.globalData = {
      env: "cloud1-d1gxzmgkie0e81cac",
      // 宝宝档案（v15 活数据：多宝宝切换/添加/删除；babyProfile 恒指向当前宝宝，兼容旧页面）
      babies: [],        // [{ id, name, birth, gender?, lat?, lng? }] —— 每项含稳定 id（跨端同步的权威引用）
      babyIdx: 0,        // 当前宝宝下标（派生值：由 curBabyId 解析，字段名与语义不变）
      curBabyId: '',     // 当前宝宝稳定 id（持久化与跨端同步的唯一权威引用）
      babyProfile: null, // 派生字段 = babies[babyIdx]（我的页等旧代码仍读写它）
      // 所在板块（v9 定位栏：首页顶部左侧，点击底部 sheet 切换）
      block: "",
      // 关怀大字模式开关（M5/M6 切换并写入 storage）
      elderMode: false,
      // 关怀版字号档：'std' | 'lg' | 'xl'（默认「大」）
      elderFont: 'lg',
      // 关怀版高对比：默认开（PRD §4.8「默认深绿 + 近黑文字」）
      elderContrast: true,
      // 成长主题模式：'auto' 按月龄自动切换；'infant' / 'toddler' 为手动覆盖
      themeMode: 'auto',
      // 户外陪伴计时（M2 首页环：有效户外累计秒 + 每日目标；day 用于跨天重置）
      outdoor: { outdoor: 0, goal: 60, day: '' },
      // 本地缓存的「上次已知云端 rev」，push 时作 baseRev（0 = 本机从未与云端对过账）
      userRev: 0,
      // 云端数据覆盖本地后的页面刷新回调表（内部用，见 onUserSync / _emitUserSync）
      _syncListeners: [],
    };
    this.loadPersisted();
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
      // 云同步必须在 cloud.init 之后启动（内部会 pull → 云端胜出则覆盖本地并通知页面刷新）
      userSync.start(this);
    }
  },

  // 从本地存储恢复用户设置（M5；多宝宝 + 板块，含旧单档案迁移）
  loadPersisted() {
    try {
      const themeMode = wx.getStorageSync('themeMode') || 'auto';
      const elderMode = wx.getStorageSync('elderMode') || false;
      const rawFont = wx.getStorageSync('elderFont');
      const elderFont = (rawFont === 'std' || rawFont === 'xl') ? rawFont : 'lg';
      const rawContrast = wx.getStorageSync('elderContrast');
      // 从未设置过时 getStorageSync 返回 ''；此时取默认「开」
      const elderContrast = (rawContrast === '' || rawContrast === null || rawContrast === undefined) ? true : !!rawContrast;
      const block = wx.getStorageSync('block') || '';
      // babies：优先新结构；否则迁移旧的单 babyProfile
      let babies = wx.getStorageSync('babies');
      if (!Array.isArray(babies)) {
        const legacy = wx.getStorageSync('babyProfile');
        babies = legacy && legacy.name ? [legacy] : [];
      }
      // 老数据没有稳定 id → 补齐（同一批次内用 seen 去重，保证不撞值）
      const seen = {};
      babies = babies.map(function (b) {
        const item = (b && typeof b === 'object') ? b : {};
        if (!item.id) {
          let id = genBabyId();
          while (seen[id]) id = genBabyId();
          item.id = id;
        }
        seen[item.id] = 1;
        return item;
      });
      const babyIdx = Math.min(
        Math.max(0, +wx.getStorageSync('babyIdx') || 0),
        Math.max(0, babies.length - 1)
      );
      // outdoor：恢复今日户外累计（跨天由 index 页按 day 字段重置）
      const savedOutdoor = wx.getStorageSync('outdoor');
      if (savedOutdoor && typeof savedOutdoor === 'object') {
        this.globalData.outdoor = Object.assign(this.globalData.outdoor, savedOutdoor);
      }
      // curBabyId 迁移：优先读新 storage key → babies[babyIdx].id → babies[0].id
      let curBabyId = '';
      try {
        const savedId = wx.getStorageSync('curBabyId');
        if (typeof savedId === 'string') curBabyId = savedId;
      } catch (e) { /* 读不到按未迁移处理 */ }
      if (!curBabyId && babies[babyIdx]) curBabyId = babies[babyIdx].id || '';
      if (!curBabyId && babies[0]) curBabyId = babies[0].id || '';
      // userRev：本机上次已知云端 rev
      let userRev = 0;
      try { userRev = +wx.getStorageSync('userRev') || 0; } catch (e) { userRev = 0; }

      this.globalData.themeMode = themeMode;
      this.globalData.elderMode = elderMode;
      // ⚠️ 这两行不能漏：setter 只写了 storage，冷启动要靠这里把 storage 读回 globalData。
      // 漏了的话「调成特大 → 杀进程 → 重进」字号会静默掉回「大」，而关怀版唯一核心诉求就是字大。
      this.globalData.elderFont = elderFont;
      this.globalData.elderContrast = elderContrast;
      this.globalData.block = block;
      this.globalData.babies = babies;
      this.globalData.babyIdx = babyIdx;
      this.globalData.curBabyId = curBabyId;
      this.globalData.userRev = userRev;
      // 末尾统一派生 + 回写：迁移结果（补的 id / curBabyId）立即落盘，下次冷启动不必再迁
      this._refreshDerived();
      this.saveLocal();
    } catch (e) {
      console.error('读取本地设置失败', e);
    }
  },

  // 当前宝宝（快捷访问）
  curBaby() {
    const g = this.globalData;
    return g.babies[g.babyIdx] || null;
  },

  // 由 curBabyId 解析「当前宝宝下标 + babyProfile」：所有会改动 babies / 当前宝宝的出口末尾统一调用，
  // 保证 babyProfile 恒等于 babies[babyIdx]（vaccine / mine / resolveTheme 的读取语义完全不变）
  _refreshDerived() {
    const g = this.globalData;
    if (!Array.isArray(g.babies)) g.babies = [];
    let i = -1;
    if (g.curBabyId) {
      i = g.babies.findIndex(function (b) { return b && b.id && b.id === g.curBabyId; });
    }
    if (i < 0) i = 0;  // id 找不到（被删 / 数据异常）→ 回落首位
    g.babyIdx = Math.min(Math.max(0, i), Math.max(0, g.babies.length - 1));
    g.curBabyId = (g.babies[g.babyIdx] && g.babies[g.babyIdx].id) || '';
    g.babyProfile = g.babies[g.babyIdx] || null;
  },

  // 只写本地 storage，不触发云同步（云端覆盖本地后必须用它，否则会立刻回推、白涨 rev）
  saveLocal() {
    try {
      wx.setStorageSync('babies', this.globalData.babies);
      wx.setStorageSync('babyIdx', this.globalData.babyIdx);
      wx.setStorageSync('curBabyId', this.globalData.curBabyId || '');
      wx.setStorageSync('userRev', this.globalData.userRev || 0);
    } catch (e) { console.error(e); }
  },

  // 持久化宝宝列表 + 当前下标
  persistBabies() {
    try {
      wx.setStorageSync('babies', this.globalData.babies);
      wx.setStorageSync('babyIdx', this.globalData.babyIdx);
      wx.setStorageSync('curBabyId', this.globalData.curBabyId || '');
    } catch (e) { console.error(e); }
    userSync.pushThrottled('profile', 600);
  },

  // 持久化今日户外计时（index 页每次 syncOutdoor 调用）
  persistOutdoor() {
    try { wx.setStorageSync('outdoor', this.globalData.outdoor); } catch (e) { console.error(e); }
    // syncOutdoor() 每秒跑一次 → 必须 3s 节流，否则每秒打一次云函数
    userSync.pushThrottled('outdoor', 3000);
  },

  // 切换当前宝宝（首页顶部胶囊 / 宝宝 sheet 调用）
  setBabyIdx(i) {
    const g = this.globalData;
    const idx = Math.min(Math.max(0, i), Math.max(0, g.babies.length - 1));
    g.curBabyId = (g.babies[idx] && g.babies[idx].id) || '';
    this._refreshDerived();
    this.persistBabies();
  },

  // 添加宝宝并设为当前（返回新下标）
  addBaby(profile) {
    const g = this.globalData;
    const p = profile || {};
    if (!p.id) p.id = genBabyId();
    g.babies.push(p);
    g.curBabyId = p.id;
    this._refreshDerived();
    this.persistBabies();
    return g.babyIdx;
  },

  // 删除宝宝；至少保留一个，删除成功返回 true
  removeBaby(i) {
    const g = this.globalData;
    if (g.babies.length <= 1) return false;
    // 先记下被删的 id：只有删掉的正是当前宝宝时才需要改选，否则保持原当前宝宝不动
    const removedId = g.babies[i] && g.babies[i].id;
    g.babies.splice(i, 1);
    if (removedId && g.curBabyId === removedId) {
      const next = Math.min(i, g.babies.length - 1);
      g.curBabyId = (g.babies[next] && g.babies[next].id) || '';
    }
    this._refreshDerived();
    this.persistBabies();
    return true;
  },

  // 设置所在板块（v9 定位栏）
  setBlock(block) {
    this.globalData.block = block || '';
    try { wx.setStorageSync('block', this.globalData.block); } catch (e) { console.error(e); }
    userSync.pushThrottled('profile', 600);
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
    const p = profile || {};
    // 必须保住 id：profile 通常是 babyProfile 的引用改写（id 天然在）；
    // 但 babyProfile 为 null 时我的页会传 {}，此时补「当前宝宝 id」，再没有就新生成一个
    if (!p.id) {
      p.id = g.curBabyId || (g.babies[g.babyIdx] && g.babies[g.babyIdx].id) || genBabyId();
    }
    if (g.babies.length) {
      g.babies[g.babyIdx] = p;
    } else {
      g.babies.push(p);
      g.babyIdx = 0;
    }
    g.curBabyId = p.id;
    this._refreshDerived();
    this.persistBabies();
  },

  // 云端档案覆盖本地（云端为主）：只写本地 + 通知页面刷新，绝不回推（否则 rev 空涨 + 请求风暴）
  applyCloudProfile(data) {
    try {
      const g = this.globalData;
      const d = data || {};
      const babies = Array.isArray(d.babies) ? d.babies : [];
      babies.forEach(function (b) {
        if (b && typeof b === 'object' && !b.id) b.id = genBabyId();
      });
      g.babies = babies;
      g.curBabyId = typeof d.curBabyId === 'string' ? d.curBabyId : '';
      if (typeof d.block === 'string') g.block = d.block;
      // 原地合并保留对象引用：计时中若被云端覆盖，页面持引用继续累加不会写到已失效的旧对象
      g.outdoor = Object.assign(g.outdoor || {}, { outdoor: 0, goal: 60, day: '' }, d.outdoor || {});
      g.userRev = d.rev || 0;
      try {
        wx.setStorageSync('block', g.block);
        wx.setStorageSync('outdoor', g.outdoor);
      } catch (e) { console.error(e); }
      this._refreshDerived();
      this.saveLocal();
      this._emitUserSync();
    } catch (e) {
      console.error('应用云端资料失败', e);
    }
  },

  // 注册「云端数据已覆盖本地」回调（页面级刷新入口）
  onUserSync(fn) {
    if (typeof fn !== 'function') return;
    if (!Array.isArray(this.globalData._syncListeners)) this.globalData._syncListeners = [];
    this.globalData._syncListeners.push(fn);
  },

  // 通知所有监听方：单个回调报错不影响其它
  _emitUserSync() {
    const list = this.globalData._syncListeners || [];
    for (let i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { console.error('onUserSync 回调异常', e); }
    }
  },

  setThemeMode(mode) {
    this.globalData.themeMode = mode;
    try { wx.setStorageSync('themeMode', mode); } catch (e) { console.error(e); }
  },

  // ===== 关怀版偏好（M5）=====
  // 四个出口统一走这里，保证 globalData 与 storage 同步，且与 loadPersisted() 的读回口径对称。
  // elderMode 记录「用户当前是否在关怀版」：进关怀版置 true、退出置 false。
  // 它不参与任何样式决策（样式由页面根节点的 data-theme="elder" 决定），
  // 只给标准版「我的」页展示上次状态用。
  setElderMode(on) {
    this.globalData.elderMode = !!on;
    try { wx.setStorageSync('elderMode', this.globalData.elderMode); } catch (e) { console.error(e); }
  },

  setElderFont(font) {
    // 白名单三档，其余一律回落「大」——与 loadPersisted() 的读回逻辑保持一致，
    // 避免写进去一个非法值、读出来被纠正，两边口径漂移。
    const f = (font === 'std' || font === 'xl') ? font : 'lg';
    this.globalData.elderFont = f;
    try { wx.setStorageSync('elderFont', f); } catch (e) { console.error(e); }
  },

  setElderContrast(on) {
    this.globalData.elderContrast = !!on;
    try { wx.setStorageSync('elderContrast', this.globalData.elderContrast); } catch (e) { console.error(e); }
  },

  // 供四个关怀版页面一次性读取偏好，避免每页各自拼装、口径漂移
  elderPrefs() {
    const g = this.globalData || {};
    return {
      elderMode: !!g.elderMode,
      elderFont: (g.elderFont === 'std' || g.elderFont === 'xl') ? g.elderFont : 'lg',
      elderContrast: g.elderContrast !== false, // 未设置过时取默认「开」
    };
  },
});

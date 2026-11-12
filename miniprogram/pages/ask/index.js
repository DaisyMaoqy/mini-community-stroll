// pages/ask/index.js 育儿问答（P3：RAG AI 科普助手，调用云函数 ask；契约冻结不改云函数）
// 三态口径：正常回答（answer + riskTip + sources）/ 拒答（refuseNote + 去接种点入口）/ 失败（error + 原地重试）。
// 合规口径 PRD 8.2：所有态页脚常驻「科普非诊疗」提示；riskTip 非空即醒目展示就医提醒。
const app = getApp();

// 示例问题：口语化改写自 data/kb-guides.json 语料主题（辅食 / 睡眠 / 发育 / 健康预警各一条）
const SAMPLE_QUESTIONS = [
  '宝宝几个月可以加辅食？',
  '宝宝夜里频繁醒怎么办？',
  '几个月会翻身、走路算正常？',
  '什么时候必须去医院？',
];

// 会话内历史记录 id 生成（仅用于 wx:key，不落盘）
let QA_SEQ = 0;

Page({
  data: {
    babyChip: '',        // 顶部月龄行文案：「当前宝宝：昵称 · N 个月」/「未设置宝宝月龄」
    babyAgeMonths: null, // 传给云函数的月龄；无宝宝或无生日时为 null
    question: '',
    asking: false,       // 提问中：按钮 loading 态 + 防连点
    samples: SAMPLE_QUESTIONS,
    history: [],         // [{ id, q, status: 'loading'|'ans'|'refuse'|'fail', answer?, riskTip?, sources?, refuseNote?, error? }]
  },

  onLoad() {
    this._alive = true;
    this.syncBaby();
    // 云端档案覆盖本地后刷新月龄行（与首页 onUserSync 同口径）
    this._syncFn = () => this.syncBaby();
    app.onUserSync(this._syncFn);
  },

  onShow() {
    // 首页可能切过宝宝 / 我的页可能改过生日，回本页时刷新月龄行
    this.syncBaby();
  },

  onUnload() {
    // 历史只在内存里，页面卸载即丢（刻意不持久化）；同时摘掉 onUserSync 监听，
    // 否则反复 navigateTo 本页会在 _syncListeners 里越积越多死引用
    this._alive = false;
    const list = app.globalData._syncListeners || [];
    const k = list.indexOf(this._syncFn);
    if (k >= 0) list.splice(k, 1);
  },

  // 当前宝宝月龄行：app.curBaby() 取当前宝宝（babies[babyIdx]，babyIdx 由 curBabyId 派生），
  // 月龄换算复用 app.monthAge(birth)（整月口径，与首页 ageText / resolveTheme 同源）。
  // 无宝宝或生日缺失 → monthAge 返回 null → chip 显示「未设置宝宝月龄」。
  syncBaby() {
    if (!this._alive) return;
    const cur = app.curBaby();
    const ma = (cur && cur.birth) ? app.monthAge(cur.birth) : null;
    const chip = (cur && ma != null)
      ? '当前宝宝：' + (cur.name || '宝宝') + ' · ' + ma + ' 个月'
      : '未设置宝宝月龄';
    this.setData({ babyChip: chip, babyAgeMonths: ma });
  },

  onQuestion(e) {
    this.setData({ question: e.detail.value });
  },

  // 示例 chip：点击仅填入输入框（不直接提问，用户还能再编辑）
  fillSample(e) {
    this.setData({ question: e.currentTarget.dataset.q || '' });
  },

  // 提问：先压一条 loading 记录，云函数回包后原地更新该条；按钮 loading + 防连点
  ask() {
    const q = (this.data.question || '').trim();
    if (!q) return;
    if (this.data.asking) return; // 防连点
    QA_SEQ += 1;
    const item = { id: 'qa_' + QA_SEQ, q, status: 'loading' };
    const history = this.data.history.concat([item]);
    const i = history.length - 1;
    this.setData({ asking: true, history });
    this._request(q, i);
  },

  // 失败态重试：对同一条记录重发同一个问题（原地更新，不新开记录）
  retryAsk(e) {
    if (this.data.asking) return;
    const i = +e.currentTarget.dataset.i;
    const item = this.data.history[i];
    if (!item || !item.q) return;
    this.setData({ asking: true, ['history[' + i + '].status']: 'loading' });
    this._request(item.q, i);
  },

  // 调云函数 ask（契约冻结）：data = { question, babyAgeMonths }；月龄未知时显式传 null。
  // 返回扁平结构：正常 { success:true, refused:false, answer, riskTip, sources, ... }；
  // 拒答 { success:true, refused:true, refuseNote, sources:[] }；失败 { success:false, error }；
  // 云函数异常时 callFunction 本身 reject，走 catch。
  async _request(q, i) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'ask',
        data: {
          question: q,
          babyAgeMonths: (this.data.babyAgeMonths == null ? null : this.data.babyAgeMonths),
        },
      });
      const r = (res && res.result) || {};
      if (r.success === true && r.refused === true) {
        // 拒答：展示 refuseNote，并提供去接种点入口
        this._update(i, { status: 'refuse', refuseNote: r.refuseNote || '这个问题暂时不在科普语料范围内' });
      } else if (r.success === true) {
        this._update(i, {
          status: 'ans',
          answer: (typeof r.answer === 'string') ? r.answer : '',
          riskTip: (typeof r.riskTip === 'string') ? r.riskTip : '',
          sources: Array.isArray(r.sources) ? r.sources : [],
        });
      } else {
        this._update(i, { status: 'fail', error: (typeof r.error === 'string' && r.error) || '云函数返回异常' });
      }
    } catch (err) {
      // callFunction 本身 reject（网络 / 云函数抛错）：错误信息透出给失败态文案
      const msg = (err && err.errMsg) || (err && err.message) || '';
      this._update(i, { status: 'fail', error: msg ? String(msg) : '网络异常，请稍后重试' });
    }
  },

  // 原地合并更新一条历史记录（保住 id / q，wx:key 不漂移）；页面已卸载则丢弃（防 setData 报警）
  _update(i, patch) {
    if (!this._alive) return;
    const cur = this.data.history[i] || {};
    const next = Object.assign({}, cur, patch);
    this.setData({ ['history[' + i + ']']: next, asking: false });
  },

  // 拒答态入口：去接种点。
  // ⚠️ 接种页是 tabBar 页（app.json tabBar list），wx.navigateTo 不能跳 tab 页（会直接报错），
  // 必须用 wx.switchTab —— 与任务书写的 navigateTo 有出入，按平台约束实现，见回报说明。
  goVaccine() {
    wx.switchTab({ url: '/pages/vaccine/index' });
  },
});

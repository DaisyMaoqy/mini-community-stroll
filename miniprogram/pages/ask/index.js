// pages/ask/index.js 育儿问答（P3：RAG AI 科普助手，调用云函数 ask；契约冻结不改云函数）
// 三态口径：正常回答（answer + riskTip + sources）/ 拒答 / 失败（error + 原地重试）。
// 拒答按 refuseReason 分三种展示形态：insufficient（域内但语料没覆盖，含字段缺失兜底）→ refuseNote + 去接种点按钮；
// out_of_scope（政策/成人健康/品牌地点推荐等范围外）→ refuseNote + 可问范围提示，不出按钮；
// vague（模糊求助，缺月龄和具体表现）→ refuseNote + 补全提示，不出按钮。refuseNote 由云端按类给出，前端原样展示。
// 合规口径 PRD 8.2：所有态页脚常驻「科普非诊疗」提示；riskTip 非空即醒目展示就医提醒。
// 体验增强：答案打字机（前端逐字上屏动画；云函数 callFunction 非流式整段返回，
// fullAnswer 一次进 data，answer 只放「已上屏部分」随动画增量更新；riskTip 立即显示，sources 打完再出）。
const app = getApp();

// 示例问题：口语化改写自 data/kb-guides.json 语料主题（辅食 / 睡眠 / 发育 / 健康预警各一条）
const SAMPLE_QUESTIONS = [
  '宝宝几个月可以加辅食？',
  '宝宝夜里频繁醒怎么办？',
  '几个月会翻身、走路算正常？',
  '什么时候必须去医院？',
];

// 打字机节奏：30ms 一 tick、每 tick 追加 2 字（200 字答案约 3 秒，setData 频率可控）
const TYPE_TICK_MS = 30;
const TYPE_STEP = 2;

// 会话内历史记录 id 生成（仅用于 wx:key，不落盘）
let QA_SEQ = 0;

Page({
  data: {
    babyChip: '',        // 顶部月龄行文案：「当前宝宝：昵称 · N 个月」/「未设置宝宝月龄」
    babyAgeMonths: null, // 传给云函数的月龄；无宝宝或无生日时为 null
    question: '',
    asking: false,       // 提问中：按钮 loading 态 + 防连点
    samples: SAMPLE_QUESTIONS,
    history: [],         // [{ id, q, status: 'loading'|'ans'|'refuse'|'fail', fullAnswer?, answer?, typed?, riskTip?, sources?, refuseNote?, refuseReason?, error? }]
    scrollAnchor: '',    // 打字机滚动跟随：双锚点交替值（scroll-into-view 只有值变化才触发滚动，恒定值不滚）
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
    // 打字机计时器必须清（铁律：页面卸载清理，同 InnerAudioContext 教训），再摘监听
    this._clearTypeTimer();
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
    // 上一条还没打完：立即置满再开新的，保证同屏同时只有一条在打字
    this._finishTypingNow();
    QA_SEQ += 1;
    const item = { id: 'qa_' + QA_SEQ, q, status: 'loading' };
    const history = this.data.history.concat([item]);
    const i = history.length - 1;
    // 新提问滚到新卡：交替一次锚点值（与打字 tick 同机制，值变才触发滚动）
    this._anchorToggle = !this._anchorToggle;
    this.setData({
      asking: true,
      history,
      scrollAnchor: this._anchorToggle ? 'anchor-a' : 'anchor-b',
    });
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
  // 拒答 { success:true, refused:true, refuseNote, refuseReason, sources:[] }；
  // 失败 { success:false, error }；云函数异常时 callFunction 本身 reject，走 catch。
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
        // 拒答：refuseNote 由云端按 refuseReason 分类给出，前端原样展示、不拼文案。
        // refuseReason 非三值之一（含云端未部署新版时字段缺失）一律兜底 'insufficient'，
        // 使旧版云函数的表现与现状完全一致（refuseNote + 去接种点按钮）。
        const reason = (r.refuseReason === 'out_of_scope' || r.refuseReason === 'vague')
          ? r.refuseReason
          : 'insufficient';
        this._update(i, {
          status: 'refuse',
          refuseReason: reason,
          refuseNote: r.refuseNote || '这个问题暂时不在科普语料范围内',
        });
      } else if (r.success === true) {
        // 打字机数据模型：fullAnswer（完整答案）一次进 data；answer 只是「已上屏部分」，随动画增量更新
        this._update(i, {
          status: 'ans',
          fullAnswer: (typeof r.answer === 'string') ? r.answer : '',
          answer: '',
          typed: false,
          riskTip: (typeof r.riskTip === 'string') ? r.riskTip : '',
          sources: Array.isArray(r.sources) ? r.sources : [],
        });
        this._startTyping(i);
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

  // ===== 答案打字机（前端动画；拒答/失败态不打字，refuseNote 本来就短直接出） =====

  // 开始对第 i 条做打字机：旧条若还没打完，先立即置满（同屏同时只有最新一条在打）
  _startTyping(i) {
    this._finishTypingNow();
    const item = this.data.history[i];
    if (!item || item.status !== 'ans') return;
    const full = item.fullAnswer || '';
    if (!full) {
      // 降级：空答案跳过动画直接收尾
      this.setData({ ['history[' + i + '].answer']: '', ['history[' + i + '].typed']: true });
      return;
    }
    this._typeIdx = i;
    this._typePos = 0;
    this._typeTimer = setInterval(() => {
      if (!this._alive) { this._clearTypeTimer(); return; }
      if (this._stepTyping()) this._clearTypeTimer();
    }, TYPE_TICK_MS);
  },

  // 单个 tick：追加 2 字 + 交替滚动锚点（一次 setData 只动 history[i].answer 路径 + scrollAnchor）；返回是否打完
  _stepTyping() {
    const i = this._typeIdx;
    const item = this.data.history[i];
    if (!item || item.status !== 'ans') return true; // 记录没了（异常防御）：直接停
    const full = item.fullAnswer || '';
    const pos = Math.min((this._typePos || 0) + TYPE_STEP, full.length);
    this._typePos = pos;
    const patch = { ['history[' + i + '].answer']: full.slice(0, pos) };
    if (pos >= full.length) patch['history[' + i + '].typed'] = true;
    // 双锚点交替：scroll-into-view 只有值变化才触发滚动，恒定值不滚
    this._anchorToggle = !this._anchorToggle;
    patch.scrollAnchor = this._anchorToggle ? 'anchor-a' : 'anchor-b';
    this.setData(patch);
    return pos >= full.length;
  },

  // 跳过打字：点答案区（qa-a）立即置全量文本；仅打字中生效，打完点无反应
  skipTyping(e) {
    if (!this._typeTimer) return;
    const i = +e.currentTarget.dataset.i;
    if (i !== this._typeIdx) return; // 只有正在打字的这条可跳
    this._finishTypingNow();
  },

  // 立即置满当前正在打字的这条（新提问 / 跳过共用）
  _finishTypingNow() {
    if (!this._typeTimer) return;
    const i = this._typeIdx;
    this._clearTypeTimer();
    if (!this._alive) return;
    const item = this.data.history[i];
    if (!item || item.status !== 'ans') return;
    this.setData({
      ['history[' + i + '].answer']: item.fullAnswer || '',
      ['history[' + i + '].typed']: true,
    });
  },

  _clearTypeTimer() {
    if (this._typeTimer) { clearInterval(this._typeTimer); this._typeTimer = null; }
  },

  // 拒答态入口：去接种点。
  // ⚠️ 接种页是 tabBar 页（app.json tabBar list），wx.navigateTo 不能跳 tab 页（会直接报错），
  // 必须用 wx.switchTab —— 与任务书写的 navigateTo 有出入，按平台约束实现，见回报说明。
  goVaccine() {
    wx.switchTab({ url: '/pages/vaccine/index' });
  },
});

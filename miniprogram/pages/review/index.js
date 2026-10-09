// pages/review/index.js 纠错审核页（T07 默认采纳路径 + T09 直接应用到云端）
// 运营审核端：查 local_reports 队列 → 采纳（默认，不写权威表）/ 直接应用到云端（写 local_spots）/ 驳回。
// 契约见「服务端契约（已冻结）」：统一走 callCloud('reports', { action, ... })。
//   - whoami（不鉴权）→ 判定 isAdmin，仅 admin 才拉队列
//   - queue（仅 admin）→ 分页拉取，createdAt 倒序，不返回 reporterOpenid
//   - review（仅 admin）→ status: accepted|rejected，applyToSpots 控制是否直写权威表
//   - spots.get（取 POI 现值，生成 seed 片段用；失败必须 try/catch 降级）
const { callCloud } = require('../../utils/cloud.js');

// 状态 tab（值，与 data.statusTabs 一致）+ 中文文案映射（WXML 不能调函数，用映射表渲染）
const STATUS_TABS = ['pending', 'accepted', 'rejected'];
const STATUS_LABELS = { pending: '待审', accepted: '已采纳', rejected: '已驳回' };

// 类型门禁：仅这两类支持「直接应用到云端」（与服务端字段白名单一致）
//   位置不准 → 写 coord；已关闭或不存在 → 写 verifyStatus='rejected'；其余三类服务端会 reject(INVALID_PARAM)
const DIRECT_APPLY_TYPES = ['位置不准', '已关闭或不存在'];

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// 页面本地日期 YYYY-MM-DD（与服务端 today() 口径一致）
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 页面本地时间 YYYY-MM-DD HH:mm
function nowStr() {
  const d = new Date();
  return todayStr() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// ISO 字符串 → "MM-DD HH:mm"（本地时区）；非法输入返回空串
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// 剔除云端内部字段：保留 _id，剔除 _openid 及除 _id 外所有以 _ 开头的字段
function stripInternal(doc) {
  const src = doc || {};
  const out = {};
  Object.keys(src).forEach(function (k) {
    if (k === '_id') { out._id = src._id; return; }
    if (k.charAt(0) === '_') return;
    out[k] = src[k];
  });
  return out;
}

// 上报说明：取 report.content，超 100 字截断并追加 …；为空/未填 → （未填写）
function reportNote(content) {
  const text = (content == null ? '' : String(content)).trim();
  if (!text) return '（未填写）';
  return text.length > 100 ? text.slice(0, 100) + '…' : text;
}

Page({
  // 实例级同步闩：setData 之外的极速连点可能在 data.submitting 生效前穿透，用同步布尔兜底
  _busy: false,
  // 分页追加的 in-flight 锁：仅用于拦截「分页追加」（page > 0）的重入；
  // 重置请求（page 0）一律放行并抢占，旧的过期响应由 _reqSeq 丢弃。
  _loading: false,
  // 请求序号（抢占式）：每次 loadQueue 进入即 ++；await 回来后只有「当前序号」的响应可落库/复位，
  // 过期响应一律静默丢弃，避免「旧 tab 数据写进新 tab」与「收尾清掉新请求 in-flight 标记」。
  _reqSeq: 0,

  data: {
    authChecked: false,   // 是否已完成 whoami 身份校验
    isAdmin: false,       // 是否运营审核员
    openid: '',           // 当前 openid（whoami 返回，仅调试/展示用）
    statusTabs: STATUS_TABS,      // ['pending','accepted','rejected']
    statusLabels: STATUS_LABELS,  // 供 WXML 渲染中文 tab 文案（值→文案）
    tab: 'pending',       // 当前状态筛选
    list: [],             // 当前队列（已 decorate）
    total: 0,             // 服务端返回总数
    page: 0,              // 当前页码（从 0 起）
    size: 20,             // 每页条数（服务端默认 20 上限 50）
    hasMore: false,       // 是否还有下一页
    loading: false,       // 队列加载中
    loadError: false,     // 队列加载失败（区别于空数据）
    expandId: '',         // 当前展开的反馈 _id（'' 表示全收起）
    noteMap: {},          // { [_id]: 审核备注 / 驳回理由 }
    submitting: false,    // 审核请求进行中（防连点 + 按钮禁用）
    snippetVisible: false, // seed 片段弹层显隐
    seedSnippet: '',      // seed 片段文本
  },

  onLoad() {
    // 仅 onLoad 校验身份一次；onShow 不重复拉取（避免双请求）
    this.checkAuth();
  },

  onShow() {
    // 刻意留空：回到本页不重拉队列（避免与 onLoad/下拉刷新形成双请求）
  },

  // 下拉刷新：重置到第 0 页重载当前 tab
  async onPullDownRefresh() {
    if (!this.data.isAdmin) {
      wx.stopPullDownRefresh();
      return;
    }
    this.setData({ list: [], total: 0, page: 0, hasMore: false, loadError: false, expandId: '' });
    await this.loadQueue(0);
    wx.stopPullDownRefresh();
  },

  // 触底加载下一页
  onReachBottom() {
    if (!this.data.isAdmin) return;
    if (this.data.hasMore && !this.data.loading) {
      this.loadQueue(this.data.page + 1);
    }
  },

  // 加载失败重试：重置为第 0 页后重新拉取
  onRetry() {
    this.setData({ list: [], total: 0, page: 0, hasMore: false });
    this.loadQueue(0);
  },

  // ---- 身份校验（不鉴权） ----
  async checkAuth() {
    try {
      const res = await callCloud('reports', { action: 'whoami' });
      const isAdmin = !!(res && res.isAdmin);
      this.setData({ authChecked: true, isAdmin: isAdmin, openid: (res && res.openid) || '' });
      if (isAdmin) this.loadQueue(0);
    } catch (e) {
      // whoami 正常不应失败；失败时按「无权限」兜底，并给出可返回态
      this.setData({ authChecked: true, isAdmin: false, openid: '' });
      wx.showToast({ title: '身份校验失败，请重试', icon: 'none' });
    }
  },

  // ---- 拉取队列（page 从 0 起）----
  async loadQueue(page) {
    const p = page || 0;
    const fresh = p === 0; // 第 0 页 = 重置（切 tab / 下拉刷新 / 重试）
    // 仅拦截「分页追加」的重入（page > 0）；重置请求一律放行并抢占，
    // 保证「先清空 list 再请求」的调用方不会因守卫被静默丢弃而卡在空态。
    if (!fresh && this._loading) return;
    const reqId = ++this._reqSeq; // 抢占式序号：只有最新请求能落库/复位
    this._loading = !fresh;       // 分页锁只服务追加请求；重置请求顺带清掉可能残留的旧分页锁
    this.setData({ loading: true, loadError: false });
    try {
      const res = await callCloud('reports', {
        action: 'queue',
        status: this.data.tab,
        page: p,
        size: this.data.size,
      });
      if (reqId !== this._reqSeq) return; // 已被更新的请求取代 → 丢弃，不 setData、不改 loading
      const raw = (res && res.list) || [];
      const rows = raw.map((it) => this.decorate(it));
      const total = res && typeof res.total === 'number' ? res.total : rows.length;
      const list = fresh ? rows : this.data.list.concat(rows);
      this.setData({
        list: list,
        total: total,
        page: p,
        hasMore: list.length < total,
        loading: false,
        loadError: false,
      });
    } catch (e) {
      if (reqId !== this._reqSeq) return; // 过期请求的失败同样丢弃，避免覆盖新请求的 loading 态
      console.error('加载审核队列失败', e);
      // 失败态与空数据区分：置 loadError，由 WXML 渲染失败卡 + 重试入口
      this.setData({ loading: false, loadError: true });
    } finally {
      // 仅当前有效请求可复位分页锁，避免旧请求收尾时把新请求的 in-flight 标记清掉
      if (reqId === this._reqSeq) this._loading = false;
    }
  },

  // 把服务端返回的反馈收敛成本页卡片所需字段
  decorate(it) {
    const report = Object.assign({}, it);
    const images = it.images || [];
    report._time = fmtTime(it.createdAt);
    report._statusLabel = STATUS_LABELS[it.status] || it.status || '';
    report._hasImages = images.length > 0;
    report._thumb = images[0] || '';
    report._imageCount = images.length;
    report._canApply = DIRECT_APPLY_TYPES.indexOf(it.type) >= 0;
    return report;
  },

  // ---- 切换状态 tab：重置并重载第 0 页 ----
  onStatusTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.tab) return;
    this.setData({ tab: key, list: [], total: 0, page: 0, hasMore: false, loadError: false, expandId: '' });
    this.loadQueue(0);
  },

  // ---- 展开 / 收起某条反馈 ----
  onToggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expandId: this.data.expandId === id ? '' : id });
  },

  // ---- 预览图片（点击缩略图） ----
  previewImage(e) {
    const id = e.currentTarget.dataset.id;
    const idx = e.currentTarget.dataset.idx != null ? Number(e.currentTarget.dataset.idx) : 0;
    const report = this.findReport(id);
    const urls = (report && report.images) || [];
    if (!urls.length) return;
    wx.previewImage({ urls: urls, current: urls[idx] || urls[0] });
  },

  // ---- 备注输入：写 noteMap[_id]（整体替换，规避动态 key 的路径解析差异） ----
  onNoteInput(e) {
    const id = e.currentTarget.dataset.id;
    const value = (e.detail && e.detail.value) || '';
    const noteMap = Object.assign({}, this.data.noteMap);
    noteMap[id] = value;
    this.setData({ noteMap: noteMap });
  },

  // ---- 主按钮：采纳（默认路径，不写权威表） ----
  async onAcceptDefault(e) {
    const id = e.currentTarget.dataset.id;
    const report = this.findReport(id);
    if (!report) return;
    if (this._busy || this.data.submitting) return;

    // 先 await 生成 seed 片段：复制 + 弹层展示，供运营按 SOP 回写 seed 主本
    this.setData({ submitting: true });
    try {
      const snippet = await this.buildSeedSnippet(report);
      this.setData({ seedSnippet: snippet, snippetVisible: true });
      wx.setClipboardData({
        data: snippet,
        success() { wx.showToast({ title: '已复制，请按 SOP 粘进 seed 主本', icon: 'none' }); },
        fail() { wx.showToast({ title: '复制失败，请手动长按复制', icon: 'none' }); },
      });
    } catch (err) {
      // buildSeedSnippet 内部已降级，这里仅防御：生成失败不阻断采纳
      console.error('生成 seed 片段失败', err);
    } finally {
      this.setData({ submitting: false });
    }

    // 再执行采纳（doReview 内部自持 submitting / _busy）
    await this.doReview(id, 'accepted', false, (this.data.noteMap[id] || '').trim());
  },

  // ---- 次要按钮：直接应用到云端（T09，二次确认） ----
  onApplyToCloud(e) {
    const id = e.currentTarget.dataset.id;
    const report = this.findReport(id);
    if (!report) return;
    if (this._busy || this.data.submitting) return;
    if (!report._canApply) {
      wx.showToast({ title: '该类型不支持直接应用，请走 seed 片段', icon: 'none' });
      return;
    }
    const note = (this.data.noteMap[id] || '').trim();
    wx.showModal({
      title: '确认直接应用到云端？',
      content: '将直接改写云端权威表 local_spots。请记得回写 seed 主本，否则下次部署 initSpots 会被覆盖回滚！',
      cancelText: '取消',
      confirmText: '确认应用',
      success: (res) => {
        if (!res.confirm) return; // 取消：不发起任何请求
        this.doReview(id, 'accepted', true, note);
      },
    });
  },

  // ---- 第三按钮：驳回（必填理由，空则不发请求） ----
  onReject(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    if (this._busy || this.data.submitting) return;
    const note = (this.data.noteMap[id] || '').trim();
    if (!note) {
      wx.showToast({ title: '请填写驳回理由', icon: 'none' });
      return; // 不发起请求
    }
    this.doReview(id, 'rejected', false, note);
  },

  // ---- 统一审核执行（采纳 / 直接应用 / 驳回） ----
  async doReview(id, status, applyToSpots, note) {
    if (this._busy) return { ok: false, reason: 'busy' };
    this._busy = true;
    const reviewNote = (note != null ? note : (this.data.noteMap[id] || '')).trim();
    this.setData({ submitting: true });
    try {
      const res = await callCloud('reports', {
        action: 'review',
        _id: id,
        status: status,
        reviewNote: reviewNote,
        applyToSpots: !!applyToSpots,
      });

      // 成功提示
      if (applyToSpots && res && res.appliedToSpots) {
        const fields = (res.appliedFields || []).join('、') || 'coord';
        wx.showModal({
          title: '已应用到云端',
          content: '已应用到云端（变更字段：' + fields + '）。务必回写 seed 主本并部署 initSpots，否则会被回滚。',
          showCancel: false,
          confirmText: '我知道了',
        });
      } else {
        wx.showToast({ title: status === 'accepted' ? '已采纳' : '已驳回', icon: 'none' });
      }

      // 从当前列表移除该条并刷新队列（保证与服务端一致）
      const list = (this.data.list || []).filter((x) => x._id !== id);
      this.setData({
        list: list,
        total: Math.max(0, this.data.total - 1),
        expandId: this.data.expandId === id ? '' : this.data.expandId,
      });
      this.loadQueue(0);
      return { ok: true, res: res };
    } catch (err) {
      const code = err && err.code;
      let msg = (err && err.message) || '操作失败，请重试';
      if (code === 'FORBIDDEN') msg = '无审核权限';
      else if (code === 'INVALID_PARAM' || code === 'SPOT_NOT_FOUND') msg = (err && err.message) || msg;
      else if (code === 'NOT_FOUND') msg = (err && err.message) || '该反馈不存在或已被处理';
      wx.showToast({ title: msg, icon: 'none' });
      // 保留当前展开态与已填备注（不清空上下文，便于改完重试）
      return { ok: false, err: err };
    } finally {
      this.setData({ submitting: false });
      this._busy = false;
    }
  },

  // ---- 生成 seed 采纳片段（供运营粘进 data/local_spots.seed.json） ----
  // 三种输出形态：
  //   ② 一般采纳：位置不准 / 已关闭或不存在（doc 取到且坐标齐备）→ 整条 POI JSON（可整条替换）+ 变更对照
  //   ① 需人工处理：信息有误 / 设施变化 / 其他 → 无结构化字段，仅输出当前值对照 JSON + 人工处理指引（未做任何改动）
  //   ③ 降级：spots.get 失败，或「位置不准」缺 suggestCoord → 只输出被改字段片段
  async buildSeedSnippet(report) {
    const type = report.type;
    const spotId = report.spotId || '';
    const reportId = report._id || '';
    const suggest = report.suggestCoord || null;
    const needCoord = type === '位置不准';

    // 取 POI 当前权威值（spots.get）；该云函数失败返回 errMsg 而非 message，必须 try/catch 降级
    let doc = null;
    try {
      const res = await callCloud('spots', { action: 'get', id: spotId });
      doc = (res && res.data) || null;
    } catch (e) {
      doc = null;
    }

    const chainWarn = '⚠️ 改完必须走完整链：归档主本 data/local_spots.seed.json → cp 到 cloudfunctions/initSpots/spots.seed.json → 部署 initSpots → 调用一次（否则下次部署会被回滚）';
    const genTime = nowStr();
    const noteLine = '上报说明：' + reportNote(report.content);

    // ① 无结构化字段：信息有误 / 设施变化 / 其他 没有可直接替换的字段。
    //    改法（QA P2-2）——绝不能输出「整条替换格式 + 空变更对照」，否则误导运营白改 updatedAt。
    const noStructuredField = (type !== '位置不准' && type !== '已关闭或不存在');
    if (noStructuredField) {
      const lines = [];
      lines.push('【祈福遛一遛 · POI 纠错采纳片段（需人工处理）】');
      lines.push('来源：local_reports/' + reportId);
      lines.push('生成时间：' + genTime);
      lines.push(noteLine);
      lines.push('上报类型：' + type);
      if (doc) {
        lines.push('操作：本类型没有可直接替换的结构化字段。请人工核对 data/local_spots.seed.json 中 "_id": "' + spotId + '" 的元素，按上报说明判断是否需要修改（下方为该 POI 当前云端值，仅供对照，未做任何改动）');
      } else {
        lines.push('操作：未能读取当前权威值，请自行打开 seed 主本核对 "_id": "' + spotId + '" 的元素并按上报说明判断');
      }
      lines.push(chainWarn);
      if (doc) {
        lines.push('');
        lines.push(JSON.stringify(stripInternal(doc), null, 2));
      }
      lines.push('');
      lines.push('变更对照：无（需人工判断）');
      return lines.join('\n');
    }

    // ③ 降级路径：只输出被改字段片段
    const coordMissing = needCoord && (!suggest || suggest.lng == null || suggest.lat == null);
    const degraded = !doc || coordMissing;
    if (degraded) {
      const lines = [];
      lines.push('【祈福遛一遛 · POI 纠错采纳片段（降级）】');
      lines.push('来源：local_reports/' + reportId);
      lines.push('生成时间：' + genTime);
      lines.push(noteLine);
      lines.push('⚠️ 未能读取当前权威值，请自行核对旧值');
      lines.push('操作：将下列字段合并到 data/local_spots.seed.json 中 "_id": "' + spotId + '" 的那个元素');
      lines.push(chainWarn);
      lines.push('');
      lines.push(this.buildChangedFieldsJson(type, suggest));
      lines.push('');
      lines.push('变更对照：旧值未取到');
      return lines.join('\n');
    }

    // ② 正常路径：以 spots.get 的 data 为底，按 type 覆盖（仅 位置不准 / 已关闭或不存在 会到达此处）
    const full = stripInternal(doc);
    let diffLine = '';

    if (type === '位置不准') {
      const oldCoord = (doc.coord && doc.coord.coordinates) || [];
      const oldLng = oldCoord[0] != null ? oldCoord[0] : '?';
      const oldLat = oldCoord[1] != null ? oldCoord[1] : '?';
      // gcj02 经度在前
      full.coord = { type: 'Point', coordinates: [suggest.lng, suggest.lat] };
      diffLine = 'coord：[' + oldLng + ', ' + oldLat + '] → [' + suggest.lng + ', ' + suggest.lat + ']';
    } else if (type === '已关闭或不存在') {
      const oldVerify = doc.verifyStatus != null ? doc.verifyStatus : '（未设置）';
      full.verifyStatus = 'rejected';
      diffLine = 'verifyStatus：' + oldVerify + ' → rejected';
    }

    // 与服务端 today() 口径一致：页面本地日期
    full.updatedAt = todayStr();

    const json = JSON.stringify(full, null, 2);
    const header = [
      '【祈福遛一遛 · POI 纠错采纳片段】',
      '来源：local_reports/' + reportId,
      '生成时间：' + genTime,
      noteLine,
      '操作：用下面这段整条替换 data/local_spots.seed.json 中 "_id": "' + spotId + '" 的那个元素',
      chainWarn,
    ].join('\n');

    return header + '\n\n' + json + '\n\n变更对照：' + diffLine;
  },

  // 降级用：仅被改字段的 JSON 片段（2 空格缩进）
  buildChangedFieldsJson(type, suggest) {
    const patch = {};
    if (type === '位置不准') {
      patch.coord = {
        type: 'Point',
        coordinates: [suggest && suggest.lng != null ? suggest.lng : null, suggest && suggest.lat != null ? suggest.lat : null],
      };
    } else if (type === '已关闭或不存在') {
      patch.verifyStatus = 'rejected';
    }
    patch.updatedAt = todayStr();
    return JSON.stringify(patch, null, 2);
  },

  // ---- seed 片段弹层 ----
  onCopySnippet() {
    const data = this.data.seedSnippet || '';
    if (!data) return;
    wx.setClipboardData({
      data: data,
      success() { wx.showToast({ title: '已复制，请按 SOP 粘进 seed 主本', icon: 'none' }); },
      fail() { wx.showToast({ title: '复制失败，请手动长按复制', icon: 'none' }); },
    });
  },
  onCloseSnippet() {
    this.setData({ snippetVisible: false });
  },

  // ---- 返回上一页（无页面栈时回首页） ----
  onBack() {
    wx.navigateBack({
      delta: 1,
      fail() { wx.switchTab({ url: '/pages/index/index' }); },
    });
  },

  // ---- 工具：按 _id 取当前列表中的反馈 ----
  findReport(id) {
    return (this.data.list || []).find((x) => x._id === id) || null;
  },

  // catchtouchmove 占位：锁背景滚动
  noop() {},
});

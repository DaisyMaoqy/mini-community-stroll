// pages/review/index.js 纠错审核页（T07 默认采纳 + T09 直接应用 + T11 两层视图/地图重新选点）
// 运营审核端：查 local_reports 队列 → 列表（联动页式）→ 详情（采集页式）→
//   采纳（默认，不写权威表）/ 直接应用到云端（写 local_spots）/ 驳回。
// 契约见「服务端契约（已冻结）」：统一走 callCloud('reports', { action, ... })。
//   - whoami（不鉴权）→ 判定 isAdmin，仅 admin 才拉队列
//   - queue（仅 admin）→ 分页拉取，createdAt 倒序，不返回 reporterOpenid
//   - review（仅 admin）→ status: accepted|rejected，applyToSpots 控制是否直写权威表；
//       可选 coordOverride:{lat,lng}（审核员重新选点）→ 优先级高于 suggestCoord
//   - spots.get（取 POI 现值，生成 seed 片段 + 详情只读字段；失败必须 try/catch 降级）
const { callCloud } = require('../../utils/cloud.js');

// 状态 tab（值，与 data.statusTabs 一致）+ 中文文案映射（WXML 不能调函数，用映射表渲染）
const STATUS_TABS = ['pending', 'accepted', 'rejected'];
const STATUS_LABELS = { pending: '待审', accepted: '已采纳', rejected: '已驳回' };

// 类型门禁：仅这两类支持「直接应用到云端」（与服务端字段白名单一致）
//   位置不准 → 写 coord；已关闭或不存在 → 写 verifyStatus='rejected'；其余三类服务端会 reject(INVALID_PARAM)
const DIRECT_APPLY_TYPES = ['位置不准', '已关闭或不存在'];

// 「直接应用到云端」的运营口径文案（集中一处，便于统一维护）
// 补丁层上线后语义已变：直写 local_spots 的同时会写入 POI 补丁层（local_spot_patches），
//   initSpots 会在 seed 原文之上叠加补丁 → 改动**立即生效且长期有效**，不再是「只改云端、下次按 seed 重建即失效」的旧口径。
//   但补丁属于「待清理」状态而非长期状态，仍建议择机把改动折回 seed 主本，再用下方「POI 补丁」区删掉补丁。
//   ① 二次确认弹窗正文
const APPLY_CONFIRM_TEXT = [
  '✅ 本次改动立即生效且长期有效：系统会同时写入「POI 补丁」层，之后即使部署并调用 initSpots 也会自动叠加，不会按 seed 主本盖回去。',
  '但补丁应当是待清理状态：仍建议在合适时机把改动折回 seed 主本（data/local_spots.seed.json → cp 到 cloudfunctions/initSpots/spots.seed.json → 部署并调用一次 initSpots），再到底部「POI 补丁」区复制 JSON 并「已折回，删补丁」。',
].join('\n');
//   ② 应用成功弹窗正文模板：入参为实际变更字段名（服务端 appliedFields 拼好的串），保持拼接不写死
//      片段在「改云端之前」就已生成（否则权威值会被自己顶掉，对照退化成 X → X），成功后随弹窗一并给出
//      注意：wx.showModal 的 confirmText 上限 4 个字符 → 按钮文案只能用「查看片段」，正文引用必须与之逐字一致
const APPLY_DONE_TEXT_TMPL = function (fields) {
  return '已永久生效（变更字段：' + fields + '）。改动已写入 POI 补丁层，后续部署并调用 initSpots 也会自动叠加，不会丢失；点「查看片段」可取得整条 POI JSON，便于择机折回 seed 主本。';
};

// 「POI 补丁」区：服务端 appliedFields 是英文技术字段名，界面必须翻成运营能读的中文
//   未知字段原样显示（服务端新增字段时不至于显示空白）
const PATCH_FIELD_LABELS = {
  coord: '坐标',
  verifyStatus: '状态标记',
  name: '名称',
  type: '类型',
  subType: '子类型',
  address: '地址',
  ageRange: '适龄',
  adultOnly: '仅成人',
  external: '社区外',
  bus: '公交信息',
  updatedAt: '更新日期',
};

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

// POI 现值只读行（字段名严格取自 initSpots/spots.seed.json 中真实存在的键）
//   布尔 → 「是 / 否」；数组 → join('、')；空值（undefined/null/''）不渲染该行。
function buildPoiRows(doc) {
  if (!doc) return [];
  const rows = [];
  function push(k, v) {
    if (v === undefined || v === null || v === '') return;
    let text;
    if (Array.isArray(v)) text = v.join('、');
    else if (typeof v === 'boolean') text = v ? '是' : '否';
    else text = String(v);
    if (text === '') return;
    rows.push({ k: k, v: text });
  }
  push('名称', doc.name);
  push('类型', doc.type);
  push('子类型', doc.subType);
  push('地址', doc.address);
  push('适龄', doc.ageRange);
  push('仅成人', doc.adultOnly);
  push('社区外', doc.external);
  push('核验状态', doc.verifyStatus);
  const bus = doc.bus || {};
  push('公交枢纽', bus.hub);
  push('公交线路', bus.lines);
  push('更新于', doc.updatedAt);
  push('坐标来源', doc.coordSource);
  push('坐标待复核', doc.coordEstimated);
  return rows;
}

// ---- 「POI 补丁」区：把服务端补丁文档收敛成本页一行所需字段 ----
//   服务端契约：每条含 spotId / spotName / patch / appliedFields / reportId / updatedBy / updatedAtServer
//   appliedFields（英文数组）→ 界面中文；updatedAtServer 取前 10 位（YYYY-MM-DD），取不到显示 —。
function decoratePatch(it) {
  const src = it || {};
  const patch = src.patch || {};
  const spotId = src.spotId || patch._id || '';
  const fields = Array.isArray(src.appliedFields) ? src.appliedFields : [];
  const fieldText = fields.map(function (k) { return PATCH_FIELD_LABELS[k] || k; }).join('、') || '—';

  // ISO 字符串前 10 位即 YYYY-MM-DD（服务端为 UTC ISO，运营只需粗粒度日期）
  const iso = src.updatedAtServer || '';
  const dateText = (typeof iso === 'string' && iso.length >= 10) ? iso.slice(0, 10) : '—';

  // 第二行元信息：日期 · 来源反馈（无 reportId 时只显示日期，不留孤立分隔符）
  const reportId = src.reportId || '';
  const metaText = reportId ? (dateText + ' · 来自 local_reports/' + reportId) : dateText;

  return {
    spotId: spotId,
    spotName: src.spotName || spotId || '（未知 POI）',
    patch: patch,
    reportId: reportId,
    fieldText: fieldText,
    dateText: dateText,
    metaText: metaText,
  };
}

// ---- 「复制 JSON」：输出可直接合并回 data/local_spots.seed.json 的扁平对象 ----
//   形态固定为 { _id: spotId, ...patch }；patch 里已有的 updatedAt 原样保留，不再补。
//   patch 内若残留 _id，以 spotId 为准（避免补丁文档里的旧 _id 顶掉权威 _id）。
function buildPatchJson(item) {
  const src = item || {};
  const patch = src.patch || {};
  const out = {};
  const spotId = src.spotId || patch._id || '';
  if (spotId) out._id = spotId;
  Object.keys(patch).forEach(function (k) {
    if (k === '_id') return;
    out[k] = patch[k];
  });
  return JSON.stringify(out, null, 2);
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
  // 补丁列表请求序号（抢占式，与 _reqSeq 同手法）：刷新按钮/自动刷新可能重叠，只允许最新响应落库
  _patchSeq: 0,
  // 补丁删除同步闩：setData 是异步的，极速连点会穿透 loading/disabled，必须用同步布尔兜底
  _patchBusy: false,

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
    noteMap: {},          // { [_id]: 审核备注 / 驳回理由 }
    submitting: false,    // 审核请求进行中（防连点 + 按钮禁用）
    snippetVisible: false, // seed 片段弹层显隐
    seedSnippet: '',      // seed 片段文本

    // ---- 「POI 补丁」管理区（仅 admin，列表视图内；辅助信息，失败不影响审核主流程）----
    patches: [],          // 当前生效的补丁（已 decorate：spotId/spotName/fieldText/metaText/patch…）
    patchLoading: false,  // 补丁列表加载中
    patchLoadError: false, // 补丁列表加载失败（不清空已有 patches，仅提示一行）

    // ---- 两层视图（列表 ↔ 详情）----
    view: 'list',         // 'list' | 'detail'
    detailId: '',         // 当前详情对应的反馈 _id（'' 表示未进入详情）
    detail: {},           // 当前详情承载的反馈（复用行数据，无需二次拉取）
    poiOld: null,         // spots.get 取到的 POI 权威现值（失败为 null）
    poiRows: [],          // POI 现值只读行（[{k,v}]，已格式化）
    poiLoading: false,    // POI 现值加载中
    poiLoadError: false,  // POI 现值取数失败（降级，不阻断其余内容）
    geoPick: null,        // 本轮审核员重新选点结果 {lat,lng}（仅内存，提交时才用）
    repicking: false,     // wx.chooseLocation 进行中（防连点）
  },

  onLoad() {
    // 仅 onLoad 校验身份一次；onShow 不重复拉取（避免双请求）
    this.checkAuth();
  },

  onShow() {
    // 刻意留空：回到本页不重拉队列（避免与 onLoad/下拉刷新形成双请求）
  },

  // 下拉刷新：详情视图直接返回（归属列表视图）；列表视图重置到第 0 页重载当前 tab
  async onPullDownRefresh() {
    if (this.data.view === 'detail') {
      wx.stopPullDownRefresh();
      return;
    }
    if (!this.data.isAdmin) {
      wx.stopPullDownRefresh();
      return;
    }
    this.setData({ list: [], total: 0, page: 0, hasMore: false, loadError: false });
    await this.loadQueue(0);
    wx.stopPullDownRefresh();
  },

  // 触底加载下一页：仅列表视图生效
  onReachBottom() {
    if (this.data.view !== 'list') return;
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
      // 列表视图「出现/刷新」时顺带刷新补丁区（重置请求才拉，分页追加不重复拉）
      //   loadPatches 内部自持 try/catch，且此处置于防御 try 内：补丁区任何异常都不得影响审核主流程
      if (fresh) {
        try {
          this.loadPatches();
        } catch (e) {
          console.error('触发补丁列表加载失败', e);
        }
      }
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
    report._note = reportNote(it.content); // 列表行副标题摘要
    return report;
  },

  // ---- 切换状态 tab：重置并重载第 0 页 ----
  onStatusTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.tab) return;
    this.setData({ tab: key, list: [], total: 0, page: 0, hasMore: false, loadError: false });
    this.loadQueue(0);
  },

  // ---- 列表行 → 进入详情视图 ----
  onOpenDetail(e) {
    const id = e.currentTarget.dataset.id;
    const detail = this.findReport(id);
    if (!detail) return;
    // 进详情前先复位所有详情态，避免残留上一条的坐标/照片/选点
    this.setData({
      view: 'detail',
      detailId: id,
      detail: detail,
      geoPick: null,
      repicking: false,
      poiOld: null,
      poiRows: [],
      poiLoading: false,
      poiLoadError: false,
    });
    this.loadPoi(detail.spotId);
  },

  // ---- 详情视图 → 返回列表（原生导航返回会 pop 整页，故必须页内返回）----
  onCloseDetail() {
    this.setData({
      view: 'list',
      detailId: '',
      detail: {},
      poiOld: null,
      poiRows: [],
      geoPick: null,
      repicking: false,
      poiLoading: false,
      poiLoadError: false,
    });
  },

  // ---- 取 POI 权威现值（详情只读字段 + 旧值对照）；失败降级不阻断 ----
  //   spots 云函数失败返回 errMsg 而非 message，callCloud 会 reject 成「云函数返回失败」，故必须 try/catch。
  async loadPoi(spotId) {
    if (!spotId) {
      this.setData({ poiOld: null, poiRows: [], poiLoading: false, poiLoadError: true });
      return;
    }
    this.setData({ poiLoading: true, poiLoadError: false });
    try {
      const res = await callCloud('spots', { action: 'get', id: spotId });
      const poiOld = (res && res.data) || null;
      this.setData({ poiOld: poiOld, poiRows: buildPoiRows(poiOld), poiLoading: false, poiLoadError: false });
    } catch (err) {
      this.setData({ poiOld: null, poiRows: [], poiLoading: false, poiLoadError: true });
    }
  },

  // ---- 地图重新选点（wx.chooseLocation）：结果仅存内存 geoPick，不改 suggestCoord ----
  onRelocate() {
    if (this.data.repicking) return; // 防连点
    this.setData({ repicking: true });
    wx.chooseLocation({
      success: (res) => {
        const lat = res && res.latitude;
        const lng = res && res.longitude;
        if (typeof lat !== 'number' || typeof lng !== 'number') {
          wx.showToast({ title: '选点结果无效', icon: 'none' });
          return; // 非法结果不写
        }
        this.setData({ geoPick: { lat: lat, lng: lng } });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') >= 0) {
          return; // 用户取消：静默，保留原坐标
        }
        if (msg.indexOf('auth') >= 0 || msg.indexOf('authorize') >= 0 || msg.indexOf('deny') >= 0) {
          wx.showToast({ title: '需要位置权限才能选点', icon: 'none' });
          return; // 权限拒绝：保留原坐标
        }
        wx.showToast({ title: '选点失败，请重试', icon: 'none' });
      },
      complete: () => {
        this.setData({ repicking: false });
      },
    });
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

  // ---- 提交坐标来源（仅「位置不准」+ 本轮已选点 → 传 coordOverride） ----
  pickOverride(report) {
    if (report && report.type === '位置不准' && this.data.geoPick) {
      return this.data.geoPick;
    }
    return null;
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
      const snippet = await this.buildSeedSnippet(report, this.data.geoPick);
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
    await this.doReview(id, 'accepted', false, (this.data.noteMap[id] || '').trim(), this.pickOverride(report));
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
      content: APPLY_CONFIRM_TEXT,
      cancelText: '取消',
      confirmText: '确认应用',
      success: async (res) => {
        if (!res.confirm) return; // 取消：不发起任何请求
        // 片段必须在 doReview 改云端「之前」生成：片段里要留「旧值 → 新值」对照，
        // 改完再取权威值拿到的就是新值，对照会退化成 X → X，运营会白改一版 updatedAt。
        let snippet = '';
        this.setData({ submitting: true });
        try {
          snippet = (await this.buildSeedSnippet(report, this.pickOverride(report))) || '';
        } catch (err) {
          // buildSeedSnippet 内部已降级，这里仅防御：生成失败不阻断应用
          console.error('生成 seed 片段失败', err);
        } finally {
          this.setData({ submitting: false });
        }
        await this.doReview(id, 'accepted', true, note, this.pickOverride(report), snippet);
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
  async doReview(id, status, applyToSpots, note, coordOverride, snippet) {
    if (this._busy) return { ok: false, reason: 'busy' };
    this._busy = true;
    const reviewNote = (note != null ? note : (this.data.noteMap[id] || '')).trim();
    this.setData({ submitting: true });
    try {
      const payload = {
        action: 'review',
        _id: id,
        status: status,
        reviewNote: reviewNote,
        applyToSpots: !!applyToSpots,
      };
      // 仅当确有坐标覆盖时才带上（其余类型传了也会被服务端忽略，但不徒增噪音）
      if (coordOverride) payload.coordOverride = coordOverride;
      const res = await callCloud('reports', payload);

      // 成功提示
      if (applyToSpots && res && res.appliedToSpots) {
        const fields = (res.appliedFields || []).join('、') || 'coord';
        const snip = snippet || '';
        wx.showModal({
          title: '已应用到云端',
          content: APPLY_DONE_TEXT_TMPL(fields),
          showCancel: false,
          confirmText: snip ? '查看片段' : '我知道了',
          success: () => {
            if (!snip) return;
            this.setData({ seedSnippet: snip, snippetVisible: true });
            wx.setClipboardData({
              data: snip,
              success() { wx.showToast({ title: '已复制，请按 SOP 粘进 seed 主本', icon: 'none' }); },
              fail() { wx.showToast({ title: '复制失败，请手动长按复制', icon: 'none' }); },
            });
          },
        });
      } else {
        wx.showToast({ title: status === 'accepted' ? '已采纳' : '已驳回', icon: 'none' });
      }

      // 从当前列表移除该条并刷新队列（保证与服务端一致）；同时复位详情态回列表
      const list = (this.data.list || []).filter((x) => x._id !== id);
      this.setData({
        list: list,
        total: Math.max(0, this.data.total - 1),
        view: 'list',
        detailId: '',
        detail: {},
        poiOld: null,
        poiRows: [],
        poiLoading: false,
        poiLoadError: false,
        geoPick: null,
        repicking: false,
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
      // 保留当前详情/备注（不清空上下文，便于改完重试）
      return { ok: false, err: err };
    } finally {
      this.setData({ submitting: false });
      this._busy = false;
    }
  },

  // ==================== 「POI 补丁」管理区（仅 admin） ====================
  //  补丁层是「直接应用到云端」永久生效的载体：initSpots 会在 seed 原文之上叠加补丁。
  //  这块区域是防止补丁沦为「暗配置」的闭环：能看见、能复制成可折回 seed 的 JSON、能确认折回后删除。
  //  三条铁律：
  //   ① 纯辅助信息 —— 任何失败只降级为一行提示，绝不影响队列/审核主流程；
  //   ② _patchSeq 丢弃过期响应（刷新按钮 + 自动刷新可能重叠）；
  //   ③ 删除用同步闩 _patchBusy 防极速连点（setData 异步，disabled 挡不住），finally 必释放。

  // 拉取当前生效补丁列表（admin 专属；非 admin 服务端返回 FORBIDDEN → 走失败分支只提示）
  async loadPatches() {
    const seq = ++this._patchSeq;
    this.setData({ patchLoading: true, patchLoadError: false });
    try {
      const res = await callCloud('reports', { action: 'patches' });
      if (seq !== this._patchSeq) return; // 已被更新的请求取代 → 丢弃，不 setData
      const raw = (res && res.list) || [];
      this.setData({
        patches: raw.map(decoratePatch),
        patchLoading: false,
        patchLoadError: false,
      });
    } catch (err) {
      if (seq !== this._patchSeq) return; // 过期请求的失败同样丢弃
      console.error('加载 POI 补丁失败', err);
      // 失败不清空既有列表（保留上一次可用数据），仅置失败标记让区域显示一行可重试提示
      this.setData({ patchLoading: false, patchLoadError: true });
    }
  },

  // 「刷新」按钮：强制重拉（loadPatches 自带序号抢占，重复点击不会写脏数据）
  onReloadPatches() {
    this.loadPatches();
  },

  // 「复制 JSON」：复制成可直接合并回 data/local_spots.seed.json 的扁平对象
  onCopyPatchJson(e) {
    const spotId = e.currentTarget.dataset.id || '';
    const item = (this.data.patches || []).find((x) => x.spotId === spotId) || null;
    if (!item) {
      wx.showToast({ title: '未找到该补丁，请刷新后重试', icon: 'none' });
      return;
    }
    const text = buildPatchJson(item);
    wx.setClipboardData({
      data: text,
      success() { wx.showToast({ title: '已复制，请合并回 seed 主本', icon: 'none' }); },
      fail() { wx.showToast({ title: '复制失败，请手动长按复制', icon: 'none' }); },
    });
  },

  // 「已折回，删补丁」：二次确认（防误删）→ dropPatch
  //   同步闩 _patchBusy 在「弹窗之前」上锁，取消/失败/成功三条路径都必须解锁
  onDropPatch(e) {
    const spotId = e.currentTarget.dataset.id || '';
    if (!spotId) return;
    if (this._patchBusy) return; // 极速连点穿透兜底
    this._patchBusy = true;
    wx.showModal({
      title: '删除补丁？',
      content: '确认你已经把这条改动折回 seed 主本了吗？删除后线上现值会保留到下次调用 initSpots；在此之前不要删除。',
      cancelText: '取消',
      confirmText: '删除',
      success: (res) => {
        if (!res.confirm) {
          this._patchBusy = false; // 取消：立即解锁
          return;
        }
        this.dropPatch(spotId); // 内部 finally 解锁
      },
      fail: () => {
        this._patchBusy = false; // 弹窗本身失败：必须解锁，否则永久卡死
      },
    });
  },

  // 实际删除：只删补丁文档，不动 local_spots（线上现值保留到下次 initSpots）
  async dropPatch(spotId) {
    try {
      await callCloud('reports', { action: 'dropPatch', _id: spotId });
      const patches = (this.data.patches || []).filter((x) => x.spotId !== spotId);
      this.setData({ patches: patches });
      wx.showToast({ title: '已删除', icon: 'none' });
    } catch (err) {
      const code = err && err.code;
      let msg = (err && err.message) || '删除失败，请重试';
      if (code === 'FORBIDDEN') msg = '无审核权限';
      console.error('删除 POI 补丁失败', err);
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this._patchBusy = false; // 无论成功失败必须解锁
    }
  },

  // ---- 生成 seed 采纳片段（供运营粘进 data/local_spots.seed.json） ----
  // 三种输出形态：
  //   ② 一般采纳：位置不准 / 已关闭或不存在（doc 取到且坐标齐备）→ 整条 POI JSON（可整条替换）+ 变更对照
  //   ① 需人工处理：信息有误 / 设施变化 / 其他 → 无结构化字段，仅输出当前值对照 JSON + 人工处理指引（未做任何改动）
  //   ③ 降级：spots.get 失败，或「位置不准」缺坐标 → 只输出被改字段片段
  // 坐标「新值」来源优先级（§13.5）：override（审核员重新选点）> report.suggestCoord（家长上报）
  async buildSeedSnippet(report, override) {
    const type = report.type;
    const spotId = report.spotId || '';
    const reportId = report._id || '';
    const overrideCoord = (override && typeof override.lat === 'number' && typeof override.lng === 'number') ? override : null;
    const suggest = overrideCoord || report.suggestCoord || null;
    const needCoord = type === '位置不准';

    // 取 POI 当前权威值（spots.get）；该云函数失败返回 errMsg 而非 message，必须 try/catch 降级
    let doc = null;
    try {
      const res = await callCloud('spots', { action: 'get', id: spotId });
      doc = (res && res.data) || null;
    } catch (e) {
      doc = null;
    }

    // 补丁层上线后：直写云端已永久生效（initSpots 会叠加补丁），此处仅回收「折回主本」的正规链路
    const chainWarn = '⚠️ 折回主本请走完整链：归档主本 data/local_spots.seed.json → cp 到 cloudfunctions/initSpots/spots.seed.json → 部署 initSpots → 调用一次；折回并确认后，到审核列表「POI 补丁」区点「已折回，删补丁」清掉对应补丁（本次改动已永久生效，不折回也不会丢）';
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

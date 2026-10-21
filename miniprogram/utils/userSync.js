/**
 * userSync —— 用户数据（宝宝资料 / 当前宝宝 / 板块 / 户外时长）云端同步
 * 对应架构设计《架构设计_用户数据云端化_2026-10-20.md》§3 / §5.2。
 *
 * 职责边界（写死，防止蔓延）：
 *  - 只做一件事：把 app.globalData 的三类数据搬上云端、从云端搬回来。
 *  - 不持有业务状态（状态永远在 app.globalData）、不做 UI、不弹 toast、不调 setData。
 *  - 所有导出函数内部 try/catch，永不向外抛异常 —— 云不可用 = 完全退回纯本地，体验零退化。
 *  - 依赖：utils/cloud.js 的 callCloud（其 reject 只透传 code、不透传 data，
 *    所以 CONFLICT 拿不到冲突文档，只能再调一次 pull 以云端为准）。
 */
const { callCloud } = require('./cloud.js');

// ---- 模块私有状态 ----
let _app = null;      // App 实例（start 时注入；不持有业务数据，只持有引用）
let _ready = false;   // pull 是否成功过（守卫①：pull 成功前不允许 push）
let _pushable = false; // 是否允许 push（守卫① + 守卫②）
let _lastFailAt = 0;  // 最近一次失败时间戳（isDirty 用；成功 push 后清零）
let _timers = {};     // 节流定时器 { key: timerId }
let _lastPushSig = ''; // 上次成功推送的数据指纹（去重用，见 push）

function _warn(msg, err) {
  // 云同步失败一律静默：只 warn，不做任何用户可见提示（离线是常态）
  console.warn('[userSync] ' + msg, err && (err.code || err.message || err.errMsg || err));
}

// 守卫：允许 push 才推（pull 未成功过 / 本地 babies 为空 → 一律不推，
// 后者是「本地空数据清空云端」的第二层守卫）
function canPush() {
  if (!_pushable) return false;
  if (!_app || !_app.globalData) return false;
  const babies = _app.globalData.babies;
  if (!Array.isArray(babies) || !babies.length) return false;
  return true;
}

// payload 每次现取、不缓存快照（节流期间数据可能已经变了，取最新才是正确的）
function buildPayload() {
  const g = _app.globalData;
  return {
    action: 'push',
    baseRev: g.userRev || 0,
    babies: g.babies || [],
    curBabyId: g.curBabyId || '',
    babyIdx: g.babyIdx || 0,
    block: g.block || '',
    outdoor: g.outdoor || { outdoor: 0, goal: 60, day: '' },
  };
}

/**
 * 稳定序列化：对象按 key 升序输出，保证同一份数据永远得到同一个字符串。
 * 不能直接 JSON.stringify —— 对象 key 顺序随赋值先后变化会产生假差异。
 * @param {*} v
 * @returns {string}
 */
function _stable(v) {
  if (v === undefined) return 'null';
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(_stable).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + _stable(v[k]); }).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * 数据指纹：只对「会被写进云端的业务字段」取签名。
 * ⚠️ 必须排除 baseRev —— 它每次成功推送都会自增，算进去会让去重永远失效。
 * @returns {string}
 */
function _sig() {
  const g = _app.globalData;
  return _stable({
    babies: g.babies || [],
    curBabyId: g.curBabyId || '',
    babyIdx: g.babyIdx || 0,
    block: g.block || '',
    outdoor: g.outdoor || { outdoor: 0, goal: 60, day: '' },
  });
}

// 记录本地已知云端 rev（写 globalData + storage，避免杀进程后 baseRev 回退引发无谓 CONFLICT）
function _setRev(rev) {
  if (_app && _app.globalData) _app.globalData.userRev = rev;
  try { wx.setStorageSync('userRev', rev); } catch (e) { /* storage 失败不影响内存态 */ }
}

/**
 * 拉取云端档案并覆盖本地（云端为主）
 * @returns {Promise<{ok:boolean, exists:boolean, code?:string}>} 永不 reject
 */
async function pull() {
  try {
    const res = await callCloud('userdata', { action: 'pull' });
    if (res && res.exists && res.data && _app && _app.applyCloudProfile) {
      // pull 的 rev 在返回体顶层，applyCloudProfile 需要它写本地 userRev → 合进 data
      _app.applyCloudProfile(Object.assign({}, res.data, { rev: res.rev || 0 }));
    }
    // exists:false（云端无文档）→ 保留本地数据，交给 push('init') 完成首次上云
    return { ok: true, exists: !!(res && res.exists) };
  } catch (e) {
    _lastFailAt = Date.now();
    _warn('pull 失败，退回纯本地', e);
    return { ok: false, exists: false, code: e && e.code };
  }
}

/**
 * 立即推一次云端（内部仍走守卫 + 指纹去重）
 * @param {string} reason 仅用于日志排查（'init' / 'profile' / 'outdoor' ...）
 * @returns {Promise<{ok:boolean, rev?:number, code?:string, skipped?:boolean, dedup?:boolean}>} 永不 reject
 */
async function push(reason) {
  try {
    if (!canPush()) return { ok: false, skipped: true, reason: reason };
    const sig = _sig();
    // 去重：内容与上次成功推送完全一致 → 不发请求。
    // 典型收益两处：① pauseTimer 已立即推过，3s 尾部节流到期的那次是纯重复；
    // ② 切 tab / 切后台触发的 onHide push，数据其实一个字节都没变。
    if (sig && sig === _lastPushSig) {
      return { ok: true, skipped: true, dedup: true, reason: reason };
    }
    const res = await callCloud('userdata', buildPayload());
    if (res && typeof res.rev === 'number') _setRev(res.rev);
    _lastPushSig = sig; // 仅在成功后落指纹，失败不落 → 下次原样重试
    _lastFailAt = 0;
    return { ok: true, rev: res && res.rev };
  } catch (e) {
    _lastFailAt = Date.now();
    const code = e && e.code;
    if (code === 'CONFLICT') {
      // callCloud 的 reject 不透传 data，拿不到云端文档 → 重新 pull 以云端为准；
      // 不重试本次 payload（否则会覆盖掉云端更新的数据）
      _warn('push 冲突，改以云端为准', e);
      await pull();
      return { ok: false, code: code, conflict: true };
    }
    _warn('push 失败（' + (reason || '-') + '）', e);
    return { ok: false, code: code };
  }
}

/**
 * 节流推：同 key 合并、尾部触发（注意是「尾部触发 + 每次清 int 重排」，不是「每 N 秒推一次」）
 * @param {string} key 'profile'（600ms） / 'outdoor'（3000ms，syncOutdoor 每秒跑一次，必须节流）
 * @param {number} waitMs 等待毫秒
 */
function pushThrottled(key, waitMs) {
  try {
    const k = key || 'default';
    let wait = typeof waitMs === 'number' && waitMs >= 0 ? waitMs : 600;
    if (_timers[k]) clearTimeout(_timers[k]);
    _timers[k] = setTimeout(function () {
      _timers[k] = null;
      push(k);
    }, wait);
  } catch (e) {
    _warn('pushThrottled 异常', e);
  }
}

/**
 * 冷启动入口：pull → 决策 pushable → 云端无文档且本地有数据则立即 push('init') 上云
 * @param {Object} app App 实例
 * @returns {Promise<{ok:boolean}>} 永不 reject
 */
async function start(app) {
  try {
    _app = app || null;
    if (!_app) return { ok: false };
    const r = await pull();
    if (r && r.ok) {
      _ready = true;
      _pushable = true;
      const babies = _app.globalData && _app.globalData.babies;
      // 云端无文档 + 本地有数据 = 老用户首次上云（守卫①的唯一例外）
      if (r.exists === false && Array.isArray(babies) && babies.length) {
        await push('init');
      }
      return { ok: true };
    }
    // 云不可用：守卫② —— 仅当本机曾与云端对过账（userRev > 0）才允许离线补推
    _ready = false;
    _pushable = ((_app.globalData && _app.globalData.userRev) || 0) > 0;
    _warn('云端不可用，本次会话退回纯本地（pushable=' + _pushable + '）', null);
    return { ok: false };
  } catch (e) {
    _ready = false;
    try { _pushable = ((_app && _app.globalData && _app.globalData.userRev) || 0) > 0; } catch (e2) { /* noop */ }
    _warn('start 异常', e);
    return { ok: false };
  }
}

/**
 * 是否存在「推失败过、待补推」的脏状态（供页面 onShow 判断是否补一次）
 * @returns {boolean}
 */
function isDirty() {
  return _lastFailAt > 0;
}

module.exports = { start, pull, push, pushThrottled, isDirty };

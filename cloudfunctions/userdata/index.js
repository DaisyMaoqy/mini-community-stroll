// userdata —— 用户数据云端化服务端（pull / push）
// 对应架构设计《架构设计_用户数据云端化_2026-10-20.md》§4。
// 集合：user_profiles，_id = openid（一人一档），整文档覆盖 + rev 乐观锁。
// 前端调用：wx.cloud.callFunction({ name: 'userdata', data: { action, ... } })
//   - 返回统一为 { success:true, ... } 或 { success:false, code, message }
//   - message 为「用户可读文案」供前端 toast（utils/cloud.js 读的是 message 字段，不是 errMsg）
//   - 身份只从 cloud.getWXContext().OPENID 取，前端传入的 _openid / rev / updatedAt / schema 一律丢弃
//   - 云控制台「测试普通云函数」不带用户身份 → NO_OPENID 是预期结果，不是 bug，不要为此加 workaround
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTION = "user_profiles";
const SCHEMA = 1; // 文档结构版本，预留未来升级
const MAX_BABIES = 10; // 宝宝数量上限
const MAX_NAME = 20; // 宝宝昵称上限
const MAX_BLOCK = 20; // 板块名上限（不做枚举校验，板块会随数据扩充）
const GOAL_MIN = 1; // 每日目标分钟下限
const GOAL_MAX = 1440; // 每日目标分钟上限（24h）
const GOAL_DEFAULT = 60; // 每日目标缺省值
const OUTDOOR_DEFAULT = { outdoor: 0, goal: GOAL_DEFAULT, day: "" };

// 错误码全集（架构设计 §4.3）；前端以字面量比较（小程序与云函数不共享模块）
const CODES = {
  NO_OPENID: "NO_OPENID",
  INVALID_PARAM: "INVALID_PARAM",
  CONFLICT: "CONFLICT",
  COLLECTION_ERROR: "COLLECTION_ERROR",
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
};

// 统一失败返回体（message 为前端可直接 toast 的文案）
function fail(code, message) {
  return { success: false, code: code, message: message };
}

// updatedAt 归一化为 ISO 字符串，便于前端展示/排查
function toIso(v) {
  return v instanceof Date ? v.toISOString() : v;
}

// 确保集合存在：云函数端 doc().set() 不会自动建集合，集合不存在会报 -502005。
// 已存在时 createCollection 会抛错，忽略即可（与 reports/index.js:66-72 保持一致）。
async function ensureCollection() {
  try {
    await db.createCollection(COLLECTION);
  } catch (e) {
    // ignore：集合已存在属正常情况；其它异常会在后续 get()/set()/update() 处暴露为 COLLECTION_ERROR
  }
}

// 有限数值判定（排除 NaN / Infinity，避免脏数据入库）
function isFiniteNumber(v) {
  return typeof v === "number" && isFinite(v);
}

// day 时间戳：'YYYY-M-D' **无补零**（见 pages/index/index.js 的 _dayKey），
// 必须按日期语义比较，不能字典序比（'2026-10-9' 字典序大于 '2026-10-10'，语义却更小）。
function dayTs(day) {
  if (typeof day !== "string") return 0;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(day);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

// 宝宝列表白名单校验 + 组装（§4.3.3）：
//   - 必须非空数组且 ≤10，否则 INVALID_PARAM（这是「本地空数据清空云端」的服务端守卫）
//   - 每项：id 非空字符串（缺失由服务端兜底生成，不因此失败）；name 字符串 ≤20；
//     birth 为 '' 或 /^\d{4}-\d{2}-\d{2}$/；gender ∈ {'','boy','girl'}，其它归 ''；
//     lat/lng 仅在为有限 number 时保留
// 返回 null 表示校验失败
function sanitizeBabies(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_BABIES) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i] && typeof list[i] === "object" ? list[i] : {};
    let id = typeof b.id === "string" ? b.id.trim() : "";
    if (!id) id = "b_srv_" + i + "_" + Date.now().toString(36);
    let name = typeof b.name === "string" ? b.name : "";
    if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME);
    let birth = typeof b.birth === "string" ? b.birth : "";
    if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) birth = "";
    let gender = typeof b.gender === "string" ? b.gender : "";
    if (gender !== "boy" && gender !== "girl") gender = "";
    const baby = { id: id, name: name, birth: birth, gender: gender };
    if (isFiniteNumber(b.lat)) baby.lat = b.lat;
    if (isFiniteNumber(b.lng)) baby.lng = b.lng;
    out.push(baby);
  }
  return out;
}

// 板块：字符串 ≤20，不做枚举校验（板块会随 seed 数据扩充，枚举校验会误拒）
function sanitizeBlock(v) {
  let s = typeof v === "string" ? v : "";
  if (s.length > MAX_BLOCK) s = s.slice(0, MAX_BLOCK);
  return s;
}

// 宝宝 id / 当前宝宝 id：字符串截断，非字符串归 ''
function sanitizeId(v) {
  return typeof v === "string" ? v.slice(0, 64) : "";
}

// 下标：整数并夹到 [0, len-1]
function sanitizeIdx(v, len) {
  let i = parseInt(v, 10);
  if (isNaN(i)) i = 0;
  return Math.min(Math.max(0, i), Math.max(0, len - 1));
}

// babyIdx 是派生值：服务端按 curBabyId 重算，找不到才回落前端传入的下标
function resolveIdx(babies, curBabyId, fallbackIdx) {
  if (curBabyId) {
    for (let i = 0; i < babies.length; i++) {
      if (babies[i].id === curBabyId) return i;
    }
  }
  return sanitizeIdx(fallbackIdx, babies.length);
}

// 户外计时白名单：outdoor ≥0；goal 夹到 [1,1440]，缺省 60；day 保留字符串（可为空）
function sanitizeOutdoor(o) {
  const src = o && typeof o === "object" ? o : {};
  let outdoor = isFiniteNumber(src.outdoor) ? Math.max(0, src.outdoor) : 0;
  let goal = isFiniteNumber(src.goal) ? Math.round(src.goal) : GOAL_DEFAULT;
  if (goal < GOAL_MIN) goal = GOAL_MIN;
  if (goal > GOAL_MAX) goal = GOAL_MAX;
  return {
    outdoor: outdoor,
    goal: goal,
    day: typeof src.day === "string" ? src.day : "",
  };
}

// outdoor 字段级合并（架构设计 §3.3，服务端唯一的字段级例外）：
//   - incoming.day 为空 → 本次不写 outdoor（返回 null，视为未初始化，不冲掉云端）
//   - 两边 day 都非空：同一天取 Math.max；不同天取日期更新的那份（按日期语义比，不字典序）
// 返回 null 表示「本次不写该字段」
function mergeOutdoor(incoming, existing) {
  if (!incoming || !incoming.day) return null;
  if (!existing || !existing.day) return incoming;
  if (incoming.day === existing.day) {
    return {
      outdoor: Math.max(incoming.outdoor || 0, existing.outdoor || 0),
      goal: incoming.goal,
      day: incoming.day,
    };
  }
  return dayTs(incoming.day) > dayTs(existing.day) ? incoming : existing;
}

exports.main = async (event) => {
  const action = event && event.action;
  // 身份一律取服务端上下文，忽略前端传入的 openid（§4 安全边界）
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  switch (action) {
    case "pull": {
      if (!openid) return fail(CODES.NO_OPENID, "未获取到用户身份");
      // 集合不存在（-502005）或本人无文档 → 正常首登，exists:false，不报错
      let doc = null;
      try {
        const r = await db.collection(COLLECTION).doc(openid).get();
        doc = r && r.data;
      } catch (e) {
        doc = null;
      }
      if (!doc) return { success: true, exists: false, rev: 0, data: null };
      return {
        success: true,
        exists: true,
        rev: doc.rev || 0,
        data: {
          schema: doc.schema || 0,
          babies: Array.isArray(doc.babies) ? doc.babies : [],
          curBabyId: typeof doc.curBabyId === "string" ? doc.curBabyId : "",
          babyIdx: typeof doc.babyIdx === "number" ? doc.babyIdx : 0,
          block: typeof doc.block === "string" ? doc.block : "",
          outdoor: doc.outdoor && typeof doc.outdoor === "object" ? doc.outdoor : null,
          updatedAt: toIso(doc.updatedAt),
        },
      };
    }

    case "push": {
      if (!openid) return fail(CODES.NO_OPENID, "未获取到用户身份");
      // 铁律 R1：写入前首行确保集合存在（集合不存在时 set 会报 -502005）
      await ensureCollection();

      // ① 校验 + 白名单组装（前端传入的 rev / updatedAt / _id / _openid / schema 一律丢弃）
      const babies = sanitizeBabies(event.babies);
      if (!babies) return fail(CODES.INVALID_PARAM, "数据格式有误");
      const curBabyId = sanitizeId(event.curBabyId);
      const babyIdx = resolveIdx(babies, curBabyId, event.babyIdx);
      const block = sanitizeBlock(event.block);
      const outdoor = sanitizeOutdoor(event.outdoor);
      let baseRev = parseInt(event.baseRev, 10);
      if (isNaN(baseRev)) baseRev = 0;

      const full = {
        schema: SCHEMA,
        babies: babies,
        curBabyId: curBabyId,
        babyIdx: babyIdx,
        block: block,
      };

      // ② 先 get 判存在，再 set / update（铁律 R2：不依赖 stats.updated === 0 判 NOT_FOUND）
      let doc = null;
      try {
        const r = await db.collection(COLLECTION).doc(openid).get();
        doc = r && r.data;
      } catch (e) {
        doc = null;
      }

      // ③ 首写
      if (!doc) {
        const merged = mergeOutdoor(outdoor, null);
        if (merged) full.outdoor = merged;
        const created = Object.assign({}, full, { rev: 1, updatedAt: db.serverDate() });
        try {
          await db.collection(COLLECTION).doc(openid).set({ data: created });
        } catch (e) {
          return fail(CODES.COLLECTION_ERROR, "保存失败，请重试");
        }
        return { success: true, rev: 1, updatedAt: new Date().toISOString() };
      }

      // ④ 乐观锁：云端 rev 领先 → 拒绝本次覆盖（前端收到后重新 pull，以云端为准）
      if ((doc.rev || 0) > baseRev) return fail(CODES.CONFLICT, "云端有更新的数据");

      // ⑤ 覆盖写（整文档 last-write-wins，唯一例外是 outdoor 的字段级合并）
      const nextRev = (doc.rev || 0) + 1;
      const merged = mergeOutdoor(outdoor, doc.outdoor);
      if (merged) full.outdoor = merged;
      const patch = Object.assign({}, full, { rev: nextRev, updatedAt: db.serverDate() });
      try {
        await db.collection(COLLECTION).doc(openid).update({ data: patch });
      } catch (e) {
        return fail(CODES.COLLECTION_ERROR, "保存失败，请重试");
      }
      return { success: true, rev: nextRev, updatedAt: new Date().toISOString() };
    }

    default:
      return fail(CODES.UNKNOWN_ACTION, "未知操作：" + action);
  }
};

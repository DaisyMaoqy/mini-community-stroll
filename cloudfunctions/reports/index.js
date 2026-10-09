// reports —— POI 纠错上报闭环服务端（submit / mine / get + 审核端 whoami / queue / review）
// 对应增量 PRD《POI 纠错闭环》与架构设计 v1.1 §3.2 / §12.3。
// 前端调用：wx.cloud.callFunction({ name: 'reports', data: { action, ... } })
//   - 返回统一为 { success:true, ... } 或 { success:false, code, message }
//   - message 为「用户可读文案」供前端 toast（注意：utils/cloud.js 读的是 message 字段，不是 errMsg）
//   - 与权威表 local_spots 物理隔离：submit/mine/get 只读写 local_reports；
//     仅 review(applyToSpots=true) 按字段白名单写 local_spots（§12.7）
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ADMINS = require("./admins");

const COLLECTION = "local_reports";
const SPOT_COLLECTION = "local_spots";

// 纠错类型枚举（存储值；chip 显示文案的映射见组件层 report-sheet，§3.4/§8-4）
const TYPE_ENUM = ["位置不准", "已关闭或不存在", "信息有误", "设施变化", "其他"];
const MAX_CONTENT = 200; // 说明字数上限
const MAX_IMAGES = 3; // 照片上限
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h 滚动窗口
const RATE_LIMIT_MAX = 3; // 同 openid 同 spotId 24h 内 ≤3 条（第 4 条被拒，对应 P0-7）

// 审核端枚举与白名单（§12.3.2）
const QUEUE_STATUS_ENUM = ["pending", "accepted", "rejected"];
const REVIEW_STATUS_ENUM = ["accepted", "rejected"];
// 直接应用字段白名单：仅这两类可写 local_spots（§12.3.2 / §12.8）
const APPLY_TYPE_MAP = { "位置不准": "coord", "已关闭或不存在": "verifyStatus" };

// 错误码全集（架构设计 §3.2.4 / §12.3.3）；前端以字面量比较（小程序与云函数不共享模块）
const CODES = {
  INVALID_TYPE: "INVALID_TYPE",
  INVALID_PARAM: "INVALID_PARAM",
  RATE_LIMITED: "RATE_LIMITED",
  COLLECTION_ERROR: "COLLECTION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
  FORBIDDEN: "FORBIDDEN",
  SPOT_NOT_FOUND: "SPOT_NOT_FOUND",
};

// 统一失败返回体（message 为前端可直接 toast 的文案）
function fail(code, message) {
  return { success: false, code: code, message: message };
}

// 与 spots/index.js 的 updatedAt 保持同格式（'YYYY-MM-DD'），避免运营侧口径不一致
function today() {
  return new Date().toISOString().slice(0, 10);
}

// createdAt / reviewedAt 归一化为 ISO 字符串（§12.3.2 明确要求）
function toIso(v) {
  return v instanceof Date ? v.toISOString() : v;
}

// 运营鉴权：仅白名单内 openid 可调用 queue / review
function isAdmin(openid) {
  return Array.isArray(ADMINS) && ADMINS.indexOf(openid) >= 0;
}

// 确保集合存在：云函数端 doc().set() 不会自动建集合，集合不存在会报 -502005。
// 已存在时 createCollection 会抛错，忽略即可（与 initSpots/index.js:47-51 保持一致）。
async function ensureCollection() {
  try {
    await db.createCollection(COLLECTION);
  } catch (e) {
    // ignore：集合已存在属正常情况；其它异常会在后续 add()/count() 处暴露为 COLLECTION_ERROR
  }
}

// suggestCoord 形状校验：允许 null / undefined；非空时须为 { lat:number, lng:number, cs:'gcj02' }
function isValidCoord(c) {
  if (c === undefined || c === null) return true;
  if (typeof c !== "object") return false;
  if (typeof c.lat !== "number" || typeof c.lng !== "number") return false;
  if (c.cs !== "gcj02") return false;
  return true;
}

// coordOverride 形状校验（§13.5）：未提供（undefined/null）视为合法；
// 提供则必须是数值且落在宽松经纬度范围内（不做项目范围校验，避免误伤跨区/边界点位）。
function isValidCoordOverride(c) {
  if (c === undefined || c === null) return true;
  if (typeof c !== "object") return false;
  if (typeof c.lat !== "number" || typeof c.lng !== "number") return false;
  if (!(c.lat >= -90 && c.lat <= 90)) return false;
  if (!(c.lng >= -180 && c.lng <= 180)) return false;
  return true;
}

// submit 参数校验：通过返回 null，否则返回失败体（含对应 code）
function validateSubmit(event) {
  const ev = event || {};
  // type：缺失或不在枚举 → INVALID_TYPE（对应 P0-5）
  if (!ev.type || TYPE_ENUM.indexOf(ev.type) < 0) {
    return fail(CODES.INVALID_TYPE, "请选择反馈类型");
  }
  // spotId / spotName 必填（不校验 spotId 是否存在于 local_spots，§6.7）
  if (!ev.spotId || typeof ev.spotId !== "string" || !ev.spotName || typeof ev.spotName !== "string") {
    return fail(CODES.INVALID_PARAM, "提交失败，请重试");
  }
  // content：可选，≤200
  if (ev.content !== undefined && ev.content !== null) {
    if (typeof ev.content !== "string" || ev.content.length > MAX_CONTENT) {
      return fail(CODES.INVALID_PARAM, "提交失败，请重试");
    }
  }
  // images：可选，字符串数组且 ≤3
  if (ev.images !== undefined && ev.images !== null) {
    if (!Array.isArray(ev.images) || ev.images.length > MAX_IMAGES) {
      return fail(CODES.INVALID_PARAM, "提交失败，请重试");
    }
    for (let i = 0; i < ev.images.length; i++) {
      if (typeof ev.images[i] !== "string" || !ev.images[i]) {
        return fail(CODES.INVALID_PARAM, "提交失败，请重试");
      }
    }
  }
  // suggestCoord：可选，形状须合法
  if (!isValidCoord(ev.suggestCoord)) {
    return fail(CODES.INVALID_PARAM, "提交失败，请重试");
  }
  return null;
}

// 24h 滚动窗口计数：同 openid 同 spotId 在 [now-24h, now] 内的条数（§6.6）
async function countRecent(openid, spotId) {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const res = await db
    .collection(COLLECTION)
    .where({ reporterOpenid: openid, spotId: spotId, createdAt: _.gte(since) })
    .count();
  return res.total;
}

exports.main = async (event) => {
  const action = event && event.action;
  // 身份一律取服务端上下文，忽略前端传入的 reporterOpenid（§8-7 安全边界）
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  switch (action) {
    case "submit": {
      // 铁律 R1：写入前首行确保集合存在（集合不存在时 add 会报 -502005）
      await ensureCollection();

      // ② 参数校验
      const invalid = validateSubmit(event);
      if (invalid) return invalid;

      // ③ 24h 限流计数
      let total = 0;
      try {
        total = await countRecent(openid, event.spotId);
      } catch (e) {
        return fail(CODES.COLLECTION_ERROR, "提交失败，请重试");
      }
      if (total >= RATE_LIMIT_MAX) {
        return fail(CODES.RATE_LIMITED, "今日反馈次数已达上限");
      }

      // ④ 白名单组装：前端传入的 reporterOpenid/status/createdAt/reviewed* 一律丢弃
      const doc = {
        spotId: event.spotId,
        spotName: event.spotName,
        type: event.type,
        content: typeof event.content === "string" ? event.content : "",
        images: Array.isArray(event.images) ? event.images.slice(0, MAX_IMAGES) : [],
        suggestCoord: event.suggestCoord || null,
        reporterOpenid: openid, // 服务端上下文取，前端传入被覆盖
        status: "pending", // 恒写死，前端不得指定
        createdAt: db.serverDate(), // 服务端时钟（Date），防客户端改表、满足滚动窗口比较
        reviewedBy: "",
        reviewNote: "",
        appliedToSpots: false, // §12.3.1：审计字段，保持新旧记录字段齐整
        appliedFields: [],
      };
      try {
        const r = await db.collection(COLLECTION).add({ data: doc });
        return { success: true, _id: r._id };
      } catch (e) {
        return fail(CODES.COLLECTION_ERROR, "提交失败，请重试");
      }
    }

    case "mine": {
      // 仅返回本人记录（where reporterOpenid === OPENID）；不接受任何过滤参数
      try {
        const res = await db
          .collection(COLLECTION)
          .where({ reporterOpenid: openid })
          .orderBy("createdAt", "desc")
          .limit(50)
          .get();
        const list = (res.data || []).map(function (d) {
          // 只回必要字段，不暴露他人数据 / 内部字段
          return {
            _id: d._id,
            spotId: d.spotId,
            spotName: d.spotName,
            type: d.type,
            status: d.status,
            createdAt: d.createdAt,
            reviewNote: d.reviewNote || "",
          };
        });
        return { success: true, total: list.length, list: list };
      } catch (e) {
        // 集合尚未创建（未产生任何上报）时视为空列表，避免报错
        const msg = (e && (e.errMsg || e.message)) || String(e);
        if (/502005|collection not exists|ResourceNotFound/i.test(msg)) {
          return { success: true, total: 0, list: [] };
        }
        return fail(CODES.COLLECTION_ERROR, "查询失败，请重试");
      }
    }

    case "get": {
      const id = event && event._id;
      if (!id) return fail(CODES.NOT_FOUND, "记录不存在");
      try {
        const res = await db.collection(COLLECTION).doc(id).get();
        return { success: true, data: res.data };
      } catch (e) {
        // doc().get() 在记录不存在时抛错 → 统一收敛为 NOT_FOUND
        return fail(CODES.NOT_FOUND, "记录不存在");
      }
    }

    // ---- 审核端（§12.3.2）----
    case "whoami": {
      // 不鉴权：仅回本人 openid 与是否运营，绝不回白名单内容
      return { success: true, openid: openid, isAdmin: isAdmin(openid) };
    }

    case "queue": {
      if (!isAdmin(openid)) return fail(CODES.FORBIDDEN, "无审核权限");
      const ev = event || {};
      const status = ev.status || "pending";
      if (QUEUE_STATUS_ENUM.indexOf(status) < 0) {
        return fail(CODES.INVALID_PARAM, "参数错误");
      }
      const page = Math.max(0, parseInt(ev.page, 10) || 0);
      let size = parseInt(ev.size, 10) || 20;
      if (size < 1) size = 20;
      if (size > 50) size = 50;
      try {
        const coll = db.collection(COLLECTION);
        const where = { status: status };
        const cnt = await coll.where(where).count();
        const res = await coll
          .where(where)
          .orderBy("createdAt", "desc")
          .skip(page * size)
          .limit(size)
          .get();
        // 显式字段白名单逐字段组装（严禁 spread 原始 doc）：绝不返回 reporterOpenid（§12.7 隐私）
        const list = (res.data || []).map(function (d) {
          return {
            _id: d._id,
            spotId: d.spotId,
            spotName: d.spotName,
            type: d.type,
            content: d.content || "",
            images: Array.isArray(d.images) ? d.images : [],
            suggestCoord: d.suggestCoord || null,
            status: d.status,
            reviewNote: d.reviewNote || "",
            reviewedAt: d.reviewedAt ? toIso(d.reviewedAt) : d.reviewedAt,
            appliedToSpots: !!d.appliedToSpots,
            appliedFields: Array.isArray(d.appliedFields) ? d.appliedFields : [],
            createdAt: toIso(d.createdAt),
          };
        });
        return { success: true, list: list, total: cnt.total, page: page };
      } catch (e) {
        const msg = (e && (e.errMsg || e.message)) || String(e);
        if (/502005|collection not exists|ResourceNotFound/i.test(msg)) {
          return { success: true, list: [], total: 0, page: page };
        }
        return fail(CODES.COLLECTION_ERROR, "查询失败，请重试");
      }
    }

    case "review": {
      if (!isAdmin(openid)) return fail(CODES.FORBIDDEN, "无审核权限");
      const ev = event || {};
      const id = ev._id;
      const status = ev.status;
      // 2) 校验 _id / status
      if (!id || typeof id !== "string" || REVIEW_STATUS_ENUM.indexOf(status) < 0) {
        return fail(CODES.INVALID_PARAM, "参数错误");
      }
      // 2.1) coordOverride 形状校验（§13.5）：未提供视为合法；提供则必须合法——即使 applyToSpots===false
      //      也需校验，因为要落审计字段 reviewedCoord/coordSource。
      const coordOverride = ev.coordOverride;
      if (!isValidCoordOverride(coordOverride)) return fail(CODES.INVALID_PARAM, "参数错误");
      const hasOverride = !!coordOverride;
      // 3) reviewNote 软校验：非字符串按 ''，超 200 截断（不因缺理由硬失败，§12.7）
      let reviewNote = typeof ev.reviewNote === "string" ? ev.reviewNote : "";
      if (reviewNote.length > MAX_CONTENT) reviewNote = reviewNote.slice(0, MAX_CONTENT);
      const applyToSpots = ev.applyToSpots === true;
      if (applyToSpots && status !== "accepted") {
        return fail(CODES.INVALID_PARAM, "参数错误");
      }

      // 统一「先 get 判存在、再 update」：不依赖 stats.updated===0（文档存在但内容未变时它也为 0，会产生假 NOT_FOUND）
      let rep = null;
      try {
        const r = await db.collection(COLLECTION).doc(id).get();
        rep = r && r.data;
      } catch (e) {
        return fail(CODES.NOT_FOUND, "记录不存在");
      }
      if (!rep) return fail(CODES.NOT_FOUND, "记录不存在");

      let appliedFields = [];
      // 5) 直接应用分支：必须在更新报告状态之前完成；失败即整体中止、不改报告状态
      if (applyToSpots) {
        const field = APPLY_TYPE_MAP[rep.type];
        if (!field) {
          // 覆盖 信息有误 / 设施变化 / 其他：禁止直接应用
          return fail(CODES.INVALID_PARAM, "该类型不支持直接应用，请走 seed 片段");
        }
        let patch = null;
        if (field === "coord") {
          // 坐标来源优先级（§13.5）：coordOverride（审核员重新选点）> suggestCoord（家长上报）
          const coordSrc = hasOverride
            ? { lat: coordOverride.lat, lng: coordOverride.lng }
            : rep.suggestCoord;
          if (!coordSrc || typeof coordSrc !== "object" || typeof coordSrc.lng !== "number" || typeof coordSrc.lat !== "number") {
            return fail(CODES.INVALID_PARAM, "该类型不支持直接应用，请走 seed 片段");
          }
          // 仅写 coord(+updatedAt)；GeoJSON Point 经度在前（§8-6）
          patch = { coord: { type: "Point", coordinates: [coordSrc.lng, coordSrc.lat] }, updatedAt: today() };
        } else if (field === "verifyStatus") {
          // 仅写 verifyStatus(+updatedAt)
          patch = { verifyStatus: "rejected", updatedAt: today() };
        } else {
          return fail(CODES.INVALID_PARAM, "该类型不支持直接应用，请走 seed 片段");
        }
        // 先判权威 POI 存在（get 判存在，不用 stats.updated）
        try {
          await db.collection(SPOT_COLLECTION).doc(rep.spotId).get();
        } catch (e) {
          return fail(CODES.SPOT_NOT_FOUND, "权威 POI 不存在，未应用");
        }
        // 按白名单 patch 写 local_spots（其余字段一律不动）
        try {
          await db.collection(SPOT_COLLECTION).doc(rep.spotId).update({ data: patch });
        } catch (e) {
          return fail(CODES.COLLECTION_ERROR, "提交失败，请重试");
        }
        appliedFields = [field];
      }

      // 6) 审计留痕（§13.5）：仅「已采纳 + 位置不准」记录坐标来源；不覆盖 suggestCoord。
      //    override → 审核员重新选点；report → 回落家长上报坐标；其余场景 null / ""。
      let reviewedCoord = null;
      let coordSource = "";
      if (status === "accepted" && rep.type === "位置不准") {
        if (hasOverride) {
          reviewedCoord = { lat: coordOverride.lat, lng: coordOverride.lng };
          coordSource = "override";
        } else if (rep.suggestCoord && typeof rep.suggestCoord.lat === "number" && typeof rep.suggestCoord.lng === "number") {
          reviewedCoord = { lat: rep.suggestCoord.lat, lng: rep.suggestCoord.lng };
          coordSource = "report";
        }
      }

      // 7) 更新报告状态与审计字段（服务端写入，前端不可伪造）
      try {
        await db.collection(COLLECTION).doc(id).update({
          data: {
            status: status,
            reviewNote: reviewNote,
            reviewedBy: openid,
            reviewedAt: db.serverDate(),
            appliedToSpots: applyToSpots,
            appliedFields: appliedFields,
            reviewedCoord: reviewedCoord,
            coordSource: coordSource,
          },
        });
      } catch (e) {
        return fail(CODES.COLLECTION_ERROR, "提交失败，请重试");
      }

      // 8) 返回（新增审计字段不回传前端）
      if (applyToSpots) {
        return { success: true, appliedToSpots: true, appliedFields: appliedFields };
      }
      return { success: true };
    }

    default:
      return fail(CODES.UNKNOWN_ACTION, "未知操作：" + action);
  }
};

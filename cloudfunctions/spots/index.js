// spots —— local_spots 集合 CRUD + 采集端校验
// 对应 D7 护城河：自维护 POI 数据闭环（采集端提交/纠错 → 校验 → 入库）
// 前端/采集端调用：wx.cloud.callFunction({ name: 'spots', data: { action, ... } })
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const TYPES = ["接种", "遛娃", "便民", "邨巴"];
const VERIFY_STATUS = ["verified", "pending", "disputed", "rejected"];

// 字段校验（采集端入库前把关，防止脏数据污染自维护 POI 库）
function validateSpot(data, partial) {
  const errs = [];
  const need = (c, m) => {
    if (!c) errs.push(m);
  };
  if (!partial) {
    need(data && data.name, "name 必填");
    need(
      data && data.type && TYPES.indexOf(data.type) >= 0,
      "type 必为 " + TYPES.join("/")
    );
  }
  if (data && data.type && TYPES.indexOf(data.type) < 0)
    errs.push("type 非法: " + data.type);
  if (data && data.adultOnly !== undefined && typeof data.adultOnly !== "boolean")
    errs.push("adultOnly 必须为布尔（防重蹈 v9 把祈福医院当儿童点）");
  if (data && data.verifyStatus !== undefined && VERIFY_STATUS.indexOf(data.verifyStatus) < 0)
    errs.push("verifyStatus 非法: " + data.verifyStatus);
  if (data && data.coord !== undefined) {
    need(
      data.coord &&
        data.coord.type === "Point" &&
        Array.isArray(data.coord.coordinates) &&
        data.coord.coordinates.length === 2,
      "coord 须为 geojson Point [lng,lat]"
    );
  }
  return errs;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

exports.main = async (event) => {
  const action = event && event.action;
  const coll = db.collection("local_spots");

  switch (action) {
    case "list": {
      // 构造单一条件对象（链式 where 语义不明确，改用单个 cond 一次匹配）
      const cond = {};
      if (event.type) cond.type = event.type;
      if (event.adultOnly !== undefined) cond.adultOnly = !!event.adultOnly;
      if (event.verifyStatus) cond.verifyStatus = event.verifyStatus;
      let q = coll;
      if (Object.keys(cond).length) q = q.where(cond);
      // 服务端分页，翻完所有匹配文档（种子 12 条 + 余量，上限 100/页）
      const PAGE = 100;
      const all = [];
      let page = 0;
      try {
        while (true) {
          if (page > 100) break; // 安全上限，防止意外死循环
          const res = await q.skip(page * PAGE).limit(PAGE).get();
          all.push(...res.data);
          if (res.data.length < PAGE) break;
          page++;
        }
        // 若调用方传了正数值 limit，则作为上限截断（0/undefined 表示不限）
        if (event.limit && all.length > event.limit) all.length = event.limit;
        return { success: true, list: all, total: all.length };
      } catch (e) {
        const msg = (e && (e.errMsg || e.message)) || String(e);
        // 集合尚未初始化（-502005 collection not exists）时返回空列表，
        // 避免调试台/前端抛错；跑一次 initSpots 后即有数据。
        if (/502005|collection not exists|ResourceNotFound/i.test(msg)) {
          return { success: true, list: [], total: 0, empty: true };
        }
        return { success: false, errMsg: msg };
      }
    }

    case "get":
      if (!event.id) return { success: false, errMsg: "id 必填" };
      return { success: true, data: (await coll.doc(event.id).get()).data };

    case "create": {
      const d = event.data || {};
      const errs = validateSpot(d, false);
      if (errs.length) return { success: false, errMsg: "校验失败", errors: errs };
      const id =
        d._id || "spot_" + Date.now() + "_" + Math.floor(Math.random() * 1e4);
      const data = Object.assign({}, d, {
        createdAt: today(),
        updatedAt: today(),
      });
      delete data._id;
      // 采集时若标 verified，自动算 verifyDueAt（+90d 复核到期）
      if (data.verifyStatus === "verified" && !data.verifyDueAt) {
        const due = new Date();
        due.setDate(due.getDate() + 90);
        data.verifyDueAt = due.toISOString().slice(0, 10);
      }
      await coll.doc(id).set({ data });
      return { success: true, id, data: Object.assign({ _id: id }, data) };
    }

    case "update": {
      if (!event.id) return { success: false, errMsg: "id 必填" };
      const d = event.data || {};
      const errs = validateSpot(d, true);
      if (errs.length) return { success: false, errMsg: "校验失败", errors: errs };
      const data = Object.assign({}, d, { updatedAt: today() });
      delete data._id;
      await coll.doc(event.id).update({ data });
      return { success: true, id: event.id };
    }

    case "remove":
      if (!event.id) return { success: false, errMsg: "id 必填" };
      await coll.doc(event.id).remove();
      return { success: true, id: event.id };

    default:
      return { success: false, errMsg: "未知 action: " + action };
  }
};

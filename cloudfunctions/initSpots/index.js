// initSpots —— 一键让 local_spots 集合与种子文件完全一致（权威同步）
// 部署后在微信开发者工具「云开发 → 云函数」右键「上传并部署」本函数，
// 前端或云函数调试台调用：wx.cloud.callFunction({ name: 'initSpots', data: {} })
//
// ⚠️ 关键 1：云函数端 db.collection(x).doc(id).set() **不会**自动创建集合，
//    集合不存在时会直接报 -502005 collection not exists。故此处先显式 createCollection。
// ⚠️ 关键 2：doc(id).set() 只做 upsert（新建/覆盖），**不会删除**集合里已有的其它文档。
//    因此「种子删掉一条」后重跑本函数，旧记录会残留在集合里（表现为前端读到的条数 > 种子条数）。
//    故本函数在 upsert 之后会 **prune**：删除所有 _id 不在种子里的记录，使集合 == 种子。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const seed = require("./spots.seed.json");

const COLLECTION = "local_spots";

exports.main = async () => {
  const spots = (seed && seed.spots) || [];
  const seedIds = new Set(spots.map((s) => s._id).filter(Boolean));
  let done = 0;
  let pruned = 0;
  let failed = 0;
  const errors = [];

  // 确保集合存在（已存在时 createCollection 会抛错，直接忽略；
  // 若因其他原因失败，下方写入会给出明确错误）
  try {
    await db.createCollection(COLLECTION);
  } catch (e) {
    // ignore：集合已存在属正常情况
  }

  // 1) upsert 种子（doc.set：已存在覆盖，不存在创建，幂等）
  for (const s of spots) {
    const id = s._id;
    if (!id) {
      failed++;
      errors.push("skip: missing _id");
      continue;
    }
    const data = Object.assign({}, s);
    delete data._id;
    try {
      await db.collection(COLLECTION).doc(id).set({ data });
      done++;
    } catch (e) {
      failed++;
      errors.push(id + ": " + (e && (e.errMsg || e.message) ? (e.errMsg || e.message) : e));
    }
  }

  // 2) prune：删除不在种子里的历史记录（分页扫描，防 100 条上限）
  try {
    const existing = [];
    const PAGE = 100;
    let page = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await db
        .collection(COLLECTION)
        .skip(page * PAGE)
        .limit(PAGE)
        .get();
      const rows = (res && res.data) || [];
      if (!rows.length) break;
      rows.forEach((d) => existing.push(d._id));
      if (rows.length < PAGE) break;
      page++;
    }
    for (const id of existing) {
      if (!seedIds.has(id)) {
        try {
          await db.collection(COLLECTION).doc(id).remove();
          pruned++;
        } catch (e) {
          errors.push("prune " + id + ": " + (e && (e.errMsg || e.message) ? (e.errMsg || e.message) : e));
        }
      }
    }
  } catch (e) {
    errors.push("prune-scan: " + (e && (e.errMsg || e.message) ? (e.errMsg || e.message) : e));
  }

  return {
    success: failed === 0,
    total: spots.length,
    done,
    pruned,
    failed,
    errors,
  };
};

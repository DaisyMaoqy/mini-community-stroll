// initSpots —— 一次性初始化 local_spots 集合（幂等 upsert）
// 部署后在微信开发者工具「云开发 → 云函数」右键「上传并部署」本函数，
// 前端或云函数调试台调用：wx.cloud.callFunction({ name: 'initSpots', data: {} })
//
// ⚠️ 关键：云函数端 db.collection(x).doc(id).set() **不会**自动创建集合，
//    集合不存在时会直接报 -502005 collection not exists。故此处先显式 createCollection。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const seed = require("./spots.seed.json");

const COLLECTION = "local_spots";

exports.main = async () => {
  const spots = (seed && seed.spots) || [];
  let done = 0;
  let failed = 0;
  const errors = [];

  // 确保集合存在（已存在时 createCollection 会抛错，直接忽略；
  // 若因其他原因失败，下方写入会给出明确错误）
  try {
    await db.createCollection(COLLECTION);
  } catch (e) {
    // ignore：集合已存在属正常情况
  }

  for (const s of spots) {
    const id = s._id;
    if (!id) {
      failed++;
      errors.push("skip: missing _id");
      continue;
    }
    // doc(id).set 即 upsert：已存在则覆盖，不存在则创建（幂等，可重复执行）
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

  return {
    success: failed === 0,
    total: spots.length,
    done,
    failed,
    errors,
  };
};

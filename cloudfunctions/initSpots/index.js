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
// 补丁层集合：运营在审核端「直接应用到云端」产生的白名单改动存这里，
// 每次跑本函数时在 seed upsert + prune 之后重新叠回，使手机上的改动永久生效。
const PATCH_COLLECTION = "local_spot_patches";

// 并发池：以固定并发度跑任务，避免 N 次串行 await 撑爆云函数超时（默认 3s）
async function runPool(items, limit, worker) {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = [];
  for (let k = 0; k < size; k++) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          await worker(items[idx], idx);
        }
      })()
    );
  }
  await Promise.all(runners);
}

exports.main = async () => {
  const t0 = Date.now();
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
  // 补丁集合同样必须显式建：否则第 3 步首次读取会 -502005 并被 catch 吞掉，静默不生效
  try {
    await db.createCollection(PATCH_COLLECTION);
  } catch (e) {
    // ignore：集合已存在属正常情况
  }

  // 1) upsert 种子（doc.set：已存在覆盖，不存在创建，幂等）
  await runPool(spots, 20, async (s) => {
    const id = s._id;
    if (!id) {
      failed++;
      errors.push("skip: missing _id");
      return;
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
  });

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
    const toRemove = existing.filter((id) => !seedIds.has(id));
    await runPool(toRemove, 20, async (id) => {
      try {
        await db.collection(COLLECTION).doc(id).remove();
        pruned++;
      } catch (e) {
        errors.push("prune " + id + ": " + (e && (e.errMsg || e.message) ? (e.errMsg || e.message) : e));
      }
    });
  } catch (e) {
    errors.push("prune-scan: " + (e && (e.errMsg || e.message) ? (e.errMsg || e.message) : e));
  }

  // 3) applyPatches：把运营在手机上做过的白名单改动重新叠回（必须放在 upsert + prune 之后，
  //    否则第 1 步 seed 的 set() 整文档覆盖会把之前所有「直接应用」抹掉）。
  //    这里用 update() 做字段级合并，且补丁文档本身不删除 —— 下次重跑依旧幂等。
  let patched = 0;
  let skipped = 0;
  const skippedIds = [];
  try {
    const all = [];
    const PAGE = 100;
    let page = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await db
        .collection(PATCH_COLLECTION)
        .skip(page * PAGE)
        .limit(PAGE)
        .get();
      const rows = (res && res.data) || [];
      if (!rows.length) break;
      rows.forEach((d) => all.push(d));
      if (rows.length < PAGE) break;
      page++;
    }
    await runPool(all, 20, async (p) => {
      const id = p && p._id;
      const patch = (p && p.patch) || {};
      if (!id || !Object.keys(patch).length) return;
      // 孤儿补丁：POI 已不在 seed 里（第 2 步刚被 prune 掉）→ 跳过并上报。
      // 用 seedIds 显式判定而不是依赖 update() 对不存在文档是否抛错：
      // 若某天 update() 改为只回 stats.updated:0 而不抛错，靠异常计数的写法会让
      // patched 虚高、skipped 恒为 0，孤儿补丁就永远不会被发现。
      if (!seedIds.has(id)) {
        skipped++;
        skippedIds.push(id);
        return;
      }
      try {
        // 字段级合并，不是整文档覆盖：只改 coord / verifyStatus 等补丁字段
        await db.collection(COLLECTION).doc(id).update({ data: patch });
        patched++;
      } catch (e) {
        // 走到这里说明 id 确实在 seed 里：孤儿分支已由上面的 seedIds 判定接管，
        // 此处只兜住网络 / 权限等真实异常，同样计为 skipped 并上报，不要整函数失败
        skipped++;
        skippedIds.push(id);
      }
    });
  } catch (e) {
    errors.push("applyPatches: " + (e && (e.errMsg || e.message) ? (e.errMsg || e.message) : e));
  }

  return {
    success: failed === 0,
    total: spots.length,
    done,
    pruned,
    patched,
    skipped,
    skippedIds,
    failed,
    errors,
    elapsedMs: Date.now() - t0,
  };
};

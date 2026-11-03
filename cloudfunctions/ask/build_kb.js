// build_kb —— 为 kb_chunks 集合批量生成 embedding 并写回
// 用法：在本目录 npm i wx-server-sdk 后，用 Node 直接跑（需本机能访问外网）：
//   DASHSCOPE_API_KEY=sk-xxx node build_kb.js
// 只处理 embedding 字段为空的记录，可重复执行（增量补齐）
const https = require("https");

// 云环境 ID【改成你的】
const ENV_ID = "";
const COLLECTION = "kb_chunks";

// ---------- CloudBase HTTP API（openapi 接口方式；也可改用微信开发者工具的云函数本地调试跑同样逻辑） ----------
// 说明：为避免引入 @cloudbase/manager-node 的安装成本，这里走 HTTP API。
// 需要先获取 access_token（appid + secret），【填入你的小程序 appid/secret，用完删除】
const APPID = "";
const SECRET = "";

function httpsReq(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: Object.assign({}, headers, payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      (res) => { let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(raw.slice(0, 300))); } }); }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAccessToken() {
  const res = await httpsReq("GET", `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`);
  if (!res.access_token) throw new Error("获取 access_token 失败: " + JSON.stringify(res));
  return res.access_token;
}

async function embed(text, key) {
  const res = await httpsReq("POST", "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
    { Authorization: "Bearer " + key }, { model: "text-embedding-v3", input: { text }, dimension: 1024 });
  return res.output.embeddings[0].embedding;
}

(async () => {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key || !APPID || !SECRET || !ENV_ID) {
    console.error("请先填 ENV_ID / APPID / SECRET，并设置 DASHSCOPE_API_KEY 环境变量");
    process.exit(1);
  }
  const token = await getAccessToken();
  // 拉取缺 embedding 的记录（分页）
  let skip = 0, done = 0;
  for (;;) {
    const q = JSON.stringify({ env: ENV_ID, collection: COLLECTION, query: "db.collection('" + COLLECTION + "').where({ embedding: _.eq(null) }).skip(" + skip + ").limit(100).get()" });
    const res = await httpsReq("POST", "https://api.weixin.qq.com/tcb/databasequery?access_token=" + token, {}, q);
    if (res.errcode !== 0) throw new Error("查询失败: " + JSON.stringify(res));
    const rows = (res.data || []).map((r) => JSON.parse(r));
    if (!rows.length) break;
    for (const doc of rows) {
      const vec = await embed(doc.question + "\n" + doc.text, key);
      const upd = JSON.stringify({ env: ENV_ID, collection: COLLECTION, query: "db.collection('" + COLLECTION + "').doc('" + doc._id + "').update({ data: { embedding: " + JSON.stringify(vec) + " } })" });
      const ur = await httpsReq("POST", "https://api.weixin.qq.com/tcb/databaseupdate?access_token=" + token, {}, upd);
      if (ur.errcode !== 0) console.error("写入失败", doc._id, ur);
      else { done++; console.log("✓", doc._id, doc.topic || ""); }
    }
    if (rows.length < 100) break;
    skip += 100;
  }
  console.log("完成，共处理", done, "条");
})();

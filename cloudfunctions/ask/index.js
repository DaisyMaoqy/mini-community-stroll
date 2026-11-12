// ask —— 育儿问答 RAG 云函数（最小可跑版：月龄前置过滤 + 内存余弦召回 + 置信度拒答）
// 前端：wx.cloud.callFunction({ name:'ask', data:{ question, babyAgeMonths } })
// 返回（扁平）：{
//   success, refused, answer, sources:[{topic, source}], topScore, latencyMs
// }
//
// 检索链路（刻意不用向量库）：
//   知识库规模预期 300-500 chunk，云函数内全量拉取后内存余弦相似度即可，
//   比引 Milvus/pgvector 更快且零运维；到万级 chunk 再考虑换 ANN。
//   已知边界：云数据库 get 单次上限 1000 条，>1000 需分页拉取（当前规模不会触发，
//   但 kbChunks 分页逻辑已预留，防止知识库增长后静默截断导致「召回变差」难排查）。
//
// 拒答设计（两层）：
//   1. 风险信号词前置：发热/抽搐/脱水/体重不增等 → 无论检索得分如何，回答强制附就医提示
//   2. 置信度拒答：top1 余弦 < RAG_REFUSE_THRESHOLD（默认 0.35）→ 不生成，直接拒答 + 就医引导
//      阈值是初始经验值，上线后用 badcase 回归校准（这正是 30 题评估表的用途）
//
// 合规定位：科普 + 经验分享，不做诊断/用药建议；系统提示词与拒答文案均含免责声明。
//
// ---------- 管理动作 buildKb（替代本地跑 build_kb.js） ----------
// 背景：本地跑 build_kb.js 需要填 APPID/SECRET 并配置 IP 白名单，成本高。
// 现在把「建集合 + 种子导入 + 增量生成 embedding」全部放进云函数：
//   wx.cloud.callFunction({ name:'ask', data:{ action:'buildKb' } })   // 可选 token
// 每次（最多）处理 BATCH 条缺 embedding 的记录，返回 remaining，重复调用直到 remaining=0。
// 幂等：集合非空时跳过种子导入；embedding 已有的记录不动。
// 安全：若环境变量设置了 ASK_ADMIN_TOKEN，则 event.token 必须匹配（不设置则不校验）。
//
// 【待你完成】
//   1. 云开发控制台 → 该云函数 → 环境变量添加 DASHSCOPE_API_KEY（新开 Key，勿用课程笔记里那个）
//   2. 右键部署 ask（会随包带上 kb.seed.json）
//   3. 开发者工具 Console 跑 wx.cloud.callFunction({name:'ask', data:{action:'buildKb'}})，
//      重复到返回 remaining=0（首次调用会自动建集合并导入 80 条种子）
const cloud = require("wx-server-sdk");
const https = require("https");
const kbSeed = require("./kb.seed.json");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const KB_COLLECTION = "kb_chunks";
const TOP_K = 4;
// 拒答阈值可经环境变量 RAG_REFUSE_THRESHOLD 调整（不填用默认 0.35）——
// 上线后用 30 题评估表的 badcase 校准时，改环境变量即可，不用改代码重发
const REFUSE_THRESHOLD = (() => {
  const v = Number(process.env.RAG_REFUSE_THRESHOLD);
  return v > 0 && v < 1 ? v : 0.35;
})();

// 风险信号词：命中即附就医提示（持续扩充）
const RISK_PATTERNS = [
  "发热", "高烧", "抽搐", "惊厥", "脱水", "呕吐不止", "腹泻带血",
  "体重不增", "体重下降", "呼吸急促", "囟门", "黄疸加重", "哭闹不止超过",
];

const SYSTEM_PROMPT =
  "你是一个育儿科普助手，面向 0-3 岁宝宝的家长。规则：\n" +
  "1. 只依据提供的参考资料回答，资料不足以回答时明确说「资料里没有覆盖这个问题」；\n" +
  "2. 定位是科普和经验分享，不做诊断，不给用药剂量建议；\n" +
  "3. 回答末尾固定附一句：以上为一般性育儿科普，不构成医疗建议，如有异常请及时就医。\n" +
  "4. 用口语化中文回答，控制在 200 字内，分点不超过 3 点。";

// ---------- DashScope 调用（HTTPS，与 getWeather 同风格，无额外依赖） ----------

function httpsPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, headers),
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("响应解析失败: " + raw.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(25000, () => req.destroy(new Error("请求超时")));
    req.write(payload);
    req.end();
  });
}

// 文本向量化：text-embedding-v3，1024 维
async function embed(text) {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error("缺少环境变量 DASHSCOPE_API_KEY");
  const res = await httpsPostJson(
    "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
    { Authorization: "Bearer " + key },
    { model: "text-embedding-v3", input: { text }, dimension: 1024 }
  );
  if (!res.output || !res.output.embeddings || !res.output.embeddings[0]) {
    throw new Error("embedding 返回异常: " + JSON.stringify(res).slice(0, 200));
  }
  return res.output.embeddings[0].embedding;
}

// 生成回答：qwen-plus（非流式，最小版先跑通；流式留待前端接 enableChunked 时再开）
async function chat(prompt) {
  const key = process.env.DASHSCOPE_API_KEY;
  const res = await httpsPostJson(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    { Authorization: "Bearer " + key },
    {
      model: "qwen-plus",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    }
  );
  if (!res.choices || !res.choices[0]) throw new Error("chat 返回异常: " + JSON.stringify(res).slice(0, 200));
  return res.choices[0].message.content.trim();
}

// ---------- 检索 ----------

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// 拉取知识库：分页预留（>1000 条时静默截断是云数据库的坑）
async function loadKb() {
  const MAX_PAGE = 1000;
  let all = [], skip = 0;
  for (;;) {
    const res = await db.collection(KB_COLLECTION).skip(skip).limit(MAX_PAGE).get();
    all = all.concat(res.data);
    if (res.data.length < MAX_PAGE) break;
    skip += MAX_PAGE;
  }
  return all;
}

// ---------- buildKb：建集合 + 种子导入 + 增量生成 embedding ----------

const BUILD_BATCH = 25; // 单次调用最多处理条数；80 条种子约需 4 次调用跑完

async function buildKb(event) {
  // 管理令牌：控制台设置了 ASK_ADMIN_TOKEN 就强制校验（防止裸调烧 API 额度）
  const adminToken = process.env.ASK_ADMIN_TOKEN;
  if (adminToken && event.token !== adminToken) {
    return { success: false, error: "buildKb 需要正确的 token（ASK_ADMIN_TOKEN）" };
  }
  try {
    // 1. 确保集合存在（已存在时 createCollection 会报错，忽略即可）
    try { await db.createCollection(KB_COLLECTION); } catch (e) { /* 已存在 */ }

    // 2. 集合为空时导入种子（幂等：非空不动，避免与手工导入重复）
    const cntRes = await db.collection(KB_COLLECTION).count();
    let seeded = 0;
    if (cntRes.total === 0) {
      for (const doc of kbSeed) {
        await db.collection(KB_COLLECTION).add({ data: Object.assign({}, doc, { embedding: null }) });
        seeded++;
      }
    }

    // 3. 找缺 embedding 的记录，本批最多 BUILD_BATCH 条
    const all = await loadKb();
    const pending = all.filter((c) => !Array.isArray(c.embedding));
    const batch = pending.slice(0, BUILD_BATCH);
    let embedded = 0, failed = 0;
    for (const doc of batch) {
      try {
        const vec = await embed(doc.question + "\n" + doc.text);
        await db.collection(KB_COLLECTION).doc(doc._id).update({ data: { embedding: vec } });
        embedded++;
      } catch (e) {
        failed++;
        console.error("embedding 失败", doc._id, e.message);
      }
    }

    // 4. 汇报进度（remaining 让前端/Console 决定是否继续调用）
    const remaining = pending.length - batch.length;
    return {
      success: true, action: "buildKb",
      total: all.length, seeded, embedded, failed,
      remaining,
      done: remaining === 0,
      note: remaining > 0 ? "还有 " + remaining + " 条待处理，请重复调用" : "全部完成",
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ---------- 主入口 ----------

exports.main = async (event) => {
  // 管理动作分流（不占问答主链路）
  if (event.action === "buildKb") return buildKb(event);

  const t0 = Date.now();
  const question = (event.question || "").trim();
  const babyAge = typeof event.babyAgeMonths === "number" ? event.babyAgeMonths : null;
  if (!question) return { success: false, error: "question 为空" };

  try {
    // 1. 问题向量化
    const qVec = await embed(question);

    // 2. 拉知识库 + 月龄前置过滤（age_start/age_end 为 -1 表示不限月龄）
    const kb = await loadKb();
    const filtered = kb.filter(
      (c) => Array.isArray(c.embedding) &&
        (c.age_start == null || c.age_start < 0 || (babyAge == null || (babyAge >= c.age_start && babyAge <= (c.age_end == null ? 999 : c.age_end))))
    );

    // 3. 内存余弦 + top-K
    const scored = filtered
      .map((c) => ({ chunk: c, score: cosine(qVec, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);

    const topScore = scored.length ? scored[0].score : 0;

    // 4. 置信度拒答：检索不到相关内容就不硬答
    if (topScore < REFUSE_THRESHOLD) {
      return {
        success: true, refused: true, answer: "",
        refuseNote: "这个问题我暂时没有足够的资料来回答。宝宝的情况如果持续或加重，建议咨询儿保医生。",
        sources: [], topScore: Number(topScore.toFixed(3)), latencyMs: Date.now() - t0,
      };
    }

    // 5. 组装上下文 + 风险信号检测
    const context = scored
      .map((s, i) => "[" + (i + 1) + "] (" + (s.chunk.topic || "通用") + ") " + s.chunk.text)
      .join("\n\n");
    const hitRisk = RISK_PATTERNS.some((w) => question.indexOf(w) >= 0);

    // 6. 生成回答
    const answer = await chat(
      "家长提问（宝宝月龄：" + (babyAge == null ? "未知" : babyAge + " 个月") + "）：\n" + question +
      "\n\n参考资料：\n" + context
    );

    return {
      success: true, refused: false, answer,
      riskTip: hitRisk ? "你的描述中包含需要医生评估的信号，请尽快就医确认。" : "",
      sources: scored.map((s) => ({ topic: s.chunk.topic || "通用", source: s.chunk.source || "" })),
      topScore: Number(topScore.toFixed(3)), latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

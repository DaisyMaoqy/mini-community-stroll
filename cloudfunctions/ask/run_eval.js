// run_eval —— 育儿问答 RAG 云函数 30 题评估跑分脚本（拒答阈值校准用）
//
// 两种模式：
//   手动模式（下方 ENV_ID / APPID / SECRET 任一为空，默认）：
//     node run_eval.js
//     打印「逐题手测清单」——人工在小程序 ask 页逐题提问并记录结果。
//     topScore 前端不展示，所以只记「答了/拒答了」+ 主观「答非所问」判定。
//   自动模式（填好凭据后）：
//     node run_eval.js
//     走微信云开发 HTTP API（invokecloudfunction）逐题调真实 ask 云函数，
//     串行调用 + 每题间隔 300ms（DashScope 限流 100 次/分，别并发轰），
//     输出：逐题结果 / hit 与 refuse 通过率 / topScore 分布表 / 建议拒答阈值。
//
// 凭据与 build_kb.js 同风格：【填入你的小程序 appid/secret，用完删除】
// DASHSCOPE_API_KEY 不需要——那是云函数侧的环境变量，本脚本只透传问题。
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------- 凭据（留空 = 手动模式） ----------
const ENV_ID = "";
const APPID = "";
const SECRET = "";

const FN_NAME = "ask";
const EVAL_FILE = path.join(__dirname, "..", "..", "data", "eval-30.json");
const SLEEP_MS = 300; // 每题之间的间隔，别并发轰云函数

// 与 cloudfunctions/ask/index.js 保持一致的风险信号词：
// 命中 expect:"hit" 且含风险词的题，回答必须带就医提示（riskTip 非空）
const RISK_PATTERNS = [
  "发热", "高烧", "抽搐", "惊厥", "脱水", "呕吐不止", "腹泻带血",
  "体重不增", "体重下降", "呼吸急促", "囟门", "黄疸加重", "哭闹不止超过",
];

// ---------- 小工具 ----------
function httpsReq(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname + u.search, method,
        headers: Object.assign({}, headers, payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("响应解析失败: " + raw.slice(0, 300))); } });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAccessToken() {
  const res = await httpsReq("GET", `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`);
  if (!res.access_token) throw new Error("获取 access_token 失败: " + JSON.stringify(res));
  return res.access_token;
}

function loadEval() {
  const items = JSON.parse(fs.readFileSync(EVAL_FILE, "utf8"));
  if (!Array.isArray(items) || !items.length) throw new Error("评估表为空或格式不对: " + EVAL_FILE);
  return items;
}

function hasRiskWord(q) {
  return RISK_PATTERNS.some((w) => q.indexOf(w) >= 0);
}

function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - width(s)));
}
// 中文按 2 列宽计算，对齐好看点
function width(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

// 调一次 ask 云函数。
// 注意：invokecloudfunction 的返回里，函数结果通常在 resp_data 字段（部分封装在 result），
// 且可能是 JSON 字符串也可能是对象——两种都兼容。
async function invokeAsk(token, item) {
  const body = { question: item.question };
  if (item.babyAgeMonths !== null && item.babyAgeMonths !== undefined) body.babyAgeMonths = item.babyAgeMonths;
  const res = await httpsReq(
    "POST",
    `https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${token}&env=${ENV_ID}&name=${FN_NAME}`,
    {},
    body
  );
  if (res.errcode && res.errcode !== 0) {
    throw new Error("invokecloudfunction errcode=" + res.errcode + " " + (res.errmsg || ""));
  }
  let out = res.resp_data != null ? res.resp_data : res.result;
  if (typeof out === "string") {
    try { out = JSON.parse(out); } catch (e) { /* 保持字符串，judge 里会标 error */ }
  }
  return out && typeof out === "object" ? out : {};
}

// ---------- 手动模式：逐题手测清单 ----------
function manualMode(items) {
  console.log("==============================================================");
  console.log(" ask 云函数 30 题评估 · 手动模式（未配置凭据）");
  console.log("==============================================================");
  console.log("使用说明：");
  console.log("1. 打开小程序 ask 问答页，按下面清单逐题输入「问题」，");
  console.log("   并按「月龄」列设置宝宝月龄（null = 不传月龄）。");
  console.log("2. 每题只记两件事（topScore 前端不展示，记不了）：");
  console.log("   ① 答了 / 拒答了（拒答时页面显示「没有足够的资料…」拒答文案）；");
  console.log("   ② 答非所问？（主观判定：回答内容是否对应问题）");
  console.log("3. 风险词题（序号后带 ⚠）额外记：回答是否带就医提示");
  console.log("   （riskTip 文案「包含需要医生评估的信号」会拼在回答里）。");
  console.log("4. 【边界】标记的题是月龄过滤灰区探针，结果无论答/拒都请抄下回答摘要。");
  console.log("");
  console.log(pad("序号", 6) + pad("预期", 8) + pad("月龄", 6) + pad("风险", 6) + pad("问题", 46) + "答了/拒答 | 答非所问? | 备注");
  console.log("-".repeat(100));
  items.forEach((it, i) => {
    const no = (i + 1) + (hasRiskWord(it.question) ? "⚠" : " ");
    const mark = it.note && it.note.indexOf("【月龄边界题") >= 0 ? "【边界】" : "";
    console.log(
      pad(no, 6) +
      pad(it.expect, 8) +
      pad(it.babyAgeMonths == null ? "-" : it.babyAgeMonths, 6) +
      pad(hasRiskWord(it.question) ? "是" : "-", 6) +
      pad(it.question.slice(0, 44), 46) +
      mark
    );
  });
  console.log("-".repeat(100));
  console.log("共 " + items.length + " 题 | hit " + items.filter((i) => i.expect === "hit").length +
    " / refuse " + items.filter((i) => i.expect === "refuse").length);
  console.log("填好 ENV_ID / APPID / SECRET 后重跑本脚本进入自动模式（走真实云函数跑分）。");
}

// ---------- 自动模式：跑分 ----------
function judge(item, no, out) {
  const refused = out.refused === true;
  const answered = out.success === true && !refused;
  const risk = hasRiskWord(item.question);

  let actual;
  let pass = false;
  const reasons = [];

  if (out.success === false) {
    actual = "error";
    reasons.push(String(out.error || "未知错误"));
  } else if (refused) {
    actual = "refused";
    pass = item.expect === "refuse";
  } else if (answered) {
    actual = "answered";
    pass = item.expect === "hit";
  } else {
    actual = "unknown";
    reasons.push("success/refused 字段缺失");
  }

  // 风险词题（expect=hit）：回答必须附就医提示
  if (item.expect === "hit" && answered && risk && !out.riskTip) {
    pass = false;
    reasons.push("缺就医提示(riskTip)");
  }
  // 拒答题理想上也别甩 error
  if (item.expect === "refuse" && out.success === false) {
    reasons.push("走的是 error 而非拒答文案");
  }

  // 主题是否命中（信息性指标，不计入 pass）
  const topicHit = !!(item.expectTopic && Array.isArray(out.sources) &&
    out.sources.some((s) => s && s.topic === item.expectTopic));

  return {
    no, question: item.question, expect: item.expect, expectTopic: item.expectTopic || "",
    actual, topScore: typeof out.topScore === "number" ? out.topScore : null,
    latencyMs: typeof out.latencyMs === "number" ? out.latencyMs : null,
    pass, topicHit, risk, reasons,
  };
}

function printDistribution(title, rows) {
  console.log("\n" + title);
  console.log(pad("题号", 6) + pad("expect", 8) + pad("pass", 6) + "topScore");
  rows.forEach((r) => {
    console.log(pad("#" + r.no, 6) + pad(r.expect, 8) + pad(r.pass ? "✔" : "✘", 6) + (r.topScore == null ? "-" : r.topScore));
  });
}

async function autoMode(items) {
  console.log("==============================================================");
  console.log(" ask 云函数 30 题评估 · 自动模式");
  console.log(" env=" + ENV_ID + " | 函数=" + FN_NAME + " | " + items.length + " 题 | 串行+300ms间隔");
  console.log("==============================================================");

  const token = await getAccessToken();
  const results = [];
  const tAll = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const no = i + 1;
    process.stdout.write(pad("#" + no, 5) + " ");
    let r;
    try {
      const out = await invokeAsk(token, item);
      r = judge(item, no, out);
    } catch (e) {
      r = { no, question: item.question, expect: item.expect, expectTopic: item.expectTopic || "",
        actual: "error", topScore: null, latencyMs: null, pass: false, topicHit: false,
        risk: hasRiskWord(item.question), reasons: [e.message] };
    }
    results.push(r);
    console.log(
      pad(r.expect, 8) + pad(r.actual, 10) +
      "topScore=" + (r.topScore == null ? "-" : r.topScore.toFixed ? r.topScore.toFixed(3) : r.topScore) + " " +
      pad(r.pass ? "PASS" : "FAIL", 6) +
      (r.reasons.length ? "  [" + r.reasons.join("; ") + "]" : "") +
      (r.latencyMs != null ? "  " + r.latencyMs + "ms" : "")
    );
    if (i < items.length - 1) await sleep(SLEEP_MS);
  }

  // ---------- 汇总 ----------
  const hits = results.filter((r) => r.expect === "hit");
  const refuses = results.filter((r) => r.expect === "refuse");
  const hitPass = hits.filter((r) => r.pass).length;
  const refusePass = refuses.filter((r) => r.pass).length;

  console.log("\n==============================================================");
  console.log(" 汇总");
  console.log("==============================================================");
  console.log("hit 题   : " + hitPass + "/" + hits.length + " 通过（通过率 " + (100 * hitPass / hits.length).toFixed(0) + "%）");
  console.log("refuse 题: " + refusePass + "/" + refuses.length + " 通过（通过率 " + (100 * refusePass / refuses.length).toFixed(0) + "%）");
  const topicOk = hits.filter((r) => r.topicHit).length;
  console.log("hit 题主题命中（sources 含 expectTopic）: " + topicOk + "/" + hits.length + "（信息性指标，不计入 pass）");
  console.log("总耗时 " + ((Date.now() - tAll) / 1000).toFixed(1) + "s");

  // topScore 分布（各题从高到低）
  const sortDesc = (a, b) => (b.topScore == null ? -1 : b.topScore) - (a.topScore == null ? -1 : a.topScore);
  printDistribution("—— hit 题 topScore 分布（高→低）——", hits.slice().sort(sortDesc));
  printDistribution("—— refuse 题 topScore 分布（高→低）——", refuses.slice().sort(sortDesc));

  // 建议阈值：hit 最低分 vs refuse 最高分
  const hitScores = hits.map((r) => r.topScore).filter((v) => typeof v === "number");
  const refuseScores = refuses.map((r) => r.topScore).filter((v) => typeof v === "number");
  console.log("\n—— 阈值建议 ——");
  if (!hitScores.length || !refuseScores.length) {
    console.log("样本不足（有题报错没拿到 topScore），无法给出阈值建议。");
  } else {
    const hitMin = Math.min.apply(null, hitScores);
    const refuseMax = Math.max.apply(null, refuseScores);
    console.log("hit 题最低 topScore   = " + hitMin.toFixed(3));
    console.log("refuse 题最高 topScore = " + refuseMax.toFixed(3));
    if (hitMin > refuseMax) {
      const mid = (hitMin + refuseMax) / 2;
      console.log("两分布可分：建议 RAG_REFUSE_THRESHOLD 取 " + mid.toFixed(3) +
        "（区间 (" + refuseMax.toFixed(3) + ", " + hitMin.toFixed(3) + ") 内任一值均可，取中点平衡余量）。");
    } else {
      console.log("不可分（hit 最低分 ≤ refuse 最高分）：需补语料或改写题目。badcase 题号：");
      const badRefuse = refuses.filter((r) => typeof r.topScore === "number" && r.topScore >= hitMin).map((r) => "#" + r.no);
      const badHit = hits.filter((r) => typeof r.topScore === "number" && r.topScore <= refuseMax).map((r) => "#" + r.no);
      if (badRefuse.length) console.log("  拒答侧得分过高（被误答风险）: " + badRefuse.join(", "));
      if (badHit.length) console.log("  命中侧得分过低（被误拒风险）: " + badHit.join(", "));
    }
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log("\n—— 未通过明细 ——");
    failed.forEach((r) => console.log("#" + r.no + " [" + r.expect + "] " + r.reasons.join("; ") + " | " + r.question));
  }
}

// ---------- 入口 ----------
(async () => {
  let items;
  try {
    items = loadEval();
  } catch (e) {
    console.error("读取评估表失败: " + e.message);
    process.exit(1);
  }

  if (ENV_ID && APPID && SECRET) {
    try {
      await autoMode(items);
    } catch (e) {
      console.error("自动模式失败: " + e.message);
      console.error("检查 ENV_ID / APPID / SECRET 是否正确、云函数 ask 是否已部署。");
      process.exit(1);
    }
  } else {
    manualMode(items);
  }
})();

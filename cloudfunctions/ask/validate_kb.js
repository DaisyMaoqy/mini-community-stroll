// validate_kb —— 语料入库前校验（对应 PRD AC-11）
// 用法：node validate_kb.js [语料JSON路径]
//   默认校验 ../../data/kb-guides.json，也可传入其他路径
// 校验项：
//   1. 必填字段：question / text / topic / age_start / age_end / source
//   2. age_start / age_end 必须为整数
//   3. -1 必须成对：age_start 与 age_end 同时为 -1，或都不为 -1
//      （只写 age_start:6, age_end:-1 会导致过滤条件「月龄 ≤ -1」永远为假，
//        该条语料永久不被召回且不报错——最隐蔽的数据 bug）
//   4. 非不限月龄条目：0 ≤ age_start ≤ age_end
//   5. text 非空；embedding 字段允许为 null（由 build_kb.js 补齐）
// 任何一项失败 → 退出码 1，并逐条打印错误

const fs = require("fs");
const path = require("path");

const file = process.argv[2] || path.join(__dirname, "..", "..", "data", "kb-guides.json");

let data;
try {
  data = JSON.parse(fs.readFileSync(file, "utf-8"));
} catch (e) {
  console.error("✗ 无法读取语料文件:", file, "\n ", e.message);
  process.exit(1);
}

const errors = [];
const REQUIRED = ["question", "text", "topic", "age_start", "age_end", "source"];

data.forEach((d, i) => {
  const id = d.question ? `#${i + 1}「${String(d.question).slice(0, 18)}…」` : `#${i + 1}`;
  for (const f of REQUIRED) {
    if (d[f] === undefined || d[f] === null || (typeof d[f] === "string" && !d[f].trim())) {
      errors.push(`${id} 缺少必填字段 ${f}`);
    }
  }
  const { age_start: a, age_end: b } = d;
  const isInt = (v) => Number.isInteger(v);
  if (!isInt(a) || !isInt(b)) {
    errors.push(`${id} age_start / age_end 必须为整数（当前: ${JSON.stringify(a)}, ${JSON.stringify(b)}）`);
    return;
  }
  const aNeg = a === -1, bNeg = b === -1;
  if (aNeg !== bNeg) {
    errors.push(`${id} -1 必须成对：age_start=${a}, age_end=${b}（孤立 -1 会导致该条永久不被召回且不报错）`);
  }
  if (!aNeg && !bNeg) {
    if (a < 0) errors.push(`${id} age_start=${a} 非法（非「不限月龄」条目不能为负）`);
    if (b < a) errors.push(`${id} age_end=${b} < age_start=${a}，区间非法`);
  }
  if (typeof d.text === "string" && d.text.trim().length < 10) {
    errors.push(`${id} 正文过短（${d.text.trim().length} 字符），疑似占位数据`);
  }
});

// 汇总
const topics = new Set(data.map((d) => d.topic).filter(Boolean));
const sources = new Set(data.map((d) => d.source).filter(Boolean));
console.log(`语料: ${data.length} 条 ｜ 主题: ${topics.size} 个 ｜ 来源: ${sources.size} 个`);

if (errors.length) {
  console.error(`\n✗ 校验失败，共 ${errors.length} 处：`);
  errors.forEach((e) => console.error("  -", e));
  process.exit(1);
}
console.log("✓ 校验通过：字段完整，-1 均成对，月龄区间合法");

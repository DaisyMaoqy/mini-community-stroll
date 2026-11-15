// 育儿问答 30 题校准脚本（整段复制 → 粘贴到微信开发者工具 Console → 回车）
// 前置：buildKb 已跑完（remaining=0）。耗时约 2~4 分钟，期间别关开发者工具。
// 结尾会打印「汇总」：两侧通过数 + topScore 分布，据此定 RAG_REFUSE_THRESHOLD。
const EVAL = [
  {q:"宝宝一晚上要醒四五次，每次都得抱起来哄才能接着睡，愁死了",a:10,e:"hit",t:"睡眠-夜醒"},
  {q:"月子里的宝宝白天呼呼睡、一到晚上就来精神，怎么帮她分清白天黑夜",a:1,e:"hit",t:"睡眠-作息"},
  {q:"宝宝三个月，夜里还要喂两三次奶，啥时候能不用夜里喂了",a:3,e:"hit",t:"睡眠-夜醒"},
  {q:"娃咳嗽流鼻涕好几天了，自己怎么判断要不要带去医院看",a:20,e:"hit",t:"健康-预警"},
  {q:"一岁的宝宝发热到39度5还抽搐了一下，要不要马上送医院",a:12,e:"hit",t:"健康-预警"},
  {q:"宝宝拉肚子拉得有点脱水，嘴唇干哭都没眼泪，在家先怎么处理",a:9,e:"hit",t:"健康-预警"},
  {q:"宝宝快十一个月了还不太会爬，就想扶着沙发站，要不要紧",a:11,e:"hit",t:"发育-大运动"},
  {q:"宝宝七个月了还没冒牙，是不是缺钙呀",a:7,e:"hit",t:"发育-出牙"},
  {q:"米糊吃了一个多月了，什么时候能换成带颗粒的辅食",a:8,e:"hit",t:"辅食-性状"},
  {q:"八个月的宝宝能不能喝点自己榨的橙汁",a:8,e:"hit",t:"辅食-禁忌"},
  {q:"老一辈说一岁内不能碰鸡蛋海鲜，晚点加真能防过敏吗",a:7,e:"hit",t:"辅食-过敏"},
  {q:"宝宝两个月，婆婆说喂点米糊扛饿，能喂吗",a:2,e:"hit",t:"母乳喂养"},
  {q:"娃一岁两个月了，现在每天奶量要保证多少，三餐怎么搭",a:14,e:"hit",t:"喂养-奶量"},
  {q:"母乳喂养的宝宝维生素D要怎么补，补到多大停",a:3,e:"hit",t:"喂养-营养"},
  {q:"娃抓到什么都往嘴里塞，家里哪些小东西必须收起来",a:14,e:"hit",t:"安全-误吞"},
  {q:"冬天怕娃冷，小床里能不能给他盖厚被子塞个毛绒玩具",a:5,e:"hit",t:"安全-睡眠环境"},
  {q:"带娃打完疫苗是不是得在现场观察一会儿才能回家",a:6,e:"hit",t:"疫苗常识"},
  {q:"宝宝这两天有点拉肚子，疫苗还能按时去打吗",a:8,e:"hit",t:"疫苗常识"},
  {q:"生完娃快三个月了还是特别爱掉眼泪，一点小事就崩溃，我是不是抑郁了",a:2,e:"hit",t:"妈妈心理"},
  {q:"老公下班就躺着刷手机基本不带娃，怎么让他搭把手",a:6,e:"hit",t:"妈妈心理"},
  {q:"怀孕五个月晚上老是腿抽筋，需要补点什么吗",a:null,e:"refuse",t:""},
  {q:"我最近血压有点偏高，150上下，平时要注意啥",a:8,e:"refuse",t:""},
  {q:"想入一个恒温调奶器，有没有靠谱的牌子推荐",a:7,e:"refuse",t:""},
  {q:"周末带娃出门，附近有什么遛娃的好去处推荐",a:24,e:"refuse",t:""},
  {q:"生娃的生育津贴怎么申请，大概能领多少",a:1,e:"refuse",t:""},
  {q:"宝宝出生后落户都要办哪些手续",a:0,e:"refuse",t:""},
  {q:"想给娃养只小狗，几岁开始养比较合适",a:24,e:"refuse",t:""},
  {q:"宝宝确诊了手足口病，在家应该怎么治疗",a:20,e:"refuse",t:""},
  {q:"宝宝这到底是怎么回事啊，急死了",a:null,e:"refuse",t:""},
  {q:"在线等，宝宝这情况该怎么办呀",a:null,e:"refuse",t:""}
];
(async () => {
  const out = [];
  for (let i = 0; i < EVAL.length; i++) {
    const it = EVAL[i];
    let r;
    try { r = (await wx.cloud.callFunction({ name: 'ask', data: { question: it.q, babyAgeMonths: it.a } })).result; }
    catch (e) { r = { success: false, error: e.message }; }
    const rec = { i: i + 1, expect: it.e, refused: r.refused === true, ok: false,
      topScore: r.topScore != null ? r.topScore : -1, gotTopic: r.sources && r.sources[0] ? r.sources[0].topic : "" };
    if (r.success && rec.refused) rec.ok = it.e === "refuse";
    else if (r.success && !rec.refused) rec.ok = it.e === "hit";
    out.push(rec);
    console.log("#" + String(i + 1).padStart(2, "0") + " 期望=" + it.e + " 拒答=" + rec.refused + " top=" + rec.topScore + (rec.gotTopic ? " 命中[" + rec.gotTopic + "]" : "") + (rec.ok ? " OK" : " XX") + "  " + it.q);
    await new Promise(s => setTimeout(s, 300));
  }
  const hits = out.filter(x => x.expect === "hit"), refs = out.filter(x => x.expect === "refuse");
  const pass = a => a.filter(x => x.ok).length;
  const asc = a => a.map(x => x.topScore).sort((p, q) => p - q);
  console.log("\n========== 汇总 ==========");
  console.log("应答正确(hit 侧): " + pass(hits) + "/" + hits.length);
  console.log("拒答正确(refuse 侧): " + pass(refs) + "/" + refs.length);
  console.log("hit 侧 topScore 升序:   " + JSON.stringify(asc(hits)));
  console.log("refuse 侧 topScore 升序: " + JSON.stringify(asc(refs)));
  console.log("读法：hit 侧最小值若高于 refuse 侧最大值 → 取中间值写进云函数环境变量 RAG_REFUSE_THRESHOLD；重叠 → 把 XX 题目编号发我逐题看");
})();

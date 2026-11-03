// pages/elder-home —— 关怀版首页
//
// 版式对齐 UI原型_v11_关怀版 #tab-home：关怀版标识条 → 板块条 → 大判断卡 →
// 四宫格 → 出门时段卡 → 语音播报条 → 两枚超大快捷 → 两个大按钮。
//
// 数据复用标准版同一套纯函数（utils/weather.js + utils/t6.js），不另造一套打分逻辑：
//   getWeather() → 30 分钟本地 TTL 缓存，无网时回落到确定性 mock（utils/weather.js:52）
//   scoreWeather() → { headline, tip, items, levelKey }（utils/t6.js:105）
//   slotScores()   → 清晨/上午/傍晚三窗口，best 为最优（utils/t6.js:169）
//
// 三个 data-* 必须齐全：styles/theme.wxss 里字号三档与对比度两档是
// [data-theme="elder"][data-font="x"][data-contrast="y"] 复合属性选择器，缺一个就不命中，
// 字号会掉回标准版大小 —— 关怀版最核心的诉求就是字大，这里不能错。
const app = getApp();
const { getWeather } = require('../../utils/weather.js');
const t6 = require('../../utils/t6.js');
const speech = require('../../utils/speech.js');

const VERDICT_ICON = { good: '✅', mid: '⚠️', bad: '⛔' };

// vclass（good / mid / bad）→ 朗读稿的开头引导语。只是把页面上已有的判断档位
// 换成一句口语，不新造天气数据、不重新算分 —— 结论一律用 data 里现成的
// headline / tip / slot。
const SPEECH_LEAD = {
  good: '挺适合带宝宝出门',
  mid: '出门要挑个好时段',
  bad: '先别带宝宝出门啦',
};

// t6 四档（优/良/一般/不宜）→ 关怀版三态（good 绿 / mid 橙 / bad 红）
// 「优」与「良」同用绿色，靠 headline 文案区分（"现在出门很合适" vs "适合出门遛一遛"）
function vclassOf(levelKey) {
  if (levelKey === 'normal') return 'mid';
  if (levelKey === 'bad') return 'bad';
  return 'good';
}

// ===== 朗读文本「可朗读化」：纯函数，只作用于送给语音插件的字符串 =====
// 界面上 this.data.headline / tip / slot.v 是给人看的原文，一个字都不改；
// 只在 onSpeak 拼完朗读稿后过一遍这里，把会让 TTS 念崩的内容清掉：
//   ① 时段连接号（t6.js:196 的 slot.v 形如 '07:00 – 08:30'）连同两侧空格
//      统一成「 到 」，读作「07:00 到 08:30」；
//   ② emoji / 装饰符号（如 💪、✅、变体选择符、零宽连接符）念出来是怪字符或直接卡住；
//   ③ 折叠多余空白、去首尾。
//
// 关于 \p{Extended_Pictographic}：project.config.json:49 的 libVersion 是 3.17.2，
// 调试基础库支持 ES2018 Unicode 属性转义；但真机基础库由用户微信版本决定、项目
// 未声明最低基础库，而正则【字面量】里的 \p{...} 在不支持的 JavaScriptCore 上是
// 页面脚本「解析期」SyntaxError（整页白屏，运行时 try/catch 兜不住）。所以这里用
// new RegExp 动态构造主路径，catch 住不支持的情况后退回 ES5 兼容的代理对 + BMP 区间，
// 保证任何引擎都能加载本页。
function buildUnreadableRe() {
  try {
    return new RegExp('[\\p{Extended_Pictographic}\\uFE0F\\u200D]', 'gu');
  } catch (e) {
    // 纯 ES5 正则语法：所有增补平面字符（含 emoji 代理对）+ BMP 内的装饰符号
    return new RegExp('[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF\\u2B00-\\u2BFF\\uFE00-\\uFE0F\\u200D]', 'g');
  }
}

const UNREADABLE_RE = buildUnreadableRe();

/**
 * 把一段中文清洗成适合朗读的文本（纯函数，不改入参、不改任何页面数据）。
 * @param {string} text 原始朗读稿
 * @returns {string} 清洗后的朗读稿
 */
function toReadable(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\s*[–—~～]\s*/g, ' 到 ')
    .replace(UNREADABLE_RE, '')
    // emoji 被删后常在标点前留下一个空格（「撒欢 💪。」→「撒欢 。」），
    // 这个空格 TTS 会念成停顿，一并收掉
    .replace(/\s+([，。、！？；：])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

Page({
  data: {
    speaking: false, // 播报中渲染态（实例闩 _speaking 只管防连点，两者不混）
    efont: 'lg',      // 'std' | 'lg' | 'xl'
    econtrast: 'high', // 'high' | 'normal'
    block: '',
    loading: true,
    errMsg: '',
    headline: '',
    tip: '',
    vclass: 'good',
    vicon: '✅',
    items: [],
    slot: null,
  },

  // 请求序号：丢弃过期响应（onShow 会重复触发，天气回包快慢不一，
  // 若让旧回包后到覆盖新回包，界面会显示上一次的结果）
  _seq: 0,
  // 同步闩：setData 是异步的，极速连点「重新看天气」会穿透 loading 判断
  _busy: false,

  onShow() {
    this.syncPrefs();
    this.load();
  },

  // 离页必须掐掉声音：InnerAudioContext 的生命周期不跟随页面，页面销毁后仍会继续播，
  // 老人误触点开播报再切页，声音会跟到别的页面去。
  // onHide：页面还在，可以安全 setData 复位渲染态，且必须走 _setSpeaking 统一入口
  // （只 setData 而不写 _speaking 的话，回来第一下会被判成「停止播报」而不是「开始播报」）。
  onHide() {
    speech.stop();
    this._setSpeaking(false);
  },

  // onUnload：页面已销毁，禁止 setData（会报 "setData called after page unload"），
  // 只复位实例闩 + 掐声音；data.speaking 随页面一起没了，不需要管。
  // speech.stop() 会让在途的 textToSpeech 回包作废，不会有迟到的回调再来改状态。
  onUnload() {
    speech.stop();
    this._speaking = false;
  },

  // 从全局偏好同步（在关怀版「我的」改完字号/对比度后返回本页要立即生效）
  syncPrefs() {
    const g = (app && app.globalData) || {};
    const f = (g.elderFont === 'std' || g.elderFont === 'xl') ? g.elderFont : 'lg';
    this.setData({
      efont: f,
      econtrast: g.elderContrast === false ? 'normal' : 'high',
      block: g.block || ''
    });
  },

  async load() {
    if (this._busy) return;
    this._busy = true;
    const seq = ++this._seq;
    this.setData({ loading: true, errMsg: '' });
    try {
      const bp = (app && app.curBaby && app.curBaby()) || null;
      const w = await getWeather((bp && bp.lat) || 22.963, (bp && bp.lng) || 113.33);
      if (seq !== this._seq) return;
      const idx = t6.scoreWeather(w);
      const rows = t6.slotScores(w.hourly, new Date().getHours());
      const slot = (rows && rows.filter(function (r) { return r.best; })[0]) || null;
      const vc = vclassOf(idx.levelKey);
      this.setData({
        loading: false,
        headline: idx.headline,
        tip: idx.tip,
        vclass: vc,
        vicon: VERDICT_ICON[vc] || '✅',
        items: idx.items || [],
        slot: slot,
      });
    } catch (e) {
      console.error('[elder-home] 天气加载失败', e);
      if (seq !== this._seq) return;
      // 只作布尔标志用（wxml 用 wx:elif="{{errMsg}}" 判定），写中文是为了万一将来
      // 有人直接渲染它，不会露出英文 "fail"
      this.setData({ loading: false, errMsg: '天气暂时看不了' });
    } finally {
      this._busy = false;
    }
  },

  // 板块切换在标准版首页（那里有板块 sheet），关怀版不重复实现一份
  onBlockTap() {
    wx.showToast({ title: '请在首页切换', icon: 'none' });
  },

  // 两个播报状态各司其职，不混用：
  //   _speaking —— 实例闩，同步读写，负责防连点 / 判断「再点即停止」；
  //   data.speaking —— 渲染态，wxml 用它切文案与 is-speaking 高亮。
  // setData 是异步桥调用，不能拿它做节流判断，所以实例闩必须保留。
  _speaking: false,

  // 统一同步两者，避免多处各写一半导致界面与逻辑不同步
  _setSpeaking(v) {
    this._speaking = v;
    if (this.data.speaking !== v) this.setData({ speaking: v });
  },

  // 语音播报：走 utils/speech.js（微信同声传译插件未开通时自动降级）。
  // 播报中再点一次 = 停止，给老人留一个随时能关掉的入口（容易误触，必须能停）。
  onSpeak() {
    if (this._speaking) {
      speech.stop();
      this._setSpeaking(false);
      wx.showToast({ title: '已停止播报', icon: 'none' });
      return;
    }
    if (!speech.available()) {
      wx.showToast({ title: '语音播报暂未开通', icon: 'none' });
      return;
    }
    const d = this.data;
    // 天气还没回来时不硬读（否则会念出「。。」），给一句听得懂的提示
    if (!d.headline && !d.tip) {
      wx.showToast({ title: '天气还没看好，请稍后再点', icon: 'none' });
      return;
    }
    const lead = SPEECH_LEAD[d.vclass] || SPEECH_LEAD.mid;
    const parts = ['今天' + lead + '。'];
    if (d.headline) parts.push(d.headline + '。');
    if (d.tip) parts.push(d.tip + '。');
    if (d.slot && d.slot.v) parts.push('最适合出门的时间是' + d.slot.v + '。');

    // 清洗严格卡在「parts.join('') 之后、speak() 之前」，返回新字符串；
    // this.data 里给界面显示的原串（含好排版的 – ）一个字都不改。
    const script = toReadable(parts.join(''));
    const ok = speech.speak(script, {
      onStart: () => { this._setSpeaking(true); },
      onEnd: () => { this._setSpeaking(false); },
      onError: () => { this._setSpeaking(false); },
    });
    if (!ok) {
      this._setSpeaking(false);
      wx.showToast({ title: '播报没能开始，请稍后再点', icon: 'none' });
      return;
    }
    // 合成请求已发出、音频还没回来这段窗口也算「播报中」：老人连点第二下
    // 就能立刻停，不会重复排队两段声音。onStart 再置一次是幂等的。
    this._setSpeaking(true);
  },

  goMap() {
    wx.redirectTo({ url: '/pages/elder-map/index' });
  },

  goVac() {
    wx.redirectTo({ url: '/pages/elder-vac/index' });
  },
});

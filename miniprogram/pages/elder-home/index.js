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

const VERDICT_ICON = { good: '✅', mid: '⚠️', bad: '⛔' };

// t6 四档（优/良/一般/不宜）→ 关怀版三态（good 绿 / mid 橙 / bad 红）
// 「优」与「良」同用绿色，靠 headline 文案区分（"现在出门很合适" vs "适合出门遛一遛"）
function vclassOf(levelKey) {
  if (levelKey === 'normal') return 'mid';
  if (levelKey === 'bad') return 'bad';
  return 'good';
}

Page({
  data: {
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

  // 语音播报：小程序没有浏览器那种原生 TTS，真朗读要接「微信同声传译」插件
  // （需后台申请 + 配置插件 appid）。本轮先放占位，不阻塞界面落地。
  onSpeak() {
    wx.showToast({ title: '即将支持', icon: 'none' });
  },

  goMap() {
    wx.redirectTo({ url: '/pages/elder-map/index' });
  },

  goVac() {
    wx.redirectTo({ url: '/pages/elder-vac/index' });
  },
});

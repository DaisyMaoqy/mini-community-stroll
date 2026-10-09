// pages/vaccine/index.js 接种页（M3/M4：接 local_spots 真实接种类 POI + 天气/出行建议）
const app = getApp();
const { callCloud } = require('../../utils/cloud.js');
const { planRoute, planRouteBlockless } = require('../../utils/routePlan.js');
const { getWeather, advice, travelTip } = require('../../utils/weather.js');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'child', label: '儿童可打' },
  { key: 'adult', label: '仅成人' },
];

// 「粤苗」小程序 appId —— 微信搜「粤苗」→ 右上角 … → 关于，可查 appId；
// 并到小程序后台「设置 - 第三方设置 - 跳转其他小程序」加入白名单，否则 navigateToMiniProgram 会失败。
const YUEMIAO_APPID = 'wx6af1989a3ae918a0';

// 社区中心兜底坐标（未授权定位时用于取天气）
const CENTER = { lat: 22.963, lng: 113.33 };

// 把云函数返回的 spot 收敛成本页卡片所需的字段
function enrich(s) {
  const coords = (s.coord && s.coord.coordinates) || [];
  return {
    id: s._id,
    name: s.vacName || s.name,
    subType: s.subType || '',
    address: s.address || '',
    ageRange: s.ageRange || '',
    busText: (s.bus && s.bus.busText) || '',
    adultOnly: !!s.adultOnly,
    external: !!s.external,
    // 候诊方式：indoor=室内候诊 / outdoor=室外排队 / 未传=未知（决定天气提示措辞）
    queue: s.queue || '',
    verified: s.verifyStatus === 'verified',
    verifySource: s.verifySource || '',
    verifyUrl: s.verifyUrl || '',
    lng: coords[0],
    lat: coords[1],
    // 供 utils/routePlan.js 出行决策用：保留 coord（gcj02）与 bus（邨巴可达性）
    coord: s.coord || null,
    bus: s.bus || null,
  };
}

Page({
  _decorateSeq: 0,
  data: {
    babyName: '',
    tabs: TABS,
    activeTab: 'all',
    list: [],
    loading: true,
    loadError: false,   // 云函数加载失败标记（区别于「确实无数据」，用于失败态重试卡）
    weather: null,      // { tempC, icon, text, rain2h, mock, ... }
    weatherAdvice: '',  // 顶部外出建议
    hasLoc: false,      // 是否已定位（决定是否显示距离与「按距离排序」）
    // 儿童疫苗指引点名（成人卡提醒行用）——从种子数据动态取，避免硬编码名称过期
    childVacName: '延康祈福社区卫生服务站',
    // 纠错上报弹层（report-sheet）受控状态：onReport() 打开，组件回调关闭
    reportVisible: false,
    reportSpotId: '',
    reportSpotName: '',
  },

  onLoad() {
    const bp = app.globalData && app.globalData.babyProfile;
    this.setData({ babyName: (bp && bp.name) || '' });
    this.load();
    this.loadWeather();
    this.locate();
  },

  onShow() {
    const bp = app.globalData && app.globalData.babyProfile;
    this.setData({ babyName: (bp && bp.name) || '', theme: app.resolveTheme() });
  },

  async load() {
    try {
      const res = await callCloud('spots', { action: 'list' });
      const all = (res && res.list) || [];
      const vacs = all.filter((s) => s.type === '接种').map(enrich);
      this._vacs = vacs;
      const tabs = TABS.map((t) => ({
        ...t,
        count:
          t.key === 'all'
            ? vacs.length
            : t.key === 'child'
            ? vacs.filter((v) => !v.adultOnly).length
            : vacs.filter((v) => v.adultOnly).length,
      }));
      // 社区内、非仅成人的接种点 = 儿童疫苗指引点（名称以种子数据为准，改数据即同步文案）
      const childVac = vacs.find((v) => !v.adultOnly && !v.external);
      // 先渲染、后补距离：把 enrich() 后的列表立刻写入 _rows 并 applyFilter，
      // 让卡片立即出现，消除「loading 已置 false 但 _rows 尚未写入」的空窗期
      // （该空窗期内 data.list 仍为 []，会闪出「暂无符合条件的接种点」）。
      // 此时尚未补 _meta/_distText（预期为空），随后 decorate() 会再 applyFilter 覆盖为新数据。
      this._rows = vacs.slice();
      this.applyFilter(this.data.activeTab);
      this.setData({
        tabs,
        loading: false,
        loadError: false,
        childVacName: (childVac && childVac.name) || this.data.childVacName,
      });
      await this.decorate();
    } catch (e) {
      console.error('加载接种点失败', e);
      // 失败态与空数据区分：置 loadError，由 WXML 渲染失败卡 + 重试入口
      this.setData({ loading: false, loadError: true });
    }
  },

  // 加载失败重试：重置为加载态后重新拉取
  onRetry() {
    this.setData({ loading: true, loadError: false });
    this.load();
  },

  // 天气：云函数 getWeather → 直连 Open-Meteo → 本地估算（三级降级，见 utils/weather.js）
  async loadWeather() {
    try {
      const w = await getWeather(CENTER.lat, CENTER.lng);
      this._weather = w;
      this.setData({ weather: w, weatherAdvice: advice(w) });
      this.decorate();
    } catch (e) {
      // 降级链内部已兜底，这里仅防御
    }
  },

  // 定位（失败不阻塞；PRD §4.5 原点=用户所选板块，定位仅作兜底）
  locate() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this._user = { lat: res.latitude, lng: res.longitude };
        this.decorate();
      },
      fail: () => {
        // 无定位仍可用板块坐标算距离
        this.decorate();
      },
    });
  },

  // 给每条接种点补「距离 + 出行方式（步行/邨巴/电动车）+ 天气提示」，有板块/定位时按距离排序
  // 用请求序号防并发乱序：load/loadWeather/locate 都可能触发 decorate，仅最新一次生效。
  async decorate() {
    // 数据未到不渲染：onLoad 中 load()/loadWeather()/locate() 三路并发，
    // loadWeather 或 locate 的 decorate 可能先于 load 返回（此时 this._vacs 仍为 undefined），
    // rows 为空 → applyFilter 会把 list 清空并闪出空态。
    // 故 _vacs 未就绪时直接返回，改由 load() 成功后再触发 decorate。
    if (!this._vacs) return;
    const seq = ++this._decorateSeq;
    const w = this._weather;
    const block = (app.globalData && app.globalData.block) || '';
    const rows = [];
    for (const v of this._vacs || []) {
      const nv = Object.assign({}, v);
      // 出行方案：板块坐标优先，回退定位
      let plan = null;
      try {
        if (block) {
          plan = await planRoute(block, nv);
        } else if (this._user) {
          plan = await planRouteBlockless(this._user.lat, this._user.lng, nv);
        }
      } catch (e) { plan = null; }
      if (seq !== this._decorateSeq) return; // 已被更新的 decorate 取代，放弃本次结果
      if (plan && plan.min != null) {
        nv._dist = plan.distM;
        nv._distText = plan.modeText + ' ' + plan.min + ' 分钟' + (plan.degraded ? '（估）' : '');
        nv._mode = plan.mode;
        nv._ebike = plan.ebike && plan.ebike.available
          ? '也可骑电动车约 ' + plan.ebike.min + ' 分钟'
          : '';
        nv._busText = plan.bus && plan.bus.text ? plan.bus.text : '';
        nv._degraded = plan.degraded;
      }
      // 副标题行 = 门诊类型 · 距离/出行方式（参考「预防接种门诊 · 1.2 km · 步行 16 分钟」）
      nv._meta = [nv.subType, nv._distText].filter(Boolean).join(' · ');
      // 天气提示：按候诊方式分流（室内候诊不再出现「室外排队」），社区外点额外叠加换乘提示
      nv._tip = w ? travelTip(w, nv.queue) : '';
      if (nv._tip && nv.external) {
        nv._tip += '；社区外接种点，需换乘前往，请预留路程时间';
      }
      rows.push(nv);
    }
    if (block || this._user) {
      rows.sort((a, b) => (a._dist == null ? 1e9 : a._dist) - (b._dist == null ? 1e9 : b._dist));
    }
    this._rows = rows;
    this.setData({ hasLoc: !!(block || this._user) });
    this.applyFilter(this.data.activeTab);
  },

  applyFilter(key) {
    const list = (this._rows || []).filter((v) =>
      key === 'all' ? true : key === 'child' ? !v.adultOnly : v.adultOnly
    );
    this.setData({ list, activeTab: key });
  },

  onTab(e) {
    this.applyFilter(e.currentTarget.dataset.key);
  },

  // 查看官方信息：复制官方链接到剪贴板（小程序无 web-view 业务域名时最稳妥）
  onBook(e) {
    const v = (this.data.list || [])[e.currentTarget.dataset.idx];
    if (v && v.verifyUrl) {
      wx.setClipboardData({
        data: v.verifyUrl,
        success() {
          wx.showToast({ title: '官方链接已复制', icon: 'none' });
        },
      });
    } else {
      wx.showToast({ title: '暂未收录官方链接', icon: 'none' });
    }
  },

  // 到这里：调起原生地图导航（coord 已是 gcj02）
  onNav(e) {
    const v = (this.data.list || [])[e.currentTarget.dataset.idx];
    if (v && v.lat && v.lng) {
      wx.openLocation({
        latitude: v.lat,
        longitude: v.lng,
        name: v.name,
        address: v.address || '',
        scale: 15,
      });
    } else {
      wx.showToast({ title: '暂无坐标', icon: 'none' });
    }
  },

  // 「信息有误？反馈」：打开 report-sheet（携带该接种点的 _id / name），不再假 toast。
  onReport(e) {
    const v = (this.data.list || [])[e.currentTarget.dataset.idx];
    if (!v) return;
    this.setData({
      reportVisible: true,
      reportSpotId: v.id || '',
      reportSpotName: v.name || '',
    });
  },
  // report-sheet 关闭 → 隐藏弹层
  onReportClose() {
    this.setData({ reportVisible: false });
  },
  // report-sheet 提交成功 → 隐藏弹层（权威表不自动改，无需刷新列表）
  onReportSubmitted() {
    this.setData({ reportVisible: false });
  },

  // 打开「粤苗」小程序（接种预约官方平台）。腾讯系内跳转最稳，但需配置 appId + 后台白名单。
  onYueMiao() {
    if (!YUEMIAO_APPID) {
      wx.showToast({ title: '请微信搜索「粤苗」小程序', icon: 'none' });
      return;
    }
    wx.navigateToMiniProgram({
      appId: YUEMIAO_APPID,
      fail() {
        wx.showToast({ title: '跳转失败，请微信搜索「粤苗」', icon: 'none' });
      },
    });
  },
});

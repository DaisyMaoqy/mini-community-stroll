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
    weather: null,      // { tempC, icon, text, rain2h, mock, ... }
    weatherAdvice: '',  // 顶部外出建议
    hasLoc: false,      // 是否已定位（决定是否显示距离与「按距离排序」）
    // 儿童疫苗指引点名（成人卡提醒行用）——从种子数据动态取，避免硬编码名称过期
    childVacName: '延康祈福社区卫生服务站',
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
      this.setData({
        tabs,
        loading: false,
        childVacName: (childVac && childVac.name) || this.data.childVacName,
      });
      this.decorate();
    } catch (e) {
      console.error('加载接种点失败', e);
      this.setData({ loading: false });
    }
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

  onReport() {
    wx.showToast({ title: '已提交纠错，感谢反馈', icon: 'none' });
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

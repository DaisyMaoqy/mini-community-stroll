// pages/vaccine/index.js 接种页（M4：接 local_spots 真实接种类 POI）
const app = getApp();
const { callCloud } = require('../../utils/cloud.js');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'child', label: '儿童可打' },
  { key: 'adult', label: '仅成人' },
];

// 「粤苗」小程序 appId —— 微信搜「粤苗」→ 右上角 … → 关于，可查 appId；
// 并到小程序后台「设置 - 第三方设置 - 跳转其他小程序」加入白名单，否则 navigateToMiniProgram 会失败。
const YUEMIAO_APPID = 'wx6af1989a3ae918a0';

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
    verified: s.verifyStatus === 'verified',
    verifySource: s.verifySource || '',
    verifyUrl: s.verifyUrl || '',
    lng: coords[0],
    lat: coords[1],
  };
}

Page({
  data: {
    babyName: '',
    tabs: TABS,
    activeTab: 'all',
    list: [],
    loading: true,
  },

  onLoad() {
    const bp = app.globalData && app.globalData.babyProfile;
    this.setData({ babyName: (bp && bp.name) || '' });
    this.load();
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
      this.setData({ tabs, loading: false });
      this.applyFilter('all');
    } catch (e) {
      console.error('加载接种点失败', e);
      this.setData({ loading: false });
    }
  },

  applyFilter(key) {
    const list = (this._vacs || []).filter((v) =>
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

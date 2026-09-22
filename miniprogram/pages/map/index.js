// pages/map/index.js 遛娃地图（M3：接 local_spots 真实 POI + 标记 + 详情）
const app = getApp();
const { callCloud } = require('../../utils/cloud.js');

const CAT = {
  '接种': { pin: 'vac', color: '#F0A93B', label: '接种' },
  '遛娃': { pin: 'play', color: '#2FB67C', label: '遛娃' },
  '便民': { pin: 'civic', color: '#4A8FD0', label: '便民' },
  '邨巴': { pin: 'bus', color: '#FF9E6D', label: '邨巴' },
};
const CAT_ORDER = ['接种', '遛娃', '便民', '邨巴'];

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// 调试用加载模拟（仅「开发者工具模拟器」内生效；真机 / 真机调试恒返回 0，走真实网络）。
// 微信开发者工具的网络面板只会节流 WebView 请求，不会节流 wx.cloud.callFunction（走云 SDK 独立通道），
// 所以「Slow 3G」看不到骨架屏。要在模拟器里查看骨架/失败态，请在调试器 Console 执行：
//   wx.setStorageSync('__debugMapLoad', 1)   // 1=模拟慢网（延迟 3s 再返回）
//   wx.setStorageSync('__debugMapLoad', 2)   // 2=模拟断网（强制失败，显示失败卡）
//   wx.removeStorageSync('__debugMapLoad')   // 恢复正常
// 然后切走再切回地图页（或点刷新）即可看到对应状态。
// 真机测试请用真实网络条件：开飞行模式=断网、弱信号=弱网，云调用会真实失败/变慢，无需此钩子。
// 把模拟限定在模拟器内，可避免真机调试时模拟抛错干扰开发者工具导致闪退。
function debugLoadMode() {
  try {
    const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
    const env = (info && info.miniProgram && info.miniProgram.envVersion) || 'develop';
    if (env === 'release') return 0;
    // 仅开发者工具模拟器（platform==='devtools'）启用模拟；真机 / 真机调试走真实网络
    const sys = (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}) || {};
    if (sys.platform !== 'devtools') return 0;
    return Number(wx.getStorageSync('__debugMapLoad')) || 0;
  } catch (e) {
    return 0;
  }
}

Page({
  data: {
    center: { lat: 22.963, lng: 113.33 },
    scale: 15,
    tabs: [{ key: 'all', label: '全部' }],
    activeTab: 'all',
    filtered: [],
    markers: [],
    detail: null,
    userLoc: null,
    loading: true,
    mapReady: false,   // 地图瓦片渲染就绪（bindupdated 置 true，含兜底超时）
    loadError: false,  // 云函数加载失败标记（区别于空数据）
    locating: false,   // 定位进行中
  },

  onLoad() {
    this.loadSpots();
    this.getLocation();
  },

  onShow() {
    this.setData({ theme: app.resolveTheme() });
  },

  async loadSpots() {
    const dbg = debugLoadMode();
    try {
      if (dbg === 1) await new Promise((r) => setTimeout(r, 3000));
      if (dbg === 2) throw new Error('debug: 模拟断网');
      const res = await callCloud('spots', { action: 'list' });
      const list = (res && res.list) || [];
      // 类别 tabs（仅显示真实存在的类别）
      const present = CAT_ORDER.filter((t) => list.some((s) => s.type === t));
      const tabs = [{ key: 'all', label: '全部' }].concat(
        present.map((t) => ({ key: t, label: CAT[t].label }))
      );
      // 中心点 = POI 坐标均值
      const coords = list
        .filter((s) => s.coord && s.coord.coordinates)
        .map((s) => s.coord.coordinates);
      let clat = 22.963, clng = 113.33;
      if (coords.length) {
        clng = coords.reduce((a, c) => a + c[0], 0) / coords.length;
        clat = coords.reduce((a, c) => a + c[1], 0) / coords.length;
      }
      // 给每个 POI 加一个 CSS 安全的类型类名（WXSS 不允许中文选择器）
      const TYPE_CLASS = { '接种': 't-vac', '遛娃': 't-play', '便民': 't-civic', '邨巴': 't-bus' };
      this.allSpots = list.map((s) => Object.assign({}, s, { typeClass: TYPE_CLASS[s.type] || 't-civic' }));
      this.setData({ tabs, activeTab: 'all', center: { lat: clat, lng: clng }, loading: false, loadError: false, mapReady: false });
      this.applyFilter('all');
      // 地图瓦片加载兜底：bindupdated 未触发时 1.5s 后结束"地图加载中"
      setTimeout(() => { if (!this.data.mapReady) this.setData({ mapReady: true }); }, 1500);
    } catch (e) {
      // 调试模拟的断网（message 以 'debug:' 开头）不刷 console.error，
      // 避免真机调试桥转发日志时拖累开发者工具导致闪退；真实错误照常记录。
      const isDebugSim = e && typeof e.message === 'string' && e.message.indexOf('debug:') === 0;
      if (!isDebugSim) console.error('加载 POI 失败', e);
      this.setData({ loading: false, loadError: true });
    }
  },

  getLocation() {
    const self = this;
    this.setData({ locating: true });
    wx.getLocation({
      type: 'gcj02',
      success(res) {
        self.setData({ userLoc: { lat: res.latitude, lng: res.longitude }, locating: false });
        self.computeDistances();
      },
      fail() {
        // 用户拒绝授权：不显示距离即可
        self.setData({ locating: false });
      },
    });
  },

  computeDistances() {
    const u = this.data.userLoc;
    if (!u) return;
    const list = (this.allSpots || []).map((s) => {
      const ns = Object.assign({}, s);
      if (s.coord && s.coord.coordinates) {
        const d = haversine(u.lat, u.lng, s.coord.coordinates[1], s.coord.coordinates[0]);
        ns._dist = d;
        ns._walkMin = Math.max(1, Math.round(d / 70)); // 约 70m/min
      }
      return ns;
    });
    this.allSpots = list;
    this.applyFilter(this.data.activeTab);
  },

  applyFilter(tab) {
    const list = (this.allSpots || []).filter((s) => tab === 'all' || s.type === tab);
    const markers = list.map((s, i) => {
      const cat = CAT[s.type] || { pin: 'civic' };
      return {
        id: i,
        latitude: s.coord.coordinates[1],
        longitude: s.coord.coordinates[0],
        iconPath: '/assets/pins/pin-' + cat.pin + '.png',
        width: 30,
        height: 38,
        anchor: { x: 0.5, y: 1 },
      };
    });
    this._idx = list; // marker.id 与 list 下标对应
    this.setData({ filtered: list, markers, activeTab: tab });
  },

  onTab(e) {
    this.applyFilter(e.currentTarget.dataset.tab);
  },

  onMarkerTap(e) {
    const s = (this._idx || [])[e.detail.markerId];
    if (s) this.openDetail(s);
  },

  onCardTap(e) {
    const s = (this.data.filtered || [])[e.currentTarget.dataset.idx];
    if (s) this.openDetail(s);
  },

  openDetail(s) {
    this.setData({ detail: s });
  },
  closeDetail() {
    this.setData({ detail: null });
  },
  noop() {},
  reportFix() {
    wx.showToast({ title: '已提交纠错，感谢反馈', icon: 'none' });
    this.closeDetail();
  },

  // 地图渲染完成（瓦片就位）后关闭"地图加载中"提示
  onMapUpdated() {
    if (!this.data.mapReady) this.setData({ mapReady: true });
  },

  // 手动重新加载（刷新按钮 / 加载失败重试）
  reload() {
    this.setData({ loadError: false, loading: true, locating: true, mapReady: false });
    this.loadSpots();
    this.getLocation();
  },
});

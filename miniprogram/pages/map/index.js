// pages/map/index.js 遛娃地图（M3：接 local_spots 真实 POI + 标记 + 详情）
// M4：邨巴 tab 改为「地铁式线路示意图」——数据源为官方推文（pages/map/busRoutes.js）。
//     真实地图不再用于邨巴：封闭小区无街/幢级 POI，geocoding 精度只能到小区级（±300~900m），
//     站点级需要 ±20~50m，打点与 polyline 会误导用户，故移除。
const app = getApp();
const { callCloud } = require('../../utils/cloud.js');
const busData = require('./busRoutes.js');

const CAT = {
  '接种': { pin: 'vac', color: '#F0A93B', label: '接种' },
  '遛娃': { pin: 'play', color: '#2FB67C', label: '遛娃' },
  '便民': { pin: 'civic', color: '#4A8FD0', label: '便民' },
  '邨巴': { pin: 'bus', color: '#FF9E6D', label: '邨巴' },
};
const CAT_ORDER = ['接种', '遛娃', '便民', '邨巴'];

// 邨巴线路配色（地铁图式）—— 唯一真源为 busRoutes.js 的 ROUTE_COLORS，
// 此处直接引用，保证与 tools/gen_map_pins.py 的 BUS_ROUTES、示意图内联色三处完全一致。
const BUS_ROUTE_COLORS = busData.ROUTE_COLORS;

// 线路摘要（总览列表 / 示意图图例共用）
const LINE_SUMMARY = busData.ROUTE_ORDER.map((id) => {
  const line = busData.routes[id];
  const ins = busData.buildStations(id, 'in');
  const outs = busData.buildStations(id, 'out');
  return {
    id: id,
    name: line.name,
    color: line.color,
    via: line.via,
    from: ins.length ? ins[0].name : '',
    to: ins.length ? ins[ins.length - 1].name : '',
    inCount: ins.length,
    outCount: outs.length,
    inLabel: line.inLabel,
    outLabel: line.outLabel,
  };
});

// 总览扇形角度：8 条线从枢纽向上发散，均匀铺满 -168° ~ -12°（CSS rotate，负值朝上）
const FAN_SPAN = 156;
const FAN_START = -168;
const FAN_LINES = LINE_SUMMARY.map((line, i) => {
  const raw = FAN_START + (FAN_SPAN * i) / Math.max(1, LINE_SUMMARY.length - 1);
  const angle = Math.round(raw * 10) / 10;
  return Object.assign({}, line, { angle: angle, counterAngle: -angle });
});

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
    // 邨巴线路筛选 chips（配色取自 BUS_ROUTE_COLORS）
    activeRoute: 'all', // 'all' = 线网总览；否则为单线路号
    routeChips: [
      { r: 'all', label: '全部', c: '#8A9490' },
      { r: '1', label: '1', c: BUS_ROUTE_COLORS['1'] },
      { r: '2', label: '2', c: BUS_ROUTE_COLORS['2'] },
      { r: '3', label: '3', c: BUS_ROUTE_COLORS['3'] },
      { r: '5', label: '5', c: BUS_ROUTE_COLORS['5'] },
      { r: '6', label: '6', c: BUS_ROUTE_COLORS['6'] },
      { r: '8', label: '8', c: BUS_ROUTE_COLORS['8'] },
      { r: 'A', label: 'A', c: BUS_ROUTE_COLORS['A'] },
      { r: 'C', label: 'C', c: BUS_ROUTE_COLORS['C'] },
    ],
    // ---- 邨巴「地铁式示意图」渲染数据 ----
    busDir: 'in',            // 'in' = 入邨（第一方向），'out' = 出邨（第二方向）
    hubName: busData.HUB_NAME,
    hubColor: BUS_ROUTE_COLORS.hub,
    overviewLines: FAN_LINES.map((l) => Object.assign({}, l, { active: false })),
    lineCards: LINE_SUMMARY, // activeRoute === 'all' 时的线路列表
    activeLine: null,        // 单线路态：线路摘要对象
    chain: [],               // 单线路态：当前方向有序站点
    chainCount: 0,
    timetable: null,         // buildTimetable 结果
    ttOpen: false,           // 时刻表展开开关
  },

  onLoad() {
    this.getLocation();
  },

  onShow() {
    this.setData({ theme: app.resolveTheme() });
    // 切回地图（tab 切换 / 从详情返回）时重新拉取 POI，保证数据最新
    this.loadSpots();
  },

  async loadSpots() {
    const dbg = debugLoadMode();
    try {
      if (dbg === 1) await new Promise((r) => setTimeout(r, 3000));
      if (dbg === 2) throw new Error('debug: 模拟断网');
      const res = await callCloud('spots', { action: 'list' });
      const list = (res && res.list) || [];
      // 类别 tabs：接种/遛娃/便民 仅显示真实存在的类别；
      // 邨巴无条件保留 —— 其数据源是 busRoutes.js（地铁式示意图），
      // 不再依赖 local_spots 里的邨巴 POI（已于 2026-09-24 从种子移除）
      const present = CAT_ORDER.filter(
        (t) => t === '邨巴' || list.some((s) => s.type === t)
      );
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
    // 保留当前线路选择（定位异步返回时不要清掉用户已选线路）
    this.applyFilter(this.data.activeTab, this.data.activeRoute);
  },

  applyFilter(tab, route) {
    route = route || 'all';
    // 先按分类 tab 过滤
    let list = (this.allSpots || []).filter((s) => tab === 'all' || s.type === tab);
    // 邨巴 + 指定线路：按 bus.lines 全线路集合过滤（换乘站会在每条相关线路下出现）
    if (tab === '邨巴' && route !== 'all') {
      list = list.filter((s) => s.bus && s.bus.lines && s.bus.lines.split('/').indexOf(route) >= 0);
    }
    // ⚠ 邨巴 POI 一律不上真实地图（任何 tab）。
    //   坐标可靠性是数据属性、与 tab 无关：这些点由「小区级」geocoding 生成（±300~900m），
    //   站点级需要 ±20~50m，画上去必然"位置不贴合、散乱"，会误导用户。
    //   邨巴信息改由「地铁式线路示意图」承载（见 邨巴 tab）。
    //   注：list 仍保留邨巴条目以兼容既有数据，仅不产出 marker。
    //   ⚠ marker 子集与 _idx 必须是同一套下标体系：_idx 也按同一条件过滤，
    //     否则 marker.id（过滤后下标）与 _idx（未过滤下标）错位，点 marker 会弹错详情。
    //   ⚠ 无 coord 的 POI 不打点（cloudfunctions/spots 的 validateSpot 允许 coord 缺省入库），
    //     同样并入过滤条件而非 map 中跳过，避免 map 回调里的下标再次错位。
    const markerSpots = list.filter((s) => s.type !== '邨巴' && s.coord && s.coord.coordinates);
    const markers = markerSpots.map((s, i) => {
      const pin = (CAT[s.type] || { pin: 'civic' }).pin;
      return {
        id: i,
        latitude: s.coord.coordinates[1],
        longitude: s.coord.coordinates[0],
        iconPath: '/assets/pins/pin-' + pin + '.png',
        width: 30,
        height: 38,
        anchor: { x: 0.5, y: 1 },
      };
    });
    this._idx = markerSpots; // marker.id 与本数组的下标一一对应

    this.setData({
      filtered: list,
      markers: markers,
      activeTab: tab,
      activeRoute: route,
    });
    // 邨巴：重建示意图渲染数据
    this.buildBusView(route);
  },

  /**
   * 构建「地铁式示意图」渲染数据。
   * @param {string} route 'all' = 线网总览；否则为线路号
   */
  buildBusView(route) {
    const overviewLines = FAN_LINES.map((l) => Object.assign({}, l, { active: l.id === route }));
    if (route === 'all') {
      this.setData({
        overviewLines: overviewLines,
        activeLine: null,
        chain: [],
        chainCount: 0,
        timetable: null,
        ttOpen: false,
      });
      return;
    }
    const line = busData.routes[route];
    if (!line) {
      // 未知线路号（脏数据 / 未来线路号下线）：不静默返回，回退到线网总览态，
      // 避免 activeLine / chain / timetable 残留上一条线路造成"显示陈旧链"。
      this.setData({ activeRoute: 'all' });
      this.buildBusView('all');
      return;
    }
    const dir = this.data.busDir === 'out' ? 'out' : 'in';
    const hubColor = BUS_ROUTE_COLORS.hub;
    // 站点圆点配色：枢纽 = 枢纽灰；首末站 = 实心线路色；中途站 = 白心线路描边
    const chain = busData.buildStations(route, dir).map((st) => {
      const c = st.isHub ? hubColor : line.color;
      return Object.assign({}, st, {
        dotBorder: c,
        dotBg: (st.isHub || st.isTerminal) ? c : '#FFFFFF',
      });
    });
    const summary = LINE_SUMMARY.filter((l) => l.id === route)[0] || null;
    this.setData({
      overviewLines: overviewLines,
      activeLine: summary,
      chain: chain,
      chainCount: chain.length,
      timetable: busData.buildTimetable(route),
      ttOpen: false,
    });
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeRoute: 'all' }); // 切换分类时回到线网总览
    this.applyFilter(tab, 'all');
  },

  // 邨巴线路筛选：点线路 chip 切换 activeRoute（同时驱动示意图）
  onRouteTap(e) {
    this.applyFilter(this.data.activeTab, e.currentTarget.dataset.route);
  },

  // 总览列表 / 图例点选线路
  onLineTap(e) {
    this.applyFilter('邨巴', e.currentTarget.dataset.route);
  },

  // 入邨 / 出邨 方向切换
  onDirTap(e) {
    const dir = e.currentTarget.dataset.dir === 'out' ? 'out' : 'in';
    if (dir === this.data.busDir) return;
    this.setData({ busDir: dir });
    this.buildBusView(this.data.activeRoute);
  },

  // 时刻表展开 / 收起
  toggleTimetable() {
    this.setData({ ttOpen: !this.data.ttOpen });
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
    const d = Object.assign({}, s);
    if (s.type === '邨巴' && s.bus) {
      d.busColor = s.isHub ? BUS_ROUTE_COLORS.hub : (BUS_ROUTE_COLORS[s.route] || '#FF9E6D');
    }
    this.setData({ detail: d });
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

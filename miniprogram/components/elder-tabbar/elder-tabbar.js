// components/elder-tabbar —— 关怀版底部大导航栏（78px + 安全区）
//
// 为什么不用 app.json 的 tabBar：小程序 tabBar.list 上限 5 项，已被标准版四页
// （index / vaccine / map / mine）占满，关怀版四页进不去。所以关怀版走「非 tab 页 +
// 自建导航」这条路：四个页面各自渲染本组件，用 wx.redirectTo 互切。
// 好处是标准版四页零改动（不需要感知 elderMode），坏处是每次切换会重建页面、
// 没有 tab 页的常驻缓存 —— 对关怀版这种短路径场景可以接受。
const TABS = [
  { key: 'home', label: '首页', icon: 'home', url: '/pages/elder-home/index' },
  { key: 'vac', label: '接种', icon: 'vaccine', url: '/pages/elder-vac/index' },
  { key: 'map', label: '遛娃', icon: 'map', url: '/pages/elder-map/index' },
  { key: 'me', label: '我的', icon: 'user', url: '/pages/elder-me/index' },
];

Component({
  properties: {
    current: { type: String, value: 'home' }, // 'home' | 'vac' | 'map' | 'me'
  },

  data: {
    tabs: TABS,
  },

  methods: {
    onTap(e) {
      const key = e.currentTarget.dataset.key;
      // 已在当前页就不再跳转：redirectTo 会重建页面，重复点击是纯浪费
      if (key === this.properties.current) return;
      const tab = TABS.filter(function (t) { return t.key === key; })[0];
      if (!tab) return;
      wx.redirectTo({
        url: tab.url,
        fail: function (err) { console.error('[elder-tabbar] redirectTo 失败', key, err); },
      });
    },
  },
});

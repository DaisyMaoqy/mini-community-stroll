// svg-icon 组件（v15 主题化：图标颜色随主题自动换深浅）
// 用法：<svg-icon name="home" size="22"></svg-icon>
// 实现：<view> + CSS mask（描边图作遮罩），background-color 取 var(--green)，
//      因此 data-theme 切到 infant / toddler / elder 时图标颜色自动跟随，调用处无需改动。
// 彩色 PNG 通道：个别插画型图标（ebike/walk）为彩色位图，无法走单色 mask，
//      在 PNG_ICONS 登记后用 <image> 直渲，调用处写法完全一致。
//      注意：彩色 PNG 不随 data-theme 变色（插画本身带色，属预期）。
const ICONS = require('./icons.js');

// 彩色 PNG 图标登记表：name -> 包内绝对路径
const PNG_ICONS = {
  ebike: '/assets/icons/ebike-color.png',
  walk: '/assets/icons/walk-color.png',
};

Component({
  properties: {
    name: {
      type: String,
      value: '',
    },
    size: {
      type: Number,
      value: 19,
    },
    // 可选着色：'' 默认主题绿；'peach' 蜜桃（宝宝胶囊）；'red' 红；'ink' 墨灰；'mint' 浅绿（v15 指数分项）
    // 对 PNG 彩色图标无效（保持插画原色）
    tint: {
      type: String,
      value: '',
    },
  },
  data: {
    mask: '',
    img: '',
  },
  observers: {
    name(n) {
      this.applyIcon(n);
    },
  },
  lifetimes: {
    attached() {
      this.applyIcon(this.data.name);
    },
  },
  methods: {
    applyIcon(n) {
      if (PNG_ICONS[n]) {
        this.setData({ img: PNG_ICONS[n], mask: '' });
        return;
      }
      const svg = ICONS[n] || ICONS.home || '';
      this.setData({ img: '', mask: 'data:image/svg+xml,' + encodeURIComponent(svg) });
    },
  },
});

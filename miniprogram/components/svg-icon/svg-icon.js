// svg-icon 组件（v15 主题化：图标颜色随主题自动换深浅）
// 用法：<svg-icon name="home" size="22"></svg-icon>
// 实现：<view> + CSS mask（描边图作遮罩），background-color 取 var(--green)，
//      因此 data-theme 切到 infant / toddler / elder 时图标颜色自动跟随，调用处无需改动。
const ICONS = require('./icons.js');

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
  },
  data: {
    mask: '',
  },
  observers: {
    name(n) {
      const svg = ICONS[n] || ICONS.home || '';
      this.setData({ mask: 'data:image/svg+xml,' + encodeURIComponent(svg) });
    },
  },
  lifetimes: {
    attached() {
      const svg = ICONS[this.data.name] || ICONS.home || '';
      this.setData({ mask: 'data:image/svg+xml,' + encodeURIComponent(svg) });
    },
  },
});

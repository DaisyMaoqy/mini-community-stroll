// svg-icon 组件
// 用法：<svg-icon name="home" color="icon" size="22"></svg-icon>
// 图标文件约定：/assets/icons/i-{{name}}-{{color}}.svg（颜色烘焙为变体文件）
Component({
  properties: {
    name: {
      type: String,
      value: '',
    },
    color: {
      type: String,
      value: 'icon',
    },
    size: {
      type: Number,
      value: 19,
    },
  },
  data: {},
  methods: {},
});

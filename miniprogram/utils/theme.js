// utils/theme.js —— 主题调色板（canvas 等无法读取 CSS 变量的场景统一从这里取色）
// 与 styles/tokens.wxss + styles/theme.wxss 保持同步：改主题色时两处一起改。
// toddler = tokens.wxss 默认；infant/elder = theme.wxss 的 [data-theme] 覆盖块。
const PALETTE = {
  toddler: { green: '#2FB67C', greenD: '#1F8F60', greenM: '#5CC79A', greenL: '#E7F6EF', greenL2: '#F1FAF5' },
  infant:  { green: '#7FB39E', greenD: '#567F6B', greenM: '#9CC7B4', greenL: '#E8F1EC', greenL2: '#F2F8F5' },
  elder:   { green: '#2C7C50', greenD: '#14502C', greenM: '#488C64', greenL: '#E6F2EA', greenL2: '#EFF7F1' },
};

function palette(theme) {
  return PALETTE[theme] || PALETTE.toddler;
}

module.exports = { PALETTE, palette };

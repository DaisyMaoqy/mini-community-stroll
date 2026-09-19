// pages/elder/index.js 大字关怀版（M0 骨架）
Page({
  data: {},
  goMap() {
    wx.switchTab({ url: '/pages/map/index' });
  },
  goVaccine() {
    wx.switchTab({ url: '/pages/vaccine/index' });
  },
  goMine() {
    wx.switchTab({ url: '/pages/mine/index' });
  },
  goBack() {
    wx.navigateBack();
  },
});

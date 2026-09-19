// pages/mine/index.js 我的（M0 骨架）
const app = getApp();

Page({
  data: { babyName: '未设置宝宝' },
  onShow() {
    const profile = app.globalData.babyProfile;
    if (profile && profile.name) {
      this.setData({ babyName: profile.name });
    }
  },
  goElder() {
    wx.navigateTo({ url: '/pages/elder/index' });
  },
  goSetting() {
    wx.showToast({ title: '设置（M5 接入）', icon: 'none' });
  },
});

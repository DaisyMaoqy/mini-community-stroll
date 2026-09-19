// app.js
App({
  onLaunch: function () {
    this.globalData = {
      // env 参数说明：
      // env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会请求到哪个云环境的资源
      // 此处请填入环境 ID, 环境 ID 可在微信开发者工具右上顶部工具栏点击云开发按钮打开获取
      env: "cloud1-d1gxzmgkie0e81cac",
      // 宝宝档案（M5 我的页录入；M2 首页户外计时/个性化关联）
      babyProfile: null, // { name, birth, gender, ... }
      // 关怀大字模式开关（M5/M6 切换并写入 storage）
      elderMode: false,
      // 户外陪伴计时（M2 首页双环：室内/室外累计分钟 + 每日目标）
      outdoor: { indoor: 0, outdoor: 0, goal: 60 },
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
  },
});

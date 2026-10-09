// 运营白名单：仅列于此数组的 openid 可调用 queue / review。
// 维护方式：改数组 → 重新部署 reports 云函数（不部署不生效）。
// 取本人 openid：部署后调用 { action: 'whoami' } 的返回即本人 openid。
module.exports = [
  // 'oXXXXXXXXXXXXXXXXXXXXXXXXXXX',
];

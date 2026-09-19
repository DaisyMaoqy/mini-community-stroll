/**
 * 云函数调用封装
 * - 统一 Promise 化 wx.cloud.callFunction
 * - 适配现有 spots 云函数的扁平式入参：
 *     event.type / event.adultOnly / event.verifyStatus / event.limit / event.id / event.data
 * - 云函数返回 { success, ... } 时，success === false 会 reject 并携带 message
 */
function callCloud(name, data) {
  return new Promise(function (resolve, reject) {
    wx.cloud.callFunction({
      name: name,
      data: data || {},
    }).then(function (res) {
      const result = res && res.result;
      if (result && result.success === false) {
        reject(new Error(result.message || '云函数返回失败'));
        return;
      }
      resolve(result);
    }).catch(function (err) {
      reject(err);
    });
  });
}

module.exports = { callCloud };

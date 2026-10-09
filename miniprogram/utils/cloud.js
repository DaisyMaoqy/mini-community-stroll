/**
 * 云函数调用封装
 * - 统一 Promise 化 wx.cloud.callFunction
 * - 适配现有 spots 云函数的扁平式入参：
 *     event.type / event.adultOnly / event.verifyStatus / event.limit / event.id / event.data
 * - 云函数返回 { success, ... } 时，success === false 会 reject 并携带 message 与 code
 *   （reports 云函数用 message 字段；code 供调用方识别限流等分支，向后兼容：不读 code 的旧调用方行为不变）
 */
function callCloud(name, data) {
  return new Promise(function (resolve, reject) {
    wx.cloud.callFunction({
      name: name,
      data: data || {},
    }).then(function (res) {
      const result = res && res.result;
      if (result && result.success === false) {
        const err = new Error(result.message || '云函数返回失败');
        // 透传云函数错误码（如 RATE_LIMITED / INVALID_PARAM），供组件识别限流分支
        if (result.code) err.code = result.code;
        reject(err);
        return;
      }
      resolve(result);
    }).catch(function (err) {
      reject(err);
    });
  });
}

module.exports = { callCloud };

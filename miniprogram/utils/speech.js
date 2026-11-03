// utils/speech.js —— 语音播报（可降级实现）
//
// ⚠️ 小程序没有浏览器那种 window.speechSynthesis。真朗读依赖「微信同声传译」插件
// （插件名 WechatSI，provider appid wx069ba97219f66d99）：
//   plugin.textToSpeech({ lang, tts, content, success, fail }) → success 返回 res.filename
//   （临时语音文件路径），还需用 wx.createInnerAudioContext() 自行播放，插件不负责播放。
//
// 该插件必须由小程序管理员在微信公众平台后台「设置 → 第三方设置 → 插件管理」手动添加。
// 未添加时：① 往 app.json 写 plugins 声明会直接导致编译失败；② 运行时 requirePlugin 会抛错。
// 所以本期策略是「代码写全 + 运行时探测 + 优雅降级」：
//   · miniprogram/app.json 目前【没有】声明该插件，因此 available() 返回 false —— 这是
//     预期行为，不是 bug；页面会提示「语音播报暂未开通」，不会崩、不会白屏。
//   · 后台添加插件后，只需在 app.json 补上声明即可让业务代码原样生效，无需改动任何页面：
//       "plugins": {
//         "WechatSI": {
//           "version": "<以后台插件管理页显示为准>",
//           "provider": "wx069ba97219f66d99"
//         }
//       }
//   · 本文件不会（也不该由工具模块）去改 app.json。
//
// 约束：任何情况下都不把异常抛给调用方 —— requirePlugin / textToSpeech / InnerAudioContext
// 的每一步都包 try/catch；失败通过回调或 false 返回值表达。

const PLUGIN_NAME = 'WechatSI';
// 单次合成的最大字数：微信同声传译对超长文本会直接 fail，见 speak() 里的截断说明。
const MAX_LEN = 300;

let _probed = false;   // 探测结果缓存，只探一次
let _plugin = null;    // 插件实例；null = 不可用
let _audio = null;     // 当前正在播放的 InnerAudioContext
let _seq = 0;          // 请求序号：stop()/新一句让在途合成回调作废，防止串音

/**
 * 探测插件是否可用，结果缓存，只探一次。
 * requirePlugin 在插件未声明 / 未授权时【会抛错】，必须整体包 try/catch。
 * @returns {boolean} 插件是否可用
 */
function probe() {
  if (_probed) return _plugin !== null;
  _probed = true;
  try {
    if (typeof requirePlugin !== 'function') return false;
    const p = requirePlugin(PLUGIN_NAME);
    // 顺手确认核心方法在，避免插件返回空壳时后续调用再抛错
    _plugin = (p && typeof p.textToSpeech === 'function') ? p : null;
  } catch (e) {
    _plugin = null;
  }
  return _plugin !== null;
}

/**
 * 插件是否可用。app.json 未声明时返回 false —— 预期的降级，不是错误。
 * @returns {boolean}
 */
function available() {
  return probe();
}

/**
 * 停止并销毁当前语音、清引用。可重复调用（无音频时是 no-op）。
 * 同时递增 _seq，让仍在途的 textToSpeech 回调作废，避免「停止后声音又冒出来」。
 * @returns {void}
 */
function stop() {
  _seq++;
  const a = _audio;
  _audio = null;
  if (!a) return;
  try {
    a.stop();
    a.destroy();
  } catch (e) {
    // 销毁异常也不能抛给调用方；引用已清空，不会再留可播放句柄
  }
}

/**
 * 朗读一段中文。
 * @param {string} text 待朗读文本；空字符串或非字符串直接返回 false
 * @param {{onStart?: Function, onEnd?: Function, onError?: Function}} [opts] 生命周期回调
 * @returns {boolean} 是否成功发起合成并进入播放流程。
 *   注意：textToSpeech 是异步的，同步返回值只能表示「已成功发起请求」，
 *   真正开始播放以 onStart 为准；插件不可用 / 参数非法 / 调用抛错返回 false。
 */
function speak(text, opts) {
  const o = opts || {};
  const cbStart = typeof o.onStart === 'function' ? o.onStart : null;
  const cbEnd = typeof o.onEnd === 'function' ? o.onEnd : null;
  const cbError = typeof o.onError === 'function' ? o.onError : null;

  // 同步失败一律只用 false 表达（不触发回调），避免与调用方的状态复位产生竞态。
  if (typeof text !== 'string' || !text.trim()) return false;
  if (!probe()) return false;

  // 长度保护：微信同声传译对超长文本合成会失败（单次请求有长度上限，过长直接走 fail），
  // 而首页朗读稿由多段文案拼成、长度不可控，所以统一截断到 300 字并在末尾补「……」，
  // 让老人听得出内容被缩短了，而不是莫名其妙只念半句。
  // 用 Array.from 按 Unicode 码点切，避免把 emoji / 生僻字的代理对切成半个字符。
  const clean = text.trim();
  const chars = Array.from(clean);
  const content = chars.length > MAX_LEN
    ? chars.slice(0, MAX_LEN).join('') + '……'
    : clean;

  // 播新的一句前先停掉旧的，两段声音不能叠在一起
  stop();
  const seq = _seq;  // stop() 已递增；本次请求认领当前序号，被 stop/新请求覆盖即作废

  try {
    _plugin.textToSpeech({
      lang: 'zh_CN',
      tts: true,
      content: content,
      success: (res) => {
        if (seq !== _seq) return;  // 已被停止或被新一句取代：丢弃过期音频
        const filename = res && res.filename;
        if (!filename) {
          if (cbError) cbError(new Error('textToSpeech: no filename'));
          if (cbEnd) cbEnd();
          return;
        }
        let audio = null;
        try {
          audio = wx.createInnerAudioContext();
          _audio = audio;
          audio.src = filename;
          audio.onEnded(() => {
            if (_audio !== audio) return;  // 不是当前那一段，不重复收尾
            stop();                        // stop() 内部 destroy() 并清引用
            if (cbEnd) cbEnd();
          });
          audio.onError((err) => {
            if (_audio !== audio) return;
            stop();
            if (cbError) cbError(err);
            if (cbEnd) cbEnd();            // 失败也是「播报结束」，调用方要能复位状态
          });
          audio.play();
          if (cbStart) cbStart();
        } catch (e) {
          _audio = null;
          try { if (audio) audio.destroy(); } catch (e2) { /* 忽略销毁异常 */ }
          if (cbError) cbError(e);
          if (cbEnd) cbEnd();
        }
      },
      fail: (err) => {
        if (seq !== _seq) return;
        if (cbError) cbError(err);
        if (cbEnd) cbEnd();
      },
    });
  } catch (e) {
    // textToSpeech 同步抛错（基础库过低 / 插件方法异常）：同样只返回 false
    return false;
  }
  return true;
}

module.exports = { available, speak, stop };

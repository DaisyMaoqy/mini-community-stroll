// utils/speech.js —— 语音播报（可降级实现）
//
// ⚠️ 小程序没有浏览器那种 window.speechSynthesis。真朗读依赖「微信同声传译」插件
// （插件名 WechatSI，provider appid wx069ba97219f66d99）：
//   plugin.textToSpeech({ lang, tts, content, success, fail }) → success 返回 res.filename
//   （临时语音文件路径，有效期为 3 小时，见 expired_time），还需用
//   wx.createInnerAudioContext() 自行播放，插件不负责播放。
//
// ⚠️ 官方文档的硬限制（2026-11 复核）：textToSpeech 的 content 【后台限制在 50 个字符内】，
//   超长直接 fail（-20002）。所以朗读稿总长超 50 字时必须【分段合成、顺序播放】——
//   见 _splitChunks()。配额：语音合成 100 次/分钟、2 万次/天；分 3~4 段播一条天气完全够用。
//
// 该插件必须由小程序管理员在微信公众平台后台添加（入口：登录 mp.weixin.qq.com →
// 左下角头像 →「账号设置」→「第三方设置」→「插件管理」→「添加插件」，搜「同声传译」）。
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
// 朗读稿【总长】上限：超长先截断补「……」，让老人听得出内容被缩短了。
// 用 Array.from 按 Unicode 码点切，避免把 emoji / 生僻字的代理对切成半个字符。
const MAX_TOTAL = 300;
// 单段上限：官方后台限制 content ≤ 50 字符，超长直接 fail（-20002）。
const MAX_LEN = 50;
// 分段数上限：50 × 12 = 600 > MAX_TOTAL，纯防御（总长 300 时实际最多 7 段）。
const MAX_CHUNKS = 12;

let _probed = false;   // 探测结果缓存，只探一次
let _plugin = null;    // 插件实例；null = 不可用
let _audio = null;     // 当前正在播放的那一段的 InnerAudioContext
let _session = null;   // 当前播报会话 { chunks:[], idx:number }；null = 空闲。
                       // 所有在途回调（合成 success/fail、onEnded/onError）都先比对
                       // 会话身份（_session === session），被 stop()/新 speak() 换掉后自动作废。

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

// 只销毁当前音频实例，不动会话身份（会话内部换段时用）。
function _destroyAudio() {
  const a = _audio;
  _audio = null;
  if (!a) return;
  try { a.stop(); } catch (e) { /* 忽略 */ }
  try { a.destroy(); } catch (e) { /* 忽略销毁异常；引用已清，不会再留可播放句柄 */ }
}

/**
 * 把朗读稿切成 ≤50 字的段。断点优先落在句读标点（。！？；，、）之后，
 * 找不到合适的标点才硬切 —— 硬切可能把词切一半，TTS 读起来会顿一下，
 * 但总比直接合成失败（整段没声音）好。
 * @param {string} text 已清洗、已截断到 MAX_TOTAL 的朗读稿
 * @returns {string[]}
 */
function _splitChunks(text) {
  const chars = Array.from(text);
  const out = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + MAX_LEN, chars.length);
    if (end < chars.length) {
      // 超长：从末尾往回找最近的句读标点，把断点挪到它后面
      for (let i = end - 1; i > start; i--) {
        if ('。！？；，、'.indexOf(chars[i]) >= 0) { end = i + 1; break; }
      }
    }
    out.push(chars.slice(start, end).join(''));
    start = end;
  }
  return out;
}

/**
 * 停止并销毁当前语音、清引用。可重复调用（无音频时是 no-op）。
 * 先把 _session 置 null：所有在途的 textToSpeech 回调与音频事件凭会话身份比对，
 * 从这一刻起全部作废 —— 不会出现「停止后下一段又冒出来」。
 * @returns {void}
 */
function stop() {
  _session = null;
  _destroyAudio();
}

/**
 * 朗读一段中文。长稿（>50 字）自动分段合成、按顺序无缝播放，调用方无感。
 * @param {string} text 待朗读文本；空字符串或非字符串直接返回 false
 * @param {{onStart?: Function, onEnd?: Function, onError?: Function}} [opts] 生命周期回调
 *   onStart：第一段真正开始播放时触发一次
 *   onEnd：全部段播完（或流程结束）时触发一次；onError 后也会触发，调用方要能复位
 * @returns {boolean} 是否成功发起第一段合成。注意 textToSpeech 是异步的，同步返回值
 *   只能表示「已成功发起请求」；真正开始播放以 onStart 为准；插件不可用 /
 *   参数非法 / 调用抛错返回 false。
 */
function speak(text, opts) {
  const o = opts || {};
  const cbStart = typeof o.onStart === 'function' ? o.onStart : null;
  const cbEnd = typeof o.onEnd === 'function' ? o.onEnd : null;
  const cbError = typeof o.onError === 'function' ? o.onError : null;

  // 同步失败一律只用 false 表达（不触发回调），避免与调用方的状态复位产生竞态。
  if (typeof text !== 'string' || !text.trim()) return false;
  if (!probe()) return false;

  // 总长保护：>300 字按码点截断补「……」（同 MAX_TOTAL 说明）。
  const chars = Array.from(text.trim());
  const total = chars.length > MAX_TOTAL ? chars.slice(0, MAX_TOTAL).join('') + '……' : text.trim();
  const chunks = _splitChunks(total).slice(0, MAX_CHUNKS);
  if (!chunks.length) return false;

  // 播新的一句前先停掉旧的，两段声音不能叠在一起；stop() 顺带作废旧会话。
  stop();
  const session = { chunks: chunks, idx: 0 };
  _session = session;
  const isLive = function () { return _session === session; };

  function fail(err) {
    if (!isLive()) return;
    _session = null;
    _destroyAudio();
    if (cbError) cbError(err);
    if (cbEnd) cbEnd();   // 失败也是「播报结束」，调用方要能复位状态
  }

  function next() {
    if (!isLive()) return true; // 已被停止/被新一句取代：不算失败
    const i = session.idx;
    try {
      _plugin.textToSpeech({
        lang: 'zh_CN',
        tts: true,
        content: session.chunks[i],
        success: function (res) {
          if (!isLive()) return;  // 在途合成被 stop() 作废：丢弃过期音频
          const filename = res && res.filename;
          if (!filename) { fail(new Error('textToSpeech: no filename')); return; }
          let audio = null;
          try {
            audio = wx.createInnerAudioContext();
            _audio = audio;
            audio.src = filename;
            audio.onEnded(function () {
              if (_audio !== audio || !isLive()) return; // 不是当前那一段，不重复收尾
              _destroyAudio();
              session.idx++;
              if (session.idx < session.chunks.length) {
                next();   // 上一段播完，接着合成下一段（段间有一次网络往返，听感是句间停顿）
              } else {
                _session = null;
                if (cbEnd) cbEnd();
              }
            });
            audio.onError(function (err) {
              if (_audio !== audio) return;
              fail(err);
            });
            audio.play();
            if (i === 0 && cbStart) cbStart();
          } catch (e) {
            _audio = null;
            try { if (audio) audio.destroy(); } catch (e2) { /* 忽略销毁异常 */ }
            fail(e);
          }
        },
        fail: function (err) {
          fail(err);
        },
      });
      return true;
    } catch (e) {
      // textToSpeech 同步抛错（基础库过低 / 插件方法异常）
      fail(e);
      return false;
    }
  }

  return next();
}

module.exports = { available, speak, stop };

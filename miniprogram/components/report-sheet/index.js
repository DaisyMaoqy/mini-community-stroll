// components/report-sheet/index.js —— POI 纠错上报底部弹层（地图 / 接种两页复用）
// 契约（架构设计_POI纠错闭环 §3.3）：
//   - 显隐受控：props `visible` 驱动；关闭时清空表单
//   - 表单自持：类型 / 说明 / 照片 / 坐标由组件内部持有，失败重试不丢内容
//   - 照片：先 wx.compressImage(quality≈70) 压缩 → wx.cloud.uploadFile 拿 fileID → 一次性 submit（§6.3）
//   - 成功后派发 `submitted`，关闭派发 `close`
const { callCloud } = require('../../utils/cloud.js');

// 存储值（enum）→ chip 显示文案 的固定映射（§3.4 / §8-4）：
// 库内存「信息有误」，chip 上显示「信息有误（地址·时间·类型）」。
const TYPE_LABELS = {
  '位置不准': '位置不准',
  '已关闭或不存在': '已关闭或不存在',
  '信息有误': '信息有误（地址·时间·类型）',
  '设施变化': '设施变化',
  '其他': '其他',
};

// 仅「位置不准」带定位开关（其余类型不采集坐标，隐私最小化）
const SUGGEST_TYPE = '位置不准';

// 生成上传的云存储路径：report/YYYY-MM-DD/时间戳_随机.ext
function dateStamp() {
  const d = new Date();
  const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function extOf(p) {
  const m = /\.([a-zA-Z0-9]+)(?:\?|$)/.exec(p || '');
  return m ? m[1] : 'jpg';
}
function cloudPathFor(filePath) {
  return 'report/' + dateStamp() + '/' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.' + extOf(filePath);
}

Component({
  properties: {
    // 受控显隐：true 打开，false 关闭并重置表单
    visible: {
      type: Boolean,
      value: false,
      observer: '_onVisibleChange',
    },
    spotId: { type: String, value: '' },
    spotName: { type: String, value: '' },
    // 类型枚举（存储值），预留扩展位
    typeOptions: {
      type: Array,
      value: ['位置不准', '已关闭或不存在', '信息有误', '设施变化', '其他'],
      observer: '_onTypeOptionsChange',
    },
    maxImages: { type: Number, value: 3 },
    maxContent: { type: Number, value: 200 },
    enableSuggestCoord: { type: Boolean, value: true },
  },

  data: {
    selectedType: '', // 当前选中类型（enum value）
    content: '', // 说明文本
    contentLen: 0, // 字数计数
    images: [], // [{ key, tempFilePath, fileID, uploading, failed }]
    suggestOn: false, // 「用我的定位」开关（默认关闭）
    suggestCoord: null, // 已取到的 gcj02 坐标 { lat, lng, cs }
    submitting: false, // 提交中（防重复点击 + 按钮 loading）
    uploading: false, // 照片上传中
    errorTip: '', // 内联校验/错误提示
    typeMeta: [], // [{ value, label }] 由 typeOptions 派生（WXML 不能调用函数）
    contentMax: 200, // maxContent 镜像（供 wxml 显示 n/200）
  },

  lifetimes: {
    attached() {
      this._buildTypeMeta();
    },
  },

  methods: {
    // ---- 派生数据 ----
    _buildTypeMeta() {
      const opts = this.data.typeOptions || [];
      const meta = opts.map(function (v) { return { value: v, label: TYPE_LABELS[v] || v }; });
      this.setData({ typeMeta: meta, contentMax: this.data.maxContent });
    },

    // ---- 受控显隐 ----
    _onVisibleChange(nv) {
      // 打开与关闭都重置表单，保证每次打开是干净状态（幂等，无副作用）
      this.resetForm();
    },
    _onTypeOptionsChange() {
      this._buildTypeMeta();
    },

    // ---- 类型选择 ----
    onSelectType(e) {
      if (this.data.submitting) return;
      const v = e.currentTarget.dataset.value;
      const next = this.data.selectedType === v ? '' : v; // 再点一次取消选择
      const patch = { selectedType: next, errorTip: '' };
      // 切离「位置不准」时关闭定位开关并清坐标（隐私最小化）
      if (next !== SUGGEST_TYPE) {
        patch.suggestOn = false;
        patch.suggestCoord = null;
      }
      this.setData(patch);
    },

    // ---- 说明输入（超长截断 + 计数）----
    onContentInput(e) {
      let v = (e.detail && e.detail.value) || '';
      const max = this.data.maxContent;
      if (v.length > max) v = v.slice(0, max);
      this.setData({ content: v, contentLen: v.length });
    },

    // ---- 照片：选择 ----
    onChooseImage() {
      if (this.data.submitting || this.data.uploading) return;
      const remain = this.data.maxImages - this.data.images.length;
      if (remain <= 0) {
        wx.showToast({ title: '最多上传 ' + this.data.maxImages + ' 张照片', icon: 'none' });
        return;
      }
      const self = this;
      wx.chooseMedia({
        count: remain,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success(res) {
          const files = (res.tempFiles || []).map(function (f) { return f.tempFilePath; }).filter(Boolean);
          if (!files.length) return;
          const base = self.data.images.length;
          const stamp = Date.now();
          const entries = files.map(function (p, i) {
            return {
              key: 'img_' + stamp + '_' + (base + i),
              tempFilePath: p,
              fileID: '',
              uploading: true,
              failed: false,
            };
          });
          self.setData({ images: self.data.images.concat(entries), uploading: true });
          // 逐张压缩后上传（各自独立回调，互不阻塞）
          entries.forEach(function (ent) {
            self._uploadOne(ent.key, ent.tempFilePath);
          });
        },
        fail() {
          // 用户取消选择：静默
        },
      });
    },

    // 压缩 → 上传单张；成功写 fileID，失败标记 failed（保留条目供重试）
    // 返回 Promise（供重传分支 Promise.all 收口 + busy 闩释放）
    _uploadOne(key, path) {
      const self = this;
      return self._compress(path)
        .then(function (src) { return self._uploadToCloud(src); })
        .then(function (fileID) {
          self._patchImage(key, { fileID: fileID, uploading: false, failed: false });
          self._refreshUploading();
        })
        .catch(function () {
          self._patchImage(key, { uploading: false, failed: true });
          self._refreshUploading();
          wx.showToast({ title: '照片上传失败，请重试', icon: 'none' });
        });
    },

    // 压缩（quality≈70）；压缩失败退回原图，不阻断
    _compress(src) {
      return new Promise(function (resolve) {
        wx.compressImage({
          src: src,
          quality: 70,
          success(res) { resolve((res && res.tempFilePath) || src); },
          fail() { resolve(src); },
        });
      });
    },

    // 上传到云存储，resolve fileID
    _uploadToCloud(filePath) {
      return new Promise(function (resolve, reject) {
        wx.cloud.uploadFile({
          cloudPath: cloudPathFor(filePath),
          filePath: filePath,
          success(res) { resolve(res.fileID); },
          fail(err) { reject(err); },
        });
      });
    },

    // 按 key 局部更新某张图的状态
    _patchImage(key, patch) {
      const images = this.data.images.map(function (it) {
        return it.key === key ? Object.assign({}, it, patch) : it;
      });
      this.setData({ images: images });
    },

    // 依据是否仍有图在上传，同步 uploading 标志
    _refreshUploading() {
      const any = this.data.images.some(function (it) { return it.uploading; });
      if (any !== this.data.uploading) this.setData({ uploading: any });
    },

    // ---- 照片：预览 ----
    onPreviewImage(e) {
      const idx = e.currentTarget.dataset.idx;
      const urls = this.data.images
        .map(function (it) { return it.fileID || it.tempFilePath; })
        .filter(Boolean);
      if (!urls.length) return;
      const cur = this.data.images[idx];
      const current = (cur && (cur.fileID || cur.tempFilePath)) || urls[0];
      wx.previewImage({ urls: urls, current: current });
    },

    // ---- 照片：删除单张 ----
    onRemoveImage(e) {
      if (this.data.submitting) return;
      const idx = e.currentTarget.dataset.idx;
      const images = this.data.images.slice();
      images.splice(idx, 1);
      this.setData({ images: images });
      this._refreshUploading();
    },

    // ---- 定位开关（仅「位置不准」显示，默认关闭）----
    onToggleSuggest(e) {
      if (this.data.submitting) return;
      const on = !!(e.detail && e.detail.value);
      if (!on) {
        this.setData({ suggestOn: false, suggestCoord: null });
        return;
      }
      const self = this;
      wx.getLocation({
        type: 'gcj02',
        success(res) {
          self.setData({
            suggestOn: true,
            suggestCoord: { lat: res.latitude, lng: res.longitude, cs: 'gcj02' },
          });
        },
        fail() {
          // 授权失败 / 取不到：开关回弹为关闭，不写入坐标
          self.setData({ suggestOn: false, suggestCoord: null });
          wx.showToast({ title: '定位获取失败，请检查授权', icon: 'none' });
        },
      });
    },

    // ---- 提交 ----
    // 实例级同步闩 _busy：onSubmit 全程（含照片重传分支）只允许一次在途调用，
    // 防止重传分支未置 submitting 时快速连点对同一 failed 图并发重复上传（P2-1）。
    // 注：_busy 在「本次异步流程 settle 后」才释放，不能用同步 finally（那会在异步返回前就解锁）。
    onSubmit() {
      if (this._busy) return;
      this._busy = true;
      const release = () => { this._busy = false; };

      if (this.data.submitting) { release(); return; }

      // ① 未选类型 → 内联提示，不发起任何请求
      if (!this.data.selectedType) {
        this.setData({ errorTip: '请先选择反馈类型' });
        release();
        return;
      }
      // 防御：无目标 POI 不提交
      if (!this.data.spotId) {
        this.setData({ errorTip: '地点信息缺失，请重试' });
        release();
        return;
      }
      // ② 仍有图在上传中 → 阻断
      if (this.data.uploading) {
        wx.showToast({ title: '照片上传中，请稍候', icon: 'none' });
        release();
        return;
      }
      // ③ 有失败图 → 重传失败的（§6.3 只补失败的），本次阻断
      const failed = this.data.images.filter(function (it) { return it.failed; });
      if (failed.length) {
        const self = this;
        // 同步把失败项标记为「上传中」，避免闩释放前的窗口期内被并发重复触发
        const images = this.data.images.map(function (it) {
          return it.failed ? Object.assign({}, it, { uploading: true, failed: false }) : it;
        });
        this.setData({ images: images, uploading: true });
        const tasks = failed.map(function (it) { return self._uploadOne(it.key, it.tempFilePath); });
        Promise.all(tasks).then(release, release);
        wx.showToast({ title: '照片上传中，请稍候', icon: 'none' });
        return;
      }

      const payload = {
        action: 'submit',
        spotId: this.data.spotId,
        spotName: this.data.spotName,
        type: this.data.selectedType,
        content: this.data.content,
        images: this.data.images.filter(function (it) { return it.fileID; }).map(function (it) { return it.fileID; }),
        suggestCoord: (this.data.selectedType === SUGGEST_TYPE && this.data.suggestOn) ? this.data.suggestCoord : null,
      };

      this.setData({ submitting: true, errorTip: '' });
      const self = this;
      callCloud('reports', payload)
        .then(function (res) {
          const _id = res && res._id;
          wx.showToast({ title: '已提交，感谢反馈', icon: 'none' });
          self.resetForm(); // 成功后重置表单
          self.triggerEvent('submitted', { _id: _id });
          release();
        })
        .catch(function (err) {
          // 失败不清空已填内容，便于重试
          self.setData({ submitting: false });
          const code = err && err.code;
          let msg = (err && err.message) || '提交失败，请重试';
          if (code === 'RATE_LIMITED') msg = '今日反馈次数已达上限';
          else if (code === 'INVALID_TYPE') msg = '请先选择反馈类型';
          wx.showToast({ title: msg, icon: 'none' });
          self.triggerEvent('error', { code: code || '', message: msg });
          release();
        });
    },

    // ---- 重置全部表单态 ----
    resetForm() {
      this.setData({
        selectedType: '',
        content: '',
        contentLen: 0,
        images: [],
        suggestOn: false,
        suggestCoord: null,
        submitting: false,
        uploading: false,
        errorTip: '',
      });
    },

    // ---- 关闭（点 ✕ / 点遮罩）----
    onClose() {
      if (this.data.submitting) return; // 提交中不响应关闭，避免状态错乱
      this.triggerEvent('close', {});
    },

    // catchtouchmove 占位：锁背景滚动
    noop() {},
  },
});

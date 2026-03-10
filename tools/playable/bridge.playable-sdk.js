(function (global) {
  // 统一对外 API
  const PlayableSDK = {
    channel: (global.__CHANNEL__ || 'unknown') + '',
    isReady: false,
    ready() {
      // 部分渠道要求等 mraid ready
      tryMraidReady(() => {
        this.isReady = true;
        this.track('ready');
      });
    },
    // url: 商店链接（可选）。如果渠道要求 clickTag，则可在 html 里注入 window.clickTag
    open(url) {
      const target = url || global.clickTag || global.ClickTag || global.__CLICK_URL__ || '';
      this.track('cta');
      // 1) MRAID（很多聚合渠道/广告 SDK 使用）
      if (global.mraid && typeof global.mraid.open === 'function') {
        try { global.mraid.open(target); return true; } catch (e) {}
      }
      // 2) Google ExitApi（Google Ads playable 常见）
      // 常见形态：ExitApi.exit() 或 ExitApi.exit(url)
      if (global.ExitApi && typeof global.ExitApi.exit === 'function') {
        try {
          // 有的只允许 exit()，有的允许 exit(url)
          if (target) { global.ExitApi.exit(target); }
          else { global.ExitApi.exit(); }
          return true;
        } catch (e) {}
      }
      // 3) Facebook/Meta（历史上常见 clickTag / 以及 playable 事件对象）
      // 这里做最宽松兜底：优先 window.open
      // 若你的 Meta 模板有 FbPlayableAd 对象，后续再补精确 API
      if (global.FbPlayableAd) {
        // 尝试常见方法名（不同版本/模板差异大）
        const cand = ['onCTAClick', 'cta', 'click', 'open', 'openStore', 'openUrl', 'openURL'];
        for (const fn of cand) {
          try {
            if (typeof global.FbPlayableAd[fn] === 'function') {
              global.FbPlayableAd[fn](target);
              return true;
            }
          } catch (e) {}
        }
      }
      // 4) TikTok（常见：可用 clickTag 或 postMessage 给宿主）
      // 先做 postMessage 尝试
      try {
        if (global.parent && global.parent !== global) {
          global.parent.postMessage({ type: 'open', url: target }, '*');
        }
      } catch (e) {}
      // 5) 终极兜底：window.open（有些 WebView 会拦截弹窗，审核不一定过）
      try {
        global.open(target || 'https://example.com', '_blank');
        return true;
      } catch (e) {}
      return false;
    },
    // name: 'start' | 'progress' | 'complete' | 'cta' | ...
    track(name, data) {
      const evt = String(name || '');
      const payload = data == null ? {} : data;
      // MRAID：常见是 mraid.trackEvent / mraid.fireEvent（实现不统一）
      if (global.mraid) {
        try {
          if (typeof global.mraid.trackEvent === 'function') global.mraid.trackEvent(evt, payload);
        } catch (e) {}
        // 一些实现可能通过 setExpandProperties/其他，不强求
      }
      // Google：部分模板会有 gtag / 或者自定义 reporter
      // 这里不强依赖
      // Meta：尝试 FbPlayableAd 的事件上报（名称不统一，尽量探测）
      if (global.FbPlayableAd) {
        const cand = ['logEvent', 'track', 'trackEvent', 'sendEvent', 'reportEvent'];
        for (const fn of cand) {
          try {
            if (typeof global.FbPlayableAd[fn] === 'function') {
              global.FbPlayableAd[fn](evt, payload);
              break;
            }
          } catch (e) {}
        }
      }
      // 通用 postMessage（一些宿主用 message 采集）
      try {
        if (global.parent && global.parent !== global) {
          global.parent.postMessage({ type: 'track', event: evt, data: payload }, '*');
        }
      } catch (e) {}
      // 控制台（本地调试）
      if (!global.__PLAYABLE_SILENT_LOG__) {
        try { console.log('[PlayableSDK.track]', evt, payload); } catch (e) {}
      }
    },
    // 常见需求：静音控制（Playable 通常默认静音，用户点击后再打开）
    setMuted(muted) {
      this.track(muted ? 'mute' : 'unmute');
      global.__PLAYABLE_MUTED__ = !!muted;
      // 这里不直接操作 Cocos Audio，由你在游戏侧监听该变量或直接调用引擎 API
    }
  };
  function tryMraidReady(cb) {
    const m = global.mraid;
    if (!m) return cb();
    try {
      if (typeof m.getState === 'function') {
        const st = m.getState();
        if (st === 'loading' && typeof m.addEventListener === 'function') {
          m.addEventListener('ready', function onReady() {
            try { m.removeEventListener && m.removeEventListener('ready', onReady); } catch (e) {}
            cb();
          });
          return;
        }
      }
    } catch (e) {}
    cb();
  }
  global.PlayableSDK = PlayableSDK;
})(window);
(function () {
  if (window.__MOEKOE_LIKE_INJECTED__) return;
  window.__MOEKOE_LIKE_INJECTED__ = true;

  // ── 1. localStorage.setItem 劫持 ──
  // 检测歌曲切换和认证变化

  var _prevSetItem = localStorage.setItem.bind(localStorage);

  localStorage.setItem = function (key, value) {
    _prevSetItem(key, value);

    if (key === 'current_song') {
      try {
        var song = JSON.parse(value);
        var hash = song && (song.hash || song.playHash || '');
        if (hash) {
          document.dispatchEvent(new CustomEvent('moekoe-song-change', {
            detail: { hash: hash }
          }));
        }
      } catch (e) {}
    }

    if (key === 'MoeData') {
      try {
        var data = JSON.parse(value);
        var authenticated = !!(data && data.UserInfo && data.UserInfo.token);
        document.dispatchEvent(new CustomEvent('moekoe-auth-change', {
          detail: { authenticated: authenticated }
        }));
      } catch (e) {}
    }
  };

  // ── 2. XMLHttpRequest 拦截 ──
  // 检测"我喜欢"歌单的收藏变更：add 派发增量信号，del 派发全量刷新信号

  var _origOpen = XMLHttpRequest.prototype.open;
  var _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._moekoeUrl = (url || '').toString();
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var url = xhr._moekoeUrl || '';

    var action = parseLikeAction(url);
    if (action) {
      xhr.addEventListener('load', function () {
        try {
          var resp = JSON.parse(xhr.responseText);
          if (resp.status !== 1) return;
          dispatchLikeAction(action);
        } catch (e) {}
      });
    }

    // 拦截 /privilege/lite 响应：提取当前歌曲所有音质 hash，供 content.js 跨音质匹配收藏
    if (isPrivilegeUrl(url)) {
      xhr.addEventListener('load', function () {
        try {
          var resp = JSON.parse(xhr.responseText);
          var hashes = extractPrivilegeHashes(resp);
          if (hashes && hashes.length) {
            dispatchPrivilegeInfo(hashes);
          }
        } catch (e) {}
      });
    }

    return _origSend.apply(this, arguments);
  };

  // ── 2b. fetch API 拦截 ──
  // 防御性拦截：若改用 fetch，仍能感知收藏变更

  var _origFetch = window.fetch;

  window.fetch = function (input, init) {
    var url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
    }

    var action = parseLikeAction(url);
    var promise = _origFetch.apply(this, arguments);

    if (action) {
      promise.then(function (response) {
        if (!response.ok) return response;
        var cloned = response.clone();
        cloned.json().then(function (resp) {
          if (resp.status !== 1) return;
          dispatchLikeAction(action);
        }).catch(function () {});
        return response;
      }).catch(function () {});
    }

    // 拦截 /privilege/lite 响应（fetch 版本）
    if (isPrivilegeUrl(url)) {
      promise.then(function (response) {
        if (!response.ok) return response;
        var cloned = response.clone();
        cloned.json().then(function (resp) {
          var hashes = extractPrivilegeHashes(resp);
          if (hashes && hashes.length) {
            dispatchPrivilegeInfo(hashes);
          }
        }).catch(function () {});
        return response;
      }).catch(function () {});
    }

    return promise;
  };

  // ── 辅助：解析"我喜欢"歌单的收藏操作 ──
  // 只有 listid === localStorage['like'] 的请求才视为"我喜欢"歌单操作
  // add: 从 data 参数解析 hash 列表（格式 name|hash,name|hash）
  // del: 无法从 fileids 反查 hash，返回 del 类型由 content.js 全量刷新

  function parseLikeAction(url) {
    if (!url) return null;
    var isAdd = url.indexOf('/playlist/tracks/add') !== -1;
    var isDel = url.indexOf('/playlist/tracks/del') !== -1;
    if (!isAdd && !isDel) return null;

    var likeId = localStorage.getItem('like');
    if (!likeId) return null;

    try {
      var fullUrl = new URL(url, location.origin);
      var listid = fullUrl.searchParams.get('listid');
      if (listid !== likeId) return null;

      if (isAdd) {
        var data = fullUrl.searchParams.get('data') || '';
        var hashes = data.split(',').map(function (item) {
          var idx = item.lastIndexOf('|');
          return idx >= 0 ? item.substring(idx + 1) : '';
        }).filter(Boolean);
        return { type: 'add', hashes: hashes };
      }
      return { type: 'del' };
    } catch (e) {
      return null;
    }
  }

  function dispatchLikeAction(action) {
    if (action.type === 'add') {
      document.dispatchEvent(new CustomEvent('moekoe-like-add', {
        detail: { hashes: action.hashes }
      }));
    } else {
      document.dispatchEvent(new CustomEvent('moekoe-like-refresh', {
        detail: { action: 'del' }
      }));
    }
  }

  // ── 辅助：拦截 /privilege/lite 响应，提取所有音质 hash ──
  // 主程序播放歌曲时调 /privilege/lite 获取各音质权限，响应含同一首歌所有音质的 hash
  // 派发给 content.js，用于跨音质匹配收藏（搜索播放用高音质 hash，收藏列表用标准 hash）

  function isPrivilegeUrl(url) {
    return url && url.indexOf('/privilege/lite') !== -1;
  }

  function extractPrivilegeHashes(resp) {
    if (!resp || !resp.data || !Array.isArray(resp.data)) return null;
    var hashes = [];
    for (var i = 0; i < resp.data.length; i++) {
      var item = resp.data[i];
      if (item && item.hash) {
        hashes.push(item.hash);
      }
      if (item && Array.isArray(item.relate_goods)) {
        for (var j = 0; j < item.relate_goods.length; j++) {
          var variant = item.relate_goods[j];
          if (variant && variant.hash) {
            hashes.push(variant.hash);
          }
        }
      }
    }
    return hashes;
  }

  function dispatchPrivilegeInfo(hashes) {
    document.dispatchEvent(new CustomEvent('moekoe-privilege-info', {
      detail: { hashes: hashes }
    }));
  }

  // ── 3. 启动时通知当前歌曲 ──

  try {
    var raw = localStorage.getItem('current_song');
    if (raw) {
      var song = JSON.parse(raw);
      var hash = song && (song.hash || song.playHash || '');
      if (hash) {
        document.dispatchEvent(new CustomEvent('moekoe-song-change', {
          detail: { hash: hash }
        }));
      }
    }
  } catch (e) {}

  // ── 4. 清理函数 ──

  window.__MOEKOE_LIKE_CLEANUP__ = function () {
    localStorage.setItem = _prevSetItem;
    XMLHttpRequest.prototype.open = _origOpen;
    XMLHttpRequest.prototype.send = _origSend;
    window.fetch = _origFetch;
    delete window.__MOEKOE_LIKE_CLEANUP__;
    delete window.__MOEKOE_LIKE_INJECTED__;
  };
})();

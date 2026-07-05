(function () {
  'use strict';

  if (window.__MOEKOE_LIKE_INDICATOR__) return;
  window.__MOEKOE_LIKE_INDICATOR__ = true;

  var P = '[LikeIndicator]';
  var DEFAULT_API_BASE = 'http://127.0.0.1:6521';
  var DEBUG = localStorage.getItem('moekoe_like_debug') === 'true';
  var CACHE_TTL = 3600000;         // 缓存有效期 1 小时（增量更新维护，无需频繁全量）
  var POLL_INTERVAL = 5000;         // 降级轮询间隔 5 秒
  var INIT_DELAY = 1500;            // 初始化延迟
  var API_TIMEOUT = 10000;          // API 请求超时 10 秒
  var DEBOUNCE_DELAY = 500;         // 收藏变更防抖 500ms
  var MAX_PAGES = 100;              // 分页拉取最大页数
  var MAX_RETRIES = 3;              // fetchLikedSongs 最大重试次数
  var RETRY_DELAY = 5000;           // 重试间隔

  var likedHashes = new Set();
  var currentSongHash = '';
  var crossMatchedHash = '';    // 跨音质匹配命中的歌曲 hash（当前 hash 不在收藏列表，但同歌其他音质在）
  var likePlaylistId = '';      // listid 字段（新接口 /playlist/track/all/new 用）
  var likePlaylistGcid = '';    // global_collection_id 字段（老接口 /playlist/track/all 用，与主程序对齐）
  var crossMatchRequestId = 0;  // 跨音质匹配请求 ID（竞态保护，快速切歌时忽略旧请求结果）
  var isLoading = false;
  var domObserver = null;
  var rafPending = false;
  var pollTimer = null;
  var mainWorldActive = false;
  var debounceTimer = null;
  var retryCount = 0;
  var cleanupFns = [];

  function log() {
    if (!DEBUG) return;
    console.log.apply(console, [P].concat(Array.prototype.slice.call(arguments)));
  }

  function warn() {
    console.warn.apply(console, [P].concat(Array.prototype.slice.call(arguments)));
  }

  // ── 工具函数 ──

  function getApiBaseUrl() {
    try {
      var raw = localStorage.getItem('settings');
      if (raw) {
        var settings = JSON.parse(raw);
        var url = settings.apiBaseUrl;
        var custom = (url || '').toString().trim().replace(/\/+$/, '');
        if (custom && /^https?:\/\//.test(custom)) return custom;
      }
    } catch (e) {}
    return DEFAULT_API_BASE;
  }

  function getAuthHeaders() {
    try {
      var moeData = JSON.parse(localStorage.getItem('MoeData') || '{}');
      var user = moeData.UserInfo || {};
      var device = moeData.Device || {};
      var parts = [];
      if (user.token) parts.push('token=' + user.token);
      if (user.userid) parts.push('userid=' + user.userid);
      if (device.dfid) parts.push('dfid=' + device.dfid);
      if (user.t1) parts.push('t1=' + user.t1);
      if (device.mid) parts.push('KUGOU_API_MID=' + device.mid);
      if (device.guid) parts.push('KUGOU_API_GUID=' + device.guid);
      if (device.serverDev) parts.push('KUGOU_API_DEV=' + device.serverDev);
      if (device.mac) parts.push('KUGOU_API_MAC=' + device.mac);
      return parts.length > 0 ? { Authorization: parts.join(';') } : {};
    } catch (e) {
      return {};
    }
  }

  function isAuthenticated() {
    return !!getAuthHeaders().Authorization;
  }

  function getCurrentSongHash() {
    try {
      var raw = localStorage.getItem('current_song');
      if (!raw) return '';
      var song = JSON.parse(raw);
      return song.hash || song.playHash || '';
    } catch (e) {
      return '';
    }
  }

  // ── API 请求（带超时） ──

  async function apiGet(path, params) {
    var baseUrl = getApiBaseUrl();
    var url = new URL(path, baseUrl);
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
          url.searchParams.set(k, params[k]);
        }
      });
    }
    var headers = Object.assign({}, getAuthHeaders());

    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, API_TIMEOUT);

    try {
      var response = await fetch(url.toString(), {
        headers: headers,
        credentials: 'include',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' ' + response.statusText);
      }

      var data = await response.json();

      if (data.status !== undefined && data.status !== 1) {
        throw new Error('API status=' + data.status);
      }

      return data;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  // ── 收藏歌单信息 ──
  // 始终调 /user/playlist 提取 global_collection_id，用于老接口拉取收藏歌曲 hash

  var LIKE_NAMES = ['我喜欢', '我喜歡', 'My Favorites', 'お気に入り', '좋아요', 'Избранное'];

  async function fetchLikePlaylistInfo() {
    // 始终调 /user/playlist 获取"我喜欢"歌单对象，提取 global_collection_id
    // 必须用 global_collection_id 调老接口 /playlist/track/all，才能与主程序播放时用的 hash 对齐
    // （主程序 PlaylistDetail.vue 用 route.query.global_collection_id 调老接口）
    var data = await apiGet('/user/playlist', { pagesize: 500 });

    if (!data.data || !data.data.info) {
      warn('歌单列表数据为空');
      return;
    }

    var likedPlaylist = null;

    // 优先用 localStorage['like']（主程序维护的 listid）匹配歌单对象
    var storedLike = localStorage.getItem('like');
    if (storedLike) {
      for (var i = 0; i < data.data.info.length; i++) {
        if (data.data.info[i].listid === storedLike) {
          likedPlaylist = data.data.info[i];
          break;
        }
      }
    }

    // 回退：用已存储的 ID 匹配
    if (!likedPlaylist) {
      var storedId = localStorage.getItem('moekoe_like_playlist_id');
      if (storedId) {
        for (var j = 0; j < data.data.info.length; j++) {
          if (data.data.info[j].listid === storedId) {
            likedPlaylist = data.data.info[j];
            break;
          }
        }
      }
    }

    // 回退：按名称匹配
    if (!likedPlaylist) {
      for (var k = 0; k < data.data.info.length; k++) {
        if (LIKE_NAMES.indexOf(data.data.info[k].name) !== -1) {
          likedPlaylist = data.data.info[k];
          break;
        }
      }
    }

    if (likedPlaylist) {
      // 与 SidebarNavigation.vue 一致：global_collection_id = list_create_gid || global_collection_id
      likePlaylistGcid = likedPlaylist.list_create_gid || likedPlaylist.global_collection_id || '';
      likePlaylistId = likedPlaylist.listid || '';

      if (likePlaylistId) {
        localStorage.setItem('moekoe_like_playlist_id', likePlaylistId);
      }

      if (likePlaylistGcid) {
        log('找到收藏歌单, global_collection_id:', likePlaylistGcid, '| listid:', likePlaylistId);
      } else if (likePlaylistId) {
        warn('收藏歌单缺少 global_collection_id，将回退用 listid + 新接口:', likePlaylistId);
      } else {
        warn('收藏歌单缺少 listid 和 global_collection_id');
      }
    } else {
      warn('未找到收藏歌单');
    }
  }

  // ── 全量拉取收藏歌曲（含重试） ──
  // 拆分为外层守卫 + 内层重试，重试期间保持 isLoading=true 阻止并发

  async function fetchLikedSongs() {
    if (isLoading) return;
    if (!isAuthenticated()) {
      log('未登录，跳过');
      return;
    }
    isLoading = true;

    try {
      await fetchLikedSongsWithRetry();
    } finally {
      isLoading = false;
    }
  }

  async function fetchLikedSongsWithRetry() {
    while (true) {
      try {
        await fetchLikePlaylistInfo();

        if (!likePlaylistGcid && !likePlaylistId) {
          warn('无法获取收藏歌单 ID，跳过拉取');
          retryCount = 0;
          return;
        }

        var allHashes = new Set();
        var page = 1;
        var pageSize = 300;
        var hasMore = true;

        while (hasMore && page <= MAX_PAGES) {
          var data;
          if (likePlaylistGcid) {
            // 优先用老接口 + global_collection_id（与主程序 PlaylistDetail.vue 一致）
            // 不同后端返回的 hash 可能不同，必须与主程序用同一接口才能 hash 对齐
            data = await apiGet('/playlist/track/all', {
              id: likePlaylistGcid,
              page: page,
              pagesize: pageSize
            });
          } else {
            // 回退：新接口 + listid（收藏歌单缺少 global_collection_id 时）
            data = await apiGet('/playlist/track/all/new', {
              listid: likePlaylistId,
              page: page,
              pagesize: pageSize
            });
          }

          var songs = data.data.songs || data.data.info || [];
          if (!Array.isArray(songs)) songs = [];

          songs.forEach(function (song) {
            if (song.hash) allHashes.add(song.hash);
          });

          log('第', page, '页,', songs.length, '首');

          if (songs.length < pageSize) {
            hasMore = false;
          } else {
            var totalCount = (data.data.list_info && data.data.list_info.count) || 0;
            if (totalCount > 0 && page * pageSize >= totalCount) {
              hasMore = false;
            } else {
              page++;
            }
          }
        }

        if (page > MAX_PAGES) {
          warn('分页超过最大限制', MAX_PAGES);
        }

        likedHashes = allHashes;
        retryCount = 0;
        log('共', likedHashes.size, '首收藏歌曲');

        persistLikedHashes();
        updateHeartButton();
        // 收藏列表加载完成前可能已切歌，此时 crossMatchByPrivilege 因 likedHashes 为空未命中
        // 加载完成后若当前歌曲仍未直接命中收藏，重新触发跨音质匹配
        if (currentSongHash && !likedHashes.has(currentSongHash) && !crossMatchedHash) {
          crossMatchByPrivilege(currentSongHash);
        }
        return;
      } catch (e) {
        warn('获取收藏歌曲失败:', e.message);
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          warn('重试', retryCount, '/', MAX_RETRIES, '（保持 isLoading 阻止并发）');
          await new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAY); });
          // 继续循环重试
        } else {
          warn('重试次数已达上限，停止重试');
          retryCount = 0;
          return;
        }
      }
    }
  }

  // ── 缓存加载与持久化 ──

  function loadCachedHashes() {
    try {
      var cached = localStorage.getItem('moekoe_liked_hashes_v2');
      var cachedTime = parseInt(localStorage.getItem('moekoe_liked_hashes_v2_time') || '0');
      if (cached && Date.now() - cachedTime < CACHE_TTL) {
        likedHashes = new Set(JSON.parse(cached));
        log('从缓存加载', likedHashes.size, '首');
        return true;
      }
    } catch (e) {}
    return false;
  }

  function persistLikedHashes() {
    try {
      localStorage.setItem('moekoe_liked_hashes_v2', JSON.stringify(Array.from(likedHashes)));
      localStorage.setItem('moekoe_liked_hashes_v2_time', Date.now().toString());
    } catch (e) {}
  }

  // ── 防抖全量刷新（用于 del 场景，del 请求只有 fileid 无法增量） ──

  function invalidateAndRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      fetchLikedSongs();
    }, DEBOUNCE_DELAY);
  }

  // ── 增量添加（用于 add 场景，来自 injected.js 对"我喜欢"歌单 add 请求的拦截） ──

  function addLikedHashes(hashes) {
    if (!hashes || !hashes.length) return;
    var changed = false;
    var affectsCurrent = false;
    hashes.forEach(function (h) {
      if (!likedHashes.has(h)) {
        likedHashes.add(h);
        changed = true;
      }
      if (h === currentSongHash) affectsCurrent = true;
    });
    if (changed) {
      persistLikedHashes();
      log('增量添加', hashes.length, '首，总计', likedHashes.size);
    }
    if (affectsCurrent) {
      updateHeartButton();
    }
  }

  // ── UI 更新 ──
  // 只 toggle moekoe-liked 类，颜色由 styles.css 的 var(--primary-color) 控制

  function updateHeartButton() {
    var isLiked = currentSongHash && (likedHashes.has(currentSongHash) || crossMatchedHash === currentSongHash);
    log('更新红心:', isLiked ? '已收藏' : '未收藏', '| hash:', currentSongHash ? currentSongHash.substring(0, 8) + '...' : '(空)', '| 收藏数:', likedHashes.size, crossMatchedHash === currentSongHash ? '| 跨音质匹配' : '');

    // 播放栏红心
    var extraBtns = document.querySelectorAll('.extra-controls .extra-btn');
    extraBtns.forEach(function (btn) {
      if (btn.querySelector('.fa-heart')) {
        btn.classList.toggle('moekoe-liked', isLiked);
      }
    });

    // 全屏歌词页红心
    var likeBtns = document.querySelectorAll('.player-controls .like-btn');
    likeBtns.forEach(function (btn) {
      btn.classList.toggle('moekoe-liked', isLiked);
    });
  }

  // ── 歌曲切换处理 ──

  function onSongChange(hash) {
    if (hash === currentSongHash) return;
    currentSongHash = hash;
    crossMatchedHash = '';  // 切歌时重置跨音质匹配，等新歌曲的 privilege/lite 返回后重新判定
    log('歌曲切换:', hash ? hash.substring(0, 8) + '...' : '(无)');
    updateHeartButton();
    // 如果当前 hash 不在收藏列表，主动调 /privilege/lite 跨音质匹配
    // 解决搜索/排行榜等场景播放高音质版本时，hash 与收藏列表标准音质 hash 不一致
    if (hash && !likedHashes.has(hash) && isAuthenticated()) {
      crossMatchByPrivilege(hash);
    }
  }

  // 主动调 /privilege/lite API 跨音质匹配
  // /privilege/lite 返回同一首歌所有音质（128/320/flac/high 等）的 hash
  // 若任意音质 hash 在收藏列表中，则当前歌曲视为已收藏
  function crossMatchByPrivilege(hash) {
    var requestId = ++crossMatchRequestId;
    apiGet('/privilege/lite', { hash: hash }).then(function (resp) {
      // 竞态保护：快速切歌时忽略旧请求结果
      if (requestId !== crossMatchRequestId) return;
      if (currentSongHash !== hash) return;
      if (!resp || !resp.data || !Array.isArray(resp.data)) return;
      // 当前 hash 已直接命中收藏列表时无需跨音质匹配
      if (likedHashes.has(hash)) return;
      // 提取所有音质 hash：data[].hash + data[].relate_goods[].hash
      var allHashes = [];
      for (var i = 0; i < resp.data.length; i++) {
        var item = resp.data[i];
        if (item && item.hash) allHashes.push(item.hash);
        if (item && Array.isArray(item.relate_goods)) {
          for (var j = 0; j < item.relate_goods.length; j++) {
            var variant = item.relate_goods[j];
            if (variant && variant.hash) allHashes.push(variant.hash);
          }
        }
      }
      log('/privilege/lite 返回', allHashes.length, '个音质 hash');
      // 检查是否有任意音质 hash 在收藏列表中
      var matched = false;
      for (var k = 0; k < allHashes.length; k++) {
        if (likedHashes.has(allHashes[k])) {
          matched = true;
          break;
        }
      }
      if (matched) {
        crossMatchedHash = hash;
        log('跨音质匹配命中（主动调 API）');
        updateHeartButton();
      } else {
        log('跨音质匹配未命中');
      }
    }).catch(function (e) {
      if (requestId === crossMatchRequestId) {
        log('/privilege/lite 请求失败:', e.message);
      }
    });
  }

  // ── 主世界脚本注入 ──

  function tryInjectMainWorldScript() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return;

    var script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = function () {
      log('主世界脚本加载成功');
      script.remove();
    };
    script.onerror = function () {
      log('主世界脚本加载失败，将使用降级轮询');
      script.remove();
      startFallbackPolling();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // ── 事件监听 ──

  function setupCustomEventListener() {
    // 歌曲切换
    var songHandler = function (e) {
      mainWorldActive = true;
      if (e.detail && e.detail.hash) {
        onSongChange(e.detail.hash);
      }
    };
    document.addEventListener('moekoe-song-change', songHandler);
    cleanupFns.push(function () {
      document.removeEventListener('moekoe-song-change', songHandler);
    });

    // 增量添加收藏（add 场景，injected.js 拦截"我喜欢"歌单 add 请求后派发）
    var addHandler = function (e) {
      mainWorldActive = true;
      if (e.detail && e.detail.hashes) {
        log('收到增量添加信号:', e.detail.hashes.length, '首');
        addLikedHashes(e.detail.hashes);
      }
    };
    document.addEventListener('moekoe-like-add', addHandler);
    cleanupFns.push(function () {
      document.removeEventListener('moekoe-like-add', addHandler);
    });

    // 全量刷新（del 场景，del 请求只有 fileid 无法增量）
    var refreshHandler = function () {
      mainWorldActive = true;
      log('收到全量刷新信号（del 场景）');
      invalidateAndRefresh();
    };
    document.addEventListener('moekoe-like-refresh', refreshHandler);
    cleanupFns.push(function () {
      document.removeEventListener('moekoe-like-refresh', refreshHandler);
    });

    // 跨音质匹配：拦截 /privilege/lite 响应后，检查当前歌曲所有音质 hash 是否有在收藏列表中
    // 解决搜索/排行榜等场景播放高音质版本时，hash 与收藏列表标准音质 hash 不一致的问题
    var privilegeHandler = function (e) {
      if (!e.detail || !e.detail.hashes) return;
      mainWorldActive = true;
      // 竞态保护：只有当当前歌曲 hash 在返回的 hash 列表中时才生效（快速切歌时旧信息会被忽略）
      if (!currentSongHash || e.detail.hashes.indexOf(currentSongHash) === -1) return;
      // 当前 hash 已直接命中收藏列表时无需跨音质匹配
      if (likedHashes.has(currentSongHash)) return;
      // 检查是否有任意音质 hash 在收藏列表中
      var matched = false;
      for (var i = 0; i < e.detail.hashes.length; i++) {
        if (likedHashes.has(e.detail.hashes[i])) {
          matched = true;
          break;
        }
      }
      if (matched) {
        crossMatchedHash = currentSongHash;
        log('跨音质匹配命中:', e.detail.hashes.length, '个音质 hash');
        updateHeartButton();
      }
    };
    document.addEventListener('moekoe-privilege-info', privilegeHandler);
    cleanupFns.push(function () {
      document.removeEventListener('moekoe-privilege-info', privilegeHandler);
    });

    // 认证变化
    var authHandler = function (e) {
      if (!e.detail) return;
      if (e.detail.authenticated) {
        // 登录：清空旧数据，重新拉取
        likedHashes.clear();
        try {
          localStorage.removeItem('moekoe_liked_hashes_v2');
          localStorage.removeItem('moekoe_liked_hashes_v2_time');
        } catch (e2) {}
        fetchLikedSongs();
      } else {
        // 登出：清空所有状态，重置 UI
        likedHashes.clear();
        currentSongHash = '';
        crossMatchedHash = '';
        try {
          localStorage.removeItem('moekoe_liked_hashes_v2');
          localStorage.removeItem('moekoe_liked_hashes_v2_time');
        } catch (e2) {}
        updateHeartButton();
      }
    };
    document.addEventListener('moekoe-auth-change', authHandler);
    cleanupFns.push(function () {
      document.removeEventListener('moekoe-auth-change', authHandler);
    });
  }

  // ── 降级轮询（主世界脚本加载失败时使用） ──

  function startFallbackPolling() {
    if (pollTimer) return;
    log('启动降级轮询，间隔', POLL_INTERVAL, 'ms');

    var hash = getCurrentSongHash();
    if (hash) onSongChange(hash);

    pollTimer = setInterval(function () {
      if (mainWorldActive) {
        clearInterval(pollTimer);
        pollTimer = null;
        log('主世界已激活，停止降级轮询');
        return;
      }
      var hash = getCurrentSongHash();
      onSongChange(hash);
    }, POLL_INTERVAL);

    cleanupFns.push(function () {
      clearInterval(pollTimer);
      pollTimer = null;
    });
  }

  // ── MutationObserver ──
  // 监听红心按钮被新增到 DOM（如全屏歌词页打开）
  // 注意：全屏歌词页 .lyrics-bg 是 .player-container 的兄弟元素，
  // 必须监听两者的共同父元素，否则 .lyrics-bg 的添加无法被捕获

  function startDOMObserver() {
    if (domObserver) return;

    domObserver = new MutationObserver(function (mutations) {
      var hasRelevant = false;
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.matches && (node.matches('.extra-btn, .like-btn, .extra-controls, .player-controls, .lyrics-bg, .lyrics-screen') ||
              node.querySelector && node.querySelector('.extra-btn, .like-btn'))) {
            hasRelevant = true;
            break;
          }
        }
        if (hasRelevant) break;
      }
      if (!hasRelevant) return;

      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        updateHeartButton();
      });
    });

    // 监听 .player-container 的父元素，确保能捕获兄弟元素 .lyrics-bg 的添加
    var playerContainer = document.querySelector('.player-container');
    var target = (playerContainer && playerContainer.parentElement) || document.body;
    domObserver.observe(target, { childList: true, subtree: true });

    cleanupFns.push(function () {
      domObserver.disconnect();
      domObserver = null;
    });
  }

  // ── 清理 ──

  function cleanup() {
    cleanupFns.forEach(function (fn) { fn(); });
    cleanupFns = [];
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    // 清理主世界补丁
    try {
      var script = document.createElement('script');
      script.textContent = 'if(window.__MOEKOE_LIKE_CLEANUP__)window.__MOEKOE_LIKE_CLEANUP__()';
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) {}
    log('资源已清理');
  }

  // ── 初始化 ──

  async function init() {
    log('初始化 v1.6.7-adapter...');
    // 还原历史补丁：插件升级时旧 injected.js 的 localStorage/XHR/fetch 拦截可能残留，
    // __MOEKOE_LIKE_INJECTED__ 守卫会阻止新脚本注入。先调 cleanup 触发 __MOEKOE_LIKE_CLEANUP__
    // 还原主世界补丁并清除守卫，确保新 injected.js 能正常注入
    cleanup();
    log('API 地址:', getApiBaseUrl());
    log('已认证:', isAuthenticated());

    loadCachedHashes();

    currentSongHash = getCurrentSongHash();
    log('当前歌曲 hash:', currentSongHash ? currentSongHash.substring(0, 8) + '...' : '(空)');

    setupCustomEventListener();
    tryInjectMainWorldScript();
    startDOMObserver();

    updateHeartButton();

    await fetchLikedSongs();

    log('初始化完成，收藏歌曲数:', likedHashes.size);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(init, INIT_DELAY);
    });
  } else {
    setTimeout(init, INIT_DELAY);
  }
})();

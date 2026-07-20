// ============================================================
// 数据访问层 - Supabase API 替代 IndexedDB
// ============================================================

const STORAGE_BUCKET = 'seat-photos';

// ---- 腾讯云 COS 配置 ----
const COS_BASE_URL = 'https://seat-photos-1410629582.cos.ap-guangzhou.myqcloud.com';
const COS_PRESIGNED_URL_ENDPOINT = 'https://cuejslqxatzkortnkdsf.supabase.co/functions/v1/get-cos-presigned-url';

// ---- 缩略图 Cache Storage 缓存 ----
const THUMB_CACHE_NAME = 'seat-thumbnails-v1';

/** 从缓存获取缩略图，返回 blob URL 或 null */
async function getCachedThumb(url) {
  try {
    const cache = await caches.open(THUMB_CACHE_NAME);
    const response = await cache.match(url);
    if (response) {
      return URL.createObjectURL(await response.blob());
    }
  } catch (e) { /* Cache API 不可用时静默降级 */ }
  return null;
}

/** 将缩略图存入缓存（后台执行，不阻塞） */
async function cacheThumb(url, response) {
  try {
    const cache = await caches.open(THUMB_CACHE_NAME);
    cache.put(url, response.clone());
  } catch (e) { /* 缓存写入失败不影响显示 */ }
}

/** 从缓存中删除指定 URL */
async function removeCachedThumb(url) {
  try {
    const cache = await caches.open(THUMB_CACHE_NAME);
    await cache.delete(url);
  } catch (e) { /* 静默 */ }
}

/** 清空所有缓存（缩略图 + Service Worker 缓存的图片等） */
async function clearAllThumbCache() {
  try {
    // 清除所有 Cache Storage（包括 SW 的 seat-cache-v* 和缩略图缓存）
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch (e) { /* 静默 */ }
}

// 【v2.7.8 并发控制】缩略图下载并发队列，最多 4 个同时下载
const MAX_CONCURRENT_DOWNLOADS = 4;
let _activeDownloads = 0;
const _downloadQueue = [];

/** 将下载任务加入并发队列，返回 Promise<{response, fromCache}> */
function enqueueDownload(url, priority = false) {
  return new Promise((resolve, reject) => {
    const task = { url, resolve, reject };
    if (priority) {
      // 高优先级（可见区域）插队到队首
      _downloadQueue.unshift(task);
    } else {
      _downloadQueue.push(task);
    }
    _processDownloadQueue();
  });
}

async function _processDownloadQueue() {
  if (_activeDownloads >= MAX_CONCURRENT_DOWNLOADS || _downloadQueue.length === 0) return;

  const { url, resolve, reject } = _downloadQueue.shift();
  _activeDownloads++;

  try {
    // 先查缓存
    const cachedUrl = await getCachedThumb(url);
    if (cachedUrl) {
      resolve({ blobUrl: cachedUrl, fromCache: true });
    } else {
      const response = await fetch(url, { mode: 'cors' });
      if (response.ok) {
        // 延迟写入缓存，不阻塞主线程
        const cloned = response.clone();
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => { cacheThumb(url, cloned); });
        } else {
          setTimeout(() => { cacheThumb(url, cloned); }, 0);
        }
        const blob = await response.blob();
        resolve({ blobUrl: URL.createObjectURL(blob), fromCache: false });
      } else {
        reject(new Error('HTTP ' + response.status));
      }
    }
  } catch (e) {
    reject(e);
  } finally {
    _activeDownloads--;
    _processDownloadQueue();
  }
}

/** 获取 COS 预签名 URL
 *  @param {'upload'|'delete'|'get'} action - 操作类型
 *  @param {string} key - COS 对象路径（如 '1/1104/xxx.jpg'）
 *  @returns {Promise<string|null>} 预签名 URL，失败返回 null
 */
async function getCOSPresignedUrl(action, key) {
  try {
    const resp = await fetch(COS_PRESIGNED_URL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ action, key })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + (body ? ': ' + body.slice(0, 200) : ''));
    }
    const data = await resp.json();
    if (!data.url) throw new Error('返回数据缺少 url');
    console.log('[COS] 预签名URL获取成功:', action, key);
    return data.url;
  } catch (e) {
    console.error('[COS] 获取预签名URL失败:', e.message);
    // 【v2.7.45】SSL/网络错误统一提示，不写入脏数据
    // 调用方（dlUploadPhoto）会在拿不到预签名 URL 时回退到 Supabase Storage
    // 但如果是 SSL 证书错误，Supabase Storage 大概率也会失败
    const errMsg = String(e?.message || '');
    if (/cert|ssl|tls|ERR_CERT|ERR_TLS/i.test(errMsg)) {
      console.error('[COS] SSL/TLS 错误，可能是网络环境问题');
      // 不抛异常，返回 null 让调用方处理（避免中断流程）
      // 调用方的 catch 块会检测错误信息并给出友好提示
    }
    return null;
  }
}

/** 获取 COS 图片的预签名读取 URL（用于全屏预览，解决 CORS 问题）
 *  @param {string} url - COS 原始 URL（如 https://seat-photos-xxx.cos.ap-guangzhou.myqcloud.com/1/1104/xxx.jpg）
 *  @returns {Promise<string>} 预签名 URL，失败则返回原始 URL
 */
async function getCOSReadUrl(url) {
  if (!url || !url.includes('.myqcloud.com')) return url;
  const key = extractStoragePath(url);
  if (!key) return url;
  const presigned = await getCOSPresignedUrl('get', key);
  return presigned || url;
}

// ---- 【v2.7.15】预签名 URL 内存缓存（全屏预览优化：消除实时获取预签名 URL 的网络等待） ----
const presignedUrlCache = new Map(); // key: 原始URL, value: 预签名URL

/** 异步预生成图片列表的预签名 URL（后台执行，不阻塞 UI）
 *  在展开座位/打开预览时调用，预签名 URL 提前就绪后预览可瞬间打开
 */
async function preloadPresignedUrls(images) {
  if (!images || !images.length) return;
  // 串行预生成（避免并发请求过多冲击 Edge Function）
  for (const img of images) {
    if (!img || !img.url) continue;
    if (presignedUrlCache.has(img.url)) continue; // 已缓存跳过
    try {
      const presignedUrl = await getCOSReadUrl(img.url);
      presignedUrlCache.set(img.url, presignedUrl);
    } catch (e) {
      // 预生成失败不影响预览，预览时再实时获取
    }
  }
}

/** 同步获取已缓存的预签名 URL，未命中返回 null */
function getPresignedUrlCached(url) {
  if (!url) return null;
  return presignedUrlCache.get(url) || null;
}

/** 清空预签名 URL 缓存（日期切换/登出时调用） */
function clearPresignedUrlCache() {
  presignedUrlCache.clear();
}

/** 从预签名 URL 缓存中移除单个条目（删除图片时调用） */
function removePresignedUrl(url) {
  if (url) presignedUrlCache.delete(url);
}

/** 区域名称/前缀 → 安全英文文件夹名映射（避免中文路径导致 InvalidKey） */
const REGION_MAP = {
  '中': 'zhong', '报': 'bao', '东': 'dong', '南': 'nan',
  '西': 'xi', '北': 'bei', '青': 'qing', '东临': 'donglin'
};

/** 从座位编号中提取区域前缀+数字，构造安全存储文件夹路径
 *  如 "东2001" → "2/dong2001"，"西2001" → "2/xi2001"，"报1097" → "1/bao1097"
 *  同楼层不同区域（如二楼东区"东2001"和西区"西2001"）会分别存入不同子文件夹
 */
function getSafeFolder(floor, seatLabel) {
  // 提取前缀（非数字开头部分）和数字部分
  const match = seatLabel.match(/^(\D+)(\d+)$/);
  if (match) {
    const prefix = match[1];
    const num = match[2];
    const safePrefix = REGION_MAP[prefix] || prefix.replace(/[^\w]/g, '').toLowerCase() || 's';
    return `${floor}/${safePrefix}${num}`;
  }
  // 回退：纯数字或无法解析
  const num = seatLabel.replace(/\D/g, '');
  return `${floor}/s${num.slice(-4) || '0'}`;
}

// ---- 内存缓存 ----
const _imageCountCache = new Map();
const _cellDataCache = new Map();
const _seatNamesCache = {};
const _extraSeatsCache = {};
const _deletedSeatsCache = new Set();
const _deletedPhotoIds = new Set(); // 【v2.3.0】已删除的 photo_id，防止增量合并恢复
const _userNameCache = new Map(); // uid → name 内存缓存
const _userNameFetching = new Map(); // uid → Promise（去重并发请求）
const _USER_NAME_LS_KEY = 'shared_seat_user_names_v1'; // localStorage 持久化键

/** 【v2.7.16】从 localStorage 恢复姓名缓存（页面刷新后立即可用，避免微信 WebView 会话时序问题） */
function _loadUserNameCacheFromLS() {
  if (_userNameCache.size > 0) return; // 已加载则跳过
  try {
    const raw = localStorage.getItem(_USER_NAME_LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([uid, name]) => {
        if (uid && name) _userNameCache.set(uid, name);
      });
    }
  } catch (e) { /* localStorage 不可用，忽略 */ }
}

/** 【v2.7.16】将姓名缓存写入 localStorage（节流，避免频繁写入） */
let _userNameLSWriteTimer = null;
function _persistUserNameCacheToLS() {
  if (_userNameLSWriteTimer) return;
  _userNameLSWriteTimer = setTimeout(() => {
    _userNameLSWriteTimer = null;
    try {
      const obj = {};
      _userNameCache.forEach((name, uid) => { obj[uid] = name; });
      localStorage.setItem(_USER_NAME_LS_KEY, JSON.stringify(obj));
    } catch (e) { /* quota exceeded，忽略 */ }
  }, 1000);
}

/** 【v2.7.16】预热当前用户姓名到缓存（登录后立即调用） */
function _preWarmCurrentUserName(uid, name) {
  if (!uid || !name) return;
  if (_userNameCache.get(uid) !== name) {
    _userNameCache.set(uid, name);
    _persistUserNameCacheToLS();
  }
}

/** 批量获取用户姓名（缓存 + 重试 + 按需查询）
 *  【v2.7.16】增强：3 次重试 + 500ms 间隔，解决微信 WebView 会话时序导致查询失败的问题
 */
async function batchGetUserNames(uids) {
  if (!uids || !uids.length) return {};
  _loadUserNameCacheFromLS(); // 确保从 localStorage 恢复
  const missing = uids.filter(uid => uid && !_userNameCache.has(uid));
  if (missing.length) {
    // 去重并发请求：同一个 uid 同时被多次请求时，复用同一个 Promise
    const tasks = missing.map(uid => {
      if (!_userNameFetching.has(uid)) {
        _userNameFetching.set(uid, _fetchUserNameWithRetry(uid));
      }
      return _userNameFetching.get(uid).finally(() => _userNameFetching.delete(uid));
    });
    await Promise.all(tasks);
  }
  const result = {};
  uids.forEach(uid => { if (uid) result[uid] = _userNameCache.get(uid) || ''; });
  return result;
}

/** 【v2.7.16】带重试的单 uid 姓名查询（3 次尝试，500ms 间隔）
 *  【v2.7.19】改用 RPC 函数 get_user_names 绕过 RLS，解决非 owner/admin 角色查询被拦截的问题
 */
async function _fetchUserNameWithRetry(uid, maxRetries = 2, delayMs = 500) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      // 【v2.7.19】使用 RPC 函数绕过 RLS（仅返回 uid 和 name，不泄露敏感字段）
      const { data, error } = await _sb.rpc('get_user_names', { p_uids: [uid] });
      if (error) throw error;
      if (data && data.length > 0 && data[0].name) {
        _userNameCache.set(uid, data[0].name);
        _persistUserNameCacheToLS();
        return;
      }
      // data 为空数组：用户不存在或 name 为空，缓存为空字符串避免重试
      _userNameCache.set(uid, '');
      return;
    } catch (e) {
      console.warn(`[dl] 查询用户姓名失败 (uid=${uid}, 第${i + 1}次):`, e.message || e);
      // 【v2.7.19】RPC 失败时回退到直接查询（兼容未部署 RPC 函数的环境）
      try {
        const { data: fallbackData, error: fallbackErr } = await _sb.from('users').select('uid, name').eq('uid', uid).maybeSingle();
        if (!fallbackErr && fallbackData && fallbackData.name) {
          _userNameCache.set(uid, fallbackData.name);
          _persistUserNameCacheToLS();
          return;
        }
      } catch (fallbackErr) { /* 静默 */ }
      if (i < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      // 最终失败：不缓存，下次调用时再次尝试
    }
  }
}

// ---- 网络重试 + 本地缓存 ----
const SUPABASE_HOST = 'https://cuejslqxatzkortnkdsf.supabase.co';
// 【v2.7.34】添加 shared_ 前缀，切断与离线版 localStorage 的关联
const LOCAL_CACHE_PREFIX = 'shared_seat_cell_';
const LOCAL_CACHE_TTL = 30 * 60 * 1000; // 策略四：30分钟过期

/** 策略一：通用重试函数，最多重试 maxRetries 次，每次间隔 delayMs 毫秒 */
async function fetchWithRetry(queryFn, maxRetries = 2, delayMs = 1000) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const result = await queryFn();
      if (result.error && i < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      return result;
    } catch (e) {
      if (i < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
}

/** 策略四：写入 localStorage 缓存 */
function setLocalCache(ck, data) {
  try {
    localStorage.setItem(LOCAL_CACHE_PREFIX + ck, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) { /* quota exceeded, ignore */ }
}

/** 策略四：读取 localStorage 缓存，超时返回 null */
function getLocalCache(ck) {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_PREFIX + ck);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > LOCAL_CACHE_TTL) { localStorage.removeItem(LOCAL_CACHE_PREFIX + ck); return null; }
    return data;
  } catch (e) { return null; }
}

/** 策略四：清除 localStorage 缓存 */
function clearLocalCache(ck) {
  try { if (ck) localStorage.removeItem(LOCAL_CACHE_PREFIX + ck); else { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith(LOCAL_CACHE_PREFIX)) localStorage.removeItem(k); } } } catch (e) {}
}

/** 清理 localStorage 中残留的 CDN URL 缓存（CDN 已废弃，需将含 libseat.cn 的 URL 替换回 Supabase 直连） */
(function fixCdnCache() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LOCAL_CACHE_PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (!raw || !raw.includes('libseat.cn')) continue;
      const fixed = raw.replace(/https?:\/\/libseat\.cn/g, SUPABASE_HOST);
      if (fixed !== raw) localStorage.setItem(k, fixed);
    }
  } catch (e) {}
})();

/** 上传保护锁：上传后30秒内禁止用空数据覆盖该 cell 缓存 */
const _cacheLocks = new Map();
function lockCell(ck) { _cacheLocks.set(ck, Date.now()); }
function isCellLocked(ck) {
  const t = _cacheLocks.get(ck);
  if (!t) return false;
  if (Date.now() - t > 30000) { _cacheLocks.delete(ck); return false; }
  return true;
}

/** 【修复二】安全更新缓存：空数组永远不覆盖已有非空缓存，上传锁期间更严格 */
function safeSetCache(ck, data, reason) {
  if (data && data.length > 0) {
    console.log('[CACHE] SET', ck, 'count=' + data.length, reason || '');
    _cellDataCache.set(ck, data);
    setLocalCache(ck, data);
    return;
  }
  // data 为空或长度为0
  const existing = _cellDataCache.get(ck);
  if (existing && existing.length > 0) {
    if (isCellLocked(ck)) {
      console.warn('[CACHE] 拒绝覆盖（上传锁）:', ck, 'reason=' + (reason || 'unknown'));
      return;
    }
    console.warn('[CACHE] 拒绝用空数组覆盖非空缓存:', ck, 'existing=' + existing.length, 'reason=' + (reason || ''));
    return;
  }
  // 缓存本身为空，允许设空
  console.log('[CACHE] SET empty', ck, reason || '');
  _cellDataCache.set(ck, data || []);
}

/** 【修复二】安全删除缓存：带诊断日志 */
function safeDeleteCache(ck, reason) {
  const existing = _cellDataCache.get(ck);
  if (existing && existing.length > 0 && isCellLocked(ck)) {
    console.warn('[CACHE] 拒绝删除（上传锁）:', ck, 'reason=' + (reason || ''));
    return;
  }
  console.log('[CACHE] DELETE', ck, 'hadData=' + !!(existing && existing.length), reason || '');
  _cellDataCache.delete(ck);
  _imageCountCache.delete(ck);
}

/** 【修复二】上传后校验：1秒后检查缓存是否被意外清空，若丢失则从数据库恢复 */
function verifyUploadCache(ck, expectedCount) {
  setTimeout(async () => {
    // 如果该 cell 正在删除中，跳过校验
    if (typeof _deletingCells !== 'undefined' && _deletingCells.has(ck)) return;
    // 如果该 cell 正在上传中，跳过校验（避免覆盖 _uploading 状态的缓存）
    if (typeof isUploading === 'function' && isUploading(ck)) return;
    const cached = _cellDataCache.get(ck);
    if (cached && cached.length >= expectedCount) return; // 缓存完好
    console.warn('[dl] 上传后校验：缓存丢失，从数据库恢复', ck);
    try {
      const { data, error } = await _sb.from('seat_photos')
        .select('id, url, status, uploaded_by, created_at, time_slot')
        .eq('cell_key', ck)
        .order('created_at', { ascending: true })
        .limit(3);
      if (!error && data && data.length > 0) {
        // 【v2.5.1】过滤掉已被删除的图片
        const images = data
          .filter(p => !_deletedPhotoIds.has(p.id))
          .map(p => ({
            photo_id: p.id, url: p.url, status: p.status,
            uploaded_by: p.uploaded_by, created_at: p.created_at,
            thumbnail: p.url, time_slot: p.time_slot
          }));
        if (images.length === 0) return; // 全部已删除，不恢复
        safeSetCache(ck, images, 'verifyUploadCache恢复');
        _imageCountCache.set(ck, images.length);
        lockCell(ck); // 恢复后也上锁
        // 通知 UI 刷新
        if (typeof invalidateTimeslotCache === 'function') {
          const sk = ck.replace(/-\d+$/, ''); // cell_key → seat_key
          invalidateTimeslotCache(sk);
          requestAnimationFrame(() => { if (typeof renderTimeSlots === 'function') renderTimeSlots(sk); });
        }
      }
    } catch (e) { console.warn('[dl] 上传后校验失败:', e); }
  }, 1000);
}


// ---- 辅助 ----
function parseCellKey(ck) { const p = ck.split('-'); return { fid: p[0], aname: p[1], sidx: parseInt(p[2]), tidx: parseInt(p[3]) }; }
function parseSeatKey(sk) { const p = sk.split('-'); return { fid: p[0], aname: p[1], sidx: parseInt(p[2]) }; }
function areaKey(fid, aname) { return `${fid}-${aname}`; }
function seatKeyFromParts(fid, aname, sidx) { return `${fid}-${aname}-${sidx}`; }
function cellKeyFromParts(fid, aname, sidx, tidx) { return `${fid}-${aname}-${sidx}-${tidx}`; }

function defaultSeatName(fid, aname, sidx) {
  const cfg = getAreaConfig(parseInt(fid), aname);
  if (cfg) return cfg.prefix + (cfg.start + sidx);
  console.warn('[dl] defaultSeatName fallback: fid=', fid, 'aname=', aname, 'sidx=', sidx);
  return `S${fid}${sidx}`;
}

function getAreaConfig(fid, aname) {
  const floor = FLOORS.find(f => f.id === parseInt(fid));
  return floor ? floor.areas.find(a => a.name === aname) : null;
}

function extractStoragePath(url) {
  try {
    // 腾讯云 COS URL: https://seat-photos-1410629582.cos.ap-guangzhou.myqcloud.com/xxx/yyy.jpg
    if (url.includes('.myqcloud.com')) {
      const u = new URL(url);
      return u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
    }
    // 旧 Supabase Storage URL: https://xxx.supabase.co/object/public/seat-photos/xxx
    const m = new URL(url).pathname.match(/\/object\/public\/seat-photos\/(.+)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function dataURLtoBlob(dataURL) {
  const parts = dataURL.split(','), mime = parts[0].match(/:(.*?);/)[1];
  const b64 = atob(parts[1]), arr = new Uint8Array(b64.length);
  for (let i = 0; i < b64.length; i++) arr[i] = b64.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---- openDB / dbDelete / dbGet（空操作，保持兼容） ----
async function openDB() { return true; }
async function dbDelete(storeName, key) {
  if (storeName === 'cells') { safeDeleteCache(key, 'dbDelete'); }
}
async function dbGet(storeName, key) {
  if (storeName === 'cells' && _cellDataCache.has(key)) return { key, images: _cellDataCache.get(key) };
  return null;
}

// ============================================================
// 图片数据读写
// ============================================================

/** 获取单个单元格的图片数据（按 cell_key 精确查询） */
async function getCellData(ck, dateRange) {
  if (_cellDataCache.has(ck)) {
    // 【v2.5.1】过滤掉已被删除的图片（防止缓存残留）
    const cached = _cellDataCache.get(ck);
    const filtered = cached.filter(img => !img.photo_id || !_deletedPhotoIds.has(img.photo_id));
    if (filtered.length !== cached.length) {
      safeSetCache(ck, filtered, 'getCellData过滤已删');
      _imageCountCache.set(ck, filtered.length);
    }
    return { key: ck, images: filtered };
  }

  // 策略四：先从 localStorage 读取缓存
  const localData = getLocalCache(ck);
  if (localData && !Array.isArray(localData)) { /* skip invalid */ }
  else if (localData) {
    // 【v2.5.1】过滤掉已被删除的图片
    const filtered = localData.filter(img => !img.photo_id || !_deletedPhotoIds.has(img.photo_id));
    if (filtered.length > 0) {
      safeSetCache(ck, filtered, 'localStorage恢复');
      return { key: ck, images: filtered };
    }
  }

  // 策略一：使用 fetchWithRetry 重试
  const { data, error } = await fetchWithRetry(() => {
    let q = _sb.from('seat_photos')
      .select('id, url, status, uploaded_by, created_at, time_slot')
      .eq('cell_key', ck)
      .order('created_at', { ascending: true })
      .limit(3);
    if (dateRange && dateRange.start && dateRange.end) {
      q = q.gte('created_at', dateRange.start.toISOString()).lt('created_at', dateRange.end.toISOString());
    }
    return q;
  });
  if (error) {
    console.warn('[dl] getCellData error (after retry):', error);
    const memCached = _cellDataCache.get(ck);
    if (memCached && memCached.length > 0) return { key: ck, images: memCached };
    if (localData && localData.length > 0) return { key: ck, images: localData };
    return { key: ck, images: [], _networkError: true };
  }

  const freshImages = (data || [])
    .filter(p => !_deletedPhotoIds.has(p.id)) // 【v2.5.1】过滤已删除
    .map(p => ({
      photo_id: p.id, url: p.url, status: p.status,
      uploaded_by: p.uploaded_by, created_at: p.created_at,
      thumbnail: p.url, time_slot: p.time_slot
    }));
  // 【v2.5.4修复】空结果也要缓存，否则轮询无法同步删除操作
  if (freshImages.length > 0) {
    safeSetCache(ck, freshImages, 'getCellData');
    setLocalCache(ck, freshImages);
  } else {
    // 空结果：直接写缓存（绕过 safeSetCache 的空数组保护）
    _cellDataCache.set(ck, []);
    _imageCountCache.set(ck, 0);
    clearLocalCache(ck);
  }
  return { key: ck, images: _cellDataCache.get(ck) || freshImages };
}

/** 批量获取（按 cell_key 批量查询）
 *  【v2.7.38】分批查询：每批最多 100 个 cellKey，避免 URL 过长导致请求失败
 */
async function getCellDataBatch(cellKeys, dateRange, forceRefresh = false) {
  if (!cellKeys || !cellKeys.length) return {};
  const result = {};
  const missing = [];
  // 【v2.7.50】forceRefresh=true 时跳过 _cellDataCache 缓存，强制走数据库查询
  // 原因：批量下载场景下，缓存可能是上次下载时的旧数据，不包含他人新上传的图片
  cellKeys.forEach(ck => {
    if (!forceRefresh && _cellDataCache.has(ck)) {
      result[ck] = { key: ck, images: _cellDataCache.get(ck) };
    } else {
      missing.push(ck);
    }
  });
  if (!missing.length) return result;

  // 【v2.7.38】分批查询，每批最多 100 个 cellKey
  const BATCH_SIZE = 100;
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    batches.push(missing.slice(i, i + BATCH_SIZE));
  }
  console.log('[getCellDataBatch] 总 cellKey 数:', missing.length, '分批数:', batches.length);

  let allData = [];
  let lastError = null;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const { data, error } = await fetchWithRetry(() => {
      let q = _sb.from('seat_photos')
        .select('id, url, status, cell_key, uploaded_by, created_at, time_slot')
        .in('cell_key', batch)
        .order('created_at', { ascending: true });
      if (dateRange && dateRange.start && dateRange.end) {
        q = q.gte('created_at', dateRange.start.toISOString()).lt('created_at', dateRange.end.toISOString());
      }
      return q;
    });
    if (error) {
      console.warn(`[getCellDataBatch] 第 ${bi + 1} 批查询失败:`, error);
      lastError = error;
    } else if (data) {
      allData = allData.concat(data);
    }
  }

  // 所有批次都失败才走错误兜底逻辑
  if (allData.length === 0 && lastError) {
    missing.forEach(ck => {
      const memCached = _cellDataCache.get(ck);
      if (memCached && memCached.length > 0) {
        result[ck] = { key: ck, images: memCached };
      } else {
        const local = getLocalCache(ck);
        result[ck] = local && local.length > 0 ? { key: ck, images: local } : { key: ck, images: [], _networkError: true };
      }
    });
    return result;
  }

  const byCellKey = {};
  (allData || []).forEach(p => { if (!byCellKey[p.cell_key]) byCellKey[p.cell_key] = []; if (byCellKey[p.cell_key].length < 3) byCellKey[p.cell_key].push(p); });

  missing.forEach(ck => {
    const photos = byCellKey[ck] || [];
    const freshImages = photos.map(p => ({
      photo_id: p.id, url: p.url, status: p.status,
      uploaded_by: p.uploaded_by, created_at: p.created_at, thumbnail: p.url, time_slot: p.time_slot
    }));
    // 【修复二】使用安全缓存更新：空数组不覆盖非空缓存
    safeSetCache(ck, freshImages, 'getCellDataBatch');
    result[ck] = { key: ck, images: _cellDataCache.get(ck) || freshImages };
  });
  return result;
}

/** 保存单元格图片数据
 *  核心原则：上传失败绝不写数据库，绝不缓存破损记录
 */
async function saveCellData(ck, imgs) {
  const { fid, aname, sidx, tidx } = parseCellKey(ck);
  const seatId = defaultSeatName(fid, aname, sidx);
  const timeSlot = TIME_SLOTS[tidx];

  // 查询该 cell_key 的现有照片
  const { data: ex } = await _sb.from('seat_photos').select('id, url').eq('cell_key', ck);
  const existingIds = new Set((ex || []).map(p => p.id));
  const newIds = new Set(imgs.filter(i => i.photo_id).map(i => i.photo_id));

  // 删除不再存在的照片
  for (const p of (ex || [])) {
    if (!newIds.has(p.id)) await dlDeletePhoto(p.id, p.url, ck);
  }

  // 新增照片：严格校验上传成功后才写数据库
  const successImgs = [];
  const seenIds = new Set(existingIds); // 已有photo_id集合（用于去重）
  const seenUrls = new Set((ex || []).map(p => p.url)); // 已有url集合（用于去重）
  const seenCreatedAt = new Set(); // 同一批内 createdAt 去重（防同一图片被重复插入）
  for (const img of imgs) {
    // 同一批内 createdAt 去重：同一毫秒的图片视为重复
    const ts = img.createdAt;
    if (ts && seenCreatedAt.has(ts)) continue;
    if (ts) seenCreatedAt.add(ts);

    if (img.photo_id) {
      // 已有 photo_id 的，去重检查
      if (seenIds.has(img.photo_id)) continue;
      seenIds.add(img.photo_id);
      if (img.url && seenUrls.has(img.url)) continue;
      if (img.url) seenUrls.add(img.url);
      successImgs.push(img);
    } else if (img.data || img._fullBlob) {
      // 新图片：上传 + 写库
      const result = await dlUploadPhoto(ck, img);
      if (result && result.success && result.url) {
        // 上传成功，img 对象已被 dlUploadPhoto 更新了 photo_id
        // 更新去重集合，防止后续重复上传
        if (img.photo_id) seenIds.add(img.photo_id);
        if (img.url) seenUrls.add(img.url);
        successImgs.push(img);
      } else {
        // 上传失败：绝不加入缓存，绝不写数据库
        console.error('[dl] 上传失败，跳过该图片，不写入数据库:', result?.error);
      }
    }
  }

  // 缓存更新：增量合并，禁止删除已有缓存（防闪烁）
  // 原则：旧图片数据始终保留在缓存中，仅追加或更新新图片
  // 【v2.3.0】跳过已被删除的 photo_id，防止增量合并恢复已删图片
  const existing = _cellDataCache.get(ck) || [];
  const mergedMap = new Map(); // photo_id → img

  // 先放入已有图片（保留旧数据，跳过已删除的）
  for (const img of existing) {
    if (img.photo_id && _deletedPhotoIds.has(img.photo_id)) continue;
    const key = img.photo_id || img.createdAt || img.url;
    if (key) mergedMap.set(key, img);
  }

  // 合入本次成功的图片（覆盖同key旧数据或追加新数据，跳过已删除的）
  for (const img of successImgs) {
    if (img.photo_id && _deletedPhotoIds.has(img.photo_id)) continue;
    const key = img.photo_id || img.createdAt || img.url;
    if (key) mergedMap.set(key, img);
  }

  const merged = Array.from(mergedMap.values());
  safeSetCache(ck, merged, 'saveCellData增量合并');
  _imageCountCache.set(ck, merged.length);
  setLocalCache(ck, merged);
}

/** 上传单张照片到 Supabase Storage + 写入数据库
 *  返回 { success: true, url } 或 { success: false, error }
 *  绝不 throw，调用方通过返回值判断是否成功
 */
async function dlUploadPhoto(ck, img) {
  const { fid, aname, sidx, tidx } = parseCellKey(ck);
  const floor = fid;
  const seatLabel = defaultSeatName(fid, aname, sidx);
  const timeSlot = TIME_SLOTS[tidx];

  // 1. 准备文件 Blob
  let fullBlob = img._fullBlob || null;
  if (!fullBlob && img.data) {
    try { fullBlob = dataURLtoBlob(img.data); } catch (e) {
      return { success: false, error: 'Blob转换失败: ' + e.message };
    }
  }
  if (!fullBlob) return { success: false, error: '无有效图片数据' };

  // 2. 构造安全路径（彻底去中文）+ 语义化文件名
  const folder = getSafeFolder(floor, seatLabel);
  const seatNum = seatLabel.replace(/\D/g, '') || '0';
  const timeIdx = String(tidx + 1).padStart(2, '0');
  const randSuffix = Math.random().toString(36).slice(2, 10);
  const fileName = `${seatNum}_${timeIdx}_${randSuffix}.jpg`;
  const filePath = `${folder}/${fileName}`;

  // 3. 上传到腾讯云 COS（预签名 URL 方式，失败时回退 Supabase Storage）
  let imageUrl;
  let usedCOS = false;
  const presignedUrl = await getCOSPresignedUrl('upload', filePath);
  if (presignedUrl) {
    try {
      const putResp = await fetch(presignedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: fullBlob
      });
      if (!putResp.ok) throw new Error('PUT ' + putResp.status);
      imageUrl = `${COS_BASE_URL}/${filePath}`;
      usedCOS = true;
    } catch (uploadErr) {
      console.error('[dl] COS 预签名上传失败，回退 Supabase Storage:', uploadErr);
    }
  } else {
    console.warn('[dl] 获取预签名URL失败，回退 Supabase Storage');
  }
  if (!usedCOS) {
    // 兜底：上传到 Supabase Storage
    const { data: uploadData, error: uploadErr } = await _sb.storage.from(STORAGE_BUCKET)
      .upload(filePath, fullBlob, { contentType: 'image/jpeg', upsert: true });
    if (uploadErr) {
      console.error('[dl] Supabase Storage 上传也失败:', uploadErr);
      return { success: false, error: '上传失败: ' + uploadErr.message };
    }
    const { data: publicUrlData } = _sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
    imageUrl = publicUrlData?.publicUrl;
    if (!imageUrl || !imageUrl.startsWith('https://')) {
      return { success: false, error: '获取公开URL失败' };
    }
  }
  if (!imageUrl || !imageUrl.startsWith('https://')) {
    console.error('[dl] URL拼接异常:', imageUrl);
    return { success: false, error: 'URL拼接异常' };
  }

  // 5. 确保座位记录
  await ensureSeatRecord(seatLabel, fid, aname);

  // 6. 只有上传成功才写入数据库
  const { data, error } = await _sb.from('seat_photos').insert({
    seat_id: seatLabel, cell_key: ck, url: imageUrl,
    time_slot: timeSlot, status: img.status || 'occupied',
    uploaded_by: currentUser.uid
  }).select().single();

  if (error) {
    // 策略二：如果是重复键错误，忽略并返回已有 URL
    const errMsg = (error.message || '').toLowerCase();
    if (errMsg.includes('duplicate') || errMsg.includes('unique') || errMsg.includes('violates')) {
      console.warn('[dl] 重复键，跳过插入:', error.message);
      return { success: true, url: imageUrl, data: null, _dedup: true };
    }
    console.error('[dl] 数据库写入失败:', error);
    return { success: false, error: '数据库写入失败: ' + translateErrMsg(error.message) };
  }

  // 7. 更新座位状态（非关键，失败不影响主流程）
  try {
    await _sb.from('seats').update({
      current_status: img.status || 'occupied',
      last_photo_url: imageUrl,
      last_updated_by: currentUser.uid,
      last_updated_at: new Date().toISOString()
    }).eq('seat_id', seatLabel);
  } catch (e) { /* 非关键 */ }

  // 8. 更新原始 img 对象（供 saveCellData 缓存使用）
  img.photo_id = data.id;
  img.url = imageUrl;
  img.created_at = data.created_at;
  img.thumbnail = imageUrl;

  // 9. 更新当前 cell_key 缓存
  const cached = _cellDataCache.get(ck) || [];
  if (!cached.some(i => i.photo_id === data.id)) {
    cached.push({
      photo_id: data.id, url: imageUrl, status: img.status,
      uploaded_by: currentUser.uid, created_at: data.created_at,
      thumbnail: imageUrl, time_slot: timeSlot
    });
  }
  safeSetCache(ck, cached, 'dlUploadPhoto成功');
  _imageCountCache.set(ck, cached.length);
  lockCell(ck); // 【修复二】上传后30秒保护锁

  return { success: true, url: imageUrl, data };
}

/** 删除单张照片（Storage + DB + 缓存三步，Storage 失败仍清 DB 和缓存）
 *  返回 { success: boolean, error?: string }
 */
// 【v2.7.11】_deletingCells 在 scripts.js 中声明，此处直接使用

async function dlDeletePhoto(photoId, url, ck) {
  let storageOk = true;
  // 0. 如果没有传 ck，先从数据库查询该图片的 cell_key（删除前查询）
  if (!ck) {
    try {
      const { data } = await _sb.from('seat_photos').select('cell_key').eq('id', photoId).maybeSingle();
      if (data) ck = data.cell_key;
    } catch (e) {}
  }

  try {
    // 1. 删除 COS 文件（失败不阻断后续）
    if (url) {
      const path = extractStoragePath(url);
      if (path) {
        if (url.includes('.myqcloud.com')) {
          const presignedUrl = await getCOSPresignedUrl('delete', path);
          if (presignedUrl) {
            try {
              const delResp = await fetch(presignedUrl, { method: 'DELETE' });
              if (!delResp.ok) console.warn('[dl] COS预签名删除返回:', delResp.status);
            } catch (e) { console.warn('[dl] COS预签名删除失败，继续清DB:', e.message); storageOk = false; }
          } else {
            console.warn('[dl] 获取删除预签名URL失败，跳过COS删除，仅清DB');
          }
        } else {
          const { error: rmErr } = await _sb.storage.from(STORAGE_BUCKET).remove([path]);
          if (rmErr) { console.warn('[dl] Storage删除失败，继续清DB:', rmErr.message); storageOk = false; }
        }
      }
    }
    // 2. 删除数据库记录（即使 Storage 失败也要删）
    const { error: dbErr } = await _sb.from('seat_photos').delete().eq('id', photoId);
    if (dbErr) return { success: false, error: '数据库删除失败: ' + dbErr.message };

    // 3. 增量删除缓存：仅移除被删除的图片，不清空整个 cell 缓存
    if (ck) {
      const cached = _cellDataCache.get(ck);
      if (cached) {
        const filtered = cached.filter(img => img.photo_id !== photoId);
        if (filtered.length > 0) {
          _cellDataCache.set(ck, filtered);
          _imageCountCache.set(ck, filtered.length);
          setLocalCache(ck, filtered);
        } else {
          _cellDataCache.delete(ck);
          _imageCountCache.delete(ck);
          clearLocalCache(ck);
        }
      } else {
        const currentCount = _imageCountCache.get(ck) || 0;
        if (currentCount > 1) {
          _imageCountCache.set(ck, currentCount - 1);
        } else {
          _imageCountCache.delete(ck);
        }
        clearLocalCache(ck);
      }
      _deletedPhotoIds.add(photoId);
      // 同步清除缩略图 + 原图 Cache Storage 条目（两者共用原始 URL 作为 key）
      if (url) removeCachedThumb(url);
      // 【v2.7.15】同步清除预签名 URL 内存缓存
      if (url) removePresignedUrl(url);
      // 【v2.7.47】强制清空轮询脏标记，确保本机和其他设备的下次轮询必定检测到变化
      // 否则可能出现：本机缓存已更新但 newJSON 比对仍相同 → 跳过 UI 刷新
      if (typeof _lastCountsJSON !== 'undefined') {
        _lastCountsJSON = '';
      }
    }
    return { success: true, storageOk };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** 确保座位记录存在 */
async function ensureSeatRecord(seatId, fid, aname) {
  const { data } = await _sb.from('seats').select('seat_id').eq('seat_id', seatId).maybeSingle();
  if (data) return;
  try {
    await _sb.from('seats').insert({ seat_id: seatId, floor_id: fid, region: aname, label: seatId, current_status: 'unknown' });
  } catch (e) {
    if (!e.message?.includes('duplicate')) console.warn('[dl] ensureSeatRecord:', e);
  }
}

// ---- 图片计数 ----
async function dbGetImageCounts(dateRange) {
  // 【修复】按 cell_key 查询并分组，返回 Map<cellKey, count>
  // 旧版按 seat_id 查询返回 seatKey 格式的键（3段），与 imageCountCache 的 cellKey 格式（4段）不匹配，
  // 导致页面刷新后所有 cell 级计数查询返回 0，蓝色/橙色指示器全部消失
  let query = _sb.from('seat_photos').select('cell_key');
  // 日期过滤：如果传入了日期范围，只查询该范围内的记录
  if (dateRange && dateRange.start && dateRange.end) {
    query = query.gte('created_at', dateRange.start.toISOString()).lt('created_at', dateRange.end.toISOString());
  }
  const { data, error } = await query;
  if (error) { console.warn('[dl] dbGetImageCounts error:', error); return new Map(); }
  if (!data || data.length === 0) {
    // 【修复二】网络返回空时不覆盖已有计数缓存
    return new Map();
  }
  const result = new Map();
  data.forEach(r => {
    if (r.cell_key) {
      result.set(r.cell_key, (result.get(r.cell_key) || 0) + 1);
    }
  });
  _imageCountCache.clear();
  result.forEach((cnt, ck) => _imageCountCache.set(ck, cnt));
  return result;
}

/** 区域级图片计数预加载：查询指定区域内所有座位的图片计数
 *  @param {number} fid 楼层ID
 *  @param {string} aname 区域名称
 *  @returns {Map<string, number>} Map<cellKey, count>
 */
async function dbGetAreaImageCounts(fid, aname, dateRange) {
  const prefix = `${fid}-${aname}-`;
  // 使用 like 查询匹配该区域所有 cell_key
  let query = _sb.from('seat_photos').select('cell_key').like('cell_key', `${prefix}%`);
  if (dateRange && dateRange.start && dateRange.end) {
    query = query.gte('created_at', dateRange.start.toISOString()).lt('created_at', dateRange.end.toISOString());
  }
  const { data, error } = await query;
  if (error) { console.warn('[dl] dbGetAreaImageCounts error:', error); return new Map(); }
  const result = new Map();
  (data || []).forEach(r => {
    if (r.cell_key) {
      result.set(r.cell_key, (result.get(r.cell_key) || 0) + 1);
    }
  });
  // 合并到全局缓存（不清空其他区域的缓存）
  result.forEach((cnt, ck) => {
    _imageCountCache.set(ck, cnt);
  });
  return result;
}

// ---- 座位名称 ----
async function getAllSeatNames() {
  const { data, error } = await _sb.from('seats').select('seat_id, label').not('label', 'is', null);
  if (error) return {};
  const m = {};
  (data || []).forEach(r => { /* seatId → seatKey 映射较复杂，暂时返回空 */ });
  return _seatNamesCache;
}
async function saveSeatName(sk, name) {
  const { fid, aname, sidx } = parseSeatKey(sk);
  const seatId = defaultSeatName(fid, aname, sidx);
  await ensureSeatRecord(seatId, fid, aname);
  await _sb.from('seats').update({ label: name }).eq('seat_id', seatId);
  _seatNamesCache[sk] = name;
}

// ---- 新增座位数 ----
async function getAllExtraSeats() { return _extraSeatsCache; }
async function saveExtraSeat(ak, count) { _extraSeatsCache[ak] = count; }

// ---- 已删除座位 ----
async function getAllDeletedSeats() { return _deletedSeatsCache; }
async function saveDeletedSeat(sk) { _deletedSeatsCache.add(sk); }

// ---- 批量删除照片 ----
async function dlDeletePhotosByAreaAndTime(ak, tidxs) {
  const [fid, ...rest] = ak.split('-');
  const aname = rest.join('-');
  const cfg = getAreaConfig(parseInt(fid), aname);
  if (!cfg) return 0;
  const seatIds = [];
  const extra = _extraSeatsCache[ak] || 0;
  for (let si = 0; si < cfg.count + extra; si++) {
    seatIds.push(defaultSeatName(fid, aname, si));
  }
  const { data, error } = await _sb.from('seat_photos').select('id, url').in('seat_id', seatIds);
  if (error || !data || !data.length) return 0;
  const ids = data.map(p => p.id);
  const paths = data.map(p => extractStoragePath(p.url)).filter(Boolean);
  if (paths.length) {
    // 分离 COS 和旧 Supabase Storage 路径
    const cosPaths = [], sbPaths = [];
    data.forEach(p => {
      if (!p.url) return;
      const path = extractStoragePath(p.url);
      if (!path) return;
      if (p.url.includes('.myqcloud.com')) cosPaths.push(path);
      else sbPaths.push(path);
    });
    // 批量删除 COS 文件（预签名 URL 逐个删除）
    if (cosPaths.length) {
      for (const cosPath of cosPaths) {
        const presignedUrl = await getCOSPresignedUrl('delete', cosPath);
        if (presignedUrl) {
          try {
            await fetch(presignedUrl, { method: 'DELETE' });
          } catch (e) { console.warn('[dl] COS批量删除单个失败:', e.message); }
        }
      }
    }
    // 批量删除旧 Supabase Storage 文件（兼容旧数据）
    if (sbPaths.length) {
      for (let i = 0; i < sbPaths.length; i += 1000) await _sb.storage.from(STORAGE_BUCKET).remove(sbPaths.slice(i, i+1000)).catch(()=>{});
    }
  }
  for (let i = 0; i < ids.length; i += 500) await _sb.from('seat_photos').delete().in('id', ids.slice(i,i+500));
  console.warn('[CACHE] CLEAR ALL (dlDeletePhotosByAreaAndTime)'); _cellDataCache.clear(); _imageCountCache.clear();
  return data.length;
}

/** 批量删除 COS 文件（供 scripts.js 清除图片功能调用，预签名 URL 逐个删除）
 *  @param {string[]} paths - COS 文件路径列表
 */
async function cosDeleteBatch(paths) {
  if (!paths || !paths.length) return;
  for (const path of paths) {
    const presignedUrl = await getCOSPresignedUrl('delete', path);
    if (presignedUrl) {
      try {
        await fetch(presignedUrl, { method: 'DELETE' });
      } catch (e) { console.warn('[dl] COS批量删除单个失败:', e.message); }
    }
  }
}

// ---- 协作密码 ----
async function dlGetCollabPasswords(floorId) {
  const today = getBjDateStr();
  // 【v2.7.61】过滤已吊销的密码：revoked = false 或 revoked IS NULL
  // 吊销操作只更新 DB，前端必须同步增加过滤条件，否则已吊销密码仍会显示
  const { data, error } = await _sb.from('collab_passwords')
    .select('*').eq('floor_id', String(floorId)).eq('date', today)
    .or('revoked.is.null,revoked.eq.false')
    .order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

async function dlCreateCollabPassword(floorId, maxUses, expiresAt) {
  const pwd = Math.random().toString(36).substring(2,8).toUpperCase();
  const today = getBjDateStr();
  const { data, error } = await _sb.from('collab_passwords').insert({
    password: pwd, floor_id: String(floorId), date: today,
    max_uses: maxUses || 8, used_count: 0,
    expires_at: expiresAt || new Date(Date.now() + 86400000).toISOString(),
    created_by: currentUser.uid
  }).select().single();
  return error ? null : data;
}

// ---- 清缓存 ----
function dlClearCache() { console.warn('[CACHE] CLEAR ALL (dlClearCache)'); _imageCountCache.clear(); _cellDataCache.clear(); clearLocalCache(); }
function dlInvalidateCell(ck) { safeDeleteCache(ck, 'dlInvalidateCell'); clearLocalCache(ck); }

// ---- 报表自动生成已移除，改由 Supabase pg_cron 定时任务每天21:30调用 Edge Function ----

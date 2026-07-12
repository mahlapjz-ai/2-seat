// ============================================================
// 数据访问层 - Supabase API 替代 IndexedDB
// ============================================================

const STORAGE_BUCKET = 'seat-photos';

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

// ---- 网络重试 + 本地缓存 ----
const SUPABASE_HOST = 'https://cuejslqxatzkortnkdsf.supabase.co';
const LOCAL_CACHE_PREFIX = 'seat_cell_';
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
    // 【v2.5.1】如果该 cell 正在删除中，跳过校验（避免恢复已删图片）
    if (typeof _deletingCells !== 'undefined' && _deletingCells.has(ck)) return;
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
  try { const m = new URL(url).pathname.match(/\/object\/public\/seat-photos\/(.+)/); return m ? m[1] : null; } catch (e) { return null; }
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
async function getCellData(ck) {
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
  const { data, error } = await fetchWithRetry(() =>
    _sb.from('seat_photos')
      .select('id, url, status, uploaded_by, created_at, time_slot')
      .eq('cell_key', ck)
      .order('created_at', { ascending: true })
      .limit(3)
  );
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
  // 【修复二】使用安全缓存更新：空数组不覆盖非空缓存
  if (freshImages.length > 0) {
    safeSetCache(ck, freshImages, 'getCellData');
    setLocalCache(ck, freshImages); // 【v2.5.1】同步更新 localStorage
  }
  return { key: ck, images: _cellDataCache.get(ck) || freshImages };
}

/** 批量获取（按 cell_key 批量查询） */
async function getCellDataBatch(cellKeys) {
  if (!cellKeys || !cellKeys.length) return {};
  const result = {};
  const missing = [];
  cellKeys.forEach(ck => {
    if (_cellDataCache.has(ck)) result[ck] = { key: ck, images: _cellDataCache.get(ck) };
    else missing.push(ck);
  });
  if (!missing.length) return result;

  // 策略一：使用 fetchWithRetry 重试
  const { data, error } = await fetchWithRetry(() =>
    _sb.from('seat_photos')
      .select('id, url, status, cell_key, uploaded_by, created_at, time_slot')
      .in('cell_key', missing)
      .order('created_at', { ascending: true })
  );
  if (error) {
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
  (data || []).forEach(p => { if (!byCellKey[p.cell_key]) byCellKey[p.cell_key] = []; if (byCellKey[p.cell_key].length < 3) byCellKey[p.cell_key].push(p); });

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
  // 文件名格式：{座位编号}_{时段序号}_{随机字符}.jpg
  // 加随机字符串确保删除后再上传不会重名，避免浏览器缓存旧图
  const seatNum = seatLabel.replace(/\D/g, '') || '0';
  const timeIdx = String(tidx + 1).padStart(2, '0');
  const randSuffix = Math.random().toString(36).slice(2, 10);
  const fileName = `${seatNum}_${timeIdx}_${randSuffix}.jpg`;
  const filePath = `${folder}/${fileName}`;

  // 3. 上传到 Storage
  const { data: uploadData, error: uploadErr } = await _sb.storage.from(STORAGE_BUCKET)
    .upload(filePath, fullBlob, { contentType: 'image/jpeg', upsert: true });
  if (uploadErr) {
    console.error('[dl] Storage 上传失败:', uploadErr);
    return { success: false, error: 'Storage上传失败: ' + uploadErr.message };
  }

  // 4. 获取公开 URL
  const { data: publicUrlData } = _sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
  const imageUrl = publicUrlData?.publicUrl;
  if (!imageUrl || !imageUrl.startsWith('https://')) {
    console.error('[dl] 获取公开URL失败, publicUrlData:', publicUrlData);
    return { success: false, error: '获取公开URL失败: ' + (imageUrl || '空') };
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
async function dlDeletePhoto(photoId, url, ck) {
  let storageOk = true;
  // 0. 如果没有传 ck，先从数据库查询该图片的 cell_key（删除前查询）
  if (!ck) {
    try {
      const { data } = await _sb.from('seat_photos').select('cell_key').eq('id', photoId).maybeSingle();
      if (data) ck = data.cell_key;
    } catch (e) {}
  }
  // 1. 删除 Storage 文件（失败不阻断后续）
  if (url) {
    const path = extractStoragePath(url);
    if (path) {
      const { error: rmErr } = await _sb.storage.from(STORAGE_BUCKET).remove([path]);
      if (rmErr) { console.warn('[dl] Storage删除失败，继续清DB:', rmErr.message); storageOk = false; }
    }
  }
  // 2. 删除数据库记录（即使 Storage 失败也要删）
  const { error: dbErr } = await _sb.from('seat_photos').delete().eq('id', photoId);
  if (dbErr) return { success: false, error: '数据库删除失败: ' + dbErr.message };

  // 3. 【v2.3.0】增量删除缓存：仅移除被删除的图片，不清空整个 cell 缓存
  if (ck) {
    const cached = _cellDataCache.get(ck);
    if (cached) {
      const filtered = cached.filter(img => img.photo_id !== photoId);
      if (filtered.length > 0) {
        // 【v2.5.2】删除操作直接写缓存，绕过 safeSetCache 的空数组保护
        _cellDataCache.set(ck, filtered);
        _imageCountCache.set(ck, filtered.length);
        setLocalCache(ck, filtered);
      } else {
        // 全部删完了，直接清空缓存，绕过 safeDeleteCache 的上传锁保护
        _cellDataCache.delete(ck);
        _imageCountCache.delete(ck);
        clearLocalCache(ck);
      }
    } else {
      clearLocalCache(ck); // 缓存中无数据也清除 localStorage
    }
    // 标记该 photo_id 为已删除，防止 saveCellData 增量合并时恢复
    _deletedPhotoIds.add(photoId);
  }
  return { success: true, storageOk };
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
async function dbGetImageCounts() {
  // 【修复】按 cell_key 查询并分组，返回 Map<cellKey, count>
  // 旧版按 seat_id 查询返回 seatKey 格式的键（3段），与 imageCountCache 的 cellKey 格式（4段）不匹配，
  // 导致页面刷新后所有 cell 级计数查询返回 0，蓝色/橙色指示器全部消失
  const { data, error } = await _sb.from('seat_photos').select('cell_key');
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
  return result;
}

/** 区域级图片计数预加载：查询指定区域内所有座位的图片计数
 *  @param {number} fid 楼层ID
 *  @param {string} aname 区域名称
 *  @returns {Map<string, number>} Map<cellKey, count>
 */
async function dbGetAreaImageCounts(fid, aname) {
  const prefix = `${fid}-${aname}-`;
  // 使用 like 查询匹配该区域所有 cell_key
  const { data, error } = await _sb
    .from('seat_photos')
    .select('cell_key')
    .like('cell_key', `${prefix}%`);
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
    for (let i = 0; i < paths.length; i += 1000) await _sb.storage.from(STORAGE_BUCKET).remove(paths.slice(i, i+1000)).catch(()=>{});
  }
  for (let i = 0; i < ids.length; i += 500) await _sb.from('seat_photos').delete().in('id', ids.slice(i,i+500));
  console.warn('[CACHE] CLEAR ALL (dlDeletePhotosByAreaAndTime)'); _cellDataCache.clear(); _imageCountCache.clear();
  return data.length;
}

// ---- 协作密码 ----
async function dlGetCollabPasswords(floorId) {
  const today = getBjDateStr();
  const { data, error } = await _sb.from('collab_passwords')
    .select('*').eq('floor_id', String(floorId)).eq('date', today)
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

// ---- 报表自动生成（客户端兜底）----
/**
 * 检查是否需要自动生成今日报表，如果需要则触发生成
 * 条件：当前北京时间 >= 21:30 且今日报表尚未生成
 * 调用时机：init 完成后 + 每隔 5 分钟检查
 */
async function autoGenerateReport() {
  try {
    // 当前北京时间
    const now = new Date();
    const bjMs = now.getTime() + 8 * 60 * 60 * 1000;
    const bjDate = new Date(bjMs);
    const bjHour = bjDate.getUTCHours();
    const bjMin = bjDate.getUTCMinutes();
    const bjMinutes = bjHour * 60 + bjMin;

    // 未到 21:30 不触发
    if (bjMinutes < 1290) return; // 21:30 = 21*60+30 = 1290

    // 今日日期字符串
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    const todayStr = `${y}-${m}-${d}`;
    const reportFileName = `report_${todayStr}.xlsx`;

    // 检查今日报表是否已存在
    const { data, error } = await _sb.storage.from('reports').list('', {
      search: reportFileName,
      limit: 1
    });
    if (error) { console.warn('[auto-report] 检查报表失败:', error.message); return; }
    if (data && data.length > 0 && data[0].name === reportFileName) {
      return; // 报表已存在
    }

    // 今日报表不存在，触发生成
    console.log('[auto-report] 触发自动生成今日报表:', reportFileName);
    const { data: sessionData } = await _sb.auth.getSession();
    const token = sessionData?.session?.access_token || '';
    const resp = await fetch(SUPABASE_HOST + '/functions/v1/generate-report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (token || SUPABASE_ANON_KEY),
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action: 'generate' })
    });
    const result = await resp.json();
    if (result.success) {
      console.log('[auto-report] 生成成功:', result.filename);
    } else {
      console.warn('[auto-report] 生成失败:', result.error);
    }
  } catch (e) {
    console.warn('[auto-report] 自动生成异常:', e);
  }
}

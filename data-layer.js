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
  if (storeName === 'cells') { _cellDataCache.delete(key); _imageCountCache.delete(key); }
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
  if (_cellDataCache.has(ck)) return { key: ck, images: _cellDataCache.get(ck) };

  const { data, error } = await _sb.from('seat_photos')
    .select('id, url, status, uploaded_by, created_at, time_slot')
    .eq('cell_key', ck)
    .order('created_at', { ascending: true })
    .limit(3);
  if (error) { console.warn('[dl] getCellData error:', error); return { key: ck, images: [] }; }

  const images = (data || []).map(p => ({
    photo_id: p.id, url: p.url, status: p.status,
    uploaded_by: p.uploaded_by, created_at: p.created_at,
    thumbnail: p.url, time_slot: p.time_slot
  }));
  _cellDataCache.set(ck, images);
  return { key: ck, images };
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

  const { data, error } = await _sb.from('seat_photos')
    .select('id, url, status, cell_key, uploaded_by, created_at, time_slot')
    .in('cell_key', missing)
    .order('created_at', { ascending: true });
  if (error) { missing.forEach(ck => { result[ck] = { key: ck, images: [] }; }); return result; }

  const byCellKey = {};
  (data || []).forEach(p => { if (!byCellKey[p.cell_key]) byCellKey[p.cell_key] = []; if (byCellKey[p.cell_key].length < 3) byCellKey[p.cell_key].push(p); });

  missing.forEach(ck => {
    const photos = byCellKey[ck] || [];
    const images = photos.map(p => ({
      photo_id: p.id, url: p.url, status: p.status,
      uploaded_by: p.uploaded_by, created_at: p.created_at, thumbnail: p.url, time_slot: p.time_slot
    }));
    _cellDataCache.set(ck, images);
    result[ck] = { key: ck, images };
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
  for (const img of imgs) {
    if (img.photo_id) {
      // 已有 photo_id 的，直接保留
      successImgs.push(img);
    } else if (img.data || img._fullBlob) {
      // 新图片：上传 + 写库
      const result = await dlUploadPhoto(ck, img);
      if (result && result.success && result.url) {
        // 上传成功，img 对象已被 dlUploadPhoto 更新了 photo_id
        successImgs.push(img);
      } else {
        // 上传失败：绝不加入缓存，绝不写数据库
        console.error('[dl] 上传失败，跳过该图片，不写入数据库:', result?.error);
      }
    }
  }

  // 缓存更新：先删旧缓存再设新缓存，确保数据一致性
  _cellDataCache.delete(ck);
  _imageCountCache.delete(ck);
  if (successImgs.length > 0) {
    _cellDataCache.set(ck, successImgs);
    _imageCountCache.set(ck, successImgs.length);
  }
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
  console.log('[dl] 上传路径:', filePath);

  // 3. 上传到 Storage
  const { data: uploadData, error: uploadErr } = await _sb.storage.from(STORAGE_BUCKET)
    .upload(filePath, fullBlob, { contentType: 'image/jpeg', upsert: true });
  if (uploadErr) {
    console.error('[dl] Storage 上传失败:', uploadErr);
    return { success: false, error: 'Storage上传失败: ' + uploadErr.message };
  }
  console.log('[dl] Storage 上传成功, path:', uploadData?.path || filePath);

  // 4. 获取公开 URL（最关键一步）
  const { data: publicUrlData } = _sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
  const imageUrl = publicUrlData?.publicUrl;
  if (!imageUrl || !imageUrl.startsWith('https://')) {
    console.error('[dl] 获取公开URL失败, publicUrlData:', publicUrlData);
    return { success: false, error: '获取公开URL失败: ' + (imageUrl || '空') };
  }
  console.log('[dl] publicUrl:', imageUrl);

  // 5. 确保座位记录
  await ensureSeatRecord(seatLabel, fid, aname);

  // 6. 只有上传成功才写入数据库
  const { data, error } = await _sb.from('seat_photos').insert({
    seat_id: seatLabel, cell_key: ck, url: imageUrl,
    time_slot: timeSlot, status: img.status || 'occupied',
    uploaded_by: currentUser.uid
  }).select().single();

  if (error) {
    console.error('[dl] 数据库写入失败:', error);
    // DB 写入失败但文件已上传，返回部分成功（URL可用）
    return { success: false, error: '数据库写入失败: ' + error.message };
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
  _cellDataCache.set(ck, cached);
  _imageCountCache.set(ck, cached.length);

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

  // 3. 强制清空该 cell 的所有缓存，确保下次读取时从数据库重新获取
  if (ck) {
    _cellDataCache.delete(ck);
    _imageCountCache.delete(ck);
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
  const { data, error } = await _sb.from('seat_photos').select('seat_id');
  if (error) { console.warn('[dl] dbGetImageCounts error:', error); return new Map(); }
  const counts = new Map();
  (data || []).forEach(r => { counts.set(r.seat_id, (counts.get(r.seat_id) || 0) + 1); });
  const result = new Map();
  counts.forEach((cnt, seatId) => {
    for (const floor of FLOORS) {
      for (const area of floor.areas) {
        for (let si = 0; si < area.count; si++) {
          if (defaultSeatName(String(floor.id), area.name, si) === seatId) {
            result.set(seatKeyFromParts(String(floor.id), area.name, si), cnt);
          }
        }
      }
    }
  });
  _imageCountCache.clear();
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
  _cellDataCache.clear(); _imageCountCache.clear();
  return data.length;
}

// ---- 协作密码 ----
async function dlGetCollabPasswords(floorId) {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await _sb.from('collab_passwords')
    .select('*').eq('floor_id', String(floorId)).eq('date', today)
    .order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

async function dlCreateCollabPassword(floorId, maxUses, expiresAt) {
  const pwd = Math.random().toString(36).substring(2,8).toUpperCase();
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await _sb.from('collab_passwords').insert({
    password: pwd, floor_id: String(floorId), date: today,
    max_uses: maxUses || 8, used_count: 0,
    expires_at: expiresAt || new Date(Date.now() + 86400000).toISOString(),
    created_by: currentUser.uid
  }).select().single();
  return error ? null : data;
}

// ---- 清缓存 ----
function dlClearCache() { _imageCountCache.clear(); _cellDataCache.clear(); }
function dlInvalidateCell(ck) { _cellDataCache.delete(ck); _imageCountCache.delete(ck); }

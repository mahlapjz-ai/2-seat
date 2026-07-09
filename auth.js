// ============================================================
// 认证模块 v3 - 读者证号登录 + 协作扫码登录
// ============================================================

const SUPABASE_URL = 'https://cuejslqxatzkortnkdsf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1ZWpzbHF4YXR6a29ydG5rZHNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4OTk4OTAsImV4cCI6MjA5ODQ3NTg5MH0.T76oSi1ycI8xxBrybQsscR-eWM3ItJiKC_z3xaRglFE';
const EDGE_FUNCTION_URL = SUPABASE_URL + '/functions/v1/handle-assistant-login';

let _sb = null;
let _sbConfigured = false;

try {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    _sbConfigured = true;
  } else { console.error('[auth] Supabase SDK 未加载'); }
} catch (err) { console.error('[auth] 初始化失败:', err); }

// ---- 当前用户 ----
const currentUser = {
  uid: null, email: null, name: null, cardNumber: null, phone: null,
  role: null, managedFloors: [], assistantExpiresAt: null, loaded: false
};

function isSupabaseReady() { return _sbConfigured && _sb !== null; }
function getSupabaseClient() { return _sb; }

// 英文错误→中文映射
const _errMap = [
  [/\bcolumn reference \w+ is ambiguous\b/i, '数据库查询错误，请联系管理员'],
  [/\bnew row violates row-level security policy\b/i, '权限不足，无法完成操作'],
  [/\bInvalid key\b/i, '文件路径无效'],
  [/\bUnauthorized\b/i, '未授权，请重新登录'],
  [/\bInvalid login credentials\b/i, '证号或密码错误'],
  [/\bUser already registered\b/i, '该账号已注册，请直接登录'],
  [/\bEmail not confirmed\b/i, '账号未验证，请联系管理员'],
  [/\bNetwork request failed\b/i, '网络连接失败，请检查网络'],
  [/\bFailed to fetch\b/i, '网络连接失败，请检查网络'],
  [/\bJWT expired\b/i, '登录已过期，请重新登录'],
  [/\bnot found\b/i, '未找到相关数据'],
  [/\bduplicate key\b/i, '数据已存在，请勿重复操作'],
  [/\bviolates unique constraint\b/i, '数据已存在，请勿重复操作'],
  [/\bviolates foreign key constraint\b/i, '关联数据不存在，无法操作'],
  [/\bpermission denied\b/i, '权限不足，无法完成操作'],
  [/\bstorage\.object\b/i, '文件操作失败'],
  [/\bbucket not found\b/i, '存储空间不存在'],
  [/\bPayload too large\b/i, '文件过大，请压缩后重试'],
];

function translateErrMsg(msg) {
  if (!msg || typeof msg !== 'string') return msg;
  for (const [re, cn] of _errMap) {
    if (re.test(msg)) return cn;
  }
  return msg;
}

function extractErrMsg(err) {
  if (!err) return '';
  if (typeof err === 'string') return translateErrMsg(err);
  let raw = '';
  if (err.message && typeof err.message === 'string' && err.message.trim()) raw = err.message.trim();
  else if (err.msg) raw = err.msg;
  else if (err.error_description) raw = err.error_description;
  else if (err.error) raw = typeof err.error === 'string' ? err.error : extractErrMsg(err.error);
  else { try { const s = JSON.stringify(err); if (s && s !== '{}' && s !== '[]') raw = s; } catch (e) {} }
  return translateErrMsg(raw);
}

// ---- 读者证号注册 ----
async function signUpWithCard(cardNumber, password, name) {
  if (!isSupabaseReady()) return { success: false, error: 'Supabase 未配置' };
  if (!/^[A-Z0-9]{13,18}$/.test(cardNumber)) return { success: false, error: '读者证号应为13-18位大写字母或数字' };
  if (!password || password.length < 6) return { success: false, error: '密码至少6位' };
  // 校验注册开关
  try {
    const { data } = await _sb.from('settings').select('value').eq('key', 'registration_enabled').single();
    if (!data || data.value !== 'true') return { success: false, error: '注册功能未开放，请联系管理员' };
  } catch (e) { return { success: false, error: '注册功能未开放，请联系管理员' }; }
  try {
    const fakeEmail = `${cardNumber}@lib.internal`;
    const { data, error } = await _sb.auth.signUp({
      email: fakeEmail, password,
      options: { data: { name: name || '', card_number: cardNumber } }
    });
    if (error) return { success: false, error: extractErrMsg(error) || '注册失败' };
    if (!data.session) return { success: true, error: null, needsEmailConfirm: true };
    await loadUserProfile();
    return { success: true, error: null, user: currentUser };
  } catch (err) { return { success: false, error: extractErrMsg(err) || '注册请求失败' }; }
}

// ---- 读者证号登录 ----
async function signInWithCard(cardNumber, password) {
  if (!isSupabaseReady()) return { success: false, error: 'Supabase 未配置' };
  try {
    const fakeEmail = `${cardNumber}@lib.internal`;
    const { data, error } = await _sb.auth.signInWithPassword({ email: fakeEmail, password });
    if (error) {
      const msg = extractErrMsg(error);
      if (msg.includes('Invalid login credentials')) return { success: false, error: '证号或密码错误' };
      return { success: false, error: msg || '登录失败' };
    }
    await loadUserProfile();
    return { success: true, error: null, user: currentUser };
  } catch (err) { return { success: false, error: extractErrMsg(err) || '登录请求失败' }; }
}

// ---- 带超时的 fetch ----
async function fetchWithTimeout(url, opts, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('网络较慢，请稍候重试');
    throw err;
  }
}

// ---- 协作者扫码登录 ----
// 策略：先用 RPC（数据库函数，无冷启动），如果返回"新用户需创建"再走 Edge Function
async function assistantQRLogin(qrData, name, phone) {
  if (!isSupabaseReady()) return { success: false, error: 'Supabase 未配置' };
  try {
    // 第一步：通过 RPC 调用数据库函数校验密码+获取用户信息
    console.log('[auth] assistantQRLogin: 尝试 RPC...');
    const { data: rpcResult, error: rpcError } = await _sb.rpc('assistant_login', {
      p_password: qrData.password,
      p_floor_id: String(qrData.floor_id),
      p_name: name || '',
      p_phone: phone
    });
    console.log('[auth] assistantQRLogin RPC result:', { rpcResult, rpcError });

    if (rpcError) {
      return { success: false, error: extractErrMsg(rpcError) || '密码验证失败' };
    }

    const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
    if (!row) {
      return { success: false, error: '密码验证失败' };
    }

    // 如果是已有用户，RPC 返回了 uid → 直接用 Edge Function 获取 session
    if (row.uid && row.msg === '登录成功') {
      // 已有用户，通过 Edge Function 获取 session token
      const result = await callEdgeFunctionForSession(row.uid, phone);
      return result;
    }

    // 如果是新用户，需要 Edge Function 创建 Auth 账号
    if (row.msg === '新用户需由Edge Function创建') {
      console.log('[auth] 新用户，调用 Edge Function 创建账号...');
      const resp = await fetchWithTimeout(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ action: 'qr_login', qr_data: qrData, name, phone })
      }, 15000);
      const result = await resp.json();
      if (!result.success) return { success: false, error: result.error || '扫码登录失败' };
      if (result.access_token && result.refresh_token) {
        await _sb.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
      }
      await loadUserProfile();
      try { localStorage.setItem('assistant_uid', currentUser.uid); localStorage.setItem('assistant_phone', phone); } catch (e) {}
      return { success: true, error: null, user: currentUser };
    }

    // 其他错误消息
    return { success: false, error: row.msg || '密码验证失败' };
  } catch (err) {
    console.error('[auth] assistantQRLogin error:', err);
    return { success: false, error: extractErrMsg(err) || '扫码登录请求失败' };
  }
}

// ---- 通过 Edge Function 获取已有用户的 session ----
async function callEdgeFunctionForSession(uid, phone) {
  const resp = await fetchWithTimeout(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ action: 'get_session', uid })
  }, 15000);
  const result = await resp.json();
  if (!result.success) return { success: false, error: result.error || '获取session失败' };
  if (result.access_token && result.refresh_token) {
    await _sb.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
  }
  await loadUserProfile();
  try { localStorage.setItem('assistant_uid', currentUser.uid); localStorage.setItem('assistant_phone', phone); } catch (e) {}
  return { success: true, error: null, user: currentUser };
}

// ---- 协作者再次登录 ----
// 先尝试 RPC 查找，再走 Edge Function 获取 session
async function assistantReLogin(name, phone) {
  if (!isSupabaseReady()) return { success: false, error: 'Supabase 未配置' };
  try {
    console.log('[auth] assistantReLogin: 尝试 RPC 查找用户...');
    // 直接查 users 表找未过期的 assistant
    const { data: user, error } = await _sb.from('users')
      .select('uid, role, name')
      .eq('phone', phone)
      .eq('role', 'assistant')
      .gt('assistant_expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();
    console.log('[auth] assistantReLogin query:', { user, error });

    if (user) {
      // 找到了，通过 Edge Function 获取 session
      return await callEdgeFunctionForSession(user.uid, phone);
    }

    // 没找到，尝试 Edge Function
    console.log('[auth] assistantReLogin: 未找到本地记录，尝试 Edge Function...');
    const resp = await fetchWithTimeout(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ action: 're_login', name, phone })
    }, 15000);
    const result = await resp.json();
    if (!result.success) return { success: false, error: result.error || '登录失败' };
    if (result.access_token && result.refresh_token) {
      await _sb.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
    }
    await loadUserProfile();
    try { localStorage.setItem('assistant_uid', currentUser.uid); localStorage.setItem('assistant_phone', phone); } catch (e) {}
    return { success: true, error: null, user: currentUser };
  } catch (err) { return { success: false, error: extractErrMsg(err) || '登录请求失败' }; }
}

// ---- 协作者自动登录 ----
async function assistantAutoLogin() {
  try {
    const phone = localStorage.getItem('assistant_phone');
    if (!phone) return { success: false, error: '无设备绑定' };
    return await assistantReLogin('', phone);
  } catch (e) { return { success: false, error: '自动登录失败' }; }
}

// ---- 登出 ----
async function signOut() {
  try {
    if (_sb) await _sb.auth.signOut();
    resetCurrentUser();
    try { sessionStorage.removeItem('seat_user_profile'); localStorage.removeItem('assistant_uid'); localStorage.removeItem('assistant_phone'); } catch (e) {}
    window.location.href = 'login.html';
  } catch (err) { console.error('登出失败:', err); }
}

function resetCurrentUser() {
  Object.assign(currentUser, { uid: null, email: null, name: null, cardNumber: null, phone: null, role: null, managedFloors: [], assistantExpiresAt: null, loaded: false });
}

// ---- 获取 session ----
async function getSession() {
  if (!isSupabaseReady()) return null;
  try { const { data: { session } } = await _sb.auth.getSession(); return session; } catch (e) { return null; }
}

// ---- 加载用户角色 ----
async function loadUserProfile() {
  if (!isSupabaseReady()) return;
  // 【共享版】每次都从云端读取，不使用 sessionStorage 缓存（确保角色变更立即生效）
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) return;

  currentUser.uid = session.user.id;
  currentUser.email = session.user.email;
  currentUser.cardNumber = session.user.user_metadata?.card_number || '';
  currentUser.name = session.user.user_metadata?.name || '';

  try {
    const { data: profile, error } = await _sb.from('users')
      .select('uid, role, managed_floors, assistant_expires_at, name, card_number, phone')
      .eq('uid', session.user.id);
    if (error || !profile || profile.length === 0) {
      console.error('[auth] 查询用户角色失败:', error);
      currentUser.role = 'reader'; currentUser.managedFloors = [];
    } else {
      const p = profile[0]; // 取第一条
      currentUser.role = p.role || 'reader';
      currentUser.managedFloors = p.managed_floors || [];
      currentUser.assistantExpiresAt = p.assistant_expires_at;
      if (p.name) currentUser.name = p.name;
      if (p.card_number) currentUser.cardNumber = p.card_number;
      if (p.phone) currentUser.phone = p.phone;
    }
  } catch (err) { currentUser.role = 'reader'; currentUser.managedFloors = []; }

  await checkAssistantExpiry();
  currentUser.loaded = true;
  // 更新缓存
  try {
    sessionStorage.setItem('seat_user_profile', JSON.stringify({
      uid: currentUser.uid, email: currentUser.email, name: currentUser.name,
      cardNumber: currentUser.cardNumber, phone: currentUser.phone,
      role: currentUser.role, managedFloors: currentUser.managedFloors,
      assistantExpiresAt: currentUser.assistantExpiresAt, loaded: true
    }));
  } catch (e) {}
}

async function checkAssistantExpiry() {
  if (currentUser.role === 'assistant' && currentUser.assistantExpiresAt) {
    if (new Date(currentUser.assistantExpiresAt) <= new Date()) {
      currentUser.role = 'reader'; currentUser.managedFloors = [];
      currentUser.assistantExpiresAt = null;
      // 同步降级到数据库
      if (currentUser.uid && isSupabaseReady()) {
        try {
          await _sb.from('users').update({
            role: 'reader',
            managed_floors: null,
            assistant_expires_at: null
          }).eq('uid', currentUser.uid);
        } catch (e) { console.error('降级写入失败:', e); }
      }
    }
  }
}

// ---- 全局设置缓存 ----
const globalSettings = {};

async function loadGlobalSettings() {
  if (!isSupabaseReady()) return;
  try {
    const { data, error } = await _sb.from('settings').select('*');
    if (!error && data) {
      data.forEach(s => { globalSettings[s.key] = s.value; });
    }
  } catch(e) { console.warn('[auth] loadGlobalSettings error:', e); }
}

function isFeatureEnabled(key) {
  // owner始终可用
  if (currentUser.role === 'owner') return true;
  return globalSettings[key] === 'true';
}

// ---- 权限判断 ----
function canEditFloor(floorId) {
  if (!currentUser.loaded) return false;
  if (currentUser.role === 'owner' || currentUser.role === 'admin') return true;
  if (currentUser.role === 'floor_manager')
    return (currentUser.managedFloors || []).includes(String(floorId));
  if (currentUser.role === 'assistant') {
    if (currentUser.assistantExpiresAt && new Date(currentUser.assistantExpiresAt) <= new Date()) return false;
    return (currentUser.managedFloors || []).includes(String(floorId));
  }
  return false;
}
function canViewPhotos() { return currentUser.loaded && (currentUser.role !== 'reader' || isFeatureEnabled('reader_view_enabled')); }
function canManageUsers() { return currentUser.loaded && (currentUser.role === 'owner' || currentUser.role === 'admin'); }
function canManageFloors() { return currentUser.loaded && currentUser.role === 'owner'; }
function canManageSettings() { return currentUser.loaded && (currentUser.role === 'owner' || currentUser.role === 'admin'); }
function getViewableFloors() { if (!currentUser.loaded) return []; return ['1','2','3','4','5']; }
function getRoleDisplayName(r) { return { owner:'所有者', admin:'管理者', floor_manager:'辅专', assistant:'协助者', reader:'读者' }[r] || r; }
function getAssistantRemainingMinutes() {
  if (currentUser.role !== 'assistant' || !currentUser.assistantExpiresAt) return -1;
  return Math.max(0, Math.floor((new Date(currentUser.assistantExpiresAt) - new Date()) / 60000));
}

// ---- 扫码功能（html5-qrcode 库，最简配置） ----
let html5QrCode = null;

async function startQrScanner() {
  const container = document.getElementById('qrScannerContainer');
  container.style.display = 'block';

  if (html5QrCode) {
    await html5QrCode.stop().catch(() => {});
    html5QrCode = null;
  }

  html5QrCode = new Html5Qrcode("qrReader");

  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: 250,
        // [关键] 强制请求高清视频流
        videoConstraints: {
          width: { min: 1280, ideal: 1920 },
          height: { min: 720, ideal: 1080 },
          facingMode: "environment"
        }
      },
      (decodedText) => {
        handleCollaborateLogin(decodedText);
        stopQrScanner();
      },
      () => {}
    );
  } catch (err) {
    console.error('摄像头启动失败:', err);
    alert('无法打开摄像头，请检查是否授予了相机权限');
    stopQrScanner();
  }
}

async function stopQrScanner() {
  if (html5QrCode) {
    try {
      await html5QrCode.stop();
    } catch (e) {}
    html5QrCode = null;
  }
  document.getElementById('qrScannerContainer').style.display = 'none';
}

const _btnCloseScanner = document.getElementById('btnCloseScanner');
if (_btnCloseScanner) _btnCloseScanner.addEventListener('click', stopQrScanner);

async function handleCollaborateLogin(decodedText) {
  let qr; try { qr = JSON.parse(decodedText); } catch (e) { return; }
  if (!qr.password || !qr.floor_id) return;
  const name = document.getElementById('collab-name').value.trim();
  const phone = document.getElementById('collab-phone').value.trim();
  const btn = document.getElementById('btn-collab-scan');
  const errEl = document.getElementById('collab-error');
  if (btn) { btn.classList.add('loading'); btn.disabled = true; btn.setAttribute('data-loading-text', '正在验证...'); }
  if (errEl) errEl.className = 'login-error err';
  try {
    // 【重复注册优化】先检查该手机号是否已注册
    const { data: existingUser } = await _sb.from('users').select('uid, role, name, managed_floors').eq('phone', phone).maybeSingle();

    let r;
    if (existingUser) {
      // 已注册用户（reader或assistant）扫码：一律覆盖权限，消耗密码次数
      const now = new Date();
      const hours = now.getHours(), mins = now.getMinutes();
      let expireAt;
      // 早班08:30-13:14过期时间12:30，晚班13:15-17:30过期时间17:30
      if (hours < 13 || (hours === 13 && mins <= 14)) expireAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 30);
      else expireAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 30);
      await _sb.from('users').update({
        role: 'assistant',
        managed_floors: [String(qr.floor_id)],
        assistant_expires_at: expireAt.toISOString()
      }).eq('uid', existingUser.uid);
      await _sb.rpc('increment_collab_usage', { p_password: qr.password }).catch(() => {});
      r = await callEdgeFunctionForSession(existingUser.uid, phone);
    } else {
      r = await assistantQRLogin(qr, name, phone);
    }

    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    if (r.success) location.href = 'index.html';
    else { if (errEl) { errEl.textContent = r.error || '扫码登录失败'; errEl.className = 'login-error show err'; } }
  } catch (e) {
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    if (errEl) { errEl.textContent = '扫码登录出错'; errEl.className = 'login-error show err'; }
  }
}

// ---- Auth 状态监听 ----
if (_sb) {
  _sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) loadUserProfile();
    else if (event === 'SIGNED_OUT') { resetCurrentUser(); try { sessionStorage.removeItem('seat_user_profile'); } catch (e) {} }
  });
}

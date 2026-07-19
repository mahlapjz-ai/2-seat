// ============================================================
// 认证模块 v3 - 读者证号登录 + 协作扫码登录
// ============================================================

// 获取北京时间日期字符串 YYYY-MM-DD（与数据库 RPC/Edge Function 保持一致）
function getBjDateStr() {
  const d = new Date(Date.now() + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const SUPABASE_URL = 'https://cuejslqxatzkortnkdsf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1ZWpzbHF4YXR6a29ydG5rZHNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4OTk4OTAsImV4cCI6MjA5ODQ3NTg5MH0.T76oSi1ycI8xxBrybQsscR-eWM3ItJiKC_z3xaRglFE';
const EDGE_FUNCTION_URL = SUPABASE_URL + '/functions/v1/handle-assistant-login';

let _sb = null;
let _sbConfigured = false;

try {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 10 } }
    });
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
  // 【v2.7.29】密码规则：6-16位，必须同时包含数字和字母
  if (!password || password.length < 6 || password.length > 16 || !/\d/.test(password) || !/[a-zA-Z]/.test(password)) return { success: false, error: '密码6-16位，需同时包含数字和字母' };
  // 校验注册开关
  try {
    const { data } = await _sb.from('settings').select('value').eq('key', 'registration_enabled').single();
    if (!data || data.value !== 'true') return { success: false, error: '注册功能未开放，请联系管理员' };
  } catch (e) { return { success: false, error: '注册功能未开放，请联系管理员' }; }
  try {
    const fakeEmail = `${cardNumber}@lib.internal`;
    const displayName = name || cardNumber || '用户'; // 【v2.7.8】统一 name 变量，确保 auth 和 public.users 一致
    const { data, error } = await _sb.auth.signUp({
      email: fakeEmail, password,
      options: { data: { name: displayName, card_number: cardNumber } }
    });
    if (error) {
      // 【修复】如果 auth 用户已存在（之前删除 public.users 但 auth.users 残留），尝试直接登录并补写 public.users
      if (error.message && (error.message.includes('already') || error.message.includes('already registered') || error.message.includes('User already registered'))) {
        console.log('[auth] signUp 报已注册，尝试直接登录并补写 public.users');
        const signInResult = await _sb.auth.signInWithPassword({ email: fakeEmail, password });
        if (signInResult.error) return { success: false, error: '该证号已注册，请直接登录' };
        // 登录成功，检查 public.users 是否存在
        const uid = signInResult.data.user?.id;
        if (uid) {
          // 【v2.7.8】同步更新 auth user_metadata.name
          try { await _sb.auth.updateUser({ data: { name: displayName, card_number: cardNumber } }); } catch (e) { /* 静默 */ }
          const { data: existingUser } = await _sb.from('users').select('uid').eq('uid', uid).maybeSingle();
          if (!existingUser) {
            // public.users 不存在，手动补写
            console.log('[auth] public.users 缺失，补写 uid:', uid);
            await _sb.from('users').upsert({
              uid, name: displayName, card_number: cardNumber, role: 'reader',
            }, { onConflict: 'uid' });
          }
        }
        await loadUserProfile();
        return { success: true, error: null, user: currentUser };
      }
      return { success: false, error: extractErrMsg(error) || '注册失败' };
    }
    // signUp 成功，显式确保 public.users 存在（不依赖 trigger）
    const uid = data.user?.id;
    if (uid) {
      console.log('[注册] 准备确保 public.users 存在, uid:', uid);
      const { data: existingUser } = await _sb.from('users').select('uid').eq('uid', uid).maybeSingle();
      if (!existingUser) {
        console.log('[注册] public.users 缺失，补写 uid:', uid);
        const { error: insertError } = await _sb.from('users').upsert({
          uid, name: displayName, card_number: cardNumber, role: 'reader',
        }, { onConflict: 'uid' });
        if (insertError) console.error('[注册] 插入 public.users 失败:', insertError);
        else console.log('[注册] 插入 public.users 成功');
      } else {
        console.log('[注册] public.users 已存在（trigger 正常写入）');
      }
    }
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
    // 【修复】登录成功后检查 public.users 是否存在（防止 auth 用户残留但 public.users 被删）
    const uid = data.user?.id;
    if (uid) {
      const { data: existingUser } = await _sb.from('users').select('uid').eq('uid', uid).maybeSingle();
      if (!existingUser) {
        console.log('[auth] 登录时发现 public.users 缺失，补写 uid:', uid);
        // name 有 NOT NULL 约束，从 auth user_metadata 或邮箱前缀取默认值
        const authName = signInResult.data.user?.user_metadata?.name || cardNumber || signInResult.data.user?.email?.split('@')[0] || '用户';
        await _sb.from('users').upsert({
          uid, name: authName, card_number: cardNumber, role: 'reader',
        }, { onConflict: 'uid' });
      }
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
// 直接调用 Edge Function handle-assistant-login 统一处理密码校验、用户创建/更新、session 生成
async function assistantQRLogin(qrData, name, phone) {
  if (!isSupabaseReady()) return { success: false, error: 'Supabase 未配置' };
  try {
    // 直接调用 Edge Function 统一处理：密码校验 + 用户创建/更新 + session 生成
    console.log('[auth] assistantQRLogin: 调用 Edge Function...');
    const resp = await fetchWithTimeout(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ action: 'qr_login', qr_data: qrData, name, phone })
    }, 15000);
    const result = await resp.json();
    console.log('[auth] assistantQRLogin Edge Function result:', result.success ? '成功' : result.error);

    if (!result.success) return { success: false, error: result.error || '扫码登录失败' };

    // 设置 session
    if (result.access_token && result.refresh_token) {
      await _sb.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
    }
    // 【修复】优先使用 Edge Function 返回的角色信息，而非仅依赖 loadUserProfile
    // 先从 session 获取 uid/email，再直接设置角色（不依赖 RLS 查询）
    const savedRole = result.role || null;
    const savedFloors = result.managed_floors || [];
    const savedExpires = result.assistant_expires_at || null;
    if (savedRole) {
      const { data: { session: newSession } } = await _sb.auth.getSession();
      if (newSession) {
        currentUser.uid = newSession.user.id;
        currentUser.email = newSession.user.email;
      }
      currentUser.role = savedRole;
      currentUser.managedFloors = savedFloors;
      currentUser.assistantExpiresAt = savedExpires;
      if (result.name) currentUser.name = result.name;
      if (result.phone) currentUser.phone = result.phone;
      currentUser.loaded = true;
      console.log('[auth] 从 Edge Function 返回值设置角色:', savedRole, '楼层:', savedFloors, '过期:', savedExpires);
    }
    // 调用 loadUserProfile 从数据库强制刷新，补充 card_number 等字段
    await loadUserProfile();
    console.log('[auth] loadUserProfile 后角色:', currentUser.role, '楼层:', currentUser.managedFloors);
    // 【v2.7.35】信任数据库结果：如果数据库已将角色降级为 reader（密码被吊销或过期），
    // 不再恢复 assistant。仅当 savedExpires 未过期且数据库角色仍为 assistant 时才正常使用。
    if (savedRole === 'assistant' && currentUser.role === 'reader') {
      const isExpired = savedExpires && new Date(savedExpires) <= new Date();
      console.warn('[auth] 数据库已降级为 reader，savedExpires 是否过期:', isExpired);
      if (typeof showToast === 'function') showToast('您的协助者权限已变更（可能已过期或被吊销）', 3000);
    }
    console.log('[auth] 最终角色:', currentUser.role, '楼层:', currentUser.managedFloors, '过期:', currentUser.assistantExpiresAt);
    try { localStorage.setItem('shared_assistant_uid', currentUser.uid); localStorage.setItem('shared_assistant_phone', phone); } catch (e) {}
    // 【v2.7.25】激活记录已由 Edge Function 写入，客户端不再重复写入
    return { success: true, error: null, user: currentUser };
  } catch (err) {
    console.error('[auth] assistantQRLogin error:', err);
    return { success: false, error: extractErrMsg(err) || '扫码登录请求失败' };
  }
}

// ---- 写入协作激活日志 ----
async function logCollabActivation(qrData, assistantUid) {
  try {
    // 查询 collab_passwords 获取 password_id
    const today = getBjDateStr();
    const { data: cp } = await _sb.from('collab_passwords')
      .select('id, created_by')
      .eq('password', qrData.password)
      .eq('floor_id', String(qrData.floor_id))
      .eq('date', today)
      .maybeSingle();
    if (cp) {
      await _sb.from('collab_activation_logs').insert({
        password_id: cp.id,
        assistant_uid: assistantUid
      });
      // 【修复】如果密码的 created_by 为空，用扫码的辅专 uid 补上
      const granterUid = qrData.granter_uid || qrData.manager_uid || null;
      if (granterUid && !cp.created_by) {
        await _sb.from('collab_passwords').update({ created_by: granterUid }).eq('id', cp.id);
      }
    }
  } catch (e) {
    console.warn('[auth] 写入激活日志失败:', e);
  }
}

// ---- 通过 Edge Function 获取已有用户的 session ----
async function callEdgeFunctionForSession(uid, phone, qrData) {
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
  // 优先使用 Edge Function 返回的角色信息
  const savedRole = result.role || null;
  const savedFloors = result.managed_floors || [];
  const savedExpires = result.assistant_expires_at || null;
  if (savedRole) {
    const { data: { session: newSession } } = await _sb.auth.getSession();
    if (newSession) {
      currentUser.uid = newSession.user.id;
      currentUser.email = newSession.user.email;
    }
    currentUser.role = savedRole;
    currentUser.managedFloors = savedFloors;
    currentUser.assistantExpiresAt = savedExpires;
    if (result.name) currentUser.name = result.name;
    if (result.phone) currentUser.phone = result.phone;
    currentUser.loaded = true;
    console.log('[auth] callEdgeFunctionForSession 设置角色:', savedRole, '楼层:', savedFloors);
  }
  await loadUserProfile();
  // 【v2.7.35】信任数据库结果：仅提示权限变更，不再恢复 assistant
  if (savedRole === 'assistant' && currentUser.role === 'reader') {
    console.warn('[auth] 数据库已降级为 reader');
    if (typeof showToast === 'function') showToast('您的协助者权限已变更（可能已过期或被吊销）', 3000);
  }
  try { localStorage.setItem('shared_assistant_uid', currentUser.uid); localStorage.setItem('shared_assistant_phone', phone); } catch (e) {}
  // 【v2.7.25】激活记录已由 Edge Function 写入，客户端不再重复写入
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
    // 优先使用 Edge Function 返回的角色信息
    const savedRole = result.role || null;
    const savedFloors = result.managed_floors || [];
    const savedExpires = result.assistant_expires_at || null;
    if (savedRole) {
      const { data: { session: newSession } } = await _sb.auth.getSession();
      if (newSession) {
        currentUser.uid = newSession.user.id;
        currentUser.email = newSession.user.email;
      }
      currentUser.role = savedRole;
      currentUser.managedFloors = savedFloors;
      currentUser.assistantExpiresAt = savedExpires;
      if (result.name) currentUser.name = result.name;
      if (result.phone) currentUser.phone = result.phone;
      currentUser.loaded = true;
      console.log('[auth] assistantReLogin 设置角色:', savedRole, '楼层:', savedFloors);
    }
    await loadUserProfile();
    // 【v2.7.35】信任数据库结果：不再恢复 assistant 角色
    if (savedRole === 'assistant' && currentUser.role === 'reader') {
      console.warn('[auth] 数据库已降级为 reader');
      if (typeof showToast === 'function') showToast('您的协助者权限已变更（可能已过期或被吊销）', 3000);
    }
    try { localStorage.setItem('shared_assistant_uid', currentUser.uid); localStorage.setItem('shared_assistant_phone', phone); } catch (e) {}
    return { success: true, error: null, user: currentUser };
  } catch (err) { return { success: false, error: extractErrMsg(err) || '登录请求失败' }; }
}

// ---- 协作者自动登录 ----
async function assistantAutoLogin() {
  try {
    const phone = localStorage.getItem('shared_assistant_phone');
    if (!phone) return { success: false, error: '无设备绑定' };
    return await assistantReLogin('', phone);
  } catch (e) { return { success: false, error: '自动登录失败' }; }
}

// ---- 多设备登录：已取消 session_token 互踢机制（v2.7.32） ----
// 允许多设备同时登录同一账号，不再生成/检查 session_token
// users 表的 session_token 字段保留不动，但前端不再使用

// ---- 登出 ----
let _authListener = null; // 保存监听器引用，登出时取消

async function signOut() {
  try {
    // 1. 取消 auth 状态监听，防止 SIGNED_IN 事件触发自动恢复
    if (_authListener) {
      try { _authListener.subscription.unsubscribe(); } catch (e) {}
      _authListener = null;
    }
    // 2. 停止轮询
    if (typeof stopPolling === 'function') stopPolling();
    // 3. 调用 Supabase 登出
    if (_sb) {
      try { await _sb.auth.signOut(); } catch (e) { console.warn('[signOut] signOut 调用异常:', e); }
    }
    // 4. 重置用户状态
    resetCurrentUser();
    // 5. 彻底清除所有 Supabase session 残留（sb-* 键）+ 业务缓存
    try {
      // 【v2.7.15】清空预签名 URL 内存缓存
      if (typeof clearPresignedUrlCache === 'function') clearPresignedUrlCache();
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('sb-') || key.startsWith('supabase'))) {
          localStorage.removeItem(key);
        }
      }
      sessionStorage.removeItem('shared_seat_user_profile');
      localStorage.removeItem('shared_assistant_uid');
      localStorage.removeItem('shared_assistant_phone');
      // 【v2.7.32】清理可能残留的旧 session_token（已弃用，仅做历史清理）
      localStorage.removeItem('seat_session_token');
      localStorage.removeItem('shared_seat_session_token');
    } catch (e) {}
    // 6. 跳转登录页
    window.location.href = 'login.html';
  } catch (err) {
    console.error('登出失败:', err);
    // 即使失败也强制跳转
    window.location.href = 'login.html';
  }
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
      console.error('[auth] 查询用户角色失败:', error, 'uid:', session.user.id);
      currentUser.role = 'reader'; currentUser.managedFloors = [];
    } else {
      const p = profile[0]; // 取第一条
      console.log('[auth] loadUserProfile 查到:', { role: p.role, managed_floors: p.managed_floors, assistant_expires_at: p.assistant_expires_at });
      currentUser.role = p.role || 'reader';
      currentUser.managedFloors = p.managed_floors || [];
      currentUser.assistantExpiresAt = p.assistant_expires_at;
      if (p.name) currentUser.name = p.name;
      if (p.card_number) currentUser.cardNumber = p.card_number;
      if (p.phone) currentUser.phone = p.phone;
    }
  } catch (err) { currentUser.role = 'reader'; currentUser.managedFloors = []; }
  // 【v2.7.16】预热当前用户姓名到缓存，供历史图片水印使用
  if (typeof _preWarmCurrentUserName === 'function') {
    _preWarmCurrentUserName(currentUser.uid, currentUser.name);
  }

  await checkAssistantExpiry();
  currentUser.loaded = true;
  // 【v2.7.32】已取消单设备登录机制，允许多设备同时登录
  // 更新缓存
  try {
    sessionStorage.setItem('shared_seat_user_profile', JSON.stringify({
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

// 【v2.7.31】受角色权限控制的功能开关清单（共10个）
const ROLE_BASED_FEATURES = [
  'feat_batch_download',      // 批量下载
  'feat_bottom_download',     // 底部下载按钮
  'feat_zip_download',        // 打包下载（ZIP）
  'feat_clear_images',       // 清除图片
  'feat_photo_download',     // 拍照后下载
  'feat_delete_seat',        // 允许删除座位
  'feat_reset_app',          // 重置应用
  'feat_rename_seat',        // 修改座位编号名称
  'feat_add_seat',           // 添加座位按钮
  'feat_preview_save'        // 全屏预览保存图片
];

async function loadGlobalSettings() {
  if (!isSupabaseReady()) return;
  try {
    const { data, error } = await _sb.from('settings').select('*');
    if (!error && data) {
      data.forEach(s => {
        let val = s.value;
        // 【v2.7.31】对受角色控制的功能开关进行旧数据迁移：'true'/'false' → JSON
        if (ROLE_BASED_FEATURES.includes(s.key) && typeof val === 'string') {
          if (val === 'true') val = JSON.stringify({ admin: true, floor_manager: true });
          else if (val === 'false') val = JSON.stringify({ admin: false, floor_manager: false });
          // 已是 JSON 字符串则保持不变
        }
        globalSettings[s.key] = val;
      });
    }
  } catch(e) { console.warn('[auth] loadGlobalSettings error:', e); }
}

/**
 * 旧 API：保留向后兼容
 * - 受角色控制的开关：根据当前用户角色判断
 * - 其他开关（feat_area_drag_sort、reader_view_enabled 等）：保留原 value === 'true' 判断
 */
function isFeatureEnabled(key) {
  // owner 始终可用
  if (currentUser.role === 'owner') return true;
  // 受角色控制的开关：走 canUseFeature
  if (ROLE_BASED_FEATURES.includes(key)) return canUseFeature(key, currentUser.role);
  // 其他开关：assistant 和 reader 不可用
  if (currentUser.role === 'assistant' || currentUser.role === 'reader') return false;
  return globalSettings[key] === 'true';
}

/**
 * 【v2.7.31】按角色授权的功能权限判断
 * - owner 永远可用
 * - assistant / reader 永远不可用
 * - admin / floor_manager 根据 settings 中存储的 JSON 对象判断
 */
function canUseFeature(featureKey, userRole) {
  if (userRole === 'owner') return true;
  if (userRole === 'assistant' || userRole === 'reader') return false;
  const setting = getFeatureSetting(featureKey);
  if (userRole === 'admin') return setting?.admin === true;
  if (userRole === 'floor_manager') return setting?.floor_manager === true;
  return false;
}

/** 解析 settings 中的 JSON 权限对象（兼容旧字符串格式） */
function getFeatureSetting(featureKey) {
  const raw = globalSettings[featureKey];
  if (!raw) return { admin: false, floor_manager: false };
  if (typeof raw === 'object') return raw;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return obj;
  } catch (e) { /* 解析失败，按旧格式处理 */ }
  // 旧格式：'true' / 'false'
  if (raw === 'true') return { admin: true, floor_manager: true };
  return { admin: false, floor_manager: false };
}

// ---- 权限判断 ----
function canEditFloor(floorId) {
  if (!currentUser.loaded) return false;
  if (currentUser.role === 'owner' || currentUser.role === 'admin') return true;
  if (currentUser.role === 'floor_manager' || currentUser.role === 'assistant') {
    if (currentUser.role === 'assistant' && currentUser.assistantExpiresAt && new Date(currentUser.assistantExpiresAt) <= new Date()) return false;
    const floors = (currentUser.managedFloors || []).map(f => String(f));
    return floors.includes(String(floorId));
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
        stopQrScanner();
        handleCollaborateLogin(decodedText);
      },
      (errorMessage) => {
        console.debug('[QR] 解码中...（持续尝试）');
      }
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
  // 【v2.7.21】清理 BOM/前后空白/不可见字符，防止 JSON.parse 失败
  const cleanText = decodedText.replace(/^\uFEFF/, '').trim();
  console.log('[auth] 扫码原始数据:', decodedText);
  console.log('[auth] 清理后数据:', cleanText);
  const errEl = document.getElementById('collab-error');
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.className = 'login-error show err'; } };

  let qr;
  try {
    qr = JSON.parse(cleanText);
  } catch (e) {
    console.error('[auth] 二维码解析失败:', e, '原始数据前200字符:', decodedText.slice(0, 200));
    showErr('二维码格式无效，请确认扫描的是协作二维码');
    return;
  }
  console.log('[auth] 解析后参数:', qr);
  // 【v2.7.24】解码 granter_name（URL 编码后的中文姓名），兼容旧版未编码的二维码
  if (qr.granter_name) {
    try {
      qr.granter_name = decodeURIComponent(qr.granter_name);
    } catch (e) {
      console.warn('[auth] granter_name decodeURIComponent 失败，保留原值:', qr.granter_name);
    }
  }
  if (!qr.password || !qr.floor_id) {
    console.error('[auth] 缺少必要字段: password=%s, floor_id=%s', qr.password, qr.floor_id, '完整对象:', qr);
    showErr('二维码缺少必要字段，请让出示方重新生成');
    return;
  }
  const name = document.getElementById('collab-name').value.trim();
  const phone = document.getElementById('collab-phone').value.trim();
  const btn = document.getElementById('btn-collab-scan');
  if (btn) { btn.classList.add('loading'); btn.disabled = true; btn.setAttribute('data-loading-text', '正在验证...'); }
  if (errEl) errEl.className = 'login-error err';
  // 【v2.7.29】扫码后增加 Loading 提示：屏幕中央显示"正在验证…"
  const loadingMask = document.createElement('div');
  loadingMask.className = 'qr-loading-mask';
  loadingMask.innerHTML = '<div class="qr-loading-card"><div class="qr-loading-spinner"></div><div class="qr-loading-text">正在验证…</div></div>';
  document.body.appendChild(loadingMask);
  try {
    // 统一走 Edge Function 校验密码（无论是否已有用户）
    const r = await assistantQRLogin(qr, name, phone);

    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    loadingMask.remove();
    if (r.success) location.href = 'index.html';
    else { showErr(r.error || '扫码登录失败'); }
  } catch (e) {
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    loadingMask.remove();
    console.error('[auth] 扫码登录异常:', e);
    showErr('扫码登录出错：' + (e.message || '未知错误'));
  }
}

// ---- Auth 状态监听 ----
if (_sb) {
  _authListener = _sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) loadUserProfile();
    else if (event === 'SIGNED_OUT') { resetCurrentUser(); try { sessionStorage.removeItem('shared_seat_user_profile'); } catch (e) {} }
  });
}

// ---- 【v2.7.35】页面可见时强制刷新用户角色 ----
// 防止密码被吊销或过期后，协助者在本设备仍保留 assistant 角色
let _visibilityReloading = false;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!isSupabaseReady() || !currentUser.uid) return;
  if (_visibilityReloading) return; // 防止重复触发
  _visibilityReloading = true;
  try {
    const prevRole = currentUser.role;
    const prevExpires = currentUser.assistantExpiresAt;
    await loadUserProfile();
    // 如果角色被降级，提示用户并触发 UI 刷新事件
    if (prevRole !== 'reader' && currentUser.role === 'reader') {
      console.warn('[auth] visibilitychange 检测到角色被降级:', prevRole, '→', currentUser.role);
      if (typeof showToast === 'function') showToast('您的权限已变更，页面将刷新', 3000);
      // 通知主应用 UI 刷新（通过自定义事件，scripts.js 可监听）
      window.dispatchEvent(new CustomEvent('role-changed', { detail: { from: prevRole, to: currentUser.role } }));
      // 1.5 秒后刷新页面，确保所有 UI 都按新角色重新渲染
      setTimeout(() => location.reload(), 1500);
    } else if (prevExpires !== currentUser.assistantExpiresAt) {
      console.log('[auth] visibilitychange 检测到过期时间变更:', prevExpires, '→', currentUser.assistantExpiresAt);
      window.dispatchEvent(new CustomEvent('role-changed', { detail: { from: prevRole, to: currentUser.role } }));
    }
  } catch (e) {
    console.warn('[auth] visibilitychange 刷新失败:', e);
  } finally {
    _visibilityReloading = false;
  }
});

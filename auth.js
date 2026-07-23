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

// 【v2.7.51】两设备登录限制：当前设备 token 存储 key
// localStorage 用于跨页面持久化（login.html → index.html），sessionStorage 用于当前会话
const _DEVICE_TOKEN_LS_KEY = 'shared_device_token';
// 【v2.7.54】"本设备 token 已注册到 device_tokens" 标记 key
//  - enforceDeviceLimit 成功写入 token 后设置 '1'
//  - clearDeviceToken / signOut 时清除
//  - checkDeviceStillValid 中用于区分"新设备正在登录（未注册）"和"旧设备已被踢出（已注册但 DB 中查不到）"
const _DEVICE_TOKEN_REGISTERED_KEY = 'shared_device_token_registered';

/** 【v2.7.51】获取当前设备 token（如不存在则生成并持久化）
 *  token 在登出时清除，每次登录生成新 token，确保唯一性
 */
function getOrCreateDeviceToken() {
  try {
    let token = localStorage.getItem(_DEVICE_TOKEN_LS_KEY);
    if (!token) {
      // crypto.randomUUID() 在 HTTPS / localhost / PWA 中可用
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        token = crypto.randomUUID();
      } else {
        // 回退方案：基于时间戳+随机数
        token = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
      }
      localStorage.setItem(_DEVICE_TOKEN_LS_KEY, token);
    }
    return token;
  } catch (e) {
    // localStorage 不可用，回退到内存变量
    if (!window._deviceTokenFallback) {
      window._deviceTokenFallback = 'fallback-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
    }
    return window._deviceTokenFallback;
  }
}

/** 【v2.7.51】清除当前设备 token（登出时调用） */
function clearDeviceToken() {
  try { localStorage.removeItem(_DEVICE_TOKEN_LS_KEY); } catch (e) {}
  // 【v2.7.54】同步清除"已注册"标记，下次登录重新走 enforceDeviceLimit 流程
  try { localStorage.removeItem(_DEVICE_TOKEN_REGISTERED_KEY); } catch (e) {}
  if (window._deviceTokenFallback) delete window._deviceTokenFallback;
}

/** 【v2.7.54】标记当前设备 token 已成功写入 device_tokens（enforceDeviceLimit 成功后调用） */
function markDeviceTokenRegistered() {
  try { localStorage.setItem(_DEVICE_TOKEN_REGISTERED_KEY, '1'); } catch (e) {}
}

/** 【v2.7.54】检查当前设备 token 是否已注册到 device_tokens
 *  - true：已注册，若 DB 中查不到则视为被踢出
 *  - false：未注册（新设备正在登录流程中），跳过被踢检测
 */
function isDeviceTokenRegistered() {
  try { return localStorage.getItem(_DEVICE_TOKEN_REGISTERED_KEY) === '1'; } catch (e) { return false; }
}

/** 【v2.7.54】设备登录限制专用确认弹窗（不依赖 scripts.js 的 showCustomConfirm）
 *  原因：login.html 只引用 auth.js，不引用 scripts.js，导致 showCustomConfirm 未定义
 *        enforceDeviceLimit 调用 showCustomConfirm 时抛 ReferenceError，走 catch 分支
 *        return true 但不设置 registered 标记，token 也没写入 DB
 *  本函数内联样式，不依赖外部 CSS，确保在 login.html 和 index.html 都能正常工作
 *  按钮顺序：取消（左）/ 确定（右）
 *  @param {string} message - 提示文案
 *  @param {object} options - { cancelText, okText }
 *  @returns {Promise<boolean>} true=确定，false=取消
 */
function showDeviceConfirm(message, options = {}) {
  const cancelText = (options && options.cancelText) || '取消';
  const okText = (options && options.okText) || '确定';
  return new Promise((resolve) => {
    // 如果页面已有 showCustomConfirm（scripts.js 已加载），优先使用
    if (typeof showCustomConfirm === 'function') {
      showCustomConfirm(message, options).then(resolve);
      return;
    }
    // 否则使用内联样式的独立弹窗
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:8px;padding:24px 20px 16px;max-width:300px;width:80%;box-shadow:0 4px 16px rgba(0,0,0,0.12);';
    const textEl = document.createElement('div');
    textEl.style.cssText = 'font-size:15px;color:#333;line-height:1.5;text-align:center;margin-bottom:20px;word-break:break-word;';
    textEl.textContent = message;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:12px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = cancelText;
    cancelBtn.style.cssText = 'flex:1;padding:10px 16px;border:none;border-radius:4px;background:#f5f5f5;color:#666;font-size:14px;cursor:pointer;';
    const okBtn = document.createElement('button');
    okBtn.textContent = okText;
    okBtn.style.cssText = 'flex:1;padding:10px 16px;border:none;border-radius:4px;background:#1890ff;color:#fff;font-size:14px;cursor:pointer;';
    btns.appendChild(cancelBtn);
    btns.appendChild(okBtn);
    box.appendChild(textEl);
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    // 触发过渡动画
    overlay.offsetHeight;
    overlay.style.opacity = '1';
    const close = (result) => {
      overlay.style.opacity = '0';
      setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 200);
      resolve(result);
    };
    cancelBtn.onclick = () => close(false);
    okBtn.onclick = () => close(true);
    // 点击遮罩层视为取消
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
  });
}

/** 【v2.7.51】两设备登录限制：将当前设备 token 写入 users.device_tokens
 *  - 第 1、2 台设备：直接写入
 *  - 第 3 台设备：弹出确认框，用户同意后踢出最早登录的设备
 *
 *  @param {string} uid - 用户 uid
 *  @param {string} currentToken - 当前设备 token
 *  @returns {Promise<boolean>} true 表示继续登录，false 表示用户取消登录
 *
 *  【v2.7.52】修复紧急 BUG：登录后立刻提示"账号已在其他设备登录"（已废弃）
 *  【v2.7.53】彻底重构：
 *  - 改用 RPC 函数 register_device_token 绕过 RLS，确保写入成功
 *  - 删除"等待 1 秒"逻辑（RPC 同步返回后即可保证一致性）
 *  - RPC 返回最新 tokens，立即用于判断是否需要踢出
 *  - 写入失败时阻塞登录并提示用户（避免静默失败导致限制失效）
 */
async function enforceDeviceLimit(uid, currentToken) {
  if (!isSupabaseReady() || !uid || !currentToken) return true;
  // 【v2.7.53】标记登录时间，checkDeviceStillValid 在 30 秒宽限期内不检查被踢
  // 避免登录写入 device_tokens 与轮询读取之间的时序冲突
  _markDeviceLoginTime();
  try {
    // 【v2.7.53】优先使用 RPC 函数 register_device_token（绕过 RLS，确保写入成功）
    // RPC 函数内部逻辑：
    //   1. 查询当前 device_tokens
    //   2. 如果当前 token 已存在：仅更新 login_time，返回 { tokens, action: 'updated' }
    //   3. 如果当前 token 不存在且 tokens.length < 2：添加新 token，返回 { tokens, action: 'added' }
    //   4. 如果当前 token 不存在且 tokens.length >= 2：返回 { tokens, action: 'need_confirm', kicked_token }
    // RPC 会返回最新的 tokens 数组，避免客户端再查一次
    let rpcResult = null;
    try {
      const { data, error: rpcErr } = await _sb.rpc('register_device_token', {
        p_uid: uid,
        p_token: currentToken
      });
      if (!rpcErr && data) {
        rpcResult = data;
        console.log('[auth] RPC register_device_token 返回:', data);
      } else if (rpcErr) {
        console.warn('[auth] RPC register_device_token 失败，回退到客户端逻辑:', rpcErr.message);
      }
    } catch (e) {
      console.warn('[auth] RPC register_device_token 异常，回退到客户端逻辑:', e);
    }

    // 如果 RPC 成功，按 RPC 返回的 action 处理
    if (rpcResult) {
      const action = rpcResult.action;
      const tokens = Array.isArray(rpcResult.tokens) ? rpcResult.tokens : [];

      if (action === 'updated' || action === 'added') {
        // 直接写入成功（第 1、2 台设备，或同设备重复登录）
        console.log('[auth] 设备 token 写入成功，action:', action, '当前设备数:', tokens.length);
        // 【v2.7.54】标记当前设备 token 已注册到 device_tokens
        // checkDeviceStillValid 检测到 DB 中没有当前 token 但本地标记为已注册时，才视为被踢出
        markDeviceTokenRegistered();
        return true;
      }

      if (action === 'need_confirm') {
        // 第 3 台设备：弹出确认框（取消在左 / 确定在右）
        // 【v2.7.54】使用 showDeviceConfirm（不依赖 scripts.js，login.html 也能正常工作）
        const confirmed = await showDeviceConfirm(
          '您已在 2 台设备上登录。确定在此登录并下线最早登录的设备吗？',
          { cancelText: '取消', okText: '确定' }
        );
        if (!confirmed) {
          console.log('[auth] 用户取消登录（两设备限制）');
          return false;
        }
        // 用户确认踢出 → 调用 RPC 的 confirm 分支
        const { data: confirmResult, error: confirmErr } = await _sb.rpc('register_device_token', {
          p_uid: uid,
          p_token: currentToken,
          p_confirm_kick: true
        });
        if (confirmErr) {
          console.warn('[auth] RPC confirm_kick 失败:', confirmErr.message);
          // 失败也允许登录，避免阻塞用户
        } else {
          console.log('[auth] 已踢出最早设备，新设备登录成功:', confirmResult);
        }
        // 【v2.7.54】标记当前设备 token 已注册到 device_tokens（踢出场景也算当前设备已注册）
        markDeviceTokenRegistered();
        return true;
      }
    }

    // 【v2.7.53】RPC 不可用时回退到客户端逻辑（兼容未部署 RPC 的环境）
    // 但写入用 upsert 强制覆盖，避免 RLS update 失败
    const fallbackOk = await _enforceDeviceLimitFallback(uid, currentToken);
    // 【v2.7.54】fallback 成功时也标记已注册（与 RPC 路径保持一致）
    if (fallbackOk) markDeviceTokenRegistered();
    return fallbackOk;
  } catch (err) {
    // 【v2.7.54】异常时必须记录详细日志，帮助诊断 enforceDeviceLimit 为何失败
    // 之前异常被静默吞掉，导致 token 未写入 DB 但用户已登录，两设备限制完全失效
    console.error('[auth] enforceDeviceLimit 异常，跳过两设备限制:', err);
    console.error('[auth] 异常堆栈:', err?.stack || err);
    return true; // 异常不阻塞登录
  }
}

/** 【v2.7.53】enforceDeviceLimit 的回退实现（RPC 不可用时使用）
 *  使用 update + 验证的方式确保写入成功
 */
async function _enforceDeviceLimitFallback(uid, currentToken) {
  // 查询当前 device_tokens
  const { data: profile, error } = await _sb.from('users')
    .select('device_tokens')
    .eq('uid', uid)
    .maybeSingle();
  if (error) {
    console.warn('[auth] 查询 device_tokens 失败，跳过两设备限制:', error.message);
    return true; // 查询失败不阻塞登录
  }

  let tokens = Array.isArray(profile?.device_tokens) ? profile.device_tokens : [];

  // 过滤掉超过 30 天未活跃的 token
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
  tokens = tokens.filter(t => {
    if (!t || !t.token || !t.login_time) return false;
    return new Date(t.login_time).getTime() > thirtyDaysAgo;
  });

  // 同设备重复登录：仅更新 login_time
  if (tokens.some(t => t.token === currentToken)) {
    console.log('[auth] 当前设备已在 device_tokens 中，更新 login_time');
    tokens = tokens.map(t => t.token === currentToken
      ? { ...t, login_time: new Date().toISOString() }
      : t);
    const { error: updateErr } = await _sb.from('users').update({ device_tokens }).eq('uid', uid);
    if (updateErr) console.warn('[auth] 更新 login_time 失败:', updateErr.message);
    return true;
  }

  // 设备数 < 2：直接添加
  if (tokens.length < 2) {
    tokens.push({ token: currentToken, login_time: new Date().toISOString() });
    const { error: updateErr } = await _sb.from('users')
      .update({ device_tokens })
      .eq('uid', uid);
    if (updateErr) {
      console.warn('[auth] 写入 device_tokens 失败:', updateErr.message);
    } else {
      console.log('[auth] 设备登录成功，当前设备数:', tokens.length);
    }
    return true;
  }

  // 设备数 >= 2：弹出确认框
  const confirmed = await showDeviceConfirm(
    '您已在 2 台设备上登录。确定在此登录并下线最早登录的设备吗？',
    { cancelText: '取消', okText: '确定' }
  );
  if (!confirmed) {
    console.log('[auth] 用户取消登录（两设备限制）');
    return false;
  }

  // 踢出最早登录的设备
  tokens.shift();
  tokens.push({ token: currentToken, login_time: new Date().toISOString() });
  const { error: updateErr } = await _sb.from('users')
    .update({ device_tokens })
    .eq('uid', uid);
  if (updateErr) {
    console.warn('[auth] 更新 device_tokens 失败:', updateErr.message);
  } else {
    console.log('[auth] 已踢出最早设备，新设备登录成功');
  }
  return true;
}

/** 【v2.7.51】检查当前设备是否仍在 device_tokens 中（未被踢出）
 *  在轮询中调用，被踢出时弹提示并强制登出
 *
 *  @param {string} uid - 用户 uid
 *  @param {string} currentToken - 当前设备 token
 *  @returns {Promise<boolean>} true 表示仍在登录状态，false 表示已被踢出
 *
 *  【v2.7.52】修复紧急 BUG：登录后立刻提示"账号已在其他设备登录"（已废弃的保护逻辑）
 *  【v2.7.53】彻底重构：
 *  - 删除"空数组跳过检测"和"长度<2 不视为被踢"的保护逻辑（导致限制完全失效）
 *  - 正确逻辑：token 不在 device_tokens 中即视为被踢，强制弹窗
 *  - 对话框"确定"和"取消"都执行登出（账号权限已被移除，必须登出）
 *  - 保留 shared_skip_device_check 紧急自救标记
 *  - 登录后 30 秒宽限期内不检查（避免登录写入与轮询时序冲突导致误判）
 */
// 【v2.7.53】登录成功时间戳，30 秒宽限期内不检查被踢
let _deviceLoginTime = 0;
function _markDeviceLoginTime() { _deviceLoginTime = Date.now(); }

async function checkDeviceStillValid(uid, currentToken) {
  if (!isSupabaseReady() || !uid || !currentToken) return true;

  // 【v2.7.52】紧急自救标记：localStorage 中有 shared_skip_device_check 时跳过检测
  try {
    if (localStorage.getItem('shared_skip_device_check') === '1') {
      console.log('[auth] shared_skip_device_check 标记存在，跳过被踢检测');
      return true;
    }
  } catch (e) {}

  // 【v2.7.54】关键修复 BUG1：区分"新设备正在登录"和"旧设备已被踢出"
  // - 如果当前设备 token 从未成功写入 device_tokens（未注册标记），说明 enforceDeviceLimit 还未完成
  //   （可能在等用户确认 need_confirm 弹窗，或 RPC 调用失败被吞掉）
  //   此时即使 DB 中查不到当前 token，也不能视为被踢出 → 跳过检测
  // - 只有当本地标记为"已注册"但 DB 中查不到当前 token 时，才视为被踢出（旧设备场景）
  if (!isDeviceTokenRegistered()) {
    console.log('[auth] 当前设备 token 未注册到 device_tokens，跳过被踢检测（新设备登录流程中）');
    return true;
  }

  // 【v2.7.53】登录后 30 秒宽限期内不检查被踢（双重保险，避免 DB 读取延迟）
  if (_deviceLoginTime && Date.now() - _deviceLoginTime < 30000) {
    console.log('[auth] 登录后 30 秒宽限期内，跳过被踢检测');
    return true;
  }

  try {
    const { data: profile, error } = await _sb.from('users')
      .select('device_tokens')
      .eq('uid', uid)
      .maybeSingle();
    if (error || !profile) return true; // 查询失败不踢出

    const tokens = Array.isArray(profile?.device_tokens) ? profile.device_tokens : [];

    // 【v2.7.54】正确判定：当前 token 已注册但不在 device_tokens 中 → 已被踢出
    const stillValid = tokens.some(t => t && t.token === currentToken);
    if (stillValid) return true; // 当前设备在线，无需操作

    // 当前 token 已注册但不在 device_tokens 中 → 已被踢出（其他设备登录并替换了 token 数组）
    console.warn('[auth] 当前设备已被踢出（其他设备登录）');
    console.warn('[auth] 当前 token:', currentToken, 'device_tokens:', tokens);

    // 【v2.7.53】强制弹出提示框（不能用 showCustomConfirm，因为它点击空白处会 resolve(false)）
    // 改用原生 alert，确保用户一定看到提示
    try { alert('您的账号已在其他设备登录，即将退出登录'); } catch (e) {}

    // 【v2.7.53】无论用户点击什么，都执行登出（账号权限已被移除，必须登出）
    clearDeviceToken();
    try { if (typeof stopPolling === 'function') stopPolling(); } catch (e) {}
    try { if (typeof saveFilterState === 'function') saveFilterState(); } catch (e) {}
    // 清除 session 残留
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('sb-') || key.startsWith('supabase'))) {
          localStorage.removeItem(key);
        }
      }
      sessionStorage.removeItem('shared_seat_user_profile');
      localStorage.removeItem('shared_assistant_uid');
      localStorage.removeItem('shared_assistant_phone');
    } catch (e) {}
    try { if (_sb) await _sb.auth.signOut(); } catch (e) {}
    window.location.href = 'login.html';
    return false;
  } catch (err) {
    console.warn('[auth] checkDeviceStillValid 异常:', err);
    return true; // 异常不踢出
  }
}

/** 【v2.7.51】登出时从 device_tokens 中移除当前设备 token
 *
 *  @param {string} uid - 用户 uid
 *  @param {string} currentToken - 当前设备 token
 *
 *  【v2.7.54】修复 BUG2：改用 RPC p_logout: true 绕过 RLS，确保从 device_tokens 移除
 *  原客户端 update 可能被 RLS 阻止 → token 未真正移除 → 数组仍残留旧 token → 新设备登录被误判超限
 */
async function removeDeviceTokenFromList(uid, currentToken) {
  if (!isSupabaseReady() || !uid || !currentToken) return;
  // 【v2.7.54】优先使用 RPC p_logout: true 绕过 RLS
  try {
    const { data, error } = await _sb.rpc('register_device_token', {
      p_uid: uid,
      p_token: currentToken,
      p_logout: true
    });
    if (error) {
      console.warn('[auth] RPC p_logout 失败，回退到客户端 update:', error.message);
      // 回退：客户端 update（可能被 RLS 阻止，但尽力而为）
      const { data: profile } = await _sb.from('users')
        .select('device_tokens')
        .eq('uid', uid)
        .maybeSingle();
      const tokens = Array.isArray(profile?.device_tokens) ? profile.device_tokens : [];
      const newTokens = tokens.filter(t => t && t.token !== currentToken);
      if (newTokens.length !== tokens.length) {
        await _sb.from('users').update({ device_tokens: newTokens }).eq('uid', uid);
      }
    } else {
      console.log('[auth] 已通过 RPC 从 device_tokens 移除当前设备:', data);
    }
  } catch (err) {
    console.warn('[auth] removeDeviceTokenFromList 异常:', err);
  }
}

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
        // 【v2.7.51】两设备登录限制：注册成功（已存在账号回退登录）后写入 device_tokens
        const _dt1 = getOrCreateDeviceToken();
        const _ok1 = await enforceDeviceLimit(currentUser.uid, _dt1);
        if (!_ok1) return { success: false, error: '已取消登录' };
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
    // 【v2.7.51】两设备登录限制：注册成功后写入 device_tokens
    const _dt2 = getOrCreateDeviceToken();
    const _ok2 = await enforceDeviceLimit(currentUser.uid, _dt2);
    if (!_ok2) return { success: false, error: '已取消登录' };
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
    // 【v2.7.51】两设备登录限制：读者证号登录后写入 device_tokens
    const _dt3 = getOrCreateDeviceToken();
    const _ok3 = await enforceDeviceLimit(currentUser.uid, _dt3);
    if (!_ok3) return { success: false, error: '已取消登录' };
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
  // 【v2.7.62】协作登录跳转过程中设置标记，避免 iOS Safari 跳转触发 visibilitychange
  // 导致令牌校验逻辑阻塞正常加载（卡在骨架屏）
  try { sessionStorage.setItem('collab_login_in_progress', '1'); } catch (e) {}
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
    // 【v2.7.51】两设备登录限制：扫码登录后写入 device_tokens
    const _dt4 = getOrCreateDeviceToken();
    const _ok4 = await enforceDeviceLimit(currentUser.uid, _dt4);
    if (!_ok4) return { success: false, error: '已取消登录' };
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
    // 【v2.7.61】同时过滤已吊销的密码，防止吊销后仍能激活
    const { data: cp } = await _sb.from('collab_passwords')
      .select('id, created_by, revoked')
      .eq('password', qrData.password)
      .eq('floor_id', String(qrData.floor_id))
      .eq('date', today)
      .maybeSingle();
    // 【v2.7.61】已吊销的密码不写入激活日志
    if (cp && cp.revoked === true) {
      console.warn('[auth] 协作密码已被吊销，拒绝写入激活日志:', qrData.password);
      return;
    }
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
  // 【v2.7.51】两设备登录限制：通过 Edge Function 获取 session 后写入 device_tokens
  const _dt5 = getOrCreateDeviceToken();
  const _ok5 = await enforceDeviceLimit(currentUser.uid, _dt5);
  if (!_ok5) return { success: false, error: '已取消登录' };
  return { success: true, error: null, user: currentUser };
}

// ---- 协作者再次登录 ----
// 先尝试 RPC 查找，再走 Edge Function 获取 session
async function assistantReLogin(name, phone) {
  if (!isSupabaseReady()) return { success: false, error: 'Supabase 未配置' };
  // 【v2.7.62】协作登录跳转过程中设置标记，避免 iOS Safari 跳转触发 visibilitychange
  try { sessionStorage.setItem('collab_login_in_progress', '1'); } catch (e) {}
  try {
    console.log('[auth] assistantReLogin: 尝试 RPC 查找用户...');
    // 直接查 users 表找 assistant（不前端过滤过期时间，由后端定时任务处理降级）
    // 【v2.7.84】删除 .gt('assistant_expires_at', new Date().toISOString()) 过滤
    // 原因：手机本地时间不准时会误判未过期的协助者为已过期，导致协作登录失败
    const { data: user, error } = await _sb.from('users')
      .select('uid, role, name')
      .eq('phone', phone)
      .eq('role', 'assistant')
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
    // 【v2.7.51】两设备登录限制：协作者再次登录后写入 device_tokens
    const _dt6 = getOrCreateDeviceToken();
    const _ok6 = await enforceDeviceLimit(currentUser.uid, _dt6);
    if (!_ok6) return { success: false, error: '已取消登录' };
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
    // 【v2.7.54】修复 BUG2：登出流程顺序调整
    // 3. 先调用 RPC 移除 device_tokens 中的当前设备 token（此时 session 还有效，RPC 能正常鉴权）
    //    原顺序是先 signOut 再移除 token，导致 session 失效后 RPC 调用失败，token 残留在数组中
    if (currentUser.uid) {
      const _dt = getOrCreateDeviceToken();
      try {
        await removeDeviceTokenFromList(currentUser.uid, _dt);
      } catch (e) {
        console.warn('[signOut] removeDeviceTokenFromList 异常:', e);
      }
    }
    // 4. 再调用 Supabase 登出（清除 session）
    if (_sb) {
      try { await _sb.auth.signOut(); } catch (e) { console.warn('[signOut] signOut 调用异常:', e); }
    }
    // 5. 清除本地 token + 已注册标记（clearDeviceToken 内部同步清除 registered 标记）
    clearDeviceToken();
    // 6. 重置用户状态
    resetCurrentUser();
    // 7. 彻底清除所有 Supabase session 残留（sb-* 键）+ 业务缓存
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
    // 8. 跳转登录页
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

/** 【v2.7.60】校验会话有效性，必要时自动刷新令牌
 *  场景：手机待机恢复后，Supabase 访问令牌可能已过期（默认 1 小时）
 *  流程：
 *    1. getSession() 检查当前会话
 *    2. 若会话为空或令牌已过期 → refreshSession() 尝试用刷新令牌获取新访问令牌
 *    3. 刷新成功 → 重新拉取 loadUserProfile 确保权限最新
 *    4. 刷新失败 → 清除登录态，弹提示"登录已过期"，跳转登录页
 *  @returns {Promise<boolean>} true 表示会话有效（已恢复或原本就有效），false 表示已跳转登录页
 */
async function validateAndRefreshSession() {
  if (!isSupabaseReady()) return false;

  // 步骤1：检查当前会话
  let session = null;
  try {
    const result = await _sb.auth.getSession();
    session = result?.data?.session || null;
  } catch (e) {
    console.warn('[auth] getSession 异常:', e);
    session = null;
  }

  // 【v2.7.84】会话仍有效 → 直接信任，不预判 JWT 过期
  // 原因：原代码用 Date.now()（本地时间）和 session.expires_at 比较，手机时间不准时会误判
  //       JWT 已过期，触发 refreshSession，如果 refresh token 也因时间问题失败，
  //       会错误触发"登录已过期"提示。
  // 修复：信任 session 存在即有效，不主动检查过期时间。
  //       如果 JWT 真的过期，下次 API 调用会返回 401，由调用方触发刷新。
  if (session) {
    return true;
  }
  console.log('[auth] 无有效 session，尝试刷新令牌');

  // 步骤2：尝试用刷新令牌获取新的访问令牌
  try {
    const { data: refreshData, error: refreshError } = await _sb.auth.refreshSession();
    if (refreshError || !refreshData?.session) {
      console.warn('[auth] 刷新令牌失败:', refreshError?.message || '无 session');
      _handleSessionExpired();
      return false;
    }
    console.log('[auth] 令牌刷新成功，重新拉取用户信息');
    // 步骤3：刷新成功 → 重新拉取用户信息和权限
    await loadUserProfile();
    return true;
  } catch (err) {
    console.warn('[auth] refreshSession 异常:', err);
    _handleSessionExpired();
    return false;
  }
}

/** 【v2.7.60】处理会话彻底失效（刷新令牌也过期） */
function _handleSessionExpired() {
  console.warn('[auth] 登录已过期，清除本地登录态并跳转登录页');
  // 清除本地登录态
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('sb-') || key.startsWith('supabase'))) {
        localStorage.removeItem(key);
      }
    }
    sessionStorage.removeItem('shared_seat_user_profile');
    localStorage.removeItem('shared_assistant_uid');
    localStorage.removeItem('shared_assistant_phone');
    // 注意：不清除 shared_device_token，避免重新登录后丢失设备限制状态
  } catch (e) {}
  // 清除当前用户缓存
  resetCurrentUser();
  // 弹出提示（用 setTimeout 确保 alert 在页面跳转前显示）
  try { alert('登录已过期，请重新登录'); } catch (e) {}
  // 跳转登录页
  setTimeout(() => { window.location.href = 'login.html'; }, 100);
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
      // 【v2.7.88】查询失败时保留现有角色，不静默降级为 reader
      // 原因：RLS 拦截、网络抖动、JWT 刷新延迟都会导致查询失败，静默降级会误判"权限过期"
      console.error('[auth] 查询用户角色失败，保留现有角色:', error, 'uid:', session.user.id);
    } else {
      const p = profile[0]; // 取第一条
      console.log('[auth] loadUserProfile 查到:', { role: p.role, managed_floors: p.managed_floors, assistant_expires_at: p.assistant_expires_at });
      const dbRole = p.role || 'reader';
      // 【v2.7.89】本地是 assistant 但 DB 返回 reader 时，不立即降级
      // 原因：pg_cron 历史激活日志误判、DB 读副本延迟、网络竞态都会导致 DB 临时返回 reader
      // 真正的降级由 _pollingCheckRoleChange（30秒节流 + 登录标记保护）处理
      if (currentUser.role === 'assistant' && dbRole === 'reader') {
        console.warn('[auth] DB 返回 reader 但本地是 assistant，保留现有角色（可能为 DB 读延迟或 pg_cron 误判）');
      } else {
        currentUser.role = dbRole;
      }
      currentUser.managedFloors = p.managed_floors || [];
      currentUser.assistantExpiresAt = p.assistant_expires_at;
      if (p.name) currentUser.name = p.name;
      if (p.card_number) currentUser.cardNumber = p.card_number;
      if (p.phone) currentUser.phone = p.phone;
    }
  } catch (err) {
    // 【v2.7.88】异常时保留现有角色，不静默降级为 reader
    console.error('[auth] loadUserProfile 异常，保留现有角色:', err.message || err);
  }
  // 【v2.7.16】预热当前用户姓名到缓存，供历史图片水印使用
  if (typeof _preWarmCurrentUserName === 'function') {
    _preWarmCurrentUserName(currentUser.uid, currentUser.name);
  }

  // 【v2.7.74】彻底移除前端的 assistant_expires_at 自动降级逻辑
  // 原因：手机系统时间不准/时区错乱时，前端 new Date() 与服务器时间不一致，
  //      会误判权限已到期并主动 update users 表，导致用户权限被提前回收。
  // 修复：前端只读取 role/assistant_expires_at 用于 UI 显示控制，
  //      永不主动修改 DB 中的用户角色；角色降级完全交由后端定时任务处理。
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

// 【v2.7.74】checkAssistantExpiry 函数已彻底删除
// 原因：该函数会主动 update users 表降级角色，受手机系统时间影响存在误判风险。
// 替代方案：由后端定时任务 downgrade-expired-assistants 统一处理权限过期降级。

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
    // 【v2.7.84】删除前端时间预判（new Date() 比较受手机系统时间影响）
    // 原代码：if (currentUser.role === 'assistant' && currentUser.assistantExpiresAt && new Date(currentUser.assistantExpiresAt) <= new Date()) return false;
    // 修复：前端只检查 role 是否为 assistant，不预判过期时间。
    //       角色降级完全由后端定时任务处理，前端在下次 loadUserProfile 时读取最新 role。
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
  // 【v2.7.84】注意：此函数用本地时间计算剩余分钟，仅供 UI 显示参考，不用于权限判断
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
  // 【v2.7.88】扫码登录流程中跳过角色检查，避免 Edge Function 写入与 loadUserProfile 竞态导致误降级
  try {
    if (sessionStorage.getItem('collab_login_in_progress') === '1') return;
  } catch (e) {}
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

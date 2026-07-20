import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ============================================================
 * 协作者登录 Edge Function
 * 处理三种操作：
 *   1. qr_login     — 扫码登录（协作者扫描辅专二维码）
 *   2. re_login     — 手机号重新登录（协作者权限未过期时）
 *   3. get_session  — 为已有用户获取 session（客户端已自行更新角色后调用）
 * ============================================================ */

// CORS 响应头，供浏览器跨域请求使用
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // 处理浏览器预检请求
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 使用 service_role 密钥初始化客户端，可绕过 RLS 并创建 Auth 用户
    const supabase: SupabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json();
    const { action } = body;

    if (action === "qr_login") {
      return await handleQrLogin(supabase, body);
    } else if (action === "re_login") {
      return await handleReLogin(supabase, body);
    } else if (action === "get_session") {
      return await handleGetSession(supabase, body);
    } else {
      return jsonResponse({ success: false, error: "未知操作类型" }, 400);
    }
  } catch (err) {
    return jsonResponse(
      { success: false, error: `服务器错误: ${err.message}` },
      500
    );
  }
});

/* ============================================================
 * 扫码登录
 * 接收: { action, qr_data: { password, floor_id, manager_name, manager_uid }, name, phone }
 * ============================================================ */
async function handleQrLogin(
  supabase: SupabaseClient,
  body: {
    qr_data: {
      password: string;
      floor_id: number;
      manager_name: string;
      manager_uid: string;
    };
    name: string;
    phone: string;
  }
) {
  const { qr_data, name, phone } = body;
  // 兼容两种字段命名：granter_uid / manager_uid，granter_name / manager_name
  const password = qr_data.password;
  const floor_id = qr_data.floor_id;
  const manager_uid = qr_data.manager_uid || qr_data.granter_uid;
  const manager_name = qr_data.manager_name || qr_data.granter_name;

  console.log('[handle-assistant-login] qr_data:', JSON.stringify(qr_data));
  console.log('[handle-assistant-login] 解析后: password=%s, floor_id=%s, manager_uid=%s, manager_name=%s', password, floor_id, manager_uid, manager_name);

  // ---- 参数校验 ----
  if (!password || !floor_id || !manager_uid || !name || !phone) {
    const missing = [];
    if (!password) missing.push('password');
    if (!floor_id) missing.push('floor_id');
    if (!manager_uid) missing.push('manager_uid(二维码生成方未登录)');
    if (!name) missing.push('name');
    if (!phone) missing.push('phone');
    console.error('[handle-assistant-login] 参数校验失败, 缺少:', missing.join(', '));
    return jsonResponse(
      { success: false, error: `缺少必要参数: ${missing.join(', ')}` },
      400
    );
  }

  // ---- 查询协作密码 ----
  // 使用北京时间日期（与 RPC 函数和 pg_cron 保持一致）
  const nowUTC = new Date();
  const bjOffset = 8 * 60 * 60 * 1000; // UTC+8
  const bjDate = new Date(nowUTC.getTime() + bjOffset);
  const today = `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bjDate.getUTCDate()).padStart(2, '0')}`;
  const { data: collab, error: collabError } = await supabase
    .from("collab_passwords")
    .select("*")
    .eq("password", password)
    .eq("date", today)
    .single();

  if (collabError || !collab) {
    return jsonResponse(
      { success: false, error: "密码无效或不在有效期内" },
      400
    );
  }

  // 【v2.7.61】后端兜底校验：检查密码是否已被吊销
  // 即使前端绕过校验，后端也必须拒绝已吊销的密码
  if (collab.revoked === true) {
    return jsonResponse(
      { success: false, error: "该密码已被吊销，无法使用" },
      400
    );
  }

  // ---- 检查使用次数 ----
  if (collab.used_count >= collab.max_uses) {
    return jsonResponse(
      { success: false, error: "该密码已达到最大使用次数" },
      400
    );
  }

  // ---- 检查绝对过期时间 ----
  if (collab.expires_at && new Date(collab.expires_at) < new Date()) {
    return jsonResponse(
      { success: false, error: "该密码已过期" },
      400
    );
  }

  // ---- 判断密码类型 ----
  const isTemporary = collab.password_type === 'temporary';
  console.log('[handle-assistant-login] password_type:', collab.password_type, 'isTemporary:', isTemporary);

  // ---- 检查是否在授权时段内（仅普通密码需要） ----
  // 规则：临时密码任何时间都可扫码；普通密码仅 08:00~12:30 和 13:30~17:30 可扫码授权
  const now = new Date();
  const bjHours = (now.getUTCHours() + 8) % 24;
  const bjMinutes = now.getUTCMinutes();
  const timeValue = bjHours + bjMinutes / 60;

  const isMorning = timeValue >= 8 && timeValue <= 12.5;   // 08:00 ~ 12:30
  const isAfternoon = timeValue >= 13.5 && timeValue <= 17.5; // 13:30 ~ 17:30

  if (!isTemporary && !isMorning && !isAfternoon) {
    console.log('[handle-assistant-login] 非授权时段，北京时间:', bjHours + ':' + String(bjMinutes).padStart(2, '0'));
    return jsonResponse(
      { success: false, error: "当前时间不在授权时段内，无法获取权限。请在 08:00-12:30 或 13:30-17:30 之间扫码。" },
      400
    );
  }

  // ---- 计算协作者权限过期时间 ----
  let expiresAt: Date;

  if (isTemporary) {
    // 临时密码：有效期完全由管理员设定，直接使用密码的 expires_at
    expiresAt = new Date(collab.expires_at);
    console.log('[handle-assistant-login] 临时密码，使用管理员设定的过期时间:', expiresAt.toISOString());
  } else {
    // 普通密码：根据扫码时段计算过期时间
    if (isMorning) {
      expiresAt = new Date(now);
      expiresAt.setUTCHours(4, 30, 0, 0); // 北京时间 12:30
    } else {
      expiresAt = new Date(now);
      expiresAt.setUTCHours(9, 30, 0, 0); // 北京时间 17:30
    }
  }

  console.log('[handle-assistant-login] 北京时间:', bjHours + ':' + String(bjMinutes).padStart(2, '0'), '过期时间:', expiresAt.toISOString());

  // ---- 创建或更新 users 表中的协作者记录 ----
  // 统一处理三种场景：新用户、已注册读者、协助者重新扫码
  // 核心规则：无论哪种场景，都无条件覆盖为 assistant
  let userId: string;
  const assistantEmail = `${phone}@assistant.lib`;

  // 1. 查找是否已存在该手机号的 public.users 记录
  const { data: existingUser } = await supabase
    .from("users")
    .select("uid, role")
    .eq("phone", phone)
    .maybeSingle();

  if (existingUser) {
    // 规则2 & 规则3：已注册用户（读者或协助者），无条件覆盖权限
    userId = existingUser.uid;

    console.log('[handle-assistant-login] 更新已存在用户 uid:', userId, '旧角色:', existingUser.role, '→ assistant');

    // 【v2.7.8】同步更新 auth user_metadata.name
    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { name, phone },
    });

    const { data: updatedUser, error: updateError } = await supabase
      .from("users")
      .update({
        name,
        role: "assistant",
        managed_floors: [floor_id],
        assistant_expires_at: expiresAt.toISOString(),
        phone,
        updated_at: new Date().toISOString(),
      })
      .eq("uid", userId)
      .select("role, managed_floors, assistant_expires_at")
      .single();

    if (updateError) {
      console.error('[handle-assistant-login] 更新失败:', updateError);
      return jsonResponse(
        { success: false, error: `更新用户信息失败: ${updateError.message}` },
        500
      );
    }
    console.log('[handle-assistant-login] 更新后用户数据:', updatedUser);
  } else {
    // 规则1：新用户，创建 Auth 用户 + public.users
    console.log('[handle-assistant-login] 新用户创建:', phone);

    const autoPassword = generateAutoPassword();
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email: assistantEmail,
        password: autoPassword,
        email_confirm: true,
        user_metadata: { name, phone },
      });

    if (authError) {
      if (authError.message.includes("already registered") || authError.message.includes("already been registered")) {
        // auth.users 残留（public.users 被删但 auth.users 还在），复用
        console.log('[handle-assistant-login] Auth 用户已存在，复用:', assistantEmail);
        const { data: userList } = await supabase.auth.admin.listUsers();
        const existingAuth = userList?.users?.find(
          (u) => u.email === assistantEmail
        );
        if (existingAuth) {
          userId = existingAuth.id;
        } else {
          return jsonResponse(
            { success: false, error: "Auth 用户已存在但无法找到，请联系管理员" },
            500
          );
        }
      } else {
        return jsonResponse(
          { success: false, error: `创建 Auth 用户失败: ${authError.message}` },
          500
        );
      }
    } else {
      userId = authData.user!.id;
      console.log('[handle-assistant-login] 创建新 Auth 用户 uid:', userId);
    }

    // upsert public.users（ON CONFLICT DO UPDATE 确保覆盖 trigger 可能写入的 reader）
    console.log('[handle-assistant-login] 新用户 upsert uid:', userId, 'role: assistant, floor_id:', floor_id);
    const { data: upsertedUser, error: upsertError } = await supabase.from("users").upsert({
      uid: userId,
      name,
      phone,
      card_number: phone,
      role: "assistant",
      managed_floors: [floor_id],
      assistant_expires_at: expiresAt.toISOString(),
      created_by: manager_uid,
    }, { onConflict: 'uid' })
    .select("role, managed_floors, assistant_expires_at")
    .single();

    if (upsertError) {
      console.error('[handle-assistant-login] upsert 失败:', upsertError);
      return jsonResponse(
        { success: false, error: `创建用户记录失败: ${upsertError.message}` },
        500
      );
    }
    console.log('[handle-assistant-login] upsert 后用户数据:', upsertedUser);

    // 关键验证：确认 role 确实是 assistant（防止 handle_new_user trigger 并发覆盖）
    if (!upsertedUser || upsertedUser.role !== 'assistant') {
      console.error('[handle-assistant-login] 角色异常！upsert 后 role:', upsertedUser?.role, '，强制修正为 assistant');
      const { data: fixedUser, error: fixError } = await supabase
        .from("users")
        .update({
          role: "assistant",
          managed_floors: [floor_id],
          assistant_expires_at: expiresAt.toISOString(),
        })
        .eq("uid", userId)
        .select("role, managed_floors, assistant_expires_at")
        .single();
      if (fixError) {
        console.error('[handle-assistant-login] 强制修正失败:', fixError);
      } else {
        console.log('[handle-assistant-login] 强制修正后:', fixedUser);
      }
    }
  }

  // ---- 更新协作密码使用次数 ----
  const { error: incrementError } = await supabase
    .from("collab_passwords")
    .update({ used_count: collab.used_count + 1 })
    .eq("id", collab.id);

  if (incrementError) {
    console.error("更新密码使用次数失败:", incrementError.message);
    // 不阻断登录流程，仅记录日志
  }

  // 【v2.7.36】写入激活记录（service_role 绕过 RLS，确保记录成功）
  // 直接从二维码内容获取 granter_uid 和 granter_name，不依赖 collab_passwords.created_by
  // 这样提供者字段准确反映"谁出示了二维码"，与手动生成密码的账号无关
  // 【v2.7.39】同时写入 expires_at（激活时协助者的权限过期时间）
  // 这样后续 users.assistant_expires_at 被降级清空后，历史记录仍能正确显示
  const logRecord: Record<string, unknown> = {
    password_id: collab.id,
    assistant_uid: userId,
    activated_at: new Date().toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  if (manager_uid) logRecord.granter_uid = manager_uid;
  if (manager_name) logRecord.granter_name = manager_name; // 已 URL 编码的二维码原文

  const { error: logError } = await supabase
    .from("collab_activation_logs")
    .insert(logRecord);

  if (logError) {
    console.error('[handle-assistant-login] 写入激活记录失败:', logError.message);
    // 不阻断登录流程
  } else {
    console.log('[handle-assistant-login] 激活记录已写入, password_id:', collab.id,
      'assistant_uid:', userId, 'granter_uid:', manager_uid, 'granter_name:', manager_name,
      'expires_at:', expiresAt.toISOString());
  }

  // 【v2.7.36】移除补填 collab_passwords.created_by 的逻辑
  // 提供者信息现在直接存储在 collab_activation_logs 中，不再依赖 collab_passwords.created_by

  // ---- 为协作者生成登录令牌 ----
  // 先获取用户真实邮箱，再重置密码获取 session
  const { data: authInfo } = await supabase.auth.admin.getUserById(userId);
  const userEmail = authInfo?.user?.email || `${phone}@assistant.lib`;
  const tempPassword = generateAutoPassword();
  const { error: resetError } = await supabase.auth.admin.updateUserById(
    userId,
    { password: tempPassword }
  );

  if (resetError) {
    return jsonResponse(
      { success: false, error: `重置密码失败: ${resetError.message}` },
      500
    );
  }

  // 使用邮箱密码登录获取 session
  const { data: sessionData, error: sessionError } =
    await supabase.auth.signInWithPassword({
      email: userEmail,
      password: tempPassword,
    });

  if (sessionError || !sessionData.session) {
    return jsonResponse(
      { success: false, error: `获取登录会话失败: ${sessionError?.message ?? "未知错误"}` },
      500
    );
  }

  return jsonResponse({
    success: true,
    access_token: sessionData.session.access_token,
    refresh_token: sessionData.session.refresh_token,
    role: "assistant",
    managed_floors: [floor_id],
    assistant_expires_at: expiresAt.toISOString(),
    name,
    phone,
  });
}

/* ============================================================
 * 手机号重新登录
 * 接收: { action, name, phone }
 * ============================================================ */
async function handleReLogin(
  supabase: SupabaseClient,
  body: {
    name: string;
    phone: string;
  }
) {
  const { name, phone } = body;

  // ---- 参数校验 ----
  if (!name || !phone) {
    return jsonResponse(
      { success: false, error: "缺少必要参数" },
      400
    );
  }

  // ---- 查找用户：手机号匹配 + 角色为 assistant + 未过期 ----
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("phone", phone)
    .eq("role", "assistant")
    .gt("assistant_expires_at", new Date().toISOString())
    .single();

  if (userError || !user) {
    return jsonResponse(
      { success: false, error: "未找到有效的协作者账号或权限已过期" },
      400
    );
  }

  // ---- 更新用户姓名（可能改名了） ----
  if (user.name !== name) {
    await supabase.from("users").update({ name }).eq("uid", user.uid);
    // 【v2.7.8】同步更新 auth user_metadata.name
    await supabase.auth.admin.updateUserById(user.uid, {
      user_metadata: { name, phone: user.phone || phone },
    });
  }

  // ---- 生成登录令牌 ----
  // 先获取用户真实邮箱
  const { data: authInfo2 } = await supabase.auth.admin.getUserById(user.uid);
  const userEmail = authInfo2?.user?.email || `${phone}@assistant.lib`;

  // 重置密码为临时值再登录
  const tempPassword = generateAutoPassword();
  const { error: resetError } = await supabase.auth.admin.updateUserById(
    user.uid,
    { password: tempPassword }
  );

  if (resetError) {
    return jsonResponse(
      { success: false, error: `重置密码失败: ${resetError.message}` },
      500
    );
  }

  // 使用邮箱密码登录获取 session
  const { data: sessionData, error: sessionError } =
    await supabase.auth.signInWithPassword({
      email: userEmail,
      password: tempPassword,
    });

  if (sessionError || !sessionData.session) {
    return jsonResponse(
      { success: false, error: `获取登录会话失败: ${sessionError?.message ?? "未知错误"}` },
      500
    );
  }

  return jsonResponse({
    success: true,
    access_token: sessionData.session.access_token,
    refresh_token: sessionData.session.refresh_token,
    role: user.role || "assistant",
    managed_floors: user.managed_floors || [],
    assistant_expires_at: user.assistant_expires_at,
    name: user.name,
    phone: user.phone,
  });
}

/* ============================================================
 * 为已有用户获取 session（客户端已自行更新角色后调用）
 * 接收: { action, uid, phone }
 * ============================================================ */
async function handleGetSession(
  supabase: SupabaseClient,
  body: {
    uid: string;
    phone?: string;
  }
) {
  const { uid } = body;

  if (!uid) {
    return jsonResponse({ success: false, error: "缺少 uid 参数" }, 400);
  }

  // 通过 admin API 获取用户的真实邮箱（可能是 cardNumber@lib.internal 或 phone@assistant.lib）
  const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(uid);
  if (authError || !authUser?.user) {
    return jsonResponse(
      { success: false, error: "未找到 Auth 用户" },
      400
    );
  }

  const userEmail = authUser.user.email;
  if (!userEmail) {
    return jsonResponse(
      { success: false, error: "用户邮箱为空，无法生成 session" },
      400
    );
  }

  // 重置密码并登录获取 session
  const tempPassword = generateAutoPassword();
  const { error: resetError } = await supabase.auth.admin.updateUserById(
    uid,
    { password: tempPassword }
  );

  if (resetError) {
    return jsonResponse(
      { success: false, error: `重置密码失败: ${resetError.message}` },
      500
    );
  }

  // 使用用户的真实邮箱登录获取 session
  const { data: sessionData, error: sessionError } =
    await supabase.auth.signInWithPassword({
      email: userEmail,
      password: tempPassword,
    });

  if (sessionError || !sessionData.session) {
    return jsonResponse(
      { success: false, error: `获取登录会话失败: ${sessionError?.message ?? "未知错误"}` },
      500
    );
  }

  // 查询 public.users 获取角色信息
  const { data: userProfile } = await supabase
    .from("users")
    .select("role, managed_floors, assistant_expires_at, name, phone")
    .eq("uid", uid)
    .single();

  return jsonResponse({
    success: true,
    access_token: sessionData.session.access_token,
    refresh_token: sessionData.session.refresh_token,
    role: userProfile?.role || "reader",
    managed_floors: userProfile?.managed_floors || [],
    assistant_expires_at: userProfile?.assistant_expires_at || null,
    name: userProfile?.name || null,
    phone: userProfile?.phone || null,
  });
}

/* ============================================================
 * 工具函数
 * ============================================================ */

// 生成随机密码（用于协作者 Auth 账号的自动密码）
function generateAutoPassword(): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join("");
}

// 统一 JSON 响应，附带 CORS 头
function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

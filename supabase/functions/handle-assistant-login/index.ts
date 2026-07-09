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
  const { password, floor_id, manager_uid } = qr_data;

  // ---- 参数校验 ----
  if (!password || !floor_id || !manager_uid || !name || !phone) {
    return jsonResponse(
      { success: false, error: "缺少必要参数" },
      400
    );
  }

  // ---- 查询协作密码 ----
  const today = new Date().toISOString().slice(0, 10); // 当天日期 YYYY-MM-DD
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

  // ---- 计算协作者权限过期时间 ----
  const now = new Date();
  let expiresAt: Date;

  // 获取北京时间（UTC+8）的小时和分钟
  const bjHours = (now.getUTCHours() + 8) % 24;
  const bjMinutes = now.getUTCMinutes();
  const totalMinutes = bjHours * 60 + bjMinutes;

  // 12:30 = 750 分钟, 13:30 = 810 分钟（北京时间）
  if (totalMinutes < 750) {
    // 北京时间 < 12:30，过期时间设为北京时间 12:30（UTC 04:30）
    expiresAt = new Date(now);
    expiresAt.setUTCHours(4, 30, 0, 0);
  } else if (totalMinutes >= 810) {
    // 北京时间 >= 13:30，过期时间设为北京时间 17:30（UTC 09:30）
    expiresAt = new Date(now);
    expiresAt.setUTCHours(9, 30, 0, 0);
  } else {
    // 北京时间 12:30 ~ 13:30 之间，视为午间过渡，过期时间设为北京时间 17:30（UTC 09:30）
    expiresAt = new Date(now);
    expiresAt.setUTCHours(9, 30, 0, 0);
  }

  // ---- 创建或更新 users 表中的协作者记录 ----
  // 先查找是否已存在该手机号的用户
  const { data: existingUser } = await supabase
    .from("users")
    .select("*")
    .eq("phone", phone)
    .single();

  let userId: string;

  if (existingUser) {
    // 用户已存在，更新角色和权限
    userId = existingUser.uid;

    // 覆盖 managed_floors：只保留当前扫码楼层
    const { error: updateError } = await supabase
      .from("users")
      .update({
        name,
        role: "assistant",
        managed_floors: [floor_id],
        assistant_expires_at: expiresAt.toISOString(),
      })
      .eq("uid", userId);

    if (updateError) {
      return jsonResponse(
        { success: false, error: `更新用户信息失败: ${updateError.message}` },
        500
      );
    }
  } else {
    // 用户不存在，先创建 Auth 用户再插入 users 表
    const assistantEmail = `${phone}@assistant.lib`;
    const autoPassword = generateAutoPassword();

    // 创建 Supabase Auth 用户
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email: assistantEmail,
        password: autoPassword,
        email_confirm: true, // 自动确认邮箱
      });

    if (authError) {
      // 如果邮箱已存在，尝试用已有用户
      if (authError.message.includes("already registered")) {
        // 查找已有 Auth 用户的 ID
        const { data: userList } = await supabase.auth.admin.listUsers();
        const existingAuth = userList?.users?.find(
          (u) => u.email === assistantEmail
        );
        if (existingAuth) {
          userId = existingAuth.id;
        } else {
          return jsonResponse(
            { success: false, error: "Auth 用户已存在但无法找到" },
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
    }

    // 插入 users 表
    const { error: insertError } = await supabase.from("users").insert({
      uid: userId,
      name,
      phone,
      role: "assistant",
      managed_floors: [floor_id],
      assistant_expires_at: expiresAt.toISOString(),
      created_by: manager_uid,
    });

    if (insertError) {
      return jsonResponse(
        { success: false, error: `创建用户记录失败: ${insertError.message}` },
        500
      );
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

  // ---- 为协作者生成登录令牌 ----
  // 先重置密码为已知值，再 signInWithPassword 获取 session
  const assistantEmail = `${phone}@assistant.lib`;
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
      email: assistantEmail,
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
  }

  // ---- 生成登录令牌 ----
  const assistantEmail = `${phone}@assistant.lib`;

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
      email: assistantEmail,
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
  const { uid, phone } = body;

  if (!uid) {
    return jsonResponse({ success: false, error: "缺少 uid 参数" }, 400);
  }

  // 查找用户记录，获取手机号（用于拼装邮箱）
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("uid, phone")
    .eq("uid", uid)
    .single();

  if (userError || !user) {
    return jsonResponse(
      { success: false, error: "未找到用户记录" },
      400
    );
  }

  const userPhone = phone || user.phone;
  if (!userPhone) {
    return jsonResponse(
      { success: false, error: "用户手机号为空，无法生成 session" },
      400
    );
  }

  // 重置密码并登录获取 session
  const assistantEmail = `${userPhone}@assistant.lib`;
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

  const { data: sessionData, error: sessionError } =
    await supabase.auth.signInWithPassword({
      email: assistantEmail,
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

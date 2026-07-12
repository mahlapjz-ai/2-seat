-- ============================================================
-- 图书馆座位管理共享版 - 完整迁移脚本
-- ⚠️⚠️⚠️ 警告：此脚本会删除所有数据！仅用于全新部署！
-- ⚠️⚠️⚠️ 如果已有数据，绝对不要执行此文件！
-- 如需更新函数，只需执行 CREATE OR REPLACE FUNCTION 部分
-- ============================================================

-- 0. 清理旧表（按依赖顺序）
DROP TABLE IF EXISTS seat_photos, seats, collab_passwords, settings, users, floors CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS public.update_updated_at_column() CASCADE;
DROP FUNCTION IF EXISTS public.assistant_login(password text, floor_id text, name text, phone text) CASCADE;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- ============================================================
-- 1. 用户扩展信息表
-- ============================================================
CREATE TABLE public.users (
  uid uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  card_number text UNIQUE NOT NULL,
  phone text,
  role text NOT NULL DEFAULT 'reader'
    CHECK (role IN ('owner','admin','floor_manager','assistant','reader')),
  managed_floors text[],
  assistant_expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- 2. 楼层表
-- ============================================================
CREATE TABLE public.floors (
  id text PRIMARY KEY,
  name text NOT NULL,
  sort_order smallint DEFAULT 0
);

-- ============================================================
-- 3. 座位表
-- ============================================================
CREATE TABLE public.seats (
  seat_id text PRIMARY KEY,
  floor_id text NOT NULL REFERENCES floors(id),
  region text NOT NULL,
  label text NOT NULL,
  current_status text DEFAULT 'unknown'
    CHECK (current_status IN ('occupied','vacant','unknown')),
  last_photo_url text,
  last_updated_by uuid REFERENCES auth.users(id),
  last_updated_at timestamptz
);

-- ============================================================
-- 4. 照片记录表
-- ============================================================
CREATE TABLE public.seat_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id text NOT NULL REFERENCES seats(seat_id) ON DELETE CASCADE,
  url text NOT NULL,
  status text NOT NULL,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- 5. 全局设置表
-- ============================================================
CREATE TABLE public.settings (
  key text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO public.settings (key, value) VALUES ('reader_view_enabled', 'false')
  ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 6. 协作密码表
-- ============================================================
CREATE TABLE public.collab_passwords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  password text UNIQUE NOT NULL,
  floor_id text NOT NULL REFERENCES floors(id),
  date date NOT NULL,
  max_uses smallint DEFAULT 8,
  used_count smallint DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- 7. 初始楼层数据
-- ============================================================
INSERT INTO floors (id, name, sort_order) VALUES
  ('1', '一楼', 1), ('2', '二楼', 2), ('3', '三楼', 3),
  ('4', '四楼', 4), ('5', '五楼', 5)
  ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 8. 索引
-- ============================================================
CREATE INDEX idx_seat_photos_seat_id ON seat_photos(seat_id);
CREATE INDEX idx_seat_photos_uploaded_by ON seat_photos(uploaded_by);
CREATE INDEX idx_seats_floor_region ON seats(floor_id, region);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_collab_passwords_date_floor ON collab_passwords(date, floor_id);

-- ============================================================
-- 9. Auth 触发器：新注册用户自动写入 users 表
--    第一个用户成为 owner，后续默认 reader
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, auth
AS $$
BEGIN
  INSERT INTO public.users (uid, name, card_number, role, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', '用户'),
    COALESCE(NEW.raw_user_meta_data->>'card_number', NEW.email),
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM public.users) THEN 'owner'
      ELSE 'reader'
    END,
    now(), now()
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_user failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 10. updated_at 自动更新
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 11. 协作者扫码登录数据库函数
--     接收 password/floor_id/name/phone，返回用户 uid 和到期时间
-- ============================================================
CREATE OR REPLACE FUNCTION public.assistant_login(
  p_password text,
  p_floor_id text,
  p_name text,
  p_phone text
)
RETURNS TABLE(uid uuid, role text, managed_floors text[], assistant_expires_at timestamptz, msg text)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_cp RECORD;
  v_uid uuid;
  v_expires timestamptz;
  v_now time := (now() AT TIME ZONE 'Asia/Shanghai')::time;
  v_existing RECORD;
BEGIN
  -- 1. 校验密码
  SELECT * INTO v_cp FROM collab_passwords
    WHERE password = p_password
      AND floor_id = p_floor_id
      AND date = current_date
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text[], NULL::timestamptz,
      '密码无效或已过期'::text;
    RETURN;
  END IF;

  IF v_cp.used_count >= v_cp.max_uses THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text[], NULL::timestamptz,
      '密码使用次数已满'::text;
    RETURN;
  END IF;

  IF v_cp.expires_at < now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text[], NULL::timestamptz,
      '密码已过期'::text;
    RETURN;
  END IF;

  -- 2. 计算权限到期时间
  IF v_now >= '08:00'::time AND v_now < '13:15'::time THEN
    v_expires := (current_date + INTERVAL '5 hours 14 minutes')::timestamptz;
  ELSIF v_now >= '13:30'::time AND v_now < '17:30'::time THEN
    v_expires := (current_date + INTERVAL '9 hours 30 minutes')::timestamptz;
  ELSE
    v_expires := (current_date + INTERVAL '4 hours 30 minutes')::timestamptz;
  END IF;

  -- 3. 更新密码使用次数
  UPDATE collab_passwords SET used_count = used_count + 1 WHERE id = v_cp.id;

  -- 4. 查找或创建用户
  SELECT * INTO v_existing FROM public.users WHERE phone = p_phone LIMIT 1;

  IF FOUND THEN
    -- 已有用户：更新角色和到期时间
    UPDATE public.users SET
      role = 'assistant',
      managed_floors = ARRAY[p_floor_id],
      assistant_expires_at = v_expires,
      name = COALESCE(p_name, v_existing.name)
    WHERE public.users.uid = v_existing.uid;

    RETURN QUERY SELECT v_existing.uid, 'assistant'::text,
      (SELECT u.managed_floors FROM public.users u WHERE u.uid = v_existing.uid),
      v_expires, '登录成功'::text;
  ELSE
    -- 新用户：创建 auth.users + public.users
    -- 注意：在数据库函数内无法直接调用 Auth API，
    -- 实际创建 auth 用户由 Edge Function 完成
    -- 此处仅返回信息，由 Edge Function 处理创建逻辑
    RETURN QUERY SELECT NULL::uuid, 'assistant'::text,
      ARRAY[p_floor_id], v_expires, '新用户需由Edge Function创建'::text;
  END IF;
END;
$$;

-- ============================================================
-- 12. RLS 策略
-- ============================================================

-- users 表
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- 用户可读自己的记录
CREATE POLICY "Users read own" ON users FOR SELECT USING (auth.uid() = uid);
-- owner/admin 可读所有（用 JWT claim 避免递归）
CREATE POLICY "Owner admin read all" ON users FOR SELECT USING (
  auth.jwt() ->> 'role' = 'supabase_admin'
);
-- 注册插入自己的记录
CREATE POLICY "Signup insert own" ON users FOR INSERT WITH CHECK (auth.uid() = uid);
-- owner/admin 可插入
CREATE POLICY "Owner admin insert" ON users FOR INSERT WITH CHECK (
  auth.jwt() ->> 'role' = 'supabase_admin'
);
-- owner/admin 可更新
CREATE POLICY "Owner admin update" ON users FOR UPDATE USING (
  auth.jwt() ->> 'role' = 'supabase_admin'
);
-- 用户可更新自己的手机号和姓名
CREATE POLICY "Users update own" ON users FOR UPDATE USING (auth.uid() = uid);

-- floors 表
ALTER TABLE floors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read floors" ON floors FOR SELECT USING (auth.role() = 'authenticated');

-- seats 表
ALTER TABLE seats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read seats" ON seats FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Auth insert seats" ON seats FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Auth update seats" ON seats FOR UPDATE USING (auth.role() = 'authenticated');

-- seat_photos 表
ALTER TABLE seat_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read photos" ON seat_photos FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Auth insert photos" ON seat_photos FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Auth delete photos" ON seat_photos FOR DELETE USING (auth.role() = 'authenticated');

-- settings 表
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read settings" ON settings FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Admin manage settings" ON settings FOR ALL USING (
  auth.jwt() ->> 'role' = 'supabase_admin'
);

-- collab_passwords 表
ALTER TABLE collab_passwords ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read passwords" ON collab_passwords FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Auth insert passwords" ON collab_passwords FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Admin manage passwords" ON collab_passwords FOR UPDATE USING (
  auth.jwt() ->> 'role' = 'supabase_admin'
);
CREATE POLICY "Admin delete passwords" ON collab_passwords FOR DELETE USING (
  auth.jwt() ->> 'role' = 'supabase_admin'
);

-- Storage 策略（需先在 Dashboard 创建 seat-photos bucket）
-- 取消下面注释在 bucket 创建后执行
-- CREATE POLICY "Non-reader view photos" ON storage.objects
--   FOR SELECT USING (bucket_id = 'seat-photos' AND EXISTS (SELECT 1 FROM users WHERE uid = auth.uid() AND role != 'reader'));
-- CREATE POLICY "Writer upload photos" ON storage.objects
--   FOR INSERT WITH CHECK (bucket_id = 'seat-photos' AND EXISTS (SELECT 1 FROM users WHERE uid = auth.uid() AND role IN ('owner','admin','floor_manager','assistant')));
-- CREATE POLICY "Writer delete photos_storage" ON storage.objects
--   FOR DELETE USING (bucket_id = 'seat-photos' AND EXISTS (SELECT 1 FROM users WHERE uid = auth.uid() AND role IN ('owner','admin','floor_manager','assistant')));

// Supabase Edge Function: generate-report
// 使用 ExcelJS 保留原模板所有格式，只填充空单元格
// 部署: npx supabase functions deploy generate-report --project-ref <ref>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import ExcelJS from 'https://esm.sh/exceljs@4.4.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TIME_SLOTS = [
  '09:00','09:30','10:00','10:30','11:00','11:30','12:00',
  '13:00','13:30','14:00','14:30','15:00','15:30',
  '16:00','16:30','17:00','18:00','18:30','19:00',
  '19:30','20:00','20:30','21:00'
];

// ============ 区域配置 ============
// 各区域精确坐标：headerRow=责任人所在行，timeSlotRow=时段行(headerRow+1)，dataStartRow=数据首行(headerRow+2)
// seatCol=座位编号列，firstTimeCol=首个时段列，earlyShiftCol=早班责任人列，lateShiftCol=晚班责任人列
// maxRows=最大扫描行数（防止越界）

interface AreaMapping {
  floorId: number;
  areaName: string;
  seatPrefix: string;     // 座位编号前缀（用于判断 seat_id 归属区域）
  headerRow: number;       // 责任人所在行
  seatCol: number;         // 座位编号列 (B列)
  firstTimeCol: number;    // 首个时段列 (C列或AC列等)
  earlyShiftCol: number;   // 早班责任人填写列
  lateShiftCol: number;    // 晚班责任人填写列
  maxRows: number;         // 最大数据行数（从dataStartRow开始扫描）
}

const AREA_MAPPINGS: AreaMapping[] = [
  // 一楼 (B列=2 座位, C列=3 时段/早班, M列=13 晚班) — scan 确认正确
  { floorId:1, areaName:'中庭',     seatPrefix:'中',   headerRow:3,   seatCol:2,  firstTimeCol:3,  earlyShiftCol:3,  lateShiftCol:13,  maxRows:97 },
  { floorId:1, areaName:'报刊',     seatPrefix:'报',   headerRow:106, seatCol:2,  firstTimeCol:3,  earlyShiftCol:3,  lateShiftCol:13,  maxRows:131 },
  // 二楼 (AC列=29 座位, AD列=30 时段/早班, AN列=40 晚班) — scan 确认 seatCol 28→29, firstTimeCol 29→30
  { floorId:2, areaName:'北区',     seatPrefix:'北',   headerRow:3,   seatCol:29, firstTimeCol:30, earlyShiftCol:30, lateShiftCol:40, maxRows:62 },
  { floorId:2, areaName:'青少年区', seatPrefix:'青',   headerRow:70,  seatCol:29, firstTimeCol:30, earlyShiftCol:30, lateShiftCol:40, maxRows:25 },
  { floorId:2, areaName:'东区',     seatPrefix:'东',   headerRow:100, seatCol:29, firstTimeCol:30, earlyShiftCol:30, lateShiftCol:40, maxRows:81 },
  { floorId:2, areaName:'东区临时', seatPrefix:'东临', headerRow:186, seatCol:29, firstTimeCol:30, earlyShiftCol:30, lateShiftCol:40, maxRows:10 },
  { floorId:2, areaName:'南区',     seatPrefix:'南',   headerRow:200, seatCol:29, firstTimeCol:30, earlyShiftCol:30, lateShiftCol:40, maxRows:75 },
  { floorId:2, areaName:'西区',     seatPrefix:'西',   headerRow:281, seatCol:29, firstTimeCol:30, earlyShiftCol:30, lateShiftCol:40, maxRows:85 },
  // 三楼 (BD列=56 座位, BE列=57 时段/早班, BO列=67 晚班) — scan 确认 seatCol 54→56, firstTimeCol 55→57
  { floorId:3, areaName:'北区',     seatPrefix:'北',   headerRow:3,   seatCol:56, firstTimeCol:57, earlyShiftCol:57, lateShiftCol:67, maxRows:63 },
  { floorId:3, areaName:'南区',     seatPrefix:'南',   headerRow:70,  seatCol:56, firstTimeCol:57, earlyShiftCol:57, lateShiftCol:67, maxRows:67 },
  { floorId:3, areaName:'东区',     seatPrefix:'东',   headerRow:142, seatCol:56, firstTimeCol:57, earlyShiftCol:57, lateShiftCol:67, maxRows:157 },
  { floorId:3, areaName:'东区临时', seatPrefix:'东临', headerRow:304, seatCol:56, firstTimeCol:57, earlyShiftCol:57, lateShiftCol:67, maxRows:44 },
  { floorId:3, areaName:'西区',     seatPrefix:'西',   headerRow:353, seatCol:56, firstTimeCol:57, earlyShiftCol:57, lateShiftCol:67, maxRows:111 },
  // 四楼 (CE列=83 座位, CF列=84 时段/早班, CP列=94 晚班) — scan 确认 seatCol 80→83, firstTimeCol 81→84
  { floorId:4, areaName:'南区',     seatPrefix:'南',   headerRow:3,   seatCol:83, firstTimeCol:84, earlyShiftCol:84, lateShiftCol:94, maxRows:51 },
  { floorId:4, areaName:'西区',     seatPrefix:'西',   headerRow:58,  seatCol:83, firstTimeCol:84, earlyShiftCol:84, lateShiftCol:94, maxRows:65 },
  { floorId:4, areaName:'北区',     seatPrefix:'北',   headerRow:128, seatCol:83, firstTimeCol:84, earlyShiftCol:84, lateShiftCol:94, maxRows:41 },
  { floorId:4, areaName:'东区',     seatPrefix:'东',   headerRow:173, seatCol:83, firstTimeCol:84, earlyShiftCol:84, lateShiftCol:94, maxRows:37 },
  { floorId:4, areaName:'东区临时', seatPrefix:'东临', headerRow:214, seatCol:83, firstTimeCol:84, earlyShiftCol:84, lateShiftCol:94, maxRows:31 },
  // 五楼 (DF列=110 座位, DG列=111 时段/早班, DQ列=121 晚班) — scan 确认 seatCol 106→110, firstTimeCol 107→111
  { floorId:5, areaName:'西区',     seatPrefix:'西',   headerRow:3,   seatCol:110, firstTimeCol:111, earlyShiftCol:111, lateShiftCol:121, maxRows:65 },
  { floorId:5, areaName:'南区',     seatPrefix:'南',   headerRow:72,  seatCol:110, firstTimeCol:111, earlyShiftCol:111, lateShiftCol:121, maxRows:17 },
  { floorId:5, areaName:'东区',     seatPrefix:'东',   headerRow:94,  seatCol:110, firstTimeCol:111, earlyShiftCol:111, lateShiftCol:121, maxRows:115 },
  { floorId:5, areaName:'东区临时', seatPrefix:'东临', headerRow:215, seatCol:110, firstTimeCol:111, earlyShiftCol:111, lateShiftCol:121, maxRows:57 },
];

// ============ 工具函数 ============

function jsonResp(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function getDateStrings(dateStr?: string) {
  // 如果传入 dateStr (如 '2026-07-13')，使用该日期；否则使用北京时间当前日期
  let y: number, m: number, d: number;
  if (dateStr) {
    const parts = dateStr.split('-');
    y = parseInt(parts[0]); m = parseInt(parts[1]); d = parseInt(parts[2]);
  } else {
    const now = new Date();
    const bjMs = now.getTime() + 8 * 60 * 60 * 1000;
    const bj = new Date(bjMs);
    y = bj.getUTCFullYear(); m = bj.getUTCMonth() + 1; d = bj.getUTCDate();
  }
  const p = (x:number) => String(x).padStart(2,'0');
  return { sheetName: `${y}年${m}月${d}日`, fileName: `report_${y}-${p(m)}-${p(d)}.xlsx`, displayName: `${y}年${m}月${d}日座位管理统计表.xlsx`, datePath: `${y}-${p(m)}-${p(d)}` };
}

function getTimeSlotIndex(createdAt: string): number {
  const d = new Date(createdAt);
  // 转北京时间（UTC+8）
  const bjMs = d.getTime() + 8 * 60 * 60 * 1000;
  const bjDate = new Date(bjMs);
  const ts = `${String(bjDate.getUTCHours()).padStart(2,'0')}:${String(bjDate.getUTCMinutes()).padStart(2,'0')}`;
  for (let i = TIME_SLOTS.length - 1; i >= 0; i--) if (ts >= TIME_SLOTS[i]) return i;
  return -1;
}

// 早班 北京时间 08:30-13:14, 晚班 北京时间 13:15-21:20
// Edge Function 运行在 UTC 时区，需手动 +8 小时
function getBeijingMinutes(t: string): number {
  const d = new Date(t);
  // 转为北京时间（UTC+8）
  const bjMs = d.getTime() + 8 * 60 * 60 * 1000;
  const bjDate = new Date(bjMs);
  return bjDate.getUTCHours() * 60 + bjDate.getUTCMinutes();
}
function isEarlyShift(t: string): boolean { const m = getBeijingMinutes(t); return m >= 510 && m <= 794; }
function isLateShift(t: string): boolean { const m = getBeijingMinutes(t); return m >= 795 && m <= 1280; }

/** 安全获取单元格文本值 */
function getCellText(cell: ExcelJS.Cell): string {
  if (!cell || cell.value === null || cell.value === undefined) return '';
  if (typeof cell.value === 'string') return cell.value.trim();
  if (typeof cell.value === 'number') return String(cell.value);
  if (cell.value instanceof Date) {
    const h = String(cell.value.getHours()).padStart(2, '0');
    const m = String(cell.value.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  if (typeof cell.value === 'object') {
    const v = cell.value as any;
    // richText 数组：拼接每段文本
    if (v.richText) return v.richText.map((r: any) => r.text).join('');
    // 公式单元格：优先用 result，其次用 cached value
    if (v.result !== undefined && v.result !== null) return String(v.result).trim();
    if (v.value !== undefined && v.value !== null) return String(v.value).trim();
    // hyperlink 对象：取 text 或 hyperlink
    if (v.text) return v.text.toString().trim();
    if (v.hyperref) return v.hyperref.toString().trim();
    // sharedFormula：不能转成字符串
    if (v.sharedFormula) return '';
    // 兜底：避免返回 "[object Object]"
    console.warn('[getCellText] 无法识别的 cell.value 对象类型:', JSON.stringify(v));
    return '';
  }
  return String(cell.value);
}

/** 将列号转为 Excel 列字母（1=A, 27=AA）用于日志显示 */
function colToLetter(col: number): string {
  let result = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    col = Math.floor((col - 1) / 26);
  }
  return result;
}

/** 检查单元格是否为空（可安全填入数据） */
function isCellEmpty(cell: ExcelJS.Cell): boolean {
  return getCellText(cell) === '';
}

/** 将模板中的时段值归一化为 "HH:MM" 格式
 *  模板可能存储为 "9:00:00" (Date对象或字符串)，需统一为 "09:00"
 */
function normalizeTimeSlot(val: any): string {
  if (!val) return '';
  if (val instanceof Date) {
    return `${String(val.getHours()).padStart(2,'0')}:${String(val.getMinutes()).padStart(2,'0')}`;
  }
  const str = String(val).trim();
  const m = str.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2,'0')}:${m[2]}`;
  return str;
}

// ============ 主逻辑 ============

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const body = await req.json();
    if (body.action === 'generate') {
      // 【修复】增加 30 秒超时保护，防止长时间挂起导致定时任务停止
      const timeoutMs = 30000;
      const result = await Promise.race([
        handleGenerate(admin, body.date),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error(`报表生成超时（${timeoutMs / 1000}秒）`)), timeoutMs)
        )
      ]);
      return result as Response;
    }
    if (body.action === 'ping') return jsonResp({ success: true, msg: 'pong' });
    return jsonResp({ success: false, error: '未知操作' }, 400);
  } catch (err) {
    console.error('[generate-report] error:', err);
    return jsonResp({ success: false, error: String(err.message || err) }, 500);
  }
});

async function handleGenerate(admin: any, dateStr?: string) {
  console.log('[generate-report] 开始', dateStr ? `日期: ${dateStr}` : '(今天)');
  const { sheetName, fileName, displayName, datePath } = getDateStrings(dateStr);

  // ---- 1. 下载模板（尝试多个可能的文件名）----
  const templateNames = ['seat-report-template.xlsx', '改-2026座位管理表格汇总.xlsx'];
  let tpl: any = null;
  let tplName = '';
  for (const name of templateNames) {
    const { data, error } = await admin.storage.from('templates').download(name);
    if (data && !error) { tpl = data; tplName = name; break; }
    console.log('[generate-report] 模板', name, '不存在或下载失败:', error?.message);
  }
  if (!tpl) return jsonResp({ success: false, error: '下载模板失败：templates桶中未找到任何模板文件' }, 500);
  const tplBuf = await tpl.arrayBuffer();
  console.log('[generate-report] 使用模板:', tplName, '大小:', tplBuf.byteLength);

  // ---- 2. 用 ExcelJS 加载模板（保留所有格式）----
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(tplBuf);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) return jsonResp({ success: false, error: '模板中没有工作表' }, 500);

  // 重命名工作表
  worksheet.name = sheetName;
  console.log('[generate-report] 工作表已重命名为:', sheetName);

  // ---- 3. 查询指定日期照片数据 ----
  // 用北京时间确定日期范围，再转为 UTC 时间戳查询
  let y: number, m: number, d: number;
  if (dateStr) {
    const parts = dateStr.split('-');
    y = parseInt(parts[0]); m = parseInt(parts[1]) - 1; d = parseInt(parts[2]);
  } else {
    const now = new Date();
    const bjMs = now.getTime() + 8 * 60 * 60 * 1000;
    const bjDate = new Date(bjMs);
    y = bjDate.getUTCFullYear(); m = bjDate.getUTCMonth(); d = bjDate.getUTCDate();
  }
  const p = (x:number) => String(x).padStart(2,'0');
  // 北京时间 targetDate 00:00:00 = UTC (targetDate-8h)
  const todayStart = new Date(Date.UTC(y, m, d, 0, 0, 0) - 8 * 60 * 60 * 1000);
  // 北京时间 targetDate+1 00:00:00 = UTC (targetDate+1-8h)
  const tomorrowStart = new Date(Date.UTC(y, m, d+1, 0, 0, 0) - 8 * 60 * 60 * 1000);
  const todayStr = `${y}-${p(m+1)}-${p(d)}`;
  const todayStartISO = todayStart.toISOString();
  const tomorrowStartISO = tomorrowStart.toISOString();
  console.log('[generate-report] 北京时间日期:', todayStr);
  console.log('[generate-report] 查询UTC范围:', todayStartISO, '~', tomorrowStartISO);

  let photos: any[] = [];
  const { data: d1, error: e1 } = await admin.from('seat_photos')
    .select('seat_id, uploaded_by, created_at, time_slot, cell_key')
    .gte('created_at', todayStartISO)
    .lt('created_at', tomorrowStartISO);
  if (e1) {
    console.error('[generate-report] 查询出错:', e1.message);
    if (e1.message && e1.message.includes('does not exist')) {
      const { data: d2, error: e2 } = await admin.from('seat_photos')
        .select('seat_id, uploaded_by, created_at')
        .gte('created_at', todayStartISO)
        .lt('created_at', tomorrowStartISO);
      if (e2) return jsonResp({ success: false, error: '查询失败: ' + e2.message }, 500);
      photos = (d2 || []).map((p: any) => ({ ...p, time_slot: null }));
    } else {
      return jsonResp({ success: false, error: '查询失败: ' + e1.message }, 500);
    }
  } else {
    photos = d1 || [];
  }
  console.log('[generate-report] 照片数:', photos.length);

  if (photos.length === 0) {
    console.log('[generate-report] 今日无照片数据，生成空报表');
  }

  // ---- 4. 查询用户信息（责任人用）----
  const uids = [...new Set(photos.map((p: any) => p.uploaded_by).filter(Boolean))];
  let uMap: Record<string, any> = {};
  if (uids.length) {
    const { data: us } = await admin.from('users').select('uid,name,role,managed_floors').in('uid', uids);
    if (us) for (const u of us) uMap[u.uid] = u;
  }

  // ---- 5. 按 seat_id + time_slot 聚合图片数量 ----
  const stc: Record<string, Record<string, number>> = {};
  for (const p of photos) {
    let ts = p.time_slot;
    if (!ts || !TIME_SLOTS.includes(ts)) {
      const idx = getTimeSlotIndex(p.created_at);
      if (idx >= 0) ts = TIME_SLOTS[idx]; else continue;
    }
    if (!stc[p.seat_id]) stc[p.seat_id] = {};
    stc[p.seat_id][ts] = (stc[p.seat_id][ts] || 0) + 1;
  }
  console.log('[generate-report] 聚合结果：', Object.keys(stc).length, '个座位有数据');
  // 详细打印 stc 内容，帮助定位 seat_id 匹配问题
  for (const [sid, ts] of Object.entries(stc)) {
    console.log(`[stc] seat_id="${sid}" 时段数据:`, JSON.stringify(ts));
  }

  // ---- 6. 收集责任人（独立于座位行匹配，确保不遗漏）----
  const earlyShiftPersons: Record<string, Set<string>> = {};
  const lateShiftPersons: Record<string, Set<string>> = {};

  // 详细调试：打印前 10 条记录的时间判断和用户关联
  const debugCount = Math.min(photos.length, 10);
  for (let i = 0; i < debugCount; i++) {
    const p = photos[i];
    const bjMin = getBeijingMinutes(p.created_at);
    const bjHour = Math.floor(bjMin / 60);
    const bjMinute = bjMin % 60;
    const bjTimeStr = `${String(bjHour).padStart(2,'0')}:${String(bjMinute).padStart(2,'0')}`;
    const early = isEarlyShift(p.created_at);
    const late = isLateShift(p.created_at);
    const u = uMap[p.uploaded_by];
    console.log(`[责任人调试] 记录#${i}: seat_id=${p.seat_id}, cell_key=${p.cell_key}, uploaded_by=${p.uploaded_by}, userName=${u?.name||'(未找到)'}, created_at(UTC)=${p.created_at}, 北京时间=${bjTimeStr}, 北京分钟=${bjMin}, 早班=${early}, 晚班=${late}`);
  }

  for (const p of photos) {
    const seatId = p.seat_id;
    if (!seatId) continue;

    // 优先用 cell_key 判断区域归属（格式：fid-aname-sidx-tidx）
    let areaKey: string | null = null;
    if (p.cell_key && typeof p.cell_key === 'string') {
      const ckParts = p.cell_key.split('-');
      if (ckParts.length >= 2) {
        const ckFloorId = parseInt(ckParts[0]);
        const ckAreaName = ckParts[1];
        areaKey = `${ckFloorId}-${ckAreaName}`;
      }
    }

    // 回退：用 seat_id 前缀匹配（需结合楼层，只匹配 cell_key 中楼层的区域）
    if (!areaKey) {
      let matchedMapping: AreaMapping | null = null;
      const ckFloorId = p.cell_key ? parseInt(p.cell_key.split('-')[0]) : 0;
      for (const m of AREA_MAPPINGS) {
        if (seatId.startsWith(m.seatPrefix)) {
          // 如果有楼层信息，只匹配该楼层；否则选最长前缀
          if (ckFloorId && m.floorId !== ckFloorId) continue;
          if (!matchedMapping || m.seatPrefix.length > matchedMapping.seatPrefix.length) {
            matchedMapping = m;
          }
        }
      }
      if (!matchedMapping) {
        console.warn('[责任人] seat_id 未匹配任何区域:', seatId, 'cell_key:', p.cell_key);
        continue;
      }
      areaKey = `${matchedMapping.floorId}-${matchedMapping.areaName}`;
    }

    const u = uMap[p.uploaded_by];
    if (!u || !u.name) {
      // 详细日志：用户关联失败
      if (p.uploaded_by && !u) {
        console.warn('[责任人] uploaded_by 未在 users 表中找到:', p.uploaded_by, 'seat_id:', seatId);
      }
      continue;
    }

    const bjMin = getBeijingMinutes(p.created_at);
    const early = isEarlyShift(p.created_at);
    const late = isLateShift(p.created_at);

    if (early) {
      if (!earlyShiftPersons[areaKey]) earlyShiftPersons[areaKey] = new Set();
      earlyShiftPersons[areaKey].add(u.name);
    }
    if (late) {
      if (!lateShiftPersons[areaKey]) lateShiftPersons[areaKey] = new Set();
      lateShiftPersons[areaKey].add(u.name);
    }
  }
  // 调试日志：输出每个区域的早班和晚班名单
  for (const mapping of AREA_MAPPINGS) {
    const areaKey = `${mapping.floorId}-${mapping.areaName}`;
    const morningNames = earlyShiftPersons[areaKey] ? Array.from(earlyShiftPersons[areaKey]).join('、') : '(无)';
    const eveningNames = lateShiftPersons[areaKey] ? Array.from(lateShiftPersons[areaKey]).join('、') : '(无)';
    if (morningNames !== '(无)' || eveningNames !== '(无)') {
      console.log(`[责任人] ${mapping.floorId}楼${mapping.areaName} 早班: ${morningNames} 晚班: ${eveningNames}`);
    }
  }
  console.log('[generate-report] 早班区域数:', Object.keys(earlyShiftPersons).length, '晚班区域数:', Object.keys(lateShiftPersons).length);

  // ---- 7. 遍历每个区域，动态扫描座位行+时段列，填充数据 + 责任人 ----
  let totalFilled = 0;

  for (const mapping of AREA_MAPPINGS) {
    const timeSlotRow = mapping.headerRow + 1;  // 时段行 = 责任人行 + 1
    const dataStartRow = mapping.headerRow + 2;  // 数据首行 = 责任人行 + 2
    const areaKey = `${mapping.floorId}-${mapping.areaName}`;

    // 7a. 扫描时段行，构建 time_slot → 列号 映射
    const timeSlotColMap: Record<string, number> = {};
    for (let col = mapping.firstTimeCol; col < mapping.firstTimeCol + 30; col++) {
      const cellVal = worksheet.getCell(timeSlotRow, col);
      const ts = normalizeTimeSlot(cellVal.value);
      if (!ts) break;  // 空单元格，时段结束
      if (TIME_SLOTS.includes(ts)) {
        timeSlotColMap[ts] = col;
      }
    }

    // 7b. 扫描座位列，构建 seat_id → 行号 映射
    // 座位编号格式：中文前缀(中/报/北/青/东/东临/南/西) + 数字，过滤掉"释放数量"等统计行
    const seatIdPattern = /^[中报北青东南西临]+\d+$/;
    const seatRowMap: Record<string, number> = {};
    for (let r = 0; r < mapping.maxRows; r++) {
      const row = dataStartRow + r;
      const cellVal = worksheet.getCell(row, mapping.seatCol);
      const seatId = getCellText(cellVal);
      if (!seatId) continue;  // 空行跳过
      if (!seatIdPattern.test(seatId)) continue;  // 非座位编号（如"释放数量"统计行）跳过
      seatRowMap[seatId] = row;
    }
    // 【调试日志】打印扫描到的座位行映射，帮助定位区域座位读取问题
    console.log(`[seatRowMap] ${mapping.floorId}-${mapping.areaName}: seatCol=${mapping.seatCol}, dataStartRow=${dataStartRow}, maxRows=${mapping.maxRows}, 扫描到 ${Object.keys(seatRowMap).length} 个座位`, JSON.stringify(seatRowMap));

    // 7c. 填充座位标记（× / △）
    for (const [seatId, timeCounts] of Object.entries(stc)) {
      const row = seatRowMap[seatId];
      if (!row) {
        // 调试：打印未匹配的 seat_id，帮助定位格式差异
        console.warn(`[未匹配] 区域 ${mapping.floorId}-${mapping.areaName} 未找到 seat_id="${seatId}"（前缀应为"${mapping.seatPrefix}"）`);
        continue;
      }

      for (const [timeSlot, count] of Object.entries(timeCounts)) {
        const col = timeSlotColMap[timeSlot];
        if (!col) {
          console.warn(`[未匹配时段] ${mapping.floorId}-${mapping.areaName} seat_id="${seatId}" 时段="${timeSlot}" 不在模板中`);
          continue;
        }

        const cell = worksheet.getCell(row, col);
        if (!isCellEmpty(cell)) continue;  // 只填空单元格

        cell.value = count >= 2 ? '△' : '×';
        totalFilled++;
        console.log(`[填充] ${mapping.floorId}-${mapping.areaName} seat_id="${seatId}" 时段="${timeSlot}" count=${count} → ${colToLetter(col)}${row}`);
      }
    }

    // 7d. 填写责任人（无论有无图片数据，都尝试填写）
    if (earlyShiftPersons[areaKey]?.size > 0) {
      const cell = worksheet.getCell(mapping.headerRow, mapping.earlyShiftCol);
      if (isCellEmpty(cell)) {
        cell.value = Array.from(earlyShiftPersons[areaKey]).join('\u3001');
        totalFilled++;
      }
    }
    if (lateShiftPersons[areaKey]?.size > 0) {
      const cell = worksheet.getCell(mapping.headerRow, mapping.lateShiftCol);
      if (isCellEmpty(cell)) {
        cell.value = Array.from(lateShiftPersons[areaKey]).join('\u3001');
        totalFilled++;
      }
    }
  }

  console.log('[generate-report] 填充单元格数:', totalFilled);

  // ---- 7. 生成并上传 ----
  const outputBuf: any = await workbook.xlsx.writeBuffer();

  let uploadData: Uint8Array;
  if (outputBuf instanceof Uint8Array) uploadData = outputBuf;
  else if (outputBuf instanceof ArrayBuffer) uploadData = new Uint8Array(outputBuf);
  else if (outputBuf?.buffer instanceof ArrayBuffer) uploadData = new Uint8Array(outputBuf.buffer, outputBuf.byteOffset, outputBuf.byteLength);
  else uploadData = new Uint8Array(outputBuf);

  if (uploadData.byteLength === 0) return jsonResp({ success: false, error: '生成的文件为空' }, 500);

  const headerHex = Array.from(uploadData.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log('[generate-report] 文件头:', headerHex, '大小:', uploadData.byteLength);

  const reportPath = `reports/${fileName}`;
  const { error: upErr } = await admin.storage.from('reports').upload(reportPath, uploadData, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upsert: true
  });
  if (upErr) return jsonResp({ success: false, error: '上传失败: ' + upErr.message }, 500);

  console.log('[generate-report] 完成:', reportPath, '填充:', totalFilled);
  return jsonResp({ success: true, filename: displayName, storageName: fileName, size: uploadData.byteLength, filledCells: totalFilled });
}

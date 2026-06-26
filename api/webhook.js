const { google } = require('googleapis');
const crypto = require('crypto');

const LINE_TOKEN     = process.env.LINE_TOKEN;
const GEMINI_KEY     = process.env.GEMINI_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ══════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ══════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'LINE Bot พร้อมใช้งาน ✅' });
  }

  const { events = [] } = req.body || {};

  for (const event of events) {
    if (event.type !== 'message') continue;
    try {
      if (event.message.type === 'image') {
        await handleImage(event);
      } else if (event.message.type === 'text') {
        await handleText(event);
      }
    } catch (err) {
      console.error('Event error:', err);
      try {
        await pushMessage(event.source.userId,
          `❌ เกิดข้อผิดพลาด: ${err.message.slice(0, 100)}\nลองใหม่อีกครั้งครับ`);
      } catch (_) {}
    }
  }

  return res.status(200).json({ status: 'ok' });
};


// ══════════════════════════════════════════════════════════════
//  TEXT HANDLER
// ══════════════════════════════════════════════════════════════
async function handleText(event) {
  const { replyToken, source: { userId }, message: { text } } = event;
  const txt   = text.trim();
  const lower = txt.toLowerCase();

  if (lower === 'สรุป' || lower === 'summary') {
    await replySummaryExpense(replyToken);

  } else if (lower === 'สรุปรายรับ') {
    await replySummaryIncome(replyToken);

  } else if (lower === 'สรุปทั้งหมด' || lower === 'สรุปสุทธิ') {
    await replySummaryNet(replyToken);

  } else if (lower.startsWith('สรุปรายวัน')) {
    const datePart = txt.replace(/^สรุปรายวัน\s*/i, '').trim();
    let target;
    if (!datePart) {
      target = todayISO();
    } else {
      target = parseDate(datePart);
    }
    if (!target) {
      await replyText(replyToken, '❓ รูปแบบวันที่ไม่ถูกต้อง เช่น "สรุปรายวัน 25/6/2569"');
    } else {
      await replyDailySummary(replyToken, target);
    }

  } else if (lower === 'รายรับ') {
    await replyText(replyToken,
      '💚 บันทึกรายรับ\n─────────────────\n' +
      'พิมพ์ในรูปแบบนี้:\n\n' +
      'รายรับ [วันที่] [รายการ] [ยอด]\n\n' +
      'ตัวอย่าง:\nรายรับ วันนี้ เงินเดือน 15000\nรายรับ 25/6 ค่าจ้าง 5000'
    );

  } else if (/^รายรับ\s+/i.test(txt)) {
    await handleIncome(event, userId, txt.replace(/^รายรับ\s+/i, '').trim());

  } else if (lower === 'groupid') {
    const gid = event.source.groupId || event.source.userId;
    await replyText(replyToken, `Group ID: ${gid}`);

  } else {
    await replyText(replyToken,
      '🤖 สวัสดีครับ! สิ่งที่ทำได้:\n\n' +
      '📸 ส่งรูปสลิป → บันทึกรายจ่ายอัตโนมัติ\n' +
      '💚 "รายรับ วันที่ รายการ ยอด" → บันทึกรายรับ\n' +
      '📊 "สรุป" → รายจ่ายเดือนนี้\n' +
      '📈 "สรุปรายรับ" → รายรับเดือนนี้\n' +
      '⚖️ "สรุปทั้งหมด" → ยอดสุทธิเดือนนี้\n' +
      '📅 "สรุปรายวัน" → สรุปเมื่อวาน'
    );
  }
}


// ══════════════════════════════════════════════════════════════
//  INCOME
// ══════════════════════════════════════════════════════════════
async function handleIncome(event, userId, content) {
  const { replyToken } = event;
  await replyText(replyToken, '⏳ กำลังบันทึกรายรับ...');

  const data = await parseIncomeWithGemini(content);
  if (!data || !data.amount) {
    await pushMessage(event.source.groupId || userId,
      '❌ ไม่เข้าใจข้อมูลครับ กรุณาระบุให้ครบ\n' +
      'เช่น: รายรับ วันนี้ เงินเดือน 15000');
    return;
  }

  const auth   = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await ensureSheetExists(sheets, 'รายรับ',
    ['วันที่', 'ยอด (บาท)', 'รายการ', 'LINE UserID', 'บันทึกเมื่อ']);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'รายรับ!A:E',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        data.date || todayISO(),
        Number(data.amount) || 0,
        data.description || '',
        userId,
        todayISO()
      ]]
    }
  });

  const amtFmt = fmt(data.amount);
  await pushMessage(event.source.groupId || userId,
    '✅ บันทึกรายรับแล้ว!\n' +
    '─────────────────\n' +
    `📅 วันที่   ${fmtDateThai(data.date)}\n` +
    `📝 รายการ  ${data.description || '-'}\n` +
    `💰 ยอด     ฿${amtFmt}\n` +
    '─────────────────\n' +
    '💾 บันทึกใน Google Sheets แล้ว'
  );
}


// ══════════════════════════════════════════════════════════════
//  IMAGE (SLIP)
// ══════════════════════════════════════════════════════════════
async function handleImage(event) {
  const { replyToken, message: { id: messageId }, source: { userId } } = event;
  await replyText(replyToken, '⏳ กำลังอ่านสลิป...');

  // 1. Download from LINE
  const imgRes = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
  );
  const imgBuf    = await imgRes.arrayBuffer();
  const imgBase64 = Buffer.from(imgBuf).toString('base64');
  const mimeType  = imgRes.headers.get('content-type') || 'image/jpeg';

  // 2. Analyze with Gemini
  async function analyzeSlipWithGemini(base64, mimeType) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: 'นี่คือสลิปโอนเงิน ตอบ JSON เท่านั้น ห้ามมีข้อความอื่น (date: YYYY-MM-DD ค.ศ.):\n{"date":"","amount":0,"description":"","recipient":"","note":""}' }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
      })
    }
  );
  const json = await res.json();
  console.log('Gemini raw response:', JSON.stringify(json));
  
  if (!json.candidates || !json.candidates[0]) {
    throw new Error('Gemini ไม่ตอบกลับ: ' + JSON.stringify(json));
  }
  
  let text = json.candidates[0].content.parts[0].text.trim();
  text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Gemini ตอบไม่ใช่ JSON: ' + text.slice(0, 100));
  return JSON.parse(match[0]);
}
  const data = await analyzeSlipWithGemini(imgBase64, mimeType);
  // 3. Save to Drive
  const auth  = getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });
  const driveUrl = await saveImageToDrive(drive, imgBuf, mimeType, `slip_${messageId}.jpg`, data.date);

  // 4. Save to Sheets
  const sheets = google.sheets({ version: 'v4', auth });
  await ensureSheetExists(sheets, 'รายจ่าย',
    ['วันที่', 'ยอด (บาท)', 'รายการ', 'ผู้รับ/ธนาคาร', 'หมายเหตุ', 'ลิงก์สลิป', 'LINE UserID', 'บันทึกเมื่อ']);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'รายจ่าย!A:G',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        data.date || todayISO(),
        Number(data.amount) || 0,
        data.description || '',
        data.recipient   || '',
        data.note        || '',
        driveUrl         || '',
        userId,
        todayISO()
      ]]
    }
  });

  const amtFmt = fmt(data.amount || 0);
  await pushMessage(event.source.groupId || userId,
    '✅ บันทึกรายจ่ายแล้ว!\n' +
    '─────────────────\n' +
    `📅 วันที่    ${fmtDateThai(data.date)}\n` +
    `💰 ยอด      ฿${amtFmt}\n` +
    `📝 รายการ   ${data.description || 'ไม่พบ'}\n` +
    `🏦 ผู้รับ    ${data.recipient   || 'ไม่พบ'}\n` +
    '─────────────────\n' +
    '💾 บันทึกใน Google Sheets + Drive แล้ว\n' +
    (driveUrl ? `🖼 ดูสลิป: ${driveUrl}` : '')
  );
}


// ══════════════════════════════════════════════════════════════
//  GEMINI
// ══════════════════════════════════════════════════════════════
async function analyzeSlipWithGemini(base64, mimeType) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: 'นี่คือสลิปโอนเงิน ตอบ JSON เท่านั้น ห้ามมีข้อความอื่น (date: YYYY-MM-DD ค.ศ.):\n{"date":"","amount":0,"description":"","recipient":"","note":""}' }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
      })
    }
  );
  const json = await res.json();
  let text = json.candidates[0].content.parts[0].text.trim();
  text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(text);
}

async function parseIncomeWithGemini(text) {
  const today = todayISO();
  
  // หายอดเงิน (ตัวเลขสุดท้าย)
  const amountMatch = text.match(/[\d,]+(?:\.\d+)?(?=\s*$)/);
  const amount = amountMatch ? parseFloat(amountMatch[0].replace(/,/g, '')) : null;
  
  // หาวันที่
  let date = today;
  if (/วันนี้|today/i.test(text)) date = today;
  else if (/เมื่อวาน/i.test(text)) {
    const d = new Date(); d.setDate(d.getDate() - 1);
    date = d.toISOString().split('T')[0];
  } else {
    const m = text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (m) {
      let [, d, mo, y] = m;
      y = y ? parseInt(y) : new Date().getFullYear();
      if (y > 2400) y -= 543;
      if (y < 100) y += 2000;
      date = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }
  
  // หา description (ลบวันที่และยอดออก)
  let description = text
    .replace(/วันนี้|เมื่อวาน|today/gi, '')
    .replace(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/, '')
    .replace(/[\d,]+(?:\.\d+)?(?=\s*$)/, '')
    .trim();

  return { date, amount, description };
}


// ══════════════════════════════════════════════════════════════
//  GOOGLE DRIVE
// ══════════════════════════════════════════════════════════════
async function saveImageToDrive(drive, imgBuf, mimeType, filename, slipDate) {
  const monthFolder = slipDate ? slipDate.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const folder = `สลิปรายจ่าย/${monthFolder}`;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const crypto    = require('crypto');

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId  = `${folder}/${filename.replace('.jpg', '')}`;
  const toSign    = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha256').update(toSign).digest('hex');

  const formData = new FormData();
  formData.append('file', new Blob([imgBuf], { type: mimeType }), filename);
  formData.append('api_key', apiKey);
  formData.append('timestamp', timestamp);
  formData.append('public_id', publicId);
  formData.append('folder', folder);
  formData.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData
  });

  const json = await res.json();
  return json.secure_url || '';
}


// ══════════════════════════════════════════════════════════════
//  GOOGLE SHEETS
// ══════════════════════════════════════════════════════════════
function getGoogleAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.JWT({
    email: creds.client_email,
    key:   creds.private_key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });
}

async function ensureSheetExists(sheets, name, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${name}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
}

async function getSheetRows(sheets, sheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:G`
    });
    const rows = res.data.values || [];
    return rows.length > 1 ? rows.slice(1) : [];
  } catch { return []; }
}


// ══════════════════════════════════════════════════════════════
//  SUMMARIES
// ══════════════════════════════════════════════════════════════
async function replySummaryExpense(replyToken) {
  const auth   = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const rows   = await getSheetRows(sheets, 'รายจ่าย');
  if (!rows.length) { await replyText(replyToken, '📭 ยังไม่มีรายการรายจ่าย'); return; }

  const total  = rows.reduce((s, r) => s + (Number(r[1]) || 0), 0);
  const recent = rows.slice(-5).reverse()
    .map(r => `• ${r[0]}  ฿${fmt(r[1])}  ${String(r[2]||'').slice(0,15)}`).join('\n');

  await replyText(replyToken,
    `📊 สรุปรายจ่าย\n─────────────────\n` +
    `รายการทั้งหมด: ${rows.length} รายการ\nยอดรวม: ฿${fmt(total)}\n\n` +
    `5 รายการล่าสุด:\n${recent}`
  );
}

async function replySummaryIncome(replyToken) {
  const auth   = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const rows   = await getSheetRows(sheets, 'รายรับ');
  if (!rows.length) { await replyText(replyToken, '📭 ยังไม่มีรายการรายรับ'); return; }

  const total  = rows.reduce((s, r) => s + (Number(r[1]) || 0), 0);
  const recent = rows.slice(-5).reverse()
    .map(r => `• ${r[0]}  ฿${fmt(r[1])}  ${String(r[2]||'').slice(0,15)}`).join('\n');

  await replyText(replyToken,
    `📈 สรุปรายรับ\n─────────────────\n` +
    `รายการทั้งหมด: ${rows.length} รายการ\nยอดรวม: ฿${fmt(total)}\n\n` +
    `5 รายการล่าสุด:\n${recent}`
  );
}

async function replySummaryNet(replyToken) {
  const auth   = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const expRows = (await getSheetRows(sheets, 'รายจ่าย')).filter(r => inRange(r[0], monthStart, now));
  const incRows = (await getSheetRows(sheets, 'รายรับ')).filter(r  => inRange(r[0], monthStart, now));

  const totalExp = expRows.reduce((s, r) => s + (Number(r[1]) || 0), 0);
  const totalInc = incRows.reduce((s, r)  => s + (Number(r[1]) || 0), 0);
  const net      = totalInc - totalExp;

  const monthLabel = now.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
  const todayLabel = now.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });

  await replyText(replyToken,
    `📆 สรุปประจำเดือน${monthLabel}\n(1 – ${todayLabel})\n─────────────────\n` +
    `💚 รายรับ    ฿${fmt(totalInc)}\n❤️ รายจ่าย   ฿${fmt(totalExp)}\n─────────────────\n` +
    `${net >= 0 ? '✅' : '⚠️'} คงเหลือ   ฿${fmt(net)}`
  );
}

async function replyDailySummary(replyToken, targetDate) {
  const auth   = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const start = new Date(targetDate + 'T00:00:00');
  const end   = new Date(targetDate + 'T23:59:59');

  const expRows = (await getSheetRows(sheets, 'รายจ่าย')).filter(r => inRange(r[0], start, end));
  const incRows = (await getSheetRows(sheets, 'รายรับ')).filter(r  => inRange(r[0], start, end));

  const totalExp = expRows.reduce((s, r) => s + (Number(r[1]) || 0), 0);
  const totalInc = incRows.reduce((s, r)  => s + (Number(r[1]) || 0), 0);
  const net      = totalInc - totalExp;

  const dateLabel = new Date(targetDate).toLocaleDateString('th-TH',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  await replyText(replyToken,
    `📅 สรุปรายวัน\n${dateLabel}\n─────────────────\n` +
    `💚 รายรับ    ฿${fmt(totalInc)}\n❤️ รายจ่าย   ฿${fmt(totalExp)}\n─────────────────\n` +
    `${net >= 0 ? '✅' : '⚠️'} คงเหลือ   ฿${fmt(net)}`
  );
}


// ══════════════════════════════════════════════════════════════
//  LINE API
// ══════════════════════════════════════════════════════════════
async function replyText(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

async function pushMessage(to, text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: to, messages: [{ type: 'text', text }] })
  });
}


// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function parseDate(txt) {
  const t = txt.trim();
  if (t === 'วันนี้' || t === 'today') return todayISO();
  if (t === 'เมื่อวาน') {
    const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0];
  }
  const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m.map(Number);
    if (y > 2400) y -= 543;
    if (y < 100)  y += y < 70 ? 2000 : 1900;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  const p = Date.parse(t);
  return isNaN(p) ? null : new Date(p).toISOString().split('T')[0];
}

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d) && d >= from && d <= to;
}

function todayISO() {
  const d = new Date();
  d.setHours(d.getHours() + 7);
  return d.toISOString().split('T')[0];
}

function fmtDateThai(dateStr) {
  if (!dateStr) return 'ไม่พบ';
  try {
    return new Date(dateStr).toLocaleDateString('th-TH',
      { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return dateStr; }
}

function fmt(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
}

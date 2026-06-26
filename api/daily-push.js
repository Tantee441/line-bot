// api/daily-push.js  ← เรียกผ่าน Vercel Cron ทุกวัน ตี 1
// Cron schedule กำหนดใน vercel.json: "0 18 * * *" (18:00 UTC = 01:00 ICT)

const { google } = require('googleapis');

const LINE_TOKEN     = process.env.LINE_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GROUP_IDS      = process.env.LINE_GROUP_IDS || ''; // คั่นด้วย comma

module.exports = async function handler(req, res) {
  // กัน cron ถูกเรียกจากคนอื่น
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end('Unauthorized');
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const targetDate = yesterday.toISOString().split('T')[0];

  const text = await buildDailySummaryText(targetDate);

  // ส่งไปทุก group ที่ลงทะเบียนไว้
  const groups = GROUP_IDS.split(',').map(s => s.trim()).filter(Boolean);
  for (const gid of groups) {
    await pushMessage(gid, text);
  }

  console.log(`Daily push sent to ${groups.length} group(s) for ${targetDate}`);
  return res.status(200).json({ sent: groups.length, date: targetDate });
};


async function buildDailySummaryText(targetDate) {
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

  return (
    `📅 สรุปรายวัน\n${dateLabel}\n─────────────────\n` +
    `💚 รายรับ    ฿${fmt(totalInc)}\n` +
    `❤️ รายจ่าย   ฿${fmt(totalExp)}\n` +
    `─────────────────\n` +
    `${net >= 0 ? '✅' : '⚠️'} คงเหลือ   ฿${fmt(net)}`
  );
}


// ── Google Sheets ──
function getGoogleAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.JWT({
    email: creds.client_email,
    key:   creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function getSheetRows(sheets, name) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${name}!A:G`
    });
    const rows = res.data.values || [];
    return rows.length > 1 ? rows.slice(1) : [];
  } catch { return []; }
}

// ── LINE ──
async function pushMessage(to, text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
}

// ── Helpers ──
function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d) && d >= from && d <= to;
}
function fmt(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
}

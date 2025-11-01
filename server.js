// server.js
// Node.js server for "Десятка" game. Uses sqlite (better-sqlite3), Express and node-cron.
// IMPORTANT: set BOT_TOKEN in environment variables on Railway. Do NOT commit your token.

const express = require('express');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(bodyParser.json({limit:'1mb'}));
app.use(cors());

// Config via env
const BOT_TOKEN = process.env.BOT_TOKEN || '<PUT_YOUR_BOT_TOKEN_HERE>';
const SERVER_URL = process.env.SERVER_URL || 'https://desyatka-production.up.railway.app';
const PORT = process.env.PORT || 3000;
const RESET_HOUR = process.env.RESET_HOUR ? parseInt(process.env.RESET_HOUR,10) : 6;

// DB init
const db = new Database('game.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT,
  tokens INTEGER DEFAULT 0,
  created_at TEXT,
  invited_by INTEGER,
  invited_confirmed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  score INTEGER,
  day TEXT,
  UNIQUE(user_id, day)
);
CREATE TABLE IF NOT EXISTS channels (
  username TEXT PRIMARY KEY,
  reward INTEGER DEFAULT 700
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,        -- 'invite'|'subscribe'|'daily'
  meta TEXT,        -- json metadata like channel username or inviter id
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  val TEXT
);
`);

// helpers
function todayDateString(d = new Date()){
  return d.toISOString().slice(0,10);
}

function nowISO(){ return new Date().toISOString(); }

// Telegram webhook: handle /start with param (invites)
app.post('/telegram_webhook', (req, res) => {
  const upd = req.body;
  try {
    if (upd.message && upd.message.text && upd.message.text.startsWith('/start')) {
      const parts = upd.message.text.split(' ');
      const startParam = parts[1] || null;
      const tgUser = upd.message.from;
      const tid = tgUser.id;
      const now = nowISO();
      db.prepare(`INSERT OR IGNORE INTO users (id, name, tokens, created_at) VALUES (?, ?, 0, ?)`).run(tid, (tgUser.username || tgUser.first_name || 'Игрок'), now);
      if (startParam) {
        const inviterId = parseInt(startParam, 10);
        if (!isNaN(inviterId) && inviterId !== tid) {
          db.prepare(`UPDATE users SET invited_by = ? WHERE id = ?`).run(inviterId, tid);
        }
      }
    }
  } catch(e) {
    console.error('webhook error', e);
  }
  res.sendStatus(200);
});

// Claim invite when invited user opens webapp - credits inviter +500 once
app.post('/claim_invite', (req, res) => {
  const { user_id, name } = req.body;
  if (!user_id) return res.status(400).json({ error:'user_id required' });
  const now = nowISO();
  db.prepare(`INSERT OR IGNORE INTO users (id, name, tokens, created_at) VALUES (?, ?, 0, ?)`).run(user_id, name||'Игрок', now);
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user_id);
  if (u && u.invited_by && !u.invited_confirmed) {
    const inviter = db.prepare(`SELECT * FROM users WHERE id = ?`).get(u.invited_by);
    if (inviter) {
      db.prepare(`UPDATE users SET tokens = tokens + 500 WHERE id = ?`).run(inviter.id);
      db.prepare(`UPDATE users SET invited_confirmed = 1 WHERE id = ?`).run(user_id);
      notifyUser(inviter.id, `Тебе начислено +500 златников за приглашённого ${u.name || ''}`);
      db.prepare(`INSERT INTO claims (user_id,type,meta,created_at) VALUES (?,?,?,?)`).run(inviter.id,'invite',JSON.stringify({invited:user_id}),now);
      return res.json({ credited: true });
    }
  }
  return res.json({ credited: false });
});

// Submit score
app.post('/submit_score', (req,res) => {
  const { user_id, name, score } = req.body;
  if (!user_id || typeof score !== 'number') return res.status(400).json({ error:'user_id and score required' });
  const now = nowISO();
  db.prepare(`INSERT OR IGNORE INTO users (id, name, tokens, created_at) VALUES (?, ?, 0, ?)`).run(user_id, name||'Игрок', now);
  const day = todayDateString();
  const existing = db.prepare(`SELECT * FROM scores WHERE user_id = ? AND day = ?`).get(user_id, day);
  if (!existing) db.prepare(`INSERT INTO scores (user_id, score, day) VALUES (?, ?, ?)`).run(user_id, score, day);
  else if (score > existing.score) db.prepare(`UPDATE scores SET score = ? WHERE user_id = ? AND day = ?`).run(score, user_id, day);
  res.json({ ok:true });
});

// Leaderboard and player rank
app.get('/leaderboard', (req,res) => {
  const uid = parseInt(req.query.user_id,10) || null;
  const day = todayDateString();
  const rows = db.prepare(`
    SELECT s.user_id, s.score, COALESCE(u.name,'Игрок') AS name
    FROM scores s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.day = ?
    ORDER BY s.score DESC, s.user_id ASC
  `).all(day);
  const top10 = rows.slice(0,10);
  let rank = null;
  for (let i=0;i<rows.length;i++){ if (rows[i].user_id === uid) { rank = i+1; break; } }
  if (!rank && uid) {
    const exist = db.prepare(`SELECT id FROM users WHERE id = ?`).get(uid);
    if (exist) rank = rows.length + 1;
  }
  res.json({ top10, rank: rank || null, day });
});

// My tokens
app.get('/my_tokens', (req,res) => {
  const uid = parseInt(req.query.user_id,10);
  if (!uid) return res.status(400).json({ error:'user_id required' });
  const u = db.prepare(`SELECT tokens FROM users WHERE id = ?`).get(uid);
  res.json({ tokens: (u ? u.tokens : 0) });
});

// Channels (tasks) APIs
app.get('/channels', (req,res) => {
  const rows = db.prepare(`SELECT username,reward FROM channels`).all();
  res.json({ channels: rows });
});

// Admin: add channel
app.post('/admin/add_channel', (req,res) => {
  // PROTECT in prod!
  const { username, reward } = req.body;
  if (!username) return res.status(400).json({ error:'username required' });
  const r = reward && Number.isInteger(reward) ? reward : 700;
  db.prepare(`INSERT OR REPLACE INTO channels (username,reward) VALUES (?,?)`).run(username, r);
  res.json({ ok:true });
});

// Claim subscription: verifies via getChatMember and credits user once per channel
app.post('/claim_subscribe', async (req,res) => {
  const { user_id, channel } = req.body;
  if (!user_id || !channel) return res.status(400).json({ error:'user_id and channel required' });
  // check if already claimed
  const already = db.prepare(`SELECT * FROM claims WHERE user_id = ? AND type = 'subscribe' AND meta = ?`).get(user_id, channel);
  if (already) return res.json({ credited:false, reason:'already_claimed' });
  // call Telegram API getChatMember
  if (!BOT_TOKEN || BOT_TOKEN.includes('<PUT')) return res.status(500).json({ error:'Bot token not configured on server' });
  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${encodeURIComponent(channel)}&user_id=${user_id}`);
    const j = await resp.json();
    if (j.ok && j.result && j.result.status && ['member','creator','administrator'].includes(j.result.status)) {
      // credit user
      const ch = db.prepare(`SELECT reward FROM channels WHERE username = ?`).get(channel);
      const reward = ch ? ch.reward : 700;
      db.prepare(`UPDATE users SET tokens = tokens + ? WHERE id = ?`).run(reward, user_id);
      db.prepare(`INSERT INTO claims (user_id,type,meta,created_at) VALUES (?,?,?,?)`).run(user_id, 'subscribe', channel, nowISO());
      notifyUser(user_id, `Тебе начислено +${reward} златников за подписку на @${channel}`);
      return res.json({ credited:true, reward });
    } else {
      return res.json({ credited:false, reason:'not_member' });
    }
  } catch(e) {
    console.error('claim_subscribe error', e);
    return res.status(500).json({ error:'telegram_api_error' });
  }
});

// Admin trigger for daily distribution (for safety)
function runDailyDistribution() {
  const day = todayDateString();
  const rows = db.prepare(`
    SELECT s.user_id, s.score
    FROM scores s
    WHERE s.day = ?
    ORDER BY s.score DESC, s.user_id ASC
  `).all(day);
  const toCredit = [];
  for (let i=0;i<rows.length;i++){
    const pos = i+1;
    let amount = 5;
    if (pos===1) amount = 100;
    else if (pos===2) amount = 70;
    else if (pos===3) amount = 50;
    else if (pos>=6 && pos<=10) amount = 30;
    toCredit.push({ user_id: rows[i].user_id, amount });
  }
  const upd = db.prepare(`UPDATE users SET tokens = tokens + ? WHERE id = ?`);
  toCredit.forEach(t => upd.run(t.amount, t.user_id));
  db.prepare(`INSERT OR REPLACE INTO meta (key,val) VALUES ('last_reset',?)`).run(new Date().toISOString());
  // Optionally record claims for daily distribution
  toCredit.forEach(t => {
    db.prepare(`INSERT INTO claims (user_id,type,meta,created_at) VALUES (?,?,?,?)`).run(t.user_id,'daily',JSON.stringify({amount:t.amount}), nowISO());
  });
  console.log('Daily distribution finished, credited', toCredit.length, 'users');
}

// cron schedule at RESET_HOUR server local time
cron.schedule(`0 ${RESET_HOUR} * * *`, () => {
  console.log('Running daily distribution at', new Date().toString());
  runDailyDistribution();
});

// Admin manual trigger endpoint (protect on prod)
app.post('/admin/run_reset', (req,res) => {
  runDailyDistribution();
  res.json({ ok:true });
});

// helper: send message via bot
async function notifyUser(userId, text) {
  if (!BOT_TOKEN || BOT_TOKEN.includes('<PUT')) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id: userId, text })
    });
  } catch (e) {
    console.warn('notify fail', e);
  }
}

app.listen(PORT, () => {
  console.log('Server listening on', PORT);
  console.log('Ensure BOT_TOKEN is set and webhook points to /telegram_webhook');
});

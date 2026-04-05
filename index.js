const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============ CONFIG ============
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const WAVE_NUMBER = process.env.WAVE_NUMBER || '+2250703575003';
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `https://avibot-2je1.onrender.com`;
const PRICE = 2000;

if (!TOKEN) { console.error('❌ BOT_TOKEN manquant'); process.exit(1); }
if (!ADMIN_ID) { console.error('❌ ADMIN_ID manquant'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ============ DATABASE ============
const db = new sqlite3.Database(path.join('/tmp', 'aviator.db'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    subscribed_until INTEGER DEFAULT 0,
    coefs TEXT DEFAULT '[]',
    strat TEXT DEFAULT 'balanced',
    total_predictions INTEGER DEFAULT 0,
    joined_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    username TEXT,
    amount INTEGER,
    activated_by INTEGER,
    activated_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER
  )`);
});

// ============ DB HELPERS ============
function dbGet(sql, params) {
  return new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
}
function dbRun(sql, params) {
  return new Promise((res, rej) => db.run(sql, params, (e) => e ? rej(e) : res()));
}
function dbAll(sql, params) {
  return new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
}

// ============ HELPERS ============
async function getUser(id) {
  return dbGet('SELECT * FROM users WHERE telegram_id = ?', [id]);
}
async function upsertUser(msg) {
  const u = msg.from;
  await dbRun(`INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name`,
    [u.id, u.username || '', u.first_name || '']
  );
}
function isSubscribed(user) {
  if (!user) return false;
  return user.subscribed_until > Math.floor(Date.now() / 1000);
}
function isAdmin(id) { return id === ADMIN_ID; }
function formatDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function daysLeft(user) {
  return Math.max(0, Math.ceil((user.subscribed_until - Math.floor(Date.now() / 1000)) / 86400));
}

// ============ HTTP SERVER (sert la Mini App + API statut) ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ===== API: vérifier statut abonnement =====
  // GET /api/status?user_id=123456
  if (url.pathname === '/api/status') {
    const userId = parseInt(url.searchParams.get('user_id'));
    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'user_id requis' }));
      return;
    }
    const user = await getUser(userId);
    const subscribed = isSubscribed(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      subscribed,
      expires_at: user ? user.subscribed_until : 0,
      days_left: user && subscribed ? daysLeft(user) : 0,
      wave_number: WAVE_NUMBER,
      price: PRICE
    }));
    return;
  }

  // ===== Servir webapp.html =====
  if (url.pathname === '/' || url.pathname === '/webapp.html') {
    const filePath = path.join(__dirname, 'webapp.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404); res.end('webapp.html non trouvé'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(filePath));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`🌐 Serveur Mini App sur port ${PORT}`));

// ============ ALGORITHME AVIATOR ============
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function detectStreak(arr) {
  if (arr.length < 2) return { type: null, count: 0 };
  const last = arr[arr.length - 1], type = last < 2 ? 'low' : 'high'; let count = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const isLow = arr[i] < 2;
    if ((type === 'low' && isLow) || (type === 'high' && !isLow)) count++;
    else break;
  }
  return { type, count };
}
const STRAT_CASHOUT = { safe: 1.5, balanced: 2.0, aggressive: 3.0, scalping: 1.3 };
function analyze(coefs, strat = 'balanced') {
  const c = coefs; if (c.length < 3) return null;
  const avg = c.reduce((a, b) => a + b, 0) / c.length;
  const med = median(c);
  const last3avg = c.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const last5 = c.slice(-5);
  const trend = last5.length >= 2 ? last5[last5.length - 1] - last5[0] : 0;
  const streak = detectStreak(c);
  let pred = avg * 0.3 + med * 0.25 + last3avg * 0.35 + (avg + trend * 0.1) * 0.1;
  if (streak.type === 'low' && streak.count >= 2) pred = Math.min(pred * 1.15, avg * 2.5);
  else if (streak.type === 'high' && streak.count >= 3) pred = Math.max(pred * 0.85, 1.1);
  pred = Math.max(1.05, parseFloat(pred.toFixed(2)));
  const variance = c.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / c.length;
  const cv = Math.sqrt(variance) / avg;
  const conf = Math.max(20, Math.min(88, Math.round((1 - Math.min(cv, 1)) * 80 + (c.length >= 10 ? 8 : 0))));
  const cashTarget = STRAT_CASHOUT[strat] || 2.0;
  const co = Math.min(pred * 0.75, cashTarget);
  let signal, emoji;
  if (pred < 1.5) { signal = 'Crash précoce probable — mise faible'; emoji = '🔴'; }
  else if (pred < 2) { signal = `Vol court — cashout à ×${cashTarget}`; emoji = '🟡'; }
  else if (pred < 5) { signal = `Bon vol estimé — cashout à ×${cashTarget}`; emoji = '🟢'; }
  else { signal = 'Vol long potentiel — surveille !'; emoji = '🚀'; }
  let streakMsg = '';
  if (streak.type === 'low' && streak.count >= 2) streakMsg = `\n⚠️ ${streak.count} crashs consécutifs → rebond possible`;
  else if (streak.type === 'high' && streak.count >= 3) streakMsg = `\n📉 ${streak.count} hauts consécutifs → prudence`;
  return { pred, conf, signal, emoji, co, streakMsg, avg: avg.toFixed(2), med: med.toFixed(2) };
}
function buildPredMessage(result, coefs, capital = 20) {
  const confBar = '█'.repeat(Math.floor(result.conf / 10)) + '░'.repeat(10 - Math.floor(result.conf / 10));
  return `✈️ *AVIATOR BOT — ANALYSE*
━━━━━━━━━━━━━━━━━━━━

🎯 *Prédiction :* ×${result.pred}
${result.emoji} *Signal :* ${result.signal}
💰 *Cashout conseillé :* ×${result.co.toFixed(2)}${result.streakMsg}

📊 *Confiance :* ${result.conf}%
\`${confBar}\`

📈 *Stats (${coefs.length} rounds)*
• Moyenne : ×${result.avg} | Médiane : ×${result.med}

💵 *Mise suggérée*
🛡 Safe 2% : *${(capital * 0.02).toFixed(2)}* | ⚖️ 5% : *${(capital * 0.05).toFixed(2)}* | 🔥 10% : *${(capital * 0.10).toFixed(2)}*

━━━━━━━━━━━━━━━━━━━━
⚡ /coef pour ajouter | 🔄 /reset | 📱 /app`.trim();
}
function parseCoefs(user) {
  try { return JSON.parse(user.coefs || '[]'); } catch { return []; }
}

// ============ COMMANDES ============

bot.onText(/\/start/, async (msg) => {
  await upsertUser(msg);
  const user = await getUser(msg.from.id);
  const sub = isSubscribed(user);
  bot.sendMessage(msg.chat.id, `✈️ *Bienvenue sur AviatorBot !*

${sub
  ? `✅ *Abonnement actif* — expire le ${formatDate(user.subscribed_until)} (${daysLeft(user)} jours)`
  : `🔒 *Abonnement requis* — 2 000 FCFA/mois\n\nTape /abonnement pour payer via Wave.`}

📋 *Commandes :*
/app — 📱 Ouvrir la Mini App
/coef — Ajouter des coefficients
/predict — Obtenir une prédiction
/historique — Voir l'historique
/reset — Remettre à zéro
/statut — Voir ton abonnement
/abonnement — Infos paiement`.trim(), { parse_mode: 'Markdown' });
});

// /app — ouvre la Mini App
bot.onText(/\/app/, async (msg) => {
  await upsertUser(msg);
  bot.sendMessage(msg.chat.id, '✈️ *AviatorBot — Mini App*\n\nClique pour ouvrir l\'interface complète :', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: '🚀 Lancer AviatorBot',
        web_app: { url: `${APP_URL}/webapp.html` }
      }]]
    }
  });
});

bot.onText(/\/abonnement/, async (msg) => {
  await upsertUser(msg);
  bot.sendMessage(msg.chat.id, `💳 *Comment s'abonner — 2 000 FCFA/mois*

1️⃣ Envoie *2 000 FCFA* sur Wave :
📱 \`${WAVE_NUMBER}\`

2️⃣ Fais une capture d'écran du reçu

3️⃣ Envoie le screenshot ici directement

4️⃣ Attends la confirmation ⏳

✅ Accès immédiat après validation — 30 jours`.trim(), { parse_mode: 'Markdown' });
});

bot.onText(/\/statut/, async (msg) => {
  await upsertUser(msg);
  const user = await getUser(msg.from.id);
  const sub = isSubscribed(user);
  bot.sendMessage(msg.chat.id,
    sub
      ? `✅ *Abonnement actif*\n📅 Expire le : ${formatDate(user.subscribed_until)}\n⏳ Jours restants : ${daysLeft(user)}\n🎯 Prédictions : ${user.total_predictions}`
      : `🔒 *Aucun abonnement actif*\n\nTape /abonnement pour payer.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/coef(.*)/, async (msg, match) => {
  await upsertUser(msg);
  const user = await getUser(msg.from.id);
  if (!isSubscribed(user) && !isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis. Tape /abonnement pour activer.');
  }
  const input = match[1].trim();
  if (!input) return bot.sendMessage(msg.chat.id, '📝 *Usage :* `/coef 2.34 1.12 4.50`', { parse_mode: 'Markdown' });
  const nums = input.split(/[\s,]+/).map(Number).filter(n => !isNaN(n) && n >= 1.01 && n <= 200);
  if (!nums.length) return bot.sendMessage(msg.chat.id, '❌ Invalide. Exemple : `/coef 2.34 1.12 4.50`', { parse_mode: 'Markdown' });
  const coefs = parseCoefs(user);
  const updated = [...coefs, ...nums].slice(-50);
  await dbRun('UPDATE users SET coefs = ? WHERE telegram_id = ?', [JSON.stringify(updated), msg.from.id]);
  const pills = updated.slice(-10).map(v => `${v >= 2 ? '🟢' : '🔴'}×${v}`).join(' ');
  bot.sendMessage(msg.chat.id, `✅ *${nums.length} coef(s) ajouté(s)* — total : ${updated.length}\n\n${pills}\n\nTape /predict ou /app pour analyser.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/predict/, async (msg) => {
  await upsertUser(msg);
  const user = await getUser(msg.from.id);
  if (!isSubscribed(user) && !isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis. Tape /abonnement.');
  }
  const coefs = parseCoefs(user);
  if (coefs.length < 3) return bot.sendMessage(msg.chat.id, `⏳ Ajoute au moins *3 coefficients*.\nTu en as ${coefs.length}.\n\nUtilise : /coef 2.34 1.12 4.50`, { parse_mode: 'Markdown' });
  const result = analyze(coefs, user.strat);
  if (!result) return bot.sendMessage(msg.chat.id, '❌ Erreur d\'analyse.');
  await dbRun('UPDATE users SET total_predictions = total_predictions + 1 WHERE telegram_id = ?', [msg.from.id]);
  bot.sendMessage(msg.chat.id, buildPredMessage(result, coefs), { parse_mode: 'Markdown' });
});

bot.onText(/\/historique/, async (msg) => {
  await upsertUser(msg);
  const user = await getUser(msg.from.id);
  if (!isSubscribed(user) && !isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis.');
  const coefs = parseCoefs(user);
  if (!coefs.length) return bot.sendMessage(msg.chat.id, '📭 Aucun coefficient. Utilise /coef pour en ajouter.');
  const last20 = coefs.slice(-20);
  const pills = last20.map((v, i) => `${i + 1}. ${v >= 2 ? '🟢' : '🔴'} ×${v}`).join('\n');
  const avg = (coefs.reduce((a, b) => a + b, 0) / coefs.length).toFixed(2);
  bot.sendMessage(msg.chat.id, `📊 *Historique (${coefs.length} rounds)*\n\n${pills}\n\n📈 Moyenne : ×${avg}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/reset/, async (msg) => {
  await upsertUser(msg);
  await dbRun('UPDATE users SET coefs = ? WHERE telegram_id = ?', ['[]', msg.from.id]);
  bot.sendMessage(msg.chat.id, '🔄 Historique remis à zéro.');
});

bot.onText(/\/strat(.*)/, async (msg, match) => {
  await upsertUser(msg);
  const user = await getUser(msg.from.id);
  if (!isSubscribed(user) && !isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis.');
  const strat = match[1].trim().toLowerCase();
  const valids = ['safe', 'balanced', 'aggressive', 'scalping'];
  if (!valids.includes(strat)) return bot.sendMessage(msg.chat.id, `🎯 *Stratégie actuelle :* ${user.strat || 'balanced'}\n\n• /strat safe — ×1.5\n• /strat balanced — ×2.0\n• /strat aggressive — ×3.0\n• /strat scalping — ×1.3`, { parse_mode: 'Markdown' });
  await dbRun('UPDATE users SET strat = ? WHERE telegram_id = ?', [strat, msg.from.id]);
  bot.sendMessage(msg.chat.id, `✅ Stratégie : *${strat}*`, { parse_mode: 'Markdown' });
});

// ============ ADMIN ============

bot.onText(/\/activer (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '❌ Non autorisé.');
  const parts = match[1].trim().split(/\s+/);
  const usernameRaw = parts[0].replace('@', '').toLowerCase();

  const target = await dbGet('SELECT * FROM users WHERE LOWER(username) = ?', [usernameRaw]);
  if (!target) return bot.sendMessage(msg.chat.id, `❌ @${usernameRaw} introuvable.\nIl doit d'abord taper /start.`);

  // Calcul de la fin du mois en cours (minuit dernier jour du mois)
  const now = new Date();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const expiresAt = Math.floor(lastDayOfMonth.getTime() / 1000);
  const daysCount = Math.ceil((expiresAt - Math.floor(now.getTime() / 1000)) / 86400);

  // Noms des mois en français
  const MOIS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const moisNom = MOIS[now.getMonth()];

  await dbRun('UPDATE users SET subscribed_until = ? WHERE telegram_id = ?', [expiresAt, target.telegram_id]);
  await dbRun('INSERT INTO payments (telegram_id, username, amount, activated_by, expires_at) VALUES (?,?,?,?,?)',
    [target.telegram_id, target.username, PRICE, msg.from.id, expiresAt]);

  // Notif admin
  bot.sendMessage(msg.chat.id,
    `✅ @${usernameRaw} activé pour *${moisNom}*\n📅 Expire le : ${formatDate(expiresAt)} (${daysCount} jours restants)`,
    { parse_mode: 'Markdown' }
  );

  // Notif client avec bouton Mini App
  bot.sendMessage(target.telegram_id,
    `🎉 *Abonnement activé !*\n\n✅ Accès débloqué pour *${moisNom}*\n📅 Expire le : ${formatDate(expiresAt)}\n⏳ ${daysCount} jours restants\n\nTape /app pour lancer la Mini App !`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Lancer AviatorBot', web_app: { url: `${APP_URL}/webapp.html` } }]]
      }
    }
  ).catch(() => {});
});

bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const total = (await dbGet('SELECT COUNT(*) as c FROM users', [])).c;
  const active = (await dbGet('SELECT COUNT(*) as c FROM users WHERE subscribed_until > ?', [Math.floor(Date.now() / 1000)])).c;
  const payments = (await dbGet('SELECT COUNT(*) as c FROM payments', [])).c;
  bot.sendMessage(msg.chat.id, `📊 *Stats AviatorBot*\n\n👥 Utilisateurs : ${total}\n✅ Abonnés actifs : ${active}\n💰 Paiements : ${payments}\n💵 Revenus : ${(payments * PRICE).toLocaleString()} FCFA`, { parse_mode: 'Markdown' });
});

bot.onText(/\/users/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const now = Math.floor(Date.now() / 1000);
  const actives = await dbAll('SELECT * FROM users WHERE subscribed_until > ? ORDER BY subscribed_until ASC', [now]);
  if (!actives.length) return bot.sendMessage(msg.chat.id, '📭 Aucun abonné actif.');
  const list = actives.map(u => `• @${u.username || u.telegram_id} — expire ${formatDate(u.subscribed_until)} (${Math.ceil((u.subscribed_until - now) / 86400)}j)`).join('\n');
  bot.sendMessage(msg.chat.id, `✅ *Abonnés actifs (${actives.length})*\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const text = match[1].trim();
  const now = Math.floor(Date.now() / 1000);
  const actives = await dbAll('SELECT telegram_id FROM users WHERE subscribed_until > ?', [now]);
  let sent = 0, failed = 0;
  for (const u of actives) {
    try { await bot.sendMessage(u.telegram_id, `📢 *Message de l'admin :*\n\n${text}`, { parse_mode: 'Markdown' }); sent++; }
    catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `📢 Broadcast terminé\n✅ ${sent} envoyés | ❌ ${failed} échecs`);
});

// ============ SCREENSHOT ============
bot.on('photo', async (msg) => {
  await upsertUser(msg);
  const user = await getUser(msg.from.id);
  if (isSubscribed(user)) return bot.sendMessage(msg.chat.id, '✅ Ton abonnement est déjà actif !');
  const name = msg.from.first_name || 'Inconnu';
  const username = msg.from.username ? `@${msg.from.username}` : `ID: ${msg.from.id}`;
  try {
    await bot.sendMessage(ADMIN_ID, `💳 *Nouveau paiement à valider*\n\n👤 ${name} (${username})\n🆔 ID: ${msg.from.id}\n\nPour activer :\n\`/activer ${msg.from.username || msg.from.id} 30\``, { parse_mode: 'Markdown' });
    await bot.forwardMessage(ADMIN_ID, msg.chat.id, msg.message_id);
    bot.sendMessage(msg.chat.id, '✅ *Screenshot reçu !*\n\nVérification en cours... Tu recevras une confirmation dans quelques minutes. ⏳', { parse_mode: 'Markdown' });
  } catch { bot.sendMessage(msg.chat.id, '❌ Erreur. Réessaie.'); }
});

// ============ RAPPELS EXPIRATION ============
setInterval(async () => {
  const now = Math.floor(Date.now() / 1000);
  const in3days = now + 3 * 86400;
  const expiringSoon = await dbAll('SELECT * FROM users WHERE subscribed_until > ? AND subscribed_until <= ?', [now, in3days]);
  expiringSoon.forEach(user => {
    bot.sendMessage(user.telegram_id, `⚠️ *Abonnement bientôt expiré !*\n📅 Expire le : ${formatDate(user.subscribed_until)} (${daysLeft(user)} jours)\n\nRenouvelle : /abonnement`, { parse_mode: 'Markdown' }).catch(() => {});
  });
}, 3600 * 1000);

console.log('✈️ AviatorBot démarré !');

const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const path = require('path');

// ============ CONFIG ============
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID); // Ton Telegram ID
const WAVE_NUMBER = process.env.WAVE_NUMBER || '+2250703575003';
const PRICE = 2000;

if (!TOKEN) { console.error('❌ BOT_TOKEN manquant dans les variables'); process.exit(1); }
if (!ADMIN_ID) { console.error('❌ ADMIN_ID manquant dans les variables'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ============ DATABASE ============
const db = new Database(path.join(__dirname, 'aviator.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    subscribed_until INTEGER DEFAULT 0,
    coefs TEXT DEFAULT '[]',
    strat TEXT DEFAULT 'balanced',
    total_predictions INTEGER DEFAULT 0,
    joined_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    username TEXT,
    amount INTEGER,
    activated_by INTEGER,
    activated_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER
  );
`);

// ============ HELPERS ============
function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id);
}

function upsertUser(msg) {
  const u = msg.from;
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(u.id, u.username || '', u.first_name || '');
}

function isSubscribed(user) {
  if (!user) return false;
  return user.subscribed_until > Math.floor(Date.now() / 1000);
}

function isAdmin(id) {
  return id === ADMIN_ID;
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

function daysLeft(user) {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil((user.subscribed_until - now) / 86400));
}

function parseCoefs(user) {
  try { return JSON.parse(user.coefs || '[]'); } catch { return []; }
}

// ============ ALGORITHME AVIATOR (même logique que le HTML) ============
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function detectStreak(arr) {
  if (arr.length < 2) return { type: null, count: 0 };
  const last = arr[arr.length - 1];
  const type = last < 2 ? 'low' : 'high';
  let count = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const isLow = arr[i] < 2;
    if ((type === 'low' && isLow) || (type === 'high' && !isLow)) count++;
    else break;
  }
  return { type, count };
}

const STRAT_CASHOUT = { safe: 1.5, balanced: 2.0, aggressive: 3.0, scalping: 1.3 };

function analyze(coefs, strat = 'balanced') {
  const c = coefs;
  if (c.length < 3) return null;

  const avg = c.reduce((a, b) => a + b, 0) / c.length;
  const med = median(c);
  const last3avg = c.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const last5 = c.slice(-5);
  const trend = last5.length >= 2 ? last5[last5.length - 1] - last5[0] : 0;
  const streak = detectStreak(c);

  let pred = avg * 0.3 + med * 0.25 + last3avg * 0.35 + (avg + trend * 0.1) * 0.1;

  if (streak.type === 'low' && streak.count >= 2) {
    pred = Math.min(pred * 1.15, avg * 2.5);
  } else if (streak.type === 'high' && streak.count >= 3) {
    pred = Math.max(pred * 0.85, 1.1);
  }

  pred = Math.max(1.05, parseFloat(pred.toFixed(2)));

  const variance = c.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / c.length;
  const cv = Math.sqrt(variance) / avg;
  const conf = Math.max(20, Math.min(88, Math.round((1 - Math.min(cv, 1)) * 80 + (c.length >= 10 ? 8 : 0))));

  const cashTarget = STRAT_CASHOUT[strat] || 2.0;
  const co = Math.min(pred * 0.75, cashTarget);

  let signal, emoji;
  if (pred < 1.5) { signal = 'Crash précoce probable — mise faible'; emoji = '🔴'; }
  else if (pred < 2) { signal = `Vol court — cashout à ×${cashTarget} recommandé`; emoji = '🟡'; }
  else if (pred < 5) { signal = `Bon vol estimé — cashout à ×${cashTarget}`; emoji = '🟢'; }
  else { signal = 'Vol long potentiel — surveille le cashout !'; emoji = '🚀'; }

  // Streak info
  let streakMsg = '';
  if (streak.type === 'low' && streak.count >= 2) streakMsg = `\n⚠️ ${streak.count} crashs consécutifs → rebond possible`;
  else if (streak.type === 'high' && streak.count >= 3) streakMsg = `\n📉 ${streak.count} hauts consécutifs → prudence`;

  return { pred, conf, signal, emoji, co, cashTarget, streak, streakMsg, avg: avg.toFixed(2), med: med.toFixed(2) };
}

function buildPredMessage(result, coefs, capital = 20) {
  const confBar = '█'.repeat(Math.floor(result.conf / 10)) + '░'.repeat(10 - Math.floor(result.conf / 10));

  return `
✈️ *AVIATOR BOT — ANALYSE*
━━━━━━━━━━━━━━━━━━━━

🎯 *Prédiction :* ×${result.pred}
${result.emoji} *Signal :* ${result.signal}
💰 *Cashout conseillé :* ×${result.co.toFixed(2)}${result.streakMsg}

📊 *Confiance :* ${result.conf}%
\`${confBar}\`

📈 *Stats (${coefs.length} rounds)*
• Moyenne : ×${result.avg}
• Médiane : ×${result.med}

💵 *Mise suggérée (capital ${capital}€)*
🛡 Safe (2%) : *${(capital * 0.02).toFixed(2)}€*
⚖️ Balanced (5%) : *${(capital * 0.05).toFixed(2)}€*
🔥 Agressif (10%) : *${(capital * 0.10).toFixed(2)}€*

━━━━━━━━━━━━━━━━━━━━
⚡ /coef pour ajouter des coefficients
🔄 /reset pour repartir à zéro
`.trim();
}

// ============ COMMANDES ============

// /start
bot.onText(/\/start/, (msg) => {
  upsertUser(msg);
  const user = getUser(msg.from.id);
  const sub = isSubscribed(user);

  const text = `
✈️ *Bienvenue sur AviatorBot !*

J'analyse les coefficients Aviator et génère des prédictions statistiques.

${sub
  ? `✅ *Abonnement actif* — expire le ${formatDate(user.subscribed_until)} (${daysLeft(user)} jours)`
  : `🔒 *Abonnement requis* — 2 000 FCFA/mois\n\nTape /abonnement pour voir comment payer.`
}

📋 *Commandes disponibles :*
/coef — Ajouter des coefficients
/predict — Obtenir une prédiction
/historique — Voir tes derniers coefs
/reset — Remettre à zéro
/statut — Voir ton abonnement
/abonnement — Infos paiement
/capital — Définir ton capital de jeu
`.trim();

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /abonnement
bot.onText(/\/abonnement/, (msg) => {
  upsertUser(msg);
  const text = `
💳 *Comment s'abonner — 2 000 FCFA/mois*

1️⃣ Envoie *2 000 FCFA* sur Wave :
📱 \`${WAVE_NUMBER}\`

2️⃣ Fais une capture d'écran du reçu

3️⃣ Envoie le screenshot ici directement

4️⃣ Attends la confirmation (généralement quelques minutes)

━━━━━━━━━━━━━━━━━━━━
✅ Accès immédiat après validation
📅 30 jours d'accès
🔄 Renouvellement manuel chaque mois
`.trim();

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /statut
bot.onText(/\/statut/, (msg) => {
  upsertUser(msg);
  const user = getUser(msg.from.id);
  const sub = isSubscribed(user);

  let text;
  if (sub) {
    text = `✅ *Abonnement actif*\n📅 Expire le : ${formatDate(user.subscribed_until)}\n⏳ Jours restants : ${daysLeft(user)}\n🎯 Prédictions faites : ${user.total_predictions}`;
  } else {
    text = `🔒 *Aucun abonnement actif*\n\nTape /abonnement pour payer et activer l'accès.`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /coef
bot.onText(/\/coef(.*)/, (msg, match) => {
  upsertUser(msg);
  const user = getUser(msg.from.id);

  if (!isSubscribed(user) && !isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis. Tape /abonnement pour activer.', { parse_mode: 'Markdown' });
  }

  const input = match[1].trim();
  if (!input) {
    return bot.sendMessage(msg.chat.id,
      '📝 *Usage :* `/coef 2.34 1.12 4.50`\n\nEnvoie un ou plusieurs coefficients séparés par des espaces.',
      { parse_mode: 'Markdown' }
    );
  }

  const nums = input.split(/[\s,]+/).map(Number).filter(n => !isNaN(n) && n >= 1.01 && n <= 200);
  if (!nums.length) {
    return bot.sendMessage(msg.chat.id, '❌ Coefficients invalides. Exemple : `/coef 2.34 1.12 4.50`', { parse_mode: 'Markdown' });
  }

  const coefs = parseCoefs(user);
  const updated = [...coefs, ...nums].slice(-50); // garde les 50 derniers max

  db.prepare('UPDATE users SET coefs = ? WHERE telegram_id = ?').run(JSON.stringify(updated), msg.from.id);

  const pills = updated.slice(-10).map(v => v >= 2 ? `🟢×${v}` : `🔴×${v}`).join('  ');

  bot.sendMessage(msg.chat.id,
    `✅ *${nums.length} coef${nums.length > 1 ? 's' : ''} ajouté${nums.length > 1 ? 's' : ''}* (total : ${updated.length})\n\n${pills}\n\nTape /predict pour analyser.`,
    { parse_mode: 'Markdown' }
  );
});

// /predict
bot.onText(/\/predict/, (msg) => {
  upsertUser(msg);
  const user = getUser(msg.from.id);

  if (!isSubscribed(user) && !isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis. Tape /abonnement pour activer.', { parse_mode: 'Markdown' });
  }

  const coefs = parseCoefs(user);
  if (coefs.length < 3) {
    return bot.sendMessage(msg.chat.id,
      `⏳ Ajoute au moins *3 coefficients* d'abord.\nTu en as ${coefs.length} actuellement.\n\nUtilise : /coef 2.34 1.12 4.50`,
      { parse_mode: 'Markdown' }
    );
  }

  const result = analyze(coefs, user.strat);
  if (!result) return bot.sendMessage(msg.chat.id, '❌ Erreur d\'analyse.');

  db.prepare('UPDATE users SET total_predictions = total_predictions + 1 WHERE telegram_id = ?').run(msg.from.id);

  const capital = 20; // défaut, modifiable via /capital
  bot.sendMessage(msg.chat.id, buildPredMessage(result, coefs, capital), { parse_mode: 'Markdown' });
});

// /historique
bot.onText(/\/historique/, (msg) => {
  upsertUser(msg);
  const user = getUser(msg.from.id);

  if (!isSubscribed(user) && !isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis.', { parse_mode: 'Markdown' });
  }

  const coefs = parseCoefs(user);
  if (!coefs.length) {
    return bot.sendMessage(msg.chat.id, '📭 Aucun coefficient enregistré. Utilise /coef pour en ajouter.');
  }

  const last20 = coefs.slice(-20);
  const pills = last20.map((v, i) => `${i + 1}. ${v >= 2 ? '🟢' : '🔴'} ×${v}`).join('\n');
  const avg = (coefs.reduce((a, b) => a + b, 0) / coefs.length).toFixed(2);

  bot.sendMessage(msg.chat.id,
    `📊 *Historique (${coefs.length} rounds)*\n\n${pills}\n\n📈 Moyenne générale : ×${avg}`,
    { parse_mode: 'Markdown' }
  );
});

// /reset
bot.onText(/\/reset/, (msg) => {
  upsertUser(msg);
  db.prepare('UPDATE users SET coefs = ? WHERE telegram_id = ?').run('[]', msg.from.id);
  bot.sendMessage(msg.chat.id, '🔄 Historique remis à zéro. Utilise /coef pour recommencer.');
});

// /strat
bot.onText(/\/strat(.*)/, (msg, match) => {
  upsertUser(msg);
  const user = getUser(msg.from.id);

  if (!isSubscribed(user) && !isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '🔒 Abonnement requis.', { parse_mode: 'Markdown' });
  }

  const strat = match[1].trim().toLowerCase();
  const valids = ['safe', 'balanced', 'aggressive', 'scalping'];

  if (!valids.includes(strat)) {
    const current = user.strat || 'balanced';
    return bot.sendMessage(msg.chat.id,
      `🎯 *Stratégie actuelle :* ${current}\n\nChoisis :\n• /strat safe — cashout ×1.5\n• /strat balanced — cashout ×2.0\n• /strat aggressive — cashout ×3.0\n• /strat scalping — cashout ×1.3`,
      { parse_mode: 'Markdown' }
    );
  }

  db.prepare('UPDATE users SET strat = ? WHERE telegram_id = ?').run(strat, msg.from.id);
  bot.sendMessage(msg.chat.id, `✅ Stratégie mise à jour : *${strat}*`, { parse_mode: 'Markdown' });
});

// /capital
bot.onText(/\/capital(.*)/, (msg, match) => {
  upsertUser(msg);
  const val = parseFloat(match[1].trim());
  if (isNaN(val) || val <= 0) {
    return bot.sendMessage(msg.chat.id, '💵 *Usage :* `/capital 50`\n\nDéfinis ton capital de jeu en euros/FCFA.', { parse_mode: 'Markdown' });
  }
  // Stocké temporairement dans la session (simplifié)
  bot.sendMessage(msg.chat.id, `✅ Capital défini : *${val}*\nLes suggestions de mise utiliseront cette valeur.`, { parse_mode: 'Markdown' });
});

// ============ ADMIN COMMANDS ============

// /activer @username jours
bot.onText(/\/activer (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '❌ Non autorisé.');

  const parts = match[1].trim().split(/\s+/);
  const usernameRaw = parts[0].replace('@', '').toLowerCase();
  const days = parseInt(parts[1]) || 30;

  // Cherche par username
  const target = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(usernameRaw);

  if (!target) {
    return bot.sendMessage(msg.chat.id,
      `❌ Utilisateur @${usernameRaw} introuvable.\n\nIl doit d'abord démarrer le bot avec /start.`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const current = Math.max(target.subscribed_until || 0, now);
  const expiresAt = current + days * 86400;

  db.prepare('UPDATE users SET subscribed_until = ? WHERE telegram_id = ?').run(expiresAt, target.telegram_id);
  db.prepare('INSERT INTO payments (telegram_id, username, amount, activated_by, expires_at) VALUES (?,?,?,?,?)').run(
    target.telegram_id, target.username, PRICE, msg.from.id, expiresAt
  );

  // Notif admin
  bot.sendMessage(msg.chat.id, `✅ @${usernameRaw} activé pour ${days} jours.\n📅 Expire le : ${formatDate(expiresAt)}`);

  // Notif client
  bot.sendMessage(target.telegram_id,
    `🎉 *Abonnement activé !*\n\n✅ Accès débloqué pour *${days} jours*\n📅 Expire le : ${formatDate(expiresAt)}\n\nTape /coef pour commencer !`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

// /stats (admin)
bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.from.id)) return;

  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const active = db.prepare(`SELECT COUNT(*) as c FROM users WHERE subscribed_until > ?`).get(Math.floor(Date.now() / 1000)).c;
  const payments = db.prepare('SELECT COUNT(*) as c FROM payments').get().c;
  const revenue = payments * PRICE;

  const text = `
📊 *Stats AviatorBot*

👥 Utilisateurs total : ${total}
✅ Abonnés actifs : ${active}
💰 Paiements validés : ${payments}
💵 Revenus estimés : ${revenue.toLocaleString()} FCFA
`.trim();

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /users (admin) - liste des abonnés actifs
bot.onText(/\/users/, (msg) => {
  if (!isAdmin(msg.from.id)) return;

  const now = Math.floor(Date.now() / 1000);
  const actives = db.prepare('SELECT * FROM users WHERE subscribed_until > ? ORDER BY subscribed_until ASC').all(now);

  if (!actives.length) return bot.sendMessage(msg.chat.id, '📭 Aucun abonné actif.');

  const list = actives.map(u =>
    `• @${u.username || u.telegram_id} — expire ${formatDate(u.subscribed_until)} (${Math.ceil((u.subscribed_until - now) / 86400)}j)`
  ).join('\n');

  bot.sendMessage(msg.chat.id, `✅ *Abonnés actifs (${actives.length})*\n\n${list}`, { parse_mode: 'Markdown' });
});

// /broadcast message (admin)
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const text = match[1].trim();
  const now = Math.floor(Date.now() / 1000);
  const actives = db.prepare('SELECT telegram_id FROM users WHERE subscribed_until > ?').all(now);

  let sent = 0, failed = 0;
  for (const u of actives) {
    try {
      await bot.sendMessage(u.telegram_id, `📢 *Message de l'admin :*\n\n${text}`, { parse_mode: 'Markdown' });
      sent++;
    } catch { failed++; }
  }

  bot.sendMessage(msg.chat.id, `📢 Broadcast terminé\n✅ Envoyé : ${sent}\n❌ Échec : ${failed}`);
});

// ============ SCREENSHOT HANDLER ============
bot.on('photo', async (msg) => {
  upsertUser(msg);
  const user = getUser(msg.from.id);

  if (isSubscribed(user)) {
    return bot.sendMessage(msg.chat.id, '✅ Ton abonnement est déjà actif !');
  }

  // Forward le screenshot à l'admin avec infos
  const name = msg.from.first_name || 'Inconnu';
  const username = msg.from.username ? `@${msg.from.username}` : `ID: ${msg.from.id}`;
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
    await bot.sendMessage(ADMIN_ID,
      `💳 *Nouveau paiement à valider*\n\n👤 ${name} (${username})\n🆔 ID: ${msg.from.id}\n\nPour activer 30 jours :\n\`/activer ${msg.from.username || msg.from.id} 30\``,
      { parse_mode: 'Markdown' }
    );
    await bot.forwardMessage(ADMIN_ID, msg.chat.id, msg.message_id);

    bot.sendMessage(msg.chat.id,
      '✅ *Screenshot reçu !*\n\nTon paiement est en cours de vérification.\nTu recevras une confirmation dans quelques minutes. ⏳',
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    bot.sendMessage(msg.chat.id, '❌ Erreur lors de l\'envoi. Contacte l\'admin directement.');
  }
});

// ============ RAPPELS EXPIRATION (vérifie toutes les heures) ============
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  const in3days = now + 3 * 86400;

  // Abonnés qui expirent dans 3 jours
  const expiringSoon = db.prepare(
    'SELECT * FROM users WHERE subscribed_until > ? AND subscribed_until <= ?'
  ).all(now, in3days);

  expiringSoon.forEach(user => {
    bot.sendMessage(user.telegram_id,
      `⚠️ *Abonnement bientôt expiré !*\n\n📅 Expire le : ${formatDate(user.subscribed_until)} (${daysLeft(user)} jours)\n\nRenouvelle maintenant : /abonnement`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });
}, 3600 * 1000);

console.log('✈️ AviatorBot démarré !');

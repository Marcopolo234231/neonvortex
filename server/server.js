'use strict';
// Neon Vortex server for a Raspberry Pi: serves the game and stores accounts + saves.
// No dependencies, only Node.js (18+). Every account is one small JSON file, written only
// when something changes (end of a run, menu choices), so the SD card sees very few writes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.NV_DATA || path.join(__dirname, 'data'));
const USERS = path.join(DATA, 'users');
const GAME = path.resolve(__dirname, '..', 'index.html');
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set when running behind Cloudflare Tunnel / nginx
const SESSION_DAYS = 180, MAX_SESSIONS = 10, MAX_SAVE = 64 * 1024, MAX_BODY = 128 * 1024;

fs.mkdirSync(USERS, { recursive: true });

// ---- names: 3-16 letters (any language, incl. ä ö ü é), digits, space, _ - .
// "Marco", "marco" and "ＭＡＲＣＯ" (full width) count as the same name.
const NAME_RE = /^[\p{L}\p{N}_\-. ]{3,16}$/u;
function normName(n) { return String(n == null ? '' : n).normalize('NFKC').trim().replace(/\s+/g, ' '); }
function nameKey(n) { return crypto.createHash('sha256').update(normName(n).toLowerCase()).digest('hex').slice(0, 32); }
function checkName(n) {
  if (!NAME_RE.test(n)) return 'Name: 3–16 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, _ - .';
  if (!/[\p{L}\p{N}]/u.test(n)) return 'Der Name braucht mindestens einen Buchstaben oder eine Zahl.';
  return null;
}
function checkPw(pw) {
  if (typeof pw !== 'string' || pw.length < 6) return 'Passwort: mindestens 6 Zeichen.';
  if (pw.length > 200) return 'Passwort: höchstens 200 Zeichen.';
  return null;
}

// ---- passwords (scrypt, built into Node) ----
function hashPw(pw, salt) {
  return new Promise((ok, fail) => crypto.scrypt(pw.normalize('NFC'), salt, 64, { N: 16384, r: 8, p: 1 },
    (err, key) => err ? fail(err) : ok(key.toString('hex'))));
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function same(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// ---- storage: one file per account, atomic writes, one operation per account at a time ----
const userFile = key => path.join(USERS, key + '.json');
function readUser(key) {
  try { return JSON.parse(fs.readFileSync(userFile(key), 'utf8')); } catch (e) { return null; }
}
function writeUser(key, u) {
  const f = userFile(key), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(u));
  fs.renameSync(tmp, f);
}
const locks = new Map();
function withUser(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

// ---- sessions: token = "<account key>.<secret>", only a hash of the secret is stored ----
function newSession(key, u) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  u.sessions = (u.sessions || []).filter(s => s.exp > now);
  u.sessions.push({ h: sha(secret), exp: now + SESSION_DAYS * 864e5 });
  while (u.sessions.length > MAX_SESSIONS) u.sessions.shift();
  return key + '.' + secret;
}
function auth(req) {
  const m = /^Bearer ([0-9a-f]{32})\.([A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const u = readUser(m[1]); if (!u) return null;
  const h = sha(m[2]), now = Date.now();
  const s = (u.sessions || []).find(x => x.exp > now && same(x.h, h));
  return s ? { key: m[1], user: u, h } : null;
}

// ---- brute-force protection: max 10 failed logins per 15 minutes per IP ----
const fails = new Map();
function ipOf(req) {
  return (TRUST_PROXY && (req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()))
    || req.socket.remoteAddress || '?';
}
function blocked(ip) { const f = fails.get(ip); return f && f.until > Date.now() && f.n >= 10; }
function failed(ip) {
  const now = Date.now(), f = fails.get(ip);
  if (!f || f.until < now) fails.set(ip, { n: 1, until: now + 15 * 60e3 }); else f.n++;
}
const regs = new Map(); // max 5 new accounts per hour per IP
setInterval(() => { const now = Date.now(); for (const m of [fails, regs]) for (const [k, f] of m) if (f.until < now) m.delete(k); }, 60e3).unref();

// ---- http helpers ----
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { fail(Object.assign(new Error('Zu gross'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { fail(Object.assign(new Error('Ungültige Daten'), { code: 400 })); } });
    req.on('error', fail);
  });
}
const pub = (u) => ({ name: u.name, meta: u.meta || null });

// ---- API ----
const routes = {
  'GET /api/health': async () => [200, { ok: true, app: 'neonvortex' }],

  'POST /api/register': async (req) => {
    const ip = ipOf(req), rg = regs.get(ip), now = Date.now();
    if (rg && rg.until > now && rg.n >= 5) return [429, { error: 'Zu viele neue Konten. Versuch es später nochmal.' }];
    const b = await readBody(req), name = normName(b.name), err = checkName(name) || checkPw(b.password);
    if (err) return [400, { error: err }];
    const key = nameKey(name), salt = crypto.randomBytes(16).toString('hex');
    const u = { name, created: new Date().toISOString(), pw: { salt, hash: await hashPw(b.password, salt) }, sessions: [], meta: null };
    const token = newSession(key, u);
    try { fs.writeFileSync(userFile(key), JSON.stringify(u), { flag: 'wx' }); } // wx = fails if the name is taken
    catch (e) { if (e.code === 'EEXIST') return [409, { error: 'Dieser Name ist schon vergeben.' }]; throw e; }
    if (!rg || rg.until < now) regs.set(ip, { n: 1, until: now + 3600e3 }); else rg.n++;
    console.log('Neues Konto:', name);
    return [201, Object.assign({ token }, pub(u))];
  },

  'POST /api/login': async (req) => {
    const ip = ipOf(req);
    if (blocked(ip)) return [429, { error: 'Zu viele Fehlversuche. Warte 15 Minuten.' }];
    const b = await readBody(req), key = nameKey(b.name);
    return withUser(key, async () => {
      const u = readUser(key);
      const ok = u && typeof b.password === 'string' && same(await hashPw(b.password, u.pw.salt), u.pw.hash);
      if (!ok) { failed(ip); return [401, { error: 'Name oder Passwort falsch.' }]; }
      const token = newSession(key, u); writeUser(key, u);
      return [200, Object.assign({ token }, pub(u))];
    });
  },

  'POST /api/logout': async (req) => {
    const a = auth(req); if (!a) return [200, { ok: true }];
    return withUser(a.key, async () => {
      const u = readUser(a.key); if (!u) return [200, { ok: true }];
      u.sessions = (u.sessions || []).filter(s => !same(s.h, a.h)); writeUser(a.key, u);
      return [200, { ok: true }];
    });
  },

  'GET /api/me': async (req) => {
    const a = auth(req); if (!a) return [401, { error: 'Bitte neu anmelden.' }];
    return [200, pub(a.user)];
  },

  'PUT /api/save': async (req) => {
    const a = auth(req); if (!a) return [401, { error: 'Bitte neu anmelden.' }];
    const b = await readBody(req), meta = b.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [400, { error: 'Ungültiger Spielstand.' }];
    if (JSON.stringify(meta).length > MAX_SAVE) return [413, { error: 'Spielstand zu gross.' }];
    return withUser(a.key, async () => {
      const u = readUser(a.key); if (!u) return [401, { error: 'Konto nicht gefunden.' }];
      u.meta = meta; u.updated = new Date().toISOString(); writeUser(a.key, u);
      return [200, { ok: true }];
    });
  },

  'POST /api/password': async (req) => {
    const a = auth(req); if (!a) return [401, { error: 'Bitte neu anmelden.' }];
    const b = await readBody(req), err = checkPw(b.newPassword);
    if (err) return [400, { error: err }];
    return withUser(a.key, async () => {
      const u = readUser(a.key);
      if (!u || typeof b.password !== 'string' || !same(await hashPw(b.password, u.pw.salt), u.pw.hash))
        return [401, { error: 'Altes Passwort ist falsch.' }];
      const salt = crypto.randomBytes(16).toString('hex');
      u.pw = { salt, hash: await hashPw(b.newPassword, salt) };
      u.sessions = (u.sessions || []).filter(s => same(s.h, a.h)); // log out all other devices
      writeUser(a.key, u);
      return [200, { ok: true }];
    });
  }
};

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    const r = routes[req.method + ' ' + url];
    if (r) { const [code, obj] = await r(req); return send(res, code, obj); }
    if (url.startsWith('/api/')) return send(res, 404, { error: 'Unbekannte Anfrage.' });
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return fs.readFile(GAME, (err, buf) => {
        if (err) { res.writeHead(500); return res.end('index.html nicht gefunden'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.end(buf);
      });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nicht gefunden');
  } catch (e) {
    if (e.code === 400 || e.code === 413) return send(res, e.code, { error: e.message });
    console.error(e); send(res, 500, { error: 'Serverfehler.' });
  }
}).listen(PORT, HOST, () => console.log('Neon Vortex läuft auf http://' + HOST + ':' + PORT + ' · Daten: ' + DATA));

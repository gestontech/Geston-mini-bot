import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime', 'Geston-Md');
const DATA_DIR = path.join(ROOT, '.mini-data');
const DB_FILE = path.join(ROOT, 'mini-data.json');
const REPO_TARBALL = 'https://codeload.github.com/gestontech/Geston-Md/tar.gz/refs/heads/main';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const MAX_BOTS = Math.max(1, Number(process.env.MAX_BOTS || 3));
const TTL_MS = Math.max(5, Number(process.env.PAIRING_TTL_MINUTES || 15)) * 60_000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public-2')));

const state = new Map();
let db = { referrals: {}, users: {} };

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(path.dirname(DB_FILE), { recursive: true });
  try { db = JSON.parse(await fsp.readFile(DB_FILE, 'utf8')); } catch { await saveDb(); }
}
async function saveDb() { await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2)); }
function id() { return crypto.randomBytes(12).toString('hex'); }
function refCode() { return crypto.randomBytes(5).toString('base64url').toUpperCase(); }
function cleanPhone(v) { return String(v || '').replace(/\D/g, ''); }
function activeCount() { return [...state.values()].filter(x => x.status === 'starting' || x.status === 'waiting' || x.status === 'connected').length; }

async function ensureRuntime() {
  const marker = path.join(RUNTIME, 'package.json');
  if (fs.existsSync(marker)) return;
  await fsp.mkdir(RUNTIME, { recursive: true });
  const tmp = path.join(ROOT, '.runtime', 'geston.tar.gz');
  const res = await fetch(REPO_TARBALL);
  if (!res.ok) throw new Error(`GitHub download failed: ${res.status}`);
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await tar.x({ file: tmp, cwd: RUNTIME, strip: 1 });
  await fsp.rm(tmp, { force: true });

  const patches = [
    ['index.js', [
      ["const sessionName = path.join(__dirname, 'Session');", "const sessionName = process.env.SESSION_DIR ? path.resolve(process.env.SESSION_DIR) : path.join(__dirname, 'Session');"],
      ["const DEV_NUMBER = '243993030390';", "const DEV_NUMBER = process.env.PAIRING_NUMBER || '243993030390';"],
      ["app.use(express.static('public'));\napp.get(\"/\", (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });\napp.get(\"/health\", (req, res) => res.json({ status: \"ok\", uptime: process.uptime() }));\napp.listen(port, () => console.log(`Server running on port ${port}`));", "if (!process.env.MINI_CHILD) {\n  app.use(express.static('public'));\n  app.get(\"/\", (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });\n  app.get(\"/health\", (req, res) => res.json({ status: \"ok\", uptime: process.uptime() }));\n  app.listen(port, () => console.log(`Server running on port ${port}`));\n}"],
    ]],
    ['auth/auth.js', [
      ["const sessionDir = path.join(__dirname, '..', 'Session');", "const sessionDir = process.env.SESSION_DIR ? path.resolve(process.env.SESSION_DIR) : path.join(__dirname, '..', 'Session');"]
    ]],
    ['database/config.js', [
      ["const _jsonPath = path.resolve('./whatsasena.json');", "const _jsonPath = path.resolve(process.env.DB_PATH || './whatsasena.json');"]
    ]]
  ];
  for (const [file, reps] of patches) {
    const p = path.join(RUNTIME, file);
    let s = await fsp.readFile(p, 'utf8');
    for (const [a, b] of reps) {
      if (!s.includes(a)) throw new Error(`Patch target missing in ${file}`);
      s = s.replace(a, b);
    }
    await fsp.writeFile(p, s);
  }
  const childPkg = JSON.parse(await fsp.readFile(path.join(RUNTIME, 'package.json'), 'utf8'));
  await fsp.writeFile(path.join(RUNTIME, 'package.json'), JSON.stringify(childPkg, null, 2));
}

async function ensureChildDeps() {
  const nm = path.join(RUNTIME, 'node_modules');
  if (fs.existsSync(nm)) return;
  await new Promise((resolve, reject) => {
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], { cwd: RUNTIME, stdio: 'inherit', env: process.env });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm install failed (${code})`)));
    p.on('error', reject);
  });
}

function referralFor(code) {
  return db.referrals[code] || { owner: null, count: 0, users: [] };
}

async function startBot(requestId, phone, referral) {
  if (activeCount() >= MAX_BOTS) throw new Error(`Maximum de ${MAX_BOTS} bots simultanés atteint.`);
  const userId = id();
  const sessionDir = path.join(DATA_DIR, 'sessions', userId);
  const dbPath = path.join(DATA_DIR, 'databases', `${userId}.json`);
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  const info = { requestId, userId, phone, referral: referral || null, status: 'starting', code: null, logs: [], child: null, createdAt: Date.now(), lastError: null };
  state.set(requestId, info);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: RUNTIME,
    env: { ...process.env, MINI_CHILD: '1', SESSION_DIR: sessionDir, DB_PATH: dbPath, PAIRING_NUMBER: phone },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  info.child = child;
  const onLine = chunk => {
    const text = String(chunk);
    info.logs.push(text.slice(-2000));
    if (info.logs.length > 50) info.logs.shift();
    const m = text.match(/PAIRING CODE:\s*([A-Z0-9-]+)/i);
    if (m) { info.code = m[1].trim(); info.status = 'waiting'; }
    if (/connection opened|connection.*open|connected to whatsapp/i.test(text)) info.status = 'connected';
    if (/logged out|401|session is no longer valid/i.test(text)) info.status = 'logged_out';
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  child.on('error', e => { info.lastError = e.message; info.status = 'error'; });
  child.on('exit', code => { if (info.status !== 'connected' && info.status !== 'logged_out') info.status = code === 0 ? 'stopped' : 'error'; info.child = null; });

  setTimeout(() => {
    if (state.get(requestId) === info && info.status === 'starting' && !info.code) {
      info.status = 'timeout';
      try { child.kill('SIGTERM'); } catch {}
    }
  }, TTL_MS);

  return info;
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'Geston MD Mini', bots: activeCount(), maxBots: MAX_BOTS }));
app.get('/api/status/:id', (req, res) => {
  const x = state.get(req.params.id);
  if (!x) return res.status(404).json({ error: 'Request not found' });
  res.json({ id: x.requestId, status: x.status, code: x.code, error: x.lastError });
});

app.post('/api/pair', async (req, res) => {
  try {
    await ensureRuntime();
    await ensureChildDeps();
    const phone = cleanPhone(req.body.phone);
    if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'Numéro WhatsApp invalide. Utilise le format international sans +.' });
    const referral = String(req.body.ref || '').trim().slice(0, 64) || null;
    if (referral && !db.referrals[referral]) return res.status(400).json({ error: 'Code de parrainage inconnu.' });
    const requestId = id();
    const info = await startBot(requestId, phone, referral);
    if (referral) {
      const r = referralFor(referral);
      r.users.push(info.userId); r.count = r.users.length; db.referrals[referral] = r;
      await saveDb();
    }
    res.json({ id: requestId, status: info.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/referral', async (req, res) => {
  const code = refCode();
  db.referrals[code] = { owner: id(), count: 0, users: [] };
  await saveDb();
  const url = `${PUBLIC_URL || `http://localhost:${PORT}`}/?ref=${code}`;
  res.json({ code, url, count: 0 });
});

app.get('/api/referral/:code', (req, res) => {
  const r = db.referrals[req.params.code];
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ code: req.params.code, count: r.count });
});

app.use((req, res) => {
  res.sendFile(path.join(ROOT, 'public-2', 'index.html'));
});

await ensureDirs();

app.listen(PORT, () => {
  console.log(`Geston MD Mini listening on ${PORT}`);
});

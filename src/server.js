const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { JsonStore } = require('./store');
const { ProxyPool } = require('./proxies');
const { SessionManager } = require('./sessions');
const { Runner } = require('./runner');
const { STEPS, executeStep } = require('./steps');

const env = process.env;
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const API_TOKEN = env.API_TOKEN || '';
const BASE_PATH = ('/' + (env.BASE_PATH || '/browser').replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '');
const PORT = Number(env.PORT || 3100);
const HOST = env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
const COOKIE_SECURE = env.COOKIE_SECURE === '1';
const VIEWPORT = { width: Number(env.VIEWPORT_WIDTH || 1280), height: Number(env.VIEWPORT_HEIGHT || 800) };

if (ADMIN_PASSWORD.length < 8) {
  console.error('Задай ADMIN_PASSWORD (минимум 8 символов) в .env');
  process.exit(1);
}

const proxyStore = new JsonStore(path.join(DATA_DIR, 'proxies.json'), []);
const scenarioStore = new JsonStore(path.join(DATA_DIR, 'scenarios.json'), []);
const proxies = new ProxyPool(proxyStore);
const sessions = new SessionManager(proxies, {
  max: Number(env.MAX_SESSIONS || 3),
  viewport: VIEWPORT,
  headless: env.HEADLESS !== '0',
  executablePath: env.CHROMIUM_PATH || '',
  manualIdleMin: Number(env.MANUAL_IDLE_MIN || 15),
});
const runner = new Runner(sessions, path.join(DATA_DIR, 'runs'));

// ---------- авторизация ----------
// Cookie = срок.подпись; ключ подписи выводится из пароля,
// поэтому смена пароля разлогинивает все устройства.
const AUTH_KEY = crypto.createHash('sha256').update(`panel:${ADMIN_PASSWORD}`).digest();
const COOKIE = 'bp_auth';
const TTL = 30 * 24 * 3600 * 1000;

const sign = (s) => crypto.createHmac('sha256', AUTH_KEY).update(s).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function isAuthed(req) {
  const h = req.headers.authorization || '';
  if (API_TOKEN && h.startsWith('Bearer ') && safeEq(h.slice(7), API_TOKEN)) return true;
  const [exp, sig] = readCookie(req, COOKIE).split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
}

function setAuthCookie(res, value, maxAgeMs) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    `Path=${BASE_PATH || '/'}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const failures = new Map(); // ip -> { n, until }
function loginBlocked(ip) {
  const f = failures.get(ip);
  return f && f.n >= 10 && f.until > Date.now();
}
function loginFailed(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { n: 1, until: Date.now() + 15 * 60 * 1000 });
  else f.n += 1;
}

// ---------- сценарии ----------
const KNOWN_STEPS = new Set(STEPS.map((s) => s.type));

function cleanScenario(body, prev = {}) {
  const name = String(body.name ?? prev.name ?? '').trim().slice(0, 100) || 'Без названия';
  const steps = Array.isArray(body.steps) ? body.steps : prev.steps || [];
  if (steps.length > 500) throw new Error('Слишком много шагов (максимум 500)');
  const cleanSteps = steps.map((s, i) => {
    if (!s || !KNOWN_STEPS.has(s.type)) throw new Error(`Шаг ${i + 1}: неизвестный тип`);
    const params = s.params && typeof s.params === 'object' ? s.params : {};
    return { type: s.type, params, disabled: !!s.disabled, note: String(s.note || '').slice(0, 200) };
  });
  return {
    id: prev.id || crypto.randomUUID().slice(0, 8),
    name,
    steps: cleanSteps,
    repeat: Math.max(1, Math.min(1000, Number(body.repeat ?? prev.repeat ?? 1) || 1)),
    intervalMin: Math.max(0, Number(body.intervalMin ?? prev.intervalMin ?? 0) || 0),
    scheduleEnabled: !!(body.scheduleEnabled ?? prev.scheduleEnabled),
    updatedAt: Date.now(),
  };
}

const findScenario = (id) => scenarioStore.data.find((s) => s.id === id);

// Простое расписание: «запускать каждые N минут», если прошлый запуск закончился.
const lastScheduled = new Map();
setInterval(() => {
  for (const sc of scenarioStore.data) {
    if (!sc.scheduleEnabled || !sc.intervalMin) continue;
    const last = lastScheduled.get(sc.id) || 0;
    if (Date.now() - last < sc.intervalMin * 60000 || runner.isRunning(sc.id)) continue;
    lastScheduled.set(sc.id, Date.now());
    try {
      runner.start(sc);
    } catch (e) {
      console.error(`Расписание «${sc.name}»: ${e.message}`);
    }
  }
}, 30000).unref();

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
const r = express.Router();

r.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
r.use(express.json({ limit: '2mb' }));

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message.split('\n')[0] });
  }
};
const notFound = (what) => Object.assign(new Error(`${what} не найден(а)`), { status: 404 });

r.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (loginBlocked(ip)) return res.status(429).json({ error: 'Слишком много попыток, подожди 15 минут' });
  if (!safeEq(String(req.body?.password || ''), ADMIN_PASSWORD)) {
    loginFailed(ip);
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  failures.delete(ip);
  const exp = String(Date.now() + TTL);
  setAuthCookie(res, `${exp}.${sign(exp)}`, TTL);
  res.json({ ok: true });
});

r.post('/api/logout', (req, res) => {
  setAuthCookie(res, '', 0);
  res.json({ ok: true });
});

r.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Нужен вход' });
});

r.get('/api/config', wrap(() => ({ steps: STEPS, viewport: VIEWPORT, maxSessions: sessions.opts.max })));

// сценарии
r.get('/api/scenarios', wrap(() => scenarioStore.data));
r.post('/api/scenarios', wrap((req) => {
  const sc = cleanScenario(req.body || {});
  scenarioStore.data.push(sc);
  scenarioStore.save();
  return sc;
}));
r.get('/api/scenarios/:id', wrap((req) => findScenario(req.params.id) || Promise.reject(notFound('Сценарий'))));
r.put('/api/scenarios/:id', wrap((req) => {
  const prev = findScenario(req.params.id);
  if (!prev) throw notFound('Сценарий');
  const sc = cleanScenario(req.body || {}, prev);
  Object.assign(prev, sc);
  scenarioStore.save();
  return prev;
}));
r.delete('/api/scenarios/:id', wrap((req) => {
  scenarioStore.data = scenarioStore.data.filter((s) => s.id !== req.params.id);
  scenarioStore.save();
}));
r.post('/api/scenarios/:id/run', wrap((req) => {
  const sc = findScenario(req.params.id);
  if (!sc) throw notFound('Сценарий');
  return runner.info(runner.start(sc));
}));

// запуски
r.get('/api/runs', wrap(() => runner.list()));
r.get('/api/runs/:id', wrap((req) => {
  const run = runner.get(req.params.id);
  if (!run) throw notFound('Запуск');
  return runner.info(run);
}));
r.post('/api/runs/:id/stop', wrap((req) => runner.stop(req.params.id)));
r.get('/api/runs/:id/shots/:file', (req, res) => {
  const run = runner.get(req.params.id);
  const shot = run && run.screenshots.find((s) => s.file === req.params.file);
  if (!shot) return res.status(404).end();
  res.sendFile(path.join(runner.runsDir, run.id, shot.file));
});

// сессии (ручное управление и просмотр)
r.get('/api/sessions', wrap(() => sessions.list()));
r.post('/api/sessions', wrap(async (req) => {
  const s = await sessions.create({ proxy: req.body?.proxy || 'none', label: 'Тестовая', manual: true });
  return s.info();
}));
r.delete('/api/sessions/:id', wrap((req) => sessions.close(req.params.id)));
r.get('/api/sessions/:id/screenshot', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.page) return res.status(404).end();
  s.touch();
  try {
    const buf = await s.page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/jpeg').send(buf);
  } catch {
    res.status(503).end();
  }
});
// Выполнить один шаг в ручной сессии — для кнопки «Проверить шаг».
r.post('/api/sessions/:id/step', wrap(async (req) => {
  const id = req.params.id;
  if (!sessions.get(id)) throw notFound('Сессия');
  sessions.get(id).touch();
  const step = req.body?.step;
  if (!step || !KNOWN_STEPS.has(step.type)) throw new Error('Неизвестный шаг');
  let shot = null;
  await executeStep(step, {
    session: () => sessions.get(id),
    startSession: (o) => sessions.restart(id, o),
    restartSession: (o) => sessions.restart(id, o),
    closeSession: () => sessions.close(id),
    saveScreenshot: async (buf) => { shot = buf.toString('base64'); },
    shouldStop: () => false,
  });
  return { ok: true, session: sessions.get(id)?.info() || null, screenshot: shot };
}));

// прокси
r.get('/api/proxies', wrap(() => proxies.list()));
r.post('/api/proxies', wrap((req) => proxies.addMany(req.body?.text, req.body || {})));
r.put('/api/proxies/:id', wrap((req) => proxies.update(req.params.id, req.body || {})));
r.delete('/api/proxies/:id', wrap((req) => proxies.remove(req.params.id)));
r.post('/api/proxies/:id/check', wrap(async (req) => ({ ip: await proxies.check(req.params.id) })));
r.post('/api/proxies/:id/rotate', wrap(async (req) => {
  const p = proxies.get(req.params.id);
  if (!p) throw notFound('Прокси');
  if (!p.rotateUrl) throw new Error('У прокси нет ссылки ротации');
  await proxies.rotate(p, 0);
}));

r.use('/api', (req, res) => res.status(404).json({ error: 'Нет такого метода' }));
r.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// /browser -> /browser/, иначе относительные ссылки панели поедут
if (BASE_PATH) {
  app.use((req, res, next) => {
    const [p, q] = req.originalUrl.split('?');
    if (p === BASE_PATH) return res.redirect(301, `${BASE_PATH}/${q ? `?${q}` : ''}`);
    next();
  });
}
app.use(BASE_PATH || '/', r);

const server = app.listen(PORT, HOST, () => {
  console.log(`Панель: http://${HOST}:${PORT}${BASE_PATH}/`);
});

async function shutdown() {
  server.close();
  await sessions.closeAll();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

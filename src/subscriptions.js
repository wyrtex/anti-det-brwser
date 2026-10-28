const crypto = require('crypto');
const { Xray } = require('./xray');

// ---------- разбор ссылок подписки в outbound для xray ----------

const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
const COUNTRY_NAMES = {
  DE: ['germany', 'германия', 'deutschland'], NL: ['netherlands', 'нидерланды', 'holland'],
  US: ['usa', 'united states', 'сша', 'америка'], GB: ['united kingdom', 'великобритания', 'england', 'uk'],
  FI: ['finland', 'финляндия'], SE: ['sweden', 'швеция'], FR: ['france', 'франция'], PL: ['poland', 'польша'],
  TR: ['turkey', 'турция', 'türkiye'], KZ: ['kazakhstan', 'казахстан'], AM: ['armenia', 'армения'],
  GE: ['georgia', 'грузия'], AE: ['uae', 'эмираты'], JP: ['japan', 'япония'], SG: ['singapore', 'сингапур'],
  CA: ['canada', 'канада'], CH: ['switzerland', 'швейцария'], AT: ['austria', 'австрия'], ES: ['spain', 'испания'],
  IT: ['italy', 'италия'], LV: ['latvia', 'латвия'], LT: ['lithuania', 'литва'], EE: ['estonia', 'эстония'],
  RU: ['russia', 'россия'], UA: ['ukraine', 'украина'], CZ: ['czech', 'чехия'], RO: ['romania', 'румыния'],
  BG: ['bulgaria', 'болгария'], HK: ['hong kong', 'гонконг'], IN: ['india', 'индия'], BR: ['brazil', 'бразилия'],
};

function detectCountry(name) {
  const m = String(name).match(FLAG_RE);
  if (m) return [...m[0]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join('');
  const low = String(name).toLowerCase();
  for (const [cc, words] of Object.entries(COUNTRY_NAMES)) {
    if (words.some((w) => new RegExp(`(^|[^a-zа-я])${w}([^a-zа-я]|$)`, 'i').test(low))) return cc;
  }
  return '';
}

const b64decode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const looksBase64 = (s) => /^[A-Za-z0-9+/=_\-\s]+$/.test(s) && !s.includes('://');
const bracketless = (h) => h.replace(/^\[|\]$/g, '');

const NETWORKS = { tcp: 'tcp', raw: 'tcp', ws: 'ws', grpc: 'grpc', h2: 'http', http: 'http', httpupgrade: 'httpupgrade', xhttp: 'xhttp', splithttp: 'xhttp' };

// p: функция get(name) -> строка | ''. Один и тот же набор параметров у vless/trojan и (после перекладки) у vmess.
function buildStream(p, address) {
  const type = (p('type') || p('net') || 'tcp').toLowerCase();
  const network = NETWORKS[type];
  if (!network) throw new Error(`транспорт «${type}» не поддерживается`);
  const security = (p('security') || 'none').toLowerCase();
  const host = p('host');
  const path = p('path');
  const s = { network };

  if (security === 'tls') {
    s.security = 'tls';
    s.tlsSettings = {
      serverName: p('sni') || host || address,
      ...(p('fp') && { fingerprint: p('fp') }),
      ...(p('alpn') && { alpn: p('alpn').split(',') }),
      ...(['1', 'true'].includes(p('allowInsecure') || p('insecure')) && { allowInsecure: true }),
    };
  } else if (security === 'reality') {
    if (!p('pbk')) throw new Error('Reality без publicKey (pbk)');
    s.security = 'reality';
    s.realitySettings = {
      serverName: p('sni'),
      fingerprint: p('fp') || 'chrome',
      publicKey: p('pbk'),
      shortId: p('sid') || '',
      spiderX: p('spx') || '',
    };
  } else if (security !== 'none' && security !== '') {
    throw new Error(`security «${security}» не поддерживается`);
  }

  if (network === 'ws') s.wsSettings = { path: path || '/', ...(host && { headers: { Host: host } }) };
  else if (network === 'grpc') s.grpcSettings = { serviceName: p('serviceName') || path || '', multiMode: p('mode') === 'multi' };
  else if (network === 'httpupgrade') s.httpupgradeSettings = { path: path || '/', ...(host && { host }) };
  else if (network === 'xhttp') s.xhttpSettings = { path: path || '/', ...(host && { host }), ...(p('mode') && { mode: p('mode') }) };
  else if (network === 'http') s.httpSettings = { path: path || '/', ...(host && { host: host.split(',') }) };
  else if (network === 'tcp' && (p('headerType') || p('type_header')) === 'http') {
    s.tcpSettings = { header: { type: 'http', request: { path: (path || '/').split(','), headers: { Host: (host || address).split(',') } } } };
  }
  return s;
}

function parseUrlLike(link) {
  const u = new URL(link);
  const q = u.searchParams;
  return { u, p: (k) => q.get(k) || '', name: decodeURIComponent(u.hash.replace(/^#/, '')) };
}

function parseVless(link) {
  const { u, p, name } = parseUrlLike(link);
  const address = bracketless(u.hostname);
  if (!u.username || !u.port) throw new Error('нет id или порта');
  return {
    name, address, port: Number(u.port),
    outbound: {
      protocol: 'vless',
      settings: { vnext: [{ address, port: Number(u.port), users: [{ id: decodeURIComponent(u.username), encryption: p('encryption') || 'none', ...(p('flow') && { flow: p('flow') }) }] }] },
      streamSettings: buildStream(p, address),
    },
  };
}

function parseTrojan(link) {
  const { u, p, name } = parseUrlLike(link);
  const address = bracketless(u.hostname);
  if (!u.username || !u.port) throw new Error('нет пароля или порта');
  const sp = (k) => (k === 'security' ? p('security') || 'tls' : p(k)); // у trojan tls по умолчанию
  return {
    name, address, port: Number(u.port),
    outbound: {
      protocol: 'trojan',
      settings: { servers: [{ address, port: Number(u.port), password: decodeURIComponent(u.username) }] },
      streamSettings: buildStream(sp, address),
    },
  };
}

function parseVmess(link) {
  let j;
  try {
    j = JSON.parse(b64decode(link.slice('vmess://'.length).trim()));
  } catch {
    throw new Error('не удалось прочитать vmess-ссылку');
  }
  const address = j.add;
  if (!address || !j.port || !j.id) throw new Error('в vmess нет адреса, порта или id');
  const params = { type: j.net, host: j.host, path: j.path, security: j.tls === 'tls' ? 'tls' : 'none', sni: j.sni, fp: j.fp, alpn: j.alpn, serviceName: j.path, headerType: j.type };
  return {
    name: j.ps || '', address, port: Number(j.port),
    outbound: {
      protocol: 'vmess',
      settings: { vnext: [{ address, port: Number(j.port), users: [{ id: j.id, alterId: Number(j.aid) || 0, security: j.scy || 'auto' }] }] },
      streamSettings: buildStream((k) => (params[k] == null ? '' : String(params[k])), address),
    },
  };
}

function parseShadowsocks(link) {
  let rest = link.slice('ss://'.length);
  let name = '';
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    name = decodeURIComponent(rest.slice(hash + 1));
    rest = rest.slice(0, hash);
  }
  const qi = rest.indexOf('?');
  if (qi !== -1) {
    if (/plugin=/.test(rest.slice(qi))) throw new Error('плагины shadowsocks не поддерживаются');
    rest = rest.slice(0, qi);
  }
  rest = rest.replace(/\/$/, '');
  let userinfo;
  let hostport;
  const at = rest.lastIndexOf('@');
  if (at === -1) {
    [userinfo, hostport] = b64decode(rest).split(/@(?=[^@]*$)/);
  } else {
    userinfo = rest.slice(0, at);
    hostport = rest.slice(at + 1);
    if (!userinfo.includes(':')) userinfo = b64decode(decodeURIComponent(userinfo));
    else userinfo = decodeURIComponent(userinfo);
  }
  const m = String(hostport || '').match(/^(.+):(\d+)$/);
  const i = String(userinfo || '').indexOf(':');
  if (!m || i === -1) throw new Error('не удалось прочитать ss-ссылку');
  const address = bracketless(m[1]);
  return {
    name, address, port: Number(m[2]),
    outbound: { protocol: 'shadowsocks', settings: { servers: [{ address, port: Number(m[2]), method: userinfo.slice(0, i), password: userinfo.slice(i + 1) }] } },
  };
}

const PARSERS = { 'vless:': parseVless, 'vmess:': parseVmess, 'trojan:': parseTrojan, 'ss:': parseShadowsocks };
const PLACEHOLDER_HOSTS = new Set(['0.0.0.0', '127.0.0.1', 'localhost', '1.1.1.1.1']);

// Подписка в формате JSON (массив конфигов xray с полем remarks), который тоже умеет отдавать Happ.
function parseJsonSubscription(data, warnings) {
  const list = Array.isArray(data) ? data : [data];
  const nodes = [];
  for (const cfg of list) {
    const ob = (cfg.outbounds || []).find((o) => ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(o.protocol));
    if (!ob) {
      warnings.push('в JSON-конфиге не нашёлся поддерживаемый outbound');
      continue;
    }
    const { tag, ...outbound } = ob;
    const s = (outbound.settings.vnext || outbound.settings.servers || [])[0] || {};
    nodes.push({ key: JSON.stringify(outbound), name: cfg.remarks || tag || s.address || '', protocol: ob.protocol, address: s.address, port: s.port, outbound });
  }
  return nodes;
}

function parseSubscription(text) {
  const warnings = [];
  let body = String(text || '').trim();
  if (/^happ:\/\/crypt/i.test(body)) {
    return { nodes: [], warnings: ['Подписка зашифрована Happ (happ://crypt…): расшифровать её может только само приложение. Попроси у провайдера обычную ссылку подписки (для v2rayN / v2rayNG).'] };
  }
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const nodes = parseJsonSubscription(JSON.parse(body), warnings).map((n) => ({ ...n, country: detectCountry(n.name) }));
      return { nodes, warnings };
    } catch {
      /* не JSON — идём дальше */
    }
  }
  if (looksBase64(body)) {
    try {
      body = b64decode(body.replace(/\s+/g, ''));
    } catch {
      /* оставляем как есть */
    }
  }
  const nodes = [];
  const seen = new Set();
  const skipped = {};
  for (const raw of body.split(/\r?\n/)) {
    const link = raw.trim();
    if (!link || link.startsWith('#')) continue;
    const scheme = (link.match(/^([a-z0-9]+):\/\//i) || [])[1]?.toLowerCase();
    const parse = scheme && PARSERS[`${scheme}:`];
    if (!parse) {
      if (scheme) skipped[scheme] = (skipped[scheme] || 0) + 1;
      continue;
    }
    try {
      const n = parse(link);
      if (PLACEHOLDER_HOSTS.has(n.address)) continue; // «служебные» строки вида «осталось 5 дней»
      if (seen.has(link)) continue;
      seen.add(link);
      nodes.push({ key: link, protocol: scheme === 'ss' ? 'shadowsocks' : scheme, ...n, name: n.name || `${n.address}:${n.port}`, country: detectCountry(n.name) });
    } catch (e) {
      warnings.push(`${scheme}: ${e.message}`);
    }
  }
  for (const [k, c] of Object.entries(skipped)) warnings.push(`${c} шт. ${k}:// пропущено — этот протокол панель не поддерживает`);
  return { nodes, warnings };
}

async function fetchSubscription(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Ссылка подписки должна начинаться с http:// или https://');
  let last = new Error('Не удалось получить подписку');
  // Некоторые провайдеры отдают формат в зависимости от User-Agent.
  for (const ua of ['Happ/2.7.0', 'v2rayN/7.0.0', 'curl/8.5.0']) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    } catch (e) {
      last = new Error(`Не удалось скачать подписку: ${e.cause?.code || e.message}`);
      continue;
    }
    if (!res.ok) {
      last = new Error(`Сервер подписки ответил HTTP ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5e6) throw new Error('Ответ подписки слишком большой');
    const parsed = parseSubscription(buf.toString('utf8'));
    if (parsed.nodes.length) {
      return { ...parsed, userinfo: res.headers.get('subscription-userinfo') || '', title: res.headers.get('profile-title') || '' };
    }
    last = new Error(parsed.warnings[0] || 'В подписке не нашлось поддерживаемых серверов (нужны vless / vmess / trojan / ss)');
  }
  throw last;
}

function parseUserinfo(s) {
  const o = {};
  for (const part of String(s || '').split(';')) {
    const [k, v] = part.split('=').map((x) => x && x.trim());
    if (k && v !== undefined && !Number.isNaN(Number(v))) o[k] = Number(v);
  }
  if (o.total === undefined && o.upload === undefined && o.download === undefined) return null;
  return { used: (o.upload || 0) + (o.download || 0), total: o.total || 0, expire: o.expire || 0 };
}

function decodeTitle(t) {
  if (!t) return '';
  return /^base64:/i.test(t) ? b64decode(t.slice(7)).trim() : t.trim();
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Подписки + локальный xray. Каждая локация получает свой SOCKS-порт на 127.0.0.1,
// и ProxyPool выдаёт её сессиям как обычный прокси.
class SubscriptionManager {
  constructor(store, xray, { refreshHours = 6 } = {}) {
    this.store = store;
    this.xray = xray;
    this.refreshHours = refreshHours;
    this.ports = new Map(); // id локации -> порт
    this.dropped = new Map(); // id локации -> причина, почему xray её не принял
    this.status = { running: false, error: '' };
  }

  async start() {
    await this.sync();
    const tick = () => this.refreshAll().catch(() => {});
    tick();
    if (this.refreshHours > 0) setInterval(tick, this.refreshHours * 3600 * 1000).unref();
  }

  async refreshAll() {
    for (const s of this.store.data) await this.refresh(s.id).catch(() => {});
  }

  nodeId(sub, n) {
    return `n-${sha(`${sub.id}|${n.key}`).slice(0, 8)}`;
  }

  // Активные локации (xray их принял и слушает порт).
  nodes() {
    const out = [];
    for (const sub of this.store.data) {
      for (const n of sub.nodes) {
        const id = this.nodeId(sub, n);
        const port = this.ports.get(id);
        if (port) out.push({ id, name: n.name, country: n.country, protocol: n.protocol, subId: sub.id, subName: sub.name, port });
      }
    }
    return out;
  }

  list() {
    return this.store.data.map((sub) => ({
      id: sub.id,
      name: sub.name,
      url: sub.url.replace(/^(https?:\/\/[^/]+\/).*(.{4})$/, '$1…$2'),
      updatedAt: sub.updatedAt,
      error: sub.error || '',
      warnings: sub.warnings || [],
      traffic: sub.traffic || null,
      nodes: sub.nodes.map((n) => {
        const id = this.nodeId(sub, n);
        return { id, name: n.name, country: n.country, protocol: n.protocol, active: this.ports.has(id), error: this.dropped.get(id) || '' };
      }),
    }));
  }

  async add({ url, name }) {
    url = String(url || '').trim();
    if (this.store.data.some((s) => s.url === url)) throw new Error('Такая подписка уже добавлена');
    const sub = { id: crypto.randomUUID().slice(0, 8), name: String(name || '').trim(), url, nodes: [], updatedAt: 0, error: '' };
    // сначала скачиваем: если ссылка нерабочая — подписку не сохраняем
    const got = await fetchSubscription(url);
    this._apply(sub, got);
    if (!sub.name) sub.name = new URL(url).hostname;
    this.store.data.push(sub);
    this.store.save();
    await this.sync();
    return sub;
  }

  _apply(sub, got) {
    sub.nodes = got.nodes.map(({ key, name, country, protocol, outbound }) => ({ key, name, country, protocol, outbound }));
    sub.warnings = got.warnings;
    sub.traffic = parseUserinfo(got.userinfo);
    sub.updatedAt = Date.now();
    sub.error = '';
    if (!sub.name) sub.name = decodeTitle(got.title);
  }

  async refresh(id) {
    const sub = this.store.data.find((s) => s.id === id);
    if (!sub) throw new Error('Подписка не найдена');
    try {
      this._apply(sub, await fetchSubscription(sub.url));
    } catch (e) {
      sub.error = e.message; // старые локации остаются рабочими
      this.store.save();
      throw e;
    }
    this.store.save();
    await this.sync();
  }

  async remove(id) {
    this.store.data = this.store.data.filter((s) => s.id !== id);
    this.store.save();
    await this.sync();
  }

  async rename(id, name) {
    const sub = this.store.data.find((s) => s.id === id);
    if (!sub) throw new Error('Подписка не найдена');
    sub.name = String(name || '').trim() || sub.name;
    this.store.save();
  }

  async sync() {
    const items = [];
    for (const sub of this.store.data) {
      for (const n of sub.nodes) items.push({ id: this.nodeId(sub, n), outbound: n.outbound });
    }
    const res = await this.xray.apply(items);
    this.ports = res.ports;
    this.dropped = res.dropped;
    this.status = { running: res.running, error: res.error || '' };
  }
}

module.exports = { SubscriptionManager, parseSubscription, fetchSubscription, detectCountry, Xray };

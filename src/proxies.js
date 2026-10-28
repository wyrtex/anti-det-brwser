const crypto = require('crypto');
const { request } = require('playwright');

// Разбор строки прокси. Поддерживаемые форматы:
//   http://user:pass@host:port   socks5://host:port
//   user:pass@host:port          host:port
//   host:port:user:pass
function parseProxy(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Пустая строка прокси');
  let scheme = 'http';
  const m = s.match(/^([a-z0-9]+):\/\//i);
  if (m) {
    scheme = m[1].toLowerCase();
    s = s.slice(m[0].length);
  }
  if (!['http', 'https', 'socks5', 'socks4'].includes(scheme)) {
    throw new Error(`Неподдерживаемая схема прокси: ${scheme}`);
  }
  let username = '';
  let password = '';
  let hostPort = s;
  const at = s.lastIndexOf('@');
  if (at !== -1) {
    const cred = s.slice(0, at);
    hostPort = s.slice(at + 1);
    const i = cred.indexOf(':');
    username = i === -1 ? cred : cred.slice(0, i);
    password = i === -1 ? '' : cred.slice(i + 1);
  } else {
    const parts = s.split(':');
    if (parts.length >= 4) {
      hostPort = `${parts[0]}:${parts[1]}`;
      username = parts[2];
      password = parts.slice(3).join(':');
    }
  }
  if (!/^[^:\s]+:\d{1,5}$/.test(hostPort)) {
    throw new Error(`Не получилось разобрать host:port в "${raw}"`);
  }
  if (scheme.startsWith('socks') && username) {
    // Chromium не умеет авторизацию на SOCKS-прокси.
    throw new Error('Chromium не поддерживает SOCKS-прокси с логином/паролем — используй http');
  }
  const out = { server: `${scheme}://${hostPort}` };
  if (username) {
    out.username = decodeURIComponent(username);
    out.password = decodeURIComponent(password);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Пул прокси. Каждый прокси может одновременно обслуживать не больше
// maxSessions сессий (по умолчанию 1). Режимы выбора:
//   'none'  — без прокси, IP сервера
//   'pool'  — следующий свободный прокси по кругу
//   '<id>'  — конкретный прокси
class ProxyPool {
  constructor(store) {
    this.store = store;
    if (!Array.isArray(store.data)) store.data = [];
    this.inUse = new Map(); // id -> количество активных сессий
    this.cursor = 0;
  }

  list() {
    return this.store.data.map((p) => ({ ...p, inUse: this.inUse.get(p.id) || 0 }));
  }

  get(id) {
    return this.store.data.find((p) => p.id === id);
  }

  addMany(text, { rotateUrl = '', maxSessions = 1 } = {}) {
    const added = [];
    const errors = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      try {
        parseProxy(l);
        const p = {
          id: crypto.randomUUID().slice(0, 8),
          url: l,
          label: '',
          rotateUrl: rotateUrl || '',
          maxSessions: Math.max(1, Number(maxSessions) || 1),
        };
        this.store.data.push(p);
        added.push(p);
      } catch (e) {
        errors.push(`${l}: ${e.message}`);
      }
    }
    this.store.save();
    return { added, errors };
  }

  update(id, patch) {
    const p = this.get(id);
    if (!p) throw new Error('Прокси не найден');
    if (patch.url !== undefined) {
      parseProxy(patch.url);
      p.url = String(patch.url).trim();
    }
    if (patch.label !== undefined) p.label = String(patch.label);
    if (patch.rotateUrl !== undefined) p.rotateUrl = String(patch.rotateUrl).trim();
    if (patch.maxSessions !== undefined) p.maxSessions = Math.max(1, Number(patch.maxSessions) || 1);
    this.store.save();
    return p;
  }

  remove(id) {
    this.store.data = this.store.data.filter((p) => p.id !== id);
    this.store.save();
  }

  free(p) {
    return (this.inUse.get(p.id) || 0) < (p.maxSessions || 1);
  }

  // Возвращает { proxy, playwright, release() } либо null для режима 'none'.
  acquire(mode) {
    if (!mode || mode === 'none') return null;
    const all = this.store.data;
    let chosen;
    if (mode === 'pool') {
      if (!all.length) throw new Error('Пул прокси пуст — добавь прокси или выбери «Без прокси»');
      for (let i = 0; i < all.length; i++) {
        const p = all[(this.cursor + i) % all.length];
        if (this.free(p)) {
          chosen = p;
          this.cursor = (this.cursor + i + 1) % all.length;
          break;
        }
      }
      if (!chosen) throw new Error('Все прокси заняты другими сессиями');
    } else {
      chosen = this.get(mode);
      if (!chosen) throw new Error(`Прокси ${mode} не найден`);
      if (!this.free(chosen)) throw new Error(`Прокси ${chosen.label || chosen.id} уже занят`);
    }
    this.inUse.set(chosen.id, (this.inUse.get(chosen.id) || 0) + 1);
    let released = false;
    return {
      proxy: chosen,
      playwright: parseProxy(chosen.url),
      release: () => {
        if (released) return;
        released = true;
        const n = (this.inUse.get(chosen.id) || 1) - 1;
        if (n <= 0) this.inUse.delete(chosen.id);
        else this.inUse.set(chosen.id, n);
      },
    };
  }

  // Смена IP у мобильных/ротируемых прокси: дёргаем ссылку провайдера.
  async rotate(proxy, waitMs = 5000) {
    if (!proxy.rotateUrl) return false;
    const res = await fetch(proxy.rotateUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Ссылка ротации вернула HTTP ${res.status}`);
    await sleep(waitMs);
    return true;
  }

  // Узнаёт внешний IP через прокси без запуска браузера.
  async check(id) {
    const p = this.get(id);
    if (!p) throw new Error('Прокси не найден');
    const ctx = await request.newContext({ proxy: parseProxy(p.url), timeout: 20000 });
    try {
      const res = await ctx.get('https://api.ipify.org?format=json');
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      const { ip } = await res.json();
      return ip;
    } finally {
      await ctx.dispose();
    }
  }
}

module.exports = { ProxyPool, parseProxy };

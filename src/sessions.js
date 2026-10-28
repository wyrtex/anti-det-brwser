const crypto = require('crypto');
const { chromium } = require('playwright');

// Одна сессия = отдельный процесс Chromium с чистым временным профилем.
// Playwright создаёт профиль во временной папке и удаляет его при закрытии,
// поэтому cookies, кэш, localStorage и история между сессиями не переносятся.
class Session {
  constructor(manager, { proxy = 'none', label = '', manual = false }) {
    this.manager = manager;
    this.manual = manual;
    this.lastActive = Date.now();
    this.id = crypto.randomUUID().slice(0, 8);
    this.label = label;
    this.proxyMode = proxy;
    this.lease = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.mouse = { x: 0, y: 0 };
    this.createdAt = Date.now();
    this.generation = 0; // сколько раз сессию перезапускали
  }

  // pinProxyId — взять конкретный прокси один раз, не меняя proxyMode
  // (нужно, чтобы после смены IP остаться на том же прокси из пула).
  async launch(pinProxyId) {
    const { viewport, headless, executablePath } = this.manager.opts;
    this.lease = this.manager.proxies.acquire(pinProxyId || this.proxyMode);
    try {
      this.browser = await chromium.launch({
        headless,
        executablePath: executablePath || undefined,
        proxy: this.lease ? this.lease.playwright : undefined,
      });
      this.context = await this.browser.newContext({ viewport });
      this.page = await this.context.newPage();
      // Если сайт открыл новую вкладку — переключаемся на неё.
      this.context.on('page', (p) => {
        this.page = p;
        p.on('close', () => {
          if (this.page === p) this.page = this.context.pages().at(-1) || null;
        });
      });
      this.mouse = { x: 0, y: 0 };
    } catch (e) {
      await this.shutdown();
      throw e;
    }
  }

  async shutdown() {
    const browser = this.browser;
    this.browser = this.context = this.page = null;
    if (browser) await browser.close().catch(() => {});
    if (this.lease) {
      this.lease.release();
      this.lease = null;
    }
  }

  touch() {
    this.lastActive = Date.now();
  }

  info() {
    return {
      manual: this.manual,
      id: this.id,
      label: this.label,
      proxyMode: this.proxyMode,
      proxy: this.lease ? { id: this.lease.proxy.id, label: this.lease.proxy.label } : null,
      url: this.page ? this.page.url() : null,
      createdAt: this.createdAt,
      generation: this.generation,
    };
  }
}

class SessionManager {
  constructor(proxies, opts) {
    this.proxies = proxies;
    this.opts = opts; // { max, viewport, headless, executablePath }
    this.sessions = new Map();
    // Тестовые сессии из панели закрываем, если ими не пользуются (вкладку закрыли и т.п.).
    const idleMs = (opts.manualIdleMin || 15) * 60000;
    setInterval(() => {
      for (const s of this.sessions.values()) {
        if (s.manual && Date.now() - s.lastActive > idleMs) this.close(s.id);
      }
    }, 60000).unref();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  get(id) {
    return this.sessions.get(id);
  }

  async create({ proxy = 'none', label = '', manual = false } = {}) {
    if (this.sessions.size >= this.opts.max) {
      throw new Error(`Достигнут лимит одновременных сессий (${this.opts.max})`);
    }
    const s = new Session(this, { proxy, label, manual });
    this.sessions.set(s.id, s); // резервируем слот до запуска
    try {
      await s.launch();
    } catch (e) {
      this.sessions.delete(s.id);
      throw e;
    }
    return s;
  }

  // Полный перезапуск с тем же id: старый браузер и профиль уничтожаются,
  // поднимается новый чистый. proxy: 'same' — оставить текущий режим.
  // rotateIp: дёрнуть ссылку смены IP у текущего прокси и остаться на нём.
  async restart(id, { proxy = 'same', rotateIp = false } = {}) {
    const s = this.get(id);
    if (!s) throw new Error('Сессия не найдена');
    const prev = s.lease ? s.lease.proxy : null;
    await s.shutdown();
    if (proxy && proxy !== 'same') s.proxyMode = proxy;
    let pin;
    if (rotateIp && prev && prev.rotateUrl && (!proxy || proxy === 'same')) {
      await this.proxies.rotate(prev);
      pin = prev.id;
    }
    await s.launch(pin);
    s.generation += 1;
    return s;
  }

  async close(id) {
    const s = this.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.shutdown();
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}

module.exports = { SessionManager };

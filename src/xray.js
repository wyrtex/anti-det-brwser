const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLines = (s, n = 4) => String(s || '').trim().split('\n').slice(-n).join(' | ').slice(0, 400);

// Один процесс xray на все локации: у каждой свой SOCKS5-вход на 127.0.0.1:<порт>,
// маршрутизация строго «вход -> свой выход». Наружу порты не открываются.
class Xray {
  constructor({ bin = 'xray', dir, basePort = 21000 }) {
    this.bin = bin;
    this.dir = dir;
    this.basePort = basePort;
    this.proc = null;
    this.hash = '';
    this.stopping = false;
    this.queue = Promise.resolve();
    fs.mkdirSync(dir, { recursive: true });
  }

  build(items) {
    return {
      log: { loglevel: 'warning' },
      inbounds: items.map((it, i) => ({
        tag: `in-${i}`,
        listen: '127.0.0.1',
        port: this.basePort + i,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: false },
      })),
      outbounds: items.map((it, i) => ({ tag: `out-${i}`, ...it.outbound })),
      routing: {
        domainStrategy: 'AsIs',
        rules: items.map((it, i) => ({ type: 'field', inboundTag: [`in-${i}`], outboundTag: `out-${i}` })),
      },
    };
  }

  // null — конфиг принят; строка — причина отказа; бросает ошибку, если xray не установлен.
  test(cfg) {
    const file = path.join(this.dir, 'test.json');
    fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
    return new Promise((resolve, reject) => {
      execFile(this.bin, ['run', '-test', '-config', file], { timeout: 20000 }, (err, stdout, stderr) => {
        if (!err) return resolve(null);
        if (err.code === 'ENOENT') return reject(new Error(`xray не найден (${this.bin}). Установи xray-core или укажи путь в XRAY_PATH`));
        resolve(lastLines(`${stderr}\n${stdout}`) || err.message);
      });
    });
  }

  apply(items) {
    // изменения конфигурации строго по очереди
    const run = this.queue.then(() => this._apply(items));
    this.queue = run.catch(() => {});
    return run;
  }

  async _apply(items) {
    const empty = { ports: new Map(), dropped: new Map(), running: false, error: '' };
    if (!items.length) {
      await this.stop();
      return empty;
    }
    const dropped = new Map();
    let good = items;
    try {
      let err = await this.test(this.build(good));
      if (err) {
        // один плохой сервер не должен ронять все остальные — проверяем по одному
        good = [];
        for (const it of items) {
          const e = await this.test(this.build([it]));
          if (e) dropped.set(it.id, e);
          else good.push(it);
        }
        if (!good.length) {
          await this.stop();
          return { ...empty, dropped, error: `xray не принял ни одного сервера: ${[...dropped.values()][0]}` };
        }
      }
    } catch (e) {
      await this.stop();
      return { ...empty, error: e.message };
    }

    const cfg = this.build(good);
    const text = JSON.stringify(cfg);
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const ports = new Map(good.map((it, i) => [it.id, this.basePort + i]));
    if (hash === this.hash && this.proc) return { ports, dropped, running: true, error: '' };

    await this.stop();
    const file = path.join(this.dir, 'config.json');
    fs.writeFileSync(file, text, { mode: 0o600 });
    try {
      await this._spawn(file, good[0] && this.basePort);
    } catch (e) {
      return { ...empty, dropped, error: e.message };
    }
    this.hash = hash;
    return { ports, dropped, running: true, error: '' };
  }

  async _spawn(file, probePort) {
    this.stopping = false;
    const proc = spawn(this.bin, ['run', '-config', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let exited = null;
    const onData = (d) => {
      log = (log + d).slice(-2000);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => {
      exited = e.code === 'ENOENT' ? `xray не найден (${this.bin})` : e.message;
    });
    proc.on('exit', (code) => {
      exited = `xray завершился с кодом ${code}: ${lastLines(log)}`;
      if (this.proc === proc) {
        this.proc = null;
        this.hash = '';
        if (!this.stopping) console.error(exited);
      }
    });
    this.proc = proc;
    // ждём, пока первый порт начнёт принимать соединения
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(exited);
      if (await new Promise((res) => {
        const s = net.connect(probePort, '127.0.0.1');
        s.once('connect', () => { s.destroy(); res(true); });
        s.once('error', () => res(false));
      })) return;
      await sleep(150);
    }
    await this.stop();
    throw new Error(`xray не начал слушать порт за 10 секунд: ${lastLines(log)}`);
  }

  // Возвращает промис, который выполнится, когда процесс реально завершился (порты освобождены).
  stop() {
    this.stopping = true;
    const p = this.proc;
    this.proc = null;
    this.hash = '';
    if (!p || p.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => p.kill('SIGKILL'), 3000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      p.kill('SIGTERM');
    });
  }
}

module.exports = { Xray };

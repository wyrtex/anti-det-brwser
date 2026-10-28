const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { executeStep, describe } = require('./steps');

const KEEP_RUNS = 50;

// Запуск сценария: шаги выполняются по очереди, у запуска своя сессия,
// которая закрывается в конце при любом исходе.
class Runner {
  constructor(sessions, runsDir) {
    this.sessions = sessions;
    this.runsDir = runsDir;
    this.runs = new Map();
    // Скриншоты прошлых запусков после рестарта не нужны — история в памяти.
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.mkdirSync(runsDir, { recursive: true });
  }

  list() {
    return [...this.runs.values()].reverse().map((r) => this.info(r, false));
  }

  get(id) {
    return this.runs.get(id);
  }

  info(r, withLogs = true) {
    const out = {
      id: r.id,
      scenarioId: r.scenarioId,
      scenarioName: r.scenarioName,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      sessionId: r.sessionId,
      currentStep: r.currentStep,
      iteration: r.iteration,
      error: r.error,
      hasLast: !!r.hasLast,
      screenshots: r.screenshots,
    };
    if (withLogs) out.logs = r.logs;
    return out;
  }

  isRunning(scenarioId) {
    return [...this.runs.values()].some((r) => r.scenarioId === scenarioId && r.status === 'running');
  }

  start(scenario) {
    const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
    if (!steps.length) throw new Error('В сценарии нет шагов');
    const run = {
      id: crypto.randomUUID().slice(0, 8),
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      sessionId: null,
      currentStep: -1,
      iteration: 0,
      error: null,
      logs: [],
      screenshots: [],
      stopRequested: false,
    };
    this.runs.set(run.id, run);
    this._trim();
    this._exec(run, steps, Math.max(1, Math.min(1000, Number(scenario.repeat) || 1)));
    return run;
  }

  stop(id) {
    const r = this.runs.get(id);
    if (r && r.status === 'running') r.stopRequested = true;
  }

  _trim() {
    const ids = [...this.runs.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_RUNS))) {
      if (this.runs.get(id).status === 'running') continue;
      this.runs.delete(id);
      fs.rmSync(path.join(this.runsDir, id), { recursive: true, force: true });
    }
  }

  async _exec(run, steps, repeat) {
    const log = (msg) => run.logs.push({ t: Date.now(), msg });
    const sm = this.sessions;
    const ctx = {
      session: () => (run.sessionId ? sm.get(run.sessionId) : null),
      startSession: async (opts) => {
        if (run.sessionId) await sm.close(run.sessionId);
        run.sessionId = null;
        const s = await sm.create({ ...opts, label: `Запуск ${run.id}` });
        run.sessionId = s.id;
        if (s.lease) log(`  прокси: ${s.lease.proxy.label || s.lease.proxy.id}`);
      },
      restartSession: async (opts) => {
        if (!run.sessionId) return ctx.startSession({ proxy: opts.proxy === 'same' ? 'none' : opts.proxy });
        const s = await sm.restart(run.sessionId, opts);
        if (s.lease) log(`  прокси: ${s.lease.proxy.label || s.lease.proxy.id}`);
      },
      closeSession: async () => {
        if (run.sessionId) await sm.close(run.sessionId);
        run.sessionId = null;
      },
      saveScreenshot: async (buf, name) => {
        const dir = path.join(this.runsDir, run.id);
        fs.mkdirSync(dir, { recursive: true });
        const file = `${run.screenshots.length + 1}.png`;
        fs.writeFileSync(path.join(dir, file), buf);
        run.screenshots.push({ file, name, t: Date.now() });
      },
      shouldStop: () => run.stopRequested,
    };

    log(`Старт: «${run.scenarioName}», шагов: ${steps.length}, повторов: ${repeat}`);
    try {
      for (let it = 0; it < repeat; it++) {
        run.iteration = it + 1;
        if (repeat > 1) log(`— Повтор ${it + 1}/${repeat}`);
        for (let i = 0; i < steps.length; i++) {
          if (run.stopRequested) throw new Error('Остановлено');
          const step = steps[i];
          if (step.disabled) continue;
          run.currentStep = i;
          log(`${i + 1}. ${describe(step)}`);
          await executeStep(step, ctx);
        }
      }
      run.status = 'done';
      log('Готово');
    } catch (e) {
      run.status = run.stopRequested ? 'stopped' : 'failed';
      run.error = e.message.split('\n')[0];
      log(`Ошибка: ${e.message}`);
      // Скриншот момента ошибки — помогает понять, что пошло не так.
      const s = ctx.session();
      if (s && s.page && !run.stopRequested) {
        try {
          await ctx.saveScreenshot(await s.page.screenshot({ type: 'png', timeout: 5000 }), 'ошибка');
        } catch {}
      }
    } finally {
      // Кадр «чем закончилось» — до закрытия сессии.
      const s = ctx.session();
      if (s && s.page) {
        try {
          const dir = path.join(this.runsDir, run.id);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'last.jpg'), await s.page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 }));
          run.hasLast = true;
        } catch {}
      }
      await ctx.closeSession().catch(() => {});
      run.finishedAt = Date.now();
      run.currentStep = -1;
    }
  }
}

module.exports = { Runner };

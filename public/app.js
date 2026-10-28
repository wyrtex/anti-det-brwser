'use strict';
// Все запросы относительные, поэтому панель работает под любым префиксом (/browser/ и т.п.).

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  config: null,
  scenarios: [],
  current: null, // редактируемая копия сценария
  dirty: false,
  proxies: [],
  testSessionId: null,
  activeRun: null, // последний запуск из конструктора
  pick: null, // индекс шага, для которого выбираем координаты
  selectedRunId: null,
  tab: 'builder',
};

// ---------- утилиты ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2500);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && url !== 'api/login') {
    showLogin();
    throw new Error('Нужен вход');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Обёртка для обработчиков: ошибки показываем тостом.
const act = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message, true);
  }
};

const fmtTime = (t) => (t ? new Date(t).toLocaleString('ru-RU') : '');
const STATUS = { running: 'выполняется', done: 'готово', failed: 'ошибка', stopped: 'остановлен' };
const stepDef = (type) => S.config.steps.find((s) => s.type === type);

// ---------- вход ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-pass').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await api('POST', 'api/login', { password: $('#login-pass').value });
    $('#login-pass').value = '';
    await boot();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

$('#logout').addEventListener('click', act(async () => {
  await api('POST', 'api/logout');
  showLogin();
}));

// ---------- вкладки ----------
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('active', x === b);
  for (const sec of document.querySelectorAll('.tab')) sec.classList.toggle('hidden', sec.id !== `tab-${S.tab}`);
  if (S.tab === 'runs') loadRuns().catch(() => {});
  if (S.tab === 'proxies') loadProxies().catch(() => {});
});

// ---------- прокси: варианты выбора ----------
function proxyOptions(value, allowSame) {
  const opts = [];
  if (allowSame) opts.push(['same', 'Как было']);
  opts.push(['none', 'Без прокси (IP сервера)'], ['pool', 'Из пула по кругу']);
  for (const p of S.proxies) opts.push([p.id, `Прокси: ${p.label || p.url.replace(/\/\/[^@]*@/, '//')}`]);
  return opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l));
}

async function loadProxies() {
  S.proxies = await api('GET', 'api/proxies');
  const sel = $('#test-proxy');
  const cur = sel.value || 'none';
  sel.replaceChildren(...proxyOptions(cur, false));
  if (S.tab === 'proxies') renderProxies();
}

// ---------- сценарии ----------
async function loadScenarios() {
  S.scenarios = await api('GET', 'api/scenarios');
  renderScenarioList();
}

function renderScenarioList() {
  $('#sc-list').replaceChildren(
    ...S.scenarios.map((sc) =>
      h(
        'li',
        {
          class: S.current && S.current.id === sc.id ? 'active' : '',
          title: sc.name,
          onclick: () => openScenario(sc.id),
        },
        sc.scheduleEnabled && sc.intervalMin ? h('span', { class: 'dot', title: 'по расписанию' }) : null,
        sc.name,
      ),
    ),
  );
}

function openScenario(id) {
  if (S.dirty && !confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
  const sc = S.scenarios.find((s) => s.id === id);
  if (!sc) return;
  S.current = structuredClone(sc);
  S.pick = null;
  setDirty(false);
  renderEditor();
  renderScenarioList();
}

function setDirty(v) {
  S.dirty = v;
  $('#sc-dirty').classList.toggle('hidden', !v);
}

function newStep(type) {
  const def = stepDef(type);
  const params = {};
  for (const f of def.fields) params[f.name] = f.default;
  return { type, params, disabled: false };
}

$('#sc-new').addEventListener('click', act(async () => {
  if (S.dirty && !confirm('Есть несохранённые изменения. Создать новый без сохранения?')) return;
  const sc = await api('POST', 'api/scenarios', {
    name: 'Новый сценарий',
    steps: [newStep('start_session'), newStep('goto')],
  });
  S.scenarios.push(sc);
  setDirty(false);
  openScenario(sc.id);
}));

function renderEditor() {
  const sc = S.current;
  $('#sc-empty').classList.toggle('hidden', !!sc);
  $('#sc-editor').classList.toggle('hidden', !sc);
  if (!sc) return;
  $('#sc-name').value = sc.name;
  $('#sc-repeat').value = sc.repeat || 1;
  $('#sc-interval').value = sc.intervalMin || 0;
  $('#sc-schedule').checked = !!sc.scheduleEnabled;
  renderSteps();
  renderRunState();
}

for (const [id, key, conv] of [
  ['#sc-name', 'name', String],
  ['#sc-repeat', 'repeat', Number],
  ['#sc-interval', 'intervalMin', Number],
]) {
  $(id).addEventListener('input', (e) => {
    S.current[key] = conv(e.target.value);
    setDirty(true);
  });
}
$('#sc-schedule').addEventListener('change', (e) => {
  S.current.scheduleEnabled = e.target.checked;
  setDirty(true);
});

function fieldInput(step, f, i) {
  const p = step.params;
  const set = (v) => {
    p[f.name] = v;
    setDirty(true);
  };
  const v = p[f.name] ?? f.default;
  switch (f.kind) {
    case 'number':
      return h('input', {
        type: 'number',
        value: v === '' || v === undefined ? '' : String(v),
        oninput: (e) => set(e.target.value === '' ? '' : Number(e.target.value)),
      });
    case 'textarea':
      return h('textarea', { rows: 2, value: v ?? '', oninput: (e) => set(e.target.value) });
    case 'checkbox':
      return h('input', { type: 'checkbox', checked: !!v, onchange: (e) => set(e.target.checked) });
    case 'select':
      return h('select', { onchange: (e) => set(e.target.value) },
        f.options.map(([ov, ol]) => h('option', { value: ov, selected: ov === v }, ol)));
    case 'proxy':
      return h('select', { onchange: (e) => set(e.target.value) }, proxyOptions(v, f.allowSame));
    default: {
      // iOS иногда не шлёт input при вставке/автозамене — слушаем и change
      const upd = (e) => set(e.target.value);
      return h('input', { value: v ?? '', placeholder: f.placeholder, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', oninput: upd, onchange: upd });
    }
  }
}

function renderSteps() {
  const sc = S.current;
  const running = S.activeRun && S.activeRun.status === 'running' && S.activeRun.scenarioId === sc.id
    ? S.activeRun.currentStep : -1;
  const typeOptions = (sel) => S.config.steps.map((d) => h('option', { value: d.type, selected: d.type === sel }, d.label));

  $('#steps').replaceChildren(
    ...sc.steps.map((step, i) => {
      const def = stepDef(step.type);
      const hasXY = def.fields.some((f) => f.name === 'x') && def.fields.some((f) => f.name === 'y');
      const move = (d) => () => {
        const j = i + d;
        if (j < 0 || j >= sc.steps.length) return;
        [sc.steps[i], sc.steps[j]] = [sc.steps[j], sc.steps[i]];
        setDirty(true);
        renderSteps();
      };
      return h(
        'li',
        { class: `step${step.disabled ? ' off' : ''}${i === running ? ' running' : ''}` },
        h(
          'div',
          { class: 'step-head' },
          h('select', {
            onchange: (e) => {
              const fresh = newStep(e.target.value);
              // общие поля (x, y, text …) переносим
              for (const k of Object.keys(fresh.params)) if (k in step.params) fresh.params[k] = step.params[k];
              sc.steps[i] = { ...fresh, disabled: step.disabled };
              setDirty(true);
              renderSteps();
            },
          }, typeOptions(step.type)),
          h('button', { class: 'ghost', title: 'Выполнить шаг в тестовой сессии', onclick: act(() => testStep(step)) }, '▶'),
          h('button', { class: 'ghost', title: 'Вверх', onclick: move(-1) }, '↑'),
          h('button', { class: 'ghost', title: 'Вниз', onclick: move(1) }, '↓'),
          h('button', {
            class: 'ghost',
            title: 'Дублировать',
            onclick: () => {
              sc.steps.splice(i + 1, 0, structuredClone(step));
              setDirty(true);
              renderSteps();
            },
          }, '⧉'),
          h('button', {
            class: 'ghost',
            title: step.disabled ? 'Включить' : 'Выключить (пропускать)',
            onclick: () => {
              step.disabled = !step.disabled;
              setDirty(true);
              renderSteps();
            },
          }, step.disabled ? '○' : '●'),
          h('button', {
            class: 'ghost',
            title: 'Удалить',
            onclick: () => {
              sc.steps.splice(i, 1);
              if (S.pick === i) cancelPick();
              setDirty(true);
              renderSteps();
            },
          }, '✕'),
        ),
        def.fields.length
          ? h(
            'div',
            { class: 'step-fields' },
            def.fields.map((f) =>
              h('label', { class: (f.kind === 'checkbox' ? 'check ' : '') + (['text', 'textarea'].includes(f.kind) ? 'wide' : '') },
                f.kind === 'checkbox' ? [fieldInput(step, f, i), f.label] : [f.label, fieldInput(step, f, i)]),
            ),
            hasXY
              ? h('button', {
                class: 'small pick' + (S.pick === i ? ' primary' : ''),
                title: 'Выбрать координаты кликом по экрану',
                onclick: () => startPick(i),
              }, '🎯 с экрана')
              : null,
          )
          : null,
      );
    }),
  );
}

$('#add-btn').addEventListener('click', () => {
  S.current.steps.push(newStep($('#add-type').value));
  setDirty(true);
  renderSteps();
});

async function saveScenario() {
  const sc = S.current;
  const saved = await api('PUT', `api/scenarios/${sc.id}`, sc);
  const idx = S.scenarios.findIndex((s) => s.id === sc.id);
  S.scenarios[idx] = saved;
  S.current = structuredClone(saved);
  setDirty(false);
  renderScenarioList();
}

$('#sc-save').addEventListener('click', act(async () => {
  await saveScenario();
  toast('Сохранено');
}));

$('#sc-delete').addEventListener('click', act(async () => {
  if (!confirm(`Удалить сценарий «${S.current.name}»?`)) return;
  await api('DELETE', `api/scenarios/${S.current.id}`);
  S.scenarios = S.scenarios.filter((s) => s.id !== S.current.id);
  S.current = null;
  setDirty(false);
  renderEditor();
  renderScenarioList();
}));

$('#sc-run').addEventListener('click', act(async () => {
  await saveScenario(); // всегда, чтобы в запуск ушло то, что сейчас на экране
  S.activeRun = await api('POST', `api/scenarios/${S.current.id}/run`);
  renderRunState();
  pollRun();
}));

$('#sc-stop').addEventListener('click', act(async () => {
  if (S.activeRun) await api('POST', `api/runs/${S.activeRun.id}/stop`);
}));

let polling = false;
async function pollRun() {
  if (polling) return;
  polling = true;
  try {
    while (S.activeRun && S.activeRun.status === 'running') {
      await sleep(1000);
      try {
        S.activeRun = await api('GET', `api/runs/${S.activeRun.id}`);
      } catch {
        break;
      }
      renderRunState();
      if (S.current && S.activeRun.scenarioId === S.current.id) renderStepHighlight();
    }
    if (S.activeRun && S.activeRun.status !== 'running') {
      const st = S.activeRun.status;
      toast(`Запуск: ${STATUS[st]}${S.activeRun.error ? ' — ' + S.activeRun.error : ''}`, st === 'failed');
      if (S.current) renderStepHighlight();
    }
  } finally {
    polling = false;
  }
}

// Подсветка текущего шага без полной перерисовки (чтобы не сбивать ввод).
function renderStepHighlight() {
  const cur = S.activeRun && S.activeRun.status === 'running' ? S.activeRun.currentStep : -1;
  [...$('#steps').children].forEach((li, i) => li.classList.toggle('running', i === cur));
}

function renderRunState() {
  const run = S.activeRun;
  const mine = run && S.current && run.scenarioId === S.current.id;
  const isRunning = mine && run.status === 'running';
  $('#sc-run').classList.toggle('hidden', !!isRunning);
  $('#sc-stop').classList.toggle('hidden', !isRunning);
  $('#run-box').classList.toggle('hidden', !run);
  if (!run) return;
  $('#run-title').textContent = `Запуск ${run.id} · ${run.scenarioName}`;
  const badge = $('#run-status');
  badge.textContent = STATUS[run.status] + (run.iteration > 1 ? ` · повтор ${run.iteration}` : '');
  badge.className = `badge ${run.status}`;
  const pre = $('#run-log');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 10;
  pre.textContent = (run.logs || []).map((l) => `${new Date(l.t).toLocaleTimeString('ru-RU')}  ${l.msg}`).join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ---------- экран / тестовая сессия ----------
function viewSessionId() {
  if (S.activeRun && S.activeRun.status === 'running' && S.activeRun.sessionId) return S.activeRun.sessionId;
  return S.testSessionId;
}

function updateLiveUi() {
  const run = S.activeRun && S.activeRun.status === 'running' ? S.activeRun : null;
  $('#live-source').textContent = run ? `запуск ${run.id}` : S.testSessionId ? 'тестовая сессия' : '';
  $('#test-start').textContent = S.testSessionId ? 'Новая тестовая сессия' : 'Тестовая сессия';
  $('#test-close').classList.toggle('hidden', !S.testSessionId);
  $('#interact').classList.toggle('hidden', !S.testSessionId || !!run);
}

let lastUrl = null;
async function screenLoop() {
  for (;;) {
    const id = viewSessionId();
    updateLiveUi();
    if (id && !document.hidden && !$('#app').classList.contains('hidden')) {
      try {
        const res = await fetch(`api/sessions/${id}/screenshot?t=${Date.now()}`, { credentials: 'same-origin' });
        if (res.ok) {
          const url = URL.createObjectURL(await res.blob());
          $('#screen').src = url;
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = url;
          $('#screen-empty').classList.add('hidden');
        } else if (res.status === 404) {
          if (id === S.testSessionId) S.testSessionId = null;
          $('#screen').removeAttribute('src');
          $('#screen-empty').classList.remove('hidden');
        }
      } catch {}
    } else if (!id) {
      $('#screen').removeAttribute('src');
      $('#screen-empty').classList.remove('hidden');
    }
    await sleep(800);
  }
}

$('#test-start').addEventListener('click', act(async () => {
  $('#test-start').disabled = true;
  try {
    if (S.testSessionId) await api('DELETE', `api/sessions/${S.testSessionId}`).catch(() => {});
    S.testSessionId = null;
    const s = await api('POST', 'api/sessions', { proxy: $('#test-proxy').value });
    S.testSessionId = s.id;
    toast(s.proxy ? `Сессия запущена через прокси ${s.proxy.label || s.proxy.id}` : 'Сессия запущена');
  } finally {
    $('#test-start').disabled = false;
  }
}));

$('#test-close').addEventListener('click', act(async () => {
  if (S.testSessionId) await api('DELETE', `api/sessions/${S.testSessionId}`);
  S.testSessionId = null;
}));

async function sendStep(step) {
  if (!S.testSessionId) throw new Error('Сначала запусти тестовую сессию (справа)');
  const out = await api('POST', `api/sessions/${S.testSessionId}/step`, { step });
  if (!out.session) S.testSessionId = null;
  return out;
}

async function testStep(step) {
  const out = await sendStep(step);
  if (out.screenshot) {
    const w = window.open();
    if (w) w.document.write(`<img src="data:image/png;base64,${out.screenshot}" style="max-width:100%">`);
  }
  toast('Шаг выполнен');
}

// Запись действий из блока под экраном в сценарий.
function record(...steps) {
  if (!$('#record').checked) return;
  if (!S.current) return toast('Открой сценарий, чтобы записывать действия', true);
  S.current.steps.push(...steps);
  setDirty(true);
  renderSteps();
}

const mk = (type, params) => ({ type, params: { ...newStep(type).params, ...params }, disabled: false });

function screenXY(e) {
  const img = $('#screen');
  const r = img.getBoundingClientRect();
  const { width: vw, height: vh } = S.config.viewport;
  // картинка вписана с object-fit: contain — учитываем поля
  const scale = Math.min(r.width / vw, r.height / vh);
  const ox = (r.width - vw * scale) / 2;
  const oy = (r.height - vh * scale) / 2;
  const x = Math.round((e.clientX - r.left - ox) / scale);
  const y = Math.round((e.clientY - r.top - oy) / scale);
  if (x < 0 || y < 0 || x > vw || y > vh) return null;
  return { x, y };
}

function startPick(i) {
  if (!viewSessionId()) toast('Запусти тестовую сессию, чтобы видеть экран');
  S.pick = i;
  $('#pick-banner').classList.remove('hidden');
  renderSteps();
  $('.live').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelPick() {
  S.pick = null;
  $('#pick-banner').classList.add('hidden');
  if (S.current) renderSteps();
}
$('#pick-cancel').addEventListener('click', cancelPick);

$('#screen').addEventListener('mousemove', (e) => {
  const p = screenXY(e);
  const el = $('#screen-xy');
  el.classList.toggle('hidden', !p);
  if (p) el.textContent = `${p.x}, ${p.y}`;
});
$('#screen').addEventListener('mouseleave', () => $('#screen-xy').classList.add('hidden'));

$('#screen').addEventListener('click', act(async (e) => {
  const p = screenXY(e);
  if (!p) return;
  if (S.pick !== null && S.current && S.current.steps[S.pick]) {
    Object.assign(S.current.steps[S.pick].params, p);
    setDirty(true);
    toast(`Координаты: ${p.x}, ${p.y}`);
    cancelPick();
    return;
  }
  if (!S.testSessionId || viewSessionId() !== S.testSessionId || !$('#click-through').checked) return;
  const moveStep = mk('mouse_move', { ...p, duration: 300 });
  const clickStep = mk('click', { x: '', y: '', button: 'left' });
  await sendStep(moveStep);
  await sendStep(clickStep);
  record(moveStep, clickStep);
}));

$('#i-go').addEventListener('click', act(async () => {
  let url = $('#i-url').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const step = mk('goto', { url });
  await sendStep(step);
  record(step);
}));
$('#i-url').addEventListener('keydown', (e) => e.key === 'Enter' && $('#i-go').click());

$('#i-type').addEventListener('click', act(async () => {
  const text = $('#i-text').value;
  if (!text) return;
  const step = mk('type_text', { text });
  await sendStep(step);
  record(step);
  $('#i-text').value = '';
}));
$('#i-text').addEventListener('keydown', (e) => e.key === 'Enter' && $('#i-type').click());

document.querySelector('.keys').addEventListener('click', act(async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const step = b.dataset.key ? mk('press', { key: b.dataset.key }) : mk('scroll', { dy: Number(b.dataset.scroll), dx: 0 });
  await sendStep(step);
  record(step);
}));

// ---------- запуски ----------
async function loadRuns() {
  const runs = await api('GET', 'api/runs');
  $('#runs-list').replaceChildren(
    ...(runs.length ? runs : []).map((r) =>
      h('li', { class: r.id === S.selectedRunId ? 'active' : '', onclick: () => showRun(r.id) },
        h('div', { class: 'row' }, h('b', {}, r.scenarioName), h('span', { class: `badge ${r.status}` }, STATUS[r.status])),
        h('div', { class: 'muted' }, `${fmtTime(r.startedAt)} · ${r.id}`),
        r.error ? h('div', { class: 'err' }, r.error) : null),
    ),
  );
  if (!runs.length) $('#runs-list').append(h('li', { class: 'muted' }, 'Запусков пока не было'));
  if (S.selectedRunId) await showRun(S.selectedRunId, true);
}

async function showRun(id, quiet) {
  S.selectedRunId = id;
  if (!quiet) for (const li of $('#runs-list').children) li.classList.remove('active');
  let r;
  try {
    r = await api('GET', `api/runs/${id}`);
  } catch {
    $('#run-detail').textContent = 'Запуск не найден';
    return;
  }
  $('#run-detail').classList.remove('muted');
  $('#run-detail').replaceChildren(
    h('div', { class: 'row' },
      h('b', {}, `${r.scenarioName} · ${r.id}`),
      h('span', { class: `badge ${r.status}` }, STATUS[r.status]),
      r.status === 'running' ? h('button', { class: 'small danger', onclick: act(() => api('POST', `api/runs/${r.id}/stop`)) }, 'Стоп') : null),
    h('div', { class: 'muted' }, `Начат ${fmtTime(r.startedAt)}${r.finishedAt ? ` · закончен ${fmtTime(r.finishedAt)}` : ''}`),
    h('pre', {}, r.logs.map((l) => `${new Date(l.t).toLocaleTimeString('ru-RU')}  ${l.msg}`).join('\n')),
    r.screenshots.length
      ? h('div', { class: 'shots' }, r.screenshots.map((s) => {
        const src = `api/runs/${r.id}/shots/${s.file}`;
        return h('a', { href: src, target: '_blank' }, h('img', { src, loading: 'lazy' }), s.name || s.file);
      }))
      : null,
  );
  if (!quiet) loadRuns().catch(() => {});
}

setInterval(() => {
  if (S.tab === 'runs' && !document.hidden && !$('#app').classList.contains('hidden')) loadRuns().catch(() => {});
}, 3000);

// ---------- прокси ----------
function renderProxies() {
  const save = (p, key) => act(async (e) => {
    const val = e.target.value;
    await api('PUT', `api/proxies/${p.id}`, { [key]: key === 'maxSessions' ? Number(val) : val });
    toast('Сохранено');
    await loadProxies();
  });
  $('#px-list').replaceChildren(
    ...S.proxies.map((p) =>
      h('tr', {},
        h('td', { class: 'url' }, p.url),
        h('td', {}, h('input', { value: p.label, placeholder: 'подпись', onchange: save(p, 'label') })),
        h('td', {}, h('input', { value: p.rotateUrl, placeholder: 'нет', onchange: save(p, 'rotateUrl') })),
        h('td', {}, h('input', { type: 'number', min: 1, value: String(p.maxSessions || 1), style: 'width:70px;min-width:0', onchange: save(p, 'maxSessions') })),
        h('td', {}, String(p.inUse)),
        h('td', {}, h('div', { class: 'row' },
          h('button', {
            class: 'small',
            onclick: act(async (e) => {
              e.target.disabled = true;
              try {
                const { ip } = await api('POST', `api/proxies/${p.id}/check`);
                toast(`Работает, внешний IP: ${ip}`);
              } finally {
                e.target.disabled = false;
              }
            }),
          }, 'Проверить'),
          p.rotateUrl ? h('button', {
            class: 'small',
            onclick: act(async () => {
              await api('POST', `api/proxies/${p.id}/rotate`);
              toast('Запрос на смену IP отправлен');
            }),
          }, 'Сменить IP') : null,
          h('button', {
            class: 'small ghost',
            onclick: act(async () => {
              if (!confirm('Удалить прокси?')) return;
              await api('DELETE', `api/proxies/${p.id}`);
              await loadProxies();
            }),
          }, '✕'),
        )),
      ),
    ),
  );
  if (!S.proxies.length) $('#px-list').append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'Прокси не добавлены — сессии будут ходить с IP сервера')));
}

$('#px-add').addEventListener('click', act(async () => {
  const out = await api('POST', 'api/proxies', {
    text: $('#px-text').value,
    rotateUrl: $('#px-rotate').value.trim(),
    maxSessions: Number($('#px-max').value) || 1,
  });
  $('#px-msg').textContent = `Добавлено: ${out.added.length}` + (out.errors.length ? `. Ошибки:\n${out.errors.join('\n')}` : '');
  if (out.added.length) $('#px-text').value = '';
  await loadProxies();
}));

// ---------- старт ----------
async function boot() {
  try {
    S.config = await api('GET', 'api/config');
  } catch {
    return; // showLogin уже вызван при 401
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#add-type').replaceChildren(...S.config.steps.map((d) => h('option', { value: d.type }, d.label)));
  await Promise.all([loadProxies(), loadScenarios()]);
  // Если в фоне уже идёт запуск — подхватываем его.
  const runs = await api('GET', 'api/runs');
  const running = runs.find((r) => r.status === 'running');
  if (running) {
    S.activeRun = await api('GET', `api/runs/${running.id}`);
    renderRunState();
    pollRun();
  }
  if (!S.current && S.scenarios.length) openScenario(S.scenarios[0].id);
}

window.addEventListener('beforeunload', (e) => {
  if (S.dirty) e.preventDefault();
});

boot();
screenLoop();

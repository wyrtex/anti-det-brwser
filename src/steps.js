// Описание шагов сценария. Отсюда же панель строит форму конструктора,
// так что новый шаг достаточно добавить в STEPS и в executeStep.
const XY = [
  { name: 'x', label: 'X', kind: 'number', default: 640 },
  { name: 'y', label: 'Y', kind: 'number', default: 400 },
];

const STEPS = [
  {
    type: 'start_session',
    label: 'Начать сессию',
    fields: [{ name: 'proxy', label: 'Прокси', kind: 'proxy', default: 'none' }],
  },
  {
    type: 'restart_session',
    label: 'Перезапустить сессию',
    fields: [
      { name: 'proxy', label: 'Прокси', kind: 'proxy', default: 'same', allowSame: true },
      { name: 'rotateIp', label: 'Сменить IP прокси (нужна ссылка ротации)', kind: 'checkbox', default: false },
    ],
  },
  { type: 'close_session', label: 'Закрыть сессию', fields: [] },
  {
    type: 'goto',
    label: 'Перейти по ссылке',
    fields: [{ name: 'url', label: 'URL', kind: 'text', default: '', placeholder: 'https://example.com' }],
  },
  {
    type: 'mouse_move',
    label: 'Курсор в координаты',
    fields: [...XY, { name: 'duration', label: 'Время движения, мс', kind: 'number', default: 400 }],
  },
  {
    type: 'click',
    label: 'Клик мышью',
    fields: [
      { name: 'x', label: 'X (пусто — где курсор)', kind: 'number', default: '' },
      { name: 'y', label: 'Y (пусто — где курсор)', kind: 'number', default: '' },
      {
        name: 'button',
        label: 'Кнопка',
        kind: 'select',
        default: 'left',
        options: [['left', 'ЛКМ'], ['right', 'ПКМ'], ['middle', 'Колесо']],
      },
      { name: 'double', label: 'Двойной клик', kind: 'checkbox', default: false },
    ],
  },
  {
    type: 'type_text',
    label: 'Ввести текст (посимвольно)',
    fields: [
      { name: 'text', label: 'Текст', kind: 'textarea', default: '' },
      { name: 'delay', label: 'Пауза между символами, мс', kind: 'number', default: 80 },
    ],
  },
  {
    type: 'paste_text',
    label: 'Вставить текст (целиком)',
    fields: [{ name: 'text', label: 'Текст', kind: 'textarea', default: '' }],
  },
  {
    type: 'press',
    label: 'Нажать клавишу',
    fields: [{ name: 'key', label: 'Клавиша: Enter, Tab, Backspace, Control+A …', kind: 'text', default: 'Enter' }],
  },
  {
    type: 'scroll',
    label: 'Прокрутка',
    fields: [
      { name: 'dy', label: 'Вниз, px (минус — вверх)', kind: 'number', default: 500 },
      { name: 'dx', label: 'Вправо, px', kind: 'number', default: 0 },
    ],
  },
  {
    type: 'wait',
    label: 'Пауза',
    fields: [
      { name: 'ms', label: 'Мс', kind: 'number', default: 1000 },
      { name: 'jitter', label: '± случайно, мс', kind: 'number', default: 0 },
    ],
  },
  {
    type: 'wait_selector',
    label: 'Ждать элемент (CSS)',
    fields: [
      { name: 'selector', label: 'CSS-селектор', kind: 'text', default: '' },
      { name: 'timeout', label: 'Таймаут, мс', kind: 'number', default: 15000 },
    ],
  },
  {
    type: 'click_selector',
    label: 'Клик по элементу (CSS)',
    fields: [{ name: 'selector', label: 'CSS-селектор', kind: 'text', default: '' }],
  },
  { type: 'reload', label: 'Обновить страницу', fields: [] },
  {
    type: 'screenshot',
    label: 'Скриншот',
    fields: [{ name: 'name', label: 'Подпись', kind: 'text', default: '' }],
  },
];

const BY_TYPE = Object.fromEntries(STEPS.map((s) => [s.type, s]));

function num(v, def) {
  if (v === '' || v === null || v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Ожидалось число, получено "${v}"`);
  return n;
}

function checkUrl(url) {
  let raw = String(url ?? '').trim();
  if (!raw || /^https?:\/\/$/i.test(raw)) throw new Error('Не указана ссылка в шаге «Перейти по ссылке»');
  // t.me/abc -> https://t.me/abc (но file:, chrome: и т.п. схемы не трогаем, их отсечёт проверка ниже)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^[^/]+:\d+(\/|$)/.test(raw)) raw = `https://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Некорректный URL: ${url}`);
  }
  // file://, chrome:// и прочее не пускаем — иначе через скриншот можно читать файлы сервера.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Разрешены только http:// и https:// ссылки');
  }
  return u.href;
}

// Пауза, которую можно прервать кнопкой «Стоп».
async function sleep(ms, ctx) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ctx.shouldStop()) throw new Error('Остановлено');
    await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
  }
}

function describe(step) {
  const def = BY_TYPE[step.type];
  const label = def ? def.label : step.type;
  const p = step.params || {};
  const extra = (def ? def.fields : [])
    .filter((f) => p[f.name] !== undefined && p[f.name] !== '')
    .map((f) => `${f.name}=${JSON.stringify(p[f.name]).slice(0, 60)}`)
    .join(' ');
  return extra ? `${label} (${extra})` : label;
}

// ctx: { session(), startSession(opts), restartSession(opts), closeSession(),
//        saveScreenshot(buf, name), shouldStop(), log(msg) }
async function executeStep(step, ctx) {
  const p = step.params || {};
  const page = () => {
    const s = ctx.session();
    if (!s || !s.page) throw new Error('Сессия не запущена — добавь шаг «Начать сессию»');
    return s.page;
  };
  const mouse = () => ctx.session().mouse;

  switch (step.type) {
    case 'start_session':
      return ctx.startSession({ proxy: p.proxy || 'none' });
    case 'restart_session':
      return ctx.restartSession({ proxy: p.proxy || 'same', rotateIp: !!p.rotateIp });
    case 'close_session':
      return ctx.closeSession();
    case 'goto': {
      const pg = page();
      await pg.goto(checkUrl(p.url), { waitUntil: 'domcontentloaded', timeout: 90000 });
      await pg.waitForLoadState('load', { timeout: 45000 }).catch(() => {}); // тяжёлые ресурсы не должны ронять сценарий
      return;
    }
    case 'mouse_move': {
      const pg = page();
      const m = mouse();
      const x = num(p.x, m.x);
      const y = num(p.y, m.y);
      const duration = Math.max(0, num(p.duration, 400));
      const n = Math.max(1, Math.round(duration / 16));
      const sx = m.x;
      const sy = m.y;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // плавный разгон/торможение
        await pg.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
        if (n > 1) await new Promise((r) => setTimeout(r, duration / n));
      }
      m.x = x;
      m.y = y;
      return;
    }
    case 'click': {
      const pg = page();
      const m = mouse();
      const x = num(p.x, m.x);
      const y = num(p.y, m.y);
      await pg.mouse.click(x, y, { button: p.button || 'left', clickCount: p.double ? 2 : 1 });
      m.x = x;
      m.y = y;
      return;
    }
    case 'type_text':
      await page().keyboard.type(String(p.text ?? ''), { delay: Math.max(0, num(p.delay, 80)) });
      return;
    case 'paste_text':
      await page().keyboard.insertText(String(p.text ?? ''));
      return;
    case 'press':
      await page().keyboard.press(String(p.key || 'Enter'));
      return;
    case 'scroll':
      await page().mouse.wheel(num(p.dx, 0), num(p.dy, 500));
      return;
    case 'wait': {
      const ms = Math.max(0, num(p.ms, 1000));
      const j = Math.max(0, num(p.jitter, 0));
      return sleep(Math.max(0, ms + Math.round((Math.random() * 2 - 1) * j)), ctx);
    }
    case 'wait_selector':
      await page().waitForSelector(String(p.selector), { timeout: num(p.timeout, 15000) });
      return;
    case 'click_selector':
      await page().click(String(p.selector), { timeout: 15000 });
      return;
    case 'reload': {
      const pg = page();
      await pg.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
      await pg.waitForLoadState('load', { timeout: 45000 }).catch(() => {});
      return;
    }
    case 'screenshot': {
      const buf = await page().screenshot({ type: 'png' });
      return ctx.saveScreenshot(buf, p.name || '');
    }
    default:
      throw new Error(`Неизвестный шаг: ${step.type}`);
  }
}

// Шаги, после которых страница может начать грузиться (переход, клик по ссылке, Enter в форме).
const NAVIGATING = new Set(['goto', 'click', 'click_selector', 'press', 'reload', 'start_session', 'restart_session']);
const NO_SETTLE = new Set(['wait', 'close_session', 'screenshot']);

// Пауза после шага: не меньше minMs, затем ждём, пока страница догрузится.
// Пауза идёт первой — за это время успевает начаться переход, вызванный кликом,
// и ожидание загрузки относится уже к новой странице.
async function settle(step, ctx, minMs = 1000) {
  if (NO_SETTLE.has(step.type)) return;
  await sleep(Math.max(0, minMs), ctx);
  const s = ctx.session();
  const pg = s && s.page;
  if (!pg) return;
  await pg.waitForLoadState('load', { timeout: 45000 }).catch(() => {});
  if (NAVIGATING.has(step.type)) await pg.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

module.exports = { STEPS, executeStep, describe, sleep, checkUrl, settle };

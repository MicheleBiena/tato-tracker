import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIEWPORT = { width: 375, height: 900 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const STORAGE_KEY = 'tato-tracker-state-v1';
const THEME_KEY = 'tato-tracker-theme';

function pathCandidates() {
  const env = process.env;
  const candidates = [env.CHROME_PATH, env.BROWSER_PATH, env.EDGE_PATH];

  if (process.platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    );
  } else {
    const names = [
      'google-chrome',
      'google-chrome-stable',
      'microsoft-edge',
      'microsoft-edge-stable',
      'chromium',
      'chromium-browser'
    ];
    for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of names) candidates.push(path.join(directory, name));
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function findBrowser() {
  for (const candidate of pathCandidates()) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next common installation path.
    }
  }
  throw new Error(
    'Chrome, Chromium o Edge non trovato. Imposta CHROME_PATH, EDGE_PATH o BROWSER_PATH.'
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDevTools(profileDirectory, browserProcess, timeout = 15_000) {
  const activePortFile = path.join(profileDirectory, 'DevToolsActivePort');
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) {
      throw new Error(`Il browser si e chiuso prima di avviare CDP (codice ${browserProcess.exitCode}).`);
    }
    try {
      const [portLine] = (await readFile(activePortFile, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Chrome writes this file only after the debugging endpoint is ready.
    }
    await delay(50);
  }

  throw new Error('Timeout durante l\'avvio del remote debugging del browser.');
}

async function fetchJson(url, options = {}, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  const cause = lastError?.cause?.message || lastError?.message || 'errore sconosciuto';
  throw new Error(`Endpoint CDP non disponibile (${url}): ${cause}`);
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    assert.equal(typeof WebSocket, 'function', 'Questo smoke test richiede il WebSocket nativo di Node 23.');
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Connessione CDP fallita: ${this.url}`));
      };
      const cleanup = () => {
        this.socket.removeEventListener('open', onOpen);
        this.socket.removeEventListener('error', onError);
      };
      this.socket.addEventListener('open', onOpen);
      this.socket.addEventListener('error', onError);
    });

    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => {
      for (const { reject, timer, method } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`La connessione CDP si e chiusa durante ${method}.`));
      }
      this.pending.clear();
    });
    return this;
  }

  handleMessage(rawMessage) {
    const text = typeof rawMessage === 'string'
      ? rawMessage
      : Buffer.from(rawMessage).toString('utf8');
    const message = JSON.parse(text);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const listener of this.listeners.get(message.method) || []) {
      listener(message.params || {});
    }
  }

  send(method, params = {}, timeout = 8_000) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`La connessione CDP non e aperta (${method}).`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout CDP: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => this.listeners.set(method, listeners.filter((item) => item !== listener));
  }

  once(method, timeout = 8_000) {
    return new Promise((resolve, reject) => {
      const remove = this.on(method, (params) => {
        clearTimeout(timer);
        remove();
        resolve(params);
      });
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Timeout evento CDP: ${method}`));
      }, timeout);
    });
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function connectCdp(url, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    const connection = new CdpConnection(url);
    try {
      return await connection.connect();
    } catch (error) {
      lastError = error;
      connection.close();
      await delay(50);
    }
  }
  throw lastError || new Error(`Connessione CDP fallita: ${url}`);
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || 'Errore JavaScript sconosciuto';
    throw new Error(description);
  }
  return response.result.value;
}

async function waitForPage(cdp, expression, description, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timeout: ${description}${lastError ? ` (${lastError.message})` : ''}`);
}

function formatRemoteArgument(argument) {
  if (Object.hasOwn(argument, 'value')) {
    try {
      return typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value);
    } catch {
      return String(argument.value);
    }
  }
  return argument.description || argument.type || 'valore non serializzabile';
}

async function waitForExit(child, timeout = 3_000) {
  if (!child || child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeout).then(() => false)
  ]);
}

function addUtcDays(dateKey, amount) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  assert.equal(Number.isNaN(date.getTime()), false, `Data calendario non valida: ${dateKey}`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function assertCalendarSnapshot(snapshot, label) {
  assert.equal(snapshot.rows, 6, `${label}: il calendario non contiene 6 righe.`);
  assert.deepEqual(snapshot.cellsPerRow, [7, 7, 7, 7, 7, 7], `${label}: ogni riga deve contenere 7 celle.`);
  assert.equal(snapshot.dates.length, 42, `${label}: il calendario non contiene 42 date.`);
  assert.equal(new Set(snapshot.dates).size, 42, `${label}: sono presenti date duplicate.`);

  snapshot.dates.forEach((dateKey, index) => {
    assert.match(dateKey, /^\d{4}-\d{2}-\d{2}$/, `${label}: attributo data-date non valido.`);
    if (index > 0) {
      assert.equal(dateKey, addUtcDays(snapshot.dates[index - 1], 1), `${label}: le date non sono consecutive.`);
    }
  });

  for (let row = 0; row < 6; row += 1) {
    const first = new Date(`${snapshot.dates[row * 7]}T00:00:00.000Z`).getUTCDay();
    const last = new Date(`${snapshot.dates[row * 7 + 6]}T00:00:00.000Z`).getUTCDay();
    assert.equal(first, 1, `${label}: la riga ${row + 1} non inizia di lunedi.`);
    assert.equal(last, 0, `${label}: la riga ${row + 1} non termina di domenica.`);
  }
}

async function calendarSnapshot(cdp) {
  return evaluate(cdp, `(() => {
    const rows = [...document.querySelectorAll('#calendar-grid > .calendar-row')];
    const cellsByRow = rows.map((row) => [...row.querySelectorAll(':scope > .calendar-day')]);
    return {
      month: document.querySelector('#calendar-month')?.textContent.trim() || '',
      rows: rows.length,
      cellsPerRow: cellsByRow.map((cells) => cells.length),
      dates: cellsByRow.flat().map((cell) => cell.dataset.date || '')
    };
  })()`);
}

async function mobileLayoutSnapshot(cdp) {
  return evaluate(cdp, `(() => ({
    innerWidth,
    innerHeight,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  }))()`);
}

function assertNoHorizontalOverflow(layout, label) {
  assert.equal(layout.innerWidth, VIEWPORT.width, `${label}: la viewport mobile non e larga 375px.`);
  assert.equal(layout.innerHeight, VIEWPORT.height, `${label}: la viewport mobile non e alta 900px.`);
  assert.ok(
    layout.scrollWidth <= layout.innerWidth,
    `${label}: overflow orizzontale di ${layout.scrollWidth}px su ${layout.innerWidth}px.`
  );
}

async function main() {
  const browserPath = await findBrowser();
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'tato-tracker-browser-smoke-'));
  let browserProcess;
  let browserCdp;
  let pageCdp;
  let browserStderr = '';
  let browserExit = null;

  try {
    const browserArgs = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-allow-origins=*',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank'
    ];
    if (process.platform === 'linux') browserArgs.push('--disable-dev-shm-usage');

    browserProcess = spawn(browserPath, browserArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    browserProcess.stderr.on('data', (chunk) => {
      browserStderr = `${browserStderr}${chunk}`.slice(-4_000);
    });
    browserProcess.on('error', (error) => {
      browserStderr = `${browserStderr}\n${error.message}`;
    });
    browserProcess.on('exit', (code, signal) => {
      browserExit = { code, signal };
    });

    let port;
    try {
      port = await waitForDevTools(profileDirectory, browserProcess);
    } catch (error) {
      throw new Error(`${error.message}${browserStderr.trim() ? `\n${browserStderr.trim()}` : ''}`);
    }

    const endpoint = `http://127.0.0.1:${port}`;
    const version = await fetchJson(`${endpoint}/json/version`);
    browserCdp = await connectCdp(version.webSocketDebuggerUrl);

    const target = await fetchJson(`${endpoint}/json/new?${encodeURIComponent('about:blank')}`, {
      method: 'PUT'
    });
    pageCdp = await connectCdp(target.webSocketDebuggerUrl);

    const pageErrors = [];
    pageCdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      pageErrors.push(`Eccezione: ${exceptionDetails?.exception?.description || exceptionDetails?.text || 'sconosciuta'}`);
    });
    pageCdp.on('Runtime.consoleAPICalled', ({ type, args = [] }) => {
      if (type === 'error' || type === 'assert') {
        pageErrors.push(`console.${type}: ${args.map(formatRemoteArgument).join(' ')}`);
      }
    });
    pageCdp.on('Log.entryAdded', ({ entry }) => {
      if (entry?.level === 'error') pageErrors.push(`Log pagina: ${entry.text}`);
    });

    await Promise.all([
      pageCdp.send('Page.enable'),
      pageCdp.send('Runtime.enable'),
      pageCdp.send('Log.enable'),
      pageCdp.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        screenWidth: VIEWPORT.width,
        screenHeight: VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: true
      }),
      pageCdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }),
      pageCdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
    ]);

    const firstLoad = pageCdp.once('Page.loadEventFired');
    const navigation = await pageCdp.send('Page.navigate', { url: INDEX_URL });
    assert.equal(Boolean(navigation.errorText), false, `Navigazione fallita: ${navigation.errorText}`);
    await firstLoad;
    await waitForPage(
      pageCdp,
      `document.readyState === 'complete' && document.querySelectorAll('.goal-card').length >= 3`,
      'render della dashboard demo'
    );

    const dashboard = await evaluate(pageCdp, `(() => {
      const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || 'null');
      return {
        title: document.title,
        metricCards: document.querySelectorAll('.metric-card').length,
        goalCards: document.querySelectorAll('.goal-card').length,
        todayTasks: document.querySelectorAll('.today-task').length,
        goalTitles: [...document.querySelectorAll('.goal-card .goal-copy strong')].map((node) => node.textContent.trim()),
        completion: document.querySelector('#metric-completion')?.textContent.trim(),
        saved
      };
    })()`);
    assert.match(dashboard.title, /^Tato Tracker\b/);
    assert.equal(dashboard.metricCards, 3, 'Le tre metriche principali non sono state renderizzate.');
    assert.ok(dashboard.goalCards >= 3, 'Gli obiettivi demo non sono visibili.');
    assert.ok(dashboard.todayTasks >= 1, 'Il piano demo di oggi e vuoto.');
    assert.ok(['Anatomia', 'Storia dell’arte', 'Lingua inglese'].every((title) => dashboard.goalTitles.includes(title)), 'Mancano uno o piu obiettivi demo.');
    assert.equal(dashboard.saved?.settings?.sampleData, true, 'Lo stato demo non e stato salvato correttamente.');
    assert.ok(dashboard.saved?.goals?.length >= 3, 'Il salvataggio demo non contiene gli obiettivi previsti.');
    assert.notEqual(dashboard.completion, '0%', 'Il grafico di completamento demo non contiene progressi.');

    const currentCalendar = await calendarSnapshot(pageCdp);
    assertCalendarSnapshot(currentCalendar, 'Mese corrente');

    await evaluate(pageCdp, `document.querySelector('#calendar-next').click()`);
    const nextCalendar = await calendarSnapshot(pageCdp);
    assertCalendarSnapshot(nextCalendar, 'Mese successivo');
    assert.notEqual(nextCalendar.month, currentCalendar.month, 'Il pulsante mese successivo non cambia mese.');

    await evaluate(pageCdp, `document.querySelector('#calendar-prev').click()`);
    const backFromNextCalendar = await calendarSnapshot(pageCdp);
    assertCalendarSnapshot(backFromNextCalendar, 'Ritorno dal mese successivo');
    assert.equal(backFromNextCalendar.month, currentCalendar.month, 'Il ritorno dal mese successivo slitta il mese.');
    assert.deepEqual(backFromNextCalendar.dates, currentCalendar.dates, 'Il ritorno dal mese successivo slitta le date.');

    await evaluate(pageCdp, `document.querySelector('#calendar-prev').click()`);
    const previousCalendar = await calendarSnapshot(pageCdp);
    assertCalendarSnapshot(previousCalendar, 'Mese precedente');
    assert.notEqual(previousCalendar.month, currentCalendar.month, 'Il pulsante mese precedente non cambia mese.');

    await evaluate(pageCdp, `document.querySelector('#calendar-next').click()`);
    const backFromPreviousCalendar = await calendarSnapshot(pageCdp);
    assertCalendarSnapshot(backFromPreviousCalendar, 'Ritorno dal mese precedente');
    assert.equal(backFromPreviousCalendar.month, currentCalendar.month, 'Il ritorno dal mese precedente slitta il mese.');
    assert.deepEqual(backFromPreviousCalendar.dates, currentCalendar.dates, 'Il ritorno dal mese precedente slitta le date.');

    const keyboardMonthNavigation = await evaluate(pageCdp, `(async () => {
      const currentMonth = document.querySelector('#calendar-month').textContent.trim();
      const currentMonthCells = [...document.querySelectorAll('.calendar-day:not(.outside-month)')];
      const source = currentMonthCells.find((cell) => Number(cell.dataset.date.slice(-2)) === 15);
      if (!source) throw new Error('Il giorno 15 del mese corrente non e disponibile.');
      source.focus();
      source.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
      await new Promise(requestAnimationFrame);
      const forward = document.querySelector('.calendar-day[tabindex="0"]')?.dataset.date || '';
      const forwardMonth = document.querySelector('#calendar-month').textContent.trim();
      document.querySelector('.calendar-day[tabindex="0"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
      await new Promise(requestAnimationFrame);
      return {
        source: source.dataset.date,
        forward,
        forwardMonth,
        returned: document.querySelector('.calendar-day[tabindex="0"]')?.dataset.date || '',
        returnedMonth: document.querySelector('#calendar-month').textContent.trim(),
        currentMonth
      };
    })()`);
    assert.equal(keyboardMonthNavigation.forward.slice(-2), '15', 'PageDown non conserva il giorno del mese.');
    assert.notEqual(keyboardMonthNavigation.forwardMonth, keyboardMonthNavigation.currentMonth, 'PageDown non cambia mese.');
    assert.equal(keyboardMonthNavigation.returned, keyboardMonthNavigation.source, 'PageUp non torna alla data di partenza.');
    assert.equal(keyboardMonthNavigation.returnedMonth, keyboardMonthNavigation.currentMonth, 'PageUp non torna al mese di partenza.');

    const mobileLayout = await mobileLayoutSnapshot(pageCdp);
    assertNoHorizontalOverflow(mobileLayout, 'Dashboard mobile');

    const theme = await evaluate(pageCdp, `(() => {
      const button = document.querySelector('#theme-toggle');
      const before = document.documentElement.dataset.theme;
      button.click();
      return {
        before,
        after: document.documentElement.dataset.theme,
        saved: localStorage.getItem(${JSON.stringify(THEME_KEY)}),
        label: button.getAttribute('aria-label')
      };
    })()`);
    assert.notEqual(theme.after, theme.before, 'Il toggle tema non cambia il tema.');
    assert.equal(theme.saved, theme.after, 'Il tema scelto non viene salvato.');
    assert.match(theme.label, theme.after === 'dark' ? /chiaro/i : /scuro/i);

    await evaluate(pageCdp, `document.querySelector('.mobile-nav a[href="#pomodoro-view"]').click()`);
    await waitForPage(
      pageCdp,
      `!document.querySelector('#pomodoro-view').hidden && document.querySelector('#main-content').hidden`,
      'apertura della vista Pomodoro'
    );
    const pomodoroInitial = await evaluate(pageCdp, `(() => ({
      hash: location.hash,
      title: document.title,
      rootPaths: document.querySelectorAll('#potato-plant .potato-root').length,
      sprout: Boolean(document.querySelector('#potato-plant .potato-sprout')),
      branches: document.querySelectorAll('#potato-plant .potato-branch').length,
      sproutAboveSoil: Boolean(
        document.querySelector('#potato-plant .soil-surface').compareDocumentPosition(
          document.querySelector('#potato-plant .potato-sprout')
        ) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      sessions: document.querySelector('#pomodoro-sessions').value,
      focus: document.querySelector('#pomodoro-focus').value,
      shortBreak: document.querySelector('#pomodoro-break').value,
      status: document.querySelector('#timer-status').textContent.trim(),
      plantCaption: document.querySelector('#plant-caption').textContent.trim(),
      longBreakEnabled: document.querySelector('#long-break-enabled').checked,
      activeNav: document.querySelector('.mobile-nav a[href="#pomodoro-view"]').getAttribute('aria-current'),
      stepCount: document.querySelectorAll('#session-steps li').length,
      mobileNavItems: document.querySelectorAll('.mobile-nav > a, .mobile-nav > button').length,
      plantWidth: document.querySelector('#potato-plant').getBoundingClientRect().width,
      controlHeights: [
        '#timer-start',
        '#timer-skip',
        '#timer-reset',
        '#pomodoro-sessions',
        '#pomodoro-focus',
        '#pomodoro-break'
      ].map((selector) => document.querySelector(selector).getBoundingClientRect().height)
    }))()`);
    assert.equal(pomodoroInitial.hash, '#pomodoro-view');
    assert.match(pomodoroInitial.title, /25:00.*Concentrazione.*Tato Tracker/);
    assert.equal(pomodoroInitial.rootPaths, 5, 'L\'illustrazione SVG non contiene le radici previste.');
    assert.equal(pomodoroInitial.sprout, true, 'L\'illustrazione SVG non contiene il germoglio.');
    assert.equal(pomodoroInitial.branches, 5, 'Le foglie SVG non sono collegate al gambo.');
    assert.equal(pomodoroInitial.sproutAboveSoil, true, 'Il gambo SVG non emerge davanti al terreno.');
    assert.deepEqual(
      [pomodoroInitial.sessions, pomodoroInitial.focus, pomodoroInitial.shortBreak],
      ['4', '25', '5']
    );
    assert.equal(pomodoroInitial.status, 'Timer pronto.');
    assert.equal(pomodoroInitial.plantCaption, 'Crescita radici: 0% \u00b7 germoglio: 0%');
    assert.equal(pomodoroInitial.longBreakEnabled, true);
    assert.equal(pomodoroInitial.activeNav, 'page');
    assert.equal(pomodoroInitial.stepCount, 4);
    assert.equal(pomodoroInitial.mobileNavItems, 5, 'La navigazione mobile non contiene le cinque destinazioni previste.');
    assert.ok(pomodoroInitial.plantWidth <= VIEWPORT.width, 'L\'illustrazione Pomodoro supera la viewport mobile.');
    assert.ok(pomodoroInitial.controlHeights.every((height) => height >= 44), 'Un controllo Pomodoro e piu basso di 44px.');
    assertNoHorizontalOverflow(await mobileLayoutSnapshot(pageCdp), 'Vista Pomodoro mobile');

    await pageCdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: VIEWPORT.height,
      screenWidth: 320,
      screenHeight: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: true
    });
    const compactPomodoro = await mobileLayoutSnapshot(pageCdp);
    assert.equal(compactPomodoro.innerWidth, 320, 'La vista compatta non usa una viewport da 320px.');
    assert.ok(compactPomodoro.scrollWidth <= 320, `Il Pomodoro ha overflow a 320px (${compactPomodoro.scrollWidth}px).`);
    assert.ok(
      await evaluate(pageCdp, `document.querySelector('#potato-plant').getBoundingClientRect().width <= 320`),
      'L\'SVG supera la viewport da 320px.'
    );
    await pageCdp.send('Emulation.setDeviceMetricsOverride', {
      width: 812,
      height: 375,
      screenWidth: 812,
      screenHeight: 375,
      deviceScaleFactor: 1,
      mobile: true
    });
    const landscapePomodoro = await mobileLayoutSnapshot(pageCdp);
    assert.equal(landscapePomodoro.innerWidth, 812);
    assert.ok(landscapePomodoro.scrollWidth <= 812, `Il Pomodoro ha overflow in landscape (${landscapePomodoro.scrollWidth}px).`);
    assert.equal(
      await evaluate(pageCdp, `getComputedStyle(document.querySelector('.desktop-nav')).display !== 'none'`),
      true,
      'La navigazione Pomodoro scompare nella fascia tablet/landscape.'
    );
    await pageCdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: true
    });

    const longBreakToggle = await evaluate(pageCdp, `(() => {
      const toggle = document.querySelector('#long-break-enabled');
      toggle.click();
      const disabled = [...document.querySelectorAll('#long-break-fields input')].every((input) => input.disabled);
      const hidden = document.querySelector('#long-break-fields').hidden;
      toggle.click();
      return { disabled, hidden, restored: toggle.checked };
    })()`);
    assert.deepEqual(longBreakToggle, { disabled: true, hidden: true, restored: true });

    await evaluate(pageCdp, `(() => {
      const values = {
        '#pomodoro-sessions': '3',
        '#pomodoro-focus': '1',
        '#pomodoro-break': '2',
        '#long-break-every': '2',
        '#long-break-duration': '7'
      };
      for (const [selector, value] of Object.entries(values)) {
        document.querySelector(selector).value = value;
      }
      document.querySelector('#pomodoro-settings').requestSubmit();
    })()`);
    await waitForPage(
      pageCdp,
      `JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1') || 'null')?.timer?.config?.sessions === 3`,
      'salvataggio impostazioni Pomodoro'
    );
    const configuredPomodoro = await evaluate(pageCdp, `(() => {
      const saved = JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1') || 'null');
      return {
        config: saved?.timer?.config,
        phase: saved?.timer?.phase,
        remaining: saved?.timer?.remainingSeconds,
        stepCount: document.querySelectorAll('#session-steps li').length,
        preview: document.querySelector('#cycle-preview').textContent.replace(/\\s+/g, ' ').trim()
      };
    })()`);
    assert.deepEqual(configuredPomodoro.config, {
      sessions: 3,
      focusMinutes: 1,
      shortBreakMinutes: 2,
      longBreakEnabled: true,
      longBreakEvery: 2,
      longBreakMinutes: 7
    });
    assert.equal(configuredPomodoro.phase, 'focus');
    assert.equal(configuredPomodoro.remaining, 60);
    assert.equal(configuredPomodoro.stepCount, 3);
    assert.match(configuredPomodoro.preview, /3.*Sessioni di concentrazione.*1 min ciascuna/);
    assert.match(configuredPomodoro.preview, /Pausa lunga da 7 min ogni 2 sessioni/);

    await evaluate(pageCdp, `document.querySelector('#timer-start').click()`);
    await waitForPage(
      pageCdp,
      `JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1') || 'null')?.timer?.running === true`,
      'avvio timer Pomodoro'
    );
    await delay(1_100);
    await evaluate(pageCdp, `document.querySelector('#timer-start').click()`);
    const pausedPomodoro = await evaluate(pageCdp, `(() => {
      const saved = JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1') || 'null')?.timer;
      return {
        running: saved?.running,
        remaining: saved?.remainingSeconds,
        label: document.querySelector('#timer-start span').textContent.trim()
      };
    })()`);
    assert.equal(pausedPomodoro.running, false);
    assert.ok(pausedPomodoro.remaining >= 58 && pausedPomodoro.remaining <= 59, 'La pausa non conserva il tempo rimanente.');
    assert.equal(pausedPomodoro.label, 'Riprendi');

    const quickPhaseScript = await pageCdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__pomodoroAlarmPlayCount = 0;
        window.__pomodoroAlarmPauseCount = 0;
        HTMLMediaElement.prototype.play = function () {
          window.__pomodoroAlarmPlayCount += 1;
          return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function () {
          window.__pomodoroAlarmPauseCount += 1;
        };
        try {
          const saved = JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1'));
          saved.timer.phase = 'focus';
          saved.timer.session = 1;
          saved.timer.completedSessions = 0;
          saved.timer.remainingSeconds = 1;
          saved.timer.totalSeconds = 60;
          saved.timer.running = true;
          saved.timer.endsAt = Date.now() + 250;
          localStorage.setItem('tato-tracker-pomodoro-v1', JSON.stringify(saved));
        } catch (_) {}
      })();`
    });
    const pomodoroReload = pageCdp.once('Page.loadEventFired');
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await pomodoroReload;
    await pageCdp.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: quickPhaseScript.identifier
    });
    await waitForPage(
      pageCdp,
      `JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1') || 'null')?.timer?.phase === 'shortBreak'`,
      'avanzamento Pomodoro dopo reload'
    );
    const restoredPomodoro = await evaluate(pageCdp, `(() => {
      const saved = JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1'))?.timer;
      const today = TatoStudyLog.dateKeyAt(Date.now());
      const study = TatoStudyLog.summaryForDate(
        TatoStudyLog.load(localStorage),
        today
      );
      const calendarDay = document.querySelector('.calendar-day[data-date="' + today + '"]');
      return {
        viewVisible: !document.querySelector('#pomodoro-view').hidden,
        phase: saved?.phase,
        running: saved?.running,
        completed: saved?.completedSessions,
        rootGrowth: Number(document.querySelector('#potato-plant').style.getPropertyValue('--root-growth')),
        phaseText: document.querySelector('#timer-phase').textContent.trim(),
        study,
        dailyTime: document.querySelector('#daily-study-time').textContent.trim(),
        dailyMessage: document.querySelector('#daily-study-message').textContent.trim(),
        dailySessions: document.querySelector('#daily-study-sessions').textContent.trim(),
        calendarBadge: calendarDay?.querySelector('.calendar-study-time')?.textContent.trim() || '',
        calendarLabel: calendarDay?.getAttribute('aria-label') || '',
        noticeHidden: document.querySelector('#pomodoro-timeout-notification').hidden,
        noticeTitle: document.querySelector('#pomodoro-timeout-title').textContent.trim(),
        noticeDetail: document.querySelector('#pomodoro-timeout-detail').textContent.trim(),
        alarmLoop: document.querySelector('#pomodoro-alarm').loop
      };
    })()`);
    assert.equal(restoredPomodoro.viewVisible, true, 'Il reload non conserva la vista Pomodoro.');
    assert.equal(restoredPomodoro.phase, 'shortBreak');
    assert.equal(restoredPomodoro.running, true);
    assert.equal(restoredPomodoro.completed, 1);
    assert.ok(restoredPomodoro.rootGrowth > 0, 'Le radici SVG non crescono dopo una sessione.');
    assert.equal(restoredPomodoro.phaseText, 'Pausa breve');
    assert.deepEqual(restoredPomodoro.study, { seconds: 60, sessions: 1 });
    assert.equal(restoredPomodoro.dailyTime, '1 min');
    assert.match(restoredPomodoro.dailyMessage, /tato-alizzato 1 min di studio.*Vai così/i);
    assert.equal(restoredPomodoro.dailySessions, '1 sessione completata');
    assert.equal(restoredPomodoro.calendarBadge, '1m');
    assert.match(restoredPomodoro.calendarLabel, /Pomodoro: 1 min, 1 sessione completata/);
    assert.equal(restoredPomodoro.noticeHidden, false, 'La notifica non appare alla fine della fase.');
    assert.equal(restoredPomodoro.noticeTitle, 'Sessione terminata');
    assert.equal(restoredPomodoro.noticeDetail, 'Pausa breve pronta.');
    assert.equal(restoredPomodoro.alarmLoop, true, 'Il suono non viene ripetuto durante la notifica.');
    assert.equal(
      await evaluate(pageCdp, `window.__pomodoroAlarmPlayCount`),
      1,
      'Il suono Pomodoro non parte alla fine della fase.'
    );
    await delay(6_200);
    const expiredAlert = await evaluate(pageCdp, `({
      hidden: document.querySelector('#pomodoro-timeout-notification').hidden,
      alarmLoop: document.querySelector('#pomodoro-alarm').loop,
      pauseCount: window.__pomodoroAlarmPauseCount
    })`);
    assert.equal(expiredAlert.hidden, true, 'La notifica non scompare dopo sei secondi.');
    assert.equal(expiredAlert.alarmLoop, false, 'Il loop audio continua dopo la notifica.');
    assert.ok(expiredAlert.pauseCount >= 2, 'Il suono non viene arrestato alla fine della notifica.');
    await evaluate(pageCdp, `document.querySelector('#timer-test-notification').click()`);
    const manualAlert = await evaluate(pageCdp, `({
      hidden: document.querySelector('#pomodoro-timeout-notification').hidden,
      title: document.querySelector('#pomodoro-timeout-title').textContent.trim(),
      detail: document.querySelector('#pomodoro-timeout-detail').textContent.trim(),
      alarmLoop: document.querySelector('#pomodoro-alarm').loop
    })`);
    assert.equal(manualAlert.hidden, false, 'Il tasto di test non mostra la notifica.');
    assert.equal(manualAlert.title, 'Test notifica');
    assert.equal(manualAlert.detail, 'Suono e avviso attivi per 6 secondi.');
    assert.equal(manualAlert.alarmLoop, true, 'Il tasto di test non avvia il loop audio.');

    const quickBreakScript = await pageCdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__pomodoroAlarmPlayCount = 0;
        HTMLMediaElement.prototype.play = function () {
          window.__pomodoroAlarmPlayCount += 1;
          return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function () {};
        try {
          const saved = JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1'));
          saved.timer.phase = 'shortBreak';
          saved.timer.session = 1;
          saved.timer.completedSessions = 1;
          saved.timer.remainingSeconds = 1;
          saved.timer.remainingMilliseconds = 250;
          saved.timer.running = true;
          saved.timer.endsAt = Date.now() + 250;
          localStorage.setItem('tato-tracker-pomodoro-v1', JSON.stringify(saved));
        } catch (_) {}
      })();`
    });
    const pomodoroBreakReload = pageCdp.once('Page.loadEventFired');
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await pomodoroBreakReload;
    await pageCdp.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: quickBreakScript.identifier
    });
    await waitForPage(
      pageCdp,
      `JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1') || 'null')?.timer?.phase === 'focus'
        && JSON.parse(localStorage.getItem('tato-tracker-pomodoro-v1') || 'null')?.timer?.session === 2`,
      'avanzamento Pomodoro alla fine della pausa'
    );
    const breakAlert = await evaluate(pageCdp, `({
      hidden: document.querySelector('#pomodoro-timeout-notification').hidden,
      title: document.querySelector('#pomodoro-timeout-title').textContent.trim(),
      detail: document.querySelector('#pomodoro-timeout-detail').textContent.trim(),
      alarmLoop: document.querySelector('#pomodoro-alarm').loop,
      playCount: window.__pomodoroAlarmPlayCount
    })`);
    assert.equal(breakAlert.hidden, false, 'La notifica non appare alla fine della pausa.');
    assert.equal(breakAlert.title, 'Pausa terminata');
    assert.equal(breakAlert.detail, 'Sessione 2 pronta.');
    assert.equal(breakAlert.alarmLoop, true, 'Il suono non viene ripetuto alla fine della pausa.');
    assert.equal(breakAlert.playCount, 1, 'Il suono non parte alla fine della pausa.');
    await evaluate(pageCdp, `document.querySelector('#timer-start').click()`);

    await evaluate(pageCdp, `document.querySelector('.mobile-nav a[href="#today-section"]').click()`);
    await waitForPage(
      pageCdp,
      `!document.querySelector('#main-content').hidden && document.querySelector('#pomodoro-view').hidden`,
      'ritorno al planner dal Pomodoro'
    );
    assert.equal(
      await evaluate(pageCdp, `location.hash`),
      '#today-section',
      'La navigazione non torna alla vista planner.'
    );

    const opened = await evaluate(pageCdp, `(() => {
      const button = [...document.querySelectorAll('[data-open-goal]')].find((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      if (!button) throw new Error('Nessun pulsante Nuovo obiettivo visibile');
      button.click();
      return document.querySelector('#goal-dialog').open;
    })()`);
    assert.equal(opened, true, 'La modale Nuovo obiettivo non si apre.');

    const closed = await evaluate(pageCdp, `(() => {
      const dialog = document.querySelector('#goal-dialog');
      const button = [...dialog.querySelectorAll('[data-close-dialog]')].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!button) throw new Error('Nessun pulsante di chiusura visibile');
      button.click();
      return !dialog.open;
    })()`);
    assert.equal(closed, true, 'La modale Nuovo obiettivo non si chiude.');

    const smokeGoalTitle = `Browser smoke ${Date.now()}`;
    const submitted = await evaluate(pageCdp, `(() => {
      document.querySelector('[data-open-goal]').click();
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const today = TatoPlanner.todayKey();
      setValue('#goal-title', ${JSON.stringify(smokeGoalTitle)});
      setValue('#goal-pages', '42');
      setValue('#goal-start', today);
      setValue('#goal-due', TatoPlanner.addDaysKey(today, 14));
      document.querySelector('#goal-form').requestSubmit();
      return true;
    })()`);
    assert.equal(submitted, true);
    await waitForPage(
      pageCdp,
      `!document.querySelector('#goal-dialog').open && [...document.querySelectorAll('.goal-card')].some((node) => node.textContent.includes(${JSON.stringify(smokeGoalTitle)}))`,
      'creazione del nuovo obiettivo'
    );

    const savedGoal = await evaluate(pageCdp, `(() => {
      const state = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || 'null');
      const goal = state?.goals?.find((item) => item.title === ${JSON.stringify(smokeGoalTitle)});
      return goal ? { title: goal.title, totalPages: goal.totalPages, sampleData: state.settings.sampleData } : null;
    })()`);
    assert.deepEqual(savedGoal, { title: smokeGoalTitle, totalPages: 42, sampleData: false });

    const specificGoalTitle = `Browser specific ${Date.now()}`;
    const specificSetup = await evaluate(pageCdp, `(() => {
      document.querySelector('[data-open-goal]').click();
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const startDate = TatoPlanner.addDaysKey(TatoPlanner.todayKey(), 1);
      const endDate = TatoPlanner.addDaysKey(startDate, 8);
      const selectedDates = [
        startDate,
        TatoPlanner.addDaysKey(startDate, 3),
        endDate
      ];

      setValue('#goal-title', ${JSON.stringify(specificGoalTitle)});
      setValue('#goal-pages', '15');
      setValue('#goal-start', startDate);
      setValue('#goal-due', endDate);
      document.querySelector('input[name="scheduleMode"][value="specific"]').click();
      document.querySelector('#clear-all-dates').click();

      for (const dateKey of selectedDates) {
        const input = document.querySelector('input[name="studyDates"][value="' + dateKey + '"]');
        if (!input) throw new Error('Data specifica non disponibile: ' + dateKey);
        input.click();
      }

      const checkedDates = [...document.querySelectorAll('input[name="studyDates"]:checked')]
        .map((input) => input.value)
        .sort();
      const modalLayout = {
        innerWidth,
        innerHeight,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
      };
      document.querySelector('#goal-form').requestSubmit();
      return { selectedDates: selectedDates.sort(), checkedDates, modalLayout };
    })()`);
    assert.deepEqual(specificSetup.checkedDates, specificSetup.selectedDates, 'La modale non mantiene esattamente le 3 date selezionate.');
    assert.equal(specificSetup.selectedDates.length, 3, 'Lo smoke deve selezionare esattamente 3 date specifiche.');
    assertNoHorizontalOverflow(specificSetup.modalLayout, 'Modale date specifiche');
    await waitForPage(
      pageCdp,
      `!document.querySelector('#goal-dialog').open && [...document.querySelectorAll('.goal-card')].some((node) => node.textContent.includes(${JSON.stringify(specificGoalTitle)}))`,
      'creazione dell\'obiettivo con date specifiche'
    );

    const savedSpecificGoal = await evaluate(pageCdp, `(() => {
      const state = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || 'null');
      const goal = state?.goals?.find((item) => item.title === ${JSON.stringify(specificGoalTitle)});
      return goal ? {
        title: goal.title,
        totalPages: goal.totalPages,
        scheduleMode: goal.scheduleMode,
        restWeekdays: goal.restWeekdays,
        dateRules: Object.entries(goal.dateRules || {}).sort(([left], [right]) => left.localeCompare(right)),
        allocations: Object.entries(goal.allocations || {})
          .map(([date, entry]) => ({ date, planned: entry.planned }))
          .sort((left, right) => left.date.localeCompare(right.date))
      } : null;
    })()`);
    assert.ok(savedSpecificGoal, 'L\'obiettivo con date specifiche non e presente in localStorage.');
    assert.equal(savedSpecificGoal.scheduleMode, 'specific');
    assert.deepEqual(savedSpecificGoal.restWeekdays, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(
      savedSpecificGoal.dateRules,
      specificSetup.selectedDates.map((date) => [date, 'study']),
      'Le regole data non coincidono con le 3 date selezionate.'
    );
    const positiveAllocations = savedSpecificGoal.allocations.filter(({ planned }) => planned > 0);
    assert.deepEqual(
      positiveAllocations.map(({ date }) => date),
      specificSetup.selectedDates,
      'Sono state pianificate pagine fuori dalle 3 date selezionate.'
    );
    assert.ok(positiveAllocations.every(({ planned }) => Number.isInteger(planned) && planned > 0));
    assert.equal(
      savedSpecificGoal.allocations.reduce((sum, { planned }) => sum + planned, 0),
      savedSpecificGoal.totalPages,
      'Il totale delle pagine pianificate non coincide con il totale obiettivo.'
    );

    const exported = await evaluate(pageCdp, `(async () => {
      let captured = null;
      const originalClick = HTMLAnchorElement.prototype.click;
      const originalRevoke = URL.revokeObjectURL;
      try {
        HTMLAnchorElement.prototype.click = function captureDownload() {
          captured = { href: this.href, download: this.download };
        };
        URL.revokeObjectURL = () => {};
        document.querySelector('#export-data').click();
        if (!captured) throw new Error('Il download del backup non e stato avviato.');
        const response = await fetch(captured.href);
        const payload = JSON.parse(await response.text());
        return {
          download: captured.download,
          app: payload.app,
          schemaVersion: payload.schemaVersion,
          titles: payload.goals.map((goal) => goal.title),
          pomodoroEvents: payload.pomodoroStudy?.events || []
        };
      } finally {
        HTMLAnchorElement.prototype.click = originalClick;
        URL.revokeObjectURL = originalRevoke;
        if (captured?.href) originalRevoke.call(URL, captured.href);
      }
    })()`);
    assert.match(exported.download, /^tato-tracker-backup-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(exported.app, 'Tato Tracker');
    assert.equal(exported.schemaVersion, 1);
    assert.ok(exported.titles.includes(smokeGoalTitle), 'Il backup esportato non contiene l\'obiettivo settimanale.');
    assert.ok(exported.titles.includes(specificGoalTitle), 'Il backup esportato non contiene l\'obiettivo con date specifiche.');
    assert.equal(exported.pomodoroEvents.length, 1, 'Il backup non contiene lo storico Pomodoro.');
    assert.equal(exported.pomodoroEvents[0].durationSeconds, 60);

    const layoutAfterSpecificGoal = await mobileLayoutSnapshot(pageCdp);
    assertNoHorizontalOverflow(layoutAfterSpecificGoal, 'Dashboard dopo obiettivo specifico');

    const reload = pageCdp.once('Page.loadEventFired');
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await reload;
    await waitForPage(
      pageCdp,
      `[${JSON.stringify(smokeGoalTitle)}, ${JSON.stringify(specificGoalTitle)}].every((title) => [...document.querySelectorAll('.goal-card')].some((node) => node.textContent.includes(title)))`,
      'persistenza dei nuovi obiettivi dopo reload'
    );
    const persisted = await evaluate(pageCdp, `(() => ({
      inStorage: JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || 'null')?.goals?.some((goal) => goal.title === ${JSON.stringify(smokeGoalTitle)}) === true,
      inDom: [...document.querySelectorAll('.goal-card')].some((node) => node.textContent.includes(${JSON.stringify(smokeGoalTitle)})),
      specificInStorage: JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || 'null')?.goals?.some((goal) => goal.title === ${JSON.stringify(specificGoalTitle)} && goal.scheduleMode === 'specific') === true,
      specificInDom: [...document.querySelectorAll('.goal-card')].some((node) => node.textContent.includes(${JSON.stringify(specificGoalTitle)})),
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem(${JSON.stringify(THEME_KEY)})
    }))()`);
    assert.equal(persisted.inStorage, true, 'Il nuovo obiettivo non persiste in localStorage.');
    assert.equal(persisted.inDom, true, 'Il nuovo obiettivo non ricompare dopo reload.');
    assert.equal(persisted.specificInStorage, true, 'L\'obiettivo con date specifiche non persiste in localStorage.');
    assert.equal(persisted.specificInDom, true, 'L\'obiettivo con date specifiche non ricompare dopo reload.');
    assert.equal(persisted.theme, theme.after, 'Il tema non persiste dopo reload.');
    assert.equal(persisted.savedTheme, theme.after, 'Il tema persistito non coincide con quello attivo.');

    const layoutAfterReload = await mobileLayoutSnapshot(pageCdp);
    assertNoHorizontalOverflow(layoutAfterReload, 'Dashboard dopo reload');

    const stateBeforeInvalidImport = await evaluate(
      pageCdp,
      `localStorage.getItem(${JSON.stringify(STORAGE_KEY)})`
    );
    await evaluate(pageCdp, `(() => {
      const input = document.querySelector('#import-file');
      const transfer = new DataTransfer();
      transfer.items.add(new File(['{backup non valido'], 'non-valido.json', { type: 'application/json' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForPage(
      pageCdp,
      `document.querySelector('#import-file').value === '' && !document.querySelector('#confirm-dialog').open`,
      'rifiuto del backup non valido'
    );
    const invalidImport = await evaluate(pageCdp, `(() => ({
      state: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
      toast: document.querySelector('#toast').textContent.trim(),
      confirmationOpen: document.querySelector('#confirm-dialog').open
    }))()`);
    assert.equal(invalidImport.state, stateBeforeInvalidImport, 'Un import non valido ha modificato lo stato.');
    assert.equal(invalidImport.confirmationOpen, false, 'Un import non valido ha aperto la conferma.');
    assert.ok(invalidImport.toast.length > 0, 'L\'import non valido non mostra un messaggio.');

    const importFixture = await evaluate(pageCdp, `(() => {
      const startDate = TatoPlanner.addDaysKey(TatoPlanner.todayKey(), 2);
      const endDate = TatoPlanner.addDaysKey(startDate, 4);
      const title = 'Backup date specifiche legacy';
      const goal = TatoPlanner.createGoal({
        id: 'import-legacy-specific',
        title,
        totalPages: 12,
        startDate,
        endDate,
        restWeekdays: [0, 1, 2, 3, 4, 5, 6],
        dateRules: { [startDate]: 'study', [endDate]: 'study' },
        color: '#5E8C72'
      });
      goal.dateRules = { [startDate]: 'available', [endDate]: { mode: 'work' } };
      delete goal.scheduleMode;
      window.__tatoImportFixture = JSON.stringify({
        schemaVersion: 1,
        goals: [goal],
        settings: { autoRedistribute: true, sampleData: false }
      });
      return { title, startDate, endDate };
    })()`);

    const dispatchFixtureImport = `(() => {
      const input = document.querySelector('#import-file');
      const transfer = new DataTransfer();
      transfer.items.add(new File([window.__tatoImportFixture], 'backup.json', { type: 'application/json' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`;

    await evaluate(pageCdp, dispatchFixtureImport);
    await waitForPage(pageCdp, `document.querySelector('#confirm-dialog').open`, 'conferma import annullabile');
    await evaluate(pageCdp, `document.querySelector('#confirm-cancel').click()`);
    await waitForPage(
      pageCdp,
      `!document.querySelector('#confirm-dialog').open && document.querySelector('#import-file').value === ''`,
      'annullamento import'
    );
    assert.equal(
      await evaluate(pageCdp, `localStorage.getItem(${JSON.stringify(STORAGE_KEY)})`),
      stateBeforeInvalidImport,
      'Annullare un import ha modificato lo stato.'
    );

    await evaluate(pageCdp, dispatchFixtureImport);
    await waitForPage(pageCdp, `document.querySelector('#confirm-dialog').open`, 'conferma import valido');
    await evaluate(pageCdp, `document.querySelector('#confirm-accept').click()`);
    await waitForPage(
      pageCdp,
      `[...document.querySelectorAll('.goal-card')].some((node) => node.textContent.includes(${JSON.stringify('Backup date specifiche legacy')}))`,
      'applicazione import valido'
    );
    const importedState = await evaluate(pageCdp, `(() => {
      const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || 'null');
      const goal = saved?.goals?.find((item) => item.id === 'import-legacy-specific');
      return {
        goalCount: saved?.goals?.length,
        sampleData: saved?.settings?.sampleData,
        goal: goal && {
          title: goal.title,
          scheduleMode: goal.scheduleMode,
          dateRules: Object.entries(goal.dateRules || {}).sort(([left], [right]) => left.localeCompare(right))
        }
      };
    })()`);
    assert.equal(importedState.goalCount, 1, 'L\'import valido non sostituisce lo stato.');
    assert.equal(importedState.sampleData, false);
    assert.equal(importedState.goal?.title, importFixture.title);
    assert.equal(importedState.goal?.scheduleMode, 'specific', 'Il backup legacy non viene riconosciuto come date specifiche.');
    assert.deepEqual(
      importedState.goal?.dateRules,
      [[importFixture.startDate, 'study'], [importFixture.endDate, 'study']],
      'Gli alias legacy delle regole data non vengono normalizzati.'
    );

    const importReload = pageCdp.once('Page.loadEventFired');
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await importReload;
    await waitForPage(
      pageCdp,
      `[...document.querySelectorAll('.goal-card')].some((node) => node.textContent.includes(${JSON.stringify('Backup date specifiche legacy')}))`,
      'persistenza import dopo reload'
    );

    await evaluate(pageCdp, `document.querySelector('#reset-data').click()`);
    await waitForPage(pageCdp, `document.querySelector('#confirm-dialog').open`, 'conferma reset');
    await evaluate(pageCdp, `document.querySelector('#confirm-accept').click()`);
    await waitForPage(pageCdp, `document.querySelectorAll('.goal-card').length === 0`, 'reset dei dati');
    const resetState = await evaluate(pageCdp, `JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || 'null')`);
    const resetStudy = await evaluate(pageCdp, `TatoStudyLog.load(localStorage)`);
    assert.deepEqual(resetState?.goals, [], 'Il reset non salva uno spazio vuoto.');
    assert.equal(resetState?.settings?.sampleData, false, 'Il reset riattiva i dati demo.');
    assert.deepEqual(resetStudy?.events, [], 'Il reset non cancella lo storico Pomodoro.');

    const resetReload = pageCdp.once('Page.loadEventFired');
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await resetReload;
    await waitForPage(pageCdp, `document.querySelectorAll('.goal-card').length === 0`, 'persistenza reset dopo reload');

    await evaluate(pageCdp, `(() => {
      localStorage.removeItem('tato-tracker-recovery-v1');
      localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, '{stato corrotto');
    })()`);
    const corruptReload = pageCdp.once('Page.loadEventFired');
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await corruptReload;
    await waitForPage(pageCdp, `document.querySelectorAll('.goal-card').length >= 3`, 'recupero stato corrotto');
    const firstRecovery = await evaluate(pageCdp, `(() => ({
      original: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
      recovery: localStorage.getItem('tato-tracker-recovery-v1'),
      keys: Object.keys(localStorage).filter((key) => key.startsWith('tato-tracker-recovery-')).sort()
    }))()`);
    assert.equal(firstRecovery.original, '{stato corrotto', 'Il recupero ha sovrascritto lo stato originale.');
    assert.equal(firstRecovery.recovery, firstRecovery.original, 'La copia di recupero non conserva lo stato corrotto.');
    assert.deepEqual(firstRecovery.keys, ['tato-tracker-recovery-v1'], 'Il recupero crea piu copie dello stesso stato.');

    const secondCorruptReload = pageCdp.once('Page.loadEventFired');
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await secondCorruptReload;
    await waitForPage(pageCdp, `document.querySelectorAll('.goal-card').length >= 3`, 'secondo recupero stato corrotto');
    const secondRecoveryKeys = await evaluate(
      pageCdp,
      `Object.keys(localStorage).filter((key) => key.startsWith('tato-tracker-recovery-')).sort()`
    );
    assert.deepEqual(secondRecoveryKeys, firstRecovery.keys, 'Ogni reload aggiunge una nuova copia di recupero.');

    await delay(600);
    assert.deepEqual(pageErrors, [], `Errori pagina rilevati:\n${pageErrors.join('\n')}`);

    console.log(`PASS browser smoke (${path.basename(browserPath)} / ${version.Browser})`);
    console.log(`  viewport ${mobileLayout.innerWidth}x${mobileLayout.innerHeight}, scrollWidth ${mobileLayout.scrollWidth}`);
    console.log(`  demo ${dashboard.goalCards} obiettivi, tema ${theme.before} -> ${theme.after}`);
    console.log('  calendario 6x7 verificato su mese corrente, successivo e precedente');
    console.log('  Pomodoro, audio, SVG e storico giornaliero nel calendario verificati');
    console.log('  modale, obiettivi weekly/specific, export/import/reset e recupero localStorage verificati');
  } catch (error) {
    const exitDetail = browserExit
      ? `Browser terminato: codice ${browserExit.code}, segnale ${browserExit.signal || 'nessuno'}.`
      : 'Browser ancora attivo al momento dell\'errore.';
    const stderrDetail = browserStderr.trim() ? `\nBrowser stderr:\n${browserStderr.trim()}` : '';
    throw new Error(`${error.message}\n${exitDetail}${stderrDetail}`, { cause: error });
  } finally {
    pageCdp?.close();
    if (browserCdp) {
      await browserCdp.send('Browser.close', {}, 2_000).catch(() => {});
      browserCdp.close();
    }
    if (browserProcess && !(await waitForExit(browserProcess))) {
      browserProcess.kill();
      await waitForExit(browserProcess, 2_000);
    }
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(`FAIL browser smoke\n${error.stack || error.message}`);
  process.exitCode = 1;
});

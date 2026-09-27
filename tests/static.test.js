'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const potatoSvg = fs.readFileSync(path.join(root, 'potato-plant.svg'), 'utf8');
const appScript = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const pomodoroScript = fs.readFileSync(path.join(root, 'pomodoro.js'), 'utf8');
const studyLogScript = fs.readFileSync(path.join(root, 'study-log.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

test('document includes the core accessibility landmarks', () => {
  assert.match(html, /<html\s+lang="it"/i);
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"/i);
  assert.match(html, /class="skip-link"[^>]+href="#main-content"/i);
  assert.match(html, /<main\s+id="main-content"/i);
  assert.match(html, /aria-live="polite"/i);
});

test('static ids are unique', () => {
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);
});

test('all local static assets referenced by the page exist', () => {
  const references = Array.from(html.matchAll(/(?:src|href)="([^"#][^"]*)"/g), (match) => match[1])
    .filter((reference) => !reference.includes('://'));
  const missing = references.filter((reference) => !fs.existsSync(path.join(root, reference.split(/[?#]/)[0])));
  assert.deepEqual(missing, []);
});

test('dialogs and icon-only buttons have accessible names', () => {
  const dialogs = Array.from(html.matchAll(/<dialog\b[^>]*>/g), (match) => match[0]);
  assert.ok(dialogs.length >= 3);
  dialogs.forEach((dialog) => assert.match(dialog, /aria-labelledby="[^"]+"/));

  const iconButtons = Array.from(html.matchAll(/<button\s+class="icon-button[^"]*"[^>]*>/g), (match) => match[0]);
  assert.ok(iconButtons.length > 0);
  iconButtons.forEach((button) => assert.match(button, /aria-label="[^"]+"/));
});

test('goal form exposes weekly and specific-date scheduling modes', () => {
  assert.match(html, /name="scheduleMode"\s+value="weekly"/);
  assert.match(html, /name="scheduleMode"\s+value="specific"/);
  assert.match(html, /id="specific-date-picker"[^>]+role="group"/);
});

test('Pomodoro view exposes timer controls, labelled settings and an SVG plant', () => {
  assert.match(html, /<main[^>]+id="pomodoro-view"[^>]+aria-labelledby="pomodoro-title"/s);
  assert.match(html, /id="timer-countdown"[^>]+aria-label="[^"]+"/s);
  assert.match(html, /id="pomodoro-settings"[^>]+aria-labelledby="pomodoro-settings-title"/s);
  assert.match(html, /for="pomodoro-sessions"/);
  assert.match(html, /for="pomodoro-focus"/);
  assert.match(html, /for="pomodoro-break"/);
  assert.match(html, /id="daily-study-time"/);
  assert.match(html, /id="daily-study-message"[^>]+aria-live="polite"/);
  assert.match(html, /id="daily-study-sessions"/);
  assert.match(html, /class="potato-root"/);
  assert.match(html, /class="potato-sprout"/);
  assert.match(html, /<audio[^>]+id="pomodoro-alarm"[^>]+src="snd_flowery_voiceclip_jarona1\.mp3"[^>]+preload="auto"/s);
  assert.match(html, /id="pomodoro-timeout-notification"[^>]+role="alert"[^>]+aria-live="assertive"[^>]+aria-atomic="true"[^>]+hidden/s);
  assert.match(html, /id="timer-test-notification"[^>]+type="button"/s);
  assert.match(html, /class="potato-stem"/);
  assert.equal((html.match(/class="potato-branch"/g) || []).length, 5);
  assert.ok(
    html.indexOf('class="soil-surface"') < html.indexOf('class="potato-sprout"'),
    'Il germoglio deve essere disegnato davanti alla superficie del terreno.'
  );
  assert.ok(fs.existsSync(path.join(root, 'potato-plant.svg')));
  assert.match(potatoSvg, /<svg[^>]+viewBox="0 0 520 420"/);
  assert.match(potatoSvg, /aria-labelledby="title description"/);
});

test('shared study log loads before planner and Pomodoro interfaces', () => {
  const logScriptIndex = html.indexOf('src="study-log.js"');
  assert.ok(logScriptIndex > 0);
  assert.ok(logScriptIndex < html.indexOf('src="app.js"'));
  assert.ok(logScriptIndex < html.indexOf('src="pomodoro.js"'));
  assert.match(studyLogScript, /tato-tracker-study-log-v1/);
});

test('Pomodoro copy is technical and keeps the requested completion phrase', () => {
  const removedCopy = [
    'Il tuo ritmo',
    'Una pausa rigenerante',
    'Prossimi passi',
    'Quando vuoi',
    'Concentrati su una cosa sola',
    'recupera energie',
    'lascia riposare gli occhi',
    'aspettano di crescere',
    'cercano spazio nella terra',
    'stanno crescendo nuove patate',
    'si prepara a spuntare',
    'sta emergendo dalla terra'
  ];
  const pomodoroCopy = `${html.slice(html.indexOf('id="pomodoro-view"'), html.indexOf('<footer'))}\n${pomodoroScript}`;
  removedCopy.forEach((phrase) => assert.doesNotMatch(pomodoroCopy, new RegExp(phrase, 'i')));
  assert.match(pomodoroScript, /Tato \\u00e8 spuntato\./);
});

test('Pomodoro schedules updates on real second boundaries', () => {
  assert.doesNotMatch(pomodoroScript, /setInterval\s*\(/);
  assert.match(pomodoroScript, /millisecondsUntilNextTick/);
});

test('goal cards expose a computed percentage without changing persisted data', () => {
  assert.match(appScript, /const rounded = Math\.round\(stats\.completionPercent\)/);
  assert.match(appScript, /class="goal-card-percent"[^>]*>\$\{rounded\}%/);
  assert.match(appScript, /class="goal-card-progress" role="progressbar"[\s\S]*?aria-valuenow="\$\{rounded\}"/);
  assert.doesNotMatch(appScript, /goal\.completionPercent\s*=/);
});

test('Pomodoro alert and looping alarm cover every natural phase completion', () => {
  assert.match(pomodoroScript, /elements\.start\.addEventListener\('click',[\s\S]*?primeAlarm\(\)/);
  assert.match(pomodoroScript, /const ATTENTION_DURATION_MS = 6000;/);
  assert.match(pomodoroScript, /if \(result\.transitions\.length\) \{\s*showTimeoutNotification/);
  assert.match(pomodoroScript, /elements\.alarm\.loop = true;/);
  assert.match(pomodoroScript, /window\.setTimeout\(hideTimeoutNotification, ATTENTION_DURATION_MS\)/);
  assert.match(pomodoroScript, /elements\.testNotification\.addEventListener\('click', \(\) => \{\s*showTimeoutNotification\(null, \{\s*title: 'Test notifica'/);
  assert.match(styles, /\.pomodoro-timeout-notification \{[\s\S]*?inset: 0;[\s\S]*?animation: pomodoro-attention-backdrop 1200ms/);
  assert.match(styles, /\.pomodoro-timeout-copy strong \{[\s\S]*?font-size: clamp\(3\.2rem, 8vw, 6\.8rem\)/);
  assert.match(styles, /@keyframes pomodoro-attention-backdrop/);
  assert.match(styles, /@keyframes pomodoro-attention-card/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.pomodoro-timeout-card \{\s*animation: none;/);
});

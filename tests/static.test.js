'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

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
  const missing = references.filter((reference) => !fs.existsSync(path.join(root, reference.split('?')[0])));
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

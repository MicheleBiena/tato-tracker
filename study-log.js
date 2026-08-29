(function installTatoStudyLog(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TatoStudyLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createStudyLogApi() {
  'use strict';

  const STORAGE_KEY = 'tato-tracker-study-log-v1';
  const VERSION = 1;

  function emptyLog() {
    return { version: VERSION, events: [] };
  }

  function dateKeyAt(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function normalizeEvent(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const completedAt = Math.trunc(Number(candidate.completedAt));
    const durationSeconds = Math.trunc(Number(candidate.durationSeconds));
    const session = Math.max(1, Math.trunc(Number(candidate.session) || 1));
    if (!Number.isFinite(completedAt) || completedAt <= 0) return null;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 10_800) return null;
    const fallbackId = `focus-${completedAt}-${session}-${durationSeconds}`;
    const id = String(candidate.id || fallbackId).slice(0, 180);
    return { id, completedAt, durationSeconds, session };
  }

  function normalize(candidate) {
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    const events = [];
    const ids = new Set();
    for (const candidateEvent of Array.isArray(source.events) ? source.events : []) {
      const event = normalizeEvent(candidateEvent);
      if (!event || ids.has(event.id)) continue;
      ids.add(event.id);
      events.push(event);
    }
    events.sort((left, right) => left.completedAt - right.completedAt || left.id.localeCompare(right.id));
    return { version: VERSION, events };
  }

  function addEvents(candidate, candidateEvents) {
    const log = normalize(candidate);
    const ids = new Set(log.events.map((event) => event.id));
    const added = [];
    for (const candidateEvent of Array.isArray(candidateEvents) ? candidateEvents : []) {
      const event = normalizeEvent(candidateEvent);
      if (!event || ids.has(event.id)) continue;
      ids.add(event.id);
      log.events.push(event);
      added.push(event);
    }
    if (added.length) {
      log.events.sort((left, right) => left.completedAt - right.completedAt || left.id.localeCompare(right.id));
    }
    return { log, added };
  }

  function summarizeByDate(candidate) {
    const summaries = {};
    for (const event of normalize(candidate).events) {
      const dateKey = dateKeyAt(event.completedAt);
      if (!dateKey) continue;
      if (!summaries[dateKey]) summaries[dateKey] = { seconds: 0, sessions: 0 };
      summaries[dateKey].seconds += event.durationSeconds;
      summaries[dateKey].sessions += 1;
    }
    return summaries;
  }

  function summaryForDate(candidate, dateKey) {
    const summary = summarizeByDate(candidate)[dateKey];
    return summary ? { ...summary } : { seconds: 0, sessions: 0 };
  }

  function formatDuration(seconds, compact) {
    const totalMinutes = Math.max(0, Math.floor(Number(seconds) / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (compact) {
      if (hours && minutes) return `${hours}h ${minutes}m`;
      if (hours) return `${hours}h`;
      return `${minutes}m`;
    }
    if (hours && minutes) return `${hours} ${hours === 1 ? 'ora' : 'ore'} e ${minutes} min`;
    if (hours) return `${hours} ${hours === 1 ? 'ora' : 'ore'}`;
    return `${minutes} min`;
  }

  function load(storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? normalize(JSON.parse(raw)) : emptyLog();
    } catch (_) {
      return emptyLog();
    }
  }

  function save(candidate, storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalize(candidate)));
      return true;
    } catch (_) {
      return false;
    }
  }

  return Object.freeze({
    STORAGE_KEY,
    emptyLog,
    normalize,
    addEvents,
    dateKeyAt,
    summarizeByDate,
    summaryForDate,
    formatDuration,
    load,
    save
  });
});

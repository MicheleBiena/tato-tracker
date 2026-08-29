(function installTatoPomodoro(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TatoPomodoro = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPomodoroApi() {
  'use strict';

  const DEFAULT_CONFIG = Object.freeze({
    sessions: 4,
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakEnabled: true,
    longBreakEvery: 4,
    longBreakMinutes: 15
  });

  const PHASES = new Set(['focus', 'shortBreak', 'longBreak', 'complete']);

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  function normalizeConfig(candidate) {
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    return {
      sessions: clampInteger(source.sessions, 1, 24, DEFAULT_CONFIG.sessions),
      focusMinutes: clampInteger(source.focusMinutes, 1, 180, DEFAULT_CONFIG.focusMinutes),
      shortBreakMinutes: clampInteger(source.shortBreakMinutes, 1, 90, DEFAULT_CONFIG.shortBreakMinutes),
      longBreakEnabled: source.longBreakEnabled !== false,
      longBreakEvery: clampInteger(source.longBreakEvery, 2, 12, DEFAULT_CONFIG.longBreakEvery),
      longBreakMinutes: clampInteger(source.longBreakMinutes, 1, 120, DEFAULT_CONFIG.longBreakMinutes)
    };
  }

  function phaseDurationSeconds(config, phase) {
    const normalized = normalizeConfig(config);
    if (phase === 'focus') return normalized.focusMinutes * 60;
    if (phase === 'shortBreak') return normalized.shortBreakMinutes * 60;
    if (phase === 'longBreak') return normalized.longBreakMinutes * 60;
    return 0;
  }

  function createTimer(config) {
    const normalized = normalizeConfig(config);
    const totalSeconds = phaseDurationSeconds(normalized, 'focus');
    return {
      config: normalized,
      phase: 'focus',
      session: 1,
      completedSessions: 0,
      remainingSeconds: totalSeconds,
      remainingMilliseconds: totalSeconds * 1000,
      totalSeconds,
      running: false,
      endsAt: null
    };
  }

  function normalizeTimer(candidate, now) {
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    const config = normalizeConfig(source.config);
    const phase = PHASES.has(source.phase) ? source.phase : 'focus';
    if (phase === 'complete') {
      return {
        config,
        phase,
        session: config.sessions,
        completedSessions: config.sessions,
        remainingSeconds: 0,
        remainingMilliseconds: 0,
        totalSeconds: 0,
        running: false,
        endsAt: null
      };
    }

    const totalSeconds = phaseDurationSeconds(config, phase);
    const completedMaximum = phase === 'focus' ? config.sessions - 1 : config.sessions;
    const completedSessions = clampInteger(source.completedSessions, 0, completedMaximum, 0);
    const expectedSession = phase === 'focus'
      ? Math.min(config.sessions, completedSessions + 1)
      : Math.max(1, completedSessions);
    const session = clampInteger(source.session, 1, config.sessions, expectedSession);
    const legacyRemainingSeconds = clampInteger(source.remainingSeconds, 0, totalSeconds, totalSeconds);
    const storedRemainingMilliseconds = Number(source.remainingMilliseconds);
    const remainingMilliseconds = source.remainingMilliseconds != null
      && Number.isFinite(storedRemainingMilliseconds)
      ? Math.min(totalSeconds * 1000, Math.max(0, Math.trunc(storedRemainingMilliseconds)))
      : legacyRemainingSeconds * 1000;
    const remainingSeconds = Math.ceil(remainingMilliseconds / 1000);
    const running = source.running === true;
    const fallbackNow = Number.isFinite(now) ? now : Date.now();
    const storedEndsAt = Number(source.endsAt);
    const endsAt = running
      ? Number.isFinite(storedEndsAt) && storedEndsAt > 0
        ? storedEndsAt
        : fallbackNow + remainingMilliseconds
      : null;

    return {
      config,
      phase,
      session,
      completedSessions,
      remainingSeconds,
      remainingMilliseconds,
      totalSeconds,
      running,
      endsAt
    };
  }

  function advancePhase(candidate, options) {
    const settings = options || {};
    const at = Number.isFinite(settings.at) ? settings.at : Date.now();
    const timer = normalizeTimer(candidate, at);
    const keepRunning = settings.keepRunning == null ? timer.running : settings.keepRunning === true;

    if (timer.phase === 'complete') return timer;

    let phase;
    let session;
    let completedSessions = timer.completedSessions;

    if (timer.phase === 'focus') {
      completedSessions = Math.max(completedSessions, timer.session);
      if (completedSessions >= timer.config.sessions) {
        return normalizeTimer({ ...timer, phase: 'complete' }, at);
      }
      const needsLongBreak = timer.config.longBreakEnabled
        && completedSessions % timer.config.longBreakEvery === 0;
      phase = needsLongBreak ? 'longBreak' : 'shortBreak';
      session = completedSessions;
    } else {
      phase = 'focus';
      session = Math.min(timer.config.sessions, completedSessions + 1);
    }

    const totalSeconds = phaseDurationSeconds(timer.config, phase);
    return {
      config: timer.config,
      phase,
      session,
      completedSessions,
      remainingSeconds: totalSeconds,
      remainingMilliseconds: totalSeconds * 1000,
      totalSeconds,
      running: keepRunning,
      endsAt: keepRunning ? at + totalSeconds * 1000 : null
    };
  }

  function syncTimerWithEvents(candidate, now) {
    const currentTime = Number.isFinite(now) ? now : Date.now();
    let timer = normalizeTimer(candidate, currentTime);
    const events = [];
    const transitions = [];
    if (!timer.running || timer.phase === 'complete') return { timer, events, transitions };

    let guard = 0;
    while (timer.running && timer.phase !== 'complete' && timer.endsAt <= currentTime && guard < 100) {
      const nextPhaseStart = timer.endsAt;
      transitions.push({
        phase: timer.phase,
        session: timer.session,
        completedAt: nextPhaseStart,
        durationSeconds: timer.totalSeconds
      });
      if (timer.phase === 'focus') {
        events.push({
          id: `focus-${nextPhaseStart}-${timer.session}-${timer.totalSeconds}`,
          completedAt: nextPhaseStart,
          durationSeconds: timer.totalSeconds,
          session: timer.session
        });
      }
      timer = advancePhase(timer, { at: nextPhaseStart, keepRunning: true });
      guard += 1;
    }

    if (timer.phase === 'complete') return { timer, events, transitions };
    const remainingMilliseconds = Math.max(0, Math.min(
      timer.totalSeconds * 1000,
      timer.endsAt - currentTime
    ));
    return {
      timer: {
        ...timer,
        remainingSeconds: Math.ceil(remainingMilliseconds / 1000),
        remainingMilliseconds
      },
      events,
      transitions
    };
  }

  function syncTimer(candidate, now) {
    return syncTimerWithEvents(candidate, now).timer;
  }

  function millisecondsUntilNextTick(candidate, now) {
    const currentTime = Number.isFinite(now) ? now : Date.now();
    const timer = normalizeTimer(candidate, currentTime);
    if (!timer.running || timer.phase === 'complete') return null;
    const remainingMilliseconds = Math.max(0, timer.endsAt - currentTime);
    if (remainingMilliseconds === 0) return 0;
    const displayedSeconds = Math.ceil(remainingMilliseconds / 1000);
    return remainingMilliseconds - (displayedSeconds - 1) * 1000;
  }

  function startTimer(candidate, now) {
    const currentTime = Number.isFinite(now) ? now : Date.now();
    const timer = syncTimer(candidate, currentTime);
    if (timer.phase === 'complete' || timer.running) return timer;
    const remainingMilliseconds = timer.remainingMilliseconds > 0
      ? timer.remainingMilliseconds
      : timer.totalSeconds * 1000;
    return {
      ...timer,
      remainingSeconds: Math.ceil(remainingMilliseconds / 1000),
      remainingMilliseconds,
      running: true,
      endsAt: currentTime + remainingMilliseconds
    };
  }

  function pauseTimer(candidate, now) {
    const timer = syncTimer(candidate, Number.isFinite(now) ? now : Date.now());
    if (!timer.running) return timer;
    return { ...timer, running: false, endsAt: null };
  }

  function skipPhase(candidate, now) {
    const currentTime = Number.isFinite(now) ? now : Date.now();
    const timer = syncTimer(candidate, currentTime);
    return advancePhase(timer, { at: currentTime, keepRunning: timer.running });
  }

  function timerProgress(candidate) {
    const timer = normalizeTimer(candidate);
    if (timer.phase === 'complete') {
      return { phase: 1, overall: 1, root: 1, sprout: 1 };
    }
    const phaseProgress = timer.totalSeconds
      ? Math.max(0, Math.min(1, 1 - timer.remainingMilliseconds / (timer.totalSeconds * 1000)))
      : 0;
    const focusContribution = timer.phase === 'focus' ? phaseProgress : 0;
    const overall = Math.max(0, Math.min(1,
      (timer.completedSessions + focusContribution) / timer.config.sessions
    ));
    return {
      phase: phaseProgress,
      overall,
      root: Math.max(0, Math.min(1, overall / 0.72)),
      sprout: Math.max(0, Math.min(1, (overall - 0.68) / 0.32))
    };
  }

  function phaseLabel(phase) {
    if (phase === 'focus') return 'Concentrazione';
    if (phase === 'shortBreak') return 'Pausa breve';
    if (phase === 'longBreak') return 'Pausa lunga';
    return 'Ciclo completato';
  }

  return Object.freeze({
    DEFAULT_CONFIG,
    normalizeConfig,
    phaseDurationSeconds,
    createTimer,
    normalizeTimer,
    advancePhase,
    syncTimer,
    syncTimerWithEvents,
    millisecondsUntilNextTick,
    startTimer,
    pauseTimer,
    skipPhase,
    timerProgress,
    phaseLabel
  });
});

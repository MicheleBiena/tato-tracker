(function initPomodoroView() {
  'use strict';

  const Pomodoro = globalThis.TatoPomodoro;
  const StudyLog = globalThis.TatoStudyLog;
  if (!Pomodoro || !StudyLog) return;

  const STORAGE_KEY = 'tato-tracker-pomodoro-v1';
  const ATTENTION_DURATION_MS = 6000;
  const PLANNER_TITLE = 'Tato Tracker \u2014 Studio, con calma';
  const plannerView = document.querySelector('#main-content');
  const pomodoroView = document.querySelector('#pomodoro-view');
  const timerPanel = document.querySelector('.timer-panel');
  const settingsForm = document.querySelector('#pomodoro-settings');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  if (!plannerView || !pomodoroView || !timerPanel || !settingsForm) return;

  const elements = {
    skipLink: document.querySelector('.skip-link'),
    phase: document.querySelector('#timer-phase'),
    session: document.querySelector('#timer-session'),
    countdown: document.querySelector('#timer-countdown'),
    status: document.querySelector('#timer-status'),
    progress: document.querySelector('#timer-progress'),
    steps: document.querySelector('#session-steps'),
    start: document.querySelector('#timer-start'),
    skip: document.querySelector('#timer-skip'),
    reset: document.querySelector('#timer-reset'),
    testNotification: document.querySelector('#timer-test-notification'),
    alarm: document.querySelector('#pomodoro-alarm'),
    timeoutNotification: document.querySelector('#pomodoro-timeout-notification'),
    timeoutTitle: document.querySelector('#pomodoro-timeout-title'),
    timeoutDetail: document.querySelector('#pomodoro-timeout-detail'),
    plant: document.querySelector('#potato-plant'),
    plantDescription: document.querySelector('#potato-plant-description'),
    plantCaption: document.querySelector('#plant-caption'),
    announcer: document.querySelector('#pomodoro-announcer'),
    cyclePreview: document.querySelector('#cycle-preview'),
    formError: document.querySelector('#pomodoro-form-error'),
    longBreakEnabled: document.querySelector('#long-break-enabled'),
    longBreakFields: document.querySelector('#long-break-fields'),
    dailyStudyTime: document.querySelector('#daily-study-time'),
    dailyStudyMessage: document.querySelector('#daily-study-message'),
    dailyStudySessions: document.querySelector('#daily-study-sessions')
  };

  let studyLog = StudyLog.load(localStorage);
  let timer = loadTimer();
  let tickTimeout = 0;
  let lastRenderedSecond = null;
  let alarmPrimed = false;
  let timeoutNoticeTimer = 0;

  function loadTimer() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Pomodoro.createTimer();
      const parsed = JSON.parse(raw);
      const result = Pomodoro.syncTimerWithEvents(parsed.timer || parsed);
      recordCompletionEvents(result.events);
      return result.timer;
    } catch (_) {
      return Pomodoro.createTimer();
    }
  }

  function saveTimer() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, timer }));
      return true;
    } catch (_) {
      elements.status.textContent = 'Salvataggio locale non riuscito. Il timer continua a funzionare.';
      return false;
    }
  }

  function recordCompletionEvents(events) {
    const result = StudyLog.addEvents(studyLog, events);
    studyLog = result.log;
    if (!result.added.length) return 0;
    const saved = StudyLog.save(studyLog, localStorage);
    renderDailyStudy();
    if (!saved) return result.added.length;
    window.dispatchEvent(new CustomEvent('tato:pomodoro-study-updated', {
      detail: {
        dates: [...new Set(result.added.map((event) => StudyLog.dateKeyAt(event.completedAt)))]
      }
    }));
    return result.added.length;
  }

  function syncAndRecordTimer(now) {
    const result = Pomodoro.syncTimerWithEvents(timer, now);
    timer = result.timer;
    recordCompletionEvents(result.events);
    return result;
  }

  function formatCountdown(seconds) {
    const safe = Math.max(0, Math.trunc(seconds));
    const minutes = Math.floor(safe / 60);
    const remainder = safe % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  function durationLabel(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (!remainder) return `${minutes} ${minutes === 1 ? 'minuto' : 'minuti'}`;
    return `${minutes} ${minutes === 1 ? 'minuto' : 'minuti'} e ${remainder} secondi`;
  }

  function isoDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `PT${minutes ? `${minutes}M` : ''}${remainder || !minutes ? `${remainder}S` : ''}`;
  }

  function statusText() {
    if (timer.phase === 'complete') return 'Ciclo completato.';
    if (timer.phase === 'focus') {
      if (timer.running) return 'Sessione in corso.';
      if (phaseHasStarted()) return 'Timer in pausa.';
      return 'Timer pronto.';
    }
    if (timer.running) {
      return timer.phase === 'longBreak'
        ? 'Pausa lunga in corso.'
        : 'Pausa breve in corso.';
    }
    return 'Pausa pronta.';
  }

  function phaseHasStarted() {
    return timer.remainingMilliseconds < timer.totalSeconds * 1000;
  }

  function plantCaption(progress) {
    if (timer.phase === 'complete') return 'Tato \u00e8 spuntato.';
    return `Crescita radici: ${Math.round(progress.root * 100)}% \u00b7 germoglio: ${Math.round(progress.sprout * 100)}%`;
  }

  function renderSessionSteps() {
    const { sessions } = timer.config;
    elements.steps.innerHTML = Array.from({ length: sessions }, (_, index) => {
      const number = index + 1;
      const complete = number <= timer.completedSessions;
      const current = timer.phase === 'focus' && number === timer.session && !complete;
      const state = complete ? 'completata' : current ? 'in corso' : 'da fare';
      return `<li class="${complete ? 'is-complete' : ''} ${current ? 'is-current' : ''}" aria-label="Sessione ${number}, ${state}"><span aria-hidden="true">${number}</span></li>`;
    }).join('');
  }

  function renderCyclePreview() {
    const config = timer.config;
    const breakSlots = Math.max(0, config.sessions - 1);
    const longBreaks = config.longBreakEnabled
      ? Math.floor(breakSlots / config.longBreakEvery)
      : 0;
    const shortBreaks = Math.max(0, breakSlots - longBreaks);
    const totalMinutes = config.sessions * config.focusMinutes
      + shortBreaks * config.shortBreakMinutes
      + longBreaks * config.longBreakMinutes;
    const longBreakText = config.longBreakEnabled
      ? `Pausa lunga da ${config.longBreakMinutes} min ogni ${config.longBreakEvery} sessioni`
      : 'Pause lunghe disattivate';
    elements.cyclePreview.innerHTML = `
      <li><span>${config.sessions}\u00d7</span><p><strong>Sessioni di concentrazione</strong>${config.focusMinutes} min ciascuna</p></li>
      <li><span>${shortBreaks}</span><p><strong>Pause brevi</strong>${config.shortBreakMinutes} min ciascuna</p></li>
      <li><span>${longBreaks}</span><p><strong>Pause lunghe</strong>${longBreakText}</p></li>
      <li><span>\u03a3</span><p><strong>Durata totale</strong>${totalMinutes} min</p></li>`;
  }

  function renderSettings() {
    const config = timer.config;
    settingsForm.elements.sessions.value = config.sessions;
    settingsForm.elements.focusMinutes.value = config.focusMinutes;
    settingsForm.elements.shortBreakMinutes.value = config.shortBreakMinutes;
    settingsForm.elements.longBreakEnabled.checked = config.longBreakEnabled;
    settingsForm.elements.longBreakEvery.value = config.longBreakEvery;
    settingsForm.elements.longBreakMinutes.value = config.longBreakMinutes;
    updateLongBreakFields();
    renderCyclePreview();
  }

  function renderDailyStudy() {
    const today = StudyLog.dateKeyAt(Date.now());
    const summary = StudyLog.summaryForDate(studyLog, today);
    const duration = StudyLog.formatDuration(summary.seconds);
    elements.dailyStudyTime.value = duration;
    elements.dailyStudyTime.textContent = duration;
    elements.dailyStudyMessage.textContent = summary.sessions
      ? `Oggi hai tato-alizzato ${duration} di studio! Vai cos\u00ec!`
      : 'Completa una sessione di concentrazione per iniziare il conteggio di oggi.';
    elements.dailyStudySessions.textContent = summary.sessions === 1
      ? '1 sessione completata'
      : `${summary.sessions} sessioni completate`;
  }

  function renderTimer(force) {
    const remaining = timer.remainingSeconds;
    if (!force && remaining === lastRenderedSecond) return;
    lastRenderedSecond = remaining;
    const progress = Pomodoro.timerProgress(timer);
    const phasePercent = Math.round(progress.phase * 100);
    const completedOnly = timer.completedSessions / timer.config.sessions;
    const visualOverall = reduceMotion.matches ? completedOnly : progress.overall;
    const rootGrowth = Math.max(0, Math.min(1, visualOverall / 0.72));
    const sproutGrowth = Math.max(0, Math.min(1, (visualOverall - 0.68) / 0.32));
    const phaseLabel = Pomodoro.phaseLabel(timer.phase);

    timerPanel.dataset.phase = timer.phase;
    elements.phase.textContent = phaseLabel;
    elements.session.textContent = timer.phase === 'complete'
      ? `${timer.config.sessions} sessioni completate`
      : timer.phase === 'focus'
        ? `Sessione ${timer.session} di ${timer.config.sessions}`
        : `Dopo la sessione ${timer.completedSessions} di ${timer.config.sessions}`;
    elements.countdown.textContent = formatCountdown(remaining);
    elements.countdown.dateTime = isoDuration(remaining);
    elements.countdown.setAttribute('aria-label', `${durationLabel(remaining)} rimanenti`);
    elements.status.textContent = statusText();
    elements.progress.style.setProperty('--phase-progress', timer.phase === 'complete' ? 1 : progress.phase.toFixed(4));
    elements.progress.setAttribute('aria-valuenow', timer.phase === 'complete' ? '100' : String(phasePercent));
    elements.progress.setAttribute('aria-valuetext', `${phasePercent}% di ${phaseLabel.toLowerCase()}`);
    elements.plant.style.setProperty('--root-growth', rootGrowth.toFixed(4));
    elements.plant.style.setProperty('--sprout-growth', sproutGrowth.toFixed(4));
    elements.plantCaption.textContent = plantCaption(progress);
    elements.plantDescription.textContent = `${elements.plantCaption.textContent} ${Math.round(progress.overall * 100)} percento del ciclo completato.`;

    const startLabel = timer.phase === 'complete'
      ? 'Nuovo ciclo'
      : timer.running
        ? 'Pausa'
        : phaseHasStarted()
          ? 'Riprendi'
          : 'Avvia';
    elements.start.querySelector('span').textContent = startLabel;
    elements.start.querySelector('use').setAttribute('href', timer.running ? '#icon-pause' : '#icon-play');
    elements.start.setAttribute('aria-label', timer.running ? 'Metti in pausa il timer' : `${startLabel} il timer`);
    elements.skip.disabled = timer.phase === 'complete';
    renderSessionSteps();

    if (!pomodoroView.hidden) {
      document.title = timer.phase === 'complete'
        ? `Ciclo completato \u2014 Tato Tracker`
        : `${formatCountdown(remaining)} \u00b7 ${phaseLabel} \u2014 Tato Tracker`;
    }
  }

  function announce(message) {
    elements.announcer.textContent = '';
    requestAnimationFrame(() => { elements.announcer.textContent = message; });
  }

  function resetAlarmPlayback() {
    if (!elements.alarm) return;
    elements.alarm.pause();
    elements.alarm.currentTime = 0;
  }

  function primeAlarm() {
    if (!elements.alarm || alarmPrimed) return;
    alarmPrimed = true;
    elements.alarm.loop = false;
    elements.alarm.muted = true;
    const playback = elements.alarm.play();
    if (!playback?.then) {
      resetAlarmPlayback();
      elements.alarm.muted = false;
      return;
    }
    playback.then(() => {
      resetAlarmPlayback();
      elements.alarm.muted = false;
    }).catch(() => {
      elements.alarm.muted = false;
      alarmPrimed = false;
    });
  }

  function stopAlarm() {
    if (!elements.alarm) return;
    elements.alarm.loop = false;
    resetAlarmPlayback();
  }

  function playAlarmLoop() {
    if (!elements.alarm) return;
    resetAlarmPlayback();
    elements.alarm.loop = true;
    elements.alarm.muted = false;
    const playback = elements.alarm.play();
    playback?.catch(() => {});
  }

  function completionNoticeCopy(transition) {
    if (transition.phase === 'focus') {
      return {
        title: 'Sessione terminata',
        detail: timer.phase === 'complete'
          ? 'Ciclo completato.'
          : `${Pomodoro.phaseLabel(timer.phase)} pronta.`
      };
    }
    return {
      title: 'Pausa terminata',
      detail: `Sessione ${timer.session} pronta.`
    };
  }

  function hideTimeoutNotification() {
    clearTimeout(timeoutNoticeTimer);
    timeoutNoticeTimer = 0;
    if (elements.timeoutNotification) elements.timeoutNotification.hidden = true;
    stopAlarm();
  }

  function showTimeoutNotification(transition, customCopy) {
    if ((!transition && !customCopy) || !elements.timeoutNotification) return;
    const copy = customCopy || completionNoticeCopy(transition);
    clearTimeout(timeoutNoticeTimer);
    elements.timeoutNotification.hidden = true;
    elements.timeoutTitle.textContent = copy.title;
    elements.timeoutDetail.textContent = copy.detail;
    void elements.timeoutNotification.offsetWidth;
    elements.timeoutNotification.hidden = false;
    playAlarmLoop();
    timeoutNoticeTimer = window.setTimeout(hideTimeoutNotification, ATTENTION_DURATION_MS);
  }

  function updateTicking() {
    clearTimeout(tickTimeout);
    tickTimeout = 0;
    if (!timer.running || timer.phase === 'complete' || document.hidden) return;
    const boundaryDelay = Pomodoro.millisecondsUntilNextTick(timer);
    tickTimeout = window.setTimeout(tick, Math.max(8, boundaryDelay + 8));
  }

  function tick() {
    clearTimeout(tickTimeout);
    tickTimeout = 0;
    const previousPhase = timer.phase;
    const previousSession = timer.session;
    const result = syncAndRecordTimer();
    const changedPhase = timer.phase !== previousPhase || timer.session !== previousSession;
    if (result.transitions.length) {
      showTimeoutNotification(result.transitions.at(-1));
      saveTimer();
      announce(timer.phase === 'complete'
        ? 'Ciclo Pomodoro completato.'
        : `${Pomodoro.phaseLabel(timer.phase)}. ${statusText()}`);
    }
    renderTimer(changedPhase);
    updateTicking();
  }

  function updateLongBreakFields() {
    const enabled = elements.longBreakEnabled.checked;
    elements.longBreakFields.hidden = !enabled;
    elements.longBreakFields.querySelectorAll('input').forEach((input) => {
      input.disabled = !enabled;
    });
  }

  function validateSettings() {
    const fields = [
      settingsForm.elements.sessions,
      settingsForm.elements.focusMinutes,
      settingsForm.elements.shortBreakMinutes,
      ...(elements.longBreakEnabled.checked
        ? [settingsForm.elements.longBreakEvery, settingsForm.elements.longBreakMinutes]
        : [])
    ];
    fields.forEach((field) => field.removeAttribute('aria-invalid'));
    const invalid = fields.find((field) => {
      const value = Number(field.value);
      return !Number.isInteger(value) || value < Number(field.min) || value > Number(field.max);
    });
    if (!invalid) {
      elements.formError.textContent = '';
      return true;
    }
    invalid.setAttribute('aria-invalid', 'true');
    elements.formError.textContent = `Inserisci un numero intero tra ${invalid.min} e ${invalid.max}.`;
    invalid.focus();
    return false;
  }

  function configFromForm() {
    return Pomodoro.normalizeConfig({
      sessions: settingsForm.elements.sessions.value,
      focusMinutes: settingsForm.elements.focusMinutes.value,
      shortBreakMinutes: settingsForm.elements.shortBreakMinutes.value,
      longBreakEnabled: elements.longBreakEnabled.checked,
      longBreakEvery: settingsForm.elements.longBreakEvery.value,
      longBreakMinutes: settingsForm.elements.longBreakMinutes.value
    });
  }

  function setNavigationState(hash) {
    const pomodoroActive = hash === '#pomodoro-view';
    const effectiveHash = hash && hash !== '#main-content' ? hash : '#today-section';
    document.querySelectorAll('.desktop-nav a, .mobile-nav a').forEach((link) => {
      const linkHash = new URL(link.href, location.href).hash;
      const active = pomodoroActive
        ? linkHash === '#pomodoro-view'
        : linkHash === effectiveHash;
      link.classList.toggle('active', active);
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function activateHash(hash, options) {
    const settings = options || {};
    const pomodoroActive = hash === '#pomodoro-view';
    plannerView.hidden = pomodoroActive;
    pomodoroView.hidden = !pomodoroActive;
    document.body.dataset.view = pomodoroActive ? 'pomodoro' : 'planner';
    elements.skipLink.href = pomodoroActive ? '#pomodoro-view' : '#main-content';
    setNavigationState(hash);
    renderTimer(true);
    renderDailyStudy();

    if (!pomodoroActive) document.title = PLANNER_TITLE;
    const target = document.querySelector(hash || '#main-content');
    if (settings.scroll !== false && target) {
      requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    }
    if (settings.focus === true) {
      requestAnimationFrame(() => (pomodoroActive ? pomodoroView : plannerView).focus());
    }
  }

  function navigateTo(hash, options) {
    if (location.hash !== hash) history.pushState(null, '', hash);
    activateHash(hash, {
      focus: options?.focus === true || hash === '#pomodoro-view',
      scroll: true
    });
  }

  elements.start.addEventListener('click', () => {
    primeAlarm();
    syncAndRecordTimer();
    if (timer.phase === 'complete') timer = Pomodoro.createTimer(timer.config);
    timer = timer.running ? Pomodoro.pauseTimer(timer) : Pomodoro.startTimer(timer);
    saveTimer();
    renderTimer(true);
    updateTicking();
    announce(timer.running ? `${Pomodoro.phaseLabel(timer.phase)} avviata.` : 'Timer in pausa.');
  });

  elements.skip.addEventListener('click', () => {
    syncAndRecordTimer();
    const previousPhase = timer.phase;
    timer = Pomodoro.skipPhase(timer);
    saveTimer();
    renderTimer(true);
    updateTicking();
    announce(`${Pomodoro.phaseLabel(previousPhase)} saltata. ${Pomodoro.phaseLabel(timer.phase)}.`);
  });

  elements.reset.addEventListener('click', () => {
    syncAndRecordTimer();
    timer = Pomodoro.createTimer(timer.config);
    saveTimer();
    renderTimer(true);
    updateTicking();
    announce('Ciclo Pomodoro reimpostato alla sessione 1.');
  });

  elements.testNotification.addEventListener('click', () => {
    showTimeoutNotification(null, {
      title: 'Test notifica',
      detail: 'Suono e avviso attivi per 6 secondi.'
    });
  });

  elements.longBreakEnabled.addEventListener('change', updateLongBreakFields);

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!validateSettings()) return;
    syncAndRecordTimer();
    timer = Pomodoro.createTimer(configFromForm());
    saveTimer();
    renderSettings();
    renderTimer(true);
    updateTicking();
    announce('Impostazioni applicate. Ciclo reimpostato alla sessione 1.');
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const hash = new URL(link.href, location.href).hash;
    if (!['#main-content', '#today-section', '#calendar-section', '#goals-section', '#pomodoro-view'].includes(hash)) return;
    event.preventDefault();
    navigateTo(hash, { focus: link.classList.contains('skip-link') });
  });

  window.addEventListener('popstate', () => {
    activateHash(location.hash || '#today-section', { scroll: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideTimeoutNotification();
      updateTicking();
    }
    else tick();
  });
  window.addEventListener('tato:pomodoro-study-updated', () => {
    studyLog = StudyLog.load(localStorage);
    renderDailyStudy();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== StudyLog.STORAGE_KEY) return;
    studyLog = StudyLog.load(localStorage);
    renderDailyStudy();
  });
  reduceMotion.addEventListener?.('change', () => renderTimer(true));
  window.addEventListener('pagehide', () => {
    hideTimeoutNotification();
    syncAndRecordTimer();
    saveTimer();
  });

  saveTimer();
  renderSettings();
  renderDailyStudy();
  renderTimer(true);
  updateTicking();
  activateHash(location.hash || '#today-section', { scroll: false });
})();

(function initPomodoroView() {
  'use strict';

  const Pomodoro = globalThis.TatoPomodoro;
  if (!Pomodoro) return;

  const STORAGE_KEY = 'tato-tracker-pomodoro-v1';
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
    plant: document.querySelector('#potato-plant'),
    plantDescription: document.querySelector('#potato-plant-description'),
    plantCaption: document.querySelector('#plant-caption'),
    announcer: document.querySelector('#pomodoro-announcer'),
    cyclePreview: document.querySelector('#cycle-preview'),
    formError: document.querySelector('#pomodoro-form-error'),
    longBreakEnabled: document.querySelector('#long-break-enabled'),
    longBreakFields: document.querySelector('#long-break-fields')
  };

  let timer = loadTimer();
  let tickInterval = 0;
  let lastRenderedSecond = null;

  function loadTimer() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Pomodoro.createTimer();
      const parsed = JSON.parse(raw);
      return Pomodoro.syncTimer(parsed.timer || parsed);
    } catch (_) {
      return Pomodoro.createTimer();
    }
  }

  function saveTimer() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, timer }));
      return true;
    } catch (_) {
      elements.status.textContent = 'Il timer continua, ma non riesco a salvarlo sul dispositivo.';
      return false;
    }
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
    if (timer.phase === 'complete') return 'Ciclo completato. Le radici sono forti e il germoglio \u00e8 spuntato.';
    if (timer.phase === 'focus') {
      if (timer.running) return 'Concentrati su una cosa sola. Tato tiene il tempo per te.';
      if (timer.remainingSeconds < timer.totalSeconds) return 'Timer in pausa. Riprendi quando sei pronto.';
      return 'Quando vuoi, avvia questa sessione di concentrazione.';
    }
    if (timer.running) {
      return timer.phase === 'longBreak'
        ? 'Pausa lunga: allontanati dallo schermo e recupera energie.'
        : 'Pausa breve: respira, muoviti un po\u2019 e lascia riposare gli occhi.';
    }
    return 'La pausa \u00e8 pronta. Avviala quando vuoi.';
  }

  function plantCaption(progress) {
    if (timer.phase === 'complete') return 'Tato \u00e8 spuntato: ciclo completato.';
    if (progress.overall <= 0) return 'Le prime radici aspettano di crescere.';
    if (progress.overall < 0.26) return 'Le radici cercano spazio nella terra.';
    if (progress.overall < 0.68) return 'Sotto terra stanno crescendo nuove patate.';
    if (progress.sprout < 0.5) return 'Il germoglio si prepara a spuntare.';
    return 'La pianta sta emergendo dalla terra.';
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
      <li><span>\u2248</span><p><strong>Durata complessiva</strong>Circa ${totalMinutes} min</p></li>`;
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
        : timer.remainingSeconds < timer.totalSeconds
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

  function updateTicking() {
    clearInterval(tickInterval);
    tickInterval = 0;
    if (timer.running && timer.phase !== 'complete') {
      tickInterval = window.setInterval(tick, 400);
    }
  }

  function tick() {
    const previousPhase = timer.phase;
    const previousSession = timer.session;
    timer = Pomodoro.syncTimer(timer);
    const changedPhase = timer.phase !== previousPhase || timer.session !== previousSession;
    if (changedPhase) {
      saveTimer();
      announce(timer.phase === 'complete'
        ? 'Ciclo Pomodoro completato.'
        : `${Pomodoro.phaseLabel(timer.phase)}. ${statusText()}`);
    }
    renderTimer(changedPhase);
    if (!timer.running) updateTicking();
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
    if (timer.phase === 'complete') timer = Pomodoro.createTimer(timer.config);
    timer = timer.running ? Pomodoro.pauseTimer(timer) : Pomodoro.startTimer(timer);
    saveTimer();
    renderTimer(true);
    updateTicking();
    announce(timer.running ? `${Pomodoro.phaseLabel(timer.phase)} avviata.` : 'Timer in pausa.');
  });

  elements.skip.addEventListener('click', () => {
    const previousPhase = timer.phase;
    timer = Pomodoro.skipPhase(timer);
    saveTimer();
    renderTimer(true);
    updateTicking();
    announce(`${Pomodoro.phaseLabel(previousPhase)} saltata. ${Pomodoro.phaseLabel(timer.phase)}.`);
  });

  elements.reset.addEventListener('click', () => {
    timer = Pomodoro.createTimer(timer.config);
    saveTimer();
    renderTimer(true);
    updateTicking();
    announce('Ciclo Pomodoro riportato alla prima sessione.');
  });

  elements.longBreakEnabled.addEventListener('change', updateLongBreakFields);

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!validateSettings()) return;
    timer = Pomodoro.createTimer(configFromForm());
    saveTimer();
    renderSettings();
    renderTimer(true);
    updateTicking();
    announce('Nuove impostazioni applicate. Il ciclo riparte dalla prima sessione.');
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
    if (!document.hidden) tick();
  });
  reduceMotion.addEventListener?.('change', () => renderTimer(true));
  window.addEventListener('pagehide', saveTimer);

  saveTimer();
  renderSettings();
  renderTimer(true);
  updateTicking();
  activateHash(location.hash || '#today-section', { scroll: false });
})();

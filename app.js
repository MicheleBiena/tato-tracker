(function initTatoTracker() {
  "use strict";

  const Planner = globalThis.TatoPlanner;
  const StudyLog = globalThis.TatoStudyLog;
  if (!Planner || !StudyLog) {
    document.body.innerHTML =
      '<div class="noscript">Non riesco ad avviare il pianificatore. Ricarica la pagina.</div>';
    return;
  }

  const STORAGE_KEY = "tato-tracker-state-v1";
  const RECOVERY_KEY = "tato-tracker-recovery-v1";
  const THEME_KEY = "tato-tracker-theme";
  const SCHEMA_VERSION = 1;
  const COLORS = ["#5E8C72", "#D47B62", "#7A75A8", "#C08A3E", "#4F8291"];
  const numberFormatter = new Intl.NumberFormat("it-IT");
  const monthFormatter = new Intl.DateTimeFormat("it-IT", {
    month: "long",
    year: "numeric",
  });
  const fullDateFormatter = new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const longDateFormatter = new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const shortDateFormatter = new Intl.DateTimeFormat("it-IT", {
    day: "numeric",
    month: "short",
  });

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));

  const elements = {
    themeToggle: $("#theme-toggle"),
    todayLabel: $("#today-label"),
    greeting: $("#greeting"),
    heroSummary: $("#hero-summary"),
    autoRedistribute: $("#auto-redistribute"),
    todayList: $("#today-list"),
    calendarGrid: $("#calendar-grid"),
    calendarMonth: $("#calendar-month"),
    goalsList: $("#goals-list"),
    subjectProgress: $("#subject-progress"),
    goalDialog: $("#goal-dialog"),
    goalForm: $("#goal-form"),
    dayDialog: $("#day-dialog"),
    dayForm: $("#day-form"),
    confirmDialog: $("#confirm-dialog"),
    toast: $("#toast"),
    importFile: $("#import-file"),
  };

  let loadNotice = "";
  let loadFailed = false;
  let state = loadState();
  let studyLog = StudyLog.load(localStorage);
  let calendarCursor = firstOfMonth(Planner.todayKey());
  let specificDateSelection = new Set();
  let specificSelectionInitialized = false;
  let toastTimer = 0;
  let confirmResolver = null;

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : COLORS[0];
  }

  function canonicalRuleMode(rule) {
    const mode = rule && typeof rule === "object" ? rule.mode : rule;
    if (mode === "free") return "off";
    if (mode === "available" || mode === "work") return "study";
    return mode;
  }

  function plural(value, singular, pluralForm) {
    return `${numberFormatter.format(value)} ${value === 1 ? singular : pluralForm}`;
  }

  function firstOfMonth(dateKey) {
    const date = Planner.parseDateKey(dateKey);
    return Planner.toDateKey(new Date(date.getFullYear(), date.getMonth(), 1));
  }

  function shiftMonth(dateKey, amount) {
    const date = Planner.parseDateKey(dateKey);
    date.setMonth(date.getMonth() + amount, 1);
    return Planner.toDateKey(date);
  }

  function dayDistance(fromKey, toKey) {
    const from = Planner.parseDateKey(fromKey);
    const to = Planner.parseDateKey(toKey);
    const fromUtc = Date.UTC(
      from.getFullYear(),
      from.getMonth(),
      from.getDate(),
    );
    const toUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((toUtc - fromUtc) / 86400000);
  }

  function dateInGoal(goal, dateKey) {
    return dateKey >= goal.startDate && dateKey <= goal.endDate;
  }

  function dateKeysInRange(startDate, endDate, maxDays = 731) {
    if (!startDate || !endDate || startDate > endDate) return [];
    try {
      Planner.parseDateKey(startDate);
      Planner.parseDateKey(endDate);
    } catch (_) {
      return [];
    }
    const dates = [];
    let cursor = startDate;
    while (cursor <= endDate && dates.length <= maxDays) {
      dates.push(cursor);
      cursor = Planner.addDaysKey(cursor, 1);
    }
    return dates;
  }

  function selectedWeekdays() {
    return $$('input[name="studyDays"]:checked', elements.goalForm).map(
      (input) => Number(input.value),
    );
  }

  function seedSpecificDatesFromWeekdays() {
    const startDate = $("#goal-start").value;
    const endDate = $("#goal-due").value;
    const weekdays = selectedWeekdays();
    specificDateSelection = new Set(
      dateKeysInRange(startDate, endDate).filter((date) =>
        weekdays.includes(Planner.parseDateKey(date).getDay()),
      ),
    );
    specificSelectionInitialized = true;
  }

  function updateSpecificDateSummary() {
    const startDate = $("#goal-start").value;
    const endDate = $("#goal-due").value;
    const validDates = Array.from(specificDateSelection)
      .filter((date) => date >= startDate && date <= endDate)
      .sort();
    let pages = Math.max(0, Math.trunc(Number($("#goal-pages").value) || 0));
    let loadDates = validDates;
    let estimateLabel = "";
    if (!validDates.length) {
      $("#specific-date-summary").textContent = "Nessuna data selezionata.";
      return;
    }

    const editingGoal = state.goals.find(
      (goal) => goal.id === $("#goal-id").value,
    );
    if (editingGoal) {
      const progressDates = Object.keys(editingGoal.progress || {}).sort();
      const latestProgress = progressDates.at(-1);
      const cutoff = [
        Planner.todayKey(),
        startDate,
        latestProgress ? Planner.addDaysKey(latestProgress, 1) : startDate,
      ]
        .sort()
        .at(-1);
      pages = Math.max(
        0,
        pages - Planner.goalStats(editingGoal).completedPages,
      );
      loadDates = validDates.filter(
        (date) =>
          date >= cutoff && !Object.hasOwn(editingGoal.progress || {}, date),
      );
      estimateLabel = "stima media futura: ";
    }

    if (!pages) {
      $("#specific-date-summary").textContent =
        `${plural(validDates.length, "data selezionata", "date selezionate")} · nessuna pagina rimanente`;
      return;
    }
    if (!loadDates.length) {
      $("#specific-date-summary").textContent =
        `${plural(validDates.length, "data selezionata", "date selezionate")} · ${plural(pages, "pagina senza una data futura", "pagine senza una data futura")}`;
      return;
    }

    const minimum = Math.floor(pages / loadDates.length);
    const maximum = Math.ceil(pages / loadDates.length);
    const load =
      minimum === maximum
        ? plural(minimum, "pagina al giorno", "pagine al giorno")
        : `tra ${minimum} e ${maximum} pagine al giorno`;
    $("#specific-date-summary").textContent =
      `${plural(validDates.length, "data selezionata", "date selezionate")} · ${estimateLabel}${load}`;
  }

  function renderSpecificDatePicker() {
    const container = $("#specific-date-picker");
    const startDate = $("#goal-start").value;
    const endDate = $("#goal-due").value;
    const dates = dateKeysInRange(startDate, endDate);
    if (!startDate || !endDate || startDate > endDate) {
      container.innerHTML =
        '<p class="field-help">Scegli prima un intervallo valido.</p>';
      updateSpecificDateSummary();
      return;
    }
    if (dayDistance(startDate, endDate) > 730) {
      container.innerHTML =
        '<p class="field-help">Per scegliere date singole usa un intervallo massimo di due anni.</p>';
      updateSpecificDateSummary();
      return;
    }

    const months = [];
    let monthCursor = firstOfMonth(startDate);
    const lastMonth = firstOfMonth(endDate);
    while (monthCursor <= lastMonth) {
      months.push(monthCursor);
      monthCursor = shiftMonth(monthCursor, 1);
    }
    const validSet = new Set(dates);
    const weekdayLabels =
      "<span>Lu</span><span>Ma</span><span>Me</span><span>Gi</span><span>Ve</span><span>Sa</span><span>Do</span>";
    container.innerHTML = months
      .map((monthKey) => {
        const monthDate = Planner.parseDateKey(monthKey);
        const daysInMonth = new Date(
          monthDate.getFullYear(),
          monthDate.getMonth() + 1,
          0,
        ).getDate();
        const offset = (monthDate.getDay() + 6) % 7;
        const cells = Array.from(
          { length: offset },
          () =>
            '<span class="specific-date-placeholder" aria-hidden="true"></span>',
        );
        for (let day = 1; day <= daysInMonth; day += 1) {
          const dateKey = Planner.toDateKey(
            new Date(monthDate.getFullYear(), monthDate.getMonth(), day),
          );
          if (!validSet.has(dateKey)) {
            cells.push(
              '<span class="specific-date-placeholder" aria-hidden="true"></span>',
            );
            continue;
          }
          const checked = specificDateSelection.has(dateKey);
          const dateLabel = longDateFormatter.format(
            Planner.parseDateKey(dateKey),
          );
          cells.push(
            `<label class="specific-date ${dateKey === Planner.todayKey() ? "is-today" : ""}" title="${escapeHtml(dateLabel)}"><input type="checkbox" name="studyDates" value="${dateKey}" ${checked ? "checked" : ""} aria-label="${escapeHtml(dateLabel)}" /><span>${day}</span></label>`,
          );
        }
        const heading = monthFormatter.format(monthDate);
        return `<section class="specific-month" aria-label="${escapeHtml(heading)}"><h3>${escapeHtml(heading)}</h3><div class="specific-month-weekdays" aria-hidden="true">${weekdayLabels}</div><div class="specific-month-days">${cells.join("")}</div></section>`;
      })
      .join("");
    updateSpecificDateSummary();
  }

  function setScheduleMode(mode, { seed = false } = {}) {
    const specific = mode === "specific";
    $("#weekly-options").classList.toggle("hidden", specific);
    $("#specific-options").classList.toggle("hidden", !specific);
    if (specific) {
      if (seed) seedSpecificDatesFromWeekdays();
      else if (!specificSelectionInitialized) {
        specificDateSelection.clear();
        specificSelectionInitialized = true;
      }
      renderSpecificDatePicker();
    }
  }

  function isStudyDay(goal, dateKey) {
    const rule = canonicalRuleMode(goal.dateRules && goal.dateRules[dateKey]);
    if (rule === "off") return false;
    if (rule === "study") return true;
    return !(goal.restWeekdays || []).includes(
      Planner.parseDateKey(dateKey).getDay(),
    );
  }

  function getDone(goal, dateKey) {
    const entry = goal.progress && goal.progress[dateKey];
    return Math.max(
      0,
      Number(typeof entry === "number" ? entry : entry && entry.done) || 0,
    );
  }

  function getPlanned(goal, dateKey) {
    const entry = goal.allocations && goal.allocations[dateKey];
    return Math.max(0, Number(entry && entry.planned) || 0);
  }

  function aggregateStats() {
    return state.goals.reduce(
      (summary, goal) => {
        const stats = Planner.goalStats(goal);
        summary.total += stats.totalPages;
        summary.done += Math.min(stats.completedPages, stats.totalPages);
        summary.rawDone += stats.completedPages;
        summary.remaining += stats.remainingPages;
        return summary;
      },
      { total: 0, done: 0, rawDone: 0, remaining: 0 },
    );
  }

  function createEmptyState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      goals: [],
      settings: { autoRedistribute: true, sampleData: false },
    };
  }

  function createDemoState() {
    const today = Planner.todayKey();
    const configs = [
      {
        id: "demo-anatomia",
        title: "Anatomia",
        totalPages: 220,
        startDate: Planner.addDaysKey(today, -12),
        endDate: Planner.addDaysKey(today, 24),
        restWeekdays: [0],
        dateRules: { [today]: "study" },
        color: COLORS[0],
      },
      {
        id: "demo-storia",
        title: "Storia dell’arte",
        totalPages: 150,
        startDate: Planner.addDaysKey(today, -8),
        endDate: Planner.addDaysKey(today, 18),
        restWeekdays: [0, 6],
        dateRules: { [today]: "study" },
        color: COLORS[1],
      },
      {
        id: "demo-inglese",
        title: "Lingua inglese",
        totalPages: 110,
        startDate: Planner.addDaysKey(today, -5),
        endDate: Planner.addDaysKey(today, 33),
        restWeekdays: [0],
        dateRules: { [today]: "study" },
        color: COLORS[2],
      },
    ];

    const goals = configs.map((config, goalIndex) => {
      let goal = { ...Planner.createGoal(config), scheduleMode: "weekly" };
      const pastDates = Object.keys(goal.allocations)
        .filter((date) => date < today)
        .sort();
      const variation = [-1, 0, 1, 0];
      pastDates.forEach((date, index) => {
        const planned = getPlanned(goal, date);
        const done = Math.max(
          0,
          planned + variation[(index + goalIndex) % variation.length],
        );
        goal = Planner.recordProgress(goal, date, done, { redistribute: true });
      });
      return goal;
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      goals,
      settings: { autoRedistribute: true, sampleData: true },
    };
  }

  function normalizeStoredState(candidate) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !Array.isArray(candidate.goals)
    ) {
      throw new TypeError("Formato dati non riconosciuto");
    }
    if (
      candidate.schemaVersion != null &&
      candidate.schemaVersion > SCHEMA_VERSION
    ) {
      throw new TypeError(
        "Il backup proviene da una versione più recente di Tato Tracker",
      );
    }

    const seenIds = new Set();
    const goals = candidate.goals.map((goal, index) => {
      const validation = Planner.validateGoalConfig(goal);
      if (!validation.valid)
        throw new TypeError(
          `Obiettivo non valido: ${validation.errors.join(", ")}`,
        );
      const id =
        typeof goal.id === "string" && goal.id
          ? goal.id
          : `imported-${Date.now()}-${index}`;
      if (seenIds.has(id))
        throw new TypeError(
          `Il backup contiene un identificativo duplicato: ${id}`,
        );
      seenIds.add(id);
      const canonical = {
        id,
        subjectId: typeof goal.subjectId === "string" ? goal.subjectId : null,
        title: String(goal.title ?? goal.name).trim(),
        color: safeColor(goal.color),
        totalPages: goal.totalPages ?? goal.pages ?? goal.total,
        startDate: goal.startDate ?? Planner.todayKey(),
        endDate: goal.endDate ?? goal.dueDate ?? goal.deadline,
        restWeekdays: Array.from(
          new Set(goal.restWeekdays ?? goal.freeWeekdays ?? []),
        ).sort(),
        dateRules: Object.fromEntries(
          Object.entries(goal.dateRules || {}).map(([date, rule]) => [
            date,
            canonicalRuleMode(rule),
          ]),
        ),
        allocations: Object.fromEntries(
          Object.entries(goal.allocations || {}).map(([date, entry]) => [
            date,
            {
              planned: entry.planned,
              source: entry.source === "manual" ? "manual" : "auto",
            },
          ]),
        ),
        progress: Object.fromEntries(
          Object.entries(goal.progress || {}).map(([date, entry]) => [
            date,
            { done: typeof entry === "number" ? entry : entry.done },
          ]),
        ),
        autoRedistribute: goal.autoRedistribute !== false,
        scheduleMode:
          goal.scheduleMode === "specific" ||
          ((goal.restWeekdays ?? goal.freeWeekdays ?? []).length === 7 &&
            Object.values(goal.dateRules || {}).some(
              (rule) => canonicalRuleMode(rule) === "study",
            ))
            ? "specific"
            : "weekly",
        unscheduled: Math.max(0, Number(goal.unscheduled) || 0),
        overplanned: Math.max(0, Number(goal.overplanned) || 0),
        planRevision: Math.max(0, Number(goal.planRevision) || 0),
      };
      Planner.goalStats(canonical);
      return canonical;
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      goals,
      settings: {
        autoRedistribute: candidate.settings?.autoRedistribute !== false,
        sampleData: candidate.settings?.sampleData === true,
      },
    };
  }

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDemoState();
      return normalizeStoredState(JSON.parse(raw));
    } catch (error) {
      loadFailed = true;
      if (raw) {
        try {
          localStorage.setItem(RECOVERY_KEY, raw);
        } catch (_) {
          // If storage itself is unavailable, the original key is still left untouched.
        }
      }
      loadNotice =
        "I dati salvati non erano leggibili: ho lasciato intatto l’originale e aperto un piano di esempio.";
      return createDemoState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      showToast(
        "Non riesco a salvare sul dispositivo. Esporta un backup prima di chiudere la pagina.",
      );
      return false;
    }
  }

  function cloneState() {
    return typeof structuredClone === "function"
      ? structuredClone(state)
      : JSON.parse(JSON.stringify(state));
  }

  function commitOrRollback(previousState) {
    if (saveState()) return true;
    state = previousState;
    return false;
  }

  function markAsPersonal() {
    state.settings.sampleData = false;
  }

  function replaceGoal(updatedGoal) {
    const index = state.goals.findIndex((goal) => goal.id === updatedGoal.id);
    if (index >= 0) state.goals[index] = updatedGoal;
  }

  function renderAll() {
    renderHeader();
    renderMetrics();
    renderToday();
    renderCalendar();
    renderProgress();
    renderGoals();
  }

  function renderHeader() {
    const now = new Date();
    const today = Planner.todayKey();
    const formatted = fullDateFormatter.format(Planner.parseDateKey(today));
    elements.todayLabel.textContent =
      formatted.charAt(0).toUpperCase() + formatted.slice(1);
    elements.greeting.textContent =
      now.getHours() < 12
        ? "Buongiorno"
        : now.getHours() < 18
          ? "Buon pomeriggio"
          : "Buonasera";

    const todayTasks = state.goals.filter(
      (goal) => getPlanned(goal, today) > 0 || getDone(goal, today) > 0,
    );
    const planned = todayTasks.reduce(
      (sum, goal) => sum + getPlanned(goal, today),
      0,
    );
    const done = todayTasks.reduce(
      (sum, goal) => sum + getDone(goal, today),
      0,
    );
    if (!state.goals.length) {
      elements.heroSummary.textContent =
        "Aggiungi il primo obiettivo: Tato distribuirà le pagine rispettando il tuo tempo libero.";
    } else if (!todayTasks.length) {
      elements.heroSummary.textContent =
        "Oggi il piano è libero. Riposa oppure apri il calendario per anticipare un piccolo passo.";
    } else if (done > 0) {
      elements.heroSummary.textContent = `Hai completato ${plural(done, "pagina", "pagine")} delle ${numberFormatter.format(planned)} previste oggi.`;
    } else {
      elements.heroSummary.textContent = `Oggi ci sono ${plural(planned, "pagina", "pagine")} distribuite in ${plural(todayTasks.length, "materia", "materie")}.`;
    }
  }

  function renderMetrics() {
    const today = Planner.todayKey();
    const aggregate = aggregateStats();
    const todayPlanned = state.goals.reduce(
      (sum, goal) => sum + getPlanned(goal, today),
      0,
    );
    const todayDone = state.goals.reduce(
      (sum, goal) => sum + getDone(goal, today),
      0,
    );
    const completion = aggregate.total
      ? Math.round((aggregate.done / aggregate.total) * 100)
      : 0;

    $("#metric-today").textContent = plural(todayPlanned, "pagina", "pagine");
    $("#metric-today-detail").textContent = todayPlanned
      ? `${numberFormatter.format(todayDone)} già completate`
      : "Una giornata leggera";
    $("#metric-completion").textContent = `${completion}%`;
    $("#metric-completion-detail").textContent =
      `${numberFormatter.format(aggregate.done)} di ${numberFormatter.format(aggregate.total)} pagine`;

    const nextGoal = state.goals
      .filter((goal) => !Planner.goalStats(goal).isComplete)
      .sort((a, b) => a.endDate.localeCompare(b.endDate))[0];
    if (!nextGoal) {
      $("#metric-deadline").textContent = state.goals.length
        ? "Tutto fatto"
        : "—";
      $("#metric-deadline-detail").textContent = state.goals.length
        ? "Che bella sensazione"
        : "Aggiungi un obiettivo";
      return;
    }
    const days = dayDistance(today, nextGoal.endDate);
    $("#metric-deadline").textContent =
      days === 0
        ? "Oggi"
        : days > 0
          ? plural(days, "giorno", "giorni")
          : `${numberFormatter.format(Math.abs(days))} gg fa`;
    $("#metric-deadline-detail").textContent =
      days < 0
        ? `${nextGoal.title} · piano da rivedere`
        : `${nextGoal.title} · ${shortDateFormatter.format(Planner.parseDateKey(nextGoal.endDate))}`;
  }

  function emptyStateMarkup(
    title,
    description,
    actionLabel = "",
    actionAttribute = "",
  ) {
    return `<div class="empty-state"><div><span class="empty-state-icon"><svg><use href="#icon-book"></use></svg></span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${actionLabel ? `<button class="button button-primary" type="button" ${actionAttribute}>${escapeHtml(actionLabel)}</button>` : ""}</div></div>`;
  }

  function renderToday() {
    const today = Planner.todayKey();
    elements.autoRedistribute.checked =
      state.settings.autoRedistribute !== false;
    const tasks = state.goals
      .filter((goal) => getPlanned(goal, today) > 0 || getDone(goal, today) > 0)
      .sort((a, b) => a.title.localeCompare(b.title, "it"));

    if (!state.goals.length) {
      elements.todayList.innerHTML = emptyStateMarkup(
        "Cominciamo da qui",
        "Crea un obiettivo, indica pagine e scadenza: il primo piano appare subito.",
        "Crea il primo obiettivo",
        "data-open-goal",
      );
      return;
    }
    if (!tasks.length) {
      elements.todayList.innerHTML = emptyStateMarkup(
        "Oggi non c’è nulla in programma",
        "Il riposo fa parte del piano. Se vuoi, puoi aggiungere un’attività dal calendario.",
        "Apri il calendario",
        "data-scroll-calendar",
      );
      return;
    }

    elements.todayList.innerHTML = tasks
      .map((goal) => {
        const planned = getPlanned(goal, today);
        const done = getDone(goal, today);
        const manual = goal.allocations[today]?.source === "manual";
        const title = escapeHtml(goal.title);
        return `<form class="today-task" data-progress-form data-goal-id="${escapeHtml(goal.id)}" style="--task-color:${safeColor(goal.color)}">
        <div class="today-task-info">
          <span class="today-task-badge" aria-hidden="true">${escapeHtml(goal.title.trim().charAt(0) || "T")}</span>
          <div class="today-task-copy"><strong>${title}</strong><span>${plural(planned, "pagina prevista", "pagine previste")}${manual ? " · carico personalizzato" : ""}</span></div>
        </div>
        <div class="today-checkin">
          <label for="done-${escapeHtml(goal.id)}">Pagine fatte</label>
          <div class="number-control">
            <button type="button" data-step="-1" aria-label="Riduci pagine fatte per ${title}">−</button>
            <input id="done-${escapeHtml(goal.id)}" name="done" type="number" min="0" max="9999" inputmode="numeric" value="${done}" aria-label="Pagine fatte per ${title}" />
            <button type="button" data-step="1" aria-label="Aumenta pagine fatte per ${title}">+</button>
          </div>
          <button class="button button-quiet save-progress" type="submit">Salva</button>
        </div>
      </form>`;
      })
      .join("");
  }

  function renderCalendar() {
    const cursorDate = Planner.parseDateKey(calendarCursor);
    const monthLabel = monthFormatter.format(cursorDate);
    elements.calendarMonth.textContent =
      monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
    const weekday = cursorDate.getDay();
    const mondayOffset = (weekday + 6) % 7;
    const gridStart = Planner.addDaysKey(calendarCursor, -mondayOffset);
    const today = Planner.todayKey();
    const gridEnd = Planner.addDaysKey(gridStart, 41);
    const focusDate =
      today >= gridStart && today <= gridEnd ? today : calendarCursor;
    const studyByDate = StudyLog.summarizeByDate(studyLog);

    const cells = Array.from({ length: 42 }, (_, index) => {
      const dateKey = Planner.addDaysKey(gridStart, index);
      const date = Planner.parseDateKey(dateKey);
      const activeGoals = state.goals.filter((goal) =>
        dateInGoal(goal, dateKey),
      );
      const tasks = activeGoals
        .filter(
          (goal) => getPlanned(goal, dateKey) > 0 || getDone(goal, dateKey) > 0,
        )
        .sort((a, b) => a.title.localeCompare(b.title, "it"));
      const total = tasks.reduce(
        (sum, goal) => sum + getPlanned(goal, dateKey),
        0,
      );
      const pomodoroStudy = studyByDate[dateKey] || { seconds: 0, sessions: 0 };
      const isRest =
        activeGoals.length > 0 &&
        activeGoals.every((goal) => !isStudyDay(goal, dateKey));
      const details = [];
      if (tasks.length) {
        details.push(
          tasks
            .map(
              (goal) =>
                `${goal.title}: ${getDone(goal, dateKey)} fatte su ${getPlanned(goal, dateKey)} previste`,
            )
            .join("; "),
        );
      } else if (isRest) {
        details.push("giorno libero");
      }
      if (pomodoroStudy.seconds) {
        const sessionLabel =
          pomodoroStudy.sessions === 1
            ? "1 sessione completata"
            : `${pomodoroStudy.sessions} sessioni completate`;
        details.push(
          `Po-Tato: ${StudyLog.formatDuration(pomodoroStudy.seconds)}, ${sessionLabel}`,
        );
      }
      if (!details.length) details.push("nessuna attività");
      const visibleTasks = tasks
        .slice(0, 3)
        .map((goal) => {
          const planned = getPlanned(goal, dateKey);
          const done = getDone(goal, dateKey);
          return `<span class="calendar-task ${done >= planned && planned > 0 ? "is-complete" : ""}" data-initial="${escapeHtml(goal.title.trim().charAt(0) || "T")}" style="--task-color:${safeColor(goal.color)}"><span class="calendar-task-name">${escapeHtml(goal.title)}</span><span class="calendar-task-pages">${done > 0 ? `${done}/` : ""}${planned}</span></span>`;
        })
        .join("");
      const pomodoroBadge = pomodoroStudy.seconds
        ? `<span class="calendar-study-time" title="${escapeHtml(StudyLog.formatDuration(pomodoroStudy.seconds))} di studio Po-Tato"><svg aria-hidden="true"><use href="#icon-timer"></use></svg><span>${escapeHtml(StudyLog.formatDuration(pomodoroStudy.seconds, true))}</span></span>`
        : "";
      return `<button class="calendar-day ${date.getMonth() !== cursorDate.getMonth() ? "outside-month" : ""} ${dateKey === today ? "is-today" : ""} ${isRest ? "is-rest" : ""}" type="button" role="gridcell" tabindex="${dateKey === focusDate ? "0" : "-1"}" data-date="${dateKey}" aria-label="${escapeHtml(longDateFormatter.format(date))}: ${escapeHtml(details.join("; "))}" ${dateKey === today ? 'aria-current="date"' : ""}>
        <span class="calendar-day-top"><time class="calendar-date" datetime="${dateKey}">${date.getDate()}</time><span class="calendar-day-metrics">${total ? `<span class="calendar-total">${total}p</span>` : ""}${pomodoroBadge}</span></span>
        <span class="calendar-tasks">${visibleTasks}${tasks.length > 3 ? `<span class="calendar-more">+${tasks.length - 3}</span>` : ""}</span>
      </button>`;
    });
    elements.calendarGrid.innerHTML = Array.from(
      { length: 6 },
      (_, row) =>
        `<div class="calendar-row" role="row">${cells.slice(row * 7, row * 7 + 7).join("")}</div>`,
    ).join("");
  }

  function renderProgress() {
    const aggregate = aggregateStats();
    const percent = aggregate.total
      ? Math.round((aggregate.done / aggregate.total) * 100)
      : 0;
    const circumference = 2 * Math.PI * 48;
    $("#donut-value").style.strokeDasharray =
      `${(circumference * percent) / 100} ${circumference}`;
    $("#donut-percent").textContent = `${percent}%`;
    $("#pages-done").textContent = numberFormatter.format(aggregate.done);
    $("#pages-left").textContent = numberFormatter.format(aggregate.remaining);
    $("#completion-chart").setAttribute(
      "aria-label",
      `Completamento totale: ${percent} percento, ${aggregate.done} pagine fatte e ${aggregate.remaining} da fare`,
    );

    if (!state.goals.length) {
      elements.subjectProgress.innerHTML =
        '<p class="field-help">Il progresso per materia comparirà qui.</p>';
      return;
    }
    elements.subjectProgress.innerHTML = state.goals
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, "it"))
      .map((goal) => {
        const stats = Planner.goalStats(goal);
        const rounded = Math.round(stats.completionPercent);
        return `<div class="subject-progress-item" style="--task-color:${safeColor(goal.color)}">
          <div class="subject-progress-top"><span>${escapeHtml(goal.title)}</span><strong>${rounded}% · ${numberFormatter.format(Math.min(stats.completedPages, stats.totalPages))}/${numberFormatter.format(stats.totalPages)}</strong></div>
          <div class="progress-bar" role="progressbar" aria-label="${escapeHtml(goal.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rounded}"><span style="--progress:${rounded}%"></span></div>
        </div>`;
      })
      .join("");
  }

  function focusCalendarDate(dateKey) {
    requestAnimationFrame(() => {
      const days = $$(".calendar-day", elements.calendarGrid);
      const target =
        days.find((day) => day.dataset.date === dateKey) ||
        days.find((day) => day.tabIndex === 0);
      if (!target) return;
      days.forEach((day) => {
        day.tabIndex = day === target ? 0 : -1;
      });
      target.focus();
    });
  }

  function handleCalendarKeydown(event) {
    const current = event.target.closest(".calendar-day");
    if (!current) return;
    const days = $$(".calendar-day", elements.calendarGrid);
    const index = days.indexOf(current);
    let targetIndex = index;
    if (event.key === "ArrowRight") targetIndex += 1;
    else if (event.key === "ArrowLeft") targetIndex -= 1;
    else if (event.key === "ArrowDown") targetIndex += 7;
    else if (event.key === "ArrowUp") targetIndex -= 7;
    else if (event.key === "Home") targetIndex -= index % 7;
    else if (event.key === "End") targetIndex += 6 - (index % 7);
    else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const currentDate = Planner.parseDateKey(current.dataset.date);
      const targetMonth = Planner.parseDateKey(
        shiftMonth(current.dataset.date, event.key === "PageUp" ? -1 : 1),
      );
      const targetDay = Math.min(
        currentDate.getDate(),
        new Date(
          targetMonth.getFullYear(),
          targetMonth.getMonth() + 1,
          0,
        ).getDate(),
      );
      const targetDate = Planner.toDateKey(
        new Date(targetMonth.getFullYear(), targetMonth.getMonth(), targetDay),
      );
      calendarCursor = firstOfMonth(targetDate);
      renderCalendar();
      focusCalendarDate(targetDate);
      return;
    } else {
      return;
    }
    event.preventDefault();
    const target = days[Math.max(0, Math.min(days.length - 1, targetIndex))];
    days.forEach((day) => {
      day.tabIndex = day === target ? 0 : -1;
    });
    target.focus();
  }

  function renderGoals() {
    if (!state.goals.length) {
      elements.goalsList.innerHTML =
        '<p class="field-help">Nessun obiettivo attivo.</p>';
      return;
    }
    elements.goalsList.innerHTML = state.goals
      .slice()
      .sort((a, b) => {
        const completeDelta =
          Number(Planner.goalStats(a).isComplete) -
          Number(Planner.goalStats(b).isComplete);
        return completeDelta || a.endDate.localeCompare(b.endDate);
      })
      .map((goal) => {
        const stats = Planner.goalStats(goal);
        const due = shortDateFormatter.format(
          Planner.parseDateKey(goal.endDate),
        );
        const status = stats.isComplete
          ? "Completato"
          : `${Math.round(stats.completionPercent)}% · scade ${due}${stats.unscheduled ? ` · ${stats.unscheduled} da collocare` : ""}${stats.overplanned ? ` · ${stats.overplanned} in eccesso` : ""}`;
        return `<article class="goal-card" style="--task-color:${safeColor(goal.color)}">
          <span class="goal-color" aria-hidden="true"></span>
          <div class="goal-copy"><strong>${escapeHtml(goal.title)}</strong><span>${escapeHtml(status)}</span></div>
          <button class="goal-edit" type="button" data-edit-goal="${escapeHtml(goal.id)}" aria-label="Modifica ${escapeHtml(goal.title)}"><svg><use href="#icon-edit"></use></svg></button>
        </article>`;
      })
      .join("");
  }

  function openGoalDialog(goalId = "") {
    elements.goalForm.reset();
    specificDateSelection = new Set();
    specificSelectionInitialized = false;
    $("#goal-form-error").textContent = "";
    $$(".field input", elements.goalForm).forEach((input) =>
      input.removeAttribute("aria-invalid"),
    );
    $("#goal-id").value = goalId;
    const editingGoal = state.goals.find((goal) => goal.id === goalId);

    if (editingGoal) {
      $("#goal-start").removeAttribute("min");
      $("#goal-due").removeAttribute("min");
      $("#goal-dialog-kicker").textContent = "Modifica percorso";
      $("#goal-dialog-title").textContent = "Aggiorna l’obiettivo";
      $("#goal-submit-label").textContent = "Salva modifiche";
      $("#delete-goal").classList.remove("hidden");
      $("#goal-title").value = editingGoal.title;
      $("#goal-pages").value = editingGoal.totalPages;
      $("#goal-start").value = editingGoal.startDate;
      $("#goal-due").value = editingGoal.endDate;
      const storedMode =
        editingGoal.scheduleMode === "specific" ? "specific" : "weekly";
      $$('input[name="studyDays"]', elements.goalForm).forEach((input) => {
        input.checked =
          storedMode === "specific"
            ? Number(input.value) !== 0
            : !editingGoal.restWeekdays.includes(Number(input.value));
      });
      $$('input[name="scheduleMode"]', elements.goalForm).forEach((input) => {
        input.checked = input.value === storedMode;
      });
      if (storedMode === "specific") {
        specificDateSelection = new Set(
          dateKeysInRange(editingGoal.startDate, editingGoal.endDate).filter(
            (date) => isStudyDay(editingGoal, date),
          ),
        );
        specificSelectionInitialized = true;
      }
      const color = safeColor(editingGoal.color);
      $$('input[name="color"]', elements.goalForm).forEach((input) => {
        input.checked = input.value.toLowerCase() === color.toLowerCase();
      });
    } else {
      const today = Planner.todayKey();
      $("#goal-start").min = today;
      $("#goal-due").min = today;
      $("#goal-dialog-kicker").textContent = "Nuovo percorso";
      $("#goal-dialog-title").textContent = "Crea un obiettivo";
      $("#goal-submit-label").textContent = "Crea il piano";
      $("#delete-goal").classList.add("hidden");
      $("#goal-start").value = today;
      $("#goal-due").value = Planner.addDaysKey(today, 30);
      $(
        'input[name="scheduleMode"][value="weekly"]',
        elements.goalForm,
      ).checked = true;
    }
    setScheduleMode(
      $('input[name="scheduleMode"]:checked', elements.goalForm).value,
    );
    elements.goalDialog.showModal();
    requestAnimationFrame(() => $("#goal-title").focus());
  }

  function goalConfigFromForm() {
    const formData = new FormData(elements.goalForm);
    const scheduleMode = String(formData.get("scheduleMode") || "weekly");
    const studyDays = formData.getAll("studyDays").map(Number);
    const restWeekdays =
      scheduleMode === "specific"
        ? [0, 1, 2, 3, 4, 5, 6]
        : [0, 1, 2, 3, 4, 5, 6].filter((day) => !studyDays.includes(day));
    const startDate = String(formData.get("startDate") || "");
    const endDate = String(formData.get("dueDate") || "");
    const dateRules =
      scheduleMode === "specific"
        ? Object.fromEntries(
            Array.from(specificDateSelection)
              .filter((date) => date >= startDate && date <= endDate)
              .sort()
              .map((date) => [date, "study"]),
          )
        : {};
    return {
      title: String(formData.get("title") || "").trim(),
      totalPages: Number(formData.get("totalPages")),
      startDate,
      endDate,
      restWeekdays,
      dateRules,
      scheduleMode,
      color: safeColor(formData.get("color")),
      autoRedistribute: state.settings.autoRedistribute,
    };
  }

  function validateGoalForm(config) {
    let message = "";
    let field = null;
    if (!config.title) {
      message = "Scrivi il nome della materia o dell’obiettivo.";
      field = $("#goal-title");
    } else if (!Number.isInteger(config.totalPages) || config.totalPages < 1) {
      message = "Inserisci un numero intero di pagine maggiore di zero.";
      field = $("#goal-pages");
    } else if (!config.startDate) {
      message = "Scegli una data di inizio.";
      field = $("#goal-start");
    } else if (!config.endDate) {
      message = "Scegli una data di scadenza.";
      field = $("#goal-due");
    } else if (!$("#goal-id").value && config.startDate < Planner.todayKey()) {
      message = "Per un nuovo piano scegli oggi o una data futura come inizio.";
      field = $("#goal-start");
    } else if (config.startDate > config.endDate) {
      message =
        "La scadenza deve essere uguale o successiva alla data di inizio.";
      field = $("#goal-due");
    } else if (
      config.scheduleMode === "specific" &&
      dayDistance(config.startDate, config.endDate) > 730
    ) {
      message =
        "Per scegliere date singole usa un intervallo massimo di due anni.";
      field = $("#goal-due");
    } else if (
      config.scheduleMode === "specific" &&
      !Object.keys(config.dateRules).length
    ) {
      message = "Seleziona almeno una data di studio nel calendario.";
      field = $("#specific-date-picker input") || $("#select-all-dates");
    } else if (
      config.scheduleMode === "weekly" &&
      config.restWeekdays.length === 7
    ) {
      message = "Seleziona almeno un giorno di studio alla settimana.";
      field = $('input[name="studyDays"]');
    }
    $("#goal-form-error").textContent = message;
    $$(".field input", elements.goalForm).forEach((input) =>
      input.removeAttribute("aria-invalid"),
    );
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
      return false;
    }
    return true;
  }

  function handleGoalSubmit(event) {
    event.preventDefault();
    const config = goalConfigFromForm();
    if (!validateGoalForm(config)) return;
    const goalId = $("#goal-id").value;
    const previousState = cloneState();
    try {
      let updated;
      let successMessage;
      if (goalId) {
        const previous = state.goals.find((goal) => goal.id === goalId);
        if (!previous) throw new Error("Obiettivo non trovato");
        const inRange = (date) =>
          date >= config.startDate && date <= config.endDate;
        const progressDates = Object.keys(previous.progress || {});
        if (progressDates.some((date) => !inRange(date))) {
          $("#goal-form-error").textContent =
            "Il nuovo intervallo escluderebbe giornate con progressi registrati. Mantieni quelle date nel piano.";
          (config.startDate > previous.startDate
            ? $("#goal-start")
            : $("#goal-due")
          ).focus();
          return;
        }
        const sameRestDays =
          previous.restWeekdays.length === config.restWeekdays.length &&
          previous.restWeekdays.every(
            (day, index) => day === config.restWeekdays[index],
          );
        const previousMode =
          previous.scheduleMode === "specific" ? "specific" : "weekly";
        const nextDateRules =
          config.scheduleMode === "specific"
            ? config.dateRules
            : previousMode === "specific"
              ? {}
              : Object.fromEntries(
                  Object.entries(previous.dateRules || {}).filter(([date]) =>
                    inRange(date),
                  ),
                );
        const rulesChanged =
          JSON.stringify(
            previousMode === "specific"
              ? Object.fromEntries(
                  Object.entries(previous.dateRules || {}).filter(([date]) =>
                    inRange(date),
                  ),
                )
              : nextDateRules,
          ) !== JSON.stringify(nextDateRules);
        const scheduleChanged =
          previous.totalPages !== config.totalPages ||
          previous.startDate !== config.startDate ||
          previous.endDate !== config.endDate ||
          !sameRestDays ||
          previousMode !== config.scheduleMode ||
          rulesChanged;
        const base = {
          ...previous,
          ...config,
          id: previous.id,
          subjectId: previous.subjectId,
          dateRules: nextDateRules,
          allocations: Object.fromEntries(
            Object.entries(previous.allocations || {}).filter(([date]) =>
              inRange(date),
            ),
          ),
          progress: previous.progress || {},
        };
        if (scheduleChanged) {
          const latestProgress = progressDates.sort().at(-1);
          const cutoff = [
            Planner.todayKey(),
            config.startDate,
            latestProgress
              ? Planner.addDaysKey(latestProgress, 1)
              : config.startDate,
          ]
            .sort()
            .at(-1);
          updated = Planner.rescheduleGoal(base, { fromDate: cutoff });
        } else {
          updated = base;
        }
        replaceGoal(updated);
        successMessage = scheduleChanged
          ? "Obiettivo aggiornato e piano futuro ricalcolato."
          : "Obiettivo aggiornato.";
      } else {
        updated = {
          ...Planner.createGoal(config),
          scheduleMode: config.scheduleMode,
        };
        state.goals.push(updated);
        successMessage = "Obiettivo creato: il piano è pronto.";
      }
      markAsPersonal();
      if (!commitOrRollback(previousState)) return;
      elements.goalDialog.close();
      renderAll();
      requestAnimationFrame(() => {
        const target = goalId
          ? $$("[data-edit-goal]").find(
              (button) => button.dataset.editGoal === goalId,
            )
          : $(".top-new-goal");
        target?.focus();
      });
      const stats = Planner.goalStats(updated);
      showToast(
        stats.unscheduled
          ? `${successMessage} ${plural(stats.unscheduled, "pagina non ha", "pagine non hanno")} ancora un giorno disponibile.`
          : successMessage,
      );
    } catch (error) {
      $("#goal-form-error").textContent =
        "Non riesco a creare il piano con questi dati. Controlla date e pagine.";
    }
  }

  function openDayDialog(dateKey) {
    const date = Planner.parseDateKey(dateKey);
    const futureDate = dateKey > Planner.todayKey();
    $("#day-key").value = dateKey;
    const label = fullDateFormatter.format(date);
    $("#day-dialog-title").textContent =
      label.charAt(0).toUpperCase() + label.slice(1);
    const activeGoals = state.goals
      .filter((goal) => dateInGoal(goal, dateKey))
      .sort((a, b) => a.title.localeCompare(b.title, "it"));
    const allRest =
      activeGoals.length > 0 &&
      activeGoals.every((goal) => !isStudyDay(goal, dateKey));
    $("#day-rest").checked = allRest;
    $("#day-rest").dataset.originalRest = String(allRest);
    $("#day-rest").disabled = activeGoals.length === 0;
    $("#day-redistribute").checked = state.settings.autoRedistribute !== false;

    if (!activeGoals.length) {
      $("#day-task-list").innerHTML = emptyStateMarkup(
        "Nessun obiettivo in questa data",
        "Apri un obiettivo e modifica il suo intervallo per includere questo giorno.",
      );
    } else {
      $("#day-task-list").innerHTML = activeGoals
        .map((goal) => {
          const planned = getPlanned(goal, dateKey);
          const done = getDone(goal, dateKey);
          const manual = goal.allocations[dateKey]?.source === "manual";
          return `<div class="day-task-row ${allRest ? "is-disabled" : ""}" data-day-goal="${escapeHtml(goal.id)}" data-original-planned="${planned}" data-original-done="${done}" style="--task-color:${safeColor(goal.color)}">
          <div class="day-task-name"><strong>${escapeHtml(goal.title)}</strong><span>${futureDate ? "Il progresso si registra il giorno stesso" : manual ? "Carico personalizzato" : "Distribuzione automatica"}</span></div>
          <div class="day-task-fields">
            <label>Pianificate · ${escapeHtml(goal.title)}<input class="day-planned" type="number" min="0" max="9999" inputmode="numeric" value="${planned}" ${allRest ? "disabled" : ""} /></label>
            <label>Completate · ${escapeHtml(goal.title)}<input class="day-done" type="number" min="0" max="9999" inputmode="numeric" value="${done}" ${futureDate ? "disabled" : ""} /></label>
          </div>
        </div>`;
        })
        .join("");
    }
    elements.dayDialog.showModal();
  }

  function handleDaySubmit(event) {
    event.preventDefault();
    const dateKey = $("#day-key").value;
    const rest = $("#day-rest").checked;
    const restChanged =
      rest !== ($("#day-rest").dataset.originalRest === "true");
    const redistribute = $("#day-redistribute").checked;
    const previousState = cloneState();
    try {
      $$(".day-task-row", elements.dayForm).forEach((row) => {
        const goalId = row.dataset.dayGoal;
        let goal = state.goals.find((item) => item.id === goalId);
        if (!goal) return;
        const originalPlanned = Number(row.dataset.originalPlanned);
        const originalDone = Number(row.dataset.originalDone);
        const planned = Math.max(
          0,
          Math.trunc(Number($(".day-planned", row).value) || 0),
        );
        const done = Math.max(
          0,
          Math.trunc(Number($(".day-done", row).value) || 0),
        );

        if (dateKey > Planner.todayKey() && done !== originalDone) {
          throw new RangeError("Non è possibile registrare progressi futuri");
        }

        if (restChanged) {
          goal = Planner.setDateRule(goal, dateKey, rest ? "off" : "study");
        }
        if (!rest && planned !== originalPlanned) {
          goal = Planner.setPlanned(goal, dateKey, planned, { redistribute });
        }
        if (done !== originalDone) {
          goal = Planner.recordProgress(goal, dateKey, done, { redistribute });
        }
        replaceGoal(goal);
      });
      markAsPersonal();
      if (!commitOrRollback(previousState)) return;
      elements.dayDialog.close();
      renderAll();
      focusCalendarDate(dateKey);
      showToast(
        rest
          ? "Giorno libero: il carico è stato spostato."
          : "Giornata aggiornata.",
      );
    } catch (error) {
      showToast(
        "Non riesco a salvare questa giornata. Controlla i valori inseriti.",
      );
    }
  }

  function handleTodaySubmit(event) {
    const form = event.target.closest("[data-progress-form]");
    if (!form) return;
    event.preventDefault();
    const goal = state.goals.find((item) => item.id === form.dataset.goalId);
    if (!goal) return;
    const today = Planner.todayKey();
    const planned = getPlanned(goal, today);
    const input = $('input[name="done"]', form);
    const done = Math.max(0, Math.trunc(Number(input.value) || 0));
    const previousState = cloneState();
    try {
      const updated = Planner.recordProgress(goal, today, done, {
        redistribute: state.settings.autoRedistribute,
      });
      replaceGoal(updated);
      markAsPersonal();
      if (!commitOrRollback(previousState)) return;
      renderAll();
      requestAnimationFrame(() => {
        const refreshed = $$("[data-progress-form]").find(
          (item) => item.dataset.goalId === goal.id,
        );
        $('input[name="done"]', refreshed || document)?.focus();
      });
      const delta = done - planned;
      const note =
        state.settings.autoRedistribute && delta !== 0
          ? " Le pagine rimanenti sono state ridistribuite."
          : "";
      showToast(
        delta === 0
          ? "Ottimo: attività registrata."
          : `Studio registrato.${note}`,
      );
    } catch (error) {
      showToast("Inserisci un numero valido di pagine.");
    }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    toastTimer = window.setTimeout(
      () => elements.toast.classList.remove("visible"),
      4200,
    );
  }

  function askConfirm({ title, message, acceptLabel = "Continua" }) {
    if (confirmResolver) confirmResolver(false);
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-accept").textContent = acceptLabel;
    elements.confirmDialog.showModal();
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function settleConfirm(value) {
    const resolver = confirmResolver;
    confirmResolver = null;
    if (elements.confirmDialog.open) elements.confirmDialog.close();
    if (resolver) resolver(value);
  }

  async function deleteCurrentGoal() {
    const goalId = $("#goal-id").value;
    const goal = state.goals.find((item) => item.id === goalId);
    if (!goal) return;
    const accepted = await askConfirm({
      title: `Eliminare ${goal.title}?`,
      message:
        "Verranno rimossi anche piano e progressi di questo obiettivo. Gli altri dati resteranno intatti.",
      acceptLabel: "Elimina obiettivo",
    });
    if (!accepted) return;
    const previousState = cloneState();
    state.goals = state.goals.filter((item) => item.id !== goalId);
    markAsPersonal();
    if (!commitOrRollback(previousState)) return;
    if (elements.goalDialog.open) elements.goalDialog.close();
    renderAll();
    requestAnimationFrame(() => $(".top-new-goal")?.focus());
    showToast("Obiettivo eliminato.");
  }

  function exportData() {
    const payload = JSON.stringify(
      {
        ...state,
        pomodoroStudy: StudyLog.normalize(studyLog),
        exportedAt: new Date().toISOString(),
        app: "Tato Tracker",
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([payload], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `tato-tracker-backup-${Planner.todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Backup esportato.");
  }

  async function importData(file) {
    if (!file) return;
    try {
      const parsedBackup = JSON.parse(await file.text());
      const imported = normalizeStoredState(parsedBackup);
      const importedStudy = Object.prototype.hasOwnProperty.call(
        parsedBackup,
        "pomodoroStudy",
      )
        ? StudyLog.normalize(parsedBackup.pomodoroStudy)
        : studyLog;
      const accepted = await askConfirm({
        title: "Importare questo backup?",
        message: `Il file contiene ${plural(imported.goals.length, "obiettivo", "obiettivi")} e sostituirà i dati presenti su questo dispositivo.`,
        acceptLabel: "Importa backup",
      });
      if (!accepted) return;
      const previousState = cloneState();
      const previousStudy = studyLog;
      state = imported;
      studyLog = importedStudy;
      markAsPersonal();
      if (!commitOrRollback(previousState)) {
        studyLog = previousStudy;
        return;
      }
      if (!StudyLog.save(studyLog, localStorage)) {
        state = previousState;
        studyLog = previousStudy;
        saveState();
        StudyLog.save(studyLog, localStorage);
        showToast(
          "Importazione annullata: lo storico Po-Tato non può essere salvato.",
        );
        return;
      }
      renderAll();
      window.dispatchEvent(new CustomEvent("tato:pomodoro-study-updated"));
      showToast("Backup importato correttamente.");
    } catch (error) {
      showToast(
        error.message || "Il file non è un backup valido di Tato Tracker.",
      );
    } finally {
      elements.importFile.value = "";
    }
  }

  async function resetData() {
    const accepted = await askConfirm({
      title: "Ricominciare da zero?",
      message:
        "Tutti gli obiettivi, i progressi e lo storico Po-Tato verranno eliminati. Esporta prima un backup se vuoi conservarli.",
      acceptLabel: "Cancella tutti i dati",
    });
    if (!accepted) return;
    const previousState = cloneState();
    const previousStudy = studyLog;
    state = createEmptyState();
    studyLog = StudyLog.emptyLog();
    if (!commitOrRollback(previousState)) {
      studyLog = previousStudy;
      return;
    }
    if (!StudyLog.save(studyLog, localStorage)) {
      state = previousState;
      studyLog = previousStudy;
      saveState();
      StudyLog.save(studyLog, localStorage);
      showToast(
        "Reset annullato: lo storico Po-Tato non può essere aggiornato.",
      );
      return;
    }
    calendarCursor = firstOfMonth(Planner.todayKey());
    renderAll();
    window.dispatchEvent(new CustomEvent("tato:pomodoro-study-updated"));
    showToast("Spazio pulito. Puoi creare un nuovo obiettivo quando vuoi.");
  }

  function toggleTheme() {
    const current =
      document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {
      /* Theme still applies for the session. */
    }
    updateThemeControl();
  }

  function updateThemeControl() {
    const dark = document.documentElement.dataset.theme === "dark";
    elements.themeToggle.setAttribute(
      "aria-label",
      dark ? "Attiva tema chiaro" : "Attiva tema scuro",
    );
    $('meta[name="theme-color"]').setAttribute(
      "content",
      dark ? "#151a17" : "#f3f0e8",
    );
  }

  function bindEvents() {
    elements.themeToggle.addEventListener("click", toggleTheme);
    elements.autoRedistribute.addEventListener("change", () => {
      const previousState = cloneState();
      state.settings.autoRedistribute = elements.autoRedistribute.checked;
      state.goals = state.goals.map((goal) => ({
        ...goal,
        autoRedistribute: elements.autoRedistribute.checked,
      }));
      if (!commitOrRollback(previousState)) {
        elements.autoRedistribute.checked = state.settings.autoRedistribute;
        return;
      }
      showToast(
        elements.autoRedistribute.checked
          ? "Ridistribuzione automatica attiva."
          : "Ridistribuzione automatica in pausa.",
      );
    });

    document.addEventListener("click", (event) => {
      const openButton = event.target.closest("[data-open-goal]");
      if (openButton) openGoalDialog();

      const editButton = event.target.closest("[data-edit-goal]");
      if (editButton) openGoalDialog(editButton.dataset.editGoal);

      const closeButton = event.target.closest("[data-close-dialog]");
      if (closeButton) closeButton.closest("dialog")?.close();

      const calendarScroll = event.target.closest("[data-scroll-calendar]");
      if (calendarScroll)
        $("#calendar-section").scrollIntoView({
          behavior: "smooth",
          block: "start",
        });

      const stepButton = event.target.closest("[data-step]");
      if (stepButton) {
        const input = $(
          'input[name="done"]',
          stepButton.closest("[data-progress-form]"),
        );
        input.value = Math.max(
          0,
          Number(input.value || 0) + Number(stepButton.dataset.step),
        );
      }
    });

    elements.todayList.addEventListener("submit", handleTodaySubmit);
    elements.goalForm.addEventListener("submit", handleGoalSubmit);
    elements.goalForm.addEventListener("change", (event) => {
      if (event.target.matches('input[name="scheduleMode"]')) {
        setScheduleMode(event.target.value, {
          seed:
            event.target.value === "specific" &&
            !specificSelectionInitialized &&
            Boolean($("#goal-id").value),
        });
      }
      if (event.target.matches("#goal-start, #goal-due")) {
        if (!$("#goal-id").value)
          $("#goal-due").min = $("#goal-start").value || Planner.todayKey();
        if (
          $('input[name="scheduleMode"]:checked', elements.goalForm).value ===
          "specific"
        ) {
          renderSpecificDatePicker();
        }
      }
      if (event.target.matches('input[name="studyDates"]')) {
        if (event.target.checked) specificDateSelection.add(event.target.value);
        else specificDateSelection.delete(event.target.value);
        updateSpecificDateSummary();
      }
    });
    $("#goal-pages").addEventListener("input", updateSpecificDateSummary);
    $("#select-all-dates").addEventListener("click", () => {
      const dates = dateKeysInRange(
        $("#goal-start").value,
        $("#goal-due").value,
      );
      if (
        dates.length &&
        dayDistance($("#goal-start").value, $("#goal-due").value) <= 730
      ) {
        specificDateSelection = new Set(dates);
        specificSelectionInitialized = true;
        renderSpecificDatePicker();
      }
    });
    $("#clear-all-dates").addEventListener("click", () => {
      specificDateSelection.clear();
      specificSelectionInitialized = true;
      renderSpecificDatePicker();
    });
    elements.dayForm.addEventListener("submit", handleDaySubmit);
    $("#delete-goal").addEventListener("click", deleteCurrentGoal);

    elements.calendarGrid.addEventListener("click", (event) => {
      const day = event.target.closest("[data-date]");
      if (day) {
        $$(".calendar-day", elements.calendarGrid).forEach((item) => {
          item.tabIndex = item === day ? 0 : -1;
        });
        openDayDialog(day.dataset.date);
      }
    });
    elements.calendarGrid.addEventListener("keydown", handleCalendarKeydown);
    $("#calendar-prev").addEventListener("click", () => {
      calendarCursor = shiftMonth(calendarCursor, -1);
      renderCalendar();
    });
    $("#calendar-next").addEventListener("click", () => {
      calendarCursor = shiftMonth(calendarCursor, 1);
      renderCalendar();
    });
    $("#calendar-today").addEventListener("click", () => {
      calendarCursor = firstOfMonth(Planner.todayKey());
      renderCalendar();
    });
    window.addEventListener("tato:pomodoro-study-updated", () => {
      studyLog = StudyLog.load(localStorage);
      renderCalendar();
    });
    window.addEventListener("storage", (event) => {
      if (event.key !== StudyLog.STORAGE_KEY) return;
      studyLog = StudyLog.load(localStorage);
      renderCalendar();
    });

    $("#day-rest").addEventListener("change", (event) => {
      $$(".day-task-row", elements.dayForm).forEach((row) =>
        row.classList.toggle("is-disabled", event.target.checked),
      );
      $$(".day-planned", elements.dayForm).forEach((input) => {
        input.disabled = event.target.checked;
      });
    });

    $("#export-data").addEventListener("click", exportData);
    $("#import-data").addEventListener("click", () =>
      elements.importFile.click(),
    );
    elements.importFile.addEventListener("change", () =>
      importData(elements.importFile.files[0]),
    );
    $("#reset-data").addEventListener("click", resetData);

    $("#confirm-cancel").addEventListener("click", () => settleConfirm(false));
    $("#confirm-accept").addEventListener("click", () => settleConfirm(true));
    elements.confirmDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      settleConfirm(false);
    });
    elements.confirmDialog.addEventListener("close", () => {
      if (confirmResolver) settleConfirm(false);
    });
  }

  bindEvents();
  updateThemeControl();
  renderAll();
  if (!loadFailed) saveState();

  if (loadNotice) {
    window.setTimeout(() => showToast(loadNotice), 250);
  } else if (state.settings.sampleData) {
    window.setTimeout(
      () =>
        showToast(
          "Ti mostro un piano di esempio. Personalizzalo oppure usa “Ricomincia” per partire da zero.",
        ),
      450,
    );
  }
})();

(function initTatoPlanner(root, factory) {
  'use strict';

  var api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.TatoPlanner = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function makeTatoPlanner(root) {
  'use strict';

  var DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function toDateKey(value) {
    if (typeof value === 'string' && DATE_KEY_RE.test(value)) {
      parseDateKey(value);
      return value;
    }

    var date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError('Invalid date');
    }

    return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join('-');
  }

  function todayKey() {
    return toDateKey(new Date());
  }

  function parseDateKey(key) {
    if (typeof key !== 'string') {
      throw new TypeError('Date key must be a YYYY-MM-DD string');
    }

    var match = DATE_KEY_RE.exec(key);
    if (!match) {
      throw new TypeError('Date key must use the YYYY-MM-DD format');
    }

    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var date = new Date(year, month - 1, day);

    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      throw new RangeError('Invalid calendar date: ' + key);
    }

    return date;
  }

  function addDaysKey(key, amount) {
    if (!Number.isInteger(amount)) {
      throw new TypeError('Day offset must be an integer');
    }

    var date = parseDateKey(key);
    date.setDate(date.getDate() + amount);
    return toDateKey(date);
  }

  function isDateKey(value) {
    try {
      parseDateKey(value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function canonicalMode(rule) {
    var mode = rule && typeof rule === 'object' ? rule.mode : rule;
    if (mode === 'free') return 'off';
    if (mode === 'available' || mode === 'work') return 'study';
    return mode;
  }

  function configTitle(config) {
    return config.title != null ? config.title : config.name;
  }

  function configTotal(config) {
    if (config.totalPages != null) return config.totalPages;
    if (config.pages != null) return config.pages;
    return config.total;
  }

  function configStart(config) {
    return config.startDate == null ? todayKey() : config.startDate;
  }

  function configEnd(config) {
    if (config.endDate != null) return config.endDate;
    if (config.dueDate != null) return config.dueDate;
    return config.deadline;
  }

  function configRestWeekdays(config) {
    if (config.restWeekdays != null) return config.restWeekdays;
    if (config.freeWeekdays != null) return config.freeWeekdays;
    return [];
  }

  function validateGoalConfig(config) {
    var errors = [];

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { valid: false, errors: ['Goal config must be an object'] };
    }

    var title = configTitle(config);
    var totalPages = configTotal(config);
    var startDate = configStart(config);
    var endDate = configEnd(config);
    var restWeekdays = configRestWeekdays(config);

    if (typeof title !== 'string' || !title.trim()) {
      errors.push('title is required');
    }

    if (!Number.isInteger(totalPages) || totalPages <= 0) {
      errors.push('totalPages must be a positive integer');
    }

    if (!isDateKey(startDate)) {
      errors.push('startDate must be a valid YYYY-MM-DD date');
    }

    if (!isDateKey(endDate)) {
      errors.push('endDate must be a valid YYYY-MM-DD date');
    }

    if (isDateKey(startDate) && isDateKey(endDate) && startDate > endDate) {
      errors.push('startDate cannot be after endDate');
    }

    if (
      !Array.isArray(restWeekdays) ||
      restWeekdays.some(function invalidWeekday(day) {
        return !Number.isInteger(day) || day < 0 || day > 6;
      })
    ) {
      errors.push('restWeekdays must contain only integers from 0 (Sunday) to 6');
    }

    if (config.autoRedistribute != null && typeof config.autoRedistribute !== 'boolean') {
      errors.push('autoRedistribute must be boolean');
    }

    validateDateRules(config.dateRules, errors);
    validateAllocations(config.allocations, errors);
    validateProgress(config.progress, errors);

    return { valid: errors.length === 0, errors: errors };
  }

  function validateDateRules(dateRules, errors) {
    if (dateRules == null) return;
    if (typeof dateRules !== 'object' || Array.isArray(dateRules)) {
      errors.push('dateRules must be an object keyed by date');
      return;
    }

    Object.keys(dateRules).forEach(function validateRule(date) {
      if (!isDateKey(date)) {
        errors.push('Invalid dateRules date: ' + date);
      }
      var mode = canonicalMode(dateRules[date]);
      if (mode !== 'off' && mode !== 'study') {
        errors.push('dateRules[' + date + '] must be "off" or "study"');
      }
    });
  }

  function validateAllocations(allocations, errors) {
    if (allocations == null) return;
    if (typeof allocations !== 'object' || Array.isArray(allocations)) {
      errors.push('allocations must be an object keyed by date');
      return;
    }

    Object.keys(allocations).forEach(function validateAllocation(date) {
      var allocation = allocations[date];
      if (!isDateKey(date)) {
        errors.push('Invalid allocations date: ' + date);
      }
      if (
        !allocation ||
        typeof allocation !== 'object' ||
        !Number.isInteger(allocation.planned) ||
        allocation.planned < 0
      ) {
        errors.push('allocations[' + date + '].planned must be a non-negative integer');
      } else if (allocation.source != null && allocation.source !== 'auto' && allocation.source !== 'manual') {
        errors.push('allocations[' + date + '].source must be "auto" or "manual"');
      }
    });
  }

  function validateProgress(progress, errors) {
    if (progress == null) return;
    if (typeof progress !== 'object' || Array.isArray(progress)) {
      errors.push('progress must be an object keyed by date');
      return;
    }

    Object.keys(progress).forEach(function validateProgressEntry(date) {
      var entry = progress[date];
      var done = typeof entry === 'number' ? entry : entry && entry.done;
      if (!isDateKey(date)) {
        errors.push('Invalid progress date: ' + date);
      }
      if (!Number.isInteger(done) || done < 0) {
        errors.push('progress[' + date + '].done must be a non-negative integer');
      }
    });
  }

  function cloneRule(rule) {
    return rule && typeof rule === 'object' ? Object.assign({}, rule) : rule;
  }

  function cloneGoal(goal) {
    var copy = Object.assign({}, goal);
    copy.restWeekdays = Array.isArray(goal.restWeekdays) ? goal.restWeekdays.slice() : [];
    copy.dateRules = {};
    copy.allocations = {};
    copy.progress = {};

    Object.keys(goal.dateRules || {}).forEach(function cloneDateRule(date) {
      copy.dateRules[date] = cloneRule(goal.dateRules[date]);
    });
    Object.keys(goal.allocations || {}).forEach(function cloneAllocation(date) {
      var allocation = goal.allocations[date];
      copy.allocations[date] = {
        planned: allocation.planned,
        source: allocation.source === 'manual' ? 'manual' : 'auto'
      };
    });
    Object.keys(goal.progress || {}).forEach(function cloneProgress(date) {
      var entry = goal.progress[date];
      copy.progress[date] = typeof entry === 'number' ? { done: entry } : Object.assign({}, entry);
    });

    return copy;
  }

  function newGoalId() {
    if (root && root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'goal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function createGoal(config) {
    var result = validateGoalConfig(config);
    if (!result.valid) {
      throw new TypeError('Invalid goal config: ' + result.errors.join('; '));
    }

    var dateRules = {};
    Object.keys(config.dateRules || {}).forEach(function normalizeRule(date) {
      dateRules[date] = canonicalMode(config.dateRules[date]);
    });

    var allocations = {};
    Object.keys(config.allocations || {}).forEach(function normalizeAllocation(date) {
      allocations[date] = {
        planned: config.allocations[date].planned,
        source: config.allocations[date].source === 'manual' ? 'manual' : 'auto'
      };
    });

    var progress = {};
    Object.keys(config.progress || {}).forEach(function normalizeProgress(date) {
      var entry = config.progress[date];
      progress[date] = typeof entry === 'number' ? { done: entry } : Object.assign({}, entry);
    });

    var goal = {
      id: config.id || newGoalId(),
      subjectId: config.subjectId || null,
      title: configTitle(config).trim(),
      color: config.color || null,
      totalPages: configTotal(config),
      startDate: configStart(config),
      endDate: configEnd(config),
      restWeekdays: Array.from(new Set(configRestWeekdays(config))).sort(),
      dateRules: dateRules,
      allocations: allocations,
      progress: progress,
      autoRedistribute: config.autoRedistribute !== false,
      unscheduled: 0,
      overplanned: 0
    };

    return rescheduleGoal(goal, { fromDate: goal.startDate });
  }

  function assertGoal(goal) {
    if (!goal || typeof goal !== 'object') {
      throw new TypeError('Goal must be an object');
    }
    if (!Number.isInteger(goal.totalPages) || goal.totalPages <= 0) {
      throw new TypeError('Goal totalPages must be a positive integer');
    }
    parseDateKey(goal.startDate);
    parseDateKey(goal.endDate);
    if (goal.startDate > goal.endDate) {
      throw new RangeError('Goal startDate cannot be after endDate');
    }
  }

  function progressDone(entry) {
    return typeof entry === 'number' ? entry : entry && entry.done;
  }

  function completedPages(goal) {
    return Object.keys(goal.progress || {}).reduce(function sumProgress(sum, date) {
      var done = progressDone(goal.progress[date]);
      return sum + (Number.isInteger(done) && done >= 0 ? done : 0);
    }, 0);
  }

  function hasProgress(goal, date) {
    return Object.prototype.hasOwnProperty.call(goal.progress || {}, date);
  }

  function isStudyDay(goal, date) {
    var rule = canonicalMode((goal.dateRules || {})[date]);
    if (rule === 'off') return false;
    if (rule === 'study') return true;
    return !(goal.restWeekdays || []).includes(parseDateKey(date).getDay());
  }

  function dateRange(startDate, endDate) {
    if (startDate > endDate) return [];
    var dates = [];
    var cursor = startDate;
    var guard = 0;
    while (cursor <= endDate) {
      dates.push(cursor);
      cursor = addDaysKey(cursor, 1);
      guard += 1;
      if (guard > 40000) {
        throw new RangeError('Goal date range is too large');
      }
    }
    return dates;
  }

  function rescheduleGoal(goal, options) {
    assertGoal(goal);
    options = options || {};
    var requestedFrom = options.fromDate == null ? todayKey() : toDateKey(options.fromDate);
    var fromDate = requestedFrom < goal.startDate ? goal.startDate : requestedFrom;
    var copy = cloneGoal(goal);
    var previousAllocations = cloneGoal(goal).allocations;

    Object.keys(copy.allocations).forEach(function removeAdjustableAllocation(date) {
      if (date >= fromDate && !hasProgress(copy, date)) {
        delete copy.allocations[date];
      }
    });

    var candidates = dateRange(fromDate, copy.endDate).filter(function candidate(date) {
      return isStudyDay(copy, date) && !hasProgress(copy, date);
    });
    var manualDates = [];
    var autoDates = [];

    candidates.forEach(function classify(date) {
      var previous = previousAllocations[date];
      if (previous && previous.source === 'manual') {
        copy.allocations[date] = { planned: previous.planned, source: 'manual' };
        manualDates.push(date);
      } else {
        autoDates.push(date);
      }
    });

    var remaining = Math.max(0, copy.totalPages - completedPages(copy));
    var manualTotal = manualDates.reduce(function sumManual(sum, date) {
      return sum + copy.allocations[date].planned;
    }, 0);
    var autoBudget = Math.max(0, remaining - manualTotal);
    var each = autoDates.length ? Math.floor(autoBudget / autoDates.length) : 0;
    var remainder = autoDates.length ? autoBudget % autoDates.length : 0;

    autoDates.forEach(function allocate(date, index) {
      copy.allocations[date] = {
        planned: each + (index < remainder ? 1 : 0),
        source: 'auto'
      };
    });

    var autoTotal = each * autoDates.length + remainder;
    copy.unscheduled = Math.max(0, remaining - manualTotal - autoTotal);
    copy.overplanned = Math.max(0, manualTotal - remaining);
    copy.planRevision = (Number.isInteger(goal.planRevision) ? goal.planRevision : 0) + 1;

    return copy;
  }

  function latestProgressDate(goal) {
    var dates = Object.keys(goal.progress || {}).filter(isDateKey).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  function earliestAdjustableDate(goal) {
    var fromDate = goal.startDate > todayKey() ? goal.startDate : todayKey();
    var latest = latestProgressDate(goal);
    if (latest) {
      var afterLatest = addDaysKey(latest, 1);
      if (afterLatest > fromDate) fromDate = afterLatest;
    }
    return fromDate;
  }

  function reconcilePlanGap(goal, fromDate) {
    var copy = cloneGoal(goal);
    var remaining = Math.max(0, copy.totalPages - completedPages(copy));
    var planned = Object.keys(copy.allocations).reduce(function sumFuture(sum, date) {
      if (date < fromDate || date > copy.endDate || hasProgress(copy, date)) return sum;
      return sum + copy.allocations[date].planned;
    }, 0);
    copy.unscheduled = Math.max(0, remaining - planned);
    copy.overplanned = Math.max(0, planned - remaining);
    return copy;
  }

  function recordProgress(goal, date, done, options) {
    assertGoal(goal);
    date = toDateKey(date);
    if (!Number.isInteger(done) || done < 0) {
      throw new TypeError('done must be a non-negative integer');
    }

    var copy = cloneGoal(goal);
    copy.progress[date] = { done: done };
    options = options || {};
    var redistribute = options.redistribute == null ? copy.autoRedistribute !== false : options.redistribute;
    var fromDate = addDaysKey(date, 1);
    var latest = latestProgressDate(copy);
    if (latest && addDaysKey(latest, 1) > fromDate) fromDate = addDaysKey(latest, 1);
    if (todayKey() > fromDate) fromDate = todayKey();
    if (copy.startDate > fromDate) fromDate = copy.startDate;

    return redistribute
      ? rescheduleGoal(copy, { fromDate: fromDate })
      : reconcilePlanGap(copy, fromDate);
  }

  function setPlanned(goal, date, planned, options) {
    assertGoal(goal);
    date = toDateKey(date);
    if (date < goal.startDate || date > goal.endDate) {
      throw new RangeError('Planned date must be inside the goal range');
    }
    if (planned != null && (!Number.isInteger(planned) || planned < 0)) {
      throw new TypeError('planned must be a non-negative integer or null');
    }

    var copy = cloneGoal(goal);
    if (planned == null) {
      delete copy.allocations[date];
    } else {
      copy.allocations[date] = { planned: planned, source: 'manual' };
      if (planned > 0 && !isStudyDay(copy, date)) {
        copy.dateRules[date] = 'study';
      }
    }

    options = options || {};
    var redistribute = options.redistribute !== false;
    var fromDate = earliestAdjustableDate(copy);
    return redistribute
      ? rescheduleGoal(copy, { fromDate: fromDate })
      : reconcilePlanGap(copy, fromDate);
  }

  function setDateRule(goal, date, mode) {
    assertGoal(goal);
    date = toDateKey(date);
    if (date < goal.startDate || date > goal.endDate) {
      throw new RangeError('Date rule must be inside the goal range');
    }

    var normalizedMode = canonicalMode(mode);
    var copy = cloneGoal(goal);
    if (mode == null || normalizedMode === 'default') {
      delete copy.dateRules[date];
    } else if (normalizedMode === 'off' || normalizedMode === 'study') {
      copy.dateRules[date] = normalizedMode;
    } else {
      throw new TypeError('mode must be "off", "study", or "default"');
    }

    return rescheduleGoal(copy, { fromDate: earliestAdjustableDate(copy) });
  }

  function goalStats(goal) {
    assertGoal(goal);
    var completed = completedPages(goal);
    var remaining = Math.max(0, goal.totalPages - completed);
    var extra = Math.max(0, completed - goal.totalPages);
    var fromDate = earliestAdjustableDate(goal);
    var plannedRemaining = Object.keys(goal.allocations || {}).reduce(function sumPlanned(sum, date) {
      if (date < fromDate || date > goal.endDate || hasProgress(goal, date)) return sum;
      var planned = goal.allocations[date] && goal.allocations[date].planned;
      return sum + (Number.isInteger(planned) && planned >= 0 ? planned : 0);
    }, 0);
    var percent = Math.min(100, (completed / goal.totalPages) * 100);

    return {
      totalPages: goal.totalPages,
      completedPages: completed,
      remainingPages: remaining,
      extraPages: extra,
      completionPercent: percent,
      completed: completed,
      remaining: remaining,
      percent: percent,
      plannedRemaining: plannedRemaining,
      unscheduled: Math.max(0, remaining - plannedRemaining),
      overplanned: Math.max(0, plannedRemaining - remaining),
      isComplete: completed >= goal.totalPages
    };
  }

  return Object.freeze({
    todayKey: todayKey,
    toDateKey: toDateKey,
    parseDateKey: parseDateKey,
    addDaysKey: addDaysKey,
    createGoal: createGoal,
    rescheduleGoal: rescheduleGoal,
    recordProgress: recordProgress,
    setPlanned: setPlanned,
    setDateRule: setDateRule,
    goalStats: goalStats,
    validateGoalConfig: validateGoalConfig
  });
});

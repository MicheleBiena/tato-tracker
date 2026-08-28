'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Planner = require('../planner.js');

function futureRange(days, totalPages = 10, extra = {}) {
  const startDate = Planner.addDaysKey(Planner.todayKey(), 1);
  return Planner.createGoal({
    id: 'test-goal',
    title: 'Analisi',
    totalPages,
    startDate,
    endDate: Planner.addDaysKey(startDate, days - 1),
    ...extra
  });
}

test('date helpers use strict local YYYY-MM-DD keys', () => {
  assert.equal(Planner.toDateKey(Planner.parseDateKey('2024-02-29')), '2024-02-29');
  assert.equal(Planner.addDaysKey('2024-02-28', 2), '2024-03-01');
  assert.throws(() => Planner.parseDateKey('2023-02-29'), /Invalid calendar date/);
  assert.throws(() => Planner.addDaysKey('2024-01-01', 0.5), /integer/);
});

test('validateGoalConfig reports all basic config errors without throwing', () => {
  const result = Planner.validateGoalConfig({
    title: ' ',
    totalPages: 0,
    startDate: '2026-02-30',
    endDate: 'not-a-date',
    restWeekdays: [7]
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 5);
  assert.throws(() => Planner.createGoal({ title: '', totalPages: -1, endDate: 'x' }), /Invalid goal config/);
});

test('createGoal distributes integer pages evenly with deterministic early remainder', () => {
  const goal = Planner.createGoal({
    id: 'even',
    title: 'Storia',
    totalPages: 10,
    startDate: '2030-01-01',
    endDate: '2030-01-03'
  });

  assert.deepEqual(
    Object.values(goal.allocations).map((entry) => entry.planned),
    [4, 3, 3]
  );
  assert.equal(goal.unscheduled, 0);
});

test('weekly rest days and explicit study/off rules determine eligible dates', () => {
  const startDate = Planner.addDaysKey(Planner.todayKey(), 1);
  const weekday = Planner.parseDateKey(startDate).getDay();
  let goal = Planner.createGoal({
    title: 'Fisica',
    totalPages: 5,
    startDate,
    endDate: startDate,
    restWeekdays: [weekday]
  });

  assert.equal(goal.unscheduled, 5);
  goal = Planner.setDateRule(goal, startDate, 'study');
  assert.deepEqual(goal.allocations[startDate], { planned: 5, source: 'auto' });
  goal = Planner.setDateRule(goal, startDate, 'off');
  assert.equal(goal.allocations[startDate], undefined);
  assert.equal(goal.unscheduled, 5);
});

test('specific-date mode can schedule only explicitly selected dates', () => {
  const startDate = Planner.addDaysKey(Planner.todayKey(), 1);
  const middleDate = Planner.addDaysKey(startDate, 2);
  const endDate = Planner.addDaysKey(startDate, 4);
  const goal = Planner.createGoal({
    title: 'Date scelte',
    totalPages: 9,
    startDate,
    endDate,
    restWeekdays: [0, 1, 2, 3, 4, 5, 6],
    dateRules: { [startDate]: 'study', [middleDate]: 'study', [endDate]: 'study' }
  });

  assert.deepEqual(Object.keys(goal.allocations), [startDate, middleDate, endDate]);
  assert.deepEqual(Object.values(goal.allocations).map((entry) => entry.planned), [3, 3, 3]);
  assert.equal(goal.unscheduled, 0);
});

test('manual planned values survive redistribution and auto days absorb the rest', () => {
  let goal = futureRange(3, 10);
  const dates = Object.keys(goal.allocations).sort();
  goal = Planner.setPlanned(goal, dates[1], 7, { redistribute: true });

  assert.deepEqual(goal.allocations[dates[1]], { planned: 7, source: 'manual' });
  assert.equal(goal.allocations[dates[0]].planned, 2);
  assert.equal(goal.allocations[dates[2]].planned, 1);
  assert.equal(goal.unscheduled, 0);
});

test('a zero manual override keeps that eligible day out of auto distribution', () => {
  let goal = futureRange(2, 6);
  const dates = Object.keys(goal.allocations).sort();
  goal = Planner.setPlanned(goal, dates[0], 0, { redistribute: true });

  assert.deepEqual(goal.allocations[dates[0]], { planned: 0, source: 'manual' });
  assert.deepEqual(goal.allocations[dates[1]], { planned: 6, source: 'auto' });
});

test('manual-only plans expose unscheduled and overplanned conflicts', () => {
  let goal = futureRange(2, 10);
  const dates = Object.keys(goal.allocations).sort();
  goal = Planner.setPlanned(goal, dates[0], 3);
  goal = Planner.setPlanned(goal, dates[1], 3);
  assert.equal(goal.unscheduled, 4);

  goal = Planner.setPlanned(goal, dates[0], 8);
  assert.equal(goal.allocations[dates[0]].planned, 8);
  assert.equal(goal.allocations[dates[1]].planned, 3);
  assert.equal(goal.overplanned, 1);
});

test('recordProgress replaces a daily value, preserves history, and redistributes the delta', () => {
  const startDate = Planner.todayKey();
  let goal = Planner.createGoal({
    title: 'Diritto',
    totalPages: 10,
    startDate,
    endDate: Planner.addDaysKey(startDate, 2)
  });
  const originalTodayPlan = goal.allocations[startDate];

  goal = Planner.recordProgress(goal, startDate, 2, { redistribute: true });
  assert.deepEqual(goal.allocations[startDate], originalTodayPlan);
  assert.deepEqual(goal.progress[startDate], { done: 2 });
  assert.equal(goal.allocations[Planner.addDaysKey(startDate, 1)].planned, 4);
  assert.equal(goal.allocations[Planner.addDaysKey(startDate, 2)].planned, 4);

  goal = Planner.recordProgress(goal, startDate, 3, { redistribute: true });
  assert.equal(Planner.goalStats(goal).completedPages, 3, 'editing replaces rather than adds progress');
});

test('opting out of redistribution preserves future targets and exposes the plan gap', () => {
  const startDate = Planner.todayKey();
  let goal = Planner.createGoal({
    title: 'Biologia',
    totalPages: 10,
    startDate,
    endDate: Planner.addDaysKey(startDate, 2),
    autoRedistribute: false
  });
  const tomorrow = Planner.addDaysKey(startDate, 1);
  const before = goal.allocations[tomorrow].planned;

  goal = Planner.recordProgress(goal, startDate, 2, { redistribute: false });
  assert.equal(goal.allocations[tomorrow].planned, before);
  assert.equal(goal.unscheduled, 2);

  goal = Planner.recordProgress(goal, startDate, 6, { redistribute: false });
  assert.equal(goal.overplanned, 2);
});

test('progress beyond the target is capped at 100 percent and reported as extra', () => {
  let goal = futureRange(1, 5);
  goal = Planner.recordProgress(goal, goal.startDate, 8, { redistribute: true });
  const stats = Planner.goalStats(goal);

  assert.equal(stats.completedPages, 8);
  assert.equal(stats.remainingPages, 0);
  assert.equal(stats.extraPages, 3);
  assert.equal(stats.completionPercent, 100);
  assert.equal(stats.isComplete, true);
});

test('rescheduleGoal preserves allocations before fromDate and logged-day history', () => {
  let goal = futureRange(4, 12);
  const dates = Object.keys(goal.allocations).sort();
  const firstPlan = goal.allocations[dates[0]];
  goal = Planner.recordProgress(goal, dates[0], 1, { redistribute: true });
  goal = Planner.rescheduleGoal(goal, { fromDate: dates[1] });

  assert.deepEqual(goal.allocations[dates[0]], firstPlan);
  assert.equal(goal.progress[dates[0]].done, 1);
  assert.equal(
    dates.slice(1).reduce((sum, date) => sum + goal.allocations[date].planned, 0),
    11
  );
});

test('CommonJS export is also installed as the browser-style global API', () => {
  assert.equal(globalThis.TatoPlanner, Planner);
});

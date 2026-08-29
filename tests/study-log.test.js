'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const StudyLog = require('../study-log');

test('study log deduplicates completed focus events', () => {
  const event = { id: 'focus-1', completedAt: new Date(2026, 7, 29, 10).getTime(), durationSeconds: 1500, session: 1 };
  const first = StudyLog.addEvents(StudyLog.emptyLog(), [event, event]);
  assert.equal(first.added.length, 1);
  assert.equal(first.log.events.length, 1);

  const second = StudyLog.addEvents(first.log, [event]);
  assert.equal(second.added.length, 0);
  assert.equal(second.log.events.length, 1);
});

test('study log aggregates sessions by local completion date', () => {
  const firstDay = new Date(2026, 7, 29, 23, 55).getTime();
  const secondDay = new Date(2026, 7, 30, 0, 25).getTime();
  const result = StudyLog.addEvents(StudyLog.emptyLog(), [
    { completedAt: firstDay, durationSeconds: 1500, session: 1 },
    { completedAt: secondDay, durationSeconds: 1500, session: 2 },
    { completedAt: secondDay + 1_800_000, durationSeconds: 1500, session: 3 }
  ]);

  assert.deepEqual(StudyLog.summaryForDate(result.log, '2026-08-29'), { seconds: 1500, sessions: 1 });
  assert.deepEqual(StudyLog.summaryForDate(result.log, '2026-08-30'), { seconds: 3000, sessions: 2 });
});

test('study duration uses readable long and compact labels', () => {
  assert.equal(StudyLog.formatDuration(18_000), '5 ore');
  assert.equal(StudyLog.formatDuration(5_400), '1 ora e 30 min');
  assert.equal(StudyLog.formatDuration(1_500, true), '25m');
});

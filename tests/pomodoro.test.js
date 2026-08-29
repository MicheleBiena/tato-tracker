'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Pomodoro = require('../pomodoro-engine');

test('Pomodoro config is normalized to safe integer limits', () => {
  assert.deepEqual(Pomodoro.normalizeConfig({
    sessions: 0,
    focusMinutes: 999,
    shortBreakMinutes: '7.8',
    longBreakEnabled: false,
    longBreakEvery: 1,
    longBreakMinutes: -4
  }), {
    sessions: 1,
    focusMinutes: 180,
    shortBreakMinutes: 7,
    longBreakEnabled: false,
    longBreakEvery: 2,
    longBreakMinutes: 1
  });
});

test('a timer starts, pauses without drift and resumes from its remaining time', () => {
  let timer = Pomodoro.createTimer({ focusMinutes: 1 });
  timer = Pomodoro.startTimer(timer, 1_000);
  timer = Pomodoro.syncTimer(timer, 21_000);
  assert.equal(timer.remainingSeconds, 40);

  timer = Pomodoro.pauseTimer(timer, 21_000);
  assert.equal(timer.running, false);
  assert.equal(timer.endsAt, null);
  assert.equal(Pomodoro.syncTimer(timer, 121_000).remainingSeconds, 40);

  timer = Pomodoro.startTimer(timer, 121_000);
  assert.equal(timer.endsAt, 161_000);
});

test('focus sessions alternate with breaks and use a long break at the chosen cadence', () => {
  const config = {
    sessions: 4,
    focusMinutes: 1,
    shortBreakMinutes: 2,
    longBreakEnabled: true,
    longBreakEvery: 2,
    longBreakMinutes: 6
  };
  let timer = Pomodoro.createTimer(config);

  timer = Pomodoro.advancePhase(timer);
  assert.equal(timer.phase, 'shortBreak');
  assert.equal(timer.completedSessions, 1);
  assert.equal(timer.totalSeconds, 120);

  timer = Pomodoro.advancePhase(timer);
  assert.equal(timer.phase, 'focus');
  assert.equal(timer.session, 2);

  timer = Pomodoro.advancePhase(timer);
  assert.equal(timer.phase, 'longBreak');
  assert.equal(timer.completedSessions, 2);
  assert.equal(timer.totalSeconds, 360);
});

test('finishing the final focus session completes and stops the cycle', () => {
  let timer = Pomodoro.createTimer({ sessions: 1, focusMinutes: 1 });
  timer = Pomodoro.startTimer(timer, 0);
  timer = Pomodoro.syncTimer(timer, 60_000);
  assert.equal(timer.phase, 'complete');
  assert.equal(timer.completedSessions, 1);
  assert.equal(timer.running, false);
  assert.equal(timer.remainingSeconds, 0);
});

test('sync catches up across several phases after a backgrounded tab', () => {
  let timer = Pomodoro.createTimer({
    sessions: 3,
    focusMinutes: 1,
    shortBreakMinutes: 1,
    longBreakEnabled: true,
    longBreakEvery: 2,
    longBreakMinutes: 2
  });
  timer = Pomodoro.startTimer(timer, 1);
  timer = Pomodoro.syncTimer(timer, 300_001);
  assert.equal(timer.phase, 'focus');
  assert.equal(timer.session, 3);
  assert.equal(timer.completedSessions, 2);
  assert.equal(timer.remainingSeconds, 60);
  assert.equal(timer.running, true);
});

test('skipping preserves the running state and progress grows only during focus', () => {
  let timer = Pomodoro.createTimer({ sessions: 2, focusMinutes: 1, shortBreakMinutes: 1 });
  timer = Pomodoro.startTimer(timer, 0);
  timer = Pomodoro.syncTimer(timer, 30_000);
  const duringFocus = Pomodoro.timerProgress(timer);
  assert.equal(duringFocus.phase, 0.5);
  assert.equal(duringFocus.overall, 0.25);

  timer = Pomodoro.skipPhase(timer, 30_000);
  assert.equal(timer.phase, 'shortBreak');
  assert.equal(timer.running, true);
  assert.equal(Pomodoro.timerProgress(timer).overall, 0.5);
});

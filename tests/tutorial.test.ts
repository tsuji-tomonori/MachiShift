import { expect, it } from 'vitest';
import { TutorialProgress, type TutorialObservation } from '../src/tutorial';

const idle: TutorialObservation = { active: true, speed: 0, steer: 0, boost: 0, aiming: false };
const all: TutorialObservation = { active: true, speed: 5, steer: 1, boost: 1, aiming: true };

it('GAME-09 six lessons require current driving, drift, aim, throw and recovery', () => {
  const tutorial = new TutorialProgress();
  expect(tutorial.update(.31, idle)).toBe(false);
  expect(tutorial.update(.31, { ...idle, speed: 5 })).toBe(true); expect(tutorial.step).toBe(1);
  expect(tutorial.update(.31, { ...idle, steer: 1 })).toBe(false);
  expect(tutorial.update(.31, { ...idle, speed: 3, steer: 1 })).toBe(true); expect(tutorial.step).toBe(2);
  expect(tutorial.update(.11, { ...idle, boost: 1 })).toBe(true); expect(tutorial.step).toBe(3);
  expect(tutorial.update(.11, { ...idle, aiming: true })).toBe(true); expect(tutorial.step).toBe(4);
  expect(tutorial.update(.11, all)).toBe(false);
  tutorial.record('throw'); expect(tutorial.update(.11, idle)).toBe(true); expect(tutorial.step).toBe(5);
  expect(tutorial.update(.11, all)).toBe(false);
  tutorial.record('recover'); expect(tutorial.update(.11, idle)).toBe(true); expect(tutorial.complete).toBe(true);
  expect(tutorial.update(10, all)).toBe(false); expect(tutorial.step).toBe(6);
});

it('GAME-09 throwing/recovering early cannot silently pass later lessons', () => {
  const tutorial = new TutorialProgress();
  for (let step = 0; step < 4; step++) {
    tutorial.record('throw'); tutorial.record('recover'); tutorial.update(.31, all);
  }
  expect(tutorial.step).toBe(4); expect(tutorial.update(1, all)).toBe(false);
  tutorial.record('recover'); expect(tutorial.update(1, all)).toBe(false);
  tutorial.record('throw'); tutorial.update(.11, idle); expect(tutorial.step).toBe(5);
  expect(tutorial.update(1, all)).toBe(false);
});

it('GAME-09 pause/inactive phases and invalid time do not advance tutorial progress', () => {
  const tutorial = new TutorialProgress();
  tutorial.update(.2, all);
  for (const dt of [100, .2]) expect(tutorial.update(dt, { ...all, active: false })).toBe(false);
  for (const dt of [0, -1, NaN, Infinity]) expect(tutorial.update(dt, all)).toBe(false);
  expect(tutorial.step).toBe(0);
  expect(tutorial.update(.11, all)).toBe(true); expect(tutorial.step).toBe(1);
});

it('GAME-09 brief separated actions cannot accumulate into a sustained lesson completion', () => {
  const tutorial = new TutorialProgress();
  for (let i = 0; i < 5; i++) { tutorial.update(.2, all); tutorial.update(.1, idle); }
  expect(tutorial.step).toBe(0); tutorial.update(.31, all); expect(tutorial.step).toBe(1);
});

it('GAME-09 replay clears completion, partial progress and previously recorded actions', () => {
  const tutorial = new TutorialProgress();
  for (let i = 0; i < 4; i++) tutorial.update(.31, all);
  tutorial.record('throw'); tutorial.reset();
  expect(tutorial.step).toBe(0); expect(tutorial.complete).toBe(false);
  for (let i = 0; i < 4; i++) tutorial.update(.31, all);
  expect(tutorial.update(.11, all)).toBe(false);
});

import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';

import {User} from '../../core/User';
import {Handedness} from '../Hands';
import {GestureRecognition} from './GestureRecognition';
import {GestureRecognitionOptions} from './GestureRecognitionOptions';
import type {
  GestureRecognizer,
  GestureScoreMap,
  HandContext,
  HandGestureContext,
  HandLabel,
  PoseEstimator,
} from './GestureTypes';

describe('GestureRecognition temporal context', () => {
  it('clones samples, prunes history, and isolates hands', async () => {
    const estimator = new MutablePoseEstimator();
    const recognizer = new RecordingRecognizer();
    const options = createOptions(estimator, recognizer);
    options.historyDurationMs = 100;
    options.maximumSampleGapMs = 1000;
    const left = createContext('left', 1);
    const right = createContext('right', 10);
    estimator.left = left;
    estimator.right = right;
    const recognition = await createRecognition(options);

    recognition.update(0);
    left.getJoint('wrist')!.set(99, 99, 99);
    recognition.update(60);

    const leftAt60 = recognizer.contexts.left.at(-1)!;
    expect(leftAt60.samples).toHaveLength(2);
    expect(leftAt60.samples[0].getJoint('wrist')?.x).toBe(1);
    expect(recognizer.contexts.right.at(-1)?.samples).toHaveLength(2);

    estimator.right = null;
    recognition.update(160);
    expect(
      recognizer.contexts.left.at(-1)?.samples.map((s) => s.timestamp)
    ).toEqual([60, 160]);

    estimator.right = right;
    recognition.update(170);
    expect(recognizer.contexts.right.at(-1)?.samples).toHaveLength(1);
  });

  it('resets history on tracking loss and timestamp gaps', async () => {
    const estimator = new MutablePoseEstimator();
    const recognizer = new RecordingRecognizer();
    const options = createOptions(estimator, recognizer);
    options.maximumSampleGapMs = 100;
    estimator.left = createContext('left', 0);
    const recognition = await createRecognition(options);

    recognition.update(0);
    recognition.update(50);
    expect(recognizer.contexts.left.at(-1)?.samples).toHaveLength(2);

    estimator.left = null;
    recognition.update(60);
    estimator.left = createContext('left', 1);
    recognition.update(70);
    expect(recognizer.contexts.left.at(-1)?.samples).toHaveLength(1);

    recognition.update(200);
    expect(recognizer.contexts.left.at(-1)?.samples).toHaveLength(1);
  });

  it('does not publish stale asynchronous results after tracking loss', async () => {
    const estimator = new MutablePoseEstimator();
    estimator.left = createContext('left', 0);
    let resolveFirst!: (scores: GestureScoreMap) => void;
    const first = new Promise<GestureScoreMap>((resolve) => {
      resolveFirst = resolve;
    });
    const never = new Promise<GestureScoreMap>(() => undefined);
    let calls = 0;
    const recognizer: GestureRecognizer = {
      recognize: () => (calls++ === 0 ? first : never),
    };
    const options = createOptions(estimator, recognizer);
    options.setGestureEnabled('temporal', true);
    const recognition = await createRecognition(options);
    const listener = vi.fn();
    recognition.addEventListener('gesturestart', listener);

    recognition.update(0);
    estimator.left = null;
    recognition.update(10);
    resolveFirst({temporal: {confidence: 1}});
    await Promise.resolve();
    await Promise.resolve();

    estimator.left = createContext('left', 0);
    recognition.update(20);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not publish stale asynchronous results after a sample gap', async () => {
    const estimator = new MutablePoseEstimator();
    estimator.left = createContext('left', 0);
    let resolveFirst!: (scores: GestureScoreMap) => void;
    const first = new Promise<GestureScoreMap>((resolve) => {
      resolveFirst = resolve;
    });
    const never = new Promise<GestureScoreMap>(() => undefined);
    let calls = 0;
    const recognizer: GestureRecognizer = {
      recognize: () => (calls++ === 0 ? first : never),
    };
    const options = createOptions(estimator, recognizer);
    options.maximumSampleGapMs = 50;
    options.setGestureEnabled('temporal', true);
    const recognition = await createRecognition(options);
    const listener = vi.fn();
    recognition.addEventListener('gesturestart', listener);

    recognition.update(0);
    recognition.update(100);
    resolveFirst({temporal: {confidence: 1}});
    await Promise.resolve();
    await Promise.resolve();
    recognition.update(110);

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps immediate static start, update, and end behavior', async () => {
    const estimator = new MutablePoseEstimator();
    estimator.left = createContext('left', 0);
    const scores = [0.8, 0.9, 0.1];
    const recognizer: GestureRecognizer = {
      recognize: () => ({static: {confidence: scores.shift() ?? 0}}),
    };
    const options = createOptions(estimator, recognizer);
    options.setGestureEnabled('static', true);
    const recognition = await createRecognition(options);
    const events: string[] = [];
    recognition.addEventListener('gesturestart', () => events.push('start'));
    recognition.addEventListener('gestureupdate', () => events.push('update'));
    recognition.addEventListener('gestureend', () => events.push('end'));

    recognition.update(0);
    recognition.update(16);
    recognition.update(32);

    expect(events).toEqual(['start', 'update', 'end']);
  });

  it('publishes only the highest-confidence gesture for each hand', async () => {
    const estimator = new MutablePoseEstimator();
    estimator.left = createContext('left', 0);
    const scoreFrames = [
      {first: {confidence: 0.75}, second: {confidence: 0.9}},
      {first: {confidence: 0.95}, second: {confidence: 0.8}},
      {first: {confidence: 0.2}, second: {confidence: 0.1}},
    ];
    const recognizer: GestureRecognizer = {
      recognize: () => scoreFrames.shift() ?? {},
    };
    const options = createOptions(estimator, recognizer);
    options.setGestureEnabled('first', true);
    options.setGestureEnabled('second', true);
    const recognition = await createRecognition(options);
    const active = new Set<string>();
    const events: string[] = [];
    let maximumActive = 0;
    recognition.addEventListener('gesturestart', (event) => {
      active.add(event.detail.name);
      maximumActive = Math.max(maximumActive, active.size);
      events.push(`start:${event.detail.name}`);
    });
    recognition.addEventListener('gestureend', (event) => {
      active.delete(event.detail.name);
      events.push(`end:${event.detail.name}`);
    });

    recognition.update(0);
    recognition.update(16);
    recognition.update(32);

    expect(maximumActive).toBe(1);
    expect(events).toEqual([
      'start:second',
      'end:second',
      'start:first',
      'end:first',
    ]);
  });
});

class MutablePoseEstimator implements PoseEstimator {
  left: HandContext | null = null;
  right: HandContext | null = null;

  getHandContext(handedness: Handedness) {
    if (handedness === Handedness.LEFT) return this.left;
    if (handedness === Handedness.RIGHT) return this.right;
    return null;
  }

  getHandContexts() {
    return {
      ...(this.left ? {left: this.left} : {}),
      ...(this.right ? {right: this.right} : {}),
    };
  }
}

class RecordingRecognizer implements GestureRecognizer {
  contexts: Record<HandLabel, HandGestureContext[]> = {left: [], right: []};

  recognize(context: HandGestureContext) {
    this.contexts[context.handLabel].push(context);
    return {};
  }
}

function createContext(handLabel: HandLabel, wristX: number): HandContext {
  const handedness = handLabel === 'left' ? Handedness.LEFT : Handedness.RIGHT;
  const joints = new Map([['wrist' as const, new THREE.Vector3(wristX, 0, 0)]]);
  return {
    handedness,
    handLabel,
    joints,
    getJoint: (name) => joints.get(name),
  };
}

function createOptions(
  estimator: PoseEstimator,
  recognizer: GestureRecognizer
) {
  const options = new GestureRecognitionOptions()
    .setPoseEstimator(estimator)
    .setGestureRecognizer(recognizer)
    .enable();
  options.updateIntervalMs = 0;
  return options;
}

async function createRecognition(options: GestureRecognitionOptions) {
  const recognition = new GestureRecognition();
  await recognition.init({options, user: new User()});
  return recognition;
}

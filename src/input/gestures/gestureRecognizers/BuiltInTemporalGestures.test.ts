import * as THREE from 'three';
import {describe, expect, it} from 'vitest';

import {Handedness, type JointName} from '../../Hands';
import {
  type GestureConfigurationUpdate,
  GestureRecognitionOptions,
} from '../GestureRecognitionOptions';
import type {
  HandGestureContext,
  HandLabel,
  HandPoseSample,
} from '../GestureTypes';
import type {BeckonGestureParameters} from './BuiltInTemporalGestures';
import {HeuristicGestureRecognizer} from './HeuristicGestureRecognizer';

describe('built-in temporal gestures', () => {
  it('is opt-in and leaves static gestures immediately recognizable', () => {
    const recognizer = new HeuristicGestureRecognizer();
    const context = createMotion('right', [0], [0]);

    expect(recognizer.getGestureConfigurations().shoo).toMatchObject({
      enabled: false,
      threshold: Math.PI / 12,
    });
    expect(recognizer.getGestureConfigurations().beckon).toMatchObject({
      enabled: false,
      threshold: Math.PI / 12,
    });
    expect(
      recognizer.recognize(context)['open-palm']?.confidence
    ).toBeGreaterThanOrEqual(0.6);
  });

  it.each(['left', 'right'] as const)(
    'recognizes a horizontal %s-hand shoo gesture',
    (hand) => {
      const result = recognizeShoo(
        createMotion(hand, [0, 25, -25, 25], [0, 250, 550, 850])
      );
      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result?.data).toMatchObject({reversals: 2, duration: 550});
      expect(result?.data?.amplitude).toBeGreaterThanOrEqual(15);
      expect(result?.data?.peakAngularSpeed).toBeGreaterThan(75);
    }
  );

  it.each(['left', 'right'] as const)(
    'recognizes a closed %s-hand beckon gesture',
    (hand) => {
      const result = recognizeBeckon(
        createBeckonMotion(hand, [0, 25, 0, 25], [0, 250, 550, 850], {
          closed: true,
        })
      );

      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result?.data?.openness).toBe(0);
    }
  );

  it.each(['left', 'right'] as const)(
    'does not reinterpret a rocking %s-hand thumbs-up as beckon',
    (hand) => {
      const result = recognizeBeckon(
        createBeckonMotion(hand, [0, 25, 0, 25], [0, 250, 550, 850], {
          closed: true,
          thumbsUp: true,
        })
      );

      expect(result?.confidence ?? 0).toBeLessThan(0.6);
    }
  );

  it('holds a completed detection briefly and then releases it', () => {
    const held = createMotion(
      'right',
      [0, 25, -25, 25, 25],
      [0, 250, 550, 850, 900]
    );
    const expired = createMotion(
      'right',
      [0, 25, -25, 25, 25],
      [0, 250, 550, 850, 1100]
    );

    expect(recognizeShoo(held)?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(recognizeShoo(expired)?.confidence).toBe(0);
  });

  it('bridges a brief noisy open-palm dropout', () => {
    const context = createMotion(
      'right',
      [0, 10, 20, 25, 15, 0, -15, -25, -15],
      [0, 80, 160, 240, 320, 400, 480, 560, 640],
      {closedIndices: [5]}
    );

    expect(recognizeShoo(context)?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('does not bridge a sustained pose dropout', () => {
    const context = createMotion(
      'right',
      [0, 10, 20, 25, 15, 0, -15, -25, -15],
      [0, 80, 160, 240, 320, 400, 480, 560, 640],
      {closedIndices: [4, 5, 6]}
    );

    expect(recognizeShoo(context)?.confidence ?? 0).toBeLessThan(0.6);
  });

  it.each([
    ['static palm', [0, 0, 0, 0], [0, 250, 550, 850], {}],
    ['one-way rotation', [0, 10, 20, 30], [0, 250, 550, 850], {}],
    ['slow motion', [0, 25, -25, 25], [0, 600, 1300, 2000], {}],
    ['insufficient reversals', [0, 25, -25], [0, 300, 650], {}],
    [
      'vertical conventional wave',
      [0, 25, -25, 25],
      [0, 250, 550, 850],
      {vertical: true},
    ],
    [
      'excessive arm movement',
      [0, 25, -25, 25],
      [0, 250, 550, 850],
      {translations: [0, 0.02, 0.06, 0.1]},
    ],
    ['closed hand', [0, 25, -25, 25], [0, 250, 550, 850], {closed: true}],
  ] as const)('rejects %s', (_name, angles, times, options) => {
    const context = createMotion('right', [...angles], [...times], options);
    expect(recognizeShoo(context)?.confidence ?? 0).toBeLessThan(0.6);
  });

  it.each(['left', 'right'] as const)(
    'recognizes an upright %s-hand beckon gesture',
    (hand) => {
      const result = recognizeBeckon(
        createBeckonMotion(hand, [0, 25, 0, 25], [0, 250, 550, 850])
      );

      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result?.data).toMatchObject({reversals: 2, duration: 550});
      expect(result?.data?.verticalAlignment).toBeGreaterThan(0.7);
    }
  );

  it.each(['left', 'right'] as const)(
    'recognizes a gentle %s-hand beckon and holds the completed event',
    (hand) => {
      const result = recognizeBeckon(
        createBeckonMotion(
          hand,
          [0, 7, 0, 2, 4, 6],
          [0, 500, 1000, 1300, 1600, 1900]
        ),
        {
          threshold: THREE.MathUtils.degToRad(6),
          parameters: {
            reversalCount: 1,
            minimumDurationMs: 100,
            maximumDurationMs: 2400,
            verticalToleranceDegrees: 65,
            maximumThumbsUpConfidence: 0.5,
            maximumTranslation: 5,
            minimumAngularSpeedDegreesPerSecond: 4,
            maximumPoseDropoutMs: 600,
            detectionHoldMs: 500,
            continuationWindowMs: 400,
            minimumContinuationDegrees: 1.5,
          },
        }
      );

      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result?.data?.amplitude).toBeGreaterThanOrEqual(6);
      expect(result?.data?.peakAngularSpeed).toBeGreaterThanOrEqual(4);
      expect(result?.data?.continuing).toBe(true);
    }
  );

  it('recognizes beckon independently of hand yaw and palm facing', () => {
    const result = recognizeBeckon(
      createBeckonMotion('right', [0, 25, 0, 25], [0, 250, 550, 850], {
        away: true,
      })
    );

    expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it.each([
    ['static upright palm', [0, 0, 0, 0], {}],
    ['one-way beckon', [0, 10, 20, 30], {}],
    [
      'excessive arm movement',
      [0, 25, 0, 25],
      {translations: [0, 0.02, 0.06, 0.1]},
    ],
  ] as const)('rejects beckon with %s', (_name, angles, options) => {
    const context = createBeckonMotion(
      'right',
      [...angles],
      [0, 250, 550, 850],
      options
    );
    expect(recognizeBeckon(context)?.confidence ?? 0).toBeLessThan(0.6);
  });

  it('keeps shoo and beckon orientation semantics distinct', () => {
    const shoo = createMotion('right', [0, 25, -25, 25], [0, 250, 550, 850]);
    const beckon = createBeckonMotion(
      'right',
      [0, 25, 0, 25],
      [0, 250, 550, 850]
    );

    expect(recognizeBeckon(shoo)?.confidence ?? 0).toBeLessThan(0.6);
    expect(recognizeShoo(beckon)?.confidence ?? 0).toBeLessThan(0.6);
  });

  it('registers a custom temporal detector with typed, deep-merged parameters', () => {
    interface CustomParameters {
      minimumSamples: number;
      motion: {minimumTravel: number; axis: 'x' | 'y'};
    }
    const recognizer = new HeuristicGestureRecognizer(
      false
    ).registerGesture<CustomParameters>(
      'custom-temporal',
      (context, config) => {
        const parameters = config.parameters!;
        const first = context.samples[0]?.getJoint('wrist');
        const last = context.samples.at(-1)?.getJoint('wrist');
        const travel =
          first && last
            ? Math.abs(
                last[parameters.motion.axis] - first[parameters.motion.axis]
              )
            : 0;
        return {
          confidence:
            context.samples.length >= parameters.minimumSamples &&
            travel >= parameters.motion.minimumTravel
              ? 1
              : 0,
        };
      },
      {
        parameters: {
          minimumSamples: 3,
          motion: {minimumTravel: 0.02, axis: 'x'},
        },
      }
    );
    const options = new GestureRecognitionOptions().setGestureRecognizer(
      recognizer
    );
    options.setGestureConfig<CustomParameters>('custom-temporal', {
      parameters: {motion: {minimumTravel: 0.01}},
    });
    const context = createMotion('right', [0, 0, 0], [0, 100, 200], {
      translations: [0, 0.006, 0.012],
    });

    expect(recognizer.recognize(context)['custom-temporal']?.confidence).toBe(
      1
    );
    expect(
      recognizer.getGestureConfigurations()['custom-temporal']
    ).toMatchObject({
      parameters: {
        minimumSamples: 3,
        motion: {minimumTravel: 0.01, axis: 'x'},
      },
    });
  });
});

function recognizeShoo(context: HandGestureContext) {
  const recognizer = new HeuristicGestureRecognizer();
  const options = new GestureRecognitionOptions().setGestureRecognizer(
    recognizer
  );
  options.setGestureEnabled('shoo', true);
  return recognizer.recognize(context).shoo;
}

function recognizeBeckon(
  context: HandGestureContext,
  config?: GestureConfigurationUpdate<BeckonGestureParameters>
) {
  const recognizer = new HeuristicGestureRecognizer();
  const options = new GestureRecognitionOptions().setGestureRecognizer(
    recognizer
  );
  options.setGestureEnabled('beckon', true);
  if (config) options.setGestureConfig('beckon', config);
  return recognizer.recognize(context).beckon;
}

function createMotion(
  handLabel: HandLabel,
  angles: number[],
  timestamps: number[],
  options: {
    vertical?: boolean;
    closed?: boolean;
    closedIndices?: number[];
    translations?: number[];
  } = {}
): HandGestureContext {
  const samples = angles.map((angle, index) =>
    createSample(handLabel, timestamps[index], angle, {
      vertical: options.vertical,
      closed: options.closed || options.closedIndices?.includes(index),
      translation: options.translations?.[index] ?? 0,
    })
  );
  return {...samples.at(-1)!, samples};
}

function createSample(
  handLabel: HandLabel,
  timestamp: number,
  yawDegrees: number,
  options: {vertical?: boolean; closed?: boolean; translation?: number}
): HandPoseSample {
  const handedness = handLabel === 'left' ? Handedness.LEFT : Handedness.RIGHT;
  const joints = createOpenHandJoints(options.closed ?? false);
  const rotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(options.vertical ? Math.PI / 2 : 0, degrees(yawDegrees), 0)
  );
  const translation = new THREE.Vector3(options.translation ?? 0, 0, 0);
  for (const position of joints.values()) {
    position.applyQuaternion(rotation).add(translation);
  }
  return {
    timestamp,
    handedness,
    handLabel,
    joints,
    getJoint: (name) => joints.get(name),
  };
}

function createBeckonMotion(
  handLabel: HandLabel,
  angles: number[],
  timestamps: number[],
  options: {
    away?: boolean;
    closed?: boolean;
    thumbsUp?: boolean;
    translations?: number[];
  } = {}
): HandGestureContext {
  const samples = angles.map((angle, index) =>
    createBeckonSample(handLabel, timestamps[index], angle, {
      ...options,
      translation: options.translations?.[index] ?? 0,
    })
  );
  return {...samples.at(-1)!, samples};
}

function createBeckonSample(
  handLabel: HandLabel,
  timestamp: number,
  pitchDegrees: number,
  options: {
    away?: boolean;
    closed?: boolean;
    thumbsUp?: boolean;
    translation?: number;
  }
): HandPoseSample {
  const handedness = handLabel === 'left' ? Handedness.LEFT : Handedness.RIGHT;
  const joints = createUprightOpenHandJoints(
    handLabel,
    options.closed ?? false,
    options.thumbsUp ?? false
  );
  const rotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(degrees(pitchDegrees), options.away ? Math.PI : 0, 0)
  );
  const origin = new THREE.Vector3(options.translation ?? 0, 0, -0.5);
  for (const position of joints.values()) {
    position.applyQuaternion(rotation).add(origin);
  }
  return {
    timestamp,
    handedness,
    handLabel,
    joints,
    getJoint: (name) => joints.get(name),
  };
}

function createUprightOpenHandJoints(
  handLabel: HandLabel,
  closed: boolean,
  thumbsUp: boolean
) {
  const joints = new Map<JointName, THREE.Vector3>();
  joints.set('wrist', new THREE.Vector3(0, -0.04, 0));
  const side = handLabel === 'right' ? -1 : 1;
  const fingers = [
    ['index-finger', 0.03 * side, 0.055 * side],
    ['middle-finger', 0.01 * side, 0.018 * side],
    ['ring-finger', -0.01 * side, -0.018 * side],
    ['pinky-finger', -0.03 * side, -0.055 * side],
  ] as const;
  const suffixes = [
    'metacarpal',
    'phalanx-proximal',
    'phalanx-intermediate',
    'phalanx-distal',
    'tip',
  ] as const;
  for (const [prefix, baseX, tipX] of fingers) {
    suffixes.forEach((suffix, index) => {
      if (closed) {
        const curledOffsets = [
          [0, 0],
          [0.02, 0],
          [0.01, 0.015],
          [0, 0.02],
          [-0.01, 0.015],
        ] as const;
        joints.set(
          `${prefix}-${suffix}` as JointName,
          new THREE.Vector3(
            baseX,
            curledOffsets[index][0],
            curledOffsets[index][1]
          )
        );
        return;
      }
      const alpha = index / (suffixes.length - 1);
      joints.set(
        `${prefix}-${suffix}` as JointName,
        new THREE.Vector3(
          THREE.MathUtils.lerp(baseX, tipX, alpha),
          index * 0.03,
          0
        )
      );
    });
  }

  const thumbBase = new THREE.Vector3(0.045 * side, 0, 0);
  const thumbDirection = thumbsUp
    ? new THREE.Vector3(
        0.206144573838398 * (handLabel === 'left' ? 1 : -1),
        0.9112275172350451,
        -0.35660738426263827
      ).normalize()
    : new THREE.Vector3(side, 0, 0);
  joints.set('thumb-metacarpal', thumbBase.clone());
  joints.set(
    'thumb-phalanx-proximal',
    thumbBase.clone().addScaledVector(thumbDirection, 0.03)
  );
  joints.set(
    'thumb-phalanx-distal',
    thumbBase.clone().addScaledVector(thumbDirection, 0.06)
  );
  joints.set(
    'thumb-tip',
    thumbBase.clone().addScaledVector(thumbDirection, 0.09)
  );
  return joints;
}

function createOpenHandJoints(closed: boolean) {
  const joints = new Map<JointName, THREE.Vector3>();
  joints.set('wrist', new THREE.Vector3(0, 0, 0.04));
  const fingers = [
    ['index-finger', 0.03, 0.055],
    ['middle-finger', 0.01, 0.018],
    ['ring-finger', -0.01, -0.018],
    ['pinky-finger', -0.03, -0.055],
  ] as const;
  const suffixes = [
    'metacarpal',
    'phalanx-proximal',
    'phalanx-intermediate',
    'phalanx-distal',
    'tip',
  ] as const;
  for (const [prefix, baseX, tipX] of fingers) {
    suffixes.forEach((suffix, index) => {
      if (closed && index > 0) return;
      const alpha = index / (suffixes.length - 1);
      joints.set(
        `${prefix}-${suffix}` as JointName,
        new THREE.Vector3(
          THREE.MathUtils.lerp(baseX, tipX, alpha),
          0,
          index * 0.03
        )
      );
    });
  }
  return joints;
}

function degrees(value: number) {
  return THREE.MathUtils.degToRad(value);
}

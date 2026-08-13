import * as THREE from 'three';
import {describe, expect, it} from 'vitest';

import {Handedness, type JointName} from '../../Hands';
import {HAND_JOINT_NAMES} from '../../components/HandJointNames';
import {resolveSimulatorHandPoseRotations} from '../../../simulator/handPoses/HandPoseFK';
import {SIMULATOR_HAND_POSE_ROTATIONS} from '../../../simulator/handPoses/HandPoseRotations';
import {SimulatorHandPose} from '../../../simulator/handPoses/HandPoses';
import type {
  HandContext,
  HandGestureContext,
  HandPoseSample,
} from '../GestureTypes';
import {
  DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
  detectThumbsUp,
} from './BuiltInHeuristicGestures';

describe('built-in heuristic gestures', () => {
  it.each(['left', 'right'] as const)(
    'recognizes the simulator %s-hand thumbs-up pose',
    (hand) => {
      const context = createSimulatorThumbsUpContext(hand);
      const result = detectThumbsUp(context, {
        enabled: true,
        parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
      });

      expect(
        result.confidence,
        JSON.stringify(result.data)
      ).toBeGreaterThanOrEqual(0.6);
      expect(result.data.thumbTiltDeviationDegrees).toBeCloseTo(0);
    }
  );

  it('keeps the natural thumbs-up valid when its world azimuth changes', () => {
    const context = createSimulatorThumbsUpContext('right');
    const yaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(120)
    );
    for (const position of context.joints.values()) {
      position.applyQuaternion(yaw);
    }
    const result = detectThumbsUp(context, {
      enabled: true,
      parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
    });

    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.data.thumbTiltDeviationDegrees).toBeCloseTo(0);
  });

  it.each(['left', 'right'] as const)(
    'recognizes a %s-hand thumbs-up near its natural reference direction',
    (hand) => {
      const result = detectThumbsUp(createThumbsUpContext(5, hand), {
        enabled: true,
        parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
      });

      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.data.poseValid).toBe(true);
      expect(result.data.thumbTiltDeviationDegrees).toBeCloseTo(5);
    }
  );

  it.each(['left', 'right'] as const)(
    'rejects a %s-hand thumbs-up-shaped pose outside the direction tolerance',
    (hand) => {
      const result = detectThumbsUp(createThumbsUpContext(25, hand), {
        enabled: true,
        parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
      });

      expect(result.confidence).toBe(0);
      expect(result.data.directionValid).toBe(false);
    }
  );

  it('rejects thumbs-up when even one non-thumb finger remains open', () => {
    const result = detectThumbsUp(
      createThumbsUpContext(5, 'right', {openFinger: 'pinky-finger'}),
      {
        enabled: true,
        parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
      }
    );

    expect(result.confidence).toBe(0);
    expect(result.data.allOtherFingersClosed).toBeLessThan(
      DEFAULT_THUMBS_UP_GESTURE_PARAMETERS.minimumOtherFingerCurl
    );
  });

  it('rejects an incompletely tracked thumbs-up pose', () => {
    const context = createThumbsUpContext(5, 'left');
    context.joints.delete('pinky-finger-tip');
    const result = detectThumbsUp(context, {
      enabled: true,
      parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
    });

    expect(result.confidence).toBe(0);
    expect(result.data.trackingValid).toBe(false);
  });

  it.each(['left', 'right'] as const)(
    'rejects a %s-hand thumbs-up immediately after wave-like movement',
    (hand) => {
      const result = detectThumbsUp(
        createThumbsUpHistory(hand, [0, 20, 0], [0, 100, 200]),
        {
          enabled: true,
          parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
        }
      );

      expect(result.confidence).toBe(0);
      expect(result.data.motionValid).toBe(false);
      expect(result.data.recentAngularMovement).toBeGreaterThan(15);
    }
  );

  it('recognizes thumbs-up after adjacent movement ages out', () => {
    const result = detectThumbsUp(
      createThumbsUpHistory('right', [15, 0, 0], [0, 400, 500]),
      {
        enabled: true,
        parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
      }
    );

    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.data.motionValid).toBe(true);
    expect(result.data.recentAngularMovement).toBeCloseTo(0);
  });

  it.each(['left', 'right'] as const)(
    'allows minor recent movement in a %s-hand thumbs-up',
    (hand) => {
      const result = detectThumbsUp(
        createThumbsUpHistory(hand, [0, 7, 14], [0, 175, 350]),
        {
          enabled: true,
          parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
        }
      );

      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.data.motionValid).toBe(true);
      expect(result.data.recentAngularMovement).toBeLessThanOrEqual(15);
    }
  );

  it('allows applications to tune the thumbs-up direction gate', () => {
    const result = detectThumbsUp(createThumbsUpContext(25, 'right'), {
      enabled: true,
      parameters: {
        ...DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
        maximumThumbTiltDeviationDegrees: 30,
      },
    });

    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.data.directionValid).toBe(true);
  });
});

function createThumbsUpHistory(
  handLabel: 'left' | 'right',
  rotations: number[],
  timestamps: number[]
): HandGestureContext {
  const base = createThumbsUpContext(5, handLabel);
  const samples = rotations.map((rotationDegrees, index) => {
    const rotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      THREE.MathUtils.degToRad(rotationDegrees)
    );
    const joints = new Map<JointName, THREE.Vector3>();
    for (const [name, position] of base.joints) {
      joints.set(name, position.clone().applyQuaternion(rotation));
    }
    return {
      timestamp: timestamps[index],
      handedness: base.handedness,
      handLabel,
      joints,
      getJoint: (name: JointName) => joints.get(name),
    } satisfies HandPoseSample;
  });
  return {...samples.at(-1)!, samples};
}

function createThumbsUpContext(
  thumbTiltDeviationDegrees: number,
  handLabel: 'left' | 'right',
  options: {openFinger?: string} = {}
): HandContext {
  const joints = new Map<JointName, THREE.Vector3>();
  joints.set('wrist', new THREE.Vector3(0, -0.04, 0));

  const side = handLabel === 'right' ? 1 : -1;
  const fingerXs = [0.03, 0.01, -0.01, -0.03];
  const fingers = [
    'index-finger',
    'middle-finger',
    'ring-finger',
    'pinky-finger',
  ];
  for (let index = 0; index < fingers.length; index++) {
    const prefix = fingers[index];
    const x = fingerXs[index] * side;
    joints.set(`${prefix}-metacarpal` as JointName, new THREE.Vector3(x, 0, 0));
    if (prefix === options.openFinger) {
      joints.set(
        `${prefix}-phalanx-proximal` as JointName,
        new THREE.Vector3(x, 0.025, 0)
      );
      joints.set(
        `${prefix}-phalanx-intermediate` as JointName,
        new THREE.Vector3(x, 0.05, 0)
      );
      joints.set(
        `${prefix}-phalanx-distal` as JointName,
        new THREE.Vector3(x, 0.075, 0)
      );
      joints.set(`${prefix}-tip` as JointName, new THREE.Vector3(x, 0.1, 0));
      continue;
    }
    joints.set(
      `${prefix}-phalanx-proximal` as JointName,
      new THREE.Vector3(x, 0.02, 0)
    );
    joints.set(
      `${prefix}-phalanx-intermediate` as JointName,
      new THREE.Vector3(x, 0.01, 0.015)
    );
    joints.set(
      `${prefix}-phalanx-distal` as JointName,
      new THREE.Vector3(x, 0, 0.02)
    );
    joints.set(
      `${prefix}-tip` as JointName,
      new THREE.Vector3(x, -0.01, 0.015)
    );
  }

  const thumbBase = new THREE.Vector3(0.045 * side, 0, 0);
  const thumbDirection = new THREE.Vector3(
    0.206144573838398 * (handLabel === 'left' ? 1 : -1),
    0.9112275172350451,
    -0.35660738426263827
  ).normalize();
  const deviationAxis = new THREE.Vector3()
    .crossVectors(thumbDirection, new THREE.Vector3(0, 1, 0))
    .normalize();
  thumbDirection.applyAxisAngle(
    deviationAxis,
    THREE.MathUtils.degToRad(thumbTiltDeviationDegrees)
  );
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

  return {
    handedness: handLabel === 'right' ? Handedness.RIGHT : Handedness.LEFT,
    handLabel,
    joints,
    getJoint: (name) => joints.get(name),
  };
}

function createSimulatorThumbsUpContext(
  handLabel: 'left' | 'right'
): HandContext {
  const handedness = handLabel === 'right' ? Handedness.RIGHT : Handedness.LEFT;
  const pose = resolveSimulatorHandPoseRotations(
    handedness,
    SIMULATOR_HAND_POSE_ROTATIONS[SimulatorHandPose.THUMBS_UP]
  );
  const joints = new Map<JointName, THREE.Vector3>();
  HAND_JOINT_NAMES.forEach((name, index) => {
    const position = pose[index].t;
    joints.set(name, new THREE.Vector3(position[0], position[1], position[2]));
  });
  return {
    handedness,
    handLabel,
    joints,
    getJoint: (name) => joints.get(name),
  };
}

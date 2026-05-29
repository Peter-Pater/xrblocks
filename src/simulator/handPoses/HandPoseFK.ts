import * as THREE from 'three';

import {HAND_JOINT_NAMES} from '../../input/components/HandJointNames';
import {Handedness, type JointName} from '../../input/Hands';
import type {
  SimulatorHandPoseJoints,
  SimulatorHandPoseRotations,
} from './HandPoseJoints';
import {LEFT_HAND_NEUTRAL, RIGHT_HAND_NEUTRAL} from './NeutralHandPose';

const HAND_JOINT_PARENT: Partial<Record<JointName, JointName>> = {
  'thumb-metacarpal': 'wrist',
  'thumb-phalanx-proximal': 'thumb-metacarpal',
  'thumb-phalanx-distal': 'thumb-phalanx-proximal',
  'thumb-tip': 'thumb-phalanx-distal',
  'index-finger-metacarpal': 'wrist',
  'index-finger-phalanx-proximal': 'index-finger-metacarpal',
  'index-finger-phalanx-intermediate': 'index-finger-phalanx-proximal',
  'index-finger-phalanx-distal': 'index-finger-phalanx-intermediate',
  'index-finger-tip': 'index-finger-phalanx-distal',
  'middle-finger-metacarpal': 'wrist',
  'middle-finger-phalanx-proximal': 'middle-finger-metacarpal',
  'middle-finger-phalanx-intermediate': 'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-distal': 'middle-finger-phalanx-intermediate',
  'middle-finger-tip': 'middle-finger-phalanx-distal',
  'ring-finger-metacarpal': 'wrist',
  'ring-finger-phalanx-proximal': 'ring-finger-metacarpal',
  'ring-finger-phalanx-intermediate': 'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-distal': 'ring-finger-phalanx-intermediate',
  'ring-finger-tip': 'ring-finger-phalanx-distal',
  'pinky-finger-metacarpal': 'wrist',
  'pinky-finger-phalanx-proximal': 'pinky-finger-metacarpal',
  'pinky-finger-phalanx-intermediate': 'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-distal': 'pinky-finger-phalanx-intermediate',
  'pinky-finger-tip': 'pinky-finger-phalanx-distal',
};

type RestJoint = {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  localOffset: THREE.Vector3;
  localRotation: THREE.Quaternion;
};

function createRestJoints(
  joints: typeof LEFT_HAND_NEUTRAL | typeof RIGHT_HAND_NEUTRAL
) {
  const restJoints = new Map<JointName, RestJoint>();
  HAND_JOINT_NAMES.forEach((jointName, index) => {
    const joint = joints[index];
    const position = new THREE.Vector3(joint.t[0], joint.t[1], joint.t[2]);
    const rotation = new THREE.Quaternion(
      joint.r[0],
      joint.r[1],
      joint.r[2],
      joint.r[3]
    );
    const parentName = HAND_JOINT_PARENT[jointName];

    if (!parentName) {
      restJoints.set(jointName, {
        position,
        rotation,
        localOffset: position.clone(),
        localRotation: rotation.clone(),
      });
      return;
    }

    const parentRestJoint = restJoints.get(parentName)!;
    const inverseParentRotation = parentRestJoint.rotation.clone().invert();
    const localOffset = position
      .clone()
      .sub(parentRestJoint.position)
      .applyQuaternion(inverseParentRotation);
    const localRotation = parentRestJoint.rotation
      .clone()
      .invert()
      .multiply(rotation);

    restJoints.set(jointName, {
      position,
      rotation,
      localOffset,
      localRotation,
    });
  });
  return restJoints;
}

const LEFT_REST_JOINTS = createRestJoints(LEFT_HAND_NEUTRAL);
const RIGHT_REST_JOINTS = createRestJoints(RIGHT_HAND_NEUTRAL);

function getHandednessAxisValue(
  handedness: Handedness,
  axis: 'x' | 'y' | 'z',
  value = 0
) {
  // converts euler angles to match the handedness of the hand
  if (handedness === Handedness.RIGHT && (axis === 'y' || axis === 'z')) {
    return -value;
  }
  return value;
}

function resolveHandPoseRotations(
  handedness: Handedness,
  restJoints: Map<JointName, RestJoint>,
  rotations: SimulatorHandPoseRotations
): SimulatorHandPoseJoints {
  const finalPositions = new Map<JointName, THREE.Vector3>();
  const finalRotations = new Map<JointName, THREE.Quaternion>();
  const resolvedJoints: SimulatorHandPoseJoints = [];

  for (const jointName of HAND_JOINT_NAMES) {
    const restJoint = restJoints.get(jointName)!;
    const rotation = rotations[jointName];
    const offsetRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        getHandednessAxisValue(handedness, 'x', rotation?.x),
        getHandednessAxisValue(handedness, 'y', rotation?.y),
        getHandednessAxisValue(handedness, 'z', rotation?.z),
        'XYZ'
      )
    );
    const parentName = HAND_JOINT_PARENT[jointName];

    if (!parentName) {
      const finalPosition = restJoint.position.clone();
      const finalRotation = restJoint.rotation.clone().multiply(offsetRotation);
      finalPositions.set(jointName, finalPosition);
      finalRotations.set(jointName, finalRotation);
      resolvedJoints.push({
        t: finalPosition.toArray(),
        r: finalRotation.toArray(),
        s: [1, 1, 1],
      });
      continue;
    }

    const parentPosition = finalPositions.get(parentName)!;
    const parentRotation = finalRotations.get(parentName)!;
    const finalPosition = restJoint.localOffset
      .clone()
      .applyQuaternion(parentRotation)
      .add(parentPosition);
    const finalRotation = parentRotation
      .clone()
      .multiply(restJoint.localRotation)
      .multiply(offsetRotation);
    finalPositions.set(jointName, finalPosition);
    finalRotations.set(jointName, finalRotation);
    resolvedJoints.push({
      t: finalPosition.toArray(),
      r: finalRotation.toArray(),
      s: [1, 1, 1],
    });
  }

  return resolvedJoints;
}

export function resolveSimulatorHandPoseRotations(
  handedness: Handedness,
  rotations: SimulatorHandPoseRotations
) {
  return resolveHandPoseRotations(
    handedness,
    handedness === Handedness.LEFT ? LEFT_REST_JOINTS : RIGHT_REST_JOINTS,
    rotations
  );
}

export function resolveLeftHandPoseRotations(
  rotations: SimulatorHandPoseRotations
) {
  return resolveSimulatorHandPoseRotations(Handedness.LEFT, rotations);
}

export function resolveRightHandPoseRotations(
  rotations: SimulatorHandPoseRotations
) {
  return resolveSimulatorHandPoseRotations(Handedness.RIGHT, rotations);
}

import * as THREE from 'three';
import {describe, expect, it} from 'vitest';

import {User} from '../../../core/User';
import type {Controller} from '../../Controller';
import {Handedness, Hands} from '../../Hands';
import {Input} from '../../Input';
import {WebXRHandPoseEstimator} from './WebXRHandPoseEstimator';

describe('WebXRHandPoseEstimator handedness', () => {
  it('maps hand spaces through the handed controller instead of slot order', () => {
    const slot0 = new THREE.Group() as Controller;
    const slot1 = new THREE.Group() as Controller;
    const input = new Input();
    input.controllers = [slot0, slot1];
    input.rightController = slot0;
    input.leftController = slot1;

    const user = createUser(input, [createHandSpace(1), createHandSpace(-1)]);
    const estimator = new WebXRHandPoseEstimator(user);

    expect(
      estimator.getHandContext(Handedness.LEFT)?.getJoint('wrist')?.x
    ).toBe(-1);
    expect(
      estimator.getHandContext(Handedness.RIGHT)?.getJoint('wrist')?.x
    ).toBe(1);
  });

  it('does not publish one connected hand under both labels', () => {
    const slot0 = new THREE.Group() as Controller;
    const slot1 = new THREE.Group() as Controller;
    const input = new Input();
    input.controllers = [slot0, slot1];
    input.rightController = slot0;

    const user = createUser(input, [createHandSpace(1), createHandSpace(-1)]);
    const estimator = new WebXRHandPoseEstimator(user);

    expect(estimator.getHandContext(Handedness.LEFT)).toBeNull();
    expect(
      estimator.getHandContext(Handedness.RIGHT)?.getJoint('wrist')?.x
    ).toBe(1);
  });

  it('retains index-based fallback for custom integrations without input mapping', () => {
    const input = new Input();
    const user = createUser(input, [createHandSpace(-1), createHandSpace(1)]);
    const estimator = new WebXRHandPoseEstimator(user);

    expect(
      estimator.getHandContext(Handedness.LEFT)?.getJoint('wrist')?.x
    ).toBe(-1);
    expect(
      estimator.getHandContext(Handedness.RIGHT)?.getJoint('wrist')?.x
    ).toBe(1);
  });
});

function createUser(input: Input, handSpaces: THREE.XRHandSpace[]) {
  const user = new User();
  user.input = input;
  user.hands = new Hands(handSpaces);
  return user;
}

function createHandSpace(wristX: number) {
  const wrist = new THREE.Group();
  wrist.position.x = wristX;
  wrist.updateMatrixWorld(true);

  return Object.assign(new THREE.Group(), {
    joints: {wrist},
  }) as unknown as THREE.XRHandSpace;
}

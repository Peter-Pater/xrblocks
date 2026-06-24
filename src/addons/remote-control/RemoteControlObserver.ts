import * as THREE from 'three';
import {Core, Input, Simulator} from 'xrblocks';

import type {
  RemoteControlHandObservation,
  RemoteControlObservation,
  RemoteControlObservationOptions,
  RemoteControlPoseObservation,
} from './RemoteControlProtocol';

export type RemoteControlObserverDependencies = {
  core: Core;
  simulator: Simulator;
  input: Input;
  camera: THREE.Camera;
};

function vectorToTuple(vector: THREE.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function quaternionToTuple(
  quaternion: THREE.Quaternion
): [number, number, number, number] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function poseFromObject(object: THREE.Object3D): RemoteControlPoseObservation {
  object.updateMatrixWorld(true);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  object.getWorldPosition(position);
  object.getWorldQuaternion(quaternion);
  return {
    position: vectorToTuple(position),
    quaternion: quaternionToTuple(quaternion),
  };
}

function normalizeObservationOptions(
  options?: RemoteControlObservationOptions | boolean
): RemoteControlObservationOptions {
  if (options === true) {
    return {camera: true, hands: true};
  }
  if (options === false) {
    return {};
  }
  return options ?? {camera: true, hands: true};
}

export class RemoteControlObserver {
  private frame = 0;

  constructor(private dependencies: RemoteControlObserverDependencies) {}

  async observe(
    options?: RemoteControlObservationOptions | boolean
  ): Promise<RemoteControlObservation> {
    const normalized = normalizeObservationOptions(options);
    const {core, camera, simulator} = this.dependencies;
    const observation: RemoteControlObservation = {
      timestampMs:
        typeof performance !== 'undefined' ? performance.now() : Date.now(),
      frame: this.frame++,
      simulatorRunning: core.simulatorRunning,
      paused: core.isPaused,
    };

    if (normalized.camera) {
      observation.camera = poseFromObject(camera);
    }

    if (normalized.hands) {
      observation.leftHand = this.observeHand(0);
      observation.rightHand = this.observeHand(1);
    }

    if (normalized.screenshot) {
      const screenshotPromise = core.screenshotSynthesizer.getScreenshot(
        normalized.overlayOnCamera ?? true
      );
      core.stepFrame(0);
      observation.screenshot = await screenshotPromise;
    }

    simulator.simulatorScene.updateMatrixWorld(true);
    return observation;
  }

  private observeHand(handIndex: number): RemoteControlHandObservation {
    const {simulator, input} = this.dependencies;
    const controller =
      handIndex === 0
        ? simulator.hands.leftController
        : simulator.hands.rightController;
    const controllerState = simulator.simulatorControllerState;
    const inputController = input.controllers[handIndex];
    return {
      position: vectorToTuple(
        controllerState.localControllerPositions[handIndex]
      ),
      quaternion: quaternionToTuple(
        controllerState.localControllerOrientations[handIndex]
      ),
      selected: !!inputController?.userData.selected,
      squeezing: !!inputController?.userData.squeezing,
      visible: controller?.visible ?? false,
    };
  }
}

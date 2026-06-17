import * as THREE from 'three';
import {
  Core,
  Input,
  ScreenshotSynthesizer,
  Simulator,
  type SimulatorHandPoseRotations,
} from 'xrblocks';

import {
  DEFAULT_EMBODIED_CONTROL_OPTIONS,
  type EmbodiedControlExecutorOptions,
  type EmbodiedControlObservation,
  type EmbodiedControlOptions,
  type EmbodiedControlStep,
  type EmbodiedControlStepResult,
  type HandControl,
  type HandObservation,
  type LocomotionControl,
} from './EmbodiedControlTypes';

export type EmbodiedControlExecutorDependencies = {
  core: Core;
  simulator: Simulator;
  input: Input;
  camera: THREE.Camera;
  screenshotSynthesizer: ScreenshotSynthesizer;
};

const vector = new THREE.Vector3();
const euler = new THREE.Euler();
const quaternion = new THREE.Quaternion();

function mergeOptions(
  options: EmbodiedControlOptions
): EmbodiedControlExecutorOptions {
  return {
    tickMs: options.tickMs ?? DEFAULT_EMBODIED_CONTROL_OPTIONS.tickMs,
    defaultDurationMs:
      options.defaultDurationMs ??
      DEFAULT_EMBODIED_CONTROL_OPTIONS.defaultDurationMs,
    includeScreenshot:
      options.includeScreenshot ??
      DEFAULT_EMBODIED_CONTROL_OPTIONS.includeScreenshot,
    applyHandRotationConstraints:
      options.applyHandRotationConstraints ??
      DEFAULT_EMBODIED_CONTROL_OPTIONS.applyHandRotationConstraints,
  };
}

export class EmbodiedControlBusyError extends Error {
  constructor() {
    super('EmbodiedControl already has an active step.');
    this.name = 'EmbodiedControlBusyError';
  }
}

export class EmbodiedControlExecutor {
  private activeStep = false;
  private options: EmbodiedControlExecutorOptions;

  constructor(
    private dependencies: EmbodiedControlExecutorDependencies,
    options: EmbodiedControlOptions = {}
  ) {
    this.options = mergeOptions(options);
  }

  configure(options: EmbodiedControlOptions) {
    this.options = mergeOptions({
      ...this.options,
      ...options,
    });
  }

  get busy() {
    return this.activeStep;
  }

  async step(step: EmbodiedControlStep): Promise<EmbodiedControlStepResult> {
    if (this.activeStep) {
      throw new EmbodiedControlBusyError();
    }
    this.activeStep = true;

    try {
      const durationMs = step.durationMs ?? this.options.defaultDurationMs;
      const tickMs = this.options.tickMs;
      const stepCount = Math.max(1, Math.ceil(durationMs / tickMs));
      let elapsedMs = 0;
      const initialCameraQuaternion =
        this.dependencies.camera.quaternion.clone();

      this.applyInstantHandControls(step.control.leftHand, 0);
      this.applyInstantHandControls(step.control.rightHand, 1);

      let screenshotPromise: Promise<string> | undefined;
      for (let i = 0; i < stepCount; i++) {
        const remainingMs = Math.max(0, durationMs - elapsedMs);
        const currentTickMs =
          i === stepCount - 1
            ? remainingMs || tickMs
            : Math.min(tickMs, remainingMs);
        const fraction = durationMs > 0 ? currentTickMs / durationMs : 1;

        this.applyLocomotion(
          step.control.locomotion,
          fraction,
          initialCameraQuaternion
        );
        this.applyHandMotion(step.control.leftHand, 0, fraction);
        this.applyHandMotion(step.control.rightHand, 1, fraction);

        if (this.options.includeScreenshot && i === stepCount - 1) {
          screenshotPromise =
            this.dependencies.screenshotSynthesizer.getScreenshot();
        }

        this.dependencies.core.stepFrame(currentTickMs);
        elapsedMs += currentTickMs;
      }

      const observation = await this.createObservation(screenshotPromise);
      return {
        id: step.id,
        elapsedMs,
        observation,
      };
    } finally {
      this.activeStep = false;
    }
  }

  private applyLocomotion(
    control: LocomotionControl | undefined,
    fraction: number,
    initialCameraQuaternion: THREE.Quaternion
  ) {
    if (!control) return;
    const {camera} = this.dependencies;

    if (control.move) {
      vector
        .fromArray(control.move)
        .multiplyScalar(fraction)
        .applyQuaternion(initialCameraQuaternion);
      camera.position.add(vector);
    }

    if (control.rotate) {
      euler.set(
        THREE.MathUtils.degToRad(control.rotate[0]) * fraction,
        THREE.MathUtils.degToRad(control.rotate[1]) * fraction,
        THREE.MathUtils.degToRad(control.rotate[2]) * fraction,
        'YXZ'
      );
      quaternion.setFromEuler(euler);
      camera.quaternion.multiply(quaternion);
    }
  }

  private applyHandMotion(
    control: HandControl | undefined,
    handIndex: number,
    fraction: number
  ) {
    if (!control) return;
    const controllerState =
      this.dependencies.simulator.simulatorControllerState;

    if (control.move) {
      vector.fromArray(control.move).multiplyScalar(fraction);
      controllerState.localControllerPositions[handIndex].add(vector);
    }

    if (control.rotate) {
      euler.set(
        THREE.MathUtils.degToRad(control.rotate[0]) * fraction,
        THREE.MathUtils.degToRad(control.rotate[1]) * fraction,
        THREE.MathUtils.degToRad(control.rotate[2]) * fraction,
        'YXZ'
      );
      quaternion.setFromEuler(euler);
      controllerState.localControllerOrientations[handIndex].multiply(
        quaternion
      );
    }
  }

  private applyInstantHandControls(
    control: HandControl | undefined,
    handIndex: number
  ) {
    if (!control) return;
    const {simulator} = this.dependencies;

    if (control.visible !== undefined) {
      const controller =
        handIndex === 0
          ? simulator.hands.leftController
          : simulator.hands.rightController;
      controller.visible = control.visible;
    }

    if (control.rotations) {
      this.applyHandRotations(handIndex, control.rotations);
    }
  }

  private applyHandRotations(
    handIndex: number,
    rotations: SimulatorHandPoseRotations
  ) {
    const {simulator} = this.dependencies;
    const mergedRotations =
      handIndex === 0
        ? {...simulator.hands.leftHandTargetRotations, ...rotations}
        : {...simulator.hands.rightHandTargetRotations, ...rotations};

    if (handIndex === 0) {
      simulator.hands.setLeftHandRotations(
        mergedRotations,
        this.options.applyHandRotationConstraints
      );
    } else {
      simulator.hands.setRightHandRotations(
        mergedRotations,
        this.options.applyHandRotationConstraints
      );
    }
  }

  private async createObservation(
    screenshotPromise: Promise<string> | undefined
  ): Promise<EmbodiedControlObservation> {
    const screenshot = await screenshotPromise;
    return {
      screenshot,
      state: {
        camera: {
          position: this.dependencies.camera.position.toArray(),
          quaternion: this.dependencies.camera.quaternion.toArray(),
        },
        leftHand: this.createHandObservation(0),
        rightHand: this.createHandObservation(1),
      },
    };
  }

  private createHandObservation(handIndex: number): HandObservation {
    const {input, simulator} = this.dependencies;
    const controllerState = simulator.simulatorControllerState;
    const controller = input.controllers[handIndex];
    const hand =
      handIndex === 0
        ? simulator.hands.leftController
        : simulator.hands.rightController;
    const rotations =
      handIndex === 0
        ? simulator.hands.leftHandTargetRotations
        : simulator.hands.rightHandTargetRotations;

    return {
      position: controllerState.localControllerPositions[handIndex].toArray(),
      quaternion:
        controllerState.localControllerOrientations[handIndex].toArray(),
      selected: !!controller?.userData.selected,
      squeezing: !!controller?.userData.squeezing,
      visible: hand.visible,
      rotations: {...rotations},
    };
  }
}

import {describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';

import {Core} from '../../core/Core';
import type {ScreenshotSynthesizer} from '../../core/components/ScreenshotSynthesizer';
import {Input} from '../../input/Input';
import {Simulator} from '../../simulator/Simulator';

import {
  EmbodiedControlBusyError,
  EmbodiedControlExecutor,
} from './EmbodiedControlExecutor';

function createController() {
  return new THREE.Object3D() as THREE.Object3D & {userData: {id?: number}};
}

function createExecutor(options = {includeScreenshot: false}) {
  const core = {
    stepFrame: vi.fn(),
  } as unknown as Core;
  const simulator = new Simulator(() => {});
  const input = new Input();
  const leftController = createController();
  const rightController = createController();
  leftController.userData.id = 0;
  rightController.userData.id = 1;
  input.controllers = [leftController, rightController] as never;
  simulator.hands.input = input;
  const camera = new THREE.PerspectiveCamera();
  const screenshotSynthesizer = {
    getScreenshot: vi.fn().mockResolvedValue('data:image/png;base64,test'),
  } as unknown as ScreenshotSynthesizer;

  const executor = new EmbodiedControlExecutor(
    {
      core,
      simulator,
      input,
      camera,
      screenshotSynthesizer,
    },
    options
  );

  return {executor, core, simulator, input, camera, screenshotSynthesizer};
}

describe('EmbodiedControlExecutor', () => {
  it('applies compound locomotion and hand motion over a step', async () => {
    const {executor, simulator, camera} = createExecutor();

    await executor.step({
      durationMs: 100,
      control: {
        locomotion: {
          move: [1, 0, 0],
          rotate: [0, 90, 0],
        },
        rightHand: {
          move: [0.1, 0.2, 0.3],
          rotate: [0, 45, 0],
        },
      },
    });

    expect(camera.position.x).toBeCloseTo(1);
    expect(camera.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(
      simulator.simulatorControllerState.localControllerPositions[1].x
    ).toBeCloseTo(0.4);
    expect(
      simulator.simulatorControllerState.localControllerPositions[1].y
    ).toBeCloseTo(0.1);
    expect(
      simulator.simulatorControllerState.localControllerPositions[1].z
    ).toBeCloseTo(0);
    expect(
      simulator.simulatorControllerState.localControllerOrientations[1].y
    ).toBeCloseTo(Math.sin(Math.PI / 8));
  });

  it('applies sparse hand rotations and preserves omitted target joints', async () => {
    const {executor, simulator} = createExecutor({
      includeScreenshot: false,
      applyHandRotationConstraints: false,
    });
    const initialThumb =
      simulator.hands.rightHandTargetRotations['thumb-metacarpal'];

    await executor.step({
      durationMs: 1,
      control: {
        rightHand: {
          rotations: {
            'index-finger-phalanx-proximal': [0.5, 0.1, 0],
          },
        },
      },
    });

    expect(
      simulator.hands.rightHandTargetRotations['index-finger-phalanx-proximal']
    ).toEqual([0.5, 0.1, 0]);
    expect(
      simulator.hands.rightHandTargetRotations['thumb-metacarpal']
    ).toEqual(initialThumb);
  });

  it('rejects a concurrent step while active', async () => {
    const {executor} = createExecutor({includeScreenshot: true});
    let resolveScreenshot!: (value: string) => void;
    const screenshotPromise = new Promise<string>((resolve) => {
      resolveScreenshot = resolve;
    });
    (
      executor as unknown as {
        dependencies: {
          screenshotSynthesizer: {getScreenshot: () => Promise<string>};
        };
      }
    ).dependencies.screenshotSynthesizer.getScreenshot = () =>
      screenshotPromise;

    const activeStep = executor.step({
      durationMs: 1,
      control: {},
    });

    await expect(
      executor.step({
        durationMs: 1,
        control: {},
      })
    ).rejects.toBeInstanceOf(EmbodiedControlBusyError);

    resolveScreenshot('data:image/png;base64,test');
    await activeStep;
  });
});

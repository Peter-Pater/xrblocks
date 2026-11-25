import {expect, it} from 'vitest';
import {Options} from './Options';

it('enables dependent camera features without losing explicit camera settings', () => {
  const options = new Options();
  options.deviceCamera.targetDevice = 'aura';
  options.deviceCamera.willCaptureFrequently = true;
  options.enableObjectDetection();
  options.enableCamera('user');
  expect(options.permissions.camera).toBe(true);
  expect(options.deviceCamera.enabled).toBe(true);
  expect(options.deviceCamera.targetDevice).toBe('aura');
  expect(options.deviceCamera.willCaptureFrequently).toBe(true);
  expect(options.deviceCamera.videoConstraints?.facingMode).toBe('user');
});

it('enables splats with WebGPU defaults without losing explicit renderer or antialias settings', () => {
  const defaults = new Options().enableSplats();
  expect(defaults.splats.enabled).toBe(true);
  expect(defaults.rendererBackend).toBe('webgpu');
  expect(defaults.antialias).toBe(false);

  const explicit = new Options({
    antialias: true,
    framebufferScaleFactor: 1,
  });
  explicit.rendererBackend = 'webgl';
  explicit.enableSplats({minContribution: 2.25});
  expect(explicit.rendererBackend).toBe('webgl');
  expect(explicit.antialias).toBe(true);
  expect(explicit.framebufferScaleFactor).toBe(1);
  expect(explicit.splats.minContribution).toBe(2.25);
});

it('keeps the PCVR renderer and headset entry after a desktop automation preset', () => {
  const options = new Options().enableAutomationMode();
  options.webxrOptionalFeatures = ['unbounded', 'hand-tracking'];
  expect(options.permissions.camera).toBe(true);
  options.enablePCVR().enableSplats();
  expect(options.xrSessionMode).toBe('immersive-vr');
  expect(options.rendererBackend).toBe('webgl');
  expect(options.useXRWebGLBaseLayer).toBe(true);
  expect(options.enableSimulator).toBe(false);
  expect(options.xrButton).toMatchObject({
    enabled: true,
    startText: 'Enter PCVR',
    waitForStereoFrame: true,
  });
  expect(options.permissions.camera).toBe(false);
  expect(options.deviceCamera.enabled).toBe(false);
  expect(options.webxrOptionalFeatures).toEqual(['hand-tracking']);
});

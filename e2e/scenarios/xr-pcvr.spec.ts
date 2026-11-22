import {resolve} from 'node:path';
import {expect, test} from '@playwright/test';
import type {XRDevice} from 'iwer';
import type {Core} from '../../src/core/Core';

type PCVRWindow = Window & {
  IWER: typeof import('iwer');
  __pcvrDevice: XRDevice;
  xb: {core: Core};
};

test('PCVR template presents stereo frames and controller input without simulator fallback', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript({path: resolve('node_modules/iwer/build/iwer.js')});
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', {value: 'Win32'});
    const globals = window as PCVRWindow;
    const device = new globals.IWER.XRDevice({
      ...globals.IWER.metaQuest3,
      supportedSessionModes: ['inline', 'immersive-vr'],
    });
    device.installRuntime({forceInstall: true});
    globals.__pcvrDevice = device;
  });
  await page.goto(
    `${process.env.E2E_BASE_URL}/templates/16_pcvr/index.html?debug=1&xrAutomation=1`
  );
  const enter = page.getByRole('button', {name: 'Enter PCVR', exact: true});
  await expect(enter).toBeEnabled();
  await enter.click();
  const status = page.getByRole('status');
  await expect(status).toContainText('Stereo views: 2');
  expect(
    await page.evaluate(() => (window as PCVRWindow).xb.core.simulatorRunning)
  ).toBe(false);
  expect(
    await page.evaluate(
      () => (window as PCVRWindow).xb.core.renderer.xr.isPresenting
    )
  ).toBe(true);

  await page.evaluate(() => {
    const right = (window as PCVRWindow).__pcvrDevice.controllers.right;
    right.position.set(0, 1.4, -0.5);
    right.quaternion.set(0, 0, 0, 1);
  });
  await page.waitForTimeout(150);
  await page.evaluate(() =>
    (window as PCVRWindow).__pcvrDevice.controllers.right.updateButtonValue(
      'trigger',
      1
    )
  );
  await page.waitForTimeout(150);
  await page.evaluate(() =>
    (window as PCVRWindow).__pcvrDevice.controllers.right.updateButtonValue(
      'trigger',
      0
    )
  );
  await expect(status).toContainText('Selections: 1');
  // End through the runtime, as a headset's system menu would. IWER's
  // presentation canvas covers the desktop page while a session is active.
  await page.evaluate(() =>
    (window as PCVRWindow).xb.core.renderer.xr.getSession()!.end()
  );
  await expect(status).toContainText('VR session ended');
  await expect(enter).toBeEnabled();
  await enter.click();
  await expect(status).toContainText('Stereo views: 2');
  expect(errors).toEqual([]);
});

test('PCVR template refuses a Quest browser rather than rendering on the headset', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', {value: 'Linux armv8l'});
  });
  await page.goto(`${process.env.E2E_BASE_URL}/templates/16_pcvr/index.html`);
  await expect(page.getByRole('status')).toContainText(
    'on a Windows PC, not in Quest Browser'
  );
  await expect(page.getByRole('button', {name: 'Enter PCVR'})).toHaveCount(0);
});

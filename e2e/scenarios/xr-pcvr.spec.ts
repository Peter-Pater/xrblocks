import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, test, type Page} from '@playwright/test';
import type {XRDevice} from 'iwer';
import type {Core} from '../../src/core/Core';

type PCVRWindow = Window & {
  IWER: typeof import('iwer');
  __pcvrDevice: XRDevice;
  __resumePcvrFrames?: () => void;
  xb: {core: Core};
};

async function installSimulatedQuest(page: Page) {
  const iwer = readFileSync(resolve('node_modules/iwer/build/iwer.js'), 'utf8');
  const configureQuest = () => {
    Object.defineProperty(navigator, 'platform', {value: 'Win32'});
    const globals = window as PCVRWindow;
    const device = new globals.IWER.XRDevice({
      ...globals.IWER.metaQuest3,
      supportedSessionModes: ['inline', 'immersive-vr'],
    });
    device.installRuntime({forceInstall: true});
    globals.__pcvrDevice = device;
    // Simulate a browser that exposes projection layers with a runtime that
    // cannot present them. The template should still use XRWebGLLayer.
    Object.defineProperty(XRWebGLBinding.prototype, 'createProjectionLayer', {
      value() {
        throw new Error('Projection layers are unavailable on this runtime');
      },
    });
  };
  // Run the library and its configuration in the same script so order is deterministic.
  await page.addInitScript({
    content: iwer + '\n;(' + configureQuest.toString() + ')();',
  });
}

test('PCVR template presents stereo frames and controller input without simulator fallback', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installSimulatedQuest(page);
  await page.goto(
    `${process.env.E2E_BASE_URL}/templates/16_pcvr/index.html?debug=1&xrAutomation=1`
  );
  const xrMenu = page.getByRole('button', {name: 'XR', exact: true});
  const enter = page.getByRole('button', {name: 'Enter PCVR', exact: true});
  await expect(xrMenu).toHaveAttribute('aria-expanded', 'false');
  await expect(enter).toBeHidden();
  await xrMenu.click();
  await expect(enter).toBeEnabled();
  await enter.click();
  const status = page.getByRole('status');
  await expect(status).toContainText('Stereo views: 2');
  expect(await page.evaluate(() => typeof XRWebGLBinding)).toBe('function');
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
  // IWER's presentation canvas covers desktop inputs during an XR session.
  // Dispatch the actual dock button actions beneath it.
  await xrMenu.dispatchEvent('click');
  await expect(xrMenu).toHaveAttribute('aria-expanded', 'false');
  const compactExit = page.getByRole('button', {name: 'Exit XR', exact: true});
  await expect(compactExit).toBeEnabled();
  await compactExit.dispatchEvent('click');
  await expect(status).toContainText('VR session ended');
  await expect(compactExit).toBeHidden();
  await xrMenu.click();
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

test('keeps the first stereo frame warning visible when the menu is collapsed', async ({
  page,
}) => {
  await installSimulatedQuest(page);
  await page.goto(
    `${process.env.E2E_BASE_URL}/templates/16_pcvr/index.html?debug=1`
  );
  const enter = page.getByRole('button', {name: 'Enter PCVR', exact: true});
  await page.getByRole('button', {name: 'XR', exact: true}).click();
  await expect(enter).toBeEnabled();
  await page.evaluate(() => {
    const globals = window as PCVRWindow;
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) =>
      originalTimeout(callback, delay === 15_000 ? 1_200 : delay, ...args);
    const xr = navigator.xr!;
    const request = xr.requestSession.bind(xr);
    xr.requestSession = async (mode, init) => {
      const session = await request(mode, init);
      const next = session.requestAnimationFrame.bind(session);
      const cancel = session.cancelAnimationFrame.bind(session);
      let frame: XRFrameRequestCallback | undefined;
      session.requestAnimationFrame = (callback) => {
        frame = callback;
        return -1;
      };
      session.cancelAnimationFrame = (id) => {
        if (id === -1) frame = undefined;
        else cancel(id);
      };
      globals.__resumePcvrFrames = () => {
        session.requestAnimationFrame = next;
        session.cancelAnimationFrame = cancel;
        if (frame) next(frame);
      };
      return session;
    };
  });
  await enter.click();
  await expect(
    page.getByRole('button', {name: 'Exit XR', exact: true})
  ).toBeEnabled();
  await expect(
    page.getByText('Waiting for the first stereo frame…', {exact: true})
  ).toBeVisible();
  const xrMenu = page.getByRole('button', {name: 'XR', exact: true});
  await xrMenu.dispatchEvent('click');
  await expect(xrMenu).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('button', {name: 'Exit XR', exact: true})
  ).toBeEnabled();
  const warning = page.getByText('No stereo frame received.', {exact: false});
  await expect(warning).toBeVisible();
  await page.evaluate(() => (window as PCVRWindow).__resumePcvrFrames?.());
  await expect(page.getByRole('status')).toContainText('Stereo views: 2');
  await expect(warning).toBeHidden();
});

test('keeps the Roomcraft scene and edits when switching XR modes in either direction', async ({
  page,
}) => {
  await installSimulatedQuest(page);
  await page.goto(
    `${process.env.E2E_BASE_URL}/demos/roomcraft/index.html?environment=1`
  );
  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-startup', 'ready');
  await page.getByRole('button', {name: 'Moonlit garden', exact: true}).click();
  await expect(status).toContainText('Moonlit garden loaded');
  const sunrise = page.getByRole('button', {name: 'Sunrise', exact: true});
  await sunrise.click();
  await expect(status).toContainText('Set the environment to sunrise');
  await page.getByRole('button', {name: 'XR', exact: true}).click();
  await expect(
    page.getByRole('button', {name: 'Enter Standard XR', exact: true})
  ).toBeVisible();
  await page.getByRole('link', {name: 'Switch to PCVR', exact: true}).click();

  await expect(status).toContainText('Restored "Moonlit garden"');
  await expect(sunrise).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', {name: 'Enter PCVR'})).toBeEnabled();
  await expect(page).toHaveURL(/environment=1&pcvr=1$/);
  await page
    .getByRole('link', {name: 'Switch to Standard XR', exact: true})
    .click();

  await expect(status).toContainText('Restored "Moonlit garden"');
  await expect(sunrise).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/environment=1$/);
});

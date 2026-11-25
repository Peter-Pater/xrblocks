import * as THREE from 'three';
import {afterEach, expect, it, vi} from 'vitest';
import {
  WebXRSessionEventType,
  WebXRSessionManager,
} from './WebXRSessionManager';

let manager: WebXRSessionManager | undefined;
afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function session() {
  const result = Object.assign(new EventTarget(), {
    end: vi.fn(async () => {
      result.dispatchEvent(new Event('end'));
    }),
  });
  return result as unknown as XRSession;
}

it.each([
  {
    supported: ['immersive-ar'],
    fallback: true,
    required: ['hand-tracking'],
    expected: 'immersive-ar',
  },
  {
    supported: ['immersive-vr'],
    fallback: true,
    required: ['hand-tracking'],
    expected: 'immersive-vr',
  },
  {
    supported: ['immersive-vr'],
    fallback: false,
    required: [],
    expected: undefined,
  },
  {
    supported: ['immersive-vr'],
    fallback: true,
    required: ['camera-access'],
    expected: undefined,
  },
  {
    supported: ['immersive-vr'],
    fallback: true,
    required: ['depth-sensing'],
    expected: undefined,
  },
])(
  'requests a supported mode without weakening required capabilities: %j',
  async ({supported, fallback, required, expected}) => {
    const nativeSession = session();
    const requestSession = vi.fn(async () => nativeSession);
    vi.stubGlobal('navigator', {
      xr: Object.assign(new EventTarget(), {
        isSessionSupported: async (mode: string) => supported.includes(mode),
        requestSession,
      }),
    });
    manager = new WebXRSessionManager(
      {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
      {requiredFeatures: required, optionalFeatures: ['depth-sensing']},
      'immersive-ar',
      fallback
    );
    await manager.initialize();
    expect(manager.isXRSupported()).toBe(expected !== undefined);
    if (!expected) {
      expect(() => manager!.startSession()).toThrow();
      expect(requestSession).not.toHaveBeenCalled();
      return;
    }
    manager.startSession();
    await vi.waitFor(() => expect(manager!.currentSession).toBe(nativeSession));
    const [mode, configuration] = requestSession.mock.calls[0] as unknown as [
      string,
      XRSessionInit,
    ];
    expect(mode).toBe(expected);
    expect(configuration.requiredFeatures).toEqual(required);
    expect(configuration.optionalFeatures).toContain('depth-sensing');
  }
);

it.each(['request', 'setup'] as const)(
  'ends a late native session without adopting it after disposal during %s',
  async (stage) => {
    const requested = Promise.withResolvers<XRSession>();
    const setup = Promise.withResolvers<void>();
    const nativeSession = session();
    const setSession = vi.fn(() => setup.promise);
    vi.stubGlobal('navigator', {
      xr: Object.assign(new EventTarget(), {
        isSessionSupported: async () => true,
        requestSession: () => requested.promise,
      }),
    });
    manager = new WebXRSessionManager(
      {xr: {setSession}} as unknown as THREE.WebGLRenderer,
      {},
      'immersive-vr'
    );
    await manager.initialize();
    manager.startSession();
    try {
      if (stage === 'setup') {
        requested.resolve(nativeSession);
        await vi.waitFor(() => expect(setSession).toHaveBeenCalledOnce());
      }
      await manager.dispose();
      if (stage === 'setup') expect(nativeSession.end).toHaveBeenCalledOnce();
      requested.resolve(nativeSession);
      setup.resolve();
      await vi.waitFor(() => expect(nativeSession.end).toHaveBeenCalledOnce());
      expect(manager.currentSession).toBeUndefined();
      expect(() => manager!.startSession()).toThrow(/disposed/);
    } finally {
      requested.resolve(nativeSession);
      setup.resolve();
    }
  }
);

it('makes a headset connected after page load available without automatically entering XR', async () => {
  let connected = false;
  const nativeSession = session();
  const requestSession = vi.fn(async () => nativeSession);
  const offerSession = vi.fn(async () => nativeSession);
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => connected,
    requestSession,
    offerSession,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  await manager.initialize();
  expect(manager.isXRSupported()).toBe(false);
  connected = true;
  xr.dispatchEvent(new Event('devicechange'));
  await vi.waitFor(() => expect(manager!.isXRSupported()).toBe(true));
  expect(offerSession).not.toHaveBeenCalled();
  expect(requestSession).not.toHaveBeenCalled();
  manager.startSession();
  await vi.waitFor(() => expect(manager!.currentSession).toBe(nativeSession));

  // A device event must not replace the active session. Recheck when it ends.
  connected = false;
  xr.dispatchEvent(new Event('devicechange'));
  expect(manager.currentSession).toBe(nativeSession);
  await manager.endSession();
  await vi.waitFor(() => expect(manager!.isXRSupported()).toBe(false));
  expect(() => manager!.startSession()).toThrow(/not supported/);

  await manager.dispose();
  connected = true;
  xr.dispatchEvent(new Event('devicechange'));
  await Promise.resolve();
  expect(manager.isXRSupported()).toBe(false);
});

it('ignores an obsolete support check and restores the requested AR mode after reconnecting', async () => {
  let arAvailable = false;
  const delayed = Promise.withResolvers<boolean>();
  const isSessionSupported = vi.fn(async (mode: string) =>
    mode === 'immersive-vr' ? true : arAvailable
  );
  const nativeSession = session();
  const requestSession = vi.fn(async () => nativeSession);
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported,
    requestSession,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-ar'
  );
  await manager.initialize();
  isSessionSupported.mockImplementationOnce(() => delayed.promise);
  xr.dispatchEvent(new Event('devicechange'));
  arAvailable = true;
  xr.dispatchEvent(new Event('devicechange'));
  await vi.waitFor(() => expect(isSessionSupported).toHaveBeenCalledTimes(4));
  delayed.resolve(false);
  await Promise.resolve();
  manager.startSession();
  await vi.waitFor(() => expect(manager!.currentSession).toBe(nativeSession));
  expect(requestSession.mock.calls[0]).toEqual([
    'immersive-ar',
    expect.any(Object),
  ]);
});

it('uses a fresh headset check even when the original startup probe is still pending', async () => {
  const initial = Promise.withResolvers<boolean>();
  const latest = Promise.withResolvers<boolean>();
  const completed = vi.fn();
  const isSessionSupported = vi
    .fn()
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(latest.promise);
  const xr = Object.assign(new EventTarget(), {isSessionSupported});
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const initialized = manager.initialize().then(completed);
  xr.dispatchEvent(new Event('devicechange'));
  expect(isSessionSupported).toHaveBeenCalledTimes(2);
  expect(completed).not.toHaveBeenCalled();
  expect(manager.isXRSupported()).toBeUndefined();
  latest.resolve(false);
  await initialized;
  expect(manager.isXRSupported()).toBe(false);
  initial.resolve(true);
  await Promise.resolve();
  expect(manager.isXRSupported()).toBe(false);
});

it('refreshes headset availability when entry fails after a disconnect', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let connected = true;
  const entry = Promise.withResolvers<XRSession>();
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => connected,
    requestSession: () => entry.promise,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const sessionError = vi.fn();
  manager.addEventListener(WebXRSessionEventType.SESSION_ERROR, sessionError);
  await manager.initialize();
  manager.startSession();
  connected = false;
  const disconnect = new DOMException(
    'Headset disconnected',
    'NotSupportedError'
  );
  entry.reject(disconnect);
  await vi.waitFor(() => expect(manager!.isXRSupported()).toBe(false));
  expect(sessionError).toHaveBeenCalledWith(
    expect.objectContaining({error: disconnect})
  );
  connected = true;
  xr.dispatchEvent(new Event('devicechange'));
  await vi.waitFor(() => expect(manager!.isXRSupported()).toBe(true));
});

it('allows entering again when a native session ends during renderer setup', async () => {
  const firstSession = session();
  const secondSession = session();
  const setup = Promise.withResolvers<void>();
  const setSession = vi
    .fn()
    .mockReturnValueOnce(setup.promise)
    .mockResolvedValue(undefined);
  const isSessionSupported = vi.fn(async () => true);
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported,
    requestSession: vi
      .fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession),
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const started = vi.fn();
  manager.addEventListener(WebXRSessionEventType.SESSION_START, started);
  await manager.initialize();
  manager.startSession();
  try {
    await vi.waitFor(() =>
      expect(setSession).toHaveBeenCalledWith(firstSession)
    );
    await firstSession.end();
    expect(() => manager!.startSession()).toThrow(/renderer is resetting/);
    setup.resolve();
    await vi.waitFor(() => expect(isSessionSupported).toHaveBeenCalledTimes(2));
    expect(manager.currentSession).toBeUndefined();
    expect(started).not.toHaveBeenCalled();

    manager.startSession();
    await vi.waitFor(() => expect(manager!.currentSession).toBe(secondSession));
    expect(started).toHaveBeenCalledOnce();
  } finally {
    setup.resolve();
  }
});

it('finishes startup on timeout and recovers when the same browser probe succeeds late', async () => {
  vi.useFakeTimers();
  const initial = Promise.withResolvers<boolean>();
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: () => initial.promise,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const initialized = manager.initialize();
  await vi.advanceTimersToNextTimerAsync();
  await initialized;
  expect(manager.isXRSupported()).toBe(false);
  initial.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(manager.isXRSupported()).toBe(true);
});

it('releases startup when disposed while waiting for the browser', async () => {
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: () => new Promise<boolean>(() => {}),
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const initialized = manager.initialize();
  await manager.dispose();
  await initialized;
  expect(manager.isXRSupported()).toBeUndefined();
});

it('allows retry after entry times out and ends a late session', async () => {
  vi.useFakeTimers();
  const delayed = Promise.withResolvers<XRSession>();
  const late = session();
  const retry = session();
  const setSession = vi.fn(async () => {});
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => true,
    requestSession: vi
      .fn()
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(retry),
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const error = vi.fn();
  manager.addEventListener(WebXRSessionEventType.SESSION_ERROR, error);
  await manager.initialize();
  manager.startSession();
  await vi.advanceTimersToNextTimerAsync();
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      error: expect.objectContaining({name: 'TimeoutError'}),
    })
  );
  manager.startSession();
  await vi.advanceTimersByTimeAsync(0);
  expect(manager.currentSession).toBe(retry);
  delayed.resolve(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(late.end).toHaveBeenCalledOnce();
  expect(setSession).toHaveBeenCalledExactlyOnceWith(retry);
  expect(manager.currentSession).toBe(retry);
});

it('abandons a pending browser request when the headset disconnects', async () => {
  let connected = true;
  const delayed = Promise.withResolvers<XRSession>();
  const late = session();
  const setSession = vi.fn(async () => {});
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => connected,
    requestSession: () => delayed.promise,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const error = vi.fn();
  manager.addEventListener(WebXRSessionEventType.SESSION_ERROR, error);
  await manager.initialize();
  manager.startSession();
  connected = false;
  xr.dispatchEvent(new Event('devicechange'));
  await vi.waitFor(() => expect(manager!.isXRSupported()).toBe(false));
  expect(error).toHaveBeenCalledOnce();
  delayed.resolve(late);
  await vi.waitFor(() => expect(late.end).toHaveBeenCalledOnce());
  expect(setSession).not.toHaveBeenCalled();
});

it('ends a timed-out native session and prevents overlapping renderer setup', async () => {
  vi.useFakeTimers();
  const installing = Promise.withResolvers<void>();
  const expired = session();
  const retry = session();
  const setSession = vi
    .fn()
    .mockReturnValueOnce(installing.promise)
    .mockResolvedValue(undefined);
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => true,
    requestSession: vi
      .fn()
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(retry),
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  await manager.initialize();
  manager.startSession();
  await vi.advanceTimersByTimeAsync(0);
  expect(setSession).toHaveBeenCalledExactlyOnceWith(expired);
  await vi.advanceTimersToNextTimerAsync();
  expect(expired.end).toHaveBeenCalledOnce();
  expect(() => manager!.startSession()).toThrow(/renderer is resetting/);

  installing.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(manager.currentSession).toBeUndefined();
  manager.startSession();
  await vi.advanceTimersByTimeAsync(0);
  expect(manager.currentSession).toBe(retry);
  expect(expired.end).toHaveBeenCalledOnce();
});

it('bounds overall startup even when device changes restart the availability probe', async () => {
  vi.useFakeTimers();
  const isSessionSupported = vi.fn(() => new Promise<boolean>(() => {}));
  const xr = Object.assign(new EventTarget(), {isSessionSupported});
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const ready = vi.fn();
  const initialized = manager.initialize().then(ready);
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(3_000);
    xr.dispatchEvent(new Event('devicechange'));
  }
  await vi.advanceTimersByTimeAsync(999);
  expect(ready).not.toHaveBeenCalled();
  expect(isSessionSupported).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  await initialized;
  expect(manager.isXRSupported()).toBe(false);
});

it('recovers after a timed-out exit when the native end event eventually arrives', async () => {
  vi.useFakeTimers();
  const native = session();
  vi.mocked(native.end).mockReturnValue(new Promise<void>(() => {}));
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => true,
    requestSession: async () => native,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  await manager.initialize();
  manager.startSession();
  await vi.advanceTimersByTimeAsync(0);
  const ending = manager.endSession().catch((error: unknown) => error);
  await vi.advanceTimersToNextTimerAsync();
  expect(await ending).toMatchObject({name: 'TimeoutError'});
  expect(manager.currentSession).toBe(native);
  native.dispatchEvent(new Event('end'));
  expect(manager.currentSession).toBeUndefined();
  expect(native.end).toHaveBeenCalledOnce();
});

it('bounds disposal and shares the native close request already started by a disconnect', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let connected = true;
  const native = session();
  const setup = Promise.withResolvers<void>();
  vi.mocked(native.end).mockReturnValue(new Promise<void>(() => {}));
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => connected,
    requestSession: async () => native,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: () => setup.promise}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const ready = vi.fn();
  await manager.initialize();
  manager.startSession();
  await vi.advanceTimersByTimeAsync(0);
  connected = false;
  xr.dispatchEvent(new Event('devicechange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(native.end).toHaveBeenCalledOnce();
  const disposed = manager.dispose().then(ready, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersToNextTimerAsync();
  expect(await disposed).toMatchObject({name: 'TimeoutError'});
  setup.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(native.end).toHaveBeenCalledOnce();
  expect(manager.currentSession).toBeUndefined();
  manager = undefined;
});

it('completes native exit on the end event even if the end promise is still pending', async () => {
  vi.useFakeTimers();
  const native = session();
  vi.mocked(native.end).mockReturnValue(new Promise<void>(() => {}));
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => true,
    requestSession: async () => native,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {xr: {setSession: async () => {}}} as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr'
  );
  const ended = vi.fn();
  manager.addEventListener(WebXRSessionEventType.SESSION_END, ended);
  await manager.initialize();
  manager.startSession();
  await vi.advanceTimersByTimeAsync(0);
  const ending = manager.endSession();
  await vi.advanceTimersByTimeAsync(0);
  native.dispatchEvent(new Event('end'));
  await ending;
  expect(manager.currentSession).toBeUndefined();
  expect(ended).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  'tracks an unconfirmed native close until disposal or a late end event: %s',
  async (endsLate) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let connected = true;
    const native = session();
    const setup = Promise.withResolvers<void>();
    const stillOpen = new DOMException(
      'The headset still owns the session',
      'OperationError'
    );
    vi.mocked(native.end)
      .mockReturnValueOnce(new Promise<void>(() => {}))
      .mockRejectedValueOnce(stillOpen);
    const xr = Object.assign(new EventTarget(), {
      isSessionSupported: async () => connected,
      requestSession: async () => native,
    });
    vi.stubGlobal('navigator', {xr});
    manager = new WebXRSessionManager(
      {xr: {setSession: () => setup.promise}} as unknown as THREE.WebGLRenderer,
      {},
      'immersive-vr'
    );
    await manager.initialize();
    manager.startSession();
    await vi.advanceTimersByTimeAsync(0);

    connected = false;
    xr.dispatchEvent(new Event('devicechange'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersToNextTimerAsync();
    setup.resolve();
    connected = true;
    xr.dispatchEvent(new Event('devicechange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(() => manager!.startSession()).toThrow(/has not released/);

    if (endsLate) {
      native.dispatchEvent(new Event('end'));
      await manager.dispose();
      expect(native.end).toHaveBeenCalledOnce();
    } else {
      await expect(manager.dispose()).rejects.toBe(stillOpen);
      expect(native.end).toHaveBeenCalledTimes(2);
      manager = undefined;
    }
  }
);

it('requires a current stereo frame and recovers after the first-frame warning', async () => {
  vi.useFakeTimers();
  const native = session();
  const xr = Object.assign(new EventTarget(), {
    isSessionSupported: async () => true,
    requestSession: async () => native,
  });
  vi.stubGlobal('navigator', {xr});
  manager = new WebXRSessionManager(
    {
      xr: {setSession: async () => {}, getReferenceSpace: () => ({})},
    } as unknown as THREE.WebGLRenderer,
    {},
    'immersive-vr',
    true,
    true
  );
  const states: string[] = [];
  manager.addEventListener(
    WebXRSessionEventType.STEREO_FRAME_STATUS,
    ({state}) => states.push(state)
  );
  const frame = (count: number, frameSession = native) =>
    ({
      session: frameSession,
      getViewerPose: () => ({views: Array.from({length: count})}),
    }) as unknown as XRFrame;
  await manager.initialize();
  manager.startSession();
  await vi.advanceTimersByTimeAsync(0);
  manager.onFrameRendered(frame(1));
  manager.onFrameRendered(frame(2, session()));
  expect(states).toEqual(['waiting']);
  await vi.advanceTimersToNextTimerAsync();
  expect(states).toEqual(['waiting', 'timed-out']);
  expect(manager.currentSession).toBe(native);
  manager.onFrameRendered(frame(2));
  manager.onFrameRendered(frame(2));
  expect(states).toEqual(['waiting', 'timed-out', 'ready']);
  await manager.endSession();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

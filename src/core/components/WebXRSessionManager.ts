import * as THREE from 'three';

import {
  isWebGPUBackendActive,
  type WebGLOrWebGPURenderer,
} from '../RendererTypes';

// A Quest Link entry can take over a minute while Chromium creates its swapchain.
const SUPPORT_CHECK_TIMEOUT_MS = 10_000;
const SESSION_ENTRY_TIMEOUT_MS = 150_000;
const SESSION_END_TIMEOUT_MS = 10_000;
const FIRST_STEREO_FRAME_TIMEOUT_MS = 15_000;

type InitialSupport = PromiseWithResolvers<void> & {
  timeout: ReturnType<typeof setTimeout>;
};

type SupportCheck = {
  offerSession: boolean;
  timeout: ReturnType<typeof setTimeout>;
};

type SessionAttempt = {
  kind: 'request' | 'offer';
  timeout: ReturnType<typeof setTimeout>;
  session?: XRSession;
};

export enum WebXRSessionEventType {
  UNSUPPORTED = 'unsupported',
  READY = 'ready',
  BEFORE_SESSION_START = 'beforesessionstart',
  SESSION_START = 'sessionstart',
  STEREO_FRAME_STATUS = 'stereoframestatus',
  SESSION_END = 'sessionend',
  SESSION_ERROR = 'sessionerror',
}

export type WebXRSessionManagerEventMap = THREE.Object3DEventMap & {
  [WebXRSessionEventType.UNSUPPORTED]: object;
  [WebXRSessionEventType.READY]: {sessionOptions: XRSessionInit};
  [WebXRSessionEventType.BEFORE_SESSION_START]: {session: XRSession};
  [WebXRSessionEventType.SESSION_START]: {session: XRSession};
  [WebXRSessionEventType.STEREO_FRAME_STATUS]: {
    state: 'waiting' | 'ready' | 'timed-out';
  };
  [WebXRSessionEventType.SESSION_END]: object;
  [WebXRSessionEventType.SESSION_ERROR]: {error: unknown};
};

/** Manages WebXR availability, session entry, and native session ownership. */
export class WebXRSessionManager extends THREE.EventDispatcher<WebXRSessionManagerEventMap> {
  public currentSession?: XRSession;
  private sessionOptions?: XRSessionInit;
  private xrModeSupported?: boolean;
  private disposed = false;
  private disposalPromise?: Promise<void>;
  private xrSystem?: XRSystem;
  private initialSupport?: InitialSupport;
  private supportCheck?: SupportCheck;
  private attempt?: SessionAttempt;
  private installingSession?: XRSession;
  private closingSessions = new Map<XRSession, Promise<void>>();
  private detachedSessions = new Set<XRSession>();
  private firstStereoFrame?: {
    session: XRSession;
    timeout: ReturnType<typeof setTimeout>;
  };
  private sessionMode: XRSessionMode;

  constructor(
    private renderer: WebGLOrWebGPURenderer,
    private sessionInit: XRSessionInit,
    private mode: XRSessionMode,
    private fallbackToVR = true,
    private waitForStereoFrame = false
  ) {
    super();
    this.sessionMode = mode;
  }

  /** Waits for the latest availability check before startup chooses a fallback. */
  public async initialize() {
    if (this.disposed || this.currentSession) return;
    if (this.initialSupport) return this.initialSupport.promise;

    const xr = navigator.xr;
    if (!xr) {
      this.xrModeSupported = false;
      this.dispatchEvent({type: WebXRSessionEventType.UNSUPPORTED});
      return;
    }

    if (this.xrSystem !== xr) {
      this.xrSystem?.removeEventListener('devicechange', this.onDeviceChange);
      this.xrSystem = xr;
      xr.addEventListener('devicechange', this.onDeviceChange);
    }

    const initial = Promise.withResolvers<void>();
    this.initialSupport = {
      ...initial,
      // The overall startup deadline is independent of device-change probes.
      timeout: setTimeout(() => {
        try {
          if (this.supportCheck) this.onSupportTimeout(this.supportCheck);
        } finally {
          this.resolveInitialSupport();
        }
      }, SUPPORT_CHECK_TIMEOUT_MS),
    };
    this.checkSupport(true);
    await initial.promise;
  }

  private onDeviceChange = () => this.checkSupport();

  private checkSupport(offerSession = false) {
    const xr = this.xrSystem;
    if (!xr || this.disposed || this.currentSession) return;

    this.clearSupportCheck();
    const check: SupportCheck = {
      offerSession,
      timeout: setTimeout(
        () => this.onSupportTimeout(check),
        SUPPORT_CHECK_TIMEOUT_MS
      ),
    };
    this.supportCheck = check;
    void this.probeSupport(xr, check);
  }

  private onSupportTimeout(check: SupportCheck) {
    if (this.supportCheck !== check) return;
    clearTimeout(check.timeout);
    // Let this result still restore availability if no newer probe supersedes it.
    check.offerSession = false;
    if (this.currentSession || this.attempt || this.xrModeSupported === false)
      return;
    this.xrModeSupported = false;
    this.dispatchEvent({type: WebXRSessionEventType.UNSUPPORTED});
  }

  private async probeSupport(xr: XRSystem, check: SupportCheck) {
    let mode: XRSessionMode | null = null;
    try {
      if (await xr.isSessionSupported(this.mode)) {
        mode = this.mode;
      } else if (
        this.supportCheck === check &&
        this.canFallBackToVR() &&
        (await xr.isSessionSupported('immersive-vr'))
      ) {
        mode = 'immersive-vr';
      }
    } catch (error) {
      if (this.supportCheck !== check) return;
      console.warn('Error checking WebXR availability', error);
      this.applySupportResult(check, undefined);
      return;
    }
    this.applySupportResult(check, mode);
  }

  /**
   * A null mode is a confirmed absence of support. A timeout or failed probe
   * leaves an in-flight entry alone until it finishes or reaches its own limit.
   */
  private applySupportResult(
    check: SupportCheck,
    mode: XRSessionMode | null | undefined
  ) {
    if (this.supportCheck !== check) return;
    this.clearSupportCheck();
    try {
      if (this.disposed || this.currentSession) return;
      if (mode === undefined && this.attempt) return;

      const supported = !!mode;
      const availabilityChanged =
        this.xrModeSupported !== supported ||
        (supported && this.sessionMode !== mode);
      this.xrModeSupported = supported;
      if (mode) {
        this.sessionMode = mode;
        this.sessionOptions = {
          ...this.sessionInit,
          optionalFeatures: this.sessionInit.optionalFeatures || [],
        };

        // Leave the entry UI alone while a request is in progress.
        if (!this.attempt && (availabilityChanged || check.offerSession)) {
          this.dispatchEvent({
            type: WebXRSessionEventType.READY,
            sessionOptions: this.sessionOptions,
          });
        }
        if (
          check.offerSession &&
          this.xrSystem?.offerSession &&
          !this.supportCheck &&
          !this.attempt &&
          !this.disposed &&
          !this.currentSession &&
          !this.installingSession &&
          !this.detachedSessions.size
        ) {
          this.beginAttempt('offer');
        }
      } else {
        if (this.attempt) {
          this.failAttempt(
            this.attempt,
            new DOMException(
              'XR headset is no longer available.',
              'NotSupportedError'
            ),
            false
          );
        }
        if (availabilityChanged || check.offerSession) {
          this.dispatchEvent({type: WebXRSessionEventType.UNSUPPORTED});
        }
      }
    } finally {
      if (!this.supportCheck) this.resolveInitialSupport();
    }
  }

  private clearSupportCheck() {
    clearTimeout(this.supportCheck?.timeout);
    this.supportCheck = undefined;
  }

  private resolveInitialSupport() {
    const initial = this.initialSupport;
    this.initialSupport = undefined;
    clearTimeout(initial?.timeout);
    initial?.resolve();
  }

  /** Keeps applications that require AR camera or depth on their requested mode. */
  private canFallBackToVR() {
    const required = this.sessionInit.requiredFeatures ?? [];
    return (
      this.fallbackToVR &&
      this.mode === 'immersive-ar' &&
      !required.includes('camera-access') &&
      !required.includes('depth-sensing')
    );
  }

  public startSession() {
    if (this.disposed) {
      throw new Error('WebXRSessionManager has been disposed');
    } else if (this.xrModeSupported === undefined) {
      throw new Error('Initialize not yet complete');
    } else if (!this.xrModeSupported) {
      throw new Error('WebXR not supported');
    } else if (this.currentSession) {
      throw new Error('Session already started');
    } else if (this.attempt?.kind === 'request') {
      throw new Error('Waiting for session to start');
    } else if (this.installingSession || this.attempt?.session) {
      throw new Error(
        'The XR renderer is resetting. Reload the page if it does not finish.'
      );
    }

    if (this.closingSessions.size) {
      throw new Error(
        'The previous XR session is still closing. Try again shortly.'
      );
    }

    if (this.detachedSessions.size) {
      throw new Error(
        'The browser has not released the previous XR session. Reload the page before trying again.'
      );
    }

    // A browser offering a session must not block the explicit entry button.
    this.clearAttempt();
    this.beginAttempt('request');
  }

  private beginAttempt(kind: SessionAttempt['kind']) {
    const attempt: SessionAttempt = {
      kind,
      timeout: setTimeout(
        () =>
          this.failAttempt(
            attempt,
            new DOMException(
              'Entering XR timed out. Check the headset connection and try again.',
              'TimeoutError'
            )
          ),
        SESSION_ENTRY_TIMEOUT_MS
      ),
    };
    this.attempt = attempt;
    void this.runAttempt(attempt);
  }

  private async runAttempt(attempt: SessionAttempt) {
    try {
      const xr = this.xrSystem!;
      const session = await (attempt.kind === 'offer'
        ? xr.offerSession!(this.sessionMode, this.sessionOptions)
        : xr.requestSession(this.sessionMode, this.sessionOptions));

      if (this.attempt !== attempt) {
        if (
          session !== this.currentSession &&
          session !== this.attempt?.session
        ) {
          this.releaseDetachedSession(session);
        }
        return;
      }

      attempt.session = session;
      session.addEventListener('end', this.onSessionEndedInternal);
      this.dispatchEvent({
        type: WebXRSessionEventType.BEFORE_SESSION_START,
        session,
      });
      if (this.attempt !== attempt) return;

      // The renderer stores the session internally before its setup completes.
      // Prevent overlapping writes if an old native session is ended early.
      this.installingSession = session;
      try {
        await this.renderer.xr.setSession(session);
      } finally {
        this.installingSession = undefined;
      }
      if (this.attempt !== attempt) return;

      this.clearAttempt();
      this.currentSession = session;
      this.clearSupportCheck();
      this.resolveInitialSupport();
      this.dispatchEvent({type: WebXRSessionEventType.SESSION_START, session});
      this.trackFirstStereoFrame(session);
    } catch (error) {
      if (this.attempt !== attempt) return;
      const session = attempt.session as
        | (XRSession & {enabledFeatures?: string[]})
        | undefined;
      if (
        session &&
        isWebGPUBackendActive(this.renderer) &&
        !session.enabledFeatures?.includes('webgpu')
      ) {
        console.error(
          'WebXR session did not grant the "webgpu" feature even though XRGPUBinding was present. ' +
            'In Chrome on Android XR, enable both chrome://flags/#webxr-webgpu-binding and ' +
            'chrome://flags/#webxr-projection-layers, or launch with ?forceWebGL=true to use the WebGL2 fallback.'
        );
      }
      this.failAttempt(attempt, error);
    }
  }

  private trackFirstStereoFrame(session: XRSession) {
    if (!this.waitForStereoFrame || this.currentSession !== session) return;
    this.firstStereoFrame = {
      session,
      timeout: setTimeout(() => {
        this.dispatchEvent({
          type: WebXRSessionEventType.STEREO_FRAME_STATUS,
          state: 'timed-out',
        });
      }, FIRST_STEREO_FRAME_TIMEOUT_MS),
    };
    this.dispatchEvent({
      type: WebXRSessionEventType.STEREO_FRAME_STATUS,
      state: 'waiting',
    });
  }

  /** Records stereo readiness after the renderer has drawn the frame. */
  public onFrameRendered(frame?: XRFrame) {
    const pending = this.firstStereoFrame;
    if (!pending || !frame || pending.session !== frame.session) return;
    const space = this.renderer.xr.getReferenceSpace();
    if (!space || (frame.getViewerPose(space)?.views.length ?? 0) < 2) return;
    this.clearFirstStereoFrame();
    this.dispatchEvent({
      type: WebXRSessionEventType.STEREO_FRAME_STATUS,
      state: 'ready',
    });
  }

  private clearFirstStereoFrame() {
    clearTimeout(this.firstStereoFrame?.timeout);
    this.firstStereoFrame = undefined;
  }

  private failAttempt(
    attempt: SessionAttempt,
    error: unknown,
    refreshSupport = true
  ) {
    if (this.attempt !== attempt) return;
    this.clearAttempt();
    if (attempt.session) this.releaseDetachedSession(attempt.session);
    if (attempt.kind === 'request' || attempt.session) {
      this.dispatchEvent({type: WebXRSessionEventType.SESSION_ERROR, error});
    }
    if (refreshSupport) this.checkSupport();
  }

  private clearAttempt() {
    const attempt = this.attempt;
    clearTimeout(attempt?.timeout);
    this.attempt = undefined;
    return attempt?.session;
  }

  /** Ends the active immersive session. */
  public async endSession(): Promise<void> {
    const session = this.currentSession;
    if (!session) throw new Error('No session to end');
    await this.closeNativeSession(session);
  }

  /** Returns undefined until the initial browser availability check settles. */
  public isXRSupported() {
    return this.xrModeSupported;
  }

  public getSessionOptions() {
    return this.sessionOptions;
  }

  private onSessionEndedInternal = (event: Event) => {
    const session = event.currentTarget as XRSession | null;
    if (session) this.finishSession(session);
  };

  private finishSession(session: XRSession) {
    session.removeEventListener('end', this.onSessionEndedInternal);
    this.detachedSessions.delete(session);
    if (this.attempt?.session === session) {
      this.clearAttempt();
    } else if (this.currentSession === session) {
      this.currentSession = undefined;
      this.clearFirstStereoFrame();
    } else {
      return;
    }
    if (!this.disposed) {
      this.xrModeSupported = undefined;
      this.dispatchEvent({type: WebXRSessionEventType.SESSION_END});
      this.checkSupport();
    }
  }

  private closeNativeSession(session: XRSession) {
    const ongoing = this.closingSessions.get(session);
    if (ongoing) return ongoing;

    const ended = Promise.withResolvers<void>();
    const onEnd = () => ended.resolve();
    session.addEventListener('end', onEnd, {once: true});
    const deadline = setTimeout(() => {
      ended.reject(
        new DOMException(
          'Ending XR timed out. Check the headset connection and try again.',
          'TimeoutError'
        )
      );
    }, SESSION_END_TIMEOUT_MS);
    const closing = ended.promise
      .then(() => this.finishSession(session))
      .finally(() => {
        clearTimeout(deadline);
        session.removeEventListener('end', onEnd);
        this.closingSessions.delete(session);
      });
    this.closingSessions.set(session, closing);
    void Promise.resolve()
      .then(() => session.end())
      .then(ended.resolve, ended.reject);
    return closing;
  }

  private releaseDetachedSession(session: XRSession) {
    // A failed or timed-out close does not prove that the headset is free.
    this.detachedSessions.add(session);
    session.addEventListener('end', this.onSessionEndedInternal);
    void this.closeNativeSession(session).catch((error) => {
      console.warn('Could not end an unfinished XR session', error);
    });
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    this.xrSystem?.removeEventListener('devicechange', this.onDeviceChange);
    this.clearSupportCheck();
    this.resolveInitialSupport();
    this.clearFirstStereoFrame();
    const pendingSession = this.clearAttempt();
    if (pendingSession) this.detachedSessions.add(pendingSession);
    if (this.currentSession) this.detachedSessions.add(this.currentSession);
    this.currentSession = undefined;
    for (const session of this.detachedSessions) {
      this.closeNativeSession(session);
    }
    this.disposalPromise = Promise.allSettled(
      this.closingSessions.values()
    ).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
    return this.disposalPromise;
  }
}

import {PermissionsManager} from './PermissionsManager';
import {
  WebXRSessionEventType,
  WebXRSessionManager,
} from './WebXRSessionManager';
import {XRButtonMenu} from './XRButtonMenu';

const XRBUTTON_WRAPPER_ID = 'XRButtonWrapper';
const XRBUTTON_CLASS = 'XRButton';

export class XRButton {
  public domElement = document.createElement('div');
  public simulatorButtonElement = document.createElement('button');
  public xrButtonElement = document.createElement('button');
  private errorElement = document.createElement('p');
  private stereoFrameStatusElement = document.createElement('p');
  private headsetStatusElement = document.createElement('p');
  private disposed = false;
  private startingSimulator = false;
  private simulatorRunning = false;
  private menu?: XRButtonMenu;

  constructor(
    private sessionManager: WebXRSessionManager,
    private permissionsManager: PermissionsManager,
    private appTitle = '',
    private appDescription = '',
    private startText = 'ENTER XR',
    private endText = 'END XR',
    private invalidText = 'XR NOT SUPPORTED',
    private startSimulatorText = 'START SIMULATOR',
    showEnterSimulatorButton = false,
    public startSimulator: () => void | Promise<unknown> = () => {},
    private permissions = {
      geolocation: false,
      camera: false,
      microphone: false,
    },
    private menuOptions?: {
      pcvrModeSwitch?: boolean;
      isPCVR?: boolean;
      beforeModeSwitch?: (destination: URL) => boolean;
    }
  ) {
    this.domElement.id = XRBUTTON_WRAPPER_ID;
    if (menuOptions) {
      if (
        menuOptions.pcvrModeSwitch &&
        !menuOptions.isPCVR &&
        this.startText === 'Enter XR'
      ) {
        this.startText = 'Enter Standard XR';
      }
      this.menu = new XRButtonMenu(
        this.domElement,
        this.xrButtonElement,
        !!menuOptions.pcvrModeSwitch,
        menuOptions.beforeModeSwitch
      );
    }
    this.createXRAppTitle();
    this.createXRAppDescription();
    this.createXRButtonElement();
    this.menu?.appendModeSwitch();

    if (showEnterSimulatorButton) {
      this.createSimulatorButton();
    }
    this.stereoFrameStatusElement.hidden = true;
    this.stereoFrameStatusElement.setAttribute('aria-live', 'polite');
    this.stereoFrameStatusElement.style.maxWidth = 'min(90vw, 40rem)';
    if (this.menu) {
      this.menu.attachFrameStatus(this.stereoFrameStatusElement);
    } else {
      this.contentElement.appendChild(this.stereoFrameStatusElement);
    }
    this.headsetStatusElement.hidden = true;
    this.contentElement.appendChild(this.headsetStatusElement);
    this.createErrorElement();

    this.sessionManager.addEventListener(
      WebXRSessionEventType.UNSUPPORTED,
      this.onUnsupported
    );
    this.sessionManager.addEventListener(
      WebXRSessionEventType.READY,
      this.onReady
    );
    this.sessionManager.addEventListener(
      WebXRSessionEventType.SESSION_START,
      this.onSessionStart
    );
    this.sessionManager.addEventListener(
      WebXRSessionEventType.STEREO_FRAME_STATUS,
      this.onStereoFrameStatus
    );
    this.sessionManager.addEventListener(
      WebXRSessionEventType.SESSION_END,
      this.onSessionEnd
    );
    this.sessionManager.addEventListener(
      WebXRSessionEventType.SESSION_ERROR,
      this.onSessionError
    );
  }

  get usesMenu() {
    return !!this.menu;
  }

  private get contentElement() {
    return this.menu?.panel ?? this.domElement;
  }

  private updateMenu() {
    this.menu?.update(!!this.sessionManager.currentSession);
  }

  private onUnsupported = () => this.showXRNotSupported();
  private onReady = () => this.onSessionReady();
  private onSessionStart = () => this.onSessionStarted();
  private onStereoFrameStatus = (event: {
    state: 'waiting' | 'ready' | 'timed-out';
  }) => {
    this.stereoFrameStatusElement.hidden = event.state === 'ready';
    this.stereoFrameStatusElement.textContent =
      event.state === 'timed-out'
        ? 'No stereo frame received. Keep the headset awake or select Exit XR and retry.'
        : 'Waiting for the first stereo frame…';
  };
  private onSessionEnd = () => this.onSessionEnded();
  private onSessionError = (event: {error: unknown}) =>
    this.showError(event.error);

  private createErrorElement() {
    this.errorElement.className = 'XRButtonError';
    this.errorElement.setAttribute('role', 'alert');
    this.errorElement.style.maxWidth = 'min(90vw, 40rem)';
    this.errorElement.hidden = true;
    this.contentElement.appendChild(this.errorElement);
  }

  private showError(
    error: unknown,
    mode: 'XR' | 'Simulator' = 'XR',
    action: 'start' | 'end' = 'start'
  ) {
    if (this.disposed) return;
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    this.errorElement.textContent = `${mode} could not ${action}. ${detail}`;
    this.errorElement.hidden = false;
    this.menu?.setOpen(true);
    if (mode === 'Simulator') return;
    const active = !!this.sessionManager.currentSession;
    const supported = this.sessionManager.isXRSupported() === true;
    this.xrButtonElement.textContent = active
      ? this.endText
      : supported
        ? this.startText
        : this.invalidText;
    this.xrButtonElement.disabled =
      this.startingSimulator ||
      this.simulatorRunning ||
      (!active && !supported);
    this.simulatorButtonElement.disabled =
      this.startingSimulator || this.simulatorRunning || active;
    this.updateMenu();
  }

  private createSimulatorButton() {
    this.simulatorButtonElement.classList.add(XRBUTTON_CLASS);
    this.simulatorButtonElement.innerText = this.startSimulatorText;
    this.simulatorButtonElement.onclick = async () => {
      if (this.disposed || this.simulatorButtonElement.disabled) return;
      this.setSimulatorStarting(true);
      this.errorElement.textContent = '';
      this.errorElement.hidden = true;
      try {
        await this.startSimulator();
        if (this.disposed) return;
        if (this.usesMenu) this.setSimulatorRunning();
        else this.domElement.remove();
      } catch (error) {
        if (this.disposed) return;
        this.setSimulatorStarting(false);
        this.showError(error, 'Simulator');
      }
    };
    this.contentElement.appendChild(this.simulatorButtonElement);
  }

  private createXRAppTitle() {
    if (!this.appTitle) {
      return;
    }
    const appTitle = document.createElement('h1');
    appTitle.textContent = this.appTitle;
    this.contentElement.appendChild(appTitle);
  }

  private createXRAppDescription() {
    if (!this.appDescription) {
      return;
    }
    const appDescription = document.createElement('h4');
    appDescription.textContent = this.appDescription;
    this.contentElement.appendChild(appDescription);
  }

  private createXRButtonElement() {
    this.xrButtonElement.classList.add(XRBUTTON_CLASS);
    this.xrButtonElement.disabled = true;
    this.xrButtonElement.textContent = '...';
    this.contentElement.appendChild(this.xrButtonElement);
  }

  private onSessionReady() {
    if (this.simulatorRunning) {
      this.showXRNotSupported();
      return;
    }
    this.stereoFrameStatusElement.hidden = true;
    this.headsetStatusElement.hidden = true;
    this.errorElement.textContent = '';
    this.errorElement.hidden = true;
    const button = this.xrButtonElement;
    button.style.display = '';
    button.innerHTML = this.startText;
    button.disabled = this.startingSimulator;
    this.simulatorButtonElement.disabled = this.startingSimulator;
    this.updateMenu();

    const allowsVideoFallback = this.sessionManager
      .getSessionOptions()
      ?.optionalFeatures?.includes('camera-access');

    button.onclick = () => {
      if (this.disposed || button.disabled) return;
      this.errorElement.textContent = '';
      this.errorElement.hidden = true;
      button.textContent = 'ENTERING XR...';
      button.disabled = true;
      this.simulatorButtonElement.disabled = true;
      this.updateMenu();
      this.permissionsManager
        .checkAndRequestPermissions(this.permissions, {
          allowVideoFallback: allowsVideoFallback,
        })
        .then((result) => {
          if (this.disposed) return;
          if (result.granted) {
            this.sessionManager.startSession();
          } else {
            this.showError(
              new Error(result.error || 'Browser permission was not granted.')
            );
          }
        })
        .catch((error) => this.showError(error));
    };
  }

  private showXRNotSupported() {
    this.xrButtonElement.textContent = this.simulatorRunning
      ? 'Simulator active'
      : this.invalidText;
    this.xrButtonElement.disabled = true;
    if (this.menuOptions?.isPCVR || this.simulatorRunning) {
      this.headsetStatusElement.textContent = this.simulatorRunning
        ? 'Reload with a connected headset to enter XR.'
        : 'Start wired Meta Horizon Link on the headset, then try again.';
      this.headsetStatusElement.hidden = false;
    }
    this.updateMenu();
  }

  private onSessionStarted() {
    this.headsetStatusElement.hidden = true;
    this.errorElement.textContent = '';
    this.errorElement.hidden = true;
    this.xrButtonElement.innerHTML = this.endText;
    this.xrButtonElement.disabled = this.startingSimulator;
    this.simulatorButtonElement.disabled = true;
    this.updateMenu();
    this.xrButtonElement.onclick = async () => {
      const session = this.sessionManager.currentSession;
      if (!session || this.disposed || this.xrButtonElement.disabled) return;
      this.errorElement.textContent = '';
      this.errorElement.hidden = true;
      this.xrButtonElement.textContent = 'EXITING XR...';
      this.xrButtonElement.disabled = true;
      this.updateMenu();
      try {
        await this.sessionManager.endSession();
      } catch (error) {
        if (this.sessionManager.currentSession === session) {
          this.showError(error, 'XR', 'end');
        }
      }
    };
  }

  private onSessionEnded() {
    this.stereoFrameStatusElement.hidden = true;
    this.headsetStatusElement.hidden = true;
    this.errorElement.hidden = true;
    if (this.simulatorRunning) {
      this.showXRNotSupported();
      return;
    }
    this.xrButtonElement.textContent = 'Checking for a headset…';
    this.xrButtonElement.disabled = true;
    this.simulatorButtonElement.disabled = this.startingSimulator;
    this.updateMenu();
  }

  setSimulatorRunning() {
    this.simulatorRunning = true;
    this.simulatorButtonElement.hidden = true;
    this.showXRNotSupported();
  }

  setSimulatorStarting(starting: boolean) {
    if (this.disposed) return;
    this.startingSimulator = starting;
    this.simulatorButtonElement.disabled =
      starting || this.simulatorRunning || !!this.sessionManager.currentSession;
    this.xrButtonElement.disabled =
      starting ||
      this.simulatorRunning ||
      this.sessionManager.isXRSupported() !== true;
    this.updateMenu();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sessionManager.removeEventListener(
      WebXRSessionEventType.UNSUPPORTED,
      this.onUnsupported
    );
    this.sessionManager.removeEventListener(
      WebXRSessionEventType.READY,
      this.onReady
    );
    this.sessionManager.removeEventListener(
      WebXRSessionEventType.SESSION_START,
      this.onSessionStart
    );
    this.sessionManager.removeEventListener(
      WebXRSessionEventType.STEREO_FRAME_STATUS,
      this.onStereoFrameStatus
    );
    this.sessionManager.removeEventListener(
      WebXRSessionEventType.SESSION_END,
      this.onSessionEnd
    );
    this.sessionManager.removeEventListener(
      WebXRSessionEventType.SESSION_ERROR,
      this.onSessionError
    );
    this.menu?.dispose();
    this.simulatorButtonElement.onclick = null;
    this.xrButtonElement.onclick = null;
    this.domElement.remove();
  }
}

/**
 * Compact, shared XR launcher for SDK pages. The normal entry button still
 * owns permissions and native session transitions.
 */
export class XRButtonMenu {
  readonly panel = document.createElement('div');
  private readonly trigger = document.createElement('button');
  private readonly exit = document.createElement('button');
  private modeLink?: HTMLAnchorElement;
  private frameStatus?: HTMLElement;
  private active = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly action: HTMLButtonElement,
    pcvrModeSwitch: boolean,
    beforeModeSwitch?: (destination: URL) => boolean
  ) {
    installStyles();
    root.classList.add('XRButtonDock');
    this.panel.id = 'XRButtonMenu';
    this.panel.className = 'XRMenuPanel';
    this.trigger.type = 'button';
    this.trigger.className = 'XRMenuTrigger';
    this.trigger.textContent = 'XR';
    this.trigger.setAttribute('aria-controls', this.panel.id);
    this.trigger.onclick = () => this.setOpen(this.panel.hidden);
    this.exit.type = 'button';
    this.exit.className = 'XRMenuTrigger';
    this.exit.onclick = () => action.click();
    root.append(this.trigger, this.exit, this.panel);
    root.addEventListener('keydown', this.onKeydown);

    const url = new URL(window.location.href);
    const pcvrSelected = url.searchParams.get('pcvr') === '1';
    if (pcvrModeSwitch && navigator.platform?.startsWith('Win')) {
      this.modeLink = document.createElement('a');
      if (pcvrSelected) {
        url.searchParams.delete('pcvr');
        this.modeLink.textContent = 'Switch to Standard XR';
      } else {
        url.searchParams.set('pcvr', '1');
        this.modeLink.textContent = 'Switch to PCVR';
      }
      this.modeLink.href = url.href;
      this.modeLink.className = 'XRMenuModeLink';
      if (beforeModeSwitch) {
        this.modeLink.onclick = (event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          event.preventDefault();
          const destination = new URL(url);
          if (beforeModeSwitch(destination))
            window.location.assign(destination);
        };
      }
    }
    // An explicit PCVR mode selection leads straight to its entry button.
    this.setOpen(!!this.modeLink && pcvrSelected);
  }

  appendModeSwitch() {
    if (this.modeLink) this.panel.appendChild(this.modeLink);
  }

  attachFrameStatus(status: HTMLElement) {
    this.frameStatus = status;
    status.classList.add('XRMenuFrameStatus');
    this.placeFrameStatus();
  }

  private placeFrameStatus() {
    const parent = this.panel.hidden ? this.root : this.panel;
    if (this.frameStatus && this.frameStatus.parentElement !== parent) {
      parent.appendChild(this.frameStatus);
    }
  }

  setOpen(open: boolean) {
    this.panel.hidden = !open;
    this.placeFrameStatus();
    this.trigger.setAttribute('aria-expanded', String(open));
    this.update(this.active);
  }

  update(active: boolean) {
    this.active = active;
    this.exit.hidden = !active || !this.panel.hidden;
    this.exit.disabled = this.action.disabled;
    this.exit.textContent = this.action.textContent;
    if (this.modeLink) this.modeLink.hidden = active;
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || this.panel.hidden) return;
    event.preventDefault();
    this.setOpen(false);
    this.trigger.focus();
  };

  dispose() {
    this.root.removeEventListener('keydown', this.onKeydown);
    this.trigger.onclick = null;
    this.exit.onclick = null;
    if (this.modeLink) this.modeLink.onclick = null;
  }
}

function installStyles() {
  const id = 'XRButtonMenuStyles';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    #XRButtonWrapper.XRButtonDock {
      position: fixed;
      top: max(0.75rem, env(safe-area-inset-top));
      right: max(0.75rem, env(safe-area-inset-right));
      bottom: auto;
      left: auto;
      z-index: 20;
      display: flex;
      flex-direction: row-reverse;
      align-items: center;
      gap: 0.4rem;
      width: auto;
      height: auto;
      color: #f1f5f9;
      font: 0.875rem/1.45 system-ui, sans-serif;
      text-align: left;
      pointer-events: none;
    }
    #XRButtonWrapper.XRButtonDock [hidden] { display: none !important; }
    #XRButtonWrapper.XRButtonDock .XRMenuTrigger {
      pointer-events: auto;
      cursor: pointer;
      border: 1px solid #66778f;
      border-radius: 999px;
      background: #101b2c;
      color: #f1f5f9;
      padding: 0.4rem 0.85rem;
      min-height: 2.3rem;
      font: inherit;
      font-weight: 600;
      text-transform: none;
    }
    #XRButtonWrapper.XRButtonDock .XRMenuPanel {
      position: absolute;
      top: calc(100% + 0.5rem);
      right: 0;
      width: min(20rem, calc(100vw - 1.5rem));
      max-height: calc(100dvh - 4.5rem);
      overflow: auto;
      display: grid;
      gap: 0.625rem;
      padding: 0.9rem;
      box-sizing: border-box;
      border: 1px solid #43546a;
      border-radius: 0.75rem;
      background: #101b2c;
      color: #f1f5f9;
      box-shadow: 0 6px 28px #0007;
      pointer-events: auto;
    }
    #XRButtonWrapper.XRButtonDock .XRMenuPanel :is(h1, h4, p) {
      margin: 0;
      font: inherit;
    }
    #XRButtonWrapper.XRButtonDock .XRMenuPanel h1 { font-weight: 700; }
    #XRButtonWrapper.XRButtonDock > .XRMenuFrameStatus {
      position: absolute;
      top: calc(100% + 0.5rem);
      right: 0;
      box-sizing: border-box;
      width: min(20rem, calc(100vw - 1.5rem));
      margin: 0;
      padding: 0.65rem 0.85rem;
      border: 1px solid #43546a;
      border-radius: 0.5rem;
      background: #101b2c;
    }
    #XRButtonWrapper.XRButtonDock .XRMenuPanel .XRButton {
      border: 0;
      border-radius: 0.5rem;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      padding: 0.55rem 0.7rem;
      margin: 0;
      display: block;
      background: #d4e8ff;
      color: #112238;
      font: inherit;
      font-weight: 600;
      text-align: left;
      text-transform: none;
      text-decoration: none;
      box-shadow: none;
      transform: none;
    }
    #XRButtonWrapper.XRButtonDock .XRMenuPanel .XRButton::after { display: none; }
    #XRButtonWrapper.XRButtonDock .XRMenuModeLink {
      justify-self: start;
      padding: 0.2rem 0;
      color: #d4e8ff;
      text-decoration: underline;
      text-underline-offset: 0.15em;
    }
    #XRButtonWrapper.XRButtonDock :is(button, a):focus-visible {
      outline: 2px solid #91c5ff;
      outline-offset: 2px;
    }
    #XRButtonWrapper.XRButtonDock button:disabled {
      opacity: 0.65;
      cursor: default;
    }
  `;
  document.head.appendChild(style);
}

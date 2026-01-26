import * as xb from 'xrblocks';

// --- Interfaces ---

/** Defines the structure for special functional keys. */
interface SpecialKey {
  position: 'left'|'right'|'center';
  type: 'tab'|'backspace'|'shift_lock'|'enter'|'shift'|'space';
  iconName: string;
  weight?: number;
  backgroundColor?: string;
}

/** Defines the layout for a single row of the keyboard. */
interface LayoutRow {
  textKeys?: string;
  shiftKeys?: string;
  specialKeys: SpecialKey[];
}

/** Configuration options for individual keyboard buttons. */
interface KeyboardButtonOptions {
  text: string;
  fontSize: number;
  backgroundColor: string;
  originalKey: string;
  shiftKey?: string|null;
}

// --- Constants ---

const KEY_WIDTH: number = 0.068;
const KEY_HEIGHT: number = 0.10;
const FONT_SIZE: number = 0.45;
const KEYBOARD_COLOR: string = '#5149ae';
const DEFAULT_KEY_COLOR: string = '#aa3939';
const SPECIAL_KEY_COLOR: string = '#3cb436';

const KEY_LAYOUT: LayoutRow[] = [
  {
    textKeys: '`1234567890-+',
    shiftKeys: '~!@#$%^&*()_+',
    specialKeys: [],
  },
  {
    textKeys: 'qwertyuiop',
    specialKeys: [
      {
        position: 'left',
        type: 'tab',
        iconName: 'keyboard_tab',
        weight: (KEY_WIDTH * 1.2)
      },
      {position: 'right', type: 'backspace', iconName: 'backspace'},
    ],
  },
  {
    textKeys: 'asdfghjkl',
    specialKeys: [
      {
        position: 'left',
        type: 'shift_lock',
        iconName: 'lock',
        weight: (KEY_WIDTH * 1.5)
      },
      {
        position: 'right',
        type: 'enter',
        iconName: 'keyboard_return',
        backgroundColor: '#449eb9'
      },
    ],
  },
  {
    textKeys: 'zxcvbnm,.',
    specialKeys: [
      {
        position: 'left',
        type: 'shift',
        iconName: 'keyboard_capslock',
        weight: (KEY_WIDTH * 2.1)
      },
      {position: 'right', type: 'shift', iconName: 'keyboard_capslock'},
    ],
  },
  {
    specialKeys: [
      {
        position: 'center',
        type: 'space',
        iconName: 'space_bar',
        weight: (KEY_WIDTH * 9)
      },
    ],
  },
];

const COL_SPACER: number = 0.01;
const ROW_SPACER: number = 0.015;
const TOTAL_KEYBOARD_WIDTH: number = 1.0;
const TOTAL_KEYBOARD_HEIGHT: number =
    (KEY_LAYOUT.length * KEY_HEIGHT) + ((KEY_LAYOUT.length - 1) * ROW_SPACER);

// --- Classes ---

class KeyboardButton extends xb.TextButton {
  public originalKey: string;
  public shiftKey?: string|null;

  constructor(options: KeyboardButtonOptions) {
    super(options);
    this.originalKey = options.originalKey;
    this.shiftKey = options.shiftKey;
  }
}

class Keyboard extends xb.Script {
  private keyText: string = '';
  private isShifted: boolean = false;
  private isCapsLockOn: boolean = false;
  private textButtons: KeyboardButton[] = [];

  /** Callback triggered when text content changes. */
  public onTextChanged: ((text: string) => void)|null = null;
  /** Callback triggered when the enter key is pressed. */
  public onEnterPressed: ((text: string) => void)|null = null;

  private subspace: any;  // Using any for specialized SDK UI components
  private mainGrid: any;

  constructor() {
    super();

    this.subspace = new xb.SpatialPanel({
      showEdge: true,
      backgroundColor: KEYBOARD_COLOR,
      width: 1.0,
      height: TOTAL_KEYBOARD_HEIGHT,
    });
    this.subspace.isRoot = true;
    this.add(this.subspace);

    this.mainGrid = new xb.Grid({height: 1.0});
    this.subspace.add(this.mainGrid);

    this.createKeyboard();
    this.subspace.updateLayouts();
  }

  public override init(): void {
    this.subspace.position.set(0, 1.2, -1);
  }

  private createKeyboard(): void {
    KEY_LAYOUT.forEach((rowData, index) => {
      this.createRow(rowData);
      if (index < KEY_LAYOUT.length - 1) {
        this.mainGrid.addRow({weight: ROW_SPACER});
      }
    });
  }

  private createRow(rowData: LayoutRow): void {
    const row = this.mainGrid.addRow({weight: KEY_HEIGHT});

    if (rowData.specialKeys.some(k => k.type === 'space')) {
      const spaceKey = rowData.specialKeys.find(k => k.type === 'space')!;
      const sidePadding = (TOTAL_KEYBOARD_WIDTH - (spaceKey.weight || 0)) / 2;
      row.addCol({weight: sidePadding});
      this.addKey(row, spaceKey);
      row.addCol({weight: sidePadding});
      return;
    }

    const leftSpecial = rowData.specialKeys.filter(
        k => k.position === 'left' || k.position === 'center');
    const rightSpecial =
        rowData.specialKeys.filter(k => k.position === 'right');
    const textKeys = rowData.textKeys ? rowData.textKeys.split('') : [];
    const shiftKeys = rowData.shiftKeys ? rowData.shiftKeys.split('') : [];

    let currentOccupiedWeight: number = 0;

    leftSpecial.forEach(keyData => {
      this.addKey(row, keyData);
      currentOccupiedWeight += (keyData.weight || KEY_WIDTH);
    });

    if (leftSpecial.length > 0 && textKeys.length > 0) {
      row.addCol({weight: COL_SPACER});
      currentOccupiedWeight += COL_SPACER;
    }

    textKeys.forEach((char, i) => {
      const shiftChar = shiftKeys[i] || null;
      this.addKey(row, char, shiftChar);
      currentOccupiedWeight += KEY_WIDTH;
      if (i < textKeys.length - 1 || rightSpecial.length > 0) {
        row.addCol({weight: COL_SPACER});
        currentOccupiedWeight += COL_SPACER;
      }
    });

    rightSpecial.forEach(keyData => {
      const remainingWidth = Math.max(0.05, 1.0 - currentOccupiedWeight);
      this.addKey(row, {...keyData, weight: remainingWidth});
    });
  }

  private addKey(
      row: any, data: string|SpecialKey, shiftChar: string|null = null): void {
    const isSpecial = typeof data === 'object';
    const weight = isSpecial ? (data.weight || KEY_WIDTH) : KEY_WIDTH;
    const backgroundColor = isSpecial ?
        (data.backgroundColor || SPECIAL_KEY_COLOR) :
        DEFAULT_KEY_COLOR;

    const keyPanel = row.addCol({weight: weight}).addPanel({
      backgroundColor: backgroundColor,
      margin: 0.05
    });
    keyPanel.useBorderlessShader = true;

    if (isSpecial && data.iconName) {
      const btn = new xb.IconButton({
        text: data.iconName,
        fontSize: FONT_SIZE,
        backgroundColor: '#00000000'
      });
      btn.onTriggered = () => this.handleSpecialKey(data.type);
      keyPanel.add(btn);
    } else {
      const char = typeof data === 'string' ? data : (data as any).text;
      const btn = new KeyboardButton({
        text: char,
        fontSize: FONT_SIZE,
        originalKey: char,
        shiftKey: shiftChar,
        backgroundColor: '#00000000'
      });
      this.textButtons.push(btn);
      btn.onTriggered = () => this.handleKeyPress(btn.text);
      keyPanel.add(btn);
    }
  }

  private handleKeyPress(char: string): void {
    this.keyText += char;
    console.log(`Current Text: "${this.keyText}"`);
    this.onTextChanged?.(this.keyText);

    if (this.isShifted) {
      this.isShifted = false;
      this.refreshKeyboard();
    }
  }

  private handleSpecialKey(type: SpecialKey['type']): void {
    switch (type) {
      case 'backspace':
        this.keyText = this.keyText.slice(0, -1);
        console.log(`Deleted. Current Text: "${this.keyText}"`);
        break;
      case 'space':
        this.handleKeyPress(' ');
        break;
      case 'shift':
        this.isShifted = !this.isShifted;
        this.refreshKeyboard();
        break;
      case 'shift_lock':
        this.isCapsLockOn = !this.isCapsLockOn;
        this.refreshKeyboard();
        break;
      case 'tab':
        this.handleKeyPress('\t');
        break;
      case 'enter':
        console.log(`Enter pressed. Current Text: "${this.keyText}"`);
        this.onEnterPressed?.(this.keyText);
        break;
      default:
        console.warn(`Unhandled special key type: ${type}`);
    }
    this.onTextChanged?.(this.keyText);
  }

  private refreshKeyboard(): void {
    this.textButtons.forEach((button) => {
      const isLetter =
          button.originalKey.length === 1 && /[a-z]/i.test(button.originalKey);
      let newText: string;
      const produceUpper = this.isShifted !== this.isCapsLockOn;

      if (isLetter) {
        newText = produceUpper ? button.originalKey.toUpperCase() :
                                 button.originalKey.toLowerCase();
      } else {
        newText = this.isShifted ? (button.shiftKey || button.originalKey) :
                                   button.originalKey;
      }
      button.setText(newText);
    });
  }

  /** Externally update the current text buffer. */
  public setText(text: string): void {
    this.keyText = text;
    this.onTextChanged?.(this.keyText);
  }
}

export {Keyboard};

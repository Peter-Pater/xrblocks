import 'xrblocks/addons/simulator/SimulatorAddons.js';

import * as THREE from 'three';
import {
  HeadLeashBehavior,
  ManipulationBehavior,
  UICore,
  UIIcon,
  UIPanel,
  UIText,
} from 'uiblocks';
import {
  AgentHands,
  parseAgentGestures,
} from 'xrblocks/addons/agenthands/index.js';
import {Object3DDetector} from 'xrblocks/addons/objects3d/index.js';
import * as xb from 'xrblocks';

// AgentHands demo: a free-standing pair of agent hands that gesture as the
// agent speaks.
//
// Without a Gemini key it plays a scripted monologue. Provide a key (?key=...)
// to talk to the agent: it replies with [gesture:...] markup, which is parsed
// into hand gestures played in sync with spoken (TTS) text.

const META_INSTRUCTION = `You are a friendly assistant with a visible pair of hands you gesture with. Reply in one or two short sentences. Embed gesture markup inline using [gesture:NAME] right before the word it emphasizes, where NAME is one of: point, thumbs_up, thumbs_down, fist, victory, rock, open. Use a gesture or two per reply.

You can physically point at real things in the room. When the user asks where something is, or you refer to a real object, point at it with [point:LABEL] where LABEL is one of the visible objects listed below. Only point at objects from that list. Do not mention the markup.`;

const SCRIPT = [
  'Hi there! [gesture:thumbs_up] great to see you.',
  'Look at that [gesture:point] over on the shelf.',
  'Two options [gesture:victory] to choose from.',
  'Got it [gesture:fist], let me handle that.',
];

class AgentHandsDemo extends xb.Script {
  constructor() {
    super();
    this.hands = new AgentHands();
    this.queue = [];
    this.timer = 0;
    this.busy = false;
    this.interactive = false;
    this.detector = null;
    this.detectedObjects = [];
    this.lastDetectAt = 0;
    this.scanning_ = false;
  }

  async init() {
    xb.core.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(0.5, 1, 1);
    xb.core.scene.add(key);

    await this.hands.load();
    // Raised in front of the user, fingers up, palms toward them.
    this.hands.position.set(0, 1.25, -0.7);
    this.hands.rotation.set(Math.PI / 2, 0, 0);
    this.hands.left.root.position.set(-0.16, 0, 0);
    this.hands.right.root.position.set(0.16, 0, 0);
    xb.core.scene.add(this.hands);

    this.interactive = !!xb.core.ai?.model?.options?.apiKey;
    this.buildSpatialPanel_();

    if (this.interactive) {
      this.startInteractive_();
      // Scan the room once up front (in the background) so questions never
      // wait on detection. The user can re-scan from the panel.
      this.scan_();
    } else {
      this.setStatus_('no key, playing a scripted demo. add ?key= to talk.');
      this.playLine_(0);
    }
  }

  // ---- spatial control panel (works in XR + simulator) ----

  buildSpatialPanel_() {
    this.uiCore = new UICore(this);
    const card = this.uiCore.createCard({
      name: 'AgentHandsControlCard',
      position: new THREE.Vector3(0, 0.7, -0.8),
      sizeX: 0.62,
      sizeY: 0.22,
    });
    const panel = new UIPanel({
      width: '100%',
      height: '100%',
      fillColor: 'rgba(16, 14, 26, 0.94)',
      strokeWidth: 2,
      strokeColor: 'rgba(145, 119, 199, 0.55)',
      cornerRadius: 18,
      padding: 14,
      flexDirection: 'column',
      gap: 8,
      alignItems: 'stretch',
      justifyContent: 'center',
    });
    panel.add(
      new UIText('AGENT HANDS', {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#c4b5ff',
        textAlign: 'center',
        width: '100%',
      })
    );
    this.xrStatusText = new UIText('idle', {
      fontSize: 12,
      color: '#8b97a7',
      textAlign: 'center',
      width: '100%',
    });
    panel.add(this.xrStatusText);
    panel.add(
      new UIPanel({
        width: '100%',
        height: 1,
        fillColor: 'rgba(255, 255, 255, 0.10)',
      })
    );
    const row = new UIPanel({
      width: '100%',
      flexDirection: 'row',
      gap: 10,
      justifyContent: 'center',
      alignItems: 'center',
    });
    if (this.interactive) {
      row.add(this.makeXrButton_('mic', 'talk', () => this.onTalk_()));
      row.add(this.makeXrButton_('search', 'scan', () => this.scan_()));
    } else {
      row.add(this.makeXrButton_('replay', 'replay', () => this.replay_()));
    }
    panel.add(row);
    card.add(panel);
    card.addBehavior(
      new ManipulationBehavior({draggable: true, faceCamera: false})
    );
    // Gently follow the user so the controls stay in reach as they move.
    card.addBehavior(
      new HeadLeashBehavior({
        offset: new THREE.Vector3(0, -0.55, -0.85),
        posLerp: 0.08,
        rotLerp: 0.1,
      })
    );
  }

  // Icon + caption button mirroring a DOM control (matches world_companion).
  makeXrButton_(iconName, label, onClick) {
    const idle = '#2a2a2a';
    const hover = '#3a3a3a';
    const btn = new UIPanel({
      paddingTop: 8,
      paddingBottom: 8,
      paddingLeft: 16,
      paddingRight: 16,
      cornerRadius: 12,
      fillColor: idle,
      strokeWidth: 1,
      strokeColor: '#444444',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      renderOrder: 10,
      onHoverEnter: () => btn.setFillColor(hover),
      onHoverExit: () => btn.setFillColor(idle),
      onClick: () => {
        btn.setFillColor('#9177c7');
        setTimeout(() => btn.setFillColor(idle), 180);
        onClick();
      },
    });
    btn.add(
      new UIIcon(iconName, {
        color: 'white',
        width: 22,
        height: 22,
        renderOrder: 12,
      })
    );
    btn.add(
      new UIText(label, {
        fontSize: 14,
        color: '#ffffff',
        fontWeight: 'bold',
        depthTest: false,
        renderOrder: 100,
      })
    );
    return btn;
  }

  // Triggered by either the DOM Talk button or the spatial mic button.
  onTalk_() {
    if (this.interactive) {
      xb.core.sound?.speechRecognizer?.start();
    } else {
      this.replay_();
    }
  }

  replay_() {
    if (this.interactive) return;
    this.playLine_(0);
  }

  // ---- interactive (Gemini) mode ----

  startInteractive_() {
    const button = document.getElementById('talk');
    const recognizer = xb.core.sound?.speechRecognizer;
    if (button) {
      button.style.display = 'block';
      button.addEventListener('click', () => recognizer?.start());
    }
    recognizer?.addEventListener('result', (event) => {
      if (event.isFinal && event.transcript.trim()) {
        this.respond_(event.transcript.trim());
      }
    });
    this.setStatus_('press talk and say something to the agent.');
  }

  async respond_(userText) {
    if (this.busy) return;
    this.busy = true;
    this.setStatus_(`you: "${userText}"  ·  thinking...`);
    try {
      // Use whatever the last scan found; never block the reply on detection.
      const labels = this.detectedObjects.map((o) => o.label);
      const seen = labels.length
        ? `Visible objects you can point at: ${labels.join(', ')}.`
        : 'You have not scanned the room yet, so avoid pointing.';
      const result = await xb.core.ai.query({
        prompt: `${META_INSTRUCTION}\n\n${seen}\n\nUser: ${userText}\nAssistant:`,
      });
      const reply = typeof result === 'string' ? result : (result?.text ?? '');
      const {text, gestures} = parseAgentGestures(reply);
      this.speakWithGestures_(text || "I'm not sure what to say.", gestures);
    } catch (error) {
      console.error('[agent_hands]', error);
      this.setStatus_('error talking to Gemini (see console).');
    } finally {
      this.busy = false;
    }
  }

  // Scans the room for objects in the background. Detection (Gemini + SAM +
  // depth fitting) is slow, so it runs off the conversation's critical path:
  // the agent points at whatever the most recent scan found.
  scan_() {
    if (!this.detector || this.scanning_) return;
    this.scanning_ = true;
    const wasInteractive = this.interactive;
    this.setStatus_('scanning the room for objects...');
    this.ensureDetection_().finally(() => {
      this.scanning_ = false;
      if (!wasInteractive) return;
      const n = this.detectedObjects.length;
      this.setStatus_(
        n
          ? `found ${n} things i can point at. press talk.`
          : 'press talk and say something to the agent.'
      );
    });
  }

  // Runs 3D object detection. Detected objects are Detected3DObject with a
  // `.label` and an oriented bounding box (`.obb`), so we can point at the box
  // surface nearest the agent's hand.
  async ensureDetection_() {
    if (!this.detector) return;
    try {
      const objects = await this.detector.detect();
      if (objects?.length) {
        this.detectedObjects = objects;
        this.lastDetectAt = performance.now();
      }
    } catch (error) {
      console.warn('[agent_hands] object detection failed', error);
    }
  }

  // Finds a detected object whose label best matches a point target.
  findObject_(label) {
    if (!label) return null;
    const needle = label.toLowerCase().replace(/^the\s+/, '');
    let best = null;
    for (const obj of this.detectedObjects) {
      const hay = obj.label.toLowerCase();
      if (hay === needle) return obj;
      if (!best && (hay.includes(needle) || needle.includes(hay))) best = obj;
    }
    return best;
  }

  // Speaks `text` and schedules each gesture at its relative point in the line.
  speakWithGestures_(text, gestures) {
    this.setStatus_(`agent: "${text}"`);
    xb.core.sound?.speechSynthesizer?.speak(text);
    const duration = Math.max(1.2, text.length * 0.06);
    this.queue = [];
    for (const gesture of gestures) {
      const at = (gesture.index / Math.max(1, text.length)) * duration;
      const step = {at, pose: gesture.pose};
      // A point gesture with a resolvable target aims at the object: pick the
      // box surface point nearest the agent's hands so it reaches the near face.
      if (gesture.target) {
        const obj = this.findObject_(gesture.target);
        if (obj) {
          const from = this.hands.getWorldPosition(new THREE.Vector3());
          step.point = obj.nearestSurfacePointTo(from, new THREE.Vector3());
        }
      }
      this.queue.push(step);
    }
    this.queue.push({at: duration + 0.8, rest: true});
    this.timer = 0;
  }

  // ---- scripted (no-key) mode ----

  playLine_(index) {
    const {text, gestures} = parseAgentGestures(SCRIPT[index % SCRIPT.length]);
    this.setStatus_(`agent: "${text}"`);
    this.queue = [];
    let t = 0.4;
    for (const gesture of gestures) {
      this.queue.push({at: t, pose: gesture.pose});
      t += 1.2;
    }
    this.queue.push({at: t + 0.4, pose: xb.SimulatorHandPose.RELAXED});
    this.queue.push({at: t + 2.2, next: (index + 1) % SCRIPT.length});
    this.timer = 0;
  }

  update() {
    const dt = xb.getDeltaTime?.() ?? 0.016;
    this.timer += dt;
    while (this.queue.length && this.timer >= this.queue[0].at) {
      const step = this.queue.shift();
      if (step.point) {
        this.hands.pointAt(step.point);
      } else if (step.rest) {
        this.hands.rest();
      } else if (step.pose) {
        this.hands.gesture(step.pose);
      }
      if (step.next !== undefined) this.playLine_(step.next);
    }
    this.hands.update();
  }

  setStatus_(text) {
    console.log('[agent_hands]', text);
    const el = document.getElementById('status');
    if (el) el.textContent = text;
    // The spatial font lacks some glyphs (e.g. the ellipsis), so normalize.
    if (this.xrStatusText) this.xrStatusText.setText(text.replace(/…/g, '...'));
  }
}

function start() {
  const options = new xb.Options();
  options.enableAI();
  // Spatial UI (the control panel) + reticle for pointing at it.
  options.enableUI();
  options.reticles.enabled = true;
  options.sound.speechSynthesizer.enabled = true;
  options.sound.speechRecognizer.enabled = true;
  // 3D object detection so the hands can point at real things in the room.
  options.deviceCamera.enabled = true;
  options.permissions.camera = true;
  options.world.enableObjectDetection();
  options.world.objects.backendConfig.activeBackend = 'gemini';
  options.world.objects.showDebugVisualizations = false;
  // Ask Gemini for an exhaustive object list so there is more to point at.
  options.world.objects.backendConfig.gemini.systemInstruction =
    'List every distinct object visible in the image, including small items ' +
    '(cups, books, remotes), wall-mounted things (pictures, switches, TVs), ' +
    'and ceiling fixtures (lamps, lights). For each, return ymin, xmin, ymax, ' +
    'xmax as integers from 0 to 1000 (top-left origin) and a short lowercase ' +
    'objectName. List up to 20 objects. Skip walls, floor, ceiling, and any ' +
    'human body parts or UI elements attached to them.';
  // Full-resolution depth mesh gives the OBB fitter denser samples.
  options.depth.enabled = true;
  options.depth.depthMesh.enabled = true;
  options.depth.depthMesh.updateFullResolutionGeometry = true;
  options.depth.depthTexture.enabled = false;
  options.depth.matchDepthView = false;
  options.setAppTitle('Agent Hands');
  options.setAppDescription(
    'A pair of agent hands that gesture as the agent speaks. Add ?key=... to ' +
      'talk to it.'
  );
  options.xrButton.showEnterSimulatorButton = true;

  const detector = new Object3DDetector({
    detectBackend: 'gemini',
    maskBackend: 'slimsam',
    fuseAcrossViews: true,
    showDebugBoxes: false,
  });
  const demo = new AgentHandsDemo();
  demo.detector = detector;
  window.agentHandsDemo = demo;
  xb.add(detector);
  xb.add(demo);
  xb.init(options);
}

document.addEventListener('DOMContentLoaded', start);

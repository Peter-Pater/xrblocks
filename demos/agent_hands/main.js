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
    this.detectedObjects = [];
    this.lastDetectAt = 0;
    this.scanning_ = false;
    this._scanPromise = null;
    this._ndc = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    // Auto-rescan bookkeeping: re-detect in the background when the view moves.
    this._camPos = new THREE.Vector3();
    this._camQuat = new THREE.Quaternion();
    this._scanCamPos = new THREE.Vector3();
    this._scanCamQuat = new THREE.Quaternion();
    this._lastScanAt = 0;
    // Head-anchor + idle-life state.
    this._anchored = false;
    this._anchorQuat = new THREE.Quaternion();
    this._anchorPos = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forward = new THREE.Vector3();
    this._clock = 0;
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

  // ---- embodiment: head-anchor + idle life ----

  // Keeps the hands floating in front of the user (position + yaw) so they stay
  // in view as the user walks/turns, with a gentle idle bob and sway.
  anchorToHead_() {
    const cam = xb.core.camera;
    if (!cam) return;
    cam.getWorldPosition(this._camPos);
    cam.getWorldQuaternion(this._camQuat);
    this._euler.setFromQuaternion(this._camQuat, 'YXZ');
    const yaw = this._euler.y;

    // Position: 0.7 m in front of the user at the yaw heading, a touch below
    // eye level, with a slow breathing bob.
    const bob = Math.sin(this._clock * 1.4) * 0.012;
    this._forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this._anchorPos
      .copy(this._camPos)
      .addScaledVector(this._forward, -0.7)
      .add(new THREE.Vector3(0, -0.35 + bob, 0));
    if (!this._anchored) {
      this.hands.position.copy(this._anchorPos);
      this._anchored = true;
    } else {
      this.hands.position.lerp(this._anchorPos, 0.08);
    }

    // Orientation: face the user (yaw) + the fingers-up tilt, plus a gentle
    // idle sway.
    const sway = Math.sin(this._clock * 0.8) * 0.02;
    this._euler.set(Math.PI / 2, yaw + sway, 0, 'YXZ');
    this._anchorQuat.setFromEuler(this._euler);
    this.hands.quaternion.slerp(this._anchorQuat, 0.08);
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
    try {
      // Detection swaps the shared Gemini config to a JSON schema while it
      // runs, so a scan and a chat turn must not overlap or the reply comes
      // back as detection JSON. Wait for any in-flight scan to finish first.
      if (this.scanning_ && this._scanPromise) {
        this.setStatus_('one sec...');
        await this._scanPromise.catch(() => {});
      }
      this.setStatus_(`you: "${userText}"  ·  thinking...`);
      // Use whatever the last scan found; never block the reply on detection.
      const labels = this.detectedObjects.map((o) => o.label);
      const seen = labels.length
        ? `Visible objects you can point at: ${labels.join(', ')}.`
        : 'You have not scanned the room yet, so avoid pointing.';
      const result = await xb.core.ai.query({
        prompt: `${META_INSTRUCTION}\n\n${seen}\n\nUser: ${userText}\nAssistant:`,
      });
      const reply = typeof result === 'string' ? result : (result?.text ?? '');
      // Safety net: if a detection JSON reply still slips through, don't read
      // it aloud.
      const clean = /^\s*[[{]/.test(reply.trim()) ? '' : reply;
      const {text, gestures} = parseAgentGestures(clean);
      this.speakWithGestures_(
        text || 'Sorry, could you say that again?',
        gestures
      );
    } catch (error) {
      console.error('[agent_hands]', error);
      this.setStatus_('error talking to Gemini (see console).');
    } finally {
      this.busy = false;
    }
  }

  // Scans the room for objects in the background. Detection is a Gemini vision
  // call, so it runs off the conversation's critical path: the agent points at
  // whatever the most recent scan found. `silent` auto-scans don't touch the
  // status text so they don't interrupt the agent mid-reply.
  scan_(silent = false) {
    // Never scan during a chat turn: detection mutates the shared Gemini
    // config, which would corrupt an in-flight reply.
    if (this.busy || this.scanning_) return;
    if (!xb.core.world?.objects?.runDetection) return;
    this.scanning_ = true;
    const wasInteractive = this.interactive;
    if (!silent) this.setStatus_('scanning the room for objects...');
    this._scanPromise = this.ensureDetection_().finally(() => {
      this.scanning_ = false;
      this._scanPromise = null;
      if (silent || !wasInteractive) return;
      const n = this.detectedObjects.length;
      this.setStatus_(
        n
          ? `found ${n} things i can point at. press talk.`
          : 'press talk and say something to the agent.'
      );
    });
  }

  // Re-scans in the background once the user has moved or turned far enough
  // since the last scan (with a cooldown), so the object cache stays fresh as
  // they walk around without ever blocking a reply.
  maybeAutoScan_() {
    if (!this.interactive || this.scanning_ || this.busy) return;
    if (performance.now() - this._lastScanAt < 5000) return;
    const cam = xb.core.camera;
    if (!cam) return;
    cam.getWorldPosition(this._camPos);
    cam.getWorldQuaternion(this._camQuat);
    const moved = this._camPos.distanceTo(this._scanCamPos);
    const turned = this._camQuat.angleTo(this._scanCamQuat);
    if (moved > 0.5 || turned > 0.6) {
      this.scan_(true);
    }
  }

  // Runs lightweight 2D object detection (one Gemini call), then grounds each
  // object to a 3D point by raycasting its bbox centre against the depth mesh.
  // The camera is frozen at scan time so the rays match the detected pixels.
  async ensureDetection_() {
    const detector = xb.core.world?.objects;
    if (!detector?.runDetection) return;

    // Record this scan's viewpoint + time so auto-rescan measures movement
    // from here and respects the cooldown even if the scan finds nothing.
    this._lastScanAt = performance.now();
    const live = xb.core.camera;
    live.getWorldPosition(this._scanCamPos);
    live.getWorldQuaternion(this._scanCamQuat);

    // Freeze the camera + snapshot aspect so re-grounding lines up with the
    // pixels Gemini saw, even if the user moves during the (slow) call.
    const cam = live.clone();
    cam.matrixAutoUpdate = false;
    live.updateMatrixWorld();
    cam.matrixWorld.copy(live.matrixWorld);
    cam.matrixWorldInverse.copy(live.matrixWorld).invert();
    cam.projectionMatrix.copy(live.projectionMatrix);
    cam.projectionMatrixInverse.copy(live.projectionMatrixInverse);
    let snapAspect = live.aspect;
    try {
      const probe = await xb.core.deviceCamera?.getSnapshot({
        outputFormat: 'imageData',
      });
      if (probe?.width) snapAspect = probe.width / probe.height;
    } catch {
      // fall back to camera aspect
    }

    try {
      const objects = (await detector.runDetection()) ?? [];
      const mesh = xb.core.depth?.depthMesh;
      for (const obj of objects) {
        obj._point = this.groundPoint_(obj, cam, snapAspect, mesh);
      }
      // Replace the cache (even when empty) so the agent never points at
      // objects from an old view after a scan that found nothing.
      this.detectedObjects = objects;
      this.lastDetectAt = performance.now();
    } catch (error) {
      console.warn('[agent_hands] object detection failed', error);
    }
  }

  // Raycasts an object's 2D bbox centre against the depth mesh to get a world
  // point. Applies the snapshot-vs-camera aspect correction (uvToNdc) so the
  // ray is not pulled wide on the mismatched axis (the desktop simulator
  // snapshot is square while the camera is 16:9).
  groundPoint_(obj, cam, snapAspect, mesh) {
    const fallback = obj.position?.clone ? obj.position.clone() : null;
    const box = obj.detection2DBoundingBox;
    if (!mesh || !box) return fallback;
    const u = (box.min.x + box.max.x) * 0.5;
    const v = (box.min.y + box.max.y) * 0.5;
    let sx = 1;
    let sy = 1;
    if (snapAspect < cam.aspect) sx = snapAspect / cam.aspect;
    else if (snapAspect > cam.aspect) sy = cam.aspect / snapAspect;
    this._ndc.set((u * 2 - 1) * sx, (1 - v) * 2 * sy - sy);
    this._raycaster.setFromCamera(this._ndc, cam);
    const hits = this._raycaster.intersectObject(mesh, true);
    return hits.length ? hits[0].point.clone() : fallback;
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
    // speak() rejects if it has to interrupt; swallow it so a quick follow-up
    // utterance doesn't surface as an unhandled rejection.
    xb.core.sound?.speechSynthesizer?.speak(text)?.catch(() => {});
    const duration = Math.max(1.2, text.length * 0.06);
    this.queue = [];
    for (const gesture of gestures) {
      const at = (gesture.index / Math.max(1, text.length)) * duration;
      const step = {at, pose: gesture.pose};
      // A point gesture with a resolvable target aims at that object's
      // grounded 3D point.
      if (gesture.target) {
        const obj = this.findObject_(gesture.target);
        if (obj?._point) step.point = obj._point.clone();
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
    this._clock += dt;
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
    this.anchorToHead_();
    this.hands.update();
    this.maybeAutoScan_();
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
  options.sound.speechSynthesizer.allowInterruptions = true;
  options.sound.speechRecognizer.enabled = true;
  // Object detection so the hands can point at real things in the room.
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
  // Depth mesh: grounds each detected object to a 3D point via raycast.
  options.depth.enabled = true;
  options.depth.depthMesh.enabled = true;
  options.setAppTitle('Agent Hands');
  options.setAppDescription(
    'A pair of agent hands that gesture as the agent speaks. Add ?key=... to ' +
      'talk to it.'
  );
  options.xrButton.showEnterSimulatorButton = true;

  const demo = new AgentHandsDemo();
  window.agentHandsDemo = demo;
  xb.add(demo);
  xb.init(options);
}

document.addEventListener('DOMContentLoaded', start);

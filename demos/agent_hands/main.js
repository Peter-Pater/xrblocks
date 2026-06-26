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

// Scratch vector reused when updating the pointer-ray visualization.
const scratchTip_ = new THREE.Vector3();

const META_INSTRUCTION = `You are a friendly assistant with a visible pair of hands you gesture with. Reply in one or two short sentences. Embed gesture markup inline using [gesture:NAME] right before the word it emphasizes, where NAME is one of: point, thumbs_up, thumbs_down, fist, victory, rock, open. Use a gesture or two per reply.

You can physically point at real things in the room. When the user asks where something is, or you refer to a real object, point at it with [point:LABEL] where LABEL is one of the visible objects listed below. Only point at objects from that list. If the user asks about something that is not in the list, say you cannot see it from here and do not point. Do not mention the markup.`;

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
    // Head-anchor + idle-life + pointer-viz state.
    this._anchored = false;
    this._anchorQuat = new THREE.Quaternion();
    this._anchorPos = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forward = new THREE.Vector3();
    this._leanTarget = null;
    this._pointing = false;
    this._activeHand = null;
    this._clock = 0;
    this.pointerViz = null;
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

    this.buildPointerViz_();

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

  // ---- embodiment: head-anchor, idle life, pointer viz ----

  // A faint pointer ray (fingertip -> target) plus a pulsing ring at the
  // target, shown only while the agent is pointing.
  buildPointerViz_() {
    const group = new THREE.Group();
    group.visible = false;
    const lineGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    const line = new THREE.Line(
      lineGeom,
      new THREE.LineBasicMaterial({
        color: 0x9177c7,
        transparent: true,
        opacity: 0.5,
      })
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.07, 28),
      new THREE.MeshBasicMaterial({
        color: 0x9177c7,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
      })
    );
    group.add(line, ring);
    this.pointerViz = {group, line, ring};
    xb.core.scene.add(group);
  }

  // Keeps the hands floating in front of the user (position + yaw) so they stay
  // in view as the user walks/turns. Adds a gentle idle bob, and a subtle lean
  // toward whatever the agent is pointing at.
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

    // Orientation: face the user (yaw) + the fingers-up tilt, plus a small
    // lean toward the pointing target and a gentle idle sway.
    let lean = 0;
    let leanX = 0;
    if (this._pointing && this._leanTarget) {
      this._forward.copy(this._leanTarget).sub(this.hands.position);
      lean = THREE.MathUtils.clamp(
        Math.atan2(this._forward.x, -this._forward.z) - yaw,
        -0.5,
        0.5
      );
      leanX = THREE.MathUtils.clamp(-this._forward.y * 0.25, -0.25, 0.25);
    }
    const sway = Math.sin(this._clock * 0.8) * 0.02;
    this._euler.set(Math.PI / 2 + leanX, yaw + lean + sway, 0, 'YXZ');
    this._anchorQuat.setFromEuler(this._euler);
    this.hands.quaternion.slerp(this._anchorQuat, 0.08);
  }

  // Updates the pointer ray + ring while pointing; hides it otherwise.
  updatePointerViz_() {
    const viz = this.pointerViz;
    if (!viz) return;
    const show = this._pointing && this._leanTarget && this._activeHand;
    viz.group.visible = !!show;
    if (!show) return;
    const tip = this._activeHand.getIndexTipWorld(scratchTip_);
    const positions = viz.line.geometry.attributes.position;
    positions.setXYZ(0, tip.x, tip.y, tip.z);
    positions.setXYZ(
      1,
      this._leanTarget.x,
      this._leanTarget.y,
      this._leanTarget.z
    );
    positions.needsUpdate = true;
    viz.ring.position.copy(this._leanTarget);
    const cam = xb.core.camera;
    if (cam) viz.ring.lookAt(cam.position);
    const pulse = 1 + Math.sin(this._clock * 4) * 0.15;
    viz.ring.scale.setScalar(pulse);
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

  // Resolves each gesture to a queued step (with a grounded point target where
  // available).
  buildGestureSteps_(text, gestures, duration) {
    const steps = [];
    for (const gesture of gestures) {
      const at = (gesture.index / Math.max(1, text.length)) * duration;
      const step = {at, charIndex: gesture.index, pose: gesture.pose};
      // A point gesture with a resolvable target aims at that object's
      // grounded 3D point.
      if (gesture.target) {
        const obj = this.findObject_(gesture.target);
        if (obj?._point) step.point = obj._point.clone();
      }
      steps.push(step);
    }
    return steps;
  }

  // Speaks `text` and plays its gestures. The timed queue is the guaranteed
  // driver of gestures/points/rest (it works regardless of the TTS voice), and
  // we additionally use the synthesizer's word boundaries to tighten timing
  // when the chosen voice emits them (many remote voices do not).
  speakWithGestures_(text, gestures) {
    this.setStatus_(`agent: "${text}"`);
    const duration = Math.max(1.2, text.length * 0.06);
    const steps = this.buildGestureSteps_(text, gestures, duration);

    // Timed queue: fires each gesture/point at its estimated time, then rests.
    this.queue = [...steps, {at: duration + 0.8, rest: true}];
    this.timer = 0;

    const synth = xb.core.sound?.speechSynthesizer;
    if (synth?.speak) {
      // If the voice emits boundaries, fire pending gestures a touch early for
      // tighter sync. Firing is idempotent with the timed queue (a pose set
      // twice is harmless), so this never causes a missed or doubled gesture.
      const pending = [...steps];
      synth.onBoundaryCallback = (charIndex) => {
        while (pending.length && pending[0].charIndex <= charIndex) {
          const step = pending.shift();
          if (step.point) this.pointAtTarget_(step.point);
          else if (step.pose) this.hands.gesture(step.pose);
        }
      };
      synth
        .speak(text)
        .catch(() => {})
        .finally(() => {
          synth.onBoundaryCallback = undefined;
        });
    }
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
        this.pointAtTarget_(step.point);
      } else if (step.rest) {
        this.restHands_();
      } else if (step.pose) {
        this.hands.gesture(step.pose);
      }
      if (step.next !== undefined) this.playLine_(step.next);
    }
    this.anchorToHead_();
    // Re-aim every frame while pointing so the finger stays locked on the
    // world target even as the head-anchored rig follows and sways.
    if (this._pointing && this._activeHand && this._leanTarget) {
      this._activeHand.aimAt(this._leanTarget);
    }
    this.hands.update();
    this.updatePointerViz_();
    this.maybeAutoScan_();
  }

  // Points a hand at a world point and lights up the pointer viz + lean.
  pointAtTarget_(point) {
    this.hands.pointAt(point);
    this._pointing = true;
    this._leanTarget = point;
    // pointAt picks a hand by local x; mirror that choice for the viz.
    this.hands.worldToLocal(scratchTip_.copy(point));
    this._activeHand = scratchTip_.x >= 0 ? this.hands.right : this.hands.left;
  }

  // Relaxes both hands and clears the pointing state + viz.
  restHands_() {
    this.hands.rest();
    this._pointing = false;
    this._leanTarget = null;
    this._activeHand = null;
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

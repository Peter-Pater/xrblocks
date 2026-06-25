import 'xrblocks/addons/simulator/SimulatorAddons.js';

import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as xb from 'xrblocks';

// Spike: a standalone, animatable pair of "agent hands" in world space (not the
// user's tracked hands). Loads the WebXR generic-hand rig, poses it with the
// simulator pose library, and cycles through gestures to prove the rig +
// animation work before building the full AgentHands feature.

const HAND_PROFILE_PATH =
  'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/';

const POSE_CYCLE = [
  xb.SimulatorHandPose.RELAXED,
  xb.SimulatorHandPose.POINTING,
  xb.SimulatorHandPose.THUMBS_UP,
  xb.SimulatorHandPose.VICTORY,
  xb.SimulatorHandPose.FIST,
  xb.SimulatorHandPose.ROCK,
];

const scratchVec = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

class AgentHand {
  constructor(handedness) {
    this.handedness = handedness;
    this.root = new THREE.Group();
    this.bones = [];
    this.pose = xb.SimulatorHandPose.RELAXED;
    this.loaded = false;
  }

  async load() {
    const loader = new GLTFLoader();
    loader.setPath(HAND_PROFILE_PATH);
    const file =
      this.handedness === xb.Handedness.LEFT ? 'left.glb' : 'right.glb';
    const gltf = await loader.loadAsync(file);
    this.root.add(gltf.scene);
    for (const name of xb.HAND_JOINT_NAMES) {
      this.bones.push(gltf.scene.getObjectByName(name));
    }
    this.loaded = true;
  }

  setPose(pose) {
    this.pose = pose;
  }

  update(lerp = 0.2) {
    if (!this.loaded) return;
    const rotations = xb.SIMULATOR_HAND_POSE_ROTATIONS[this.pose];
    const joints = xb.resolveSimulatorHandPoseRotations(
      this.handedness,
      rotations
    );
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i];
      const joint = joints[i];
      if (!bone || !joint) continue;
      scratchVec.fromArray(joint.t);
      scratchQuat.fromArray(joint.r);
      bone.position.lerp(scratchVec, lerp);
      bone.quaternion.slerp(scratchQuat, lerp);
    }
  }
}

class AgentHandsSpike extends xb.Script {
  constructor() {
    super();
    this.poseIndex = 0;
    this.elapsed = 0;
    this.left = new AgentHand(xb.Handedness.LEFT);
    this.right = new AgentHand(xb.Handedness.RIGHT);
  }

  async init() {
    // A light so the hand mesh shows shading.
    xb.core.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(0.5, 1, 1);
    xb.core.scene.add(key);

    await Promise.all([this.left.load(), this.right.load()]);

    // Place the hands in front of the user, palms toward them.
    this.left.root.position.set(-0.18, 1.2, -0.55);
    this.right.root.position.set(0.18, 1.2, -0.55);
    this.left.root.rotation.y = Math.PI;
    this.right.root.rotation.y = Math.PI;
    this.add(this.left.root);
    this.add(this.right.root);

    this.setStatus_('agent hands loaded. cycling poses.');
  }

  update(time) {
    const dt = xb.getDeltaTime?.() ?? 0.016;
    this.elapsed += dt;
    if (this.elapsed > 1.8) {
      this.elapsed = 0;
      this.poseIndex = (this.poseIndex + 1) % POSE_CYCLE.length;
      const pose = POSE_CYCLE[this.poseIndex];
      this.left.setPose(pose);
      this.right.setPose(pose);
      this.setStatus_(`pose: ${pose}`);
    }
    this.left.update(0.2);
    this.right.update(0.2);
  }

  setStatus_(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }
}

function start() {
  const options = new xb.Options();
  options.setAppTitle('Agent Hands (spike)');
  options.xrButton.showEnterSimulatorButton = true;
  xb.add(new AgentHandsSpike());
  xb.init(options);
}

document.addEventListener('DOMContentLoaded', start);

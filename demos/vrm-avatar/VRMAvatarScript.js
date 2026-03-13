/**
 * VRMAvatarScript.js
 *
 * xb.Script subclass that owns the scene lifecycle for the VRM walking
 * companion. Handles:
 *   - Loading the VRM + animations in init()
 *   - Detecting user movement to drive idle/walk crossfade
 *   - Smoothly positioning the avatar behind the user each frame
 *
 * Options (passed to constructor):
 *   vrmUrl         {string}   URL to the .vrm file
 *   idleUrl        {string}   URL to the Mixamo idle FBX
 *   walkUrl        {string}   URL to the Mixamo walk FBX
 *   followOffset   {THREE.Vector3}  local offset from user; default (0.4, 0, 1.5)
 *   speedThreshold {number}   m/s above which we switch to walk; default 0.05
 *   positionLerp   {number}   lerp factor per frame; default 0.05
 *   rotateLerp     {number}   slerp factor per frame; default 0.08
 */

import * as THREE from 'three';
import * as xb from 'xrblocks';

import { VRMAvatar } from './VRMAvatar.js';

export class VRMAvatarScript extends xb.Script {
  /**
   * @param {object} opts
   */
  constructor(opts = {}) {
    super();

    this._vrmUrl  = opts.vrmUrl  ?? '';
    this._idleUrl = opts.idleUrl ?? '';
    this._walkUrl = opts.walkUrl ?? '';

    // Companion positioning
    this._speedThreshold = opts.speedThreshold ?? 0.05;
    this._positionLerp   = opts.positionLerp   ?? 0.05;
    this._rotateLerp     = opts.rotateLerp     ?? 0.08;

    // Internal state
    this._avatar         = new VRMAvatar();
    this._prevUserPos    = new THREE.Vector3();
    this._targetPos      = new THREE.Vector3();
    this._targetQuat     = new THREE.Quaternion();
    this._userSpeed      = 0;
    this._isWalking      = false;
    this._loaded         = false;

    // Reusable temporaries
    this._userPosNow  = new THREE.Vector3();
    this._deltaPos    = new THREE.Vector3();
    this._worldOffset = new THREE.Vector3();
    this._lookDir     = new THREE.Vector3();
    this._lookQuat    = new THREE.Quaternion();
    this._up          = new THREE.Vector3(0, 1, 0);
  }

  // -------------------------------------------------------------------------
  // XRBlocks lifecycle
  // -------------------------------------------------------------------------

  async init() {
    if (!this._vrmUrl) {
      console.error('[VRMAvatarScript] vrmUrl is required.');
      return;
    }

    console.log('[VRMAvatarScript] Loading VRM…');
    await this._avatar.load(this._vrmUrl);

    if (this._idleUrl) {
      console.log('[VRMAvatarScript] Loading idle animation…');
      await this._avatar.loadMixamoAnimation('idle', this._idleUrl);
    }
    if (this._walkUrl) {
      console.log('[VRMAvatarScript] Loading walk animation…');
      await this._avatar.loadMixamoAnimation('walk', this._walkUrl);
    }

    this.add(this._avatar.root);

    // Seed user position so the first delta is zero.
    this._prevUserPos.copy(this._getUserPosition());
    // Place avatar immediately behind the user to avoid a visible snap.
    this._computeTargetTransform();
    this._avatar.root.position.copy(this._targetPos);
    this._avatar.root.quaternion.copy(this._targetQuat);

    // Start idle (or walk if no idle provided).
    this._avatar.play(this._idleUrl ? 'idle' : 'walk');

    this._loaded = true;
    console.log('[VRMAvatarScript] Ready.');
  }

  /**
   * Called every frame by XRBlocks.
   * @param {number} time   Elapsed time (seconds)
   * @param {XRFrame} frame XR frame (may be null on desktop)
   */
  update(time, frame) {
    if (!this._loaded) return;

    const delta = xb.core.timer.getDelta();

    this._updateMovement(delta);
    this._updateTransform(delta);
    this._avatar.update(delta);
  }

  // -------------------------------------------------------------------------
  // Movement detection → animation switching
  // -------------------------------------------------------------------------

  _getUserPosition() {
    const p = xb.core.camera.position.clone();
    p.y = 0;
    return p;
  }

  _updateMovement(delta) {
    this._userPosNow.copy(this._getUserPosition());
    this._deltaPos.subVectors(this._userPosNow, this._prevUserPos);

    // Ignore Y (vertical) for speed calculation.
    const dx = this._deltaPos.x;
    const dz = this._deltaPos.z;
    this._userSpeed = Math.sqrt(dx * dx + dz * dz) / Math.max(delta, 0.001);

    this._prevUserPos.copy(this._userPosNow);

    const shouldWalk = this._userSpeed > this._speedThreshold;
    if (shouldWalk !== this._isWalking) {
      this._isWalking = shouldWalk;
      this._avatar.play(shouldWalk ? 'walk' : 'idle');
    }
  }

  // -------------------------------------------------------------------------
  // Positioning: follow user with offset, face user
  // -------------------------------------------------------------------------

  _computeTargetTransform() {
    const camPos = xb.core.camera.position.clone();
    camPos.y = 0;
  
    // Get camera forward direction in XZ plane
    const forward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(xb.core.camera.quaternion);
    forward.y = 0;
    forward.normalize();
  
    const right = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(xb.core.camera.quaternion);
    right.y = 0;
    right.normalize();
  
    // Place avatar in front of camera
    this._targetPos.copy(camPos)
      .addScaledVector(forward, 1.5)   // 1.5m in front
      .addScaledVector(right, 0.4);    // 0.4m to the right
  
    // Avatar faces back toward the user
    this._lookDir.copy(camPos).sub(this._targetPos);
    this._lookDir.y = 0;
    this._lookDir.normalize();
  
    if (this._lookDir.lengthSq() > 0.0001) {
      this._targetQuat.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        this._lookDir
      );
    }
  }

  _updateTransform(delta) {
    this._computeTargetTransform();

    // Smooth position.
    this._avatar.root.position.lerp(this._targetPos, this._positionLerp);

    // Smooth rotation.
    this._avatar.root.quaternion.slerp(this._targetQuat, this._rotateLerp);
  }
}

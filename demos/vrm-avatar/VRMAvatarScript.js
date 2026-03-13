/**
 * VRMAvatarScript.js
 *
 * xb.Script subclass that owns the scene lifecycle for the VRM avatar.
 * Handles:
 *   - Loading the VRM + animations in init()
 *   - Walking the avatar to a floor point on controller selectend
 *
 * Options (passed to constructor):
 *   vrmUrl        {string}  URL to the .vrm file
 *   idleUrl       {string}  URL to the Mixamo idle FBX
 *   walkUrl       {string}  URL to the Mixamo walk FBX
 *   walkSpeed     {number}  m/s avatar walking speed; default 1.0
 *   arrivalDist   {number}  metres from target to count as arrived; default 0.25
 *   rotateLerp    {number}  slerp factor per frame for turning; default 0.08
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

    this._walkSpeed   = opts.walkSpeed   ?? 1.0;  // m/s
    this._arrivalDist = opts.arrivalDist ?? 0.25; // m
    this._rotateLerp  = opts.rotateLerp  ?? 0.08;

    // Internal state
    this._avatar       = new VRMAvatar();
    this._loaded       = false;
    this._walkToTarget = null; // THREE.Vector3 world pos, or null when idle

    // Reusable temporaries
    this._prevUserPos  = new THREE.Vector3();
    this._userPosNow   = new THREE.Vector3();
    this._deltaPos     = new THREE.Vector3();
    this._walkDir      = new THREE.Vector3();
    this._walkFaceQuat = new THREE.Quaternion();
    this._groundPlane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._planeHit     = new THREE.Vector3();
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

    this._prevUserPos.copy(this._getUserPosition());

    this._avatar.play(this._idleUrl ? 'idle' : 'walk');

    this._loaded = true;
    console.log('[VRMAvatarScript] Ready.');
  }

  // -------------------------------------------------------------------------
  // XR input events
  // -------------------------------------------------------------------------

  onSelectEnd(event) {

    console.log('onSelectEnd triggered');
    if (!this._loaded) return;

    let hit = null;

    // Prefer depth mesh (real XR environment)
    const depthMesh = xb.core.depth?.depthMesh;
    if (depthMesh) {
      const hits = xb.core.input.intersectObjectByEvent(event, depthMesh);
      if (hits.length > 0) hit = hits[0].point.clone();
    }

    // Fallback: intersect the y=0 ground plane (simulator / no depth)
    if (!hit) {
      xb.core.input.setRaycasterFromController(event.target);
      const planeHit = xb.core.input.raycaster.ray.intersectPlane(
        this._groundPlane, this._planeHit
      );
      if (planeHit) hit = planeHit.clone();
    }

    if (!hit) return;
    hit.y = 0;

    this._walkToTarget = hit;
    this._avatar.play('walk');
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
    if (this._walkToTarget) this._updateWalkTo(delta);
    this._avatar.update(delta);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  _getUserPosition() {
    const p = xb.core.camera.position.clone();
    p.y = 0;
    return p;
  }

  _updateMovement(delta) {
    this._userPosNow.copy(this._getUserPosition());
    this._deltaPos.subVectors(this._userPosNow, this._prevUserPos);
    this._prevUserPos.copy(this._userPosNow);
  }

  _updateWalkTo(delta) {
    const pos = this._avatar.root.position;

    this._walkDir.subVectors(this._walkToTarget, pos);
    this._walkDir.y = 0;
    const dist = this._walkDir.length();

    if (dist < this._arrivalDist) {
      this._walkToTarget = null;
      this._avatar.play('idle');
      return;
    }

    this._walkDir.normalize();

    const step = Math.min(this._walkSpeed * delta, dist);
    pos.addScaledVector(this._walkDir, step);

    this._walkFaceQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._walkDir);
    this._avatar.root.quaternion.slerp(this._walkFaceQuat, this._rotateLerp);
  }
}

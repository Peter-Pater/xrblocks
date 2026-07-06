import * as THREE from 'three';

import {Keycodes} from '../../utils/Keycodes';

import {SimulatorControlMode} from './SimulatorControlMode';

const vector3 = new THREE.Vector3();
const originVec = new THREE.Vector3();
const forwardVec = new THREE.Vector3(0, 0, -1);
const currentOffsetVec = new THREE.Vector3();
const newOffsetVec = new THREE.Vector3();
const {A_CODE, D_CODE, E_CODE, Q_CODE, S_CODE, SPACE_CODE, T_CODE, W_CODE} =
  Keycodes;

export class SimulatorControllerMode extends SimulatorControlMode {
  onPointerMove(event: MouseEvent) {
    if (event.buttons) {
      const controllerOrientation =
        this.simulatorControllerState.localControllerOrientations[
          this.simulatorControllerState.currentControllerIndex
        ];
      this.rotateOnPointerMove(event, controllerOrientation, -0.002);
    }
  }

  override update() {
    this.updateGamepad();
    this.updateControllerPositions();
  }

  onModeActivated() {
    this.enableSimulatorHands();
  }

  updateControllerPositions() {
    const deltaTime = this.timer.getDelta();
    const downKeys = this.downKeys;
    const idx = this.simulatorControllerState.currentControllerIndex;
    const localPos =
      this.simulatorControllerState.localControllerPositions[idx];
    vector3
      .set(
        Number(downKeys.has(D_CODE)) - Number(downKeys.has(A_CODE)),
        Number(downKeys.has(Q_CODE)) - Number(downKeys.has(E_CODE)),
        Number(downKeys.has(S_CODE)) - Number(downKeys.has(W_CODE))
      )
      .multiplyScalar(deltaTime);
    const distanceEnabled = !!this.simulatorOptions?.reachDistance.enabled;
    const angleEnabled = !!this.simulatorOptions?.reachAngle.enabled;
    if (distanceEnabled || angleEnabled) {
      const {radius, leftHandOrigin, rightHandOrigin} =
        this.simulatorOptions!.reachDistance;
      const angle = this.simulatorOptions!.reachAngle.angle;
      const originObj = idx === 0 ? leftHandOrigin : rightHandOrigin;
      originVec.set(originObj.x, originObj.y, originObj.z);
      currentOffsetVec.copy(localPos).sub(originVec);
      newOffsetVec.copy(currentOffsetVec).add(vector3);
      const currentDist = currentOffsetVec.length();
      const newDist = newOffsetVec.length();
      const currentAngle = currentOffsetVec.angleTo(forwardVec);
      const newAngle = newOffsetVec.angleTo(forwardVec);
      const maxAngleRad = THREE.MathUtils.degToRad(angle / 2);
      const atRadiusEdge =
        distanceEnabled && currentDist >= radius && newDist >= currentDist;
      const atAngleEdge =
        angleEnabled && currentAngle >= maxAngleRad && newAngle >= currentAngle;
      if (atRadiusEdge || atAngleEdge) {
        vector3.set(0, 0, 0);
      }
    }
    localPos.add(vector3);

    // Gamepad: left stick moves hand on XZ; configurable buttons on Y.
    // Skip when the tab isn't focused so background tabs don't react to
    // stick input meant for the foreground tab.
    const gp = this.input.gamepadController;
    if (gp.userData.connected && !gp.menuActive && document.hasFocus()) {
      const [lx, ly] = gp.getAxes();
      const downVal = gp.getButtonValue(gp.bindings.getBinding('moveDown'));
      const upVal = gp.getButtonValue(gp.bindings.getBinding('moveUp'));
      vector3.set(lx, upVal - downVal, ly).multiplyScalar(deltaTime);
      const distanceEnabled = !!this.simulatorOptions?.reachDistance.enabled;
      const angleEnabled = !!this.simulatorOptions?.reachAngle.enabled;
      if (distanceEnabled || angleEnabled) {
        const {radius, leftHandOrigin, rightHandOrigin} =
          this.simulatorOptions!.reachDistance;
        const angle = this.simulatorOptions!.reachAngle.angle;
        const originObj = idx === 0 ? leftHandOrigin : rightHandOrigin;
        originVec.set(originObj.x, originObj.y, originObj.z);
        currentOffsetVec.copy(localPos).sub(originVec);
        newOffsetVec.copy(currentOffsetVec).add(vector3);
        const currentDist = currentOffsetVec.length();
        const newDist = newOffsetVec.length();
        const currentAngle = currentOffsetVec.angleTo(forwardVec);
        const newAngle = newOffsetVec.angleTo(forwardVec);
        const maxAngleRad = THREE.MathUtils.degToRad(angle / 2);
        const atRadiusEdge =
          distanceEnabled && currentDist >= radius && newDist >= currentDist;
        const atAngleEdge =
          angleEnabled &&
          currentAngle >= maxAngleRad &&
          newAngle >= currentAngle;
        if (atRadiusEdge || atAngleEdge) {
          vector3.set(0, 0, 0);
        }
      }
      localPos.add(vector3);
    }

    super.updateControllerPositions();
  }

  toggleControllerIndex() {
    this.hands.toggleHandedness();
  }

  onKeyDown(event: KeyboardEvent) {
    super.onKeyDown(event);
    if (event.code == T_CODE) {
      this.toggleControllerIndex();
    } else if (event.code == SPACE_CODE) {
      const controllerSelecting =
        this.input.controllers[
          this.simulatorControllerState.currentControllerIndex
        ].userData?.selected;
      const newSelectingState = !controllerSelecting;
      if (this.simulatorControllerState.currentControllerIndex == 0) {
        this.hands.setLeftHandPinching(newSelectingState);
      } else {
        this.hands.setRightHandPinching(newSelectingState);
      }
    }
  }
}

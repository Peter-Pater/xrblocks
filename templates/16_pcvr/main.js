import * as THREE from 'three';
import * as xb from 'xrblocks';

const status = document.getElementById('connection-status');

class PCVRScene extends xb.Script {
  frames = 0;
  selections = 0;
  lastStatusTime = -Infinity;

  init() {
    xb.core.scene.background = new THREE.Color(0x172335);
    this.add(new THREE.HemisphereLight(0xffffff, 0x445566, 3));
    this.grid = new THREE.GridHelper(8, 16, 0x88aaff, 0x445566);
    this.add(this.grid);
    this.cube = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.35, 0.35),
      new THREE.MeshStandardMaterial({color: 0x44aaff})
    );
    this.cube.position.set(0, 1.4, -1.5);
    this.add(this.cube);
  }

  update(time, frame) {
    this.cube.rotation.y += xb.getDeltaTime() * 0.4;
    if (!frame) return;
    this.frames++;
    if (time - this.lastStatusTime < 1000) return;
    this.lastStatusTime = time;
    const referenceSpace = xb.core.renderer.xr.getReferenceSpace();
    const pose = referenceSpace && frame.getViewerPose(referenceSpace);
    const controllers = [...frame.session.inputSources].filter(
      (source) => source.targetRayMode === 'tracked-pointer'
    ).length;
    status.textContent = `PC browser XR frames: ${this.frames} · Stereo views: ${pose?.views.length ?? 0} · Tracked inputs: ${controllers} · Selections: ${this.selections}`;
  }

  onObjectSelectEnd(event) {
    if (!event.completed || event.surface !== this.cube) return;
    this.cube.material.color.set(Math.random() * 0xffffff);
    this.selections++;
  }

  onXRSessionStarted() {
    this.frames = 0;
    this.lastStatusTime = -Infinity;
    status.textContent = 'VR session established. Waiting for stereo frames…';
  }

  onXRSessionEnded() {
    status.textContent =
      'VR session ended. Reconnect Link and select Enter PCVR to return.';
  }

  dispose() {
    this.cube.geometry.dispose();
    this.cube.material.dispose();
    this.grid.geometry.dispose();
    for (const material of [this.grid.material].flat()) material.dispose();
  }
}

async function start() {
  // Opening localhost in Quest Browser would render on the headset instead.
  if (!navigator.platform.startsWith('Win')) {
    status.textContent =
      'Open this page in Chrome or Edge on a Windows PC, not in Quest Browser.';
    return;
  }
  if (!window.isSecureContext) {
    status.textContent = 'WebXR needs HTTPS or a localhost URL on your PC.';
    return;
  }

  const options = new xb.Options({
    controllers: {visualizeRays: true},
    xrButton: {appTitle: 'XR Blocks PCVR'},
  }).enablePCVR();
  xb.add(new PCVRScene());
  await xb.init(options);
  status.textContent =
    'Ready. Start wired Link, then select Enter PCVR. If unavailable, check the active OpenXR runtime and reload.';
}

start().catch((error) => {
  status.textContent = `PCVR could not initialize: ${error.message}`;
  console.error(error);
});

import * as THREE from 'three';
import {getCameraParametersSnapshot} from '../../camera/CameraUtils';
import {XRDeviceCamera} from '../../camera/XRDeviceCamera';
import {Script} from '../../core/Script';
import {Depth} from '../../depth/Depth';
import {WorldOptions} from '../WorldOptions';
import {DetectedFace} from './DetectedFace';
import {BaseFaceBackend, FaceBackendContext} from './FaceDetectorBackend';
import {MediaPipeFaceBackend} from './backends/MediaPipeFaceBackend';

/**
 * A detector script that orchestrates face landmark estimation. Manages
 * the backend face detector lifecycle (e.g. MediaPipe) and exposes the
 * detected faces, including 3D landmark positions, blendshape weights,
 * and rigid head transforms, in the world coordinate space.
 */
export class FaceRecognizer extends Script {
  static dependencies = {
    options: WorldOptions,
    deviceCamera: XRDeviceCamera,
    depth: Depth,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
  };

  private _detectorBackends = new Map<string, Promise<BaseFaceBackend>>();

  // Injected dependencies
  private options!: WorldOptions;
  private deviceCamera!: XRDeviceCamera;
  public depth!: Depth;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;

  targetDevice = 'galaxyxr';

  init({
    options,
    deviceCamera,
    depth,
    camera,
    renderer,
  }: {
    options: WorldOptions;
    deviceCamera: XRDeviceCamera;
    depth: Depth;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
  }) {
    this.options = options;
    this.deviceCamera = deviceCamera;
    this.depth = depth;
    this.camera = camera;
    this.renderer = renderer;
  }

  /**
   * Runs the face landmark detection process based on the configured
   * backend.
   */
  async runDetection(): Promise<DetectedFace[]> {
    this.clear();

    if (!this.depth || !this.depth.depthMesh) {
      console.warn(
        'Cannot run Face Detection: Depth module / depthMesh is not enabled or initialized.'
      );
      return [];
    }

    const depthMeshSnapshot = this.getDepthMeshSnapshot();
    const cameraParametersSnapshot = getCameraParametersSnapshot(
      this.camera,
      this.renderer.xr.getCamera(),
      this.deviceCamera,
      this.targetDevice
    );

    const context = this.getBackendContext();
    const activeBackend = this.options.faces.backendConfig.activeBackend;
    const backendPromise = this.getOrCreateBackend(activeBackend, context);

    let backend: BaseFaceBackend;
    try {
      backend = await backendPromise;
    } catch (error: unknown) {
      console.warn(
        `Failed to load or initialize FaceRecognizer backend '${activeBackend}':`,
        error
      );
      return [];
    }

    const faces = await backend.run(
      depthMeshSnapshot,
      cameraParametersSnapshot
    );

    return faces;
  }

  private getBackendContext(): FaceBackendContext {
    return {
      options: this.options,
      deviceCamera: this.deviceCamera,
    };
  }

  private getOrCreateBackend(
    activeBackend: string,
    context: FaceBackendContext
  ): Promise<BaseFaceBackend> {
    let backendPromise = this._detectorBackends.get(activeBackend);

    if (!backendPromise) {
      backendPromise = (async () => {
        switch (activeBackend) {
          case 'mediapipe':
            return new MediaPipeFaceBackend(context);
          default:
            throw new Error(
              `FaceRecognizer backend '${activeBackend}' is not supported.`
            );
        }
      })();
      this._detectorBackends.set(activeBackend, backendPromise);
    }
    return backendPromise;
  }

  private getDepthMeshSnapshot() {
    const depthMesh = this.depth.depthMesh!;
    const geometry = this.depth.options.depthMesh.updateFullResolutionGeometry
      ? depthMesh.geometry
      : depthMesh.downsampledGeometry || depthMesh.geometry;
    const clonedGeometry = geometry.clone();
    clonedGeometry.computeBoundingSphere();
    clonedGeometry.computeBoundingBox();
    const depthMeshSnapshot = new THREE.Mesh(
      clonedGeometry,
      new THREE.MeshBasicMaterial()
    );
    depthMesh.getWorldPosition(depthMeshSnapshot.position);
    depthMesh.getWorldQuaternion(depthMeshSnapshot.quaternion);
    depthMesh.getWorldScale(depthMeshSnapshot.scale);
    depthMeshSnapshot.updateMatrixWorld(true);
    return depthMeshSnapshot;
  }
}

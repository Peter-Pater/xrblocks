import * as THREE from 'three';
import type * as MEDIAPIPE from '@mediapipe/tasks-vision';
import {
  CameraParametersSnapshot,
  transformRgbUvToWorld,
} from '../../../camera/CameraUtils';
import {DetectedFace, FaceBlendshape, FaceLandmark} from '../DetectedFace';
import {BaseFaceBackend, FaceBackendContext} from '../FaceDetectorBackend';

let FilesetResolver: typeof MEDIAPIPE.FilesetResolver | undefined;
let FaceLandmarker: typeof MEDIAPIPE.FaceLandmarker | undefined;

// --- Attempt Dynamic Import ---
async function loadMediaPipeModule() {
  if (FilesetResolver && FaceLandmarker) {
    return;
  }
  try {
    const mediapipeModule = await import('@mediapipe/tasks-vision');
    FilesetResolver = mediapipeModule.FilesetResolver;
    FaceLandmarker = mediapipeModule.FaceLandmarker;
    console.log(
      "'@mediapipe/tasks-vision' MediaPipe Face Module loaded successfully."
    );
  } catch (error) {
    console.error('Failed to load MediaPipe Tasks Vision module:', error);
    throw error;
  }
}

/**
 * Convert a raw MediaPipe `FaceLandmarkerResult` into an array of
 * `DetectedFace` objects with world-space positions, blendshape
 * weights, and rigid head transforms.
 *
 * Extracted as a free function so unit tests can drive it directly
 * without standing up the full backend lifecycle.
 *
 * For each landmark we try a depth-mesh raycast (`transformRgbUvToWorld`)
 * first; when the ray misses the mesh we fall back to back-projecting
 * through the camera frustum, placing the point ~0.5 m from the camera
 * modulated by the landmark's relative z. The 0.5 m default is tuned
 * for selfie / desktop sim use; passthrough Quest views typically hit
 * the depth mesh path so the fallback rarely runs there.
 */
export function processFaceLandmarkerResult(
  result: MEDIAPIPE.FaceLandmarkerResult,
  depthMeshSnapshot: THREE.Mesh,
  cameraParametersSnapshot: CameraParametersSnapshot
): DetectedFace[] {
  const detectedFaces: DetectedFace[] = [];

  for (let i = 0; i < result.faceLandmarks.length; i++) {
    const mpLandmarks = result.faceLandmarks[i];

    const landmarks: FaceLandmark[] = [];
    let xmin = 1;
    let ymin = 1;
    let xmax = 0;
    let ymax = 0;

    for (let j = 0; j < mpLandmarks.length; j++) {
      const lm = mpLandmarks[j];

      xmin = Math.min(xmin, lm.x);
      ymin = Math.min(ymin, lm.y);
      xmax = Math.max(xmax, lm.x);
      ymax = Math.max(ymax, lm.y);

      // Transform screen UV to WebXR world position via depth mesh
      // raycast (preferred) or camera-frustum back-projection
      // fallback when the ray misses the mesh.
      const uv = new THREE.Vector2(lm.x, lm.y);
      const worldCoords = transformRgbUvToWorld(
        uv,
        depthMeshSnapshot,
        cameraParametersSnapshot
      );

      let wp: THREE.Vector3 | undefined;
      if (worldCoords) {
        wp = worldCoords.worldPosition;
      } else {
        const origin = new THREE.Vector3().applyMatrix4(
          cameraParametersSnapshot.worldFromView
        );
        const clipVec = new THREE.Vector3(
          2 * lm.x - 1,
          2 * (1.0 - lm.y) - 1,
          -1
        );
        const direction = clipVec
          .applyMatrix4(cameraParametersSnapshot.worldFromClip)
          .sub(origin)
          .normalize();
        // Faces sit ~0.5 m from the camera in selfie/sim use, modulate
        // by the landmark's z so the back of the head stays behind
        // the front of the face along the view ray.
        wp = origin.addScaledVector(direction, 0.5 + (lm.z || 0));
      }

      landmarks.push({
        x: lm.x,
        y: lm.y,
        z: lm.z,
        worldPosition: wp,
      });
    }

    const boundingBox = new THREE.Box2(
      new THREE.Vector2(xmin, ymin),
      new THREE.Vector2(xmax, ymax)
    );

    // Blendshapes are one Classifications object per face. Each
    // `categories` entry has `categoryName` and `score`. The browser
    // model emits them already smoothed across frames.
    const blendshapes: FaceBlendshape[] = [];
    const mpBlendshapes = result.faceBlendshapes?.[i];
    if (mpBlendshapes && mpBlendshapes.categories) {
      for (const c of mpBlendshapes.categories) {
        blendshapes.push({
          categoryName: c.categoryName,
          score: c.score,
        });
      }
    }

    // Facial transformation matrixes are stored as a column-major
    // Float32Array(16). THREE.Matrix4.fromArray() consumes the same
    // layout directly.
    let facialTransform: THREE.Matrix4 | null = null;
    const mpMatrix = result.facialTransformationMatrixes?.[i];
    if (mpMatrix && mpMatrix.data) {
      facialTransform = new THREE.Matrix4().fromArray(mpMatrix.data);
    }

    const face = new DetectedFace(
      i,
      landmarks,
      boundingBox,
      blendshapes,
      facialTransform
    );

    detectedFaces.push(face);
  }

  return detectedFaces;
}

/**
 * Face Landmark detector backend implementation using MediaPipe's
 * FaceLandmarker. Runs locally on the device. Emits 478 facial
 * landmarks per face plus optional 52 ARKit-style blendshape weights
 * and an optional rigid 4x4 facial transformation matrix.
 */
export class MediaPipeFaceBackend extends BaseFaceBackend {
  private faceLandmarker: MEDIAPIPE.FaceLandmarker | null = null;
  private initializationPromise: Promise<void>;

  constructor(context: FaceBackendContext) {
    super(context);
    this.initializationPromise = this.tryInitializeFaceLandmarker();
  }

  protected override async isAvailable(): Promise<boolean> {
    try {
      await this.initializationPromise;
      return true;
    } catch (e) {
      console.error('MediaPipe Face Landmarker is not available:', e);
      return false;
    }
  }

  protected override async getSnapshot(): Promise<{
    imageData: ImageData;
  } | null> {
    const imageData = await this.context.deviceCamera.getSnapshot({
      outputFormat: 'imageData',
    });
    if (!imageData) return null;
    return {imageData};
  }

  protected override async detect(
    snapshot: {imageData: ImageData},
    depthMeshSnapshot: THREE.Mesh,
    cameraParametersSnapshot: CameraParametersSnapshot
  ): Promise<DetectedFace[]> {
    await this.initializationPromise;
    if (!this.faceLandmarker) {
      return [];
    }

    let result: MEDIAPIPE.FaceLandmarkerResult;
    try {
      result = this.faceLandmarker.detect(snapshot.imageData);
    } catch (error: unknown) {
      console.error('MediaPipe Face detection run failed:', error);
      return [];
    }

    if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
      return [];
    }

    return processFaceLandmarkerResult(
      result,
      depthMeshSnapshot,
      cameraParametersSnapshot
    );
  }

  private async tryInitializeFaceLandmarker(): Promise<void> {
    if (this.faceLandmarker) return;

    await loadMediaPipeModule();

    const facesOptions = this.context.options.faces.backendConfig.mediapipe;
    const vision = await FilesetResolver!.forVisionTasks(
      facesOptions.wasmFilesUrl
    );
    this.faceLandmarker = await FaceLandmarker!.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: facesOptions.modelAssetPath,
        delegate: 'GPU',
      },
      runningMode: 'IMAGE',
      numFaces: facesOptions.numFaces,
      minFaceDetectionConfidence: facesOptions.minFaceDetectionConfidence,
      minFacePresenceConfidence: facesOptions.minFacePresenceConfidence,
      minTrackingConfidence: facesOptions.minTrackingConfidence,
      outputFaceBlendshapes: facesOptions.outputFaceBlendshapes,
      outputFacialTransformationMatrixes:
        facesOptions.outputFacialTransformationMatrixes,
    });
  }
}

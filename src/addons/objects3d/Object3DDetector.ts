/**
 * Reusable 3-D object-detection Script addon.
 *
 * `Object3DDetector` wraps the full pipeline from the `objects_3d` demo into a
 * reusable {@link Script}: snap camera + depth mesh, run 2-D detection, obtain
 * per-object segmentation masks, raycast depth samples into world space, fit an
 * oriented bounding box (OBB), fuse across views, and optionally show debug
 * wireframe boxes.
 */

import * as THREE from 'three';
import {
  Script,
  core,
  enableAcceleratedRaycast,
  getCameraParametersSnapshot,
} from 'xrblocks';

import {Detected3DObject} from './Detected3DObject';
import {
  anchorFromBboxCenter,
  sampleDepthInMaskAcrossFrames,
} from './geometry/DepthSampling';
import {buildFrozenCamera} from './geometry/FrozenCamera';
import {
  fuseIntoBoxes,
  snapBoxToFloor,
  unionDetections,
} from './geometry/Fusion';
import {
  fitYawOBB,
  radiusFromBbox,
  rejectByAnchor,
  rejectByAnchorDepth,
  rejectByY,
} from './geometry/ObbFitting';
import {categorize, isSurfaceLabel, isTinyFlatLabel} from './labels/Categories';
import {samEncodeSnapshot, samMaskFromBbox, getSam} from './masks/SamMask';
import {segmenterMaskFromSnapshot} from './masks/SegmenterMask';
import {
  buildBoxGroup,
  rebuildBoxGroupGeometry,
  CAT_COLOR,
} from './visuals/BoxGroup';

/** Options for {@link Object3DDetector}. */
export interface Object3DDetectorOptions {
  /**
   * Which 2-D detector backend to use.
   * - `'gemini'` — Gemini open-vocabulary (best variety, requires API key).
   * - `'mediapipe'` — On-device COCO (no key needed, fixed class set).
   * - `'both'` — Union of both with IoU dedup.
   * @defaultValue `'gemini'`
   */
  detectBackend?: 'gemini' | 'mediapipe' | 'both';
  /**
   * Which segmentation mask backend to use for depth sampling.
   * - `'slimsam'` — SlimSAM-77-uniform via `@huggingface/transformers` (tighter masks).
   * - `'mediapipe'` — MediaPipe `InteractiveSegmenter` (faster, no download).
   * @defaultValue `'slimsam'`
   */
  maskBackend?: 'slimsam' | 'mediapipe';
  /**
   * When `true`, accumulate OBBs across multiple `detect()` calls from
   * different angles. Each new call refines matching existing boxes via
   * running-average fusion instead of adding a duplicate.
   * @defaultValue `true`
   */
  fuseAcrossViews?: boolean;
  /**
   * When `true`, add wireframe box + label sprite groups to the scene as
   * children of this Script object.
   * @defaultValue `false`
   */
  showDebugBoxes?: boolean;
  /**
   * Maximum ray-hit distance in metres when sampling the depth mesh.
   * @defaultValue `12`
   */
  maxRayDistance?: number;
  /**
   * World-space sanity bounds; fitted boxes whose centre falls outside are
   * rejected. Tuned for a room-scale scene around the session origin.
   * @defaultValue `{maxXZ: 6, minY: -1, maxY: 5}`
   */
  sceneBounds?: {maxXZ?: number; minY?: number; maxY?: number};
  /**
   * Assumed distance in metres from the session origin to the cardinal
   * walls, used by the tiny-flat fitter (switches, outlets) to snap onto a
   * wall plane. The default matches the simulator's wood-cabin scene; tune
   * it (or avoid tiny-flat labels) for real rooms.
   * @defaultValue `3`
   */
  roomHalf?: number;
}

// Kick off the three-mesh-bvh dynamic import at module load so it is ready
// well before the first detect() call.
const _bvhReady: Promise<boolean> = enableAcceleratedRaycast().catch(
  () => false
);

/**
 * Extracts the 3-D object-detection pipeline from the `objects_3d` demo into a
 * reusable {@link Script}. Attach it to the scene before `xb.init()`, then
 * call `await detector.detect()` to populate `detector.results`.
 *
 * ```ts
 * import {Object3DDetector} from 'xrblocks/addons/objects3d';
 * const detector = new Object3DDetector({showDebugBoxes: true});
 * xb.add(detector);
 * xb.init(options);
 * // …later…
 * const objects = await detector.detect();
 * ```
 */
export class Object3DDetector extends Script {
  private readonly _opts: Required<
    Omit<Object3DDetectorOptions, 'sceneBounds'>
  > & {sceneBounds: {maxXZ: number; minY: number; maxY: number}};
  private _results: Detected3DObject[] = [];
  private _detectInFlight = false;

  /**
   * @param options - Configuration options.
   */
  constructor(options: Object3DDetectorOptions = {}) {
    super();
    this._opts = {
      detectBackend: options.detectBackend ?? 'gemini',
      maskBackend: options.maskBackend ?? 'slimsam',
      fuseAcrossViews: options.fuseAcrossViews ?? true,
      showDebugBoxes: options.showDebugBoxes ?? false,
      maxRayDistance: options.maxRayDistance ?? 12,
      sceneBounds: {
        maxXZ: options.sceneBounds?.maxXZ ?? 6,
        minY: options.sceneBounds?.minY ?? -1,
        maxY: options.sceneBounds?.maxY ?? 5,
      },
      roomHalf: options.roomHalf ?? 3,
    };
  }

  /** Currently fitted {@link Detected3DObject} instances from the last
   * (or accumulated) detect run. */
  get results(): Detected3DObject[] {
    return this._results;
  }

  /**
   * Remove all existing results and their debug visuals from the scene.
   * Call this to reset the detector before a new area scan.
   */
  clearDetections(): void {
    for (const obj of this._results) {
      if (obj.boxGroup) {
        obj.boxGroup.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const mat = mesh.material;
          if (mat) {
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
            else (mat as THREE.Material).dispose?.();
          }
        });
        this.remove(obj.boxGroup);
      }
      this.remove(obj);
    }
    this._results = [];
  }

  /**
   * Run the full detection + OBB-fitting pipeline and return the list of
   * fitted {@link Detected3DObject} instances.
   *
   * The call:
   * 1. Captures a camera snapshot and freezes both the camera matrix and the
   *    depth mesh at that instant.
   * 2. Runs 2-D object detection (Gemini / MediaPipe / both).
   * 3. For each detection, obtains a per-object segmentation mask (SAM /
   *    MediaPipe segmenter).
   * 4. Raycasts depth samples through the frozen mask into world space.
   * 5. Fits an oriented bounding box using a per-category strategy.
   * 6. Fuses the result into any matching existing box from a prior call.
   *
   * @returns Resolved list of fitted {@link Detected3DObject} instances,
   *   or the unchanged current results on re-entry / missing subsystems.
   */
  async detect(): Promise<Detected3DObject[]> {
    if (!core.world?.objects) {
      console.warn(
        '[Object3DDetector] object detection subsystem not available'
      );
      return this._results;
    }
    const worldObjects = core.world.objects;
    const deviceCamera = core.deviceCamera;
    if (this._detectInFlight) {
      console.info(
        '[Object3DDetector] detect already in flight, ignoring re-entry'
      );
      return this._results;
    }
    this._detectInFlight = true;

    // Capture one snapshot frame that will be shared for detection + SAM.
    let snapImageData: ImageData | null = null;
    try {
      snapImageData =
        deviceCamera?.getSnapshot({outputFormat: 'imageData'}) ?? null;
    } catch (_e) {
      snapImageData = null;
    }
    if (!snapImageData) {
      console.warn('[Object3DDetector] no camera frame available');
      this._detectInFlight = false;
      return this._results;
    }
    if (!deviceCamera) {
      console.warn('[Object3DDetector] device camera not available');
      this._detectInFlight = false;
      return this._results;
    }

    // Derive base64 from the same ImageData to avoid a second video-frame read.
    const b64Canvas = document.createElement('canvas');
    b64Canvas.width = snapImageData.width;
    b64Canvas.height = snapImageData.height;
    b64Canvas.getContext('2d')!.putImageData(snapImageData, 0, 0);
    const snapBase64 = b64Canvas.toDataURL('image/jpeg', 0.9);

    // Freeze the camera model at snapshot time so raycasts align with the
    // snapshot pixels. The RGB frame comes from the physical passthrough
    // camera, whose intrinsics and pose differ from the XR render camera
    // (e.g. on Galaxy XR: ~48° vertical FOV near the right eye, versus the
    // ~90°+ union frustum between the eyes), so build the frozen camera from
    // the SDK's device-camera model. In the simulator both models coincide.
    const snapAspect = snapImageData.width / snapImageData.height;
    const frozenCam =
      this._buildDeviceFrozenCamera(snapAspect) ??
      this._buildRenderFrozenCamera(snapAspect);

    // Wait for the BVH patch before building the per-press bounds tree.
    await _bvhReady;

    // Clone and index the depth mesh.
    const frozenDepthMesh = this._snapshotDepthMesh();
    if (!frozenDepthMesh) {
      console.warn('[Object3DDetector] no depth mesh available');
      this._detectInFlight = false;
      return this._results;
    }

    // Monkey-patch getSnapshot so the SDK detector backends read our cached
    // frame instead of the live video (which may have drifted by the time
    // they call it).
    type SnapFn = typeof deviceCamera.getSnapshot;
    const origGetSnapshot = deviceCamera.getSnapshot.bind(
      deviceCamera
    ) as SnapFn;
    const mutableCamera = deviceCamera as unknown as {
      getSnapshot: (opts?: {outputFormat?: string}) => unknown;
    };
    mutableCamera.getSnapshot = (opts?: {outputFormat?: string}) => {
      if (opts?.outputFormat === 'base64') return Promise.resolve(snapBase64);
      if (opts?.outputFormat === 'imageData') return snapImageData;
      return (origGetSnapshot as (opts?: unknown) => unknown)(opts);
    };

    // Start SAM init + encode in parallel with 2-D detection.
    let samPrep: Promise<Awaited<ReturnType<typeof samEncodeSnapshot>>> | null =
      null;
    if (this._opts.maskBackend === 'slimsam') {
      samPrep = (async () => {
        await getSam();
        return samEncodeSnapshot(snapImageData!);
      })();
      samPrep.catch(() => {});
    }

    try {
      // 2-D detection.
      let detected: Awaited<ReturnType<typeof worldObjects.runDetection>>;
      try {
        if (this._opts.detectBackend === 'both') {
          const cfg = core.world!.options.objects.backendConfig;
          const prev = cfg.activeBackend;
          try {
            cfg.activeBackend = 'mediapipe';
            const mp = await worldObjects.runDetection();
            cfg.activeBackend = 'gemini';
            const gm = await worldObjects.runDetection();
            detected = unionDetections(mp, gm) as typeof mp;
          } finally {
            cfg.activeBackend = prev;
          }
        } else {
          const cfg = core.world!.options.objects.backendConfig;
          const prev = cfg.activeBackend;
          cfg.activeBackend = this._opts.detectBackend;
          try {
            detected = await worldObjects.runDetection();
          } finally {
            cfg.activeBackend = prev;
          }
        }
      } catch (e) {
        console.warn('[Object3DDetector] runDetection threw', e);
        return this._results;
      }

      if (!detected.length) {
        console.info('[Object3DDetector] nothing detected');
        return this._results;
      }

      // Await the SAM encoder that ran in parallel with detection.
      let samState: Awaited<ReturnType<typeof samEncodeSnapshot>> | null = null;
      if (this._opts.maskBackend === 'slimsam' && samPrep) {
        try {
          samState = await samPrep;
        } catch (e) {
          console.warn('[Object3DDetector] SAM encoder failed', e);
          return this._results;
        }
      }

      // Restore the snapshot getter; fitting uses the frozen camera / mesh.
      (deviceCamera as unknown as {getSnapshot: SnapFn}).getSnapshot =
        origGetSnapshot;

      const floorY = this._estimateFloorY();

      // Pipeline per-object work: mask decode (serial on GPU via samSerialize)
      // overlaps with depth raycasts for the previous object.
      const snapshot = snapImageData;
      const processOne = async (
        obj: (typeof detected)[0]
      ): Promise<{
        obb: ReturnType<typeof fitYawOBB> & object;
        label: string;
        cat: string;
      } | null> => {
        try {
          if (isSurfaceLabel(obj.label)) return null;
          const box2d = obj.detection2DBoundingBox;
          let mask;
          try {
            mask =
              this._opts.maskBackend === 'slimsam' && samState
                ? await samMaskFromBbox(samState, box2d)
                : await segmenterMaskFromSnapshot(snapshot!, box2d);
          } catch (e) {
            console.warn('[Object3DDetector] mask failed for', obj.label, e);
            return null;
          }
          if (!mask) return null;

          const {points: raw} = await sampleDepthInMaskAcrossFrames(
            mask,
            box2d,
            10,
            3,
            frozenCam,
            frozenDepthMesh,
            snapAspect,
            this._opts.maxRayDistance
          );
          mask.close();

          const anchor =
            anchorFromBboxCenter(
              box2d,
              frozenCam,
              frozenDepthMesh,
              snapAspect
            ) ??
            (obj.position as THREE.Vector3 | undefined) ??
            null;

          const cat = categorize(obj.label);
          let points: THREE.Vector3[];

          if (cat === 'flat') {
            points = raw;
          } else if (cat === 'small') {
            const r = radiusFromBbox(box2d, frozenCam, anchor, {
              pad: 1.1,
              minR: 0.12,
              maxR: 0.3,
              fallback: 0.25,
            });
            points = rejectByAnchor(raw, anchor, r);
          } else if (cat === 'light') {
            const r = radiusFromBbox(box2d, frozenCam, anchor, {
              pad: 1.2,
              minR: 0.2,
              maxR: 0.7,
              fallback: 0.5,
            });
            points = rejectByY(rejectByAnchor(raw, anchor, r), 0.15);
          } else {
            const r = radiusFromBbox(box2d, frozenCam, anchor, {
              pad: 1.3,
              minR: 0.4,
              maxR: 2.0,
              fallback: 1.0,
            });
            const depthFiltered = rejectByAnchorDepth(
              raw,
              frozenCam,
              anchor,
              r
            );
            points = rejectByAnchor(depthFiltered, anchor, r);
          }

          const obb = fitYawOBB(points, {
            category: cat,
            camera: frozenCam,
            anchor,
            box2d,
            tinyFlat: isTinyFlatLabel(obj.label),
            roomHalf: this._opts.roomHalf,
          });
          if (!obb) return null;

          if (cat === 'furniture' || cat === 'small') {
            snapBoxToFloor(obb, floorY);
          }

          const c = obb.center;
          const bounds = this._opts.sceneBounds;
          const farFromRoom =
            Math.abs(c.x) > bounds.maxXZ ||
            Math.abs(c.z) > bounds.maxXZ ||
            c.y < bounds.minY ||
            c.y > bounds.maxY;
          const minPoints =
            cat === 'small' ? 4 : cat === 'light' ? 8 : cat === 'flat' ? 8 : 20;
          const tinyFlat = isTinyFlatLabel(obj.label);
          const tooFewPoints = !tinyFlat && points.length < minPoints;
          const oversize = obb.size.x > 4 || obb.size.y > 3 || obb.size.z > 4;
          const horizMax = Math.max(obb.size.x, obb.size.z);
          const degenerate =
            cat !== 'flat' && horizMax > 0.5 && obb.size.y / horizMax < 0.1;

          if (farFromRoom || tooFewPoints || oversize || degenerate) {
            console.warn('[Object3DDetector] reject', obj.label, {
              farFromRoom,
              tooFewPoints,
              oversize,
              degenerate,
              kept: points.length,
            });
            return null;
          }

          return {obb, label: obj.label || 'object', cat};
        } catch (e) {
          console.warn(
            '[Object3DDetector] pipeline error for',
            obj.label,
            (e as Error)?.message ?? String(e)
          );
          return null;
        }
      };

      const pipelineResults = await Promise.all(detected.map(processOne));

      // Serial fuse + add pass (fuseIntoBoxes mutates _results).
      for (const r of pipelineResults) {
        if (!r || !r.obb) continue;
        const internalObb = r.obb;

        if (this._opts.fuseAcrossViews) {
          const matched = fuseIntoBoxes(this._results, internalObb, r.cat);
          if (matched) {
            const obj = matched as Detected3DObject;
            obj.syncFromInternalObb({
              center: obj._fusionCenter,
              size: obj._fusionSize,
              angle: obj._fusionAngle,
            });
            if (this._opts.showDebugBoxes && obj.boxGroup) {
              rebuildBoxGroupGeometry(obj.boxGroup as THREE.Group, {
                center: obj._fusionCenter,
                size: obj._fusionSize,
                angle: obj._fusionAngle,
              });
            }
            continue;
          }
        }

        const newObj = new Detected3DObject(r.label, r.cat, internalObb);
        if (this._opts.showDebugBoxes) {
          const color = CAT_COLOR[r.cat] ?? 0x4cd964;
          const grp = buildBoxGroup(internalObb, r.label, color);
          newObj.boxGroup = grp;
          this.add(grp);
        }
        this._results.push(newObj);
        this.add(newObj);
      }

      return this._results;
    } finally {
      // Always restore the snapshot getter and clean up the frozen mesh.
      (deviceCamera as unknown as {getSnapshot: SnapFn}).getSnapshot =
        origGetSnapshot;
      if (frozenDepthMesh.geometry) {
        const geom = frozenDepthMesh.geometry as THREE.BufferGeometry & {
          disposeBoundsTree?: () => void;
        };
        geom.disposeBoundsTree?.();
        geom.dispose();
      }
      (frozenDepthMesh.material as THREE.Material | undefined)?.dispose?.();
      this._detectInFlight = false;
    }
  }

  /**
   * Build the frozen camera from the SDK's device-camera model (physical
   * passthrough intrinsics + pose on device; render-camera-derived square
   * crop in the simulator). Returns `null` when no camera parameters are
   * available yet (e.g. before init or outside an XR session).
   */
  private _buildDeviceFrozenCamera(
    snapAspect: number
  ): THREE.PerspectiveCamera | null {
    const deviceCamera = core.deviceCamera;
    if (!deviceCamera) return null;
    try {
      const params = getCameraParametersSnapshot(
        core.camera,
        core.renderer.xr.getCamera(),
        deviceCamera,
        core.world?.objects?.targetDevice ?? 'galaxyxr'
      );
      if (!params) return null;
      return buildFrozenCamera({
        worldFromView: params.worldFromView,
        clipFromView: params.clipFromView,
        viewFromClip: params.viewFromClip,
        snapAspect,
      });
    } catch (_e) {
      return null;
    }
  }

  /**
   * Legacy fallback: freeze a clone of the render camera. Only correct when
   * the snapshot was rendered from that camera (simulator / non-XR); kept as
   * a fallback for callers without device-camera parameters.
   */
  private _buildRenderFrozenCamera(
    snapAspect: number
  ): THREE.PerspectiveCamera {
    const liveCam = core.camera;
    const frozenCam = liveCam.clone() as THREE.PerspectiveCamera;
    frozenCam.matrixAutoUpdate = false;
    liveCam.updateMatrixWorld();
    frozenCam.matrix.copy(liveCam.matrix);
    frozenCam.matrixWorld.copy(liveCam.matrixWorld);
    frozenCam.matrixWorldInverse.copy(liveCam.matrixWorld).invert();
    frozenCam.projectionMatrix.copy(liveCam.projectionMatrix);
    frozenCam.projectionMatrixInverse.copy(liveCam.projectionMatrixInverse);
    frozenCam.position.copy(liveCam.position);
    frozenCam.quaternion.copy(liveCam.quaternion);
    frozenCam.userData = {...frozenCam.userData, snapAspect};
    return frozenCam;
  }

  /** Clone the live depth mesh into a static snapshot. */
  private _snapshotDepthMesh(): THREE.Mesh | null {
    const depth = core.depth;
    const live = depth?.depthMesh;
    if (!live || !live.geometry) return null;
    // The full-resolution geometry is only rebuilt per-frame when
    // options.depth.depthMesh.updateFullResolutionGeometry is set (default
    // false), so force a rebuild from the cached CPU depth to avoid cloning
    // a stale mesh.
    depth.updateFullResolutionDepthMesh();
    const clonedGeom = live.geometry.clone();
    clonedGeom.computeBoundingSphere();
    clonedGeom.computeBoundingBox();
    const geomWithBvh = clonedGeom as THREE.BufferGeometry & {
      computeBoundsTree?: () => void;
    };
    geomWithBvh.computeBoundsTree?.();
    const snap = new THREE.Mesh(
      clonedGeom,
      new THREE.MeshBasicMaterial({visible: false})
    );
    live.getWorldPosition(snap.position);
    live.getWorldQuaternion(snap.quaternion);
    live.getWorldScale(snap.scale);
    snap.updateMatrixWorld(true);
    return snap;
  }

  /** Estimate the floor Y from the live depth mesh (5th-percentile of vertex Y). */
  private _estimateFloorY(): number | null {
    const mesh = core.depth?.depthMesh;
    if (!mesh?.geometry) return null;
    const pos = mesh.geometry.attributes['position'];
    if (!pos || !pos.count) return null;
    mesh.updateMatrixWorld();
    const ys: number[] = [];
    const p = new THREE.Vector3();
    const stride = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += stride) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (Number.isFinite(p.y)) ys.push(p.y);
    }
    if (ys.length < 10) return null;
    ys.sort((a, b) => a - b);
    return ys[Math.floor(ys.length * 0.05)];
  }
}

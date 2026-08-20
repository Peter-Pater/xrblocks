/**
 * A persistent tag25h9 spatial anchor backed by the AprilTag reference
 * detector. Add child objects (such as {@link THREE.AxesHelper}) to this
 * Script to place them at the selected printed tag.
 */
import * as THREE from 'three';
import { Script } from 'xrblocks';
import { type AprilTagCameraIntrinsics, type AprilTagDetection, type AprilTagTrackerOptions, type AprilTagTrackingState } from './AprilTagTypes';
export { APRILTAG_FAMILY, DEFAULT_TAG25H9_ID, DEFAULT_TAG25H9_SIZE_METERS, TAG25H9_MAX_ID, TAG25H9_MIN_ID, } from './AprilTagTypes';
export type { AprilTagCameraIntrinsics, AprilTagDetection, AprilTagTrackerOptions, AprilTagTrackingState, } from './AprilTagTypes';
export { createAprilTagAnchorVisuals } from './AprilTagVisuals';
export type { AprilTagAnchorVisuals, AprilTagAnchorVisualsOptions, } from './AprilTagVisuals';
export { TagAnchorCalibrator } from './TagAnchorCalibration';
export type { TagCalibrationSolveResult, TagCameraCalibration, TagObservationVerdict, TagPoseObservation, } from './TagAnchorCalibration';
/** On-device diagnostics for the most recent accepted observation. */
export interface AprilTagTrackerDiagnostics {
    /** Age of the video pixels when snapshotted, or `null` if unreported. */
    frameLatencyMs: number | null;
    /** Gap between the capture time and the paired pose's timestamp. */
    poseMatchErrorMs: number | null;
    /** Recovered multiplicative correction applied to monocular tag ranges. */
    rangeScale: number;
    /** Magnitude of the recovered extrinsics rotation correction, radians. */
    extrinsicRotationRad: number;
    /** Magnitude of the recovered extrinsics translation correction, metres. */
    extrinsicTranslationM: number;
    /** Keyframes in the calibration set. */
    keyframeCount: number;
    /** Spread of keyframe camera positions, metres. */
    baselineMeters: number;
    /** RMS keyframe residuals of the current fit. */
    rmsTranslationResidualM: number;
    rmsRotationResidualRad: number;
    /** Whether the fit is trusted (diverse baseline, tight residuals). */
    calibrationConverged: boolean;
    /** Where the starting calibration came from. */
    calibrationSource: 'none' | 'restored' | 'pinned';
    /** Head speed at the last capture, or `null` when unknown. */
    linearSpeedMetersPerSec: number | null;
    angularSpeedRadPerSec: number | null;
}
/** localStorage key holding the persisted calibration for a target device. */
export declare function aprilTagCalibrationStorageKey(targetDevice: string): string;
/** Persisted calibration payload, as written by {@link AprilTagTracker}. */
export interface PersistedAprilTagCalibration {
    rotation: [number, number, number, number];
    translation: [number, number, number];
    rangeScale?: number;
    tagSizeMeters?: number;
}
/**
 * Reads a previously persisted device-camera calibration without
 * instantiating a tracker — for example to decide whether a "use stored
 * calibration" UI action has anything to apply. Returns `null` when nothing
 * is stored, the payload is malformed or from an incompatible storage
 * version, or storage itself is unavailable (for example inside a
 * sandboxed iframe, where even `localStorage` access can throw).
 */
export declare function loadPersistedAprilTagCalibration(targetDevice: string): PersistedAprilTagCalibration | null;
/**
 * Converts an XRBlocks device-camera projection matrix into the pinhole
 * intrinsics required by the AprilTag pose estimator.
 */
export declare function getAprilTagCameraIntrinsics(clipFromView: THREE.Matrix4, width: number, height: number): AprilTagCameraIntrinsics;
/**
 * Places an official AprilTag camera-from-tag pose into XRBlocks/Three.js
 * world space. Only the camera frame is converted (computer-vision
 * +Y-down/+Z-forward to the Three.js +Y-up, looking along −Z). The tag
 * frame passes through unchanged, so the anchor keeps the official AprilTag
 * tag axes: X to the right and Y downward as the printed tag is viewed,
 * with Z pointing into the tag.
 */
export declare function getWorldFromAprilTagPose(detection: Pick<AprilTagDetection, 'rotation' | 'translation'>, worldFromView: THREE.Matrix4, target?: THREE.Matrix4): THREE.Matrix4;
/**
 * Tracks one tag25h9 marker as a persistent, self-calibrating spatial
 * anchor.
 *
 * Each accepted detection feeds a {@link TagAnchorCalibrator}, which jointly
 * refines the tag's world pose together with a correction to the SDK's
 * estimated device-camera extrinsics and a range-scale correction for the
 * assumed focal length / printed tag size. The rendered anchor is the
 * optimized world pose — world-fixed by construction rather than chasing
 * per-frame measurements — so it converges onto the physical tag as the
 * viewer moves instead of swimming with the viewpoint. The recovered camera
 * calibration persists across sessions on the same device. Once a pose has
 * been established, the transform is retained while the tag is outside the
 * camera view.
 */
export declare class AprilTagTracker extends Script {
    readonly family: "tag25h9";
    private readonly options;
    private readonly poseRing;
    private readonly calibrator;
    private readonly targetPosition;
    private readonly targetQuaternion;
    private readonly targetScale;
    private readonly optimizedWorldFromTag;
    private viewCorrection;
    private worker;
    private inFlight;
    private captureInFlight;
    private nextRequestId;
    private lastRequestedAt;
    private lastVisualPoseAt;
    private lastSolveAt;
    private lastPersistedAt;
    private anchorEstablished;
    private configurationEpoch;
    private outlierStreak;
    private calibrationLoaded;
    private calibrationConverged;
    private calibrationSource;
    private detectionPaused;
    private lastLoggedCalibration;
    private lastBaselineMeters;
    private lastRmsTranslationResidualM;
    private lastRmsRotationResidualRad;
    private lastFrameLatencyMs;
    private lastPoseMatchErrorMs;
    private lastLinearSpeed;
    private lastAngularSpeed;
    /** The ID currently being sought. Changing it clears the existing anchor. */
    tagId: number;
    /** Printed black-and-white tag width, in metres. */
    tagSizeMeters: number;
    /** Current tracking state, including retained-but-not-currently-visible. */
    state: AprilTagTrackingState;
    /** Short status intended for a UI panel. */
    status: string;
    /** Time of the most recent accepted visual measurement, or `null`. */
    lastSeenAt: number | null;
    constructor(options?: AprilTagTrackerOptions);
    /** Whether this frame has a fresh visual observation of the selected tag. */
    get isVisible(): boolean;
    /** Whether this tracker has a usable visual or cached spatial-anchor pose. */
    get hasAnchor(): boolean;
    /** Recovered multiplicative correction applied to monocular tag ranges. */
    get estimatedRangeScale(): number;
    /** Whether the detection loop is currently suspended. */
    get isDetectionPaused(): boolean;
    /**
     * Suspend or resume the detection loop. While paused the tracker is fully
     * idle -- no pose recording, no frame captures, no worker traffic -- and
     * the anchor and calibration stop changing. On resume the pose ring
     * refills within a few frames; until then detections fall back to the
     * current-frame pose instead of a latency-matched historical one. Use this
     * to "freeze" a calibration session once it looks good, or to yield the
     * device camera to another consumer without tearing the tracker down.
     */
    setDetectionPaused(paused: boolean): void;
    /**
     * Snapshot of the recovered device-camera calibration, in the same array
     * shape as the constructor's `calibration` option — so
     * `new AprilTagTracker({calibration: tracker.getCalibration()})`
     * round-trips it into a fresh tracker.
     */
    getCalibration(): {
        rotation: [number, number, number, number];
        translation: [number, number, number];
        rangeScale: number;
    };
    /** Diagnostics for the most recent detector round trip. */
    get diagnostics(): AprilTagTrackerDiagnostics;
    /**
     * One-line diagnostics string for on-headset panels. ASCII separators
     * only — the uikit text font lacks glyphs like the middle dot.
     */
    get diagnosticsSummary(): string;
    /**
     * Extra rotation applied to the SDK's estimated device-camera extrinsics,
     * in radians, matching the `Object3DDetector` calibration convention. The
     * self-calibration normally recovers this automatically; the option
     * remains for pinning a known offset.
     */
    setCameraRotationOffset(offset: {
        yaw?: number;
        pitch?: number;
        roll?: number;
    }): void;
    /** Select another tag25h9 ID and clear the incompatible cached anchor. */
    setTagId(tagId: number): void;
    /**
     * Change the physical black-and-white tag width and clear the pose and
     * range scale derived from the old size.
     */
    setTagSizeMeters(tagSizeMeters: number): void;
    /**
     * Clear the retained pose and resume searching for the selected tag. The
     * recovered camera calibration is kept — it describes the device, not the
     * tag.
     */
    resetAnchor(): void;
    update(time?: number, frame?: XRFrame): void;
    dispose(): void;
    private startWorker;
    private recordCameraPose;
    private requestDetection;
    private motionWeightFor;
    private handleWorkerReply;
    private applyVisualPose;
    /** Move the rendered anchor toward the calibrator's optimized tag pose. */
    private applyOptimizedPose;
    private finishAcceptedObservation;
    private smoothingAlpha;
    private markNotVisible;
    private calibrationStorageKey;
    private loadCalibrationOnce;
    private persistCalibration;
    private fail;
    private targetDevice;
    private validateTagId;
    private validateTagSize;
}

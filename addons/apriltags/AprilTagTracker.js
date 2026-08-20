import * as THREE from 'three';
import { Script, core, getCameraParametersSnapshot } from 'xrblocks';
import { PoseRing } from '../objects3d/geometry/PoseRing.js';
import { APRILTAG_FAMILY, DEFAULT_TAG25H9_SIZE_METERS, DEFAULT_TAG25H9_ID, TAG25H9_MIN_ID, TAG25H9_MAX_ID } from './AprilTagTypes.js';
import { TagAnchorCalibrator } from './TagAnchorCalibration.js';
export { createAprilTagAnchorVisuals } from './AprilTagVisuals.js';

/**
 * A persistent tag25h9 spatial anchor backed by the AprilTag reference
 * detector. Add child objects (such as {@link THREE.AxesHelper}) to this
 * Script to place them at the selected printed tag.
 */
const CV_TO_THREE = new THREE.Matrix4().makeScale(1, -1, -1);
const IDENTITY = new THREE.Matrix4();
const ID_LABEL = `${APRILTAG_FAMILY} IDs ${TAG25H9_MIN_ID}-${TAG25H9_MAX_ID}`;
// Observations captured during head motion beyond these speeds are discarded
// outright; the paired pose is too uncertain to be worth ingesting.
const MAX_LINEAR_SPEED_M_PER_S = 2.5;
const MAX_ANGULAR_SPEED_RAD_PER_S = 4;
// Soft deweighting of observations by head speed at capture time. Timing
// error between the video pixels and the paired pose scales with speed, so
// fast-motion captures should pull on the anchor less.
const LINEAR_SPEED_SOFT_M_PER_S = 0.6;
const ANGULAR_SPEED_SOFT_RAD_PER_S = 1.2;
// Minimum interval between calibration solves.
const SOLVE_INTERVAL_MS = 400;
// Consecutive outlier observations before concluding that the printed tag
// was physically moved and re-seeding the anchor (the recovered camera
// calibration is kept — it describes the device, not the tag).
const OUTLIER_STREAK_LIMIT = 6;
// Orientation comes from single views, so it is smoothed at least this
// slowly even when the position constant is faster.
const MIN_ORIENTATION_SMOOTHING_MS = 250;
const CALIBRATION_PERSIST_INTERVAL_MS = 5000;
const CALIBRATION_STORAGE_VERSION = 1;
/** localStorage key holding the persisted calibration for a target device. */
function aprilTagCalibrationStorageKey(targetDevice) {
    return `xrblocks:apriltags:calibration:v${CALIBRATION_STORAGE_VERSION}:${targetDevice}`;
}
/**
 * Reads a previously persisted device-camera calibration without
 * instantiating a tracker — for example to decide whether a "use stored
 * calibration" UI action has anything to apply. Returns `null` when nothing
 * is stored, the payload is malformed or from an incompatible storage
 * version, or storage itself is unavailable (for example inside a
 * sandboxed iframe, where even `localStorage` access can throw).
 */
function loadPersistedAprilTagCalibration(targetDevice) {
    try {
        const raw = localStorage.getItem(aprilTagCalibrationStorageKey(targetDevice));
        if (!raw)
            return null;
        const data = JSON.parse(raw);
        if (data?.v !== CALIBRATION_STORAGE_VERSION)
            return null;
        if (data.rotation?.length !== 4 || data.translation?.length !== 3) {
            return null;
        }
        if (![...data.rotation, ...data.translation].every(Number.isFinite)) {
            return null;
        }
        return {
            rotation: data.rotation,
            translation: data.translation,
            rangeScale: data.rangeScale,
            tagSizeMeters: data.tagSizeMeters,
        };
    }
    catch (_error) {
        return null;
    }
}
/**
 * Converts an XRBlocks device-camera projection matrix into the pinhole
 * intrinsics required by the AprilTag pose estimator.
 */
function getAprilTagCameraIntrinsics(clipFromView, width, height) {
    const projection = clipFromView.elements;
    return {
        fx: (projection[0] * width) / 2,
        fy: (projection[5] * height) / 2,
        cx: ((1 - projection[8]) * width) / 2,
        cy: ((1 + projection[9]) * height) / 2,
    };
}
/**
 * Places an official AprilTag camera-from-tag pose into XRBlocks/Three.js
 * world space. Only the camera frame is converted (computer-vision
 * +Y-down/+Z-forward to the Three.js +Y-up, looking along −Z). The tag
 * frame passes through unchanged, so the anchor keeps the official AprilTag
 * tag axes: X to the right and Y downward as the printed tag is viewed,
 * with Z pointing into the tag.
 */
function getWorldFromAprilTagPose(detection, worldFromView, target = new THREE.Matrix4()) {
    const rotation = detection.rotation;
    if (rotation.length !== 9) {
        throw new Error('AprilTag detection had an invalid rotation matrix.');
    }
    const [tx, ty, tz] = detection.translation;
    const cameraCvFromTagCv = new THREE.Matrix4().set(rotation[0], rotation[1], rotation[2], tx, rotation[3], rotation[4], rotation[5], ty, rotation[6], rotation[7], rotation[8], tz, 0, 0, 0, 1);
    const cameraThreeFromTag = new THREE.Matrix4().multiplyMatrices(CV_TO_THREE, cameraCvFromTagCv);
    return target.multiplyMatrices(worldFromView, cameraThreeFromTag);
}
function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
function hasFinitePose(detection) {
    return (detection.rotation.length === 9 &&
        [...detection.rotation, ...detection.translation].every(Number.isFinite) &&
        detection.translation[2] > 0);
}
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
class AprilTagTracker extends Script {
    constructor(options = {}) {
        super();
        this.family = APRILTAG_FAMILY;
        this.poseRing = new PoseRing(120);
        this.calibrator = new TagAnchorCalibrator();
        this.targetPosition = new THREE.Vector3();
        this.targetQuaternion = new THREE.Quaternion();
        this.targetScale = new THREE.Vector3();
        this.optimizedWorldFromTag = new THREE.Matrix4();
        this.viewCorrection = null;
        this.worker = null;
        this.inFlight = null;
        this.captureInFlight = false;
        this.nextRequestId = 1;
        this.lastRequestedAt = -Infinity;
        this.lastVisualPoseAt = 0;
        this.lastSolveAt = -Infinity;
        this.lastPersistedAt = -Infinity;
        this.anchorEstablished = false;
        this.configurationEpoch = 0;
        this.outlierStreak = 0;
        this.calibrationLoaded = false;
        this.calibrationConverged = false;
        this.calibrationSource = 'none';
        this.detectionPaused = false;
        this.lastLoggedCalibration = '';
        this.lastBaselineMeters = 0;
        this.lastRmsTranslationResidualM = 0;
        this.lastRmsRotationResidualRad = 0;
        this.lastFrameLatencyMs = null;
        this.lastPoseMatchErrorMs = null;
        this.lastLinearSpeed = null;
        this.lastAngularSpeed = null;
        /** Current tracking state, including retained-but-not-currently-visible. */
        this.state = 'initializing';
        /** Short status intended for a UI panel. */
        this.status = 'Starting AprilTag detector...';
        /** Time of the most recent accepted visual measurement, or `null`. */
        this.lastSeenAt = null;
        this.options = {
            tagId: options.tagId ?? DEFAULT_TAG25H9_ID,
            tagSizeMeters: options.tagSizeMeters ?? DEFAULT_TAG25H9_SIZE_METERS,
            pollingIntervalMs: options.pollingIntervalMs ?? 100,
            smoothingTimeConstantMs: options.smoothingTimeConstantMs ?? 90,
            maxHamming: options.maxHamming ?? 1,
            minDecisionMargin: options.minDecisionMargin ?? 20,
            persistCalibration: options.persistCalibration ?? true,
        };
        this.setCameraRotationOffset(options.cameraRotationOffset ?? {});
        this.tagId = this.validateTagId(this.options.tagId);
        this.tagSizeMeters = this.validateTagSize(this.options.tagSizeMeters);
        if (options.calibration) {
            // A pinned calibration takes precedence over anything persisted.
            this.calibrator.setCalibration({
                rotation: options.calibration.rotation?.length === 4
                    ? new THREE.Quaternion().fromArray(options.calibration.rotation)
                    : undefined,
                translation: options.calibration.translation?.length === 3
                    ? new THREE.Vector3().fromArray(options.calibration.translation)
                    : undefined,
                rangeScale: options.calibration.rangeScale,
            });
            this.calibrationSource = 'pinned';
            this.calibrationLoaded = true;
        }
        // Do not show an arbitrary origin before the first visual observation.
        this.visible = false;
    }
    /** Whether this frame has a fresh visual observation of the selected tag. */
    get isVisible() {
        return this.state === 'tracked';
    }
    /** Whether this tracker has a usable visual or cached spatial-anchor pose. */
    get hasAnchor() {
        return this.anchorEstablished;
    }
    /** Recovered multiplicative correction applied to monocular tag ranges. */
    get estimatedRangeScale() {
        return this.calibrator.rangeScale;
    }
    /** Whether the detection loop is currently suspended. */
    get isDetectionPaused() {
        return this.detectionPaused;
    }
    /**
     * Suspend or resume the detection loop. While paused the tracker is fully
     * idle -- no pose recording, no frame captures, no worker traffic -- and
     * the anchor and calibration stop changing. On resume the pose ring
     * refills within a few frames; until then detections fall back to the
     * current-frame pose instead of a latency-matched historical one. Use this
     * to "freeze" a calibration session once it looks good, or to yield the
     * device camera to another consumer without tearing the tracker down.
     */
    setDetectionPaused(paused) {
        this.detectionPaused = paused;
    }
    /**
     * Snapshot of the recovered device-camera calibration, in the same array
     * shape as the constructor's `calibration` option — so
     * `new AprilTagTracker({calibration: tracker.getCalibration()})`
     * round-trips it into a fresh tracker.
     */
    getCalibration() {
        const calibration = this.calibrator.getCalibration();
        return {
            rotation: calibration.rotation.toArray(),
            translation: calibration.translation.toArray(),
            rangeScale: calibration.rangeScale,
        };
    }
    /** Diagnostics for the most recent detector round trip. */
    get diagnostics() {
        const extrinsic = this.calibrator.extrinsicCorrection;
        return {
            frameLatencyMs: this.lastFrameLatencyMs,
            poseMatchErrorMs: this.lastPoseMatchErrorMs,
            rangeScale: this.calibrator.rangeScale,
            extrinsicRotationRad: extrinsic.rotationRad,
            extrinsicTranslationM: extrinsic.translationM,
            keyframeCount: this.calibrator.keyframeCount,
            baselineMeters: this.lastBaselineMeters,
            rmsTranslationResidualM: this.lastRmsTranslationResidualM,
            rmsRotationResidualRad: this.lastRmsRotationResidualRad,
            calibrationConverged: this.calibrationConverged,
            calibrationSource: this.calibrationSource,
            linearSpeedMetersPerSec: this.lastLinearSpeed,
            angularSpeedRadPerSec: this.lastAngularSpeed,
        };
    }
    /**
     * One-line diagnostics string for on-headset panels. ASCII separators
     * only — the uikit text font lacks glyphs like the middle dot.
     */
    get diagnosticsSummary() {
        const extrinsic = this.calibrator.extrinsicCorrection;
        const latency = this.lastFrameLatencyMs === null
            ? 'lat -'
            : `lat ${(Math.round(this.lastFrameLatencyMs / 10) * 10).toFixed(0)}ms`;
        const poseMatch = this.lastPoseMatchErrorMs === null
            ? 'pose -'
            : `pose ~${Math.round(this.lastPoseMatchErrorMs).toFixed(0)}ms`;
        // The '*' marks a calibration restored from storage or pinned via the
        // constructor option; '?' marks a fit not yet trusted.
        const calibrationMark = this.calibrationSource === 'none' ? '' : '*';
        return (`kf ${this.calibrator.keyframeCount}` +
            ` | base ${this.lastBaselineMeters.toFixed(1)}m` +
            ` | res ${(this.lastRmsTranslationResidualM * 100).toFixed(1)}cm/` +
            `${THREE.MathUtils.radToDeg(this.lastRmsRotationResidualRad).toFixed(1)}deg` +
            ` | cal${calibrationMark} ` +
            `${THREE.MathUtils.radToDeg(extrinsic.rotationRad).toFixed(1)}deg/` +
            `${(extrinsic.translationM * 100).toFixed(1)}cm` +
            ` | k ${this.calibrator.rangeScale.toFixed(2)}` +
            `${this.calibrationConverged ? '' : '?'}` +
            ` | ${latency} | ${poseMatch}`);
    }
    /**
     * Extra rotation applied to the SDK's estimated device-camera extrinsics,
     * in radians, matching the `Object3DDetector` calibration convention. The
     * self-calibration normally recovers this automatically; the option
     * remains for pinning a known offset.
     */
    setCameraRotationOffset(offset) {
        const yaw = offset.yaw ?? 0;
        const pitch = offset.pitch ?? 0;
        const roll = offset.roll ?? 0;
        this.viewCorrection =
            yaw === 0 && pitch === 0 && roll === 0
                ? null
                : new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    }
    /** Select another tag25h9 ID and clear the incompatible cached anchor. */
    setTagId(tagId) {
        const nextId = this.validateTagId(tagId);
        if (nextId === this.tagId)
            return;
        this.tagId = nextId;
        this.resetAnchor();
    }
    /**
     * Change the physical black-and-white tag width and clear the pose and
     * range scale derived from the old size.
     */
    setTagSizeMeters(tagSizeMeters) {
        const nextSize = this.validateTagSize(tagSizeMeters);
        if (nextSize === this.tagSizeMeters)
            return;
        this.tagSizeMeters = nextSize;
        this.calibrator.resetRangeScale();
        this.resetAnchor();
    }
    /**
     * Clear the retained pose and resume searching for the selected tag. The
     * recovered camera calibration is kept — it describes the device, not the
     * tag.
     */
    resetAnchor() {
        this.configurationEpoch++;
        this.anchorEstablished = false;
        this.lastSeenAt = null;
        this.lastVisualPoseAt = 0;
        this.visible = false;
        this.calibrator.resetTag();
        this.outlierStreak = 0;
        this.calibrationConverged = false;
        this.lastBaselineMeters = 0;
        this.lastRmsTranslationResidualM = 0;
        this.lastRmsRotationResidualRad = 0;
        this.state = 'searching';
        this.status = `Looking for ${APRILTAG_FAMILY} ID ${this.tagId}.`;
    }
    update(time, frame) {
        // Paused means fully idle: no pose recording, no snapshots, no worker
        // traffic -- a frozen tracker costs nothing per frame. On resume the pose
        // ring refills within a few frames, and until it does requestDetection
        // falls back to the current-frame pose (`lookup(...) ?? params
        // .worldFromView`), so the first post-resume detection is merely
        // unwarped, never wrong.
        if (this.detectionPaused)
            return;
        const poseStamp = typeof time === 'number' ? time : now();
        const params = this.recordCameraPose(poseStamp);
        if (!this.worker)
            this.startWorker();
        if (!params ||
            !this.worker ||
            this.captureInFlight ||
            this.state === 'error') {
            return;
        }
        this.loadCalibrationOnce();
        const timestamp = now();
        if (timestamp - this.lastRequestedAt < this.options.pollingIntervalMs) {
            return;
        }
        this.lastRequestedAt = timestamp;
        void this.requestDetection(params);
    }
    dispose() {
        if (this.worker) {
            this.worker.postMessage({ type: 'dispose' });
            this.worker.terminate();
            this.worker = null;
        }
        this.inFlight = null;
        this.captureInFlight = false;
        this.poseRing.clear();
        this.calibrator.resetTag();
    }
    startWorker() {
        if (typeof Worker === 'undefined') {
            this.fail('AprilTag detection requires browser Worker support.');
            return;
        }
        try {
            this.worker = new Worker(new URL('./AprilTagWorker.js', import.meta.url), {
                type: 'module',
            });
            this.worker.onmessage = (event) => this.handleWorkerReply(event.data);
            this.worker.onerror = () => this.fail('The AprilTag detector worker stopped unexpectedly.');
            this.worker.postMessage({ type: 'initialize' });
        }
        catch (error) {
            this.fail(`Could not start the AprilTag detector: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    recordCameraPose(poseStamp) {
        const deviceCamera = core.deviceCamera;
        const renderer = core.renderer;
        if (!deviceCamera || !renderer) {
            if (!this.anchorEstablished && this.state !== 'initializing') {
                this.status = 'Waiting for the device camera.';
            }
            return null;
        }
        try {
            const params = getCameraParametersSnapshot(core.camera, renderer.xr.getCamera(), deviceCamera, this.targetDevice());
            if (params)
                this.poseRing.push(poseStamp, params.worldFromView);
            return params;
        }
        catch (_error) {
            return null;
        }
    }
    async requestDetection(params) {
        this.captureInFlight = true;
        const deviceCamera = core.deviceCamera;
        if (!deviceCamera || !this.worker) {
            this.captureInFlight = false;
            return;
        }
        let captureTime = now();
        let frameLatencyMs = null;
        try {
            const frame = await deviceCamera.waitForFreshFrame?.();
            const reported = frame?.captureTime ?? frame?.receiveTime ?? frame?.presentationTime;
            if (reported !== undefined) {
                captureTime = reported;
                frameLatencyMs = now() - reported;
            }
        }
        catch (_error) {
            // The freshness event is an optimisation; a snapshot may still be valid.
        }
        let snapshot = null;
        try {
            snapshot = deviceCamera.getSnapshot({ outputFormat: 'imageData' }) ?? null;
        }
        catch (_error) {
            snapshot = null;
        }
        if (!snapshot || !this.worker || this.state === 'error') {
            this.captureInFlight = false;
            if (!this.anchorEstablished) {
                this.state = 'searching';
                this.status = 'Waiting for a camera frame.';
            }
            else {
                this.state = 'anchored';
                this.status = 'Anchor retained; tag is not currently visible.';
            }
            return;
        }
        const historicalPose = this.poseRing.lookup(captureTime) ?? params.worldFromView;
        const velocity = this.poseRing.velocityAround(captureTime);
        const requestId = this.nextRequestId++;
        this.inFlight = {
            requestId,
            worldFromView: historicalPose.clone(),
            configurationEpoch: this.configurationEpoch,
            captureTimeMs: captureTime,
            motionWeight: this.motionWeightFor(velocity),
            frameLatencyMs,
            poseMatchErrorMs: this.poseRing.matchErrorMs(captureTime),
        };
        this.lastLinearSpeed = velocity?.linearMetersPerSec ?? null;
        this.lastAngularSpeed = velocity?.angularRadPerSec ?? null;
        try {
            this.worker.postMessage({
                type: 'detect',
                requestId,
                imageBuffer: snapshot.data.buffer,
                width: snapshot.width,
                height: snapshot.height,
                intrinsics: getAprilTagCameraIntrinsics(params.clipFromView, snapshot.width, snapshot.height),
                tagSizeMeters: this.tagSizeMeters,
            }, [snapshot.data.buffer]);
        }
        catch (error) {
            this.captureInFlight = false;
            this.inFlight = null;
            this.fail(`Could not send a frame to the AprilTag detector: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    motionWeightFor(velocity) {
        if (!velocity)
            return 1;
        if (velocity.linearMetersPerSec > MAX_LINEAR_SPEED_M_PER_S ||
            velocity.angularRadPerSec > MAX_ANGULAR_SPEED_RAD_PER_S) {
            return 0;
        }
        const linear = velocity.linearMetersPerSec / LINEAR_SPEED_SOFT_M_PER_S;
        const angular = velocity.angularRadPerSec / ANGULAR_SPEED_SOFT_RAD_PER_S;
        return 1 / (1 + linear * linear + angular * angular);
    }
    handleWorkerReply(reply) {
        if (reply.type === 'ready') {
            this.state = 'searching';
            this.status = `Looking for ${APRILTAG_FAMILY} ID ${this.tagId}.`;
            return;
        }
        if (reply.type === 'error') {
            if (reply.requestId === undefined ||
                reply.requestId === this.inFlight?.requestId) {
                this.inFlight = null;
                this.captureInFlight = false;
            }
            this.fail(reply.message);
            return;
        }
        if (reply.requestId !== this.inFlight?.requestId)
            return;
        const request = this.inFlight;
        this.inFlight = null;
        this.captureInFlight = false;
        // Detection was paused (e.g. the session was frozen) while this image
        // was in flight; its result must not move the anchor or calibrator.
        if (this.detectionPaused)
            return;
        // A tag ID, tag size, or explicit reset changed while this image was being
        // processed. Its result cannot refine the new anchor configuration.
        if (request.configurationEpoch !== this.configurationEpoch)
            return;
        const detection = reply.detections.find((candidate) => candidate.id === this.tagId &&
            candidate.hamming <= this.options.maxHamming &&
            candidate.decisionMargin >= this.options.minDecisionMargin &&
            hasFinitePose(candidate));
        if (!detection) {
            this.markNotVisible();
            return;
        }
        this.applyVisualPose(detection, request);
    }
    applyVisualPose(detection, request) {
        // A capture during head motion beyond the hard limits pairs pixels with a
        // pose too uncertain to use; keep the retained anchor instead.
        if (request.motionWeight <= 0) {
            this.markNotVisible();
            return;
        }
        const worldFromView = request.worldFromView;
        if (this.viewCorrection) {
            worldFromView.multiply(this.viewCorrection);
        }
        const [tx, ty, tz] = detection.translation;
        if (Math.hypot(tx, ty, tz) <= 0) {
            this.markNotVisible();
            return;
        }
        // The measured camera-from-tag pose in the Three.js camera frame.
        const cameraFromTag = getWorldFromAprilTagPose(detection, IDENTITY);
        const observation = {
            worldFromCamera: worldFromView,
            rotation: new THREE.Quaternion().setFromRotationMatrix(cameraFromTag),
            translation: new THREE.Vector3(tx, -ty, -tz),
            weight: request.motionWeight,
            timeMs: request.captureTimeMs,
        };
        const timestamp = now();
        const verdict = this.calibrator.observe(observation);
        if (verdict.isOutlier) {
            this.outlierStreak++;
            if (this.outlierStreak >= OUTLIER_STREAK_LIMIT) {
                // Persistent disagreement: the printed tag was likely moved. Restart
                // the tag pose while keeping the recovered camera calibration.
                this.calibrator.resetTag();
                this.calibrator.seed(observation);
                this.outlierStreak = 0;
                this.applyOptimizedPose(timestamp, true);
                this.finishAcceptedObservation(request, timestamp);
            }
            else {
                // A pose flip or transient glitch: report tracked, hold the anchor.
                this.lastSeenAt = timestamp;
                this.state = 'tracked';
                this.status = `Tracking ${APRILTAG_FAMILY} ID ${this.tagId}.`;
            }
            return;
        }
        this.outlierStreak = 0;
        if (timestamp - this.lastSolveAt >= SOLVE_INTERVAL_MS) {
            this.lastSolveAt = timestamp;
            const result = this.calibrator.solve(timestamp);
            if (result) {
                this.lastBaselineMeters = result.baselineMeters;
                this.lastRmsTranslationResidualM = result.rmsTranslationResidualM;
                this.lastRmsRotationResidualRad = result.rmsRotationResidualRad;
                this.calibrationConverged = result.converged;
                if (result.converged)
                    this.persistCalibration(timestamp);
            }
        }
        this.applyOptimizedPose(timestamp, !this.anchorEstablished);
        this.finishAcceptedObservation(request, timestamp);
    }
    /** Move the rendered anchor toward the calibrator's optimized tag pose. */
    applyOptimizedPose(timestamp, snap) {
        this.calibrator.getWorldFromTag(this.optimizedWorldFromTag);
        this.optimizedWorldFromTag.decompose(this.targetPosition, this.targetQuaternion, this.targetScale);
        if (snap || !this.anchorEstablished) {
            this.position.copy(this.targetPosition);
            this.quaternion.copy(this.targetQuaternion);
            this.anchorEstablished = true;
            this.visible = true;
            return;
        }
        const elapsed = Math.max(0, timestamp - this.lastVisualPoseAt);
        this.position.lerp(this.targetPosition, this.smoothingAlpha(elapsed, this.options.smoothingTimeConstantMs));
        this.quaternion.slerp(this.targetQuaternion, this.smoothingAlpha(elapsed, Math.max(this.options.smoothingTimeConstantMs, MIN_ORIENTATION_SMOOTHING_MS)));
    }
    finishAcceptedObservation(request, timestamp) {
        this.lastFrameLatencyMs = request.frameLatencyMs;
        this.lastPoseMatchErrorMs = request.poseMatchErrorMs;
        this.lastVisualPoseAt = timestamp;
        this.lastSeenAt = timestamp;
        this.state = 'tracked';
        this.status = `Tracking ${APRILTAG_FAMILY} ID ${this.tagId}.`;
    }
    smoothingAlpha(elapsedMs, timeConstantMs) {
        return timeConstantMs <= 0 ? 1 : 1 - Math.exp(-elapsedMs / timeConstantMs);
    }
    markNotVisible() {
        if (this.anchorEstablished) {
            this.state = 'anchored';
            this.status = 'Anchor retained; tag is not currently visible.';
        }
        else {
            this.state = 'searching';
            this.status = `Looking for ${APRILTAG_FAMILY} ID ${this.tagId}.`;
        }
    }
    calibrationStorageKey() {
        return aprilTagCalibrationStorageKey(this.targetDevice());
    }
    loadCalibrationOnce() {
        if (this.calibrationLoaded)
            return;
        this.calibrationLoaded = true;
        if (!this.options.persistCalibration)
            return;
        if (core.deviceCamera?.simulatorCamera)
            return;
        const data = loadPersistedAprilTagCalibration(this.targetDevice());
        if (!data)
            return;
        this.calibrator.setCalibration({
            rotation: new THREE.Quaternion().fromArray(data.rotation),
            translation: new THREE.Vector3().fromArray(data.translation),
            // The range scale folds in the printed tag size, so only reuse it
            // when the configured size matches the persisted one.
            rangeScale: data.tagSizeMeters === this.tagSizeMeters ? data.rangeScale : undefined,
        });
        this.calibrationSource = 'restored';
        console.log('[AprilTagTracker] Restored persisted camera calibration:', JSON.stringify(data));
    }
    persistCalibration(timestamp) {
        if (!this.options.persistCalibration)
            return;
        if (timestamp - this.lastPersistedAt < CALIBRATION_PERSIST_INTERVAL_MS) {
            return;
        }
        this.lastPersistedAt = timestamp;
        const calibration = this.calibrator.getCalibration();
        // Log the values (rounded, so the log only repeats on real change) in a
        // form that can be pasted into the `calibration` option to pin them.
        // This is deliberately independent of storage: it must appear even in
        // contexts where localStorage is unavailable.
        const round = (value) => Math.round(value * 10000) / 10000;
        const pinnable = JSON.stringify({
            rotation: calibration.rotation.toArray().map(round),
            translation: calibration.translation.toArray().map(round),
            rangeScale: round(calibration.rangeScale),
        });
        if (pinnable !== this.lastLoggedCalibration) {
            this.lastLoggedCalibration = pinnable;
            console.log('[AprilTagTracker] Camera calibration converged; pass as ' +
                `new AprilTagTracker({calibration: ${pinnable}}) to pin it.`);
        }
        if (core.deviceCamera?.simulatorCamera)
            return;
        try {
            localStorage.setItem(this.calibrationStorageKey(), JSON.stringify({
                v: CALIBRATION_STORAGE_VERSION,
                rotation: calibration.rotation.toArray(),
                translation: calibration.translation.toArray(),
                rangeScale: calibration.rangeScale,
                tagSizeMeters: this.tagSizeMeters,
            }));
        }
        catch (_error) {
            // Persisted calibration is a bonus; storage can be unavailable (for
            // example inside a sandboxed iframe) — even `localStorage` access
            // itself may throw there.
        }
    }
    fail(message) {
        this.state = 'error';
        this.status = message;
        this.inFlight = null;
        this.captureInFlight = false;
        console.error(`[AprilTagTracker] ${message}`);
    }
    targetDevice() {
        return core.world?.objects?.targetDevice ?? 'galaxyxr';
    }
    validateTagId(tagId) {
        if (!Number.isInteger(tagId) ||
            tagId < TAG25H9_MIN_ID ||
            tagId > TAG25H9_MAX_ID) {
            throw new RangeError(`${ID_LABEL}; received ${tagId}.`);
        }
        return tagId;
    }
    validateTagSize(tagSizeMeters) {
        if (!Number.isFinite(tagSizeMeters) || tagSizeMeters <= 0) {
            throw new RangeError('AprilTag size must be a positive number of metres.');
        }
        return tagSizeMeters;
    }
}

export { APRILTAG_FAMILY, AprilTagTracker, DEFAULT_TAG25H9_ID, DEFAULT_TAG25H9_SIZE_METERS, TAG25H9_MAX_ID, TAG25H9_MIN_ID, TagAnchorCalibrator, aprilTagCalibrationStorageKey, getAprilTagCameraIntrinsics, getWorldFromAprilTagPose, loadPersistedAprilTagCalibration };

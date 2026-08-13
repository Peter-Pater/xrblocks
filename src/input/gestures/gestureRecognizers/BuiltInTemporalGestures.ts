import * as THREE from 'three';

import type {GestureConfiguration} from '../GestureRecognitionOptions';
import type {GestureDetectionResult, HandGestureContext} from '../GestureTypes';
import {average, clamp01, getPalmPose} from '../HandPoseMetrics';
import {
  DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
  detectOpenPalm,
  detectThumbsUp,
} from './BuiltInHeuristicGestures';

interface OscillationGestureParameters {
  /** Number of qualifying direction changes needed to complete the gesture. */
  reversalCount: number;
  minimumDurationMs: number;
  maximumDurationMs: number;
  /** Maximum palm-center travel, measured in average palm widths. */
  maximumTranslation: number;
  minimumAngularSpeedDegreesPerSecond: number;
  /** Brief invalid/noisy pose span that may be bridged inside a motion. */
  maximumPoseDropoutMs: number;
  /** Keeps a completed gesture active long enough to emit stable events. */
  detectionHoldMs: number;
  /** Recent window used to keep a completed gesture active while motion continues. */
  continuationWindowMs: number;
  /** Minimum angular travel inside the continuation window. */
  minimumContinuationDegrees: number;
}

export interface ShooGestureParameters extends OscillationGestureParameters {
  /** Maximum wrist-to-fingers tilt away from horizontal. */
  horizontalToleranceDegrees: number;
  minimumOpenness: number;
}

export interface BeckonGestureParameters extends OscillationGestureParameters {
  /** Maximum wrist-to-knuckle-center tilt away from upright. */
  verticalToleranceDegrees: number;
  /** Rejects poses which are better interpreted as a thumbs-up. */
  maximumThumbsUpConfidence: number;
}

export const DEFAULT_SHOO_GESTURE_PARAMETERS: Readonly<ShooGestureParameters> =
  {
    reversalCount: 2,
    minimumDurationMs: 250,
    maximumDurationMs: 1200,
    horizontalToleranceDegrees: 30,
    minimumOpenness: 0.6,
    maximumTranslation: 0.75,
    minimumAngularSpeedDegreesPerSecond: 75,
    maximumPoseDropoutMs: 100,
    detectionHoldMs: 180,
    continuationWindowMs: 0,
    minimumContinuationDegrees: 0,
  };

export const DEFAULT_BECKON_GESTURE_PARAMETERS: Readonly<BeckonGestureParameters> =
  {
    reversalCount: 2,
    minimumDurationMs: 250,
    maximumDurationMs: 1200,
    verticalToleranceDegrees: 40,
    maximumThumbsUpConfidence: 0.55,
    maximumTranslation: 0.75,
    minimumAngularSpeedDegreesPerSecond: 60,
    maximumPoseDropoutMs: 100,
    detectionHoldMs: 180,
    continuationWindowMs: 0,
    minimumContinuationDegrees: 0,
  };

type OscillationPose = {
  timestamp: number;
  angle: number;
  center: THREE.Vector3;
  width: number;
  openness: number;
  poseQuality: number;
  alignment: number;
  verticalAlignment?: number;
};

type OscillationDiagnostics = {
  duration: number;
  reversals: number;
  amplitude: number;
  peakAngularSpeed: number;
  openness: number;
  translation: number;
};

const EMPTY_DIAGNOSTICS: OscillationDiagnostics = {
  duration: 0,
  reversals: 0,
  amplitude: 0,
  peakAngularSpeed: 0,
  openness: 0,
  translation: 0,
};

/** Detects a completed horizontal wrist wave used to shoo someone away. */
export function detectShoo(
  context: HandGestureContext,
  config: GestureConfiguration<ShooGestureParameters>
): GestureDetectionResult {
  const parameters = {
    ...DEFAULT_SHOO_GESTURE_PARAMETERS,
    ...config.parameters,
  };
  const poses = collectEligibleTail(
    context,
    parameters.maximumPoseDropoutMs,
    (sample) => {
      const palm = getPalmPose(sample);
      const fingerAxis = getWristToFingersAxis(sample);
      const openness = detectOpenPalm(sample, {enabled: true}).confidence;
      if (!palm || !fingerAxis || openness < parameters.minimumOpenness) {
        return null;
      }

      const verticalComponent = THREE.MathUtils.clamp(
        Math.abs(fingerAxis.y),
        0,
        1
      );
      const tiltDegrees = THREE.MathUtils.radToDeg(
        Math.asin(verticalComponent)
      );
      if (tiltDegrees > parameters.horizontalToleranceDegrees) return null;

      return {
        timestamp: sample.timestamp,
        angle: Math.atan2(fingerAxis.x, fingerAxis.z),
        center: palm.center,
        width: palm.width,
        openness,
        poseQuality: openness,
        alignment: clamp01(1 - verticalComponent),
      };
    }
  );
  const horizontalAlignment = average(poses.map((pose) => pose.alignment));

  return detectOscillation(
    poses,
    config.threshold ?? THREE.MathUtils.degToRad(15),
    parameters,
    {horizontalAlignment}
  );
}

/**
 * Detects an upright hand rocking away from and back toward vertical. It is the
 * same temporal oscillation as shoo, rotated by 90 degrees: shoo tracks the
 * direction of a horizontal hand axis, while beckon tracks the tilt magnitude
 * of a vertical hand axis. Finger openness and viewer position are irrelevant.
 */
export function detectBeckon(
  context: HandGestureContext,
  config: GestureConfiguration<BeckonGestureParameters>
): GestureDetectionResult {
  const parameters = {
    ...DEFAULT_BECKON_GESTURE_PARAMETERS,
    ...config.parameters,
  };
  const poses = collectEligibleTail(
    context,
    parameters.maximumPoseDropoutMs,
    (sample) => {
      const palm = getPalmPose(sample);
      const handAxis = getWristToKnucklesAxis(sample);
      const openness = detectOpenPalm(sample, {enabled: true}).confidence;
      const thumbsUpConfidence = detectThumbsUp(sample, {
        enabled: true,
        parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
      }).confidence;
      if (
        !palm ||
        !handAxis ||
        thumbsUpConfidence > parameters.maximumThumbsUpConfidence
      ) {
        return null;
      }

      const verticalAlignment = clamp01(handAxis.y);
      const tiltDegrees = THREE.MathUtils.radToDeg(
        Math.acos(verticalAlignment)
      );
      if (tiltDegrees > parameters.verticalToleranceDegrees) return null;

      return {
        timestamp: sample.timestamp,
        angle: Math.atan2(Math.hypot(handAxis.x, handAxis.z), handAxis.y),
        center: palm.center,
        width: palm.width,
        openness,
        poseQuality: 1,
        alignment: verticalAlignment,
        verticalAlignment,
      };
    }
  );
  const verticalAlignment = average(
    poses.map((pose) => pose.verticalAlignment ?? 0)
  );

  return detectOscillation(
    poses,
    config.threshold ?? THREE.MathUtils.degToRad(15),
    parameters,
    {verticalAlignment}
  );
}

function detectOscillation(
  poses: OscillationPose[],
  strokeThreshold: number,
  parameters: OscillationGestureParameters,
  orientationDiagnostics: Record<string, number>
): GestureDetectionResult {
  if (poses.length < 3) {
    return {
      confidence: 0,
      data: {...EMPTY_DIAGNOSTICS, ...orientationDiagnostics},
    };
  }

  unwrapAngles(poses);
  const reversals = findReversals(poses, strokeThreshold);
  const requiredReversals = Math.max(1, Math.floor(parameters.reversalCount));
  if (reversals.length < requiredReversals) {
    return {
      confidence: 0,
      data: {
        ...EMPTY_DIAGNOSTICS,
        ...orientationDiagnostics,
        reversals: reversals.length,
        openness: average(poses.map((pose) => pose.openness)),
      },
    };
  }

  const completedReversals = reversals.slice(-requiredReversals);
  const startIndex = completedReversals[0].startIndex;
  const endIndex = completedReversals.at(-1)?.endIndex ?? startIndex;
  const detectionIndex = completedReversals.at(-1)?.detectionIndex ?? endIndex;
  const motion = poses.slice(startIndex, endIndex + 1);
  const duration = poses[endIndex].timestamp - poses[startIndex].timestamp;
  const completionAge =
    poses.at(-1)!.timestamp - poses[detectionIndex].timestamp;
  const amplitude = Math.min(
    ...completedReversals.map((reversal) => reversal.amplitude)
  );
  const peakAngularSpeed = getPeakAngularSpeed(motion);
  const openness = average(motion.map((pose) => pose.openness));
  const poseQuality = average(motion.map((pose) => pose.poseQuality));
  const alignment = average(motion.map((pose) => pose.alignment));
  const translation = getTranslation(motion);
  const diagnostics = {
    duration,
    reversals: completedReversals.length,
    amplitude: THREE.MathUtils.radToDeg(amplitude),
    peakAngularSpeed: THREE.MathUtils.radToDeg(peakAngularSpeed),
    openness,
    translation,
    ...orientationDiagnostics,
  };

  const durationValid =
    duration >= parameters.minimumDurationMs &&
    duration <= parameters.maximumDurationMs;
  const speedValid =
    peakAngularSpeed >=
    THREE.MathUtils.degToRad(parameters.minimumAngularSpeedDegreesPerSecond);
  const translationValid = translation <= parameters.maximumTranslation;
  const continuing = hasRecentAngularTravel(
    poses,
    parameters.continuationWindowMs,
    THREE.MathUtils.degToRad(parameters.minimumContinuationDegrees)
  );
  const holdValid = completionAge <= parameters.detectionHoldMs || continuing;
  if (!durationValid || !speedValid || !translationValid || !holdValid) {
    return {confidence: 0, data: diagnostics};
  }

  const amplitudeScore = clamp01(amplitude / strokeThreshold);
  const speedScore = clamp01(
    peakAngularSpeed /
      THREE.MathUtils.degToRad(parameters.minimumAngularSpeedDegreesPerSecond)
  );
  const translationScore = clamp01(
    1 - translation / Math.max(parameters.maximumTranslation, 1e-6)
  );
  const quality = clamp01(
    poseQuality * 0.35 +
      alignment * 0.2 +
      amplitudeScore * 0.2 +
      speedScore * 0.15 +
      translationScore * 0.1
  );

  return {
    confidence: clamp01(0.62 + quality * 0.38),
    data: {...diagnostics, continuing},
  };
}

function hasRecentAngularTravel(
  poses: OscillationPose[],
  windowMs: number,
  minimumTravel: number
) {
  if (windowMs <= 0 || minimumTravel <= 0 || poses.length < 2) return false;
  const latestTimestamp = poses.at(-1)!.timestamp;
  const recent = poses.filter(
    (pose) => pose.timestamp >= latestTimestamp - windowMs
  );
  if (recent.length < 2) return false;
  const angles = recent.map((pose) => pose.angle);
  return Math.max(...angles) - Math.min(...angles) >= minimumTravel;
}

function getWristToFingersAxis(context: HandGestureContext['samples'][number]) {
  const wrist = context.getJoint('wrist');
  const middleTip = context.getJoint('middle-finger-tip');
  if (!wrist || !middleTip) return null;
  const axis = new THREE.Vector3().subVectors(middleTip, wrist);
  if (axis.lengthSq() <= 1e-6) return null;
  return axis.normalize();
}

function getWristToKnucklesAxis(
  context: HandGestureContext['samples'][number]
) {
  const wrist = context.getJoint('wrist');
  if (!wrist) return null;
  const knuckles = [
    context.getJoint('index-finger-metacarpal'),
    context.getJoint('middle-finger-metacarpal'),
    context.getJoint('ring-finger-metacarpal'),
    context.getJoint('pinky-finger-metacarpal'),
  ].filter((joint): joint is THREE.Vector3 => joint !== undefined);
  if (knuckles.length < 2) return null;

  const center = new THREE.Vector3();
  for (const knuckle of knuckles) center.add(knuckle);
  center.multiplyScalar(1 / knuckles.length);
  const axis = center.sub(wrist);
  if (axis.lengthSq() <= 1e-6) return null;
  return axis.normalize();
}

function collectEligibleTail(
  context: HandGestureContext,
  maximumPoseDropoutMs: number,
  createPose: (
    sample: HandGestureContext['samples'][number]
  ) => OscillationPose | null
) {
  const poses: OscillationPose[] = [];
  const latestTimestamp = context.samples.at(-1)?.timestamp;
  let lastAcceptedTimestamp: number | undefined;
  let invalidRunEndTimestamp: number | undefined;
  for (let index = context.samples.length - 1; index >= 0; index--) {
    const sample = context.samples[index];
    const pose = createPose(sample);
    if (!pose) {
      invalidRunEndTimestamp ??= lastAcceptedTimestamp ?? latestTimestamp;
      if (
        invalidRunEndTimestamp !== undefined &&
        invalidRunEndTimestamp - sample.timestamp > maximumPoseDropoutMs
      ) {
        break;
      }
      continue;
    }

    invalidRunEndTimestamp = undefined;
    poses.unshift(pose);
    lastAcceptedTimestamp = sample.timestamp;
  }
  return poses;
}

function unwrapAngles(poses: OscillationPose[]) {
  for (let index = 1; index < poses.length; index++) {
    const previous = poses[index - 1].angle;
    const rawDelta = poses[index].angle - previous;
    poses[index].angle =
      previous + Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta));
  }
}

function findReversals(poses: OscillationPose[], strokeThreshold: number) {
  const reversals: Array<{
    startIndex: number;
    endIndex: number;
    detectionIndex: number;
    amplitude: number;
  }> = [];
  const jitterThreshold = Math.max(
    THREE.MathUtils.degToRad(0.5),
    strokeThreshold * 0.05
  );
  let direction = 0;
  let strokeStartIndex = 0;

  for (let index = 1; index < poses.length; index++) {
    const delta = poses[index].angle - poses[index - 1].angle;
    if (Math.abs(delta) < jitterThreshold) continue;
    const nextDirection = Math.sign(delta);
    if (direction === 0) {
      direction = nextDirection;
      strokeStartIndex = index - 1;
      continue;
    }
    if (nextDirection === direction) continue;

    const endIndex = index - 1;
    const amplitude = Math.abs(
      poses[endIndex].angle - poses[strokeStartIndex].angle
    );
    if (amplitude >= strokeThreshold) {
      reversals.push({
        startIndex: strokeStartIndex,
        endIndex,
        detectionIndex: index,
        amplitude,
      });
      strokeStartIndex = endIndex;
      direction = nextDirection;
    }
  }
  return reversals;
}

function getPeakAngularSpeed(poses: OscillationPose[]) {
  let peak = 0;
  for (let index = 1; index < poses.length; index++) {
    const elapsedSeconds =
      (poses[index].timestamp - poses[index - 1].timestamp) / 1000;
    if (elapsedSeconds <= 0) continue;
    peak = Math.max(
      peak,
      Math.abs(poses[index].angle - poses[index - 1].angle) / elapsedSeconds
    );
  }
  return peak;
}

function getTranslation(poses: OscillationPose[]) {
  if (!poses.length) return 0;
  const origin = poses[0].center;
  const width = average(poses.map((pose) => pose.width));
  if (width <= 1e-6) return Infinity;
  return (
    Math.max(...poses.map((pose) => pose.center.distanceTo(origin))) / width
  );
}

/** @deprecated Use `ShooGestureParameters`. */
export type WaveGestureParameters = ShooGestureParameters;
/** @deprecated Use `DEFAULT_SHOO_GESTURE_PARAMETERS`. */
export const DEFAULT_WAVE_GESTURE_PARAMETERS = DEFAULT_SHOO_GESTURE_PARAMETERS;
/** @deprecated Use `detectShoo`. */
export const detectWave = detectShoo;

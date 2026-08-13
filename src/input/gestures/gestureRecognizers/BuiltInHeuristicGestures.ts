import * as THREE from 'three';

import type {JointName} from '../../Hands';
import {GestureConfiguration} from '../GestureRecognitionOptions';
import type {HandContext, HandGestureContext} from '../GestureTypes';
import {
  FINGER_ORDER,
  average,
  clamp01,
  estimateHandScale,
  getAdjacentFingerSpreads,
  getFingerCurl,
  getFingerJoint,
  getFingerPalmAlignment,
  getFingerSpread,
  getFingerStraightness,
  getFingertipDistance,
  getFingertipPalmDistance,
  getPalmPose,
  getPalmWidth,
  getThumbOpposition,
  getThumbStraightness,
  getThumbVerticalDirection,
} from '../HandPoseMetrics';

const EPSILON = 1e-6;
// Both mirrored simulator hands put a natural thumbs-up this far from world
// up. Compare polar tilt rather than the full world vector so turning around
// in the room does not rotate a valid gesture out of its reference cone.
const SIMULATOR_THUMBS_UP_TILT_DEGREES = 24.32445969031177;

export interface ThumbsUpGestureParameters {
  /** Natural thumb tilt away from world up. */
  preferredThumbTiltDegrees: number;
  /** Maximum angular deviation on either side of the preferred tilt. */
  maximumThumbTiltDeviationDegrees: number;
  minimumThumbStraightness: number;
  /** Minimum closed score required from every non-thumb finger. */
  minimumOtherFingerCurl: number;
  minimumThumbSeparation: number;
  /** Recent history checked before accepting this static pose. */
  motionLookbackMs: number;
  maximumRecentAngularMovementDegrees: number;
  /** Maximum recent palm-center movement, measured in palm widths. */
  maximumRecentTranslation: number;
}

export const DEFAULT_THUMBS_UP_GESTURE_PARAMETERS: Readonly<ThumbsUpGestureParameters> =
  {
    preferredThumbTiltDegrees: SIMULATOR_THUMBS_UP_TILT_DEGREES,
    maximumThumbTiltDeviationDegrees: 20,
    minimumThumbStraightness: 0.7,
    minimumOtherFingerCurl: 0.55,
    minimumThumbSeparation: 0.35,
    motionLookbackMs: 350,
    maximumRecentAngularMovementDegrees: 15,
    maximumRecentTranslation: 0.4,
  };

export function detectPinch(
  context: HandContext,
  config: GestureConfiguration
) {
  const distance = getFingertipDistance(context, 'thumb', 'index');
  if (distance === null || !Number.isFinite(distance)) return undefined;

  const scale = getPalmWidth(context) ?? estimateHandScale(context);
  if (scale < EPSILON) return {confidence: 0};

  const threshold = Math.max(config.threshold ?? 0, scale * 0.32, 0.025);
  const distanceScore = clamp01(
    (threshold * 1.8 - distance) / (threshold * 1.2)
  );
  const supportExtension = average(
    (['middle', 'ring', 'pinky'] as const).map((finger) =>
      getFingerStraightness(context, finger)
    )
  );
  const supportPenalty = clamp01((supportExtension - 0.55) / 0.45);
  const confidence = clamp01(distanceScore * (1 - supportPenalty * 0.35));

  return {
    confidence,
    data: {distance, threshold, supportPenalty},
  };
}

export function detectOpenPalm(
  context: HandContext,
  config: GestureConfiguration
) {
  const straightnessScores = FINGER_ORDER.map((finger) =>
    getFingerStraightness(context, finger)
  );
  const extensionScores = FINGER_ORDER.map((finger) =>
    getFingerExtensionScore(context, finger)
  );
  const straightness = average(straightnessScores);
  const extension = average(extensionScores);
  const allFingersStraight = Math.min(...straightnessScores);
  const allFingersExtended = Math.min(...extensionScores);
  const palmAlignment = average(
    FINGER_ORDER.map((finger) => getFingerPalmAlignment(context, finger))
  );
  const spread = getTipSpreadScore(context);
  const openGate = Math.min(allFingersStraight, allFingersExtended);

  const confidence = clamp01(
    openGate *
      (straightness * 0.3 +
        extension * 0.35 +
        spread * 0.15 +
        palmAlignment * 0.2)
  );

  return {
    confidence,
    data: {
      straightness,
      extension,
      allFingersStraight,
      allFingersExtended,
      openGate,
      palmAlignment,
      spread,
      threshold: config.threshold,
    },
  };
}

export function detectFist(context: HandContext, config: GestureConfiguration) {
  const closedScores = FINGER_ORDER.map((finger) =>
    getFingerClosedScore(context, finger)
  );
  const closed = average(closedScores);
  const scale = getPalmWidth(context) ?? estimateHandScale(context);
  const palmDistances = FINGER_ORDER.map((finger) =>
    getFingertipPalmDistance(context, finger)
  ).filter((distance): distance is number => distance !== null);
  const palmDistanceAverage = average(palmDistances);
  const palmDistanceScore =
    scale > EPSILON ? clamp01(1 - palmDistanceAverage / (scale * 1.35)) : 0;
  const thumbWrap = Math.max(
    getThumbOpposition(context, 'index'),
    getThumbOpposition(context, 'middle')
  );
  const thumbStraightness = getThumbStraightness(context);
  const thumbVertical = getThumbVerticalDirection(context);
  const verticalThumbPenalty =
    thumbStraightness * clamp01((Math.abs(thumbVertical) - 0.25) / 0.5);

  const baseConfidence = clamp01(
    closed * 0.7 + palmDistanceScore * 0.2 + thumbWrap * 0.1
  );
  const confidence = clamp01(
    baseConfidence * (1 - verticalThumbPenalty * 0.85)
  );

  return {
    confidence,
    data: {
      closed,
      palmDistanceScore,
      thumbWrap,
      thumbStraightness,
      thumbVertical,
      verticalThumbPenalty,
      threshold: config.threshold,
    },
  };
}

export function detectThumbsUp(
  context: HandContext,
  config: GestureConfiguration<ThumbsUpGestureParameters>
) {
  const parameters = {
    ...DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
    ...config.parameters,
  };
  const trackingValid = hasCompleteThumbsUpTracking(context);
  const recentMotion = getRecentHandMotion(
    context,
    parameters.motionLookbackMs
  );
  const thumbStraightness = getThumbStraightness(context);
  const thumbVerticalDirection = getThumbVerticalDirection(context);
  const thumbTiltDegrees = THREE.MathUtils.radToDeg(
    Math.acos(THREE.MathUtils.clamp(thumbVerticalDirection, -1, 1))
  );
  const thumbTiltDeviationDegrees = Math.abs(
    thumbTiltDegrees - parameters.preferredThumbTiltDegrees
  );
  const thumbVertical = clamp01((thumbVerticalDirection - 0.35) / 0.5);
  const otherCurlScores = FINGER_ORDER.map((finger) =>
    getFingerClosedScore(context, finger)
  );
  const otherCurl = average(otherCurlScores);
  const allOtherFingersClosed = Math.min(...otherCurlScores);
  const indexDistance = getFingertipDistance(context, 'thumb', 'index');
  const scale = getPalmWidth(context) ?? estimateHandScale(context);
  const separation =
    indexDistance !== null && scale > EPSILON
      ? clamp01((indexDistance - scale * 0.65) / (scale * 0.5))
      : 0;
  const thumbWrapPenalty = Math.max(
    getThumbOpposition(context, 'index'),
    getThumbOpposition(context, 'middle')
  );
  const thumbPose = thumbStraightness * thumbVertical;

  const directionValid =
    thumbTiltDeviationDegrees <= parameters.maximumThumbTiltDeviationDegrees;
  const motionValid =
    recentMotion.angularMovementDegrees <=
      parameters.maximumRecentAngularMovementDegrees &&
    recentMotion.translation <= parameters.maximumRecentTranslation;
  const poseValid =
    trackingValid &&
    motionValid &&
    directionValid &&
    thumbStraightness >= parameters.minimumThumbStraightness &&
    allOtherFingersClosed >= parameters.minimumOtherFingerCurl &&
    separation >= parameters.minimumThumbSeparation;
  const confidence = poseValid
    ? clamp01(
        thumbPose *
          (otherCurl * 0.45 + separation * 0.35 + (1 - thumbWrapPenalty) * 0.2)
      )
    : 0;

  return {
    confidence,
    data: {
      thumbStraightness,
      thumbVertical,
      thumbVerticalDirection,
      thumbTiltDegrees,
      thumbTiltDeviationDegrees,
      directionValid,
      trackingValid,
      motionValid,
      recentAngularMovement: recentMotion.angularMovementDegrees,
      recentTranslation: recentMotion.translation,
      poseValid,
      otherCurl,
      allOtherFingersClosed,
      separation,
      thumbWrapPenalty,
      threshold: config.threshold,
    },
  };
}

function getRecentHandMotion(context: HandContext, lookbackMs: number) {
  if (!hasGestureHistory(context) || context.samples.length < 2) {
    return {angularMovementDegrees: 0, translation: 0};
  }

  const currentPalm = getPalmPose(context);
  const latestTimestamp = context.samples.at(-1)!.timestamp;
  if (!currentPalm) {
    return {angularMovementDegrees: Infinity, translation: Infinity};
  }

  let angularMovement = 0;
  let translation = 0;
  for (const sample of context.samples) {
    if (sample.timestamp < latestTimestamp - Math.max(0, lookbackMs)) continue;
    const palm = getPalmPose(sample);
    if (!palm) continue;
    angularMovement = Math.max(
      angularMovement,
      currentPalm.normal.angleTo(palm.normal),
      currentPalm.right.angleTo(palm.right),
      currentPalm.up.angleTo(palm.up)
    );
    translation = Math.max(
      translation,
      currentPalm.center.distanceTo(palm.center) /
        Math.max(currentPalm.width, EPSILON)
    );
  }

  return {
    angularMovementDegrees: THREE.MathUtils.radToDeg(angularMovement),
    translation,
  };
}

function hasGestureHistory(
  context: HandContext
): context is HandGestureContext {
  return 'samples' in context && Array.isArray(context.samples);
}

function hasCompleteThumbsUpTracking(context: HandContext) {
  const thumbTracked = [
    'thumb-metacarpal',
    'thumb-phalanx-proximal',
    'thumb-phalanx-distal',
    'thumb-tip',
  ].every((joint) => context.getJoint(joint as JointName));
  const fingerSuffixes = [
    'metacarpal',
    'phalanx-proximal',
    'phalanx-intermediate',
    'phalanx-distal',
    'tip',
  ];
  const fingersTracked = FINGER_ORDER.every((finger) =>
    fingerSuffixes.every((suffix) => getFingerJoint(context, finger, suffix))
  );
  return thumbTracked && fingersTracked;
}

export function detectThumbsDown(
  context: HandContext,
  config: GestureConfiguration
) {
  const thumbStraightness = getThumbStraightness(context);
  const thumbVertical = clamp01(
    (-getThumbVerticalDirection(context) - 0.35) / 0.5
  );
  const otherCurl = average(
    FINGER_ORDER.map((finger) => getFingerClosedScore(context, finger))
  );
  const indexDistance = getFingertipDistance(context, 'thumb', 'index');
  const scale = getPalmWidth(context) ?? estimateHandScale(context);
  const separation =
    indexDistance !== null && scale > EPSILON
      ? clamp01((indexDistance - scale * 0.65) / (scale * 0.5))
      : 0;
  const thumbWrapPenalty = Math.max(
    getThumbOpposition(context, 'index'),
    getThumbOpposition(context, 'middle')
  );
  const thumbPose = thumbStraightness * thumbVertical;

  const confidence = clamp01(
    thumbPose *
      (otherCurl * 0.45 + separation * 0.35 + (1 - thumbWrapPenalty) * 0.2)
  );

  return {
    confidence,
    data: {
      thumbStraightness,
      thumbVertical,
      otherCurl,
      separation,
      thumbWrapPenalty,
      threshold: config.threshold,
    },
  };
}

export function detectPoint(
  context: HandContext,
  config: GestureConfiguration
) {
  const indexStraightness = getFingerStraightness(context, 'index');
  const indexAlignment = getFingerPalmAlignment(context, 'index');
  const indexExtension = getFingerExtensionScore(context, 'index');
  const middleClosed = getFingerClosedScore(context, 'middle');
  const ringClosed = getFingerClosedScore(context, 'ring');
  const pinkyClosed = getFingerClosedScore(context, 'pinky');
  const otherCurl = average([middleClosed, ringClosed, pinkyClosed]);
  const allOtherFingersClosed = Math.min(middleClosed, ringClosed, pinkyClosed);
  const indexPose = average([
    indexStraightness,
    indexExtension,
    Math.max(indexAlignment, 0.5),
  ]);

  const confidence = clamp01(
    indexPose * (otherCurl * 0.65 + allOtherFingersClosed * 0.35)
  );

  return {
    confidence,
    data: {
      indexStraightness,
      indexExtension,
      indexAlignment,
      otherCurl,
      allOtherFingersClosed,
      threshold: config.threshold,
    },
  };
}

function getFingerClosedScore(
  context: HandContext,
  finger: (typeof FINGER_ORDER)[number]
) {
  return Math.max(
    getFingerCurl(context, finger),
    1 - getFingerExtensionScore(context, finger)
  );
}

function getFingerExtensionScore(
  context: HandContext,
  finger: (typeof FINGER_ORDER)[number]
) {
  const distance = getFingertipPalmDistance(context, finger);
  const scale = getPalmWidth(context) ?? estimateHandScale(context);
  if (distance === null || scale < EPSILON) return 0;
  return clamp01((distance - scale * 0.45) / (scale * 0.85));
}

export function detectSpread(
  context: HandContext,
  config: GestureConfiguration
) {
  const straightnessScores = FINGER_ORDER.map((finger) =>
    getFingerStraightness(context, finger)
  );
  const extensionScores = FINGER_ORDER.map((finger) =>
    getFingerExtensionScore(context, finger)
  );
  const straightness = average(straightnessScores);
  const extension = average(extensionScores);
  const allFingersStraight = Math.min(...straightnessScores);
  const allFingersExtended = Math.min(...extensionScores);
  const adjacentSpreads = getAdjacentFingerSpreads(context);
  const directionSpread = average(Object.values(adjacentSpreads));
  const tipSpread = getTipSpreadScore(context);
  const spread = Math.max(directionSpread, tipSpread);
  const palmAlignment = average(
    FINGER_ORDER.map((finger) => getFingerPalmAlignment(context, finger))
  );
  const indexPinkySpread = getFingerSpread(context, 'index', 'pinky');
  const openGate = average([allFingersStraight, allFingersExtended]);

  const confidence = clamp01(
    openGate *
      (straightness * 0.2 +
        extension * 0.2 +
        spread * 0.45 +
        Math.max(indexPinkySpread, palmAlignment) * 0.15)
  );

  return {
    confidence,
    data: {
      straightness,
      extension,
      allFingersStraight,
      allFingersExtended,
      openGate,
      spread,
      indexPinkySpread,
      palmAlignment,
      threshold: config.threshold,
    },
  };
}

function getTipSpreadScore(context: HandContext) {
  const scale = getPalmWidth(context) ?? estimateHandScale(context);
  if (scale < EPSILON) return 0;

  const distances = [
    getFingertipDistance(context, 'index', 'middle'),
    getFingertipDistance(context, 'middle', 'ring'),
    getFingertipDistance(context, 'ring', 'pinky'),
  ].filter((distance): distance is number => distance !== null);

  if (!distances.length) return 0;
  return clamp01((average(distances) - scale * 0.25) / (scale * 0.45));
}

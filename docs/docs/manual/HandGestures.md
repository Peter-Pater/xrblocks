---
sidebar_position: 7
title: Hand Gestures
---

# Hand Gestures

XR Blocks gesture recognition is split into two explicit layers:

```txt
PoseEstimator -> HandGestureContext -> GestureRecognizer -> gesture events
```

A `PoseEstimator` converts a source of hand pose data into the SDK's canonical
`HandContext`. `GestureRecognition` clones timestamped joint snapshots into a
rolling history and passes a `HandGestureContext` to the recognizer. The runtime
handles sampling, history lifecycle, confidence thresholds, and events; gesture
meaning remains entirely inside registered recognizers.

The default setup is:

```txt
WebXRHandPoseEstimator -> HandGestureContext -> HeuristicGestureRecognizer
```

## Quick Start

```js
import * as xb from 'xrblocks';

const options = new xb.Options();
options.enableGestures();

// Built-in heuristic gestures are registered by default.
options.gestures.minimumConfidence = 0.6;
options.gestures.setGestureEnabled('point', true);
options.gestures.setGestureEnabled('spread', true);
options.gestures.setGestureEnabled('shoo', true); // temporal and opt-in
options.gestures.setGestureEnabled('beckon', true); // temporal and opt-in

await xb.init(options);
```

Listen for events from `xb.core.gestureRecognition`:

```js
class GestureLogger extends xb.Script {
  init() {
    const gestures = xb.core.gestureRecognition;
    if (!gestures) return;

    gestures.addEventListener('gesturestart', (event) => {
      const {hand, name, confidence} = event.detail;
      console.log(`${hand} started ${name}: ${confidence.toFixed(2)}`);
    });

    gestures.addEventListener('gestureend', (event) => {
      console.log(`${event.detail.hand} ended ${event.detail.name}`);
    });
  }
}
```

## Core Interfaces

These are the shapes a custom implementation should follow.

```ts
interface HandContext {
  handedness: xb.Handedness;
  handLabel: 'left' | 'right';
  joints: Map<xb.JointName, THREE.Vector3>;
  getJoint(jointName: xb.JointName): THREE.Vector3 | undefined;
}

interface HandPoseSample extends HandContext {
  readonly timestamp: number;
}

interface HandGestureContext extends HandContext {
  readonly samples: readonly HandPoseSample[];
}
```

`joints` should contain canonical XR Blocks/WebXR-style joint names from
`xb.HAND_JOINT_NAMES`. Positions are in world space. The history contains
cloned snapshots, so later pose-estimator mutation cannot change earlier
samples.

```ts
interface PoseEstimator {
  init?(dependencies?: {user?: xb.User}): Promise<void>;
  getHandContext(handedness: xb.Handedness): HandContext | null;
  getHandContexts(): Partial<Record<'left' | 'right', HandContext>>;
  dispose?(): void;
}

type GestureScoreMap = Record<
  string,
  {confidence: number; data?: Record<string, unknown>} | undefined
>;

interface GestureRecognizer {
  init?(): Promise<void>;
  recognize(
    context: HandGestureContext
  ): GestureScoreMap | Promise<GestureScoreMap>;
  getGestureConfigurations?(): Record<
    string,
    {enabled: boolean; threshold?: number; parameters?: object}
  >;
  setGestureConfig?(name: string, config: GestureConfiguration): void;
  dispose?(): void;
}
```

`GestureRecognition` calls the configured pose estimator for each hand, passes
each available `HandContext` to the configured gesture recognizer, and emits
events for configured gestures whose confidence is at least
`options.gestures.minimumConfidence`.

## Gesture Options

```js
const options = new xb.Options();
options.enableGestures();

options.gestures.minimumConfidence = 0.7;
options.gestures.updateIntervalMs = 33;
options.gestures.historyDurationMs = 1500;
options.gestures.maximumSampleGapMs = 250;

options.gestures.setPoseEstimator(new xb.WebXRHandPoseEstimator());
options.gestures.setGestureRecognizer(new xb.HeuristicGestureRecognizer());

options.gestures.setGestureEnabled('point', true);
options.gestures.setGestureConfig('pinch', {
  enabled: true,
  threshold: 0.025,
});
```

History is independent for each hand and pruned to `historyDurationMs`.
Tracking loss or a gap larger than `maximumSampleGapMs` clears that hand's
history. Results from an asynchronous recognizer are discarded if they finish
after such a reset.

`setGestureConfig()` deep-merges `parameters`, so an application can tune one
detector value without copying its implementation or replacing sibling values.

Gesture names are strings. They are not limited to built-ins. The gesture
catalogue is initialized from
`gestureRecognizer.getGestureConfigurations?.()`, then any explicit
`setGestureConfig` or `setGestureEnabled` calls override those defaults.

## Heuristic Gesture Registration

`HeuristicGestureRecognizer` is the simplest way to add a custom gesture. It
accepts detector functions at initialization time:

```js
const recognizer = new xb.HeuristicGestureRecognizer();

recognizer.registerGesture(
  'victory',
  (context, config) => {
    const indexStraight = xb.getFingerStraightness(context, 'index');
    const middleStraight = xb.getFingerStraightness(context, 'middle');
    const ringCurl = xb.getFingerCurl(context, 'ring');
    const pinkyCurl = xb.getFingerCurl(context, 'pinky');
    const spread = xb.getFingerSpread(context, 'index', 'middle');

    const confidence = xb.clamp01(
      xb.average([indexStraight, middleStraight]) *
        xb.average([ringCurl, pinkyCurl, spread])
    );

    return {
      confidence,
      data: {
        indexStraight,
        middleStraight,
        ringCurl,
        pinkyCurl,
        spread,
      },
    };
  },
  {enabled: true}
);

options.gestures.setGestureRecognizer(recognizer);
```

Use `new xb.HeuristicGestureRecognizer(false)` when you want only your custom
registrations and no built-in gestures.

```js
const recognizer = new xb.HeuristicGestureRecognizer(false)
  .registerGesture('my-temporal-gesture', detectMyTemporalGesture)
  .registerGesture('pinch-ish', detectPinchish);
```

The current built-in heuristic names are:

```txt
pinch
open-palm
fist
thumbs-up
thumbs-down
point
spread
shoo
beckon
```

`point`, `spread`, `shoo`, and `beckon` are registered disabled by default;
enable them by name if you want them emitted.

`thumbs-up` uses the simulator's natural pose as its mean: the thumb sits about
24.3 degrees away from world up. The left and right poses mirror horizontally
but share that polar tilt, so the detector compares tilt rather than a fixed
world-space direction (turning around must not invalidate the gesture). The
default gate allows 20 degrees on either side of the mean and is configurable
without replacing the detector:

```ts
options.gestures.setGestureConfig<xb.ThumbsUpGestureParameters>('thumbs-up', {
  parameters: {
    preferredThumbTiltDegrees: 24.3,
    maximumThumbTiltDeviationDegrees: 20,
    minimumThumbStraightness: 0.75,
    minimumOtherFingerCurl: 0.6,
    minimumThumbSeparation: 0.4,
    motionLookbackMs: 350,
    maximumRecentAngularMovementDegrees: 15,
    maximumRecentTranslation: 0.4,
  },
});
```

When timestamped history is available, `thumbs-up` also rejects recent palm
rotation or translation. This keeps a wave or beckon from being classified as
thumbs-up merely because one frame passes through the static pose. Direct calls
with only a `HandContext` retain immediate static-pose behavior.

## Static and Temporal Semantics

Static detectors score the current pose and normally produce `gesturestart`
when the pose is entered, `gestureupdate` while it is held, and `gestureend`
when it is released. Existing static detectors can treat `HandGestureContext`
as a `HandContext` and need no changes.

Recognition is mutually exclusive per hand. If multiple enabled detectors pass
the confidence threshold on the same evaluation, only the highest-confidence
result is published. When that winner changes, its `gestureend` is emitted
before the new winner's `gesturestart`. The other hand is evaluated
independently and may publish its own gesture at the same time.

Temporal detectors inspect `context.samples` and typically return confidence
only after a motion completes. They should hold a completed result briefly so
the shared event pipeline emits one `gesturestart`, followed by updates if the
hold spans another evaluation, and then the normal `gestureend`.

### Built-in Shoo and Come Here

The opt-in `shoo` detects an open palm whose wrist-to-fingers axis is roughly
horizontal while the wrist rotates side to side. The opt-in `beckon` uses the
wrist-to-knuckle-center axis, so extended, curled, and closed fingers all work.
It detects that axis rocking away from and back toward upright, independent of
the hand's yaw or which way the palm faces. Both require qualifying reversals
and reject one-way turns, slow motion, and excessive palm-center translation.
Beckon also rejects poses that strongly match the built-in thumbs-up detector.

```ts
options.gestures.setGestureEnabled('shoo', true);
options.gestures.setGestureConfig<xb.ShooGestureParameters>('shoo', {
  threshold: THREE.MathUtils.degToRad(18),
  parameters: {
    reversalCount: 3,
    maximumTranslation: 0.5,
    maximumPoseDropoutMs: 120,
    detectionHoldMs: 220,
  },
});

options.gestures.setGestureEnabled('beckon', true);
options.gestures.setGestureConfig<xb.BeckonGestureParameters>('beckon', {
  threshold: THREE.MathUtils.degToRad(6),
  parameters: {
    reversalCount: 1,
    verticalToleranceDegrees: 65,
    maximumThumbsUpConfidence: 0.5,
    minimumAngularSpeedDegreesPerSecond: 4,
    maximumPoseDropoutMs: 600,
    detectionHoldMs: 500,
    continuationWindowMs: 400,
    minimumContinuationDegrees: 1.5,
  },
});
```

The default stroke threshold is 15 degrees. Parameters also cover minimum and
maximum duration, orientation tolerance, angular speed, and detection hold
time. `shoo` additionally gates palm openness; `beckon` deliberately does not.
`beckon` also has no viewer-position or palm-facing dependency.
`maximumPoseDropoutMs` lets a detector bridge a brief run of noisy or
ineligible poses without joining distinct motions;
`continuationWindowMs` and `minimumContinuationDegrees` keep an already
completed temporal gesture active while fresh motion continues, without
extending its inactive tail;
`maximumTranslation` is measured in average palm widths. Diagnostics report
`duration`, `reversals`, `amplitude` (degrees), `peakAngularSpeed`
(degrees/second), `openness`, orientation alignment, and `translation` (palm
widths).

The former `detectWave`, `WaveGestureParameters`, and
`DEFAULT_WAVE_GESTURE_PARAMETERS` exports remain as deprecated aliases for the
`shoo` implementation, but the registered built-in gesture name is `shoo`.

### Complete Custom Temporal Gesture

This detector recognizes a steady open palm held for a configurable duration.
It lives in application code and needs no runtime changes or reserved name.

```ts
interface SteadyPalmParameters {
  holdDurationMs: number;
  minimumOpenness: number;
  maximumTravel: number;
}

const detectSteadyPalm: xb.HeuristicGestureDetector<SteadyPalmParameters> = (
  context,
  config
) => {
  const parameters = config.parameters!;
  const eligible = [];

  for (let index = context.samples.length - 1; index >= 0; index--) {
    const sample = context.samples[index];
    const openness = xb.detectOpenPalm(sample, {enabled: true}).confidence;
    const palm = xb.getPalmPose(sample);
    if (!palm || openness < parameters.minimumOpenness) break;
    eligible.unshift({sample, palm, openness});
  }
  if (eligible.length < 2) return {confidence: 0};

  const duration =
    eligible.at(-1)!.sample.timestamp - eligible[0].sample.timestamp;
  const width = xb.average(eligible.map(({palm}) => palm.width));
  const travel =
    Math.max(
      ...eligible.map(({palm}) =>
        palm.center.distanceTo(eligible[0].palm.center)
      )
    ) / width;
  const openness = xb.average(eligible.map((pose) => pose.openness));

  return {
    confidence:
      duration >= parameters.holdDurationMs &&
      travel <= parameters.maximumTravel
        ? openness
        : 0,
    data: {duration, openness, translation: travel},
  };
};

const recognizer =
  new xb.HeuristicGestureRecognizer().registerGesture<SteadyPalmParameters>(
    'steady-palm',
    detectSteadyPalm,
    {
      enabled: true,
      parameters: {
        holdDurationMs: 650,
        minimumOpenness: 0.65,
        maximumTravel: 0.35,
      },
    }
  );

options.gestures.setGestureRecognizer(recognizer);
options.gestures.setGestureConfig<SteadyPalmParameters>('steady-palm', {
  parameters: {holdDurationMs: 800},
});
```

## Hand Pose Helpers

All helpers are exported from `xrblocks` and operate on `HandContext`.

Joint access and palm pose:

```txt
getJoint(context, jointName)
getFingerJoint(context, finger, suffix)
estimateHandScale(context)
getPalmWidth(context)
getPalmNormal(context)
getPalmRight(context)
getPalmUp(context)
getPalmPose(context)
```

Finger and thumb features:

```txt
getFingerBendAngles(context, finger)
getFingerStraightness(context, finger)
getFingerCurl(context, finger)
getFingerDirection(context, finger)
getFingerPalmAlignment(context, finger)
getFingerSpread(context, fingerA, fingerB)
getAdjacentFingerSpreads(context)
getThumbBendAngles(context)
getThumbStraightness(context)
getThumbCurl(context)
getThumbDirection(context)
getThumbOpposition(context, finger)
getThumbVerticalDirection(context)
getFingertipDistance(context, digitA, digitB)
getFingertipPalmDistance(context, digit)
```

Feature-vector helpers for ML/custom models:

```txt
getBoneVectors(context)
getRelativeBoneAngles(context)
```

Utility helpers:

```txt
average(values)
clamp01(value)
```

Finger names are `index`, `middle`, `ring`, and `pinky`. Digit names are
`thumb`, `index`, `middle`, `ring`, and `pinky`.

## Custom Gesture Recognizer

Use a custom `GestureRecognizer` when your recognizer owns its own model or
wants to score several gestures together.

```js
class CustomGestureRecognizer {
  async init() {
    this.model = await loadMyModel();
  }

  getGestureConfigurations() {
    return {
      rock: {enabled: true},
      shaka: {enabled: true},
      victory: {enabled: true},
    };
  }

  recognize(context) {
    const features = xb.getRelativeBoneAngles(context);
    const result = runModel(this.model, features);

    return {
      rock: {confidence: result.rock},
      shaka: {confidence: result.shaka},
      victory: {confidence: result.victory},
    };
  }
}

options.gestures.setGestureRecognizer(new CustomGestureRecognizer());
```

Recognizers may return a `Promise<GestureScoreMap>`. The SDK stores the latest
completed async result for each hand, keeps update frames moving, and prevents
results from an older tracking generation from being published.

## Custom Pose Estimator

Use a custom `PoseEstimator` when your pose data does not come from
`xb.user.hands`. For example, a webcam or ML landmark model can be adapted into
the canonical `HandContext`.

```js
class WebcamPoseEstimator {
  async init() {
    this.video = document.querySelector('video');
    this.detector = await createWebcamHandDetector();
  }

  getHandContext(handedness) {
    if (handedness !== xb.Handedness.RIGHT) return null;

    const landmarks = this.detector.latestLandmarks;
    if (!landmarks) return null;

    const joints = new Map();
    joints.set('wrist', toVector3(landmarks[0]));
    joints.set('thumb-metacarpal', toVector3(landmarks[1]));
    joints.set('thumb-phalanx-proximal', toVector3(landmarks[2]));
    joints.set('thumb-phalanx-distal', toVector3(landmarks[3]));
    joints.set('thumb-tip', toVector3(landmarks[4]));
    // Continue mapping to every name in xb.HAND_JOINT_NAMES.

    return {
      handedness,
      handLabel: 'right',
      joints,
      getJoint: (jointName) => joints.get(jointName),
    };
  }

  getHandContexts() {
    return {
      right: this.getHandContext(xb.Handedness.RIGHT) ?? undefined,
    };
  }
}

options.gestures.setPoseEstimator(new WebcamPoseEstimator());
```

When adapting MediaPipe-style 21-landmark hands, map source landmarks into the
XR Blocks joint names. If the source model does not expose a joint exactly,
estimate it consistently. For example, MediaPipe does not separately expose the
four finger metacarpals in the same way WebXR does, so a demo can approximate
them between the wrist and each finger's MCP landmark.

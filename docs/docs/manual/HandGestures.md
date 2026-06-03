---
sidebar_position: 11
---

# Hand Gestures

XR Blocks ships with an opt-in gesture recognition subsystem powered by the
`GestureRecognition` script. When enabled, a pose estimator produces canonical
hand contexts, a gesture recognizer scores named gestures, and the SDK emits
high-level gesture events that any script can subscribe to.

## Enabling the gesture subsystem

Call `options.enableGestures()` before `xb.init()` to toggle on hand tracking
and the shared recogniser. You can swap the pose estimator or gesture
recognizer, tune the confidence threshold, and toggle gesture names from the
same options object.

```js
import * as xb from 'xrblocks';

const options = new xb.Options();
options.enableGestures();
options.gestures.minimumConfidence = 0.7; // default is 0.6
options.gestures.setGestureEnabled('point', true);
options.gestures.setGestureEnabled('spread', true);

xb.init(options);
```

The `gestures` options bag is fully mergeable, so you can supply the same fields
when instantiating `new xb.Options({...})` if you prefer declarative
configuration.

The default setup is equivalent to:

```txt
WebXRHandPoseEstimator -> HandContext -> HeuristicGestureRecognizer
```

Custom gesture recognizers can be swapped in at init time as long as they
consume `HandContext` and return a map of gesture names to confidence scores.
MediaPipe and TensorFlow pose estimator classes are present as templates for
future canonical pose adapters.

## Listening for gesture events

Once the runtime is initialised, the recogniser is exposed at
`xb.core.gestureRecognition`. Subscribe to `gesturestart`, `gestureupdate`, and
`gestureend` events to drive game logic or debugging output.

```js
import * as xb from 'xrblocks';

class GestureDebugger extends xb.Script {
  init() {
    const gestures = xb.core.gestureRecognition;
    if (!gestures) return;
    const log = (phase, {hand, name, confidence = 0}) =>
      console.log(
        `[gesture] ${hand} hand ${name} ${phase} ` +
          `(${confidence.toFixed(2)})`
      );
    gestures.addEventListener('gesturestart', (event) =>
      log('start', event.detail)
    );
    gestures.addEventListener('gestureupdate', (event) =>
      log('update', event.detail)
    );
    gestures.addEventListener('gestureend', (event) =>
      log('end', event.detail)
    );
  }
}
```

Remember to remove listeners in `dispose()` if you manually manage the script’s
lifecycle.

## Heuristic testing template

The repository includes `templates/heuristic_hand_gestures`, which configures
the heuristic gesture recognizer and logs every gesture’s start/end phases to
the console. It is handy for validating pinch, open-palm, fist, thumbs-up,
thumbs-down, point, and spread recognition on Quest or in the desktop simulator.

If you need deeper insight, consider piping the event data into your own UI or
telemetry system.

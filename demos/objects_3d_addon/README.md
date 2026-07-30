# 3D Object Boxes (Addon)

Minimal page that exercises the `objects3d` **addon** (`Object3DDetector`)
rather than an inline copy of the pipeline. This is the page to deploy when
verifying the addon itself on a headset — the sibling
[`objects_3d`](../objects_3d/) demo is self-contained and does not import the
addon.

The whole integration is three lines:

```js
const detector = new Object3DDetector({showDebugBoxes: true});
xb.add(detector);
const objects = await detector.detect();
```

## Setup

Needs a Gemini API key. Create `keys.json` in this directory (gitignored):

```json
{"gemini": {"apiKey": "YOUR_KEY"}}
```

Then serve the repo (`npm run dev` from the repo root) and open
`http://localhost:8080/demos/objects_3d_addon/`.

Press **Detect** on desktop; in immersive XR the DOM panel is hidden, so
**pinch / pull the controller trigger** to run a detection. Boxes appear as
per-category coloured wireframes with labels.

To skip the key entirely, switch to the on-device detector:
`new Object3DDetector({detectBackend: 'mediapipe', maskBackend: 'mediapipe'})`
— fixed COCO class set, no network.

## Tuning for a real room

The fitter defaults are tuned for the simulator's cabin scene. On a headset,
pass bounds that match the real space:

```js
new Object3DDetector({
  showDebugBoxes: true,
  roomHalf: 4, // walls at x/z = ±4 m
  sceneBounds: {maxXZ: 8, minY: -1, maxY: 5}, // reject boxes outside this
  maxRayDistance: 12,
});
```

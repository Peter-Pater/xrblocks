# 3D Object Boxes (Addon)

Debug harness for the `objects3d` **addon** (`Object3DDetector`), as opposed to
an inline copy of the pipeline. This is the page to deploy when verifying the
addon itself on a headset — the sibling [`objects_3d`](../objects_3d/) demo is
self-contained and does not import the addon.

The integration itself is still three lines:

```js
const detector = new Object3DDetector({showDebugBoxes: true});
xb.add(detector);
const objects = await detector.detect();
```

Everything else on the page is the debug panel.

## Setup

Needs a Gemini API key. Create `keys.json` in this directory (gitignored):

```json
{"gemini": {"apiKey": "YOUR_KEY"}}
```

Then serve the repo (`npm run dev` from the repo root) and open
`http://localhost:8080/demos/objects_3d_addon/`.

To skip the key entirely, switch the detector picker to `mediapipe` (fixed COCO
class set, no network).

## The debug panel

The same controls exist twice: as a DOM panel for desktop, and as a draggable
spatial panel for immersive XR, where the DOM is invisible. In XR the panel is
the only way to trigger a detection — pinch is deliberately not bound, so
grabbing and dragging the panel cannot fire one by accident.

**Actions** — `detect`, `clear`, and `copy`, which puts the full diagnostics
record on the clipboard as JSON and logs it to the console.

**Camera rotation offset** (`yaw` / `pitch` / `roll`, ±5° per press) applies
**live** to the next detection — no reload. This is the knob for nulling out a
constant calibration error between the SDK's estimated passthrough-camera
extrinsics and the actual hardware. Also available as `?camYawDeg=-30` etc.

**Toggles that reload the page**, because they must be set before `xb.init()`:

| Control        | Query param         | What it does                                                               |
| -------------- | ------------------- | -------------------------------------------------------------------------- |
| `matchDepth`   | `?matchDepthView=1` | Ask the platform for view-aligned depth instead of raw depth-sensor frames |
| `fullResDepth` | `?fullResDepth=1`   | Rebuild the full-resolution depth mesh every frame (see below)             |
| `detector`     | `?backend=`         | `gemini` / `mediapipe` / `both`                                            |
| `mask`         | `?mask=`            | `slimsam` / `mediapipe`                                                    |

**Diagnostics**, refreshed after each detection (4 Hz in XR):

| Row             | Why it matters                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame latency` | Age of the captured video frame. Large values mean the pixels predate the pose, which rotates every box by the head motion in between. Under ~150 ms is healthy. |
| `pose match`    | How close the pose we paired with the frame was to the frame's capture time.                                                                                     |
| `camera model`  | `device` means the SDK passthrough-camera model; `RENDER (fallback)` means the old, wrong-FOV path — a red flag on device.                                       |
| `depth remap`   | Whether the platform's view→depth-buffer UV remap is the identity.                                                                                               |
| `depth vs eye`  | Angle between the depth camera's reported orientation and the left eye's.                                                                                        |
| `rejections`    | Which sanity gate discarded detections (`farFromRoom` usually means the room-scale defaults need tuning).                                                        |
| `timings`       | Per-stage wall clock, so you can see whether a slow detect is Gemini, SAM, or geometry.                                                                          |

## Diagnosing a coherent rotation error

If every box from one detection lands rotated by roughly the same angle, run one
detection while holding your head **perfectly still for ~2 seconds**, then one
while turning your head:

- **Rotation gone when still** → the captures were pairing fresh tracking poses
  with stale video frames. The pipeline now waits for a fresh frame and pairs the
  capture with the pose at the frame's `captureTime`; check `frame latency`.
- **Rotation identical in both** (same axis, same angle) → a constant
  calibration error. Null it with the yaw/pitch/roll buttons, then bake the
  value into `cameraRotationOffset`.
- **`depth vs eye` is large** → try `matchDepth`. If that removes the rotation,
  the depth mesh (the surface every ray lands on) was the rotated ingredient,
  not the RGB camera model.

## Why this page runs faster than `objects_3d`

Two differences, one of which dominates:

1. **Per-frame full-resolution depth mesh.** `objects_3d` sets
   `options.depth.depthMesh.updateFullResolutionGeometry = true`, so every
   depth frame unprojects the full 154×154 grid — ~23.7k vertices, each a
   `Matrix4` transform plus a divide — on the main thread, on top of the 40×40
   downsampled mesh the SDK always maintains. This page leaves it `false` and
   instead calls `depth.updateFullResolutionDepthMesh()` once inside
   `detect()`, paying that cost per detection rather than per frame. Flip
   `fullResDepth` on to confirm: the frame rate should drop to match
   `objects_3d`.
2. **Spatial UI.** `objects_3d` also calls `options.enableUI()` for its panel,
   which brings in uikit/yoga layout and MSDF text rendering. This page now
   does too, for the debug panel — so this difference has gone away, and any
   remaining gap is item 1.

Neither affects correctness, only frame rate. If you want the fastest possible
page for a pure accuracy test, drop the panel and leave `fullResDepth` off.

## Tuning for a real room

The fitter defaults are tuned for the simulator's cabin scene. On a headset,
pass bounds that match the real space:

```js
new Object3DDetector({
  showDebugBoxes: true,
  roomHalf: 4, // walls at x/z = ±4 m
  sceneBounds: {maxXZ: 8, minY: -1, maxY: 5}, // reject boxes outside this
  maxRayDistance: 12,
  cameraRotationOffset: {yaw: 0, pitch: 0, roll: 0}, // radians, per-unit calibration
});
```

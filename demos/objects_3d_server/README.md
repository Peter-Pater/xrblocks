# 3D Object Boxes — Server Offload

Variant of the [`objects_3d`](../objects_3d/) demo that offloads the heavy
compute to a companion Node server. The headset only captures and renders;
detection (Gemini), segmentation (SlimSAM), depth raycasting, and OBB fitting
all run server-side, reusing the `objects3d` addon's pure geometry helpers so
results match the on-device pipeline exactly.

```
headset / simulator                         Node server
───────────────────                         ───────────
capture RGB (JPEG)          ──┐
freeze device-camera matrices ┼─ WebSocket ─▶ Gemini 2D detection
serialize depth mesh        ──┘              SlimSAM masks
                                             raycast + OBB fit (three.js)
render world-space boxes    ◀── WebSocket ── [{label, center, size, angle}]
```

Because the camera matrices and depth mesh are frozen at the moment of
capture, the boxes come back in the session's world space and stay valid
however long the round trip takes — as long as the XR session (and its
reference space) stays alive. A reference-space `reset` (recenter) flushes
the boxes.

## Server setup

```bash
cd demos/objects_3d_server/server
npm install
GEMINI_API_KEY=... npm start          # or create keys.json (see below)
```

The server imports the addon's geometry helpers from the repo's `build/`
output, which the root `npm install` generates for you via its `prepare`
script. You only need to re-run `npm run build` at the repo root after editing
anything under `src/addons/objects3d/` — not before every start. Node resolves
imports once at process start, so after a rebuild, restart the server to pick
the changes up. (`npm run dev` rebuilds on save automatically, but the server
still needs the restart.)

`keys.json` next to `server.mjs`:

```json
{"gemini": {"apiKey": "YOUR_KEY"}}
```

Options: `--port 8081` (default), `GEMINI_MODEL` env (default
`gemini-3.5-flash`). The first run downloads SlimSAM (~14 MB) and warms it up.
The Gemini key never leaves the server.

### Why a separate `package.json`

This is the only package manifest in the repo besides the root one. The
server's ML dependencies (`@huggingface/transformers`, which pulls in
onnxruntime, plus `sharp`'s native binaries) total ~100 MB and are needed only
to run this demo — the SDK deliberately keeps `@huggingface/transformers`
external (see `rollup.config.js`) and the browser loads it from a CDN via
importmap. Keeping them local means a plain `npm install` at the repo root
stays lean.

The addon code itself is _not_ a dependency: `server.mjs` imports the pure
geometry helpers by relative path from `build/addons/objects3d/…`, the same
place the browser demos point their importmaps at. Do not reintroduce a
`"xrblocks": "file:../../.."` dependency — npm materialises a full copy of the
repo (and runs its `prepare` build) inside `server/node_modules`.

## Client setup

Serve the repo as usual from the repo root:

```bash
npm run dev        # builds + serves on http://127.0.0.1:8080
```

Open `http://localhost:8080/demos/objects_3d_server/`, set the server URL
(default `ws://localhost:8081`), Connect, then Detect.

### On device (Galaxy XR)

WebXR requires a secure context; the simplest path is `adb reverse` so both
the page and the WebSocket ride on `localhost`:

```bash
adb reverse tcp:8080 tcp:8080    # demo page
adb reverse tcp:8081 tcp:8081    # detection server
```

Then browse to `http://localhost:8080/demos/objects_3d_server/` on the
headset and enter XR. In immersive mode the DOM panel is hidden — **pinch (or
controller trigger) to run a detection**; results stream back as wireframe
boxes with labels.

If you serve the page over HTTPS instead, the WebSocket must be `wss://`
(mixed-content rules) — put the server behind a TLS proxy and set the URL
accordingly (`?server=wss://...` also works).

## Verification

1. **Simulator round trip**: start the server, open the demo in the desktop
   simulator, Detect. Boxes should hug the simulated furniture exactly like
   the on-device `objects_3d` demo does.
2. **Headset**: run a detection while standing still, then walk around — the
   boxes must stay anchored to the physical objects. Accuracy at the _edges_
   of the captured frame is the discriminator for the camera-model fix.
3. **Recenter**: long-press recenter; existing boxes should clear.

## Protocol

One JSON message per capture:

- `detect` (client → server): JPEG base64, `camera` matrices
  (`worldFromView`, `clipFromView`, `viewFromClip`, `snapAspect` — from
  `xb.getCameraParametersSnapshot`), serialized depth mesh (`position` /
  `index` base64 typed arrays + `matrixWorld`), and optional fitting
  `options` (`maxRayDistance`, `roomHalf`, `sceneBounds`).
- `status` / `result` / `error` (server → client): progress, then
  `objects: [{label, category, center, size, angle}]` in world space plus
  timings.

## Known limitations

- The tiny-flat fitter (`roomHalf`) and the scene-bounds sanity gates default
  to the simulator's wood-cabin dimensions; pass `options` tuned to the real
  room for best results.
- Devices where `getUserMedia` is unavailable fall back to WebXR raw camera
  access, which has no CPU-readable snapshot — capture will report "no camera
  frame available".
- One capture is processed at a time per server (the SlimSAM ONNX session is
  not re-entrant).

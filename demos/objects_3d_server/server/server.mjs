/**
 * Offloaded 3D object detection server.
 *
 * Receives one capture per request from the headset client — a JPEG snapshot,
 * the serialized depth mesh, and the device-camera matrices frozen at capture
 * time — runs 2D detection (Gemini) + segmentation (SlimSAM) + depth raycasts
 * + OBB fitting, and replies with world-space oriented bounding boxes. The
 * geometry stages reuse the `objects3d` addon's pure helpers verbatim, so
 * results match the on-device pipeline exactly.
 *
 * Usage:
 *   GEMINI_API_KEY=... npm start           (or put keys.json next to this file)
 *   node server.mjs --port 8081
 */

import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from 'three-mesh-bvh';
import {WebSocketServer} from 'ws';

// The addon's geometry helpers are deliberately pure (no xb.core, no DOM), so
// the server reuses the repo's build output directly rather than depending on
// a published package. Run `npm run build` at the repo root first.
import {
  anchorFromBboxCenter,
  sampleDepthInMask,
} from '../../../build/addons/objects3d/geometry/DepthSampling.js';
import {buildFrozenCamera} from '../../../build/addons/objects3d/geometry/FrozenCamera.js';
import {snapBoxToFloor} from '../../../build/addons/objects3d/geometry/Fusion.js';
import {
  fitYawOBB,
  radiusFromBbox,
  rejectByAnchor,
  rejectByAnchorDepth,
  rejectByY,
} from '../../../build/addons/objects3d/geometry/ObbFitting.js';
import {
  categorize,
  isSurfaceLabel,
  isTinyFlatLabel,
} from '../../../build/addons/objects3d/labels/Categories.js';

import {detect2d} from './gemini.mjs';
import {samEncodeJpeg, samMaskFromBbox} from './sam.mjs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const PORT = Number(
  process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1]
    : (process.env.PORT ?? 8081)
);
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash';

function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const keys = JSON.parse(
      readFileSync(new URL('./keys.json', import.meta.url), 'utf8')
    );
    return keys?.gemini?.apiKey ?? keys?.geminiApiKey ?? keys?.key ?? null;
  } catch (_e) {
    return null;
  }
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error(
    'No Gemini API key. Set GEMINI_API_KEY or create keys.json ' +
      '({"gemini": {"apiKey": "..."}}) next to server.mjs.'
  );
  process.exit(1);
}

/** Decode a base64 string into an ArrayBuffer. */
function base64ToArrayBuffer(b64) {
  const buf = Buffer.from(b64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Rebuild the frozen depth mesh from the serialized client payload. */
function buildDepthMesh(payload) {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(base64ToArrayBuffer(payload.position));
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  if (payload.index) {
    const IndexArray =
      payload.indexType === 'uint16' ? Uint16Array : Uint32Array;
    geometry.setIndex(
      new THREE.BufferAttribute(
        new IndexArray(base64ToArrayBuffer(payload.index)),
        1
      )
    );
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.computeBoundsTree();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({side: THREE.DoubleSide})
  );
  mesh.matrixAutoUpdate = false;
  mesh.matrix.fromArray(payload.matrixWorld);
  mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  mesh.matrixWorld.copy(mesh.matrix);
  return mesh;
}

/** 5th-percentile of world-space vertex Y — same as the addon's floor guess. */
function estimateFloorY(mesh) {
  const pos = mesh.geometry.attributes.position;
  if (!pos || !pos.count) return null;
  const p = new THREE.Vector3();
  const ys = [];
  const stride = Math.max(1, Math.floor(pos.count / 4000));
  for (let i = 0; i < pos.count; i += stride) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (Number.isFinite(p.y)) ys.push(p.y);
  }
  if (ys.length < 10) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.05)];
}

/**
 * Fit one detection into a world-space OBB. Mirrors the per-object logic in
 * `Object3DDetector.detect()` (same rejection radii and sanity gates).
 */
async function fitOne(det, ctx) {
  if (isSurfaceLabel(det.label)) return null;
  const {frozenCam, depthMesh, samState, floorY, opts} = ctx;
  const box2d = det.box2d;
  const mask = await samMaskFromBbox(samState, box2d);
  if (!mask) return null;
  const {points: raw} = sampleDepthInMask(
    mask,
    box2d,
    10,
    opts.maxRayDistance,
    frozenCam,
    depthMesh,
    frozenCam.userData.snapAspect
  );
  mask.close();

  const anchor = anchorFromBboxCenter(
    box2d,
    frozenCam,
    depthMesh,
    frozenCam.userData.snapAspect
  );
  const cat = categorize(det.label);
  let points;
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
    points = rejectByAnchor(
      rejectByAnchorDepth(raw, frozenCam, anchor, r),
      anchor,
      r
    );
  }

  const obb = fitYawOBB(points, {
    category: cat,
    camera: frozenCam,
    anchor,
    box2d,
    tinyFlat: isTinyFlatLabel(det.label),
    roomHalf: opts.roomHalf,
  });
  if (!obb) return null;
  if (cat === 'furniture' || cat === 'small') {
    snapBoxToFloor(obb, floorY);
  }

  const c = obb.center;
  const farFromRoom =
    Math.abs(c.x) > opts.sceneBounds.maxXZ ||
    Math.abs(c.z) > opts.sceneBounds.maxXZ ||
    c.y < opts.sceneBounds.minY ||
    c.y > opts.sceneBounds.maxY;
  const minPoints =
    cat === 'small' ? 4 : cat === 'light' ? 8 : cat === 'flat' ? 8 : 20;
  const tinyFlat = isTinyFlatLabel(det.label);
  const tooFewPoints = !tinyFlat && points.length < minPoints;
  const oversize = obb.size.x > 4 || obb.size.y > 3 || obb.size.z > 4;
  const horizMax = Math.max(obb.size.x, obb.size.z);
  const degenerate =
    cat !== 'flat' && horizMax > 0.5 && obb.size.y / horizMax < 0.1;
  if (farFromRoom || tooFewPoints || oversize || degenerate) {
    console.warn('reject', det.label, {
      farFromRoom,
      tooFewPoints,
      oversize,
      degenerate,
      kept: points.length,
    });
    return null;
  }

  return {
    label: det.label,
    category: cat,
    center: [c.x, c.y, c.z],
    size: [obb.size.x, obb.size.y, obb.size.z],
    angle: obb.angle,
  };
}

async function processCapture(msg, send) {
  const t0 = Date.now();
  const opts = {
    maxRayDistance: msg.options?.maxRayDistance ?? 12,
    roomHalf: msg.options?.roomHalf ?? 3,
    sceneBounds: {
      maxXZ: msg.options?.sceneBounds?.maxXZ ?? 6,
      minY: msg.options?.sceneBounds?.minY ?? -1,
      maxY: msg.options?.sceneBounds?.maxY ?? 5,
    },
  };

  const frozenCam = buildFrozenCamera({
    worldFromView: new THREE.Matrix4().fromArray(msg.camera.worldFromView),
    clipFromView: new THREE.Matrix4().fromArray(msg.camera.clipFromView),
    viewFromClip: msg.camera.viewFromClip
      ? new THREE.Matrix4().fromArray(msg.camera.viewFromClip)
      : undefined,
    snapAspect: msg.camera.snapAspect,
  });
  const depthMesh = buildDepthMesh(msg.depthMesh);
  const floorY = estimateFloorY(depthMesh);

  const jpegBase64 = msg.image.base64.replace(/^data:image\/\w+;base64,/, '');
  const jpegBuffer = Buffer.from(jpegBase64, 'base64');

  send({type: 'status', captureId: msg.captureId, message: 'detecting'});
  // Run Gemini and the SAM encoder in parallel.
  const [detections, samState] = await Promise.all([
    detect2d(apiKey, GEMINI_MODEL, jpegBase64),
    samEncodeJpeg(jpegBuffer),
  ]);
  const tDetect = Date.now();
  console.log(
    `capture ${msg.captureId}: ${detections.length} detections ` +
      `(${tDetect - t0} ms)`
  );
  send({
    type: 'status',
    captureId: msg.captureId,
    message: `fitting ${detections.length} objects`,
  });

  const ctx = {frozenCam, depthMesh, samState, floorY, opts};
  const objects = [];
  for (const det of detections) {
    try {
      const fitted = await fitOne(det, ctx);
      if (fitted) objects.push(fitted);
    } catch (e) {
      console.warn('fit failed for', det.label, e?.message ?? e);
    }
  }
  depthMesh.geometry.disposeBoundsTree?.();
  depthMesh.geometry.dispose();

  const t1 = Date.now();
  console.log(
    `capture ${msg.captureId}: ${objects.length} boxes in ${t1 - t0} ms`
  );
  send({
    type: 'result',
    captureId: msg.captureId,
    objects,
    timings: {detectMs: tDetect - t0, totalMs: t1 - t0},
  });
}

const wss = new WebSocketServer({port: PORT, maxPayload: 64 * 1024 * 1024});
console.log(`objects3d server listening on ws://0.0.0.0:${PORT}`);
console.log(`Gemini model: ${GEMINI_MODEL}`);

// Warm up the SAM model in the background so the first capture is fast.
samEncodeJpeg(await sharpPlaceholder()).catch((e) =>
  console.warn('SAM warm-up failed:', e?.message ?? e)
);

/** Tiny in-memory JPEG used only to trigger the model download/compile. */
async function sharpPlaceholder() {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: {width: 64, height: 64, channels: 3, background: '#808080'},
  })
    .jpeg()
    .toBuffer();
}

wss.on('connection', (ws, req) => {
  console.log('client connected:', req.socket.remoteAddress);
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_e) {
      send({type: 'error', message: 'invalid JSON'});
      return;
    }
    if (msg.type === 'ping') {
      send({type: 'pong'});
      return;
    }
    if (msg.type !== 'detect') {
      send({type: 'error', message: `unknown message type: ${msg.type}`});
      return;
    }
    try {
      await processCapture(msg, send);
    } catch (e) {
      console.error('capture failed:', e);
      send({
        type: 'error',
        captureId: msg.captureId,
        message: e?.message ?? String(e),
      });
    }
  });
  ws.on('close', () => console.log('client disconnected'));
});

/**
 * Server-side SlimSAM segmentation via `@huggingface/transformers` in Node
 * (onnxruntime-node CPU backend).
 *
 * Ported from the addon's `masks/SamMask.ts`: the encoder runs once per
 * capture, then each detection decodes a mask from its 2D-bbox prompt. The
 * mask-channel selection (containment + IoU score) is identical so server and
 * on-device results match.
 */

import {
  SamModel,
  AutoProcessor,
  RawImage,
  env,
} from '@huggingface/transformers';
import sharp from 'sharp';

/** Hugging Face model ID for SlimSAM-77-uniform. Apache-2 licensed, ~14 MB. */
export const SAM_MODEL_ID = 'Xenova/slimsam-77-uniform';

let _sam = null;
let _proc = null;
let _loading = null;

// The ONNX session is not re-entrant; serialise every SAM call.
let _queue = Promise.resolve();

function serialize(fn) {
  const next = _queue.then(fn, fn);
  _queue = next.catch(() => {});
  return next;
}

/** Lazily load the SlimSAM model + processor (first call downloads ~14 MB). */
export async function getSam() {
  if (_sam && _proc) return {sam: _sam, proc: _proc};
  _loading ??= (async () => {
    env.allowLocalModels = false;
    _sam = await SamModel.from_pretrained(SAM_MODEL_ID, {dtype: 'fp32'});
    _proc = await AutoProcessor.from_pretrained(SAM_MODEL_ID);
    return {sam: _sam, proc: _proc};
  })();
  return _loading;
}

/**
 * Run the SAM encoder once on a JPEG buffer.
 *
 * @param {Buffer} jpegBuffer - The capture as a JPEG.
 * @returns {Promise<object>} Encoder state for {@link samMaskFromBbox}.
 */
export async function samEncodeJpeg(jpegBuffer) {
  return serialize(async () => {
    const {sam, proc} = await getSam();
    const {data, info} = await sharp(jpegBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({resolveWithObject: true});
    const image = new RawImage(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      info.channels
    );
    const image_inputs = await proc(image);
    const image_embeddings = await sam.get_image_embeddings(image_inputs);
    return {
      image,
      image_embeddings,
      width: info.width,
      height: info.height,
    };
  });
}

/**
 * Decode one object mask from the encoder state using a 2D-bbox prompt.
 *
 * @param {object} samState - State from {@link samEncodeJpeg}.
 * @param {{min: {x: number, y: number}, max: {x: number, y: number}}} box2d -
 *   Normalised [0, 1] bounding box.
 * @returns {Promise<{width: number, height: number, getAsUint8Array: () => Uint8Array, close: () => void}>}
 *   Mask where foreground pixels are `< 128` (MaskLike shape expected by
 *   `sampleDepthInMask`).
 */
export async function samMaskFromBbox(samState, box2d) {
  return serialize(async () => {
    const {sam, proc} = await getSam();
    const {image, image_embeddings, width, height} = samState;
    const x1 = box2d.min.x * width;
    const y1 = box2d.min.y * height;
    const x2 = box2d.max.x * width;
    const y2 = box2d.max.y * height;
    const cx = (x1 + x2) * 0.5;
    const cy = (y1 + y2) * 0.5;
    const prompt_inputs = await proc(image, {
      input_points: [
        [
          [
            [cx, cy],
            [x1, y1],
            [x2, y2],
          ],
        ],
      ],
      input_labels: [[[1, 2, 3]]],
    });
    const out = await sam({...prompt_inputs, image_embeddings});
    const masks = await proc.post_process_masks(
      out.pred_masks,
      prompt_inputs.original_sizes,
      prompt_inputs.reshaped_input_sizes
    );
    const t = masks[0];
    const dataBool = t.data;
    const H = t.dims[t.dims.length - 2];
    const W = t.dims[t.dims.length - 1];
    const planeStride = H * W;
    const numChannels = Math.max(1, Math.floor(dataBool.length / planeStride));
    const ious = out.iou_scores?.data;
    const bx1 = Math.max(0, Math.floor(x1 * (W / width)));
    const by1 = Math.max(0, Math.floor(y1 * (H / height)));
    const bx2 = Math.min(W, Math.ceil(x2 * (W / width)));
    const by2 = Math.min(H, Math.ceil(y2 * (H / height)));
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < numChannels; c++) {
      const off = c * planeStride;
      let inside = 0;
      let total = 0;
      for (let y = 0; y < H; y++) {
        const row = off + y * W;
        const yIn = y >= by1 && y < by2;
        for (let x = 0; x < W; x++) {
          if (dataBool[row + x]) {
            total++;
            if (yIn && x >= bx1 && x < bx2) inside++;
          }
        }
      }
      if (total === 0) continue;
      const containment = inside / total;
      const iou = ious ? ious[c] : 0;
      const score = containment + 0.05 * iou;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const offset = best * planeStride;
    const buf = new Uint8Array(planeStride);
    for (let i = 0; i < planeStride; i++) {
      buf[i] = dataBool[offset + i] ? 0 : 255;
    }
    return {
      width: W,
      height: H,
      getAsUint8Array: () => buf,
      close: () => {},
    };
  });
}

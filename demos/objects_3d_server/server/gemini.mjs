/**
 * Server-side Gemini 2D object detection.
 *
 * Mirrors the SDK's GeminiDetectorBackend (same prompt contract: boxes as
 * integers in [0, 1000] with a top-left origin) so results are interchangeable
 * with on-device detection. The API key stays on the server.
 */

import {GoogleGenAI} from '@google/genai';

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    required: ['objectName', 'ymin', 'xmin', 'ymax', 'xmax'],
    properties: {
      objectName: {type: 'STRING'},
      ymin: {type: 'NUMBER'},
      xmin: {type: 'NUMBER'},
      ymax: {type: 'NUMBER'},
      xmax: {type: 'NUMBER'},
    },
  },
};

// Same exhaustive-list prompt the objects_3d demo uses (the stock SDK prompt
// caps at 5 "primary nearby" objects, which is low recall for room scans).
const SYSTEM_INSTRUCTION =
  'List every distinct object visible in the image, including small ' +
  'items (cups, books, remotes), wall-mounted things (pictures, ' +
  'switches, TVs), and ceiling fixtures (lamps, lights). For each, ' +
  'return ymin, xmin, ymax, xmax as integers from 0 to 1000 (top-left ' +
  'origin) and a short lowercase objectName. List up to 20 objects. ' +
  'Skip walls, floor, ceiling, and any human body parts or UI ' +
  'elements attached to them.';

let _client = null;

/**
 * Detect 2D objects in a JPEG image via Gemini.
 *
 * @param {string} apiKey - Gemini API key.
 * @param {string} model - Gemini model id (e.g. 'gemini-3.5-flash').
 * @param {string} jpegBase64 - Raw base64 JPEG payload (no data-URL prefix).
 * @returns {Promise<Array<{label: string, box2d: {min: {x: number, y: number}, max: {x: number, y: number}}}>>}
 *   Detections with normalised [0, 1] boxes.
 */
export async function detect2d(apiKey, model, jpegBase64) {
  _client ??= new GoogleGenAI({apiKey});
  const response = await _client.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {inlineData: {mimeType: 'image/jpeg', data: jpegBase64}},
          {text: 'What do you see in this image?'},
        ],
      },
    ],
    config: {
      thinkingConfig: {thinkingBudget: 0},
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      systemInstruction: [{text: SYSTEM_INSTRUCTION}],
    },
  });
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch (_e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const detections = [];
  for (const item of parsed) {
    const {ymin, xmin, ymax, xmax, objectName} = item ?? {};
    if ([ymin, xmin, ymax, xmax].every((v) => typeof v === 'number')) {
      detections.push({
        label: objectName || 'unknown',
        box2d: {
          min: {x: xmin / 1000, y: ymin / 1000},
          max: {x: xmax / 1000, y: ymax / 1000},
        },
      });
    }
  }
  return detections;
}

/**
 * Audio-driven mouth animation addon for xrblocks. The primary export,
 * `LipsyncMouth`, is a small `xb.Script` that attaches to any
 * `THREE.Object3D` (typically an avatar head pivot), pulls audio from a
 * `MediaStream`, and animates a stylised mouth in real time.
 *
 * For multi-peer use (one mouth per remote netblocks peer), pass a shared
 * `AudioContext` via the `audioContext` option so browsers don't run out
 * of context slots.
 *
 * @see {@link LipsyncMouth}
 */
export {LipsyncMouth} from './LipsyncMouth';
export type {LipsyncMouthOptions} from './LipsyncMouth';
export {StylizedMouth} from './StylizedMouth';
export type {StylizedMouthOptions, LipMetrics} from './StylizedMouth';
export {FormantVisemeMapper} from './FormantVisemeMapper';
export type {
  AudioFeatures,
  FormantVisemeMapperOptions,
} from './FormantVisemeMapper';
export {MfccExtractor, NUM_MFCC} from './MfccExtractor';
export type {MfccExtractorOptions} from './MfccExtractor';
export {
  ARKIT_BLENDSHAPE_NAMES,
  blendshapesToVisemes,
  ZERO_VISEME,
} from './BlendshapeReducer';
export type {VisemeWeights} from './BlendshapeReducer';
export {computeAudioFeatures} from './computeAudioFeatures';
export type {AudioFeatureInputs} from './computeAudioFeatures';

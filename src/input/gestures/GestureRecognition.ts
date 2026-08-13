import * as THREE from 'three';

import {Handedness} from '../Hands';
import {User} from '../../core/User';
import {Script} from '../../core/Script';
import {GestureEventDetail, GestureEventType} from './GestureEvents';
import {GestureRecognitionOptions} from './GestureRecognitionOptions';
import {
  HAND_INDEX_TO_LABEL,
  type GestureScoreMap,
  type HandContext,
  type HandGestureContext,
  type HandLabel,
  type HandPoseSample,
  type JointPositions,
} from './GestureTypes';

type ActiveGestureState = {
  confidence: number;
  data?: Record<string, unknown>;
};

type GestureScriptEvent = THREE.Event & {
  type: GestureEventType;
  target: GestureRecognition;
  detail: GestureEventDetail;
};

interface GestureRecognitionEventMap extends THREE.Object3DEventMap {
  gesturestart: GestureScriptEvent;
  gestureupdate: GestureScriptEvent;
  gestureend: GestureScriptEvent;
}

export class GestureRecognition extends Script<GestureRecognitionEventMap> {
  static dependencies = {
    user: User,
    options: GestureRecognitionOptions,
  };

  private options!: GestureRecognitionOptions;
  private activeGestures: Record<HandLabel, Map<string, ActiveGestureState>> = {
    left: new Map(),
    right: new Map(),
  };
  private latestScores: Record<HandLabel, GestureScoreMap | null> = {
    left: null,
    right: null,
  };
  private pendingRecognition: Record<HandLabel, boolean> = {
    left: false,
    right: false,
  };
  private samples: Record<HandLabel, HandPoseSample[]> = {
    left: [],
    right: [],
  };
  private generations: Record<HandLabel, number> = {
    left: 0,
    right: 0,
  };
  private lastEvaluation = 0;

  async init({
    options,
    user,
  }: {
    options: GestureRecognitionOptions;
    user: User;
  }) {
    this.options = options;
    await this.options.poseEstimator.init?.({user});
    await this.options.gestureRecognizer.init?.();
    if (!this.options.enabled) {
      console.info(
        'GestureRecognition initialized but disabled. Call options.enableGestures() to activate.'
      );
    }
  }

  update(time = performance.now()) {
    if (!this.options.enabled) return;

    const now = Number.isFinite(time) ? time : performance.now();
    const interval = this.options.updateIntervalMs;
    if (interval > 0 && now - this.lastEvaluation < interval) {
      return;
    }
    this.lastEvaluation = now;

    this.evaluateHand(Handedness.LEFT, now);
    this.evaluateHand(Handedness.RIGHT, now);
  }

  private evaluateHand(handedness: Handedness, timestamp: number) {
    const handLabel = HAND_INDEX_TO_LABEL[handedness];
    if (!handLabel) return;

    const sourceContext = this.options.poseEstimator.getHandContext(handedness);
    if (!sourceContext) {
      this.resetHand(handLabel, true);
      return;
    }

    const previous = this.samples[handLabel].at(-1);
    if (
      previous &&
      timestamp - previous.timestamp > this.options.maximumSampleGapMs
    ) {
      this.resetHand(handLabel, true);
    }

    const sample = this.cloneSample(sourceContext, timestamp);
    const samples = this.samples[handLabel];
    samples.push(sample);
    this.pruneSamples(samples, timestamp);
    const context: HandGestureContext = {
      ...sample,
      samples: samples.slice(),
    };

    this.recognizeHand(context);
    const scores = this.latestScores[handLabel];
    if (!scores) return;

    this.emitFromScores(handLabel, scores);
  }

  private cloneSample(context: HandContext, timestamp: number): HandPoseSample {
    const joints: JointPositions = new Map();
    for (const [name, position] of context.joints) {
      joints.set(name, position.clone());
    }
    return {
      timestamp,
      handedness: context.handedness,
      handLabel: context.handLabel,
      joints,
      getJoint: (jointName) => joints.get(jointName),
    };
  }

  private pruneSamples(samples: HandPoseSample[], timestamp: number) {
    const oldestTimestamp = timestamp - this.options.historyDurationMs;
    let firstRetained = 0;
    while (
      firstRetained < samples.length &&
      samples[firstRetained].timestamp < oldestTimestamp
    ) {
      firstRetained++;
    }
    if (firstRetained > 0) samples.splice(0, firstRetained);
  }

  private recognizeHand(context: HandGestureContext) {
    const handLabel = context.handLabel;
    if (this.pendingRecognition[handLabel]) return;

    const generation = this.generations[handLabel];
    const result = this.options.gestureRecognizer.recognize(context);
    if (result instanceof Promise) {
      this.pendingRecognition[handLabel] = true;
      result
        .then((scores) => {
          if (generation === this.generations[handLabel]) {
            this.latestScores[handLabel] = scores;
          }
        })
        .catch((error) => {
          console.error('GestureRecognition recognizer failed:', error);
        })
        .finally(() => {
          if (generation === this.generations[handLabel]) {
            this.pendingRecognition[handLabel] = false;
          }
        });
      return;
    }

    this.latestScores[handLabel] = result;
  }

  private resetHand(handLabel: HandLabel, emitEnds: boolean) {
    const activeMap = this.activeGestures[handLabel];
    if (emitEnds) {
      for (const [name] of activeMap) {
        this.emitGesture('gestureend', {name, hand: handLabel, confidence: 0});
      }
    }
    activeMap.clear();
    this.samples[handLabel].length = 0;
    this.latestScores[handLabel] = null;
    this.pendingRecognition[handLabel] = false;
    this.generations[handLabel]++;
  }

  private emitFromScores(handLabel: HandLabel, scores: GestureScoreMap) {
    const activeMap = this.activeGestures[handLabel];
    let winner:
      | {
          name: string;
          result: NonNullable<GestureScoreMap[string]>;
        }
      | undefined;

    for (const [name, config] of Object.entries(this.options.gestures)) {
      if (!config?.enabled) continue;
      const result = scores[name];
      if (!result || result.confidence < this.options.minimumConfidence) {
        continue;
      }
      if (!winner || result.confidence > winner.result.confidence) {
        winner = {name, result};
      }
    }

    // A hand can express only one recognized gesture at a time. End the old
    // winner before starting a new one so event consumers never observe two
    // simultaneously active gestures for the same hand.
    for (const name of Array.from(activeMap.keys())) {
      if (name === winner?.name) continue;
      activeMap.delete(name);
      this.emitGesture('gestureend', {
        name,
        hand: handLabel,
        confidence: 0.0,
      });
    }

    if (!winner) return;

    const detail: GestureEventDetail = {
      name: winner.name,
      hand: handLabel,
      confidence: THREE.MathUtils.clamp(winner.result.confidence, 0, 1),
      data: winner.result.data,
    };
    const previousState = activeMap.get(winner.name);
    if (!previousState) {
      activeMap.set(winner.name, {
        confidence: detail.confidence,
        data: detail.data,
      });
      this.emitGesture('gesturestart', detail);
    } else {
      previousState.confidence = detail.confidence;
      previousState.data = detail.data;
      this.emitGesture('gestureupdate', detail);
    }
  }

  private emitGesture(type: GestureEventType, detail: GestureEventDetail) {
    const event: GestureScriptEvent = {type, detail, target: this};
    this.dispatchEvent(event);
  }

  dispose() {
    this.resetHand('left', false);
    this.resetHand('right', false);
    this.options.poseEstimator.dispose?.();
    this.options.gestureRecognizer.dispose?.();
  }
}

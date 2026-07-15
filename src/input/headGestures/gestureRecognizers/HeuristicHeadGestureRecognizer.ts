import type {DeepReadonly} from '../../../utils/Types';
import type {
  HeadGestureConfiguration,
  HeadGestureContext,
  HeadGestureRecognizer,
  HeadGestureScoreMap,
  HeuristicHeadGestureDetector,
} from '../HeadGestureTypes';
import {
  detectNod,
  detectShake,
  type HeuristicHeadGestureRecognizerOptions,
} from './BuiltInHeuristicHeadGestures';

export type {HeuristicHeadGestureRecognizerOptions};

type RegisteredGesture = {
  detector: HeuristicHeadGestureDetector;
  config: HeadGestureConfiguration;
};

const DEFAULT_OPTIONS: HeuristicHeadGestureRecognizerOptions = {
  minimumGestureDurationMs: 200,
  maximumGestureDurationMs: 750,
  maximumOffAxisRatio: 0.5,
  quietPrefixDurationMs: 200,
  detectionHoldMs: 180,
  returnToleranceFactor: 0.55,
  smoothingTimeConstantMs: 35,
  minimumPathEfficiency: 0.65,
  minimumPeakAngularSpeed: 0.75,
};

export class HeuristicHeadGestureRecognizer implements HeadGestureRecognizer {
  private gestures = new Map<string, RegisteredGesture>();
  readonly options: HeuristicHeadGestureRecognizerOptions;

  constructor(
    initBuiltInGestures = true,
    options: DeepReadonly<Partial<HeuristicHeadGestureRecognizerOptions>> = {}
  ) {
    this.options = {...DEFAULT_OPTIONS, ...options};
    if (initBuiltInGestures) {
      this.registerBuiltInGestures();
    }
  }

  registerGesture(
    name: string,
    detector: HeuristicHeadGestureDetector,
    config: DeepReadonly<Partial<HeadGestureConfiguration>> = {}
  ) {
    this.gestures.set(name, {
      detector,
      config: {
        enabled: true,
        ...config,
      },
    });
    return this;
  }

  unregisterGesture(name: string) {
    this.gestures.delete(name);
    return this;
  }

  getGestureConfigurations(): Record<string, HeadGestureConfiguration> {
    const configs: Record<string, HeadGestureConfiguration> = {};
    for (const [name, gesture] of this.gestures.entries()) {
      configs[name] = {...gesture.config};
    }
    return configs;
  }

  setGestureConfig(name: string, config: HeadGestureConfiguration) {
    const gesture = this.gestures.get(name);
    if (gesture) {
      gesture.config = {...config};
    }
    return this;
  }

  recognize(context: HeadGestureContext): HeadGestureScoreMap {
    const scores: HeadGestureScoreMap = {};
    for (const [name, gesture] of this.gestures.entries()) {
      scores[name] = gesture.detector(context, gesture.config);
    }
    return scores;
  }

  private registerBuiltInGestures() {
    this.registerGesture(
      'nod',
      (context, config) => detectNod(context, config, this.options),
      {enabled: true, threshold: (12 * Math.PI) / 180}
    );
    this.registerGesture(
      'shake',
      (context, config) => detectShake(context, config, this.options),
      {enabled: true, threshold: (10 * Math.PI) / 180}
    );
  }
}

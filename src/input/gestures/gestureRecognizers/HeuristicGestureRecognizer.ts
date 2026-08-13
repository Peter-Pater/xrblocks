import type {DeepReadonly} from '../../../utils/Types';
import type {
  GestureConfiguration,
  GestureParameters,
} from '../GestureRecognitionOptions';
import type {
  HeuristicGestureDetector,
  GestureRecognizer,
  GestureScoreMap,
  HandGestureContext,
} from '../GestureTypes';
import {
  DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
  detectFist,
  detectOpenPalm,
  detectPinch,
  detectPoint,
  detectSpread,
  detectThumbsDown,
  detectThumbsUp,
} from './BuiltInHeuristicGestures';
import {
  DEFAULT_BECKON_GESTURE_PARAMETERS,
  DEFAULT_SHOO_GESTURE_PARAMETERS,
  detectBeckon,
  detectShoo,
} from './BuiltInTemporalGestures';

type RegisteredGesture = {
  detector: HeuristicGestureDetector;
  config: GestureConfiguration;
};

export class HeuristicGestureRecognizer implements GestureRecognizer {
  private gestures = new Map<string, RegisteredGesture>();

  constructor(initBuiltInGestures = true) {
    if (initBuiltInGestures) {
      this.registerBuiltInGestures();
    }
  }

  registerGesture<TParameters extends object = GestureParameters>(
    name: string,
    detector: HeuristicGestureDetector<TParameters>,
    config: DeepReadonly<Partial<GestureConfiguration<TParameters>>> = {}
  ) {
    const storedConfig = {
      enabled: true,
      ...config,
    } as GestureConfiguration<TParameters>;
    this.gestures.set(name, {
      detector: (context, runtimeConfig) =>
        detector(context, runtimeConfig as GestureConfiguration<TParameters>),
      config: storedConfig as GestureConfiguration,
    });
    return this;
  }

  unregisterGesture(name: string) {
    this.gestures.delete(name);
    return this;
  }

  getGestureConfigurations(): Record<string, GestureConfiguration> {
    const configs: Record<string, GestureConfiguration> = {};
    for (const [name, gesture] of this.gestures.entries()) {
      configs[name] = structuredClone(gesture.config);
    }
    return configs;
  }

  setGestureConfig(name: string, config: GestureConfiguration) {
    const gesture = this.gestures.get(name);
    if (gesture) gesture.config = structuredClone(config);
  }

  recognize(context: HandGestureContext): GestureScoreMap {
    const scores: GestureScoreMap = {};
    for (const [name, gesture] of this.gestures.entries()) {
      scores[name] = gesture.detector(context, gesture.config);
    }
    return scores;
  }

  private registerBuiltInGestures() {
    this.registerGesture('pinch', detectPinch, {
      enabled: true,
      threshold: 0.025,
    });
    this.registerGesture('open-palm', detectOpenPalm);
    this.registerGesture('fist', detectFist);
    this.registerGesture('thumbs-up', detectThumbsUp, {
      parameters: DEFAULT_THUMBS_UP_GESTURE_PARAMETERS,
    });
    this.registerGesture('thumbs-down', detectThumbsDown);
    this.registerGesture('point', detectPoint, {enabled: false});
    this.registerGesture('spread', detectSpread, {
      enabled: false,
      threshold: 0.04,
    });
    this.registerGesture('shoo', detectShoo, {
      enabled: false,
      threshold: Math.PI / 12,
      parameters: DEFAULT_SHOO_GESTURE_PARAMETERS,
    });
    this.registerGesture('beckon', detectBeckon, {
      enabled: false,
      threshold: Math.PI / 12,
      parameters: DEFAULT_BECKON_GESTURE_PARAMETERS,
    });
  }
}

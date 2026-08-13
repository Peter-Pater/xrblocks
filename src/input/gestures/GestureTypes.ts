import * as THREE from 'three';

import {Handedness, JointName} from '../Hands';
import type {User} from '../../core/User';
import type {
  GestureConfiguration,
  GestureParameters,
} from './GestureRecognitionOptions';

export type HandLabel = 'left' | 'right';

export const HAND_INDEX_TO_LABEL: Partial<Record<Handedness, HandLabel>> = {
  [Handedness.LEFT]: 'left',
  [Handedness.RIGHT]: 'right',
};

export type JointPositions = Map<JointName, THREE.Vector3>;

export interface HandContext {
  handedness: Handedness;
  handLabel: HandLabel;
  joints: JointPositions;

  getJoint(jointName: JointName): THREE.Vector3 | undefined;
}

/** A time-isolated copy of one hand pose captured by GestureRecognition. */
export interface HandPoseSample extends HandContext {
  readonly timestamp: number;
}

/**
 * The current hand pose plus recent timestamped poses for temporal detectors.
 * Static gesture detectors can continue to use this exactly like HandContext.
 */
export interface HandGestureContext extends HandContext {
  readonly samples: readonly HandPoseSample[];
}

export type GestureDetectionResult = {
  confidence: number;
  data?: Record<string, unknown>;
};

export type GestureScoreMap = Record<
  string,
  GestureDetectionResult | undefined
>;

export type HeuristicGestureDetector<
  TParameters extends object = GestureParameters,
> = (
  context: HandGestureContext,
  config: GestureConfiguration<TParameters>
) => GestureDetectionResult | undefined;

export interface GestureRecognizer {
  init?(): Promise<void>;
  recognize(
    context: HandGestureContext
  ): GestureScoreMap | Promise<GestureScoreMap>;
  getGestureConfigurations?(): Record<string, GestureConfiguration>;
  setGestureConfig?(name: string, config: GestureConfiguration): void;
  dispose?(): void;
}

export interface PoseEstimator {
  init?(dependencies?: {user?: User}): Promise<void>;
  getHandContext(handedness: Handedness): HandContext | null;
  getHandContexts(): Partial<Record<HandLabel, HandContext>>;
  dispose?(): void;
}

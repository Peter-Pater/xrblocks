import {SimulatorHandPose} from 'xrblocks';

/** Maps gesture names the agent can emit to concrete hand poses. */
export const GESTURE_POSE_MAP: Readonly<Record<string, SimulatorHandPose>> = {
  point: SimulatorHandPose.POINTING,
  pointing: SimulatorHandPose.POINTING,
  thumbs_up: SimulatorHandPose.THUMBS_UP,
  thumbsup: SimulatorHandPose.THUMBS_UP,
  approve: SimulatorHandPose.THUMBS_UP,
  yes: SimulatorHandPose.THUMBS_UP,
  thumbs_down: SimulatorHandPose.THUMBS_DOWN,
  thumbsdown: SimulatorHandPose.THUMBS_DOWN,
  no: SimulatorHandPose.THUMBS_DOWN,
  fist: SimulatorHandPose.FIST,
  victory: SimulatorHandPose.VICTORY,
  peace: SimulatorHandPose.VICTORY,
  rock: SimulatorHandPose.ROCK,
  relax: SimulatorHandPose.RELAXED,
  rest: SimulatorHandPose.RELAXED,
  open: SimulatorHandPose.RELAXED,
};

/** Motion gesture kinds the agent can emit (animated, not static poses). */
export type AgentMotionKind = 'beat' | 'wave' | 'size' | 'count';

/** Maps gesture names to animated motion kinds. */
export const GESTURE_MOTION_MAP: Readonly<Record<string, AgentMotionKind>> = {
  beat: 'beat',
  emphasize: 'beat',
  emphasis: 'beat',
  wave: 'wave',
  hi: 'wave',
  hello: 'wave',
  hey: 'wave',
  greet: 'wave',
  size: 'size',
  big: 'size',
  this_big: 'size',
  measure: 'size',
  count: 'count',
  number: 'count',
};

/** A gesture the agent emitted, located within its (cleaned) reply text. */
export interface AgentGestureEvent {
  /** The hand pose to play, for static-pose gestures. */
  pose?: SimulatorHandPose;
  /** The animated motion to play, for motion gestures (beat/wave/size/count). */
  motion?: AgentMotionKind;
  /** Optional parameter for a motion gesture, e.g. `big` for size, `2` for count. */
  param?: string;
  /** The raw gesture name from the markup. */
  name: string;
  /** Character index in the cleaned text where the gesture occurs. */
  index: number;
  /**
   * Optional target label for a spatial gesture, e.g. the object to point at
   * from markup like `[point:the table]`. Lowercased and trimmed.
   */
  target?: string;
}

/** The agent's reply with gesture markup stripped, plus the gestures found. */
export interface ParsedAgentSpeech {
  /** The reply text with all gesture markup removed. */
  text: string;
  /** The gestures, in order of appearance. */
  gestures: AgentGestureEvent[];
}

const GESTURE_MARKUP =
  /\[(?:gesture:)?\s*([a-zA-Z _-]+?)\s*(?::\s*([^\]]+?)\s*)?\]/g;

/**
 * Resolves a gesture name (e.g. "thumbs up", "point") to a hand pose.
 * @param name - The gesture name from the markup.
 * @returns The matching pose, or undefined if unknown.
 */
export function gestureNameToPose(name: string): SimulatorHandPose | undefined {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (
    GESTURE_POSE_MAP[normalized] ??
    GESTURE_POSE_MAP[normalized.replace(/_/g, '')]
  );
}

/**
 * Resolves a gesture name (e.g. "wave", "this big") to a motion kind.
 * @param name - The gesture name from the markup.
 * @returns The matching motion kind, or undefined if it is not a motion.
 */
export function gestureNameToMotion(name: string): AgentMotionKind | undefined {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return GESTURE_MOTION_MAP[normalized];
}

/**
 * Parses an agent reply containing gesture markup such as
 * `"That one [gesture:point] over there."` into clean speech text plus the
 * gestures to play, each anchored to where it appeared in the text.
 * @param input - The raw agent reply.
 * @returns The cleaned text and the ordered gesture events.
 */
export function parseAgentGestures(input: string): ParsedAgentSpeech {
  const gestures: AgentGestureEvent[] = [];
  let text = '';
  let lastIndex = 0;
  GESTURE_MARKUP.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GESTURE_MARKUP.exec(input)) !== null) {
    text += input.slice(lastIndex, match.index);
    const name = match[1].trim().toLowerCase();
    // Index into the final normalized text so timing aligns with what the
    // caller schedules against `text` (which is whitespace-collapsed).
    const index = text.replace(/\s+/g, ' ').replace(/^\s/, '').length;
    const param = match[2]?.trim().toLowerCase();
    const motion = gestureNameToMotion(match[1]);
    if (motion) {
      gestures.push({motion, name, index, ...(param ? {param} : {})});
    } else {
      const pose = gestureNameToPose(match[1]);
      if (pose) {
        gestures.push({pose, name, index, ...(param ? {target: param} : {})});
      }
    }
    lastIndex = match.index + match[0].length;
  }
  text += input.slice(lastIndex);
  return {text: text.replace(/\s+/g, ' ').trim(), gestures};
}

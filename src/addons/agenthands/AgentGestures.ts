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

/** A gesture the agent emitted, located within its (cleaned) reply text. */
export interface AgentGestureEvent {
  /** The hand pose to play. */
  pose: SimulatorHandPose;
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
    const pose = gestureNameToPose(match[1]);
    if (pose) {
      const target = match[2]?.trim().toLowerCase();
      gestures.push({
        pose,
        name: match[1].trim().toLowerCase(),
        index: text.length,
        ...(target ? {target} : {}),
      });
    }
    lastIndex = match.index + match[0].length;
  }
  text += input.slice(lastIndex);
  return {text: text.replace(/\s+/g, ' ').trim(), gestures};
}

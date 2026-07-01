import type {GestureStep} from './AgentGestures';

/**
 * The minimal speech-synthesizer surface the conductor uses: speak some text,
 * and (optionally) report word boundaries as they are spoken.
 */
export interface SpeechSynthesizerLike {
  /** Speaks the text. May resolve when finished. */
  speak(text: string): Promise<unknown> | void;
  /** Called with the character index into the text as each word begins. */
  onBoundaryCallback?: ((charIndex: number) => void) | undefined;
}

/** One entry on the conductor's timeline. */
export interface TimelineEntry {
  /** Seconds from the start at which this entry fires. */
  at: number;
  /** A gesture step to play. */
  step?: GestureStep;
  /** Marks the end of speech: clears speaking and calls `onRest`. */
  rest?: boolean;
  /** Advances to another scripted line (calls `onNext`). */
  next?: number;
}

/** Callbacks the conductor invokes as the timeline plays. */
export interface AgentSpeechConductorCallbacks {
  /** Play a gesture step (pose, motion, or point). */
  onStep: (step: GestureStep) => void;
  /** Return the hands to rest at the end of speech. */
  onRest: () => void;
  /** Advance to a scripted line index (scripted mode only). */
  onNext?: (index: number) => void;
}

/**
 * Synchronizes gesture playback with spoken text: the "TTS timestamp matcher".
 * A timed queue is the guaranteed driver (it works regardless of the voice),
 * and when the synthesizer emits word boundaries the conductor additionally
 * fires pending steps a touch early for tighter sync. Firing is idempotent with
 * the timed queue, so a step is never missed even if it plays twice.
 */
export class AgentSpeechConductor {
  /** Whether the agent is currently speaking. */
  speaking = false;

  private queue: TimelineEntry[] = [];
  private timer = 0;
  private readonly synth?: SpeechSynthesizerLike | null;
  private readonly callbacks: AgentSpeechConductorCallbacks;

  /**
   * @param options - The synthesizer to speak through (optional) and the
   *     callbacks that apply the timeline to the hands.
   */
  constructor(
    options: {
      synthesizer?: SpeechSynthesizerLike | null;
    } & AgentSpeechConductorCallbacks
  ) {
    this.synth = options.synthesizer;
    this.callbacks = options;
  }

  /**
   * Speaks `text` and plays its gesture `steps` in sync. The timed queue fires
   * each step at its estimated time and rests at the end; if the voice emits
   * boundaries, matching steps fire early for tighter timing.
   * @param text - The text to speak.
   * @param steps - The timed gesture steps for `text`.
   * @param duration - Estimated spoken duration of `text`, in seconds.
   */
  speak(text: string, steps: GestureStep[], duration: number) {
    this.queue = [
      ...steps.map((step) => ({at: step.at, step})),
      {at: duration + 0.8, rest: true},
    ];
    this.timer = 0;
    this.speaking = true;

    const synth = this.synth;
    if (synth?.speak) {
      const pending = [...steps];
      synth.onBoundaryCallback = (charIndex: number) => {
        while (pending.length && pending[0].charIndex <= charIndex) {
          this.callbacks.onStep(pending.shift()!);
        }
      };
      Promise.resolve(synth.speak(text))
        .catch(() => {})
        .finally(() => {
          synth.onBoundaryCallback = undefined;
        });
    }
  }

  /**
   * Plays a bare timeline with no speech, e.g. a scripted (no-key) demo line.
   * @param entries - The timeline entries to play.
   */
  playTimeline(entries: TimelineEntry[]) {
    this.queue = [...entries];
    this.timer = 0;
  }

  /**
   * Advances the timeline, firing each entry whose time has arrived.
   * @param dt - Elapsed time since the last tick, in seconds.
   */
  tick(dt: number) {
    this.timer += dt;
    while (this.queue.length && this.timer >= this.queue[0].at) {
      const entry = this.queue.shift()!;
      if (entry.rest) {
        this.speaking = false;
        this.callbacks.onRest();
      } else if (entry.step) {
        this.callbacks.onStep(entry.step);
      }
      if (entry.next !== undefined) this.callbacks.onNext?.(entry.next);
    }
  }
}

import {describe, it, expect, vi} from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('AudioContext', function () {
    return {createGain: () => ({connect: () => {}}), destination: {}};
  });
});

import {SimulatorHandPose} from 'xrblocks';

import {gestureNameToPose, parseAgentGestures} from './AgentGestures';

describe('gestureNameToPose', () => {
  it('maps direct names', () => {
    expect(gestureNameToPose('point')).toBe(SimulatorHandPose.POINTING);
    expect(gestureNameToPose('fist')).toBe(SimulatorHandPose.FIST);
    expect(gestureNameToPose('victory')).toBe(SimulatorHandPose.VICTORY);
  });

  it('normalizes spaces, hyphens, and case', () => {
    expect(gestureNameToPose('Thumbs Up')).toBe(SimulatorHandPose.THUMBS_UP);
    expect(gestureNameToPose('thumbs-up')).toBe(SimulatorHandPose.THUMBS_UP);
    expect(gestureNameToPose('THUMBSUP')).toBe(SimulatorHandPose.THUMBS_UP);
  });

  it('returns undefined for unknown names', () => {
    expect(gestureNameToPose('wiggle')).toBeUndefined();
  });
});

describe('parseAgentGestures', () => {
  it('strips markup and returns clean text', () => {
    const {text} = parseAgentGestures('Look [gesture:point] over there.');
    expect(text).toBe('Look over there.');
  });

  it('captures gestures in order with their text index', () => {
    const {gestures} = parseAgentGestures(
      'Yes [gesture:thumbs_up] and that [gesture:point] one.'
    );
    expect(gestures.map((g) => g.pose)).toEqual([
      SimulatorHandPose.THUMBS_UP,
      SimulatorHandPose.POINTING,
    ]);
    expect(gestures[0].index).toBeLessThan(gestures[1].index);
  });

  it('accepts bare [name] markup without the gesture: prefix', () => {
    const {text, gestures} = parseAgentGestures('Great [thumbs up]!');
    expect(text).toBe('Great !');
    expect(gestures[0].pose).toBe(SimulatorHandPose.THUMBS_UP);
  });

  it('drops unknown gesture markup but keeps surrounding text', () => {
    const {text, gestures} = parseAgentGestures('Hmm [gesture:wiggle] ok.');
    expect(text).toBe('Hmm ok.');
    expect(gestures).toHaveLength(0);
  });

  it('returns no gestures for plain text', () => {
    const {text, gestures} = parseAgentGestures('Just talking.');
    expect(text).toBe('Just talking.');
    expect(gestures).toHaveLength(0);
  });

  it('captures a point target from [point:label] markup', () => {
    const {text, gestures} = parseAgentGestures(
      'It is right [point:the table] there.'
    );
    expect(text).toBe('It is right there.');
    expect(gestures).toHaveLength(1);
    expect(gestures[0].pose).toBe(SimulatorHandPose.POINTING);
    expect(gestures[0].target).toBe('the table');
  });

  it('captures a target from the gesture: prefixed form too', () => {
    const {gestures} = parseAgentGestures('Over [gesture:point:sofa] here.');
    expect(gestures[0].pose).toBe(SimulatorHandPose.POINTING);
    expect(gestures[0].target).toBe('sofa');
  });

  it('leaves target undefined for gestures without one', () => {
    const {gestures} = parseAgentGestures('Nice [gesture:thumbs_up]!');
    expect(gestures[0].target).toBeUndefined();
  });
});

# Agent Hands

A free-standing pair of agent hands and a glowing orb that gesture while the agent talks and point at real things in the room. Without a Gemini key the demo plays a short scripted monologue so you can see the gestures; add `?key=...` and you get the full loop: you talk, Gemini replies with inline gesture markup, the reply is spoken, and the hands gesture in sync with the spoken words while pointing at detected objects.

This demo ports the idea from AgentHands (Liu et al., CHI 2026, [paper](https://www.duruofei.com/papers/Liu_AgentHands-GeneratingInteractiveHandsGesturesForSpatiallyGroundedAgentConversationsInXR_CHI2026.pdf)) to the open web on three.js and WebXR. The paper's insight is that an agent feels more present when it can gesture and physically point at things in your space rather than only talk at you. It drives the gestures from a language model through inline markup, grounds them to real objects, and keeps the embodiment deliberately minimal, a calm orb as the locus of attention plus translucent hands and no face, so it does not tip into the uncanny.

## Running

Serve the repo root and open `/demos/agent_hands/`. The demo runs in the desktop simulator and on Android XR. Use the **talk** and **scan** buttons on the spatial panel, or the on-screen controls. Add `?key=YOUR_GEMINI_KEY` to the URL for the interactive loop; without a key it plays the scripted demo.

## How it is put together

The demo itself is scene glue (lighting, the head-anchored rig, the pointer visualization, the spatial control panel, and the microphone wiring) on top of four modules in [`src/addons/agenthands/`](../../src/addons/agenthands/):

- **World understanding** (`AgentWorld`): runs object detection, grounds each detection to a 3D point against the depth mesh, caches the result (persisted to local storage), and re-scans in the background as you move.
- **Response parser** (`buildGestureSteps` in `AgentGestures`): turns the reply's inline markup into an ordered, timed list of gesture steps, with each point target resolved to a world position.
- **TTS timestamp matcher** (`AgentSpeechConductor`): plays the gesture timeline and tightens it to the spoken words using the synthesizer's word boundaries.
- **Gesture animator** (`AgentGestureAnimator`): turns each step into hand movement (poses, motions, and pointing) and tracks which hand is pointing, for the pointer visualization and the orb's gaze.

## Gesture markup

The agent embeds markup inline in its reply, just before the word it emphasizes:

- `[gesture:NAME]` for a static pose, where NAME is `thumbs_up`, `thumbs_down`, `fist`, `victory`, `rock`, or `open`.
- `[wave]`, `[beat]`, `[size:small|big]`, and `[count:N]` for motions.
- `[point:LABEL]` to point at a detected object, where LABEL is one of the objects the last scan found.

## What it can and cannot do right now

It can hold a spoken conversation with synced gestures and point at real objects in the desktop simulator, and the same code runs in a headset.

It is a deliberately smaller system than the paper. The per-hand gesture state machine is simpler and there are fewer gesture types. Timing comes from TTS word boundaries rather than the paper's per-word energy model. Pointing relies on the depth mesh and 2D detection rather than a full scene mesh, so grounding is a single point per object rather than the paper's region-level oriented boxes. Where the paper registers objects one at a time in a dedicated mode, this demo detects the whole room in a single pass and keeps re-grounding in the background as you move, so grounding stays current without a manual step, at the cost of being coarser. There is no user-gaze input yet: the orb gazes at what it points at, but the demo does not read where you look. Most of the tuning happened in the simulator, so the in-headset path is wired but less exercised.

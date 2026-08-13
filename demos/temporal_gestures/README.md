# Temporal Gestures

Combines completed head gestures with temporal hand recognition. An XR-visible,
world-space UIBlocks panel reports head, left-hand, and right-hand results with
confidence and diagnostics. The demo explicitly enables the built-in
`thumbs-up`, `shoo`, and `beckon` gestures. Each hand row shows all active
results, with at most one recognized gesture active per hand.

Serve the repository and open:

```txt
http://localhost:8080/demos/temporal_gestures/?formFactor=desktop
```

For a standalone XR device, serve the repository from an HTTPS origin the
headset can reach and open `/demos/temporal_gestures/` without the desktop query
parameter, then enter immersive mode.

The UIBlocks dashboard is placed in world space instead of following the
headset. Point at its expanded manipulation margin, select, and drag to move it;
it remains wherever you release it.

The simulator starts in Hands mode. Select **Open Palm** in the pose bar. For
`shoo`, keep the fingers horizontal and click-drag left/right to rotate the
wrist back and forth. To `beckon` (signal “come here”), keep the hand's
wrist-to-knuckle axis roughly upright and rock the wrist away from and back
toward upright. Press `T` to switch the active hand. Nod or shake with mouse
look after switching to Navigation mode.

On an XR device, open the demo and enter immersive mode. To `shoo`, keep an open
palm's wrist-to-fingers axis horizontal and rotate the wrist side to side. To
`beckon`, point the wrist-to-knuckle axis up and rock it away from and back
toward upright; the hand may be open, curled, or closed and may face any
direction. Make one clear direction change and avoid moving the whole arm. For
`thumbs-up`, match the natural slightly angled thumb tilt shown by the
simulator's Thumbs Up pose (within roughly 20 degrees on either side) and curl
every other finger; a sideways or partly open pose is intentionally rejected.
Minor, slow palm drift is tolerated, while a wave-sized adjacent movement still
suppresses thumbs-up. A strong thumbs-up pose is excluded from beckon. The
floating panel follows the gesture's actual event lifecycle and clears on
`gestureend`; it does not add a display-only hold. The demo applies
headset-oriented profiles (6-degree beckon and 10-degree shoo strokes, brief
pose-dropout tolerance, and relaxed speed/translation gates) through
`setGestureConfig()`; the SDK's built-in temporal defaults remain conservative.
After beckon completes, fresh angular travel in a rolling 400 ms window keeps
the same detection active across repeated relaxed strokes. Once motion stops,
the normal short completion hold expires and the result clears.

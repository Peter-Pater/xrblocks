# VRM Avatar — XRBlocks Demo

A point-to-walk VRM avatar demo built on [XRBlocks](https://github.com/google/xrblocks). Click (or pinch in XR) anywhere on the floor and the avatar walks there, then returns to idle. Spring bones, facial expressions, and Mixamo animation retargeting all work out of the box.

![Demo: point-to-walk avatar in XRBlocks simulator]()

---

## What it does

- Loads any `.vrm` file using `@pixiv/three-vrm`
- Retargets Mixamo FBX animations onto the VRM humanoid skeleton
- Crossfades between idle and walk animations
- Walks the avatar to a floor point selected by the user via controller ray or mouse click
- Procedural eye blink using VRM expression manager
- Works in the XRBlocks desktop simulator and in WebXR

---

## Project structure

```
demos/vrm-avatar/
  index.html          — entry point, import map, scene setup
  VRMAvatar.js        — utility class: VRM load, animation, blink, update()
  VRMAvatarScript.js  — xb.Script subclass: scene lifecycle, point-to-walk
  models/             — place your .vrm file here
  animations/         — place your Mixamo .fbx files here
```

---

## Assets required

This demo comes with the following assets:

| File | Source |
|---|---|
| `https://cdn.jsdelivr.net/gh/pixiv/three-vrm@3.5.1/packages/three-vrm-animation/examples/models/VRM1_Constraint_Twist_Sample.vrm` | [three-vrm releases](https://github.com/pixiv/three-vrm/releases) — sample model |
| `animations/Idle.fbx` | [Mixamo](https://www.mixamo.com/) — free, no character needed |
| `animations/Walking.fbx` | [Mixamo](https://www.mixamo.com/) — free, no character needed |

For additional Mixamo animation downloads: select any animation, choose **Without Skin**, export as **FBX for Unity (.fbx)**.

---

## Key implementation notes

**Why not `xb.ModelViewer`?**
`VRMLoaderPlugin` must be registered on the `GLTFLoader` instance before the load call. `xb.ModelViewer` is a display container with no loader injection point, so `GLTFLoader` is used directly.

**Mixamo retargeting**
`VRMAvatar.js` includes a full `MIXAMO_VRM_RIG_MAP` (sourced from the three-vrm examples) and a `retargetMixamoClip()` function that remaps bone names and corrects rest-pose rotations. Root motion on the hips X/Z axes is zeroed out to prevent position drift on loop.

**Depth mesh floor detection**
On device, `onSelectEnd` raycasts against `xb.core.depth.depthMesh` for accurate floor hits. When depth mesh is not enabled, it falls back to intersecting the y=0 ground plane.

---

## Known gaps

- **`.vrma` format** — `@pixiv/three-vrm-animation` (VRM Animation format) is not used. Mixamo FBX retargeting is sufficient for walk/idle.
- **First-person mode** — VRM first-person metadata (head mesh hiding) is not configured.
- **MToon** — MToon anime-style materials load correctly at `three@0.182.0` but may render as standard material fallback on some devices.
- **Quest test** — simulator tested and working. Depth sensing is enabled via `options.enableDepth()` using the standard WebXR Depth Sensing API, which Quest 3 supports, but on-device testing has not been done yet.

---

## Dependencies

| Package | Version | Source |
|---|---|---|
| `three` | `0.182.0` | CDN |
| `@pixiv/three-vrm` | `^3` | CDN |
| `xrblocks` | `0.12.0` | Local build |
| `xrblocks/addons/` | `0.12.0` | Local build |

All other dependencies (troika, rapier3d, lit) are CDN — see the import map in `index.html`.

---

## Next steps

- Extract `VRMAvatar.js` into `src/addons/vrm/` as a proper XRBlocks addon with TypeScript types
- Integrate `@pixiv/three-vrm-animation` for `.vrma` support and AI-driven expressions
- Connect to XRBlocks' Gemini integration for a conversational AI companion that navigates physical space using depth sensing and physics
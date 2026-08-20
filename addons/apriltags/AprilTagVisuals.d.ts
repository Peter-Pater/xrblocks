/**
 * The standard "the tag is really being tracked" overlay: a set of axes at the
 * tag's origin plus an outline square matching its printed size. Add the
 * returned group as a child of an {@link AprilTagTracker} and it rides the
 * anchor for free.
 *
 * Built from SOLID GEOMETRY -- cylinders and bars -- rather than the obvious
 * `THREE.AxesHelper` + `THREE.LineLoop`, for two reasons:
 *
 *  1. **Line primitives cannot be thickened.** WebGL ignores
 *     `LineBasicMaterial.linewidth`; every line draws exactly one pixel wide
 *     whatever the value. At the distance you actually stand from a printed
 *     tag to check whether tracking has locked on, a 1 px overlay is a barely
 *     visible hairline -- the opposite of what a confidence indicator is for.
 *  2. **Line primitives raycast with a 1 METRE default threshold.** An overlay
 *     sitting exactly where the user points would otherwise swallow every
 *     pointer ray within a metre of the tag, stealing clicks from UI behind
 *     it. Meshes have tight bounds, and everything here additionally opts out
 *     of raycasting entirely.
 */
import * as THREE from 'three';
/** Tuning for {@link createAprilTagAnchorVisuals}. */
export interface AprilTagAnchorVisualsOptions {
    /**
     * Printed edge length of the tag in metres, which the outline square
     * matches. @defaultValue {@link DEFAULT_TAG25H9_SIZE_METERS}
     */
    tagSizeMeters?: number;
    /** Length of each axis arm in metres. @defaultValue 0.12 */
    axisLengthMeters?: number;
    /** Radius of each axis arm in metres. @defaultValue 0.005 */
    axisRadiusMeters?: number;
    /** Edge thickness of the outline square in metres. @defaultValue 0.008 */
    outlineThicknessMeters?: number;
    /** Outline square colour. @defaultValue 0xffffff */
    outlineColor?: THREE.ColorRepresentation;
}
/**
 * A tag overlay group. `dispose()` releases its geometries and materials, and
 * matters for any caller that builds a fresh tracker per calibration session:
 * three.js does not free GPU resources when an object leaves the scene graph.
 */
export interface AprilTagAnchorVisuals extends THREE.Group {
    dispose(): void;
}
/**
 * Builds the axes + outline overlay for a tracked AprilTag.
 *
 * @param options See {@link AprilTagAnchorVisualsOptions}.
 * @returns A group to add as a child of an `AprilTagTracker`.
 */
export declare function createAprilTagAnchorVisuals(options?: AprilTagAnchorVisualsOptions): AprilTagAnchorVisuals;

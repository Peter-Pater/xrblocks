/** The AprilTag family supported by this addon. */
const APRILTAG_FAMILY = 'tag25h9';
/** First valid ID in the tag25h9 family. */
const TAG25H9_MIN_ID = 0;
/** Last valid ID in the tag25h9 family (35 tags total). */
const TAG25H9_MAX_ID = 34;
/** Default tag selected by the demo. */
const DEFAULT_TAG25H9_ID = 17;
/**
 * Physical width of the black-and-white tag code, excluding the surrounding
 * white paper margin. This is the 155.6 mm "tag size" from the printed tag.
 */
const DEFAULT_TAG25H9_SIZE_METERS = 0.1556;

export { APRILTAG_FAMILY, DEFAULT_TAG25H9_ID, DEFAULT_TAG25H9_SIZE_METERS, TAG25H9_MAX_ID, TAG25H9_MIN_ID };

import { ROOM_HEIGHT } from './world';

/** Shared parameters for ceiling lamps and cached light transported through doors. */
export const CEILING_LIGHT = { color: 0xfff5d7, intensity: 14, distance: 18, angle: 1.28, penumbra: .65, height: ROOM_HEIGHT - .015 };

// Broad static diffuse light is integrated over the visible panel. The remaining
// spot contribution retains live ball shadows and specular highlights.
export const SPOT_LIGHT_SHARE = .45;

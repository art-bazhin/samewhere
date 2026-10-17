import { CEILING_TILE_SIZE, ROOM_HEIGHT } from './world';

/** Shared parameters for ceiling lamps and cached light transported through doors. */
export const CEILING_LIGHT = { color: 0xfff5d7, intensity: 14, distance: 18, angle: 1.28, penumbra: .65, height: ROOM_HEIGHT - .015 };
export const CEILING_PANEL_SIZE = CEILING_TILE_SIZE - .05;

// Broad static diffuse light is integrated over the visible panel. The remaining
// spot contribution retains live ball shadows and specular highlights.
export const SPOT_LIGHT_SHARE = .45;

/** Same deterministic area-light probes for local and neighboring illumination. */
export function ceilingPanelSamples(lamp: { x: number; z: number }) {
  return Array.from({ length: 9 }, (_, i) => ({
    x: lamp.x + (i % 3 - 1) * CEILING_PANEL_SIZE / 3,
    y: CEILING_LIGHT.height, z: lamp.z + (Math.floor(i / 3) - 1) * CEILING_PANEL_SIZE / 3,
  }));
}

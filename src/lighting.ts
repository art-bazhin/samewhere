import { CEILING_TILE_SIZE, ROOM_HEIGHT, ROOM_IDS, ROOMS, type RoomId, type Vec2 } from './world';

/** Shared parameters for ceiling lamps and cached light transported through doors. */
export const CEILING_LIGHT = { color: 0xfff5d7, intensity: 25, distance: 20, angle: 1.28, penumbra: .65, height: ROOM_HEIGHT - .015 };
export const CEILING_GRID_WIDTH = .024;
export const CEILING_PANEL_SIZE = CEILING_TILE_SIZE - CEILING_GRID_WIDTH;
export const ROOM_FILL_LIGHT = { hemisphere: .24, ambient: .016, environment: .12 };

/** Fixtures and all lighting calculations share the pedestal-aligned positions. */
export interface CeilingLamp extends Vec2 { distance: number }
export const ROOM_LIGHTS = Object.fromEntries(ROOM_IDS.map(room =>
  [room, ROOMS[room].pedestals.map(({ x, z }) => ({ x, z,
    distance: room === 'G' ? (z === 0 ? 5 : 15) : CEILING_LIGHT.distance,
  }))])) as Record<RoomId, CeilingLamp[]>;

// Broad static diffuse light is integrated over the visible panel. The remaining
// spot contribution retains live shadows. Balls and carpet use environment
// reflections rather than highlights from only the current room's spots.
export const SPOT_LIGHT_SHARE = .45;

/** Same deterministic area-light probes for local and neighboring illumination. */
export function ceilingPanelSamples(lamp: CeilingLamp) {
  return Array.from({ length: 9 }, (_, i) => ({
    x: lamp.x + (i % 3 - 1) * CEILING_PANEL_SIZE / 3,
    y: CEILING_LIGHT.height, z: lamp.z + (Math.floor(i / 3) - 1) * CEILING_PANEL_SIZE / 3, distance: lamp.distance,
  }));
}

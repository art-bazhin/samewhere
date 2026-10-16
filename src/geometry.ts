/** Shared XZ footprints for room meshes, miniatures, and collision boundaries. */
export interface Vec2 { x: number; z: number }
export interface WallFrame { a: Vec2; b: Vec2; center: Vec2; normal: Vec2; width: number; portal: number | null }

export function regularOutline(sides: number, apothem: number): Vec2[] {
  const radius = apothem / Math.cos(Math.PI / sides);
  return Array.from({ length: sides }, (_, side) => {
    const angle = (side - .5) * Math.PI * 2 / sides;
    return { x: Math.sin(angle) * radius, z: -Math.cos(angle) * radius };
  });
}
export function yOutline(length: number, halfWidth: number): Vec2[] {
  return [0, 1, 2].flatMap(arm => {
    const angle = arm * Math.PI * 2 / 3, x = Math.sin(angle), z = -Math.cos(angle);
    const notch = angle + Math.PI / 3, radius = halfWidth / Math.sin(Math.PI / 3);
    return [
      { x: x * length + z * halfWidth, z: z * length - x * halfWidth },
      { x: x * length - z * halfWidth, z: z * length + x * halfWidth },
      { x: Math.sin(notch) * radius, z: -Math.cos(notch) * radius },
    ];
  });
}
export function crossOutline(length: number, halfWidth: number): Vec2[] {
  const l = length, w = halfWidth;
  return [[-w, -l], [w, -l], [w, -w], [l, -w], [l, w], [w, w], [w, l], [-w, l], [-w, w], [-l, w], [-l, -w], [-w, -w]].map(([x, z]) => ({ x, z }));
}
export function hOutline(length: number, legCenter: number, halfWidth: number): Vec2[] {
  const l = length, a = legCenter + halfWidth, b = legCenter - halfWidth, w = halfWidth;
  return [[-a, -l], [-b, -l], [-b, -w], [b, -w], [b, -l], [a, -l], [a, l], [b, l], [b, w], [-b, w], [-b, l], [-a, l]].map(([x, z]) => ({ x, z }));
}
export function outlineWalls(outline: Vec2[], portals: number[]): WallFrame[] {
  return outline.map((a, index) => {
    const b = outline[(index + 1) % outline.length], dx = b.x - a.x, dz = b.z - a.z, width = Math.hypot(dx, dz);
    const side = portals.indexOf(index);
    return { a, b, center: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, normal: { x: dz / width, z: -dx / width }, width, portal: side < 0 ? null : side };
  });
}
export function offsetOutline(outline: Vec2[], distance: number): Vec2[] {
  const walls = outlineWalls(outline, []);
  return outline.map((point, index) => {
    const a = walls[(index + walls.length - 1) % walls.length].normal, b = walls[index].normal;
    const scale = distance / (1 + a.x * b.x + a.z * b.z);
    return { x: point.x + (a.x + b.x) * scale, z: point.z + (a.z + b.z) * scale };
  });
}
export function closestOnSegment(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz)));
  return { x: a.x + dx * t, z: a.z + dz * t };
}
export function insideOutline(point: Vec2, outline: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i], b = outline[j];
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

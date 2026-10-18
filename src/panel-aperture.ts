import { CEILING_LIGHT, CEILING_PANEL_SIZE } from './lighting';
import { DOOR_HEIGHT, DOOR_WIDTH, WALL_THICKNESS } from './world';

/** Fraction of a horizontal square diffuser visible through a thick doorway.
 * Included after directRecord(). Clip the emitter itself, rather than blurring
 * its projected shadow: penumbrae then widen with receiver/occluder separation.
 * For each edge, the nearer wall face is tighter when the receiver is outside
 * that edge; otherwise the farther face is tighter. Three cuts cover both faces. */
export const PANEL_APERTURE_SHADER = `
float directPanelVisibility(int light, vec3 point) {
  vec4 frame = directRecord(light, 1);
  vec2 lamp = directRecord(light, 0).xy, tangent = vec2(-frame.y, frame.x);
  float receiver = dot(point.xz, frame.xy), direction = dot(lamp, frame.xy) - receiver;
  if (abs(direction) < .000001) return 1.;
  float signDirection = sign(direction);
  vec2 faces = signDirection * (vec2(frame.z - ${(WALL_THICKNESS / 2).toFixed(6)}, frame.z + ${(WALL_THICKNESS / 2).toFixed(6)}) - receiver);
  float farFace = max(faces.x, faces.y), nearFace = min(faces.x, faces.y);
  if (farFace <= .000001 || nearFace >= abs(direction)) return 1.;
  if (nearFace <= .000001) nearFace = farFace;

  vec2 u = directRecord(light, 6).xy * ${(.5 * CEILING_PANEL_SIZE).toFixed(6)}, v = vec2(-u.y, u.x);
  float lateral = dot(point.xz, tangent) - frame.w;
  vec3 normalStep = vec3(signDirection * dot(u, frame.xy), signDirection * dot(v, frame.xy), abs(direction));
  vec3 lateralStep = vec3(dot(u, tangent), dot(v, tangent), dot(lamp - point.xz, tangent));
  float halfWidth = ${(DOOR_WIDTH / 2).toFixed(6)};
  vec3 cuts[3];
  cuts[0] = (halfWidth + lateral) * normalStep + (lateral < -halfWidth ? nearFace : farFace) * lateralStep;
  cuts[1] = (halfWidth - lateral) * normalStep - (lateral > halfWidth ? nearFace : farFace) * lateralStep;
  cuts[2] = (${DOOR_HEIGHT.toFixed(6)} - point.y) * normalStep
    - vec3(0., 0., (${CEILING_LIGHT.height.toFixed(6)} - point.y) * (point.y > ${DOOR_HEIGHT.toFixed(6)} ? nearFace : farFace));

  // Coordinates on the square emitter, in [-1,1]. A convex square clipped by
  // three planes has at most seven vertices, including rotated panel layouts.
  vec2 polygon[8];
  polygon[0] = vec2(-1., -1.); polygon[1] = vec2(1., -1.);
  polygon[2] = vec2(1., 1.); polygon[3] = vec2(-1., 1.);
  int count = 4;
  for (int edge = 0; edge < 3; edge++) {
    vec3 line = cuts[edge]; float extent = abs(line.x) + abs(line.y);
    if (line.z >= extent) continue;
    if (line.z <= -extent) return 0.;
    vec2 clipped[8]; int nextCount = 0;
    vec2 previous = polygon[count - 1]; float previousDistance = dot(line, vec3(previous, 1.));
    for (int vertex = 0; vertex < 8; vertex++) {
      if (vertex >= count) break;
      vec2 current = polygon[vertex]; float distance = dot(line, vec3(current, 1.));
      // Strict crossings avoid duplicating an emitter corner lying on the cut.
      if ((previousDistance < 0. && distance > 0.) || (previousDistance > 0. && distance < 0.))
        clipped[nextCount++] = mix(previous, current, previousDistance / (previousDistance - distance));
      if (distance >= 0.) clipped[nextCount++] = current;
      previous = current; previousDistance = distance;
    }
    if (nextCount < 3) return 0.;
    for (int vertex = 0; vertex < 8; vertex++) { if (vertex >= nextCount) break; polygon[vertex] = clipped[vertex]; }
    count = nextCount;
  }
  float twiceArea = 0.; vec2 previous = polygon[count - 1];
  for (int vertex = 0; vertex < 8; vertex++) {
    if (vertex >= count) break;
    vec2 current = polygon[vertex]; twiceArea += previous.x * current.y - previous.y * current.x; previous = current;
  }
  return clamp(abs(twiceArea) * .125, 0., 1.);
}
`;

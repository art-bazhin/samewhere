import * as THREE from 'three';
import { DOOR_WIDTH, roomOutline, type PassageGoal } from './world';

/** Marker ink is part of the wall's albedo, sharing its relief and baked light. */
export function passageMarking(base: THREE.MeshStandardMaterial, goal: PassageGoal) {
  const material = base.clone(), shown = { value: 0 };
  const outline = roomOutline(goal.to), extent = Math.max(...outline.flatMap(p => [Math.abs(p.x), Math.abs(p.z)]));
  const irregularity = goal.to === 'F' ? .4 : 1;
  const points = outline.map((p, i) => new THREE.Vector2(p.x / extent * .22 + Math.sin(i * 17 + .5) * .009 * irregularity,
    -p.z / extent * .22 + Math.cos(i * 13 + .7) * .009 * irregularity));
  const vector = (p: THREE.Vector2) => `vec2(${p.x.toFixed(6)}, ${p.y.toFixed(6)})`;
  const strokes = points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    const start = a.clone().lerp(b, -.025 - .012 * Math.sin(i * 7));
    const end = b.clone().lerp(a, -.03 - .012 * Math.cos(i * 11));
    return `inkDistance = min(inkDistance, markerStroke(p, ${vector(start)}, ${vector(end)}));`;
  }).join('\n');
  const color = new THREE.Color(goal.color === 'red' ? 0xc92530 : 0x2466c9);
  const compile = base.onBeforeCompile.bind(base), key = base.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer); shader.uniforms.passageMarkingShown = shown;
    shader.vertexShader = 'varying vec3 markingPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n markingPosition = position;');
    shader.fragmentShader = `uniform float passageMarkingShown; varying vec3 markingPosition;
      float markerStroke(vec2 p, vec2 a, vec2 b) {
        vec2 edge = b - a; float strokeLength = length(edge);
        vec2 direction = edge / strokeLength;
        float along = dot(p - a, direction), t = clamp(along / strokeLength, 0., 1.);
        float wobble = sin(t * 3.141593) * (.0045 + .002 * sin(t * 9. + a.y * 17.)) * ${irregularity.toFixed(6)};
        float across = dot(p - a, vec2(-direction.y, direction.x)) - wobble;
        float width = .006 * (1. + .2 * sin(t * 5. + a.x * 19.) + .08 * sin(t * 23. + a.y * 11.));
        // Keep the chisel tip's flat cuts, with slightly rounded corners.
        float cut = along - across * .35;
        float cornerRadius = .0015;
        vec2 d = vec2(abs(across) - width, max(-cut, cut - strokeLength)) + cornerRadius;
        return min(max(d.x, d.y), 0.) + length(max(d, vec2(0.))) - cornerRadius;
      }\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec2 p = markingPosition.xy - vec2(${(-DOOR_WIDTH / 2 - .4).toFixed(6)}, 1.65);
      float inkDistance = 100.; ${strokes}
      float inkAA = max(fwidth(inkDistance), .0001);
      float ink = passageMarkingShown * (1. - smoothstep(-inkAA, inkAA, inkDistance)) * step(-.0001, markingPosition.z);
      diffuseColor.rgb *= mix(vec3(1.), vec3(${color.r.toFixed(6)}, ${color.g.toFixed(6)}, ${color.b.toFixed(6)}), ink);`);
  };
  material.customProgramCacheKey = () => `${key}:passage-marking:${goal.to}:${goal.color}`;
  return { material, shown };
}

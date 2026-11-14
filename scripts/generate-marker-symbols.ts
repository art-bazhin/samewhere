import { readFile, writeFile } from 'node:fs/promises';
import { roomOutline, type RoomId } from '../src/world';

// Reuse the approved pen silhouettes, without rasterization or another smoothing pass.
// Run with: node --import tsx scripts/generate-marker-symbols.ts
type Point = [number, number];
type Curve = [Point, Point, Point, Point];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Point, s: number): Point => [a[0] * s, a[1] * s];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const lerp = (a: Point, b: Point, t: number) => add(mul(a, 1 - t), mul(b, t));
const reverse = (c: Curve) => [...c].reverse() as Curve;
const number = (n: number) => String(Math.round(n * 1000) / 1000);
const point = (p: Point) => p.map(number).join(' ');

function evaluate(c: Curve, t: number) {
  const s = 1 - t;
  return add(add(mul(c[0], s ** 3), mul(c[1], 3 * s * s * t)), add(mul(c[2], 3 * s * t * t), mul(c[3], t ** 3)));
}
function split(c: Curve, t: number): [Curve, Curve] {
  const a = lerp(c[0], c[1], t), b = lerp(c[1], c[2], t), d = lerp(c[2], c[3], t);
  const e = lerp(a, b, t), f = lerp(b, d, t), p = lerp(e, f, t);
  return [[c[0], a, e, p], [p, f, d, c[3]]];
}
function parameter(c: Curve, axis: number, value: number) {
  let low = 0, high = 1;
  const increasing = c[3][axis] >= c[0][axis];
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if ((evaluate(c, middle)[axis] < value) === increasing) low = middle; else high = middle;
  }
  return (low + high) / 2;
}
function contours(svg: string) {
  const paths = svg.match(/\sd="([^"]+)"/)![1].match(/M[^M]*Z/g)!;
  return paths.map(path => {
    let previous: Point; const curves: Curve[] = [];
    for (const [, command, args] of path.matchAll(/([MC])([^MCZ]+)/g)) {
      const values = args.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      if (command === 'M') previous = values as Point;
      else {
        const curve: Curve = [previous!, values.slice(0, 2) as Point, values.slice(2, 4) as Point, values.slice(4) as Point];
        curves.push(curve); previous = curve[3];
      }
    }
    return curves;
  });
}
function crossings(curves: Curve[], axis: number, value: number) {
  return curves.filter(c => (c[0][axis] <= value && c[3][axis] > value) || (c[3][axis] <= value && c[0][axis] > value))
    .map(c => evaluate(c, parameter(c, axis, value))[1 - axis]).sort((a, b) => a - b);
}
function clip(curves: Curve[], low: number, high: number) {
  const result = curves.filter(c => c[3][0] > low && c[0][0] < high).map(c => {
    let part = c;
    if (part[0][0] < low) part = split(part, parameter(part, 0, low))[1];
    if (part[3][0] > high) part = split(part, parameter(part, 0, high))[0];
    return part;
  });
  if (!result.length || Math.abs(result[0][0][0] - low) > .001 || Math.abs(result.at(-1)![3][0] - high) > .001) throw new Error('Incomplete source stroke');
  for (let i = 1; i < result.length; i++) if (Math.hypot(...sub(result[i][0], result[i - 1][3])) > .001) throw new Error('Broken source contour');
  return result;
}

const source = await readFile(new URL('../src/assets/sources/hand-drawn-square.svg', import.meta.url), 'utf8');
const [outer, inner] = contours(source);
const [outerLeft, outerRight] = crossings(outer, 1, 600), [innerLeft, innerRight] = crossings(inner, 1, 600);
const [outerTop, outerBottom] = crossings(outer, 0, 600), [innerTop, innerBottom] = crossings(inner, 0, 600);
const left = (outerLeft + innerLeft) / 2, right = (outerRight + innerRight) / 2;
const top = (outerTop + innerTop) / 2, bottom = (outerBottom + innerBottom) / 2;
const referenceSide = ((right - left) + (bottom - top)) / 2;
const frames: { origin: Point; direction: Point; normal: Point; length: number }[] = [
  { origin: [left, top], direction: [1, 0], normal: [0, 1], length: right - left },
  { origin: [right, top], direction: [0, 1], normal: [-1, 0], length: bottom - top },
  { origin: [right, bottom], direction: [-1, 0], normal: [0, -1], length: right - left },
  { origin: [left, bottom], direction: [0, -1], normal: [1, 0], length: bottom - top },
];
const profiles = frames.map(frame => [outer, inner].map(contour => contour.map(curve => curve.map(p => {
  const relative = sub(p, frame.origin); return [dot(relative, frame.direction), dot(relative, frame.normal)] as Point;
}) as Curve).filter(c => c.every(p => Math.abs(p[1]) < 55))
  .map(c => c[3][0] < c[0][0] ? reverse(c) : c).sort((a, b) => a[0][0] - b[0][0])));

function stroke(profile: number, length: number, variant: number) {
  const available = frames[profile].length - 80, used = Math.min(length, available);
  const low = 40 + (available - used) * ((variant * .38196601125 + .23) % 1), high = low + used;
  const boundaries = profiles[profile].map(curves => clip(curves, low, high));
  const startCenter = (boundaries[0][0][0][1] + boundaries[1][0][0][1]) / 2;
  const endCenter = (boundaries[0].at(-1)![3][1] + boundaries[1].at(-1)![3][1]) / 2;
  const tilt = (endCenter - startCenter) / used, extension = (length - used) / 2;
  // Crop along the line, retaining its full pen width. A long triangle edge only extends the tips slightly.
  return boundaries.map(curves => {
    const aligned = curves.map(c => c.map(([u, v]) => [u - low + extension, v - startCenter - (u - low) * tilt] as Point) as Curve);
    if (extension > .001) {
      const a = aligned[0], b = aligned.at(-1)!, start = a[0], end = b[3];
      const slopeA = (a[1][1] - start[1]) / (a[1][0] - start[0]), slopeB = (end[1] - b[2][1]) / (end[0] - b[2][0]);
      const handle = extension / 3;
      aligned.unshift([[0, start[1]], [handle, start[1]], [start[0] - handle, start[1] - slopeA * handle], start]);
      aligned.push([end, [end[0] + handle, end[1] + slopeB * handle], [length - handle, end[1]], [length, end[1]]]);
    }
    return aligned;
  });
}
function cap(a: Point, b: Point, slopeA: number, slopeB: number, sign: number): Curve[] {
  const radius = Math.abs(b[1] - a[1]) / 2, middle: Point = [a[0] + sign * radius, (a[1] + b[1]) / 2];
  const handle = radius * .5522847498, vertical = Math.sign(b[1] - a[1]);
  return [[a, [a[0] + sign * handle, a[1] + sign * slopeA * handle], [middle[0], middle[1] - vertical * handle], middle],
    [middle, [middle[0], middle[1] + vertical * handle], [b[0] + sign * handle, b[1] + sign * slopeB * handle], b]];
}
function straightenPentagonEdge(curves: Curve[], length: number): Curve[] {
  // Gently remove the source line's inward bow, keeping both pen boundaries and their joins together.
  const offset = (u: number) => -9 * 6.75 * (u / length) * (1 - u / length) ** 2;
  const slope = (u: number) => -9 * 6.75 / length * (1 - u / length) * (1 - 3 * u / length);
  return curves.map(([a, b, c, d]) => [
    [a[0], a[1] + offset(a[0])],
    [b[0], b[1] + offset(a[0]) + slope(a[0]) * (b[0] - a[0])],
    [c[0], c[1] + offset(d[0]) + slope(d[0]) * (c[0] - d[0])],
    [d[0], d[1] + offset(d[0])],
  ]);
}
const tangentSlope = (a: Point, b: Point) => (b[1] - a[1]) / (b[0] - a[0]);
const triangle = roomOutline('D'), roomSide = Math.hypot(triangle[1].x - triangle[0].x, triangle[1].z - triangle[0].z);
const pixelsPerRoomMeter = referenceSide / roomSide, pixelsPerMM = 8, gameScale = 4;
for (const [room, name] of [['D', 'triangle'], ['A', 'square'], ['B', 'pentagon']] as const) {
  const vertices = roomOutline(room).map(p => [p.x * pixelsPerRoomMeter, p.z * pixelsPerRoomMeter] as Point);
  const paths = vertices.map((a, i) => {
    const b = vertices[(i + 1) % vertices.length], edge = sub(b, a), length = Math.hypot(...edge), direction = mul(edge, 1 / length);
    const normal: Point = [-direction[1], direction[0]];
    const boundaries = stroke(i % 4, length, i + vertices.length);
    const [outside, inside] = room === 'B' && i === 0 ? boundaries.map(curves => straightenPentagonEdge(curves, length)) : boundaries;
    const oa = outside[0], ob = outside.at(-1)!, ia = inside[0], ib = inside.at(-1)!;
    const curves = [...outside, ...cap(ob[3], ib[3], tangentSlope(ob[2], ob[3]), tangentSlope(ib[2], ib[3]), 1),
      ...[...inside].reverse().map(reverse), ...cap(ia[0], oa[0], tangentSlope(ia[0], ia[1]), tangentSlope(oa[0], oa[1]), -1)];
    return curves.map(c => c.map(([u, v]) => {
      const position = add(a, add(mul(direction, u), mul(normal, v)));
      return room === 'A' ? position : mul(position, -1); // Triangle and pentagon point upward.
    }) as Curve);
  });
  const all = paths.flat(2), padding = 16;
  const minX = Math.floor(Math.min(...all.map(p => p[0]))) - padding, minY = Math.floor(Math.min(...all.map(p => p[1]))) - padding;
  const width = Math.ceil(Math.max(...all.map(p => p[0]))) + padding - minX, height = Math.ceil(Math.max(...all.map(p => p[1]))) + padding - minY;
  // Centre the ideal plan at the wall's established marking anchor, including the triangle's offset centroid.
  const extentX = Math.max(Math.abs(minX), Math.abs(minX + width)), extentY = Math.max(Math.abs(minY), Math.abs(minY + height));
  const canvasWidth = extentX * 2, canvasHeight = extentY * 2;
  const d = paths.map(curves => '  <path fill="#000" d="M' + point(add(curves[0][0], [extentX, extentY])) + curves.map(c => 'C' + c.slice(1).map(p => point(add(p, [extentX, extentY]))).join(' ')).join('') + 'Z"/>').join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${number(canvasWidth / pixelsPerMM)}mm" height="${number(canvasHeight / pixelsPerMM)}mm" viewBox="0 0 ${canvasWidth} ${canvasHeight}">\n  <desc>Room ${room} plan at the common room scale${room === 'A' ? '' : ', rotated 180 degrees to point upward'}. Curved filled pen strokes cut from sources/hand-drawn-square.svg; width and source contour detail preserved${room === 'B' ? ', with a gentle correction of the horizontal side\'s inward bow' : ''}. Generated by scripts/generate-marker-symbols.ts. 8 source pixels per mm; 4x in-game enlargement.</desc>\n${d}\n</svg>\n`;
  await writeFile(new URL(`../src/assets/${name}-marker.svg`, import.meta.url), svg);
  console.log(JSON.stringify({ room, name, sideMM: lengthOfSide(room) / pixelsPerMM * gameScale, widthMM: canvasWidth / pixelsPerMM * gameScale, heightMM: canvasHeight / pixelsPerMM * gameScale, paths: paths.length, cubicSegments: paths.flat().length }));
}
function lengthOfSide(room: RoomId) {
  const points = roomOutline(room); return Math.hypot(points[1].x - points[0].x, points[1].z - points[0].z) * pixelsPerRoomMeter;
}

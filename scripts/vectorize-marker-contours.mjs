import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Fit closed marker-ink contours to cubic Bezier curves. Keep the scan-derived input.
// Usage: node scripts/vectorize-marker-contours.mjs input.svg output.svg [sigma=3.5] [tolerance=1]
const [input, target, sigmaArgument = '3.5', toleranceArgument = '1'] = process.argv.slice(2);
const sigma = Number(sigmaArgument), tolerance = Number(toleranceArgument);
if (!input || !target || resolve(input) === resolve(target) || !Number.isFinite(sigma) || sigma <= 0 || !Number.isFinite(tolerance) || tolerance <= 0) {
  throw new Error('Expected different input/output SVG paths and positive smoothing/error values');
}
const svg = await readFile(input, 'utf8');
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const norm = a => { const length = Math.hypot(...a); return length ? mul(a, 1 / length) : [1, 0]; };
const distance = (a, b) => Math.hypot(...sub(a, b));
function resample(points) {
  const lengths = [0];
  for (let i = 0; i < points.length; i++) lengths.push(lengths.at(-1) + distance(points[i], points[(i + 1) % points.length]));
  const perimeter = lengths.at(-1), count = Math.max(12, Math.ceil(perimeter)), step = perimeter / count;
  const samples = []; let segment = 0;
  for (let i = 0; i < count; i++) {
    const along = i * step;
    while (lengths[segment + 1] < along) segment++;
    const t = (along - lengths[segment]) / (lengths[segment + 1] - lengths[segment]);
    samples.push(add(mul(points[segment], 1 - t), mul(points[(segment + 1) % points.length], t)));
  }
  // Smooth along arc length rather than rounding the original pixel vertices.
  const radius = Math.ceil(sigma * 3 / step), weights = [];
  for (let i = -radius; i <= radius; i++) weights.push(Math.exp(-.5 * (i * step / sigma) ** 2));
  const total = weights.reduce((a, b) => a + b, 0);
  return samples.map((_, i) => {
    let p = [0, 0];
    for (let j = -radius; j <= radius; j++) p = add(p, mul(samples[(i + j + count) % count], weights[j + radius] / total));
    return p;
  });
}
function evaluate(curve, t) {
  let p = curve;
  while (p.length > 1) p = p.slice(0, -1).map((point, i) => add(mul(point, 1 - t), mul(p[i + 1], t)));
  return p[0];
}
function parameters(points) {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u.at(-1) + distance(points[i - 1], points[i]));
  return u.map(value => value / u.at(-1));
}
function generate(points, u, left, right) {
  const start = points[0], end = points.at(-1);
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = u[i], s = 1 - t, b0 = s ** 3, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t ** 3;
    const a = mul(left, b1), b = mul(right, b2), delta = sub(points[i], add(mul(start, b0 + b1), mul(end, b2 + b3)));
    c00 += dot(a, a); c01 += dot(a, b); c11 += dot(b, b); x0 += dot(a, delta); x1 += dot(b, delta);
  }
  const determinant = c00 * c11 - c01 * c01;
  let alphaLeft = determinant ? (x0 * c11 - x1 * c01) / determinant : 0;
  let alphaRight = determinant ? (c00 * x1 - c01 * x0) / determinant : 0;
  const chord = distance(start, end);
  if (alphaLeft < chord * 1e-6 || alphaRight < chord * 1e-6) alphaLeft = alphaRight = chord / 3;
  return [start, add(start, mul(left, alphaLeft)), add(end, mul(right, alphaRight)), end];
}
function error(points, curve, u) {
  let maximum = 0, split = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const delta = sub(evaluate(curve, u[i]), points[i]), squared = dot(delta, delta);
    if (squared > maximum) { maximum = squared; split = i; }
  }
  return { maximum, split };
}
function reparameterize(points, curve, u) {
  const first = curve.slice(0, -1).map((p, i) => mul(sub(curve[i + 1], p), 3));
  const second = first.slice(0, -1).map((p, i) => mul(sub(first[i + 1], p), 2));
  return points.map((point, i) => {
    const p = evaluate(curve, u[i]), d = evaluate(first, u[i]), dd = evaluate(second, u[i]), delta = sub(p, point);
    const denominator = dot(d, d) + dot(delta, dd);
    return denominator ? Math.max(0, Math.min(1, u[i] - dot(delta, d) / denominator)) : u[i];
  });
}
function fit(points, left, right, tolerance = 1) {
  if (points.length === 2) {
    const handle = distance(points[0], points[1]) / 3;
    return [[points[0], add(points[0], mul(left, handle)), add(points[1], mul(right, handle)), points[1]]];
  }
  let u = parameters(points), curve = generate(points, u, left, right), result = error(points, curve, u);
  if (result.maximum <= tolerance * tolerance) return [curve];
  if (result.maximum <= tolerance * tolerance * 16) {
    for (let i = 0; i < 5; i++) {
      const next = reparameterize(points, curve, u);
      if (next.some((value, i) => i && value <= next[i - 1])) break;
      u = next; curve = generate(points, u, left, right); result = error(points, curve, u);
      if (result.maximum <= tolerance * tolerance) return [curve];
    }
  }
  const split = result.split, tangent = norm(sub(points[split - 1], points[split + 1]));
  return [...fit(points.slice(0, split + 1), left, tangent, tolerance), ...fit(points.slice(split), mul(tangent, -1), right, tolerance)];
}
const number = n => String(Math.round(n * 100) / 100), point = p => p.map(number).join(' ');
let originalVertices = 0, segments = 0;
let contourCount = 0;
const output = svg.replace(/(\sd=")([^"]+)(")/g, (_, prefix, source, suffix) => {
  if ((source.match(/[A-Za-z]/g) ?? []).some(command => !['M', 'L', 'Z'].includes(command))) {
    throw new Error('Input paths must contain closed absolute M/L/Z contours, before curve fitting');
  }
  const contours = source.match(/M[^M]*Z/g);
  if (!contours?.length || source.replace(/M[^M]*Z/g, '').trim()) throw new Error('Expected closed contours');
  contourCount += contours.length;
  return prefix + contours.map(contour => {
  const values = contour.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const raw = Array.from({ length: values.length / 2 }, (_, i) => values.slice(i * 2, i * 2 + 2));
  if (values.length % 2 || raw.length < 3) throw new Error('Each contour needs at least three coordinate pairs');
  originalVertices += raw.length;
  const points = resample(raw), middle = Math.floor(points.length / 2);
  const tangent = i => norm(sub(points[(i + 1) % points.length], points[(i + points.length - 1) % points.length]));
  const start = tangent(0), mid = tangent(middle);
  const curves = [...fit(points.slice(0, middle + 1), start, mul(mid, -1), tolerance),
    ...fit([...points.slice(middle), points[0]], mid, mul(start, -1), tolerance)];
  segments += curves.length;
  return `M${point(curves[0][0])}` + curves.map(curve => `C${point(curve[1])} ${point(curve[2])} ${point(curve[3])}`).join('') + 'Z';
  }).join('') + suffix;
});
if (!contourCount) throw new Error('No marker contours found');
await writeFile(target, output);
console.log(JSON.stringify({ contours: contourCount, originalVertices, cubicSegments: segments, bytes: output.length, sigma, tolerance }));

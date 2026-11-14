/** Encode signed distance from an RGBA alpha contour, with ink above 0.5. */
export function inkDistanceField(pixels: Uint8ClampedArray, width: number, height: number, radius = 8) {
  const outside = new Float64Array(width * height), inside = new Float64Array(width * height);
  for (let i = 0; i < outside.length; i++) {
    const alpha = pixels[i * 4 + 3] / 255;
    outside[i] = alpha === 0 ? 1e20 : Math.max(0, .5 - alpha) ** 2;
    inside[i] = alpha === 1 ? 1e20 : Math.max(0, alpha - .5) ** 2;
  }
  const length = Math.max(width, height), samples = new Float64Array(length);
  const sites = new Uint32Array(length), breaks = new Float64Array(length + 1);
  function transform(grid: Float64Array, offset: number, stride: number, count: number) {
    for (let q = 0; q < count; q++) samples[q] = grid[offset + q * stride];
    let k = 0;
    sites[0] = 0; breaks[0] = -Infinity; breaks[1] = Infinity;
    // The lower envelope of squared-distance parabolas gives the exact 1D transform.
    for (let q = 1; q < count; q++) {
      let split: number;
      for (;;) {
        const p = sites[k];
        split = (samples[q] - samples[p] + q * q - p * p) / (2 * (q - p));
        if (split > breaks[k]) break;
        k--;
      }
      sites[++k] = q; breaks[k] = split; breaks[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < count; q++) {
      while (breaks[k + 1] < q) k++;
      const delta = q - sites[k];
      grid[offset + q * stride] = delta * delta + samples[sites[k]];
    }
  }
  for (const grid of [outside, inside]) {
    for (let x = 0; x < width; x++) transform(grid, x, width, height);
    for (let y = 0; y < height; y++) transform(grid, y * width, 1, width);
  }
  const result = new Uint8Array(width * height);
  for (let i = 0; i < result.length; i++) {
    const distance = Math.sqrt(outside[i]) - Math.sqrt(inside[i]);
    result[i] = Math.round(255 * Math.max(0, Math.min(1, .5 - distance / (2 * radius))));
  }
  return result;
}

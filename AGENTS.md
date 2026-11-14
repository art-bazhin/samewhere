# Commits

All commits must follow Conventional Commits:

`<type>[optional scope][!]: <description>`

- Use `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert` as the type.
- Keep the description concise and describe the actual change.
- Mark breaking changes with `!` or a `BREAKING CHANGE:` footer.

Examples: `feat: implement the Samewhere prototype`, `fix(portals): preserve image resolution`, `docs: update controls`.

# Lighting data

Vite automatically generates the lighting binary for `npm run build` and `npm run dev`. Its cache key follows the bake script's transitive local imports and the dependency lockfile; relevant edits during development regenerate the data and reload the game. Keep new bake dependencies reachable through imports. After changes to geometry, lighting or baking, verify generation with the fast development bake and proportionate checks. Do not edit or commit generated lighting files.

Development uses coarser reflector cells in convex rooms and for distant doorway bounce, while retaining fine cells at concave visibility boundaries and additional floor refinement at wall joins and near pedestals. Production uses full precision throughout. CPU baking runs in parallel before play; room connections use the prepared data at runtime. Draft/full cache keys and assets are separate. Run `npm run build` or any full production bake only when the user explicitly requests a production build. A request to commit does not authorize a production build. When a production build is requested, check subtle lighting artifacts with `npm run preview`.

# Hand-drawn wall artwork

The user approved the handwritten starting message and wants the same treatment for future hand-drawn wall symbols. Preserve their actual handwriting, uneven marker width, proportions, and intentional asymmetry. The final SVG itself must have clean cubic Bezier contours, including when inspected outside the game. Shader antialiasing and short rounded joins on a noisy pixel outline do not replace vectorization.

Approved workflow:

1. Extract the scan at its original resolution. Apply the requested rotation, remove paper/grid/binding, and isolate the actual ink. Keep an original contour SVG as a separate input. For the starting message, the three lines were joined at their baselines, reconnecting `somewhe` + `re` without a word space.
2. Trace closed ink outlines, including holes, as absolute `M/L/Z` paths. Retain variable thickness in the filled silhouettes rather than imposing a constant stroke width.
3. Resample each closed contour uniformly at about one source-pixel interval. Smooth positions along arc length with a circular Gaussian, sigma **3.5 source pixels**, then fit cubic Bezier segments with **1 source pixel maximum fitting error**. Shared endpoint tangents keep joins smooth. These are the approved scan's parameters; adapt them proportionally for other scan resolutions and marker widths, preserving intentional corners.
4. Run `node scripts/vectorize-marker-contours.mjs input.svg output.svg [sigma=3.5] [tolerance=1]`. This dependency-free offline tool preserves the input and SVG dimensions. It accepts closed absolute `M/L/Z` contours and produces `M/C/Z` curves. Never repeatedly smooth an already fitted SVG.
5. Preserve the SVG's physical dimensions and placement; choose any in-game enlargement separately. The reference scan used 2262 pixels along A5's 210 mm edge. Its composed message is 434.854 by 30.265 mm, enlarged 4x in the game. Do not assume this scale or enlargement for new symbols without the user's dimensions.
6. Inspect the SVG itself at high magnification, especially bends, stroke ends, crossings, and holes. Compare its silhouette and ink area with the source. The approved message retained about 96.1% silhouette overlap and 99.7% of the ink area, using 474 cubic segments instead of 6124 traced vertices; these are reference measurements, not mandatory targets for other artwork.
7. Check the game at normal distance, the closest legal wall distance (22 cm), and an oblique angle, including DPR 1.5. The approved first `t` must have a smooth lower bend with no scan-induced spur.

Reference asset: `src/assets/starting-message.svg`. The original unsmoothed contour input is available with `git show 477d440:src/assets/starting-message.svg > /tmp/marker-contours.svg`.

Runtime rendering is separate: `src/starting-message.ts` rasterizes the clean SVG up to 4096 pixels wide, capped by GPU limits; `src/ink-distance-field.ts` builds a single-channel signed-distance mask once during preparation, and the wall shader reconstructs its edge with `fwidth`/`smoothstep`. Keep the wall's existing relief and lighting. Future symbols should use the same clean vector source and preserve their gameplay color and visibility rules.

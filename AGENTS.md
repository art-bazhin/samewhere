# Commits

All commits must follow Conventional Commits:

`<type>[optional scope][!]: <description>`

- Use `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert` as the type.
- Keep the description concise and describe the actual change.
- Mark breaking changes with `!` or a `BREAKING CHANGE:` footer.

Examples: `feat: implement the Samewhere prototype`, `fix(portals): preserve image resolution`, `docs: update controls`.

# Lighting data

Vite automatically generates the lighting binary for `npm run build` and `npm run dev`. Its cache key follows the bake script's transitive local imports and the dependency lockfile; relevant edits during development regenerate the data and reload the game. Keep new bake dependencies reachable through imports. After changes to geometry, lighting or baking, verify generation with the fast development bake and proportionate checks. Do not edit or commit generated lighting files.

Development uses a fast draft bake; production builds use full precision. Their cache keys and assets are separate. Run `npm run build` or any full production bake only when the user explicitly requests a production build. A request to commit does not authorize a production build. When a production build is requested, check subtle lighting artifacts with `npm run preview`.

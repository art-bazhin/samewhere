# GameAnalytics

The official JavaScript SDK is loaded asynchronously on the first analytics event. Network submission requires both SDK ingestion keys and a production build. Local Vite development and `?dev=1` never send gameplay data to GameAnalytics. Missing keys, blocked requests, and SDK failures do not prevent play.

## Configuration

Create a Samewhere game in GameAnalytics with platform **Browser** and SDK **JavaScript**. For the current GitHub Pages distribution, choose **Other** as the store; **itch.io** is appropriate for a release there.

Copy `.env.example` to `.env.local` and fill in:

```dotenv
VITE_GAMEANALYTICS_GAME_KEY=your_sdk_game_key
VITE_GAMEANALYTICS_SECRET_KEY=your_sdk_secret_key
```

`.env.local` is ignored by Git. These are the game's event-ingestion credentials, not account or administrative API tokens. Both SDK keys are included in the downloadable browser bundle, as required by the browser SDK.

For GitHub Pages, set repository or `github-pages` environment secrets named `GAMEANALYTICS_GAME_KEY` and `GAMEANALYTICS_SECRET_KEY`. The existing deployment workflow supplies them to Vite. Configuring these secrets does not deploy the game; deployment remains a manual workflow action.

For a manually prepared itch.io build, the local environment variables supply the SDK keys. Both itch.io and GitHub Pages use the shared game version as GameAnalytics' Build. There is no build override or Git-derived identifier. Local Vite development never sends data.

Official references: [JavaScript setup](https://docs.gameanalytics.com/event-tracking-and-integrations/sdks-and-collection-api/open-source-sdks/javascript/), [Design events](https://docs.gameanalytics.com/events-metrics-and-filtering/event-types/design-events/).

## Shared game version

`GAME_VERSION` in [src/version.ts](../src/version.ts) is the single version used by the save, its analytics checkpoint, event names and the SDK's Build. It is currently **2**: saves and checkpoints contain `version: 2`, events start with `v2:`, and Build is `2`.

Increment it when a game or analytics change should reset progress and begin a separate analytics cohort. Cosmetic updates can keep the same version. On loading a save with a different or missing version, the game deletes that save and offers a new game with fresh progress, music milestones and active time. Mouse sensitivity and the SDK's own browser storage are left intact. There is no migration or aliasing of old event names; previously submitted events remain in GameAnalytics under their original names and Build.

## Player-facing notice

Use the English text in [ANALYTICS.txt](../public/ANALYTICS.txt) for the itch.io page's analytics notice. It describes gameplay and session data, the generated player identifier, technical information and browser storage, and links to GameAnalytics' privacy notice. Vite also copies this file to the root of `dist/` so it travels with the game.

## Milestones

Each milestone sends one Design event:

```text
v2:<milestone>
```

The numeric `value` is cumulative active time since the beginning of this run, rounded down to completed whole seconds. Clock readings and loaded accumulated time are rounded down to whole milliseconds; rounding readings rather than each frame's duration avoids accumulating rounding errors across checkpoints. Dynamic measurements are never part of an event identifier.

Room labels describe their shapes: `3` triangle, `4` square, `5` pentagon, `6` hexagon, `X` cross, `Y` three-way room, and `H` hub. A label always identifies the room itself, including in `symbol_room` events, regardless of the symbol drawn there.

| Milestone | Trigger |
| --- | --- |
| `run_started` | First successful pointer capture for a new game |
| `room_3_visited` | First presence in the triangular room |
| `room_4_visited` | First presence in the square room; includes the starting position |
| `room_5_visited` | First presence in the pentagonal room |
| `room_6_visited` | First presence in the hexagonal room |
| `room_X_visited` | First presence in the cross-shaped room |
| `room_Y_visited` | First presence in the Y-shaped room |
| `room_H_visited` | First presence in the H-shaped hub |
| `symbol_connection_5_opened` | Complete H socket 3 → room 5 in red |
| `symbol_connection_Y_opened` | Complete room 5 socket 2 → room Y in blue, after the first goal |
| `symbol_connection_4_opened` | Complete room Y socket 1 → room 4 in red, after the second goal |
| `symbol_room_5_visited` | First presence in room 5 after its Y drawing appears |
| `symbol_room_Y_visited` | First presence in room Y after its square drawing appears |
| `symbol_room_4_visited` | First presence in room 4 after the four final drawings appear; also the music milestone for returning to the square room |
| `all_balls_in_4` | After the entire symbol chain is completed, player is in room 4 and every ball is either held or in a socket in room 4. Earlier experimental collection does not mark or consume this milestone. |
| `room_4_pattern_completed` | Correct simultaneous four-ball pattern completed inside room 4 after the entire symbol chain |
| `game_completed` | Entry into the white space, before the ending animation |

Socket indices in the triggers above start at zero.

There are 17 first-occurrence milestones, or 17 Design events in a complete run. `run_resumed` additionally sends one event with cumulative active seconds on the first successful resume after a page reload. Opening and closing the pause menu does not send more resume events. Automatic SDK lifecycle events are additional.

Milestones follow actual game state, without enforcing an analytics-only order. A drawing visit is recorded even if a drawing becomes active while the player is already in that room. Presence in a room measures access to a clue, not whether the player noticed or understood it. Initial visits to rooms 5, 3, and H already cover the first three music milestones. The initial drawing in the hub is covered by `room_H_visited`.

## Timing and persistence

Active time includes thinking while stationary. Menus, hidden tabs, loading, and the ending animation are excluded.

The save contains a small `analytics` checkpoint: the shared game version, accumulated whole milliseconds, and a bounded list of reached milestone names. Resuming a compatible save preserves the timer and deduplication; `NEW GAME` and `PLAY AGAIN` reset them. Unknown checkpoint milestone names are individually discarded while valid names and active time survive. Invalid timing or structurally damaged analytics metadata is ignored without discarding the saved world; missing timing metadata does not invent a new start time for an ongoing run. An incompatible save version resets the entire saved run as described above.

The SDK separately manages its generated player identifier and offline event queue in browser storage. SDK 5.0.0 bounds its event/session storage at approximately 2,000 entries. Our initialization queue is limited to 128 events in memory. Delivery is best-effort; the game never waits for telemetry.

## Reports and verification

Use milestone event counts to build funnels and their numeric averages for cumulative active time in seconds. Subtract cumulative values for per-stage comparisons, keeping the same population when comparing means: players who never reach a later milestone must not be included only in the earlier mean. Use the built-in build filter to compare releases. A player may start multiple runs, so timing measurements count milestone occurrences; interpret user-level conversion reports accordingly.

After deployment, start a fresh game and verify `run_started` and `room_4_visited` in GameAnalytics Live Events, followed by `room_5_visited` on reaching the pentagonal room. Then pause, reload, and resume: the previously reached milestones should not repeat, while `run_resumed` retains active time. Browser tests intercept all GameAnalytics requests using dummy credentials, including the real SDK's asynchronous session initialization, so tests do not populate the live game.

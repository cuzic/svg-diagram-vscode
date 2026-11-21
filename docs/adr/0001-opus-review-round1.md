# ADR 0001 review (Opus, round 1)

Target: docs/adr-0001-preview-source-link @ 1f9dc9426cefd65f31034ec9dd7bb995c684be16

## Conclusion
The core map is what the ADR says it is. I built 187 core examples with the 0.9.0 tarball (`build --out-dir --no-lint --locations-dir`, cwd = source dir, map in a far-away scratch dir like the preview). In every one, the map's `width`/`height` equal the SVG's `width`/`height` attributes and its `viewBox` (origin 0,0). The rects line up with the drawn `<rect>`s, including canvas/slide examples. The main SVG is the final reveal stage, so dropping `final: false` is correct. `loc.file` keeps the logical path through a symlinked directory. Three design gaps would ship wrong or broken behaviour, though: the connector hit rule uses a rect the map does not have, click ids have no generation, and the page-side path is untested in the form that ships. converged: no.

## Previous round
- (first round)

## Findings
### M1 (Major): "the connector's label is inside `rect`" plus connectors-first precedence sends ordinary clicks on boxes and group titles to the connector.
- Evidence: `connects[i].rect` is the bounding box of the whole route plus label (`lib/locations-map.ts:136-139`: `from`, `to`, every `pathSegments` box and the label box). The map has no separate label box. Repro (`connect('a:bottom','c:top',{route:'elbow',label:'go'})` with `c` inside `group(...,{title:'G'})`): the connector rect is `{x:237,y:97.6,w:236,h:65.4}`. It covers part of the group frame `{20,116,900,116}`, the group title caption `{36,132,868,21}` and the top of box `c` `{36,160,…}`. A click at (300,140) on the group title is 9.7px from the nearest segment, so it does not hit by distance. It does fall inside the connector rect, and D3 checks connectors first, so D3 picks the connector, not the group. ADR 0072 D6 (which D3 says it follows) has no connectors-first rule. It orders by smaller area, then later part.
- Fix: hit connectors only by distance to `segments`. Either ask core for a separate `labelRect` (chip/label box) and hit that too, or let a connector win only on the segment test and fall back to area order otherwise. Add a `hitTest` unit case where an elbow connector's bbox covers another part.

### M2 (Major): page→extension `reveal {id}` has no generation, so stale pages resolve ids against a newer table.
- Evidence: D2 makes ids "the index in the order sent" and keeps `loc` in the extension "looked up by `id`". Several current paths show an SVG whose map is not the extension's latest: (a) a failed rebuild keeps the old SVG on stage (`preview-html.ts:152-156`, "古い図"), while under D6 a failed build now writes a new map with `issues` (verified: overlap fixture → map with `issues` and the new layout's `parts`, exit 1, no SVG); (b) `retainContextWhenHidden: false` plus `vscode.getState().last` re-shows the persisted `svg` message (with its map) on reload or re-show (`preview-html.ts:167-169`, `preview.ts:44,63`), possibly before or without a new render; (c) a `svg` message for build N+1 can be in flight while the user clicks an id from build N; (d) after `follow()` to another source, a click from the old page arrives with an id that exists in the new table. Any of these opens a wrong line or a wrong file, silently.
- Fix: put a build token (e.g. a counter plus source URI) in the `svg` message and in `reveal`. The extension keeps the table for the token it last sent as `svg` and ignores a `reveal` whose token differs, or keeps the last few tables by token. State this for failed builds: the old SVG keeps the old table, and the `issues` of the failed map are only for D6's banner.

### M3 (Major): the page-side path (CTM conversion, fit/zoom, drag threshold, embedded `hitTest`) has no planned test in a real webview, and the "embed as a string" step differs in the shipped build.
- Evidence: the U1 test plan has unit tests for pure functions and an integration test that `reveal` selects the line. Nothing clicks the figure. `vscode-test` cannot click inside a webview, but the repo already has Playwright e2e that clicks preview controls (`e2e/extension.spec.ts:76-89`, `previewFrame`). D3 says `hitTest` is "a pure function … embedded in the page as a string". The natural form is `String(hitTest)`. Production builds use `minify: true` (`scripts/build.ts:17`), while unit, integration and e2e tests run unminified (`pnpm build`). If `hitTest` calls any module-level helper (distance to segment, area), the embedded text refers to a mangled name not present in the page. That throws a ReferenceError only in the VSIX.
- Fix: say how the page code is produced (`hitTest` self-contained with no outer references, or a separate esbuild bundle of the page script inlined under the nonce). Add an e2e case that clicks a box and a connector in fit mode and at a non-1 zoom, and checks the selection in the editor. Also add a drag case that must not jump. Run one test against the `--production` bundle.

### m1 (Minor): D1's version gate silently disables the feature for the documented core-checkout setup.
- Evidence: `cli.ts:4` documents `svgDiagram.cliPath` → `../svg-diagram/bin/svg-diagram` for trying a checkout. `packageOf` reads that checkout's `package.json`, and core `main` has `"version": "0.5.0"` while `build-diagram.ts:78-107` already supports `--locations`. Prerelease or dev versions (`0.9.0-rc.1`) also need a defined comparison. Windows is out of scope (`getCli` returns nothing on win32, `extension.ts:159`), so the `.cmd` shim case does not arise yet.
- Fix: gate on capability, not on the version alone. For example, when the version is below 0.9.0 or unknown, look for `--locations` in the usage text that `build` prints with no source (verified on 0.9.0: exit 2, usage lists `--locations FILE`; cache per bin + mtime), or answer Open question 1 with that probe. Name the comparison (semver, prerelease counts as the release).

### m2 (Minor): D6 understates what failed builds leave and does not give the `issues` shape.
- Evidence: the map is written with issues only if layout started and the error carries `laidOut` (`build-diagram.ts:174-180,288`). Import, syntax and `define()`/`diagram()` option errors delete the map (verified: an invalid `theme` → no map file). The XML-not-well-formed failure writes `issues: []` (`build-verdict.ts:11-14`, `details.issues ?? []`), so "if the map has `issues`, build the banner from them" yields an empty banner. Issue entries are `{file, rule, severity, message, line?, column?, location?: {file,line,column}, via?, related?}` (`lib/layout-issues.ts`). The position is `line`/`column` only when it is in the source; another file's position is under `location`, and `file` is map-relative. Also, the text output of a layout failure has no position on the detail line (overlap repro: `  "First" overlaps "Second" by 900x25px`), which is why D6 matters.
- Fix: in D6, say "non-empty `issues`", fall back to `buildErrorText` otherwise, spell out the issue shape and how `location`/`related` are resolved (from the map dir, like `loc.file`), and add a unit case for each.

### m3 (Minor): the shared-part claims in D5 and 結果 do not match what core emits.
- Evidence: core's `loc` is the innermost frame in the source being built (ADR 0072 D3). A part built inside `./_parts2.ts` and called from `shared.ts` resolves to `shared.ts:4:56` (the `pair()` call) for the row and both boxes. It is not in `_parts2.ts`. Another file's `loc` appears only when no frame of the source is on the stack.
- Fix: reword 結果 ("a part from a shared helper jumps to the call in this file"). Note that several parts can share one `loc`, which is the case for using `via` and label search as in check's placement, if wanted.

### m4 (Minor): the integration plan assumes an npm release and does not say how both cores run.
- Evidence: the fixture uses the GitHub release tarball (`test/fixtures/workspace/package.json:6`, `CORE_TARBALL` in `schemas.ts`), not npm (npm is still 0.5.0). U1 wants both "0.9.0 draws and reveals" and "0.8.0 does not get `--locations`" as integration tests, but there is one fixture workspace.
- Fix: depend on a v0.9.0 GitHub release asset. Cover the old-core case with a unit test on `buildArgs` plus a fake CLI (as the existing fake-CLI tests do), or add a second fixture.

### m5 (Minor): "open in `ViewColumn.One`" can cover the preview.
- Evidence: D4 says not to open in the preview's column but then fixes column One. The user may have moved the preview into column One.
- Fix: use the source's visible editor column if any, else the first column that is not `panel.viewColumn`.

### n1 (nit): hover titles will show internal labels.
- Evidence: parts carry labels like `(band)` and `group title "G"`, and kinds like `caption` for generated group titles (all seen in the maps). `title` on SVG elements needs a `<title>` child, not an attribute.
- Fix: hide `(band)` and `generated: true` labels, or show only `kind`. Use an HTML element or an SVG `<title>` for the tooltip.

### n2 (nit): validate the `reveal` message shape.
- Evidence: D8 says the extension looks the id up in its own table. If the table is an object, `"__proto__"` or `"constructor"` resolve.
- Fix: accept only `Number.isInteger(id)` within range (plus the token from M2). Take `getScreenCTM` from the stage's root `<svg>`, not from `event.target.ownerSVGElement` (icons and images can be nested `<svg>`).

## Verdict
converged: no (Blocker 0 / Major 3 / Minor 5 / nit 2)

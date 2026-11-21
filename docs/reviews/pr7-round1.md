# PR #7 review (Opus, round 1)

Target: feat/preview-source-link @ ba0001752790d522e1e9f07403ac7bab6d67f1d7

## Conclusion
converged: yes. Every U1 decision (D1–D5, D8) holds against the real v0.9.0 and v0.8.0 release tarballs, the production-minified bundle and CI's real VS Code runs. I found no case that jumps to a wrong line or file, leaks a path to the page, or breaks old cores. What remains are three Minors: clicks stay dead after a hidden-panel resync, a small window in the D5 version capture, and untested extension-side branches (D5 notice, column fallback, the post-await re-check). There is also one stale CI comment.

## Previous round
First round; no previous findings.

## What I tried (all held)
- D1 probe: the real v0.9.0 CLI prints `Usage: … [--locations FILE | --locations-dir DIR] …` on one stderr line with exit 2. `supportsBuildLocations` → true (243 ms cold, 0 ms cached). The real v0.8.0 tarball → false, then `buildArgs` without `--locations` draws normally, and the probe writes nothing into the project. bin/svg-diagram prefers `dist/build-diagram.js` exactly as `buildUsageKey` does, so the key follows the file the bin runs. Unit tests cover the key mtime and version, timeout and start failures not being cached, and `--locations` outside the usage line.
- D2 map intake: I built all 191 core v0.9.0 examples through `buildArgs(..., --locations)` and the PR's `readPreviewLocations`. All 187 that build (the 4 failures are missing icons or mathjax, identical without `--locations`) are accepted (`svgMatches` true), every target resolves inside the drawn source, and the centre of every part hits something. A symlinked project and a symlinked scratch dir both resolve to the path VS Code opened (core writes a lexical relative path).
- D2 token: `tableAfterMessage` keeps the table on `building` and `error` for the same file, and clears it on a source switch or an unmapped SVG. Page and extension both key on `shown.build` from the same `svg` message, so a mismatched page can only produce "図が新しくなった", never a wrong jump. After a reload, the new `buildSession` rejects the restored page's tokens.
- D3: `hitTest` is self-contained after `--production` (`function tt(t,{x:e,y:i},n){…Math…}` with no free identifiers). The unit test evaluates both the plain and the esbuild-minified page in `node:vm`. In CI, e2e rebuilds with `--production` in `beforeAll` and clicks the box and the connector at fit and at 200%. Connector-first precedence, the 5px tolerance via `1/hypot(a,b)` of the outer `<svg>`'s CTM, and smallest-area/later-on-tie selection all match the ADR.
- D4/D8: `revealTarget` rejects a wrong build token, non-integer or out-of-range ids, `'0'` and `__proto__`. A forged `file` field is ignored. Labels and kinds reach the page only through `textContent`, outline coordinates are validated finite numbers, and the CSP is unchanged. The page receives no paths beyond the existing `file` field.
- Fixture: `test/fixtures/workspace/package.json` and `CORE_TARBALL` point to the v0.9.0 release asset. The integration test asserts version 0.9.0 and the selection of `connect` (8:4–8:11) in column One beside a panel in column Two.

## Findings
### m1 (Minor): after the panel was hidden, clicks can stay dead ("図が新しくなった。もう一度押してください" on every click) until the next successful build
- Evidence (read; `retainContextWhenHidden: false`, src/preview.ts:50, :71): while the panel is hidden, `postMessage` is not delivered. Sequence: the preview tab is hidden, the source is saved and builds (svg N+1 with table N+1, page never receives it), then saved again and the build fails (`lastMessage` = error, table N+1 kept). When the tab is shown, the page restores `drawing` = svg N from `getState`, and `ready` re-posts only the error. The page draws N and sends `build` N; the extension holds N+1, so every click is refused with an instruction that cannot succeed. It fails safe (no wrong jump), and the stale drawing itself predates this PR.
- Fix: keep the last `svg` message the table belongs to, and on `ready` post it before `lastMessage` when `lastMessage` is not an `svg`.

### m2 (Minor): D5's `sourceVersion` is read after the probe await, not when the build was triggered
- Evidence: src/preview.ts:125 awaits `supportsBuildLocations` (up to 10 s on a cold probe), then reads `document.version` at :138. An edit typed during the probe is recorded as the drawn version, although the CLI draws the last saved text. If the next save's build then fails, the old table carries the edited version, `isDirty` is false and the versions match, so the jump gives no "保存前の位置です" notice while the lines may have moved.
- Fix: read `sourceVersion` synchronously at the top of `render()`, before any await.

### m3 (Minor): the extension-side branches of reveal have no test that fails under mutation
- Evidence (grep): no unit, integration or e2e test exercises "保存前の位置です", `isDirty`/`sourceVersion` mismatch, the "図が新しくなった" status, the `panel.viewColumn === One ? Two : One` fallback (the integration test always finds the source visible in One), or the `this.revealTable !== table` re-check after `openTextDocument`. Removing any of these leaves the suite green.
- Fix: add an integration case that edits the fixture without saving and clicks (asserting the selection plus the notice via a spy or the status bar), and one with the source not visible and the panel in One (asserting the editor lands in Two).

### n1 (nit): .github/workflows/ci.yml still says the fixture "runs core v0.8.0"
- Fix: say v0.9.0 (ci.yml was not on the task's file list, so either update it or note it for the next change).

## CI
`gh pr checks 7` on ba00017: test (typecheck, lint, 94 unit, `--production` build, integration with 20 passing, vsce package) and all 4 e2e jobs (ubuntu/macOS × 1.100.0/stable) pass. The new e2e case "box and connector clicks reveal source at fit and 200%, while a drag keeps the selection" passes in each job. Locally, `pnpm test` (94/94) and `pnpm typecheck` pass. No other open PRs.

## Verdict
converged: yes (Blocker 0 / Major 0 / Minor 3 / nit 1)

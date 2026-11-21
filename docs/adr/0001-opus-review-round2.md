# ADR 0001 review (Opus, round 2)

Target: docs/adr-0001-preview-source-link @ 9895e6bb6837b386f42b120224bea272cfac50d7

## Conclusion
The revision fixes all three Majors. Connectors are now hit only by distance to `segments`. I checked that these are the drawn polyline (`c.points` pairs, `lib/locations-map.ts:140-143`), and core has no curved routes (`Route = 'straight' | 'elbow' | 'loop-under' | 'loop-side'`). The build number plus "failed builds keep the old table" closes every stale path from round 1. The plan now runs a click/zoom/drag e2e against the `--production` bundle. Four Minor gaps remain, and I found no Blocker or Major. The most important Minor: the stated reason for `String(hitTest)` is false, because esbuild's minifier renames the function itself. Only the planned production e2e catches this; the vm unit test does not. converged: yes.

## Previous round
- M1 resolved: D3 drops the connector `rect` and hits connectors only by segment distance. Read core `connectionMap`: `segments` is the polyline, and there are no curve routes that would leave the drawn line more than 5px from it. The label-only click falls through to the part below, and the ADR says so.
- M2 resolved: `svg` carries `build`. The extension keeps only the table of the last `svg` it sent. A failed build does not replace it, `follow()` clears it, and `reveal` with another `build` is refused with a status message. I traced each round-1 path against `preview.ts`/`preview-html.ts`: (a) failed rebuild, (b) `getState().last` re-show plus the `ready` re-post (same N, same table), (c) in-flight `svg`, (d) `follow()`. Each one now resolves correctly or refuses. A tiny cross-session race remains (n1).
- M3 resolved as a test plan: production-bundle Playwright e2e at fit and 200%, box plus connector plus drag. But the embedding rule it relies on is wrong as written (m1).
- m1 partly resolved: the capability probe works. On 0.9.0, `svg-diagram build` with no source exits 2 and prints usage with `--locations FILE`. v0.4.0–v0.8.0 also print usage, exit 2 and write nothing, so the probe is safe on old cores. The cache key is wrong, though (m2).
- m2 resolved: the "non-empty `issues`" rule and the fallback are stated. The shape matches `lib/layout-issues.ts` (`related` entries are full `{file,line,column}`, `via` is `{line,column}` only). The page plumbing for failed builds is missing (m4).
- m3 resolved: 背景 and 結果 now say a shared helper's part jumps to the call in this source, and that several parts can share one `loc`.
- m4 resolved in plan: v0.9.0 GitHub release tarball, old core covered by a fake-CLI unit test. Note that no v0.9.0 release exists yet (`gh release list`: latest is v0.8.0). Publishing it is a prerequisite of U1.
- m5 resolved: the column is the one where the file is already visible, else the first column that is not `panel.viewColumn`. If that column does not exist yet, `showTextDocument` creates a group, so it never covers the preview.
- n1 resolved: no label for `generated: true` or `(band)`, and the tooltip is an HTML element filled via `textContent`.
- n2 resolved: integer/range check on `id` plus `build`. CTM from the stage's outermost `<svg>`.

## Findings
### m1 (Minor): `String(hitTest)` does not survive the production minifier, so the D3 rationale is false and the planned vm unit test cannot catch it.
- Evidence: ran it. I bundled a self-contained `export function hitTest(...)` plus a function returning `` `<script>${String(hitTest)}; hitTest(...)</script>` `` with the repo's esbuild settings (`--bundle --format=cjs --platform=node --target=node22 --minify`, as `scripts/build.ts:17` does for `--production`). The output is `<script>function u(n,t){...}; ... hitTest(...)`. The declaration is renamed to `u`, so a page script calling `hitTest` throws ReferenceError, on hover and on click, only in the VSIX. Under `node --test` (Node type stripping), `String(hitTest)` keeps the name and evaluates fine in `node:vm`. So the D3 unit test of "the embedded string" passes while the shipped page is broken. `keepNames` does not help: it adds `__name(u,"hitTest")` outside the function text. Only the production e2e in U1 would catch it.
- Fix: in D3, bind by expression, `const hitTest = (${String(hitTest)});`, so the page never depends on the declared name. Make the vm unit test evaluate a minified form, e.g. `esbuild.transform(String(hitTest), {minify: true})` or the `--production` bundle's `previewShellHtml` output, rather than the stripped source.

### m2 (Minor): D1 caches the probe by "CLI path + its mtime". The `--locations` flag lives in `build-diagram`, not in `bin/svg-diagram`, so the cache goes stale in exactly the core-checkout case D1 exists for.
- Evidence: in core, `bin/svg-diagram` last changed in c6c9005, before `--locations` landed in f77ad28 (`git merge-base --is-ancestor` confirms). A `git pull`/`checkout` across f77ad28 in a `cliPath` checkout leaves the bin's mtime unchanged. Going forward, the cached "no" keeps the feature off. Going back, a cached "yes" is worse: the pre-f77ad28 parser (same as v0.8.0, `build-diagram.ts` `modules` filter) treats `--locations <file>` as two more modules and exits 2 with `--out only makes sense with exactly one input module`. Every preview then fails with a misleading banner until reload. The ADR also does not say whether the cache persists across sessions, or whether a timed-out or aborted probe is cached as "no" (a cold run took 4.5s here, then 0.25s warm).
- Fix: key the cache on the resolved package (realpath of `cli.root`, its `package.json` version, and the mtime of `dist/build-diagram.js` or `build-diagram.ts`). Keep it in memory only, and do not cache a probe that timed out or was aborted. Optionally drop the cached "yes" and re-probe when a build with `--locations` exits 2 with usage-like stderr.

### m3 (Minor): ids are "the array index", but parts and connects are two arrays and `reveal` carries no discriminator.
- Evidence: D2 says parts are sent as `{id, kind, label?, rect}` and connects as `{id, kind: 'connect', segments}`, "`id` は配列の番号", and the extension keeps "部品ごとの `loc`・`via` の配列". D4's message is `{kind: 'reveal', build, id}`. Read literally, connector 0 and part 0 share id 0, so a connector click opens part 0's line. The U1 unit list has no case for "a connector id resolves to the connector's `loc`". Only the e2e connector click would show it, and only if the two `loc`s differ in the fixture.
- Fix: state one id space: one table where parts come first, then connects, with indices taken after the `final: false` filter (or say the ids are pre-filter indices). Add a unit case where part *i* and connector *i* have different `loc`s.

### m4 (Minor): D6 needs the failed build's number and issue rows on the page, but D2 adds `build` only to `svg` and keeps only the last `svg`'s table.
- Evidence: `ToPage.error` is `{kind, title, file, message}` (`preview-html.ts:71`). D6's `{kind: 'revealIssue', build, index}` needs the page to know the failed build's `build` and which banner rows have positions. The extension also has to keep the failed build's `issues`, but D2 says it keeps "最後に送った `svg` の回の表だけ". On reload, `getState().last` is the `error` message, so whatever goes there must also be enough to re-render clickable rows.
- Fix: in D6 (U2), add `build` and `issues?: {text, hasPosition}[]` (or similar) to the `error` message. State that the extension keeps two tables, the last `svg` one for `reveal` and the last failed one for `revealIssue`, each checked against its own `build`.

### n1 (nit): the build counter restarts with the extension host, while the page can show a persisted `svg` from the previous session.
- Evidence: after a window reload, the page shows `getState().last` (say `build: 1` from the old session) before the new host's first `svg` (also `build: 1`) is processed. A click in that window resolves against the new table. The window is tiny, because the new `svg` replaces the stage on arrival.
- Fix: make the token `{session nonce, counter}` (e.g. random per `PreviewManager`), or start the counter from a random value.

### n2 (nit): D2 says "ページはファイルのパスを知らない", but the `svg`, `building` and `error` messages already carry the absolute `file` (`preview.ts:127`, `preview-html.ts:69-71`, used by the page to clear foreign drawings).
- Evidence: read the code.
- Fix: reword to "the page never sends a path, only the extension resolves `loc.file`". That is the property D8 needs.

## Verdict
converged: yes (Blocker 0 / Major 0 / Minor 4 / nit 2)

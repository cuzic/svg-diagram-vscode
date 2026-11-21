# PR #4 review (Opus, round 1)

Target: feat/finding-locations @ 399ad0dda79e2f0e133850145dcb2823bde9aa88

## Conclusion

The PR does what Issue #3 and the decisions comment ask, and matches core's contract (ADR 0072 D1/D5, `check-diagram.ts` `CheckFinding`, and the `related` shape in core PR #417). I found no wrong squiggles in normal use. The column becomes an identifier range in UTF-16 units, which is what V8 and VS Code both use. CRLF, tabs, Japanese text and surrogate pairs before the column, `d.connect` (marks `connect`) and Japanese identifiers all land correctly. `location`, `via` and `related` resolve against the check's cwd, which is the source's directory: core prints them relative to that cwd, or keeps the given path for the checked source. Old core output (no column, no location) behaves as before: the existing unit tests are unchanged and pass, and the 0.8.0 integration tests pass. `src/check.ts` and `src/preview-html.ts` still import no `vscode`.

The integration test with the fake CLI runs. CI run 44887867660 on this SHA lists both new tests as passing. I also ran the whole integration suite locally, headless (`--ozone-platform=headless` via a scratch config, not committed): 18 passing. The `NOT RUN (integration)` mutation (drop `relatedInformation`) is caught. So are two more mutations: an off-by-one in the related `Position`, and not passing the workspace folder to `buildErrorText`.

What remains is three Minor and three nit. None of them blocks a merge.

How I checked:
- typecheck, lint, unit (68), `build --production`: all pass.
- `gh pr checks 4`: test and all 4 e2e jobs pass.
- I ran real core (main @ 2dd0a1b) `check --format json` and `build` on probe sources outside the repo, and fed the output through `placeFinding` and `buildErrorText`.
- Unit mutations, each caught: the band search ignoring `location`, column → whole line, dropping the `指摘箇所` related entry, dropping the location from the message, and the old shape keeping the path. One mutation survived (n2).

## Previous round

None (first round).

## Findings

### Minor

**m1. A column past the end of the line gives an empty squiggle beyond the text instead of falling back to the whole line.** `src/check.ts` L97-100.
`placeFinding({line: 1, column: 50}, 'box()')` gives `start 49, end 50`. VS Code clamps that to a zero-width mark at the end of the line. This happens whenever the text the extension reads is not the text the CLI checked:
- "この図を検査" on a dirty editor (the CLI reads the disk, `textOf` reads the open document);
- a file edited outside the editor (the README already lists this as a known limit).

The line was robust to this before, because it marked the whole line. Suggestion: when `f.column - 1 >= s.length`, use the existing whole-line branch, and add a unit test for it.

```ts
    if (f.column && f.column >= 1 && f.column - 1 < s.length) {
```

**m2. The integration test leaves `test/fixtures/workspace/.vscode/settings.json` (`{}`) in the working tree.** `test/integration/activation.test.ts` L23-35.
`config.update('cliPath', …, WorkspaceFolder)` creates the folder settings file, and restoring `undefined` empties it but does not delete it. After a local `pnpm test:integration`, `git status` shows `?? test/fixtures/workspace/.vscode/`. A `git add -A` would commit it, against the AGENTS.md rule to keep temporary files out of the repo.

There is also a worse case. If a run is killed inside `withLocationCli`, the file keeps `"svgDiagram.cliPath": "./finding-locations-cli.sh"`. Every later run then sends the 0.8.0 tests to the fake CLI, and they fail in a confusing way.

Suggestion: delete the file in `finally` when it did not exist before the test, or add `test/fixtures/workspace/.vscode/` to `.gitignore`. At least do the ignore, so that a stale file is obvious.

**m3. A failed layout check in the preview banner shows the scratch path and none of the problems.** `src/preview-html.ts` L14-16. This is pre-existing (main does the same), not a regression.
With real core main, `build --no-lint` of an overlapping figure prints:

```
✗ <src>: build(<scratch>/layout.svg): layout verification failed before any SVG was written:
  connect(a:right -> b:left) label "…" overlaps its own end "左" by 50x24px (…)
```

`buildErrorText` keeps only the `✗` line. The banner therefore reads `build(/…/scratch/…/layout.svg): layout verification failed before any SVG was written:`. That is the extension's own scratch directory, with a trailing colon and no detail.

Once core attaches a location to this error, the same-file rule makes it worse: it gives `…written:（5 行目）`. Layout failures are the most common reason for a stale preview. The issue asked for the banner to follow the new `✗` forms, and the multi-line block is the form it does not handle.

Suggestion (it can be a follow-up issue): keep the indented continuation lines that follow a `✗` line, and drop the `build(<out>): ` prefix. The `check`-style block (`✗ <src>:` followed by `  <loc>: <msg>` lines, U3a) would then also read well, if `build` ever prints it. Today it would show the bare absolute path `<src>:`.

### nit

**n1.** For a thrown error, V8's column is the `new` of `throw new Error(…)`, so the squiggle covers `new`. This follows the spec's "identifier at the column" rule and is harmless. If you want the squiggle on `Error`, skip a leading `new `.

**n2.** The `‌|‍` alternatives in the identifier regex (L99) can be removed and no test fails. Add a one-line test, or drop them (`\p{ID_Continue}` does not include ZWNJ/ZWJ, so keeping them is correct).

**n3.** `relatedInformation` trusts `line`/`column` ≥ 1 (`src/diagnostics.ts` L185). A related entry with `line: 0`, or a missing `column` (NaN), would make `new vscode.Position` throw, and that throw ends the whole `run` loop for the batch. Core's `SourceLoc` guarantees both fields are present, so this is defensive only. Filtering out entries without positive integers would cost one line. In the same way, `findingMessage` prints `q.ts:2:undefined` for a location without a column.

## Verdict

converged: yes (Blocker 0 / Major 0 / Minor 3 / nit 3)

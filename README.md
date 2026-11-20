# svg-diagram for VS Code

[svg-diagram](https://github.com/cuzic/svg-diagram) の図のソース（`diagrams/*.ts`、JSON spec）を、VS Code の中で書く・検査する・プレビューするための拡張。

> 開発中（0.0.x）。今は雛形だけで、機能はまだない。

## 方針

- core（`svg-diagram`）は同梱しない。案件の `node_modules/.bin/svg-diagram`、設定したパス、PATH の順に探して、CLI を子プロセスで呼ぶ。
- core の公開 API（`exports`、CLI の `--format json`、`data-node`）だけを使う。足りない機能は core 側の PR で足す。

## 起動する条件

ワークスペースに次のどちらかがあるとき。

- `node_modules/svg-diagram/package.json`
- `.svg-diagram.json`（どこの階層でもよい）

## 開発

    pnpm install
    pnpm build          # dist/extension.cjs（--watch で監視）
    pnpm typecheck && pnpm lint && pnpm test
    pnpm test:integration   # 本物の VS Code を落として動かす（画面が要る。CI では xvfb-run）
    pnpm package        # .vsix を作る

VS Code で開いて F5（「拡張を起動」）を押すと、`test/fixtures/workspace` を開いた別ウィンドウで拡張が動く。

core を手元で変えながら試すときは、拡張の設定で CLI のパスを `../svg-diagram/bin/svg-diagram` に向ける（Phase 0 の 3 で入れる）。

## ロードマップ

1. 雛形（これ）
2. CI
3. core（CLI）の見つけ方
4. `check --format json` → Problems パネル
5. ライブプレビュー
6. JSON spec の JSON Schema（core の PR が先）
7. ステータスバー・`init` / `typecheck` のコマンド
8. 以降: ソース位置（core の ADR）、プレビュー ⇄ ソースのジャンプ、Quick Fix、Markdown、差分、AI 連携、公開

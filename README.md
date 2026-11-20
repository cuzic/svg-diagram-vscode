# svg-diagram for VS Code

[svg-diagram](https://github.com/cuzic/svg-diagram) の図のソース（`diagrams/*.ts`、JSON spec）を、VS Code の中で書く・検査する・プレビューするための拡張。

> 開発中（0.0.x）。今は検査（「問題」パネル）とライブプレビューまで。

## 方針

- core（`svg-diagram`）は同梱しない。CLI を子プロセスで呼ぶ。探す順は、設定 `svgDiagram.cliPath` → 案件の `node_modules/svg-diagram`（親のフォルダへもさかのぼる）→ `PATH`。コマンド「svg-diagram: 使う CLI の場所と版を表示」で確かめられる。
- 案件の node_modules にあるコードを実行するので、信頼したワークスペースでだけ動く（Restricted Mode では起動しない）。
- core の公開 API（`exports`、CLI の `--format json`、`data-node`）だけを使う。足りない機能は core 側の PR で足す。

## 検査（`check`）

図のソース（`from 'svg-diagram'` を import している `.ts` / `.mts` / `.js` / `.mjs`）を開いたとき・保存したときに `svg-diagram check --format json` を走らせ、所見を「問題」パネルに出す。

- error → エラー、warn → 警告、info → 情報。コードはルール名（`a11y-no-title` など）。CLI が直し方（`data.fix`）を返すときは、メッセージの 2 行目に出す。
- 行番号を返すのは今は文書の検査（`doc-*`）だけ。レイアウトの所見は、帯の見出し（`data.band`）がソースの文字列に 1 回だけ現れればそこに、なければ 1 行目に付く（core がソースの位置を返すようになったら直す）。
- core 0.5.0 以前は、ソースが throw すると JSON を出さずに止まる。そのときは stderr から、throw した行に `build-error` を付ける。
- コマンド: 「svg-diagram: この図を検査」「svg-diagram: ワークスペースの図をすべて検査」。
- 設定: `svgDiagram.check.enabled` / `check.onSave` / `check.onOpen`（どれも既定 true）。

## プレビュー

図のソースを開いて、エディタ右上のプレビューのボタン、`Ctrl+K V`（Mac は `Cmd+K V`）、またはコマンド「svg-diagram: プレビューを横に開く」。

- `svg-diagram build <ソース> --out <拡張の作業用フォルダ> --no-lint` で描く。**案件には何も書き出さない**（`svg/` の SVG は変わらない）。lint は飛ばす（所見は「問題」パネルに出る）。
- 保存したときに描き直す。同じフォルダの `.ts` / `.js` / `.json`（共通部品や設定）を保存したときも描き直す。
- プレビューは 1 枚で、アクティブなエディタの図のソースに付いていく。
- 描けなかったときは、前に描けた図を残したまま「古い図」と表示し、理由（throw した行など）を上に出す。
- 表示: 幅に合わせる / 拡大・縮小 / 原寸、背景（白・暗・格子）。VS Code を再読み込みしても開き直す。
- SVG は Webview に直接埋め込む（Phase 2 で、クリックしたノードからソースへ飛ぶため）。CSP でネットワークと、SVG 内のスクリプトは止めている。

## 起動する条件

ワークスペースに次のどちらかがあるとき。

- `node_modules/svg-diagram/package.json`
- `.svg-diagram.json`（どこの階層でもよい）
- TypeScript / JavaScript のファイルを開いたとき（CLI が PATH や設定にだけある案件のため。svg-diagram と関係ない案件では、ログに 1 行出すだけで何もしない）

## 開発

    pnpm install
    pnpm build          # dist/extension.cjs（--watch で監視）
    pnpm typecheck && pnpm lint && pnpm test
    (cd test/fixtures/workspace && npm install --no-package-lock)   # 結合テストが使う core 0.5.0
    pnpm test:integration   # 本物の VS Code を落として動かす（画面が要る。CI では xvfb-run）
    pnpm package        # .vsix を作る

VS Code で開いて F5（「拡張を起動」）を押すと、`test/fixtures/workspace` を開いた別ウィンドウで拡張が動く。

core を手元で変えながら試すときは、設定 `svgDiagram.cliPath` を `../svg-diagram/bin/svg-diagram` に向ける（案件のものより優先される）。

## ロードマップ

1. 雛形（済）
2. CI（済）
3. core（CLI）の見つけ方（済）
4. `check --format json` → Problems パネル（済）
5. ライブプレビュー（済）
6. JSON spec の JSON Schema（core の PR が先）
7. ステータスバー・`init` / `typecheck` のコマンド
8. 以降: ソース位置（core の ADR）、プレビュー ⇄ ソースのジャンプ、Quick Fix、Markdown、差分、AI 連携、公開

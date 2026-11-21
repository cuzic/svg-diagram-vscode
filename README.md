# svg-diagram for VS Code

[svg-diagram](https://github.com/cuzic/svg-diagram) の図のソース（`diagrams/*.ts`、JSON spec）を、VS Code の中で書く・検査する・プレビューするための拡張。

> 開発中（0.0.x）。Phase 1（検査・プレビュー・導入・型検査・ステータスバー）まで。JSON spec の Schema は core の PR 待ち。

## 対応する環境

- Linux / macOS、および Windows の WSL（Remote - WSL）。**Windows では動かない**（core の CLI `bin/svg-diagram` が bash のスクリプトのため）。起動はするが、CLI を使う操作は理由を出して止まる（JSON の補完と検査は効く）。
- VS Code 1.100 以降。信頼したワークスペースだけ。

## 方針

- core（`svg-diagram`）は同梱しない。CLI を子プロセスで呼ぶ。探す順は、設定 `svgDiagram.cliPath` → 案件の `node_modules/svg-diagram`（図のソースのディレクトリから上へさかのぼる。monorepo の下のパッケージにだけ入っていても見つかる）→ `PATH`。コマンド「svg-diagram: 使う CLI の場所と版を表示」で確かめられる。
- 案件の node_modules にあるコードを実行するので、信頼したワークスペースでだけ動く（Restricted Mode では起動しない）。
- core の公開 API（`exports`、CLI の `--format json`、`data-node`）だけを使う。足りない機能は core 側の PR で足す。

## 検査（`check`）

図のソース（`from 'svg-diagram'` を import し、`export default` がある `.ts` / `.mts` / `.js` / `.mjs`）を開いたとき・保存したときに `svg-diagram check --format json` を走らせ、所見を「問題」パネルに出す。

- 共通部品のモジュール（svg-diagram を import するが `export default` が無い）は図ではないので、検査もプレビューもしない。
- 同じディレクトリのファイルをまとめて 1 回の CLI で検査し、cwd はそのディレクトリ（`.svg-diagram.json` はそこから上へ探される）。
- 検査中に 1 つのファイルを保存しても、他のファイルの検査は止めない（そのファイルだけ新しい結果を使う）。
- 同時に走らせる CLI は CPU コア数の半分まで。保存・開いたときの 1 件の検査は、「すべて検査」の待ち行列より先に走る。
- 「すべて検査」は `node_modules` と `files.exclude` を除く（波括弧を含むパターンは使えないので無視する）。
- 共通部品や `.svg-diagram.json` を保存すると、同じワークスペースフォルダで開いている図のソースを検査し直す。
- わかっている限界: 開いたままのファイルがエディタの外（git checkout など）で変わったとき、閉じているファイル（「すべて検査」の結果）が変わったときは、開き直すか保存するまで所見は古いまま。
- error → エラー、warn → 警告、info → 情報。コードはルール名（`a11y-no-title` など）。CLI が直し方（`data.fix`）を返すときは、メッセージの 2 行目に出す。
- core が行と桁を返すと、部品を呼び出した行の関数名に波線が付く。呼び出し元や重なりの相手の位置は「問題」パネルの関連情報に出る。共通部品など別のファイルに指摘箇所があるときは、図のソースの 1 行目に波線が付き、関連情報から指摘箇所へ移動できる。
- 行だけを返す所見は、その行に波線が付く。位置のない所見は、帯の見出し（`data.band`）がソースの文字列に 1 回だけ現れればそこに、なければ 1 行目に付く。
- ソースが throw したときは `build-error`。core 0.9.0 は JSON で throw した位置を返す。core 0.8.0 の JSON には位置が無いので 1 行目に付く。core 0.5.0 以前は stderr のスタックから throw した行に付ける。
- コマンド: 「svg-diagram: この図を検査」「svg-diagram: ワークスペースの図をすべて検査」。
- 設定: `svgDiagram.check.enabled` / `check.onSave` / `check.onOpen`（どれも既定 true）。

## JSON の補完と検査（JSON Schema）

`.svg-diagram.json`・`site.json`・デッキ（`deck.json`・`deck-*.json`・`*.deck.json`）を開くと、VS Code の JSON の補完・説明・誤りの表示が効く。部品の `type` は全種類から選べ、選ぶと説明と例のひな形が出る。`node_modules` の下のファイルは対象外。

- 使う JSON Schema は**案件の svg-diagram のもの**（`node_modules/svg-diagram/schema/`、core 0.8.0 以降。ADR 0071）。CLI の検査と同じ版で検査する。npm には 0.5.0 までしかないので、今はリリースの tarball から入れる: `pnpm add -D https://github.com/cuzic/svg-diagram/releases/download/v0.9.0/svg-diagram-0.9.0.tgz`（ビルド不要。npm でも同じ URL）。「この案件で svg-diagram を使えるようにする」は npm から入れるので 0.5.0 になり、JSON は検査しない。
- 案件の svg-diagram は、そのファイルから上の、ワークスペースフォルダの中の `node_modules/svg-diagram`。設定 `svgDiagram.cliPath`（ワークスペース・フォルダの設定）があればそれ。`PATH` の svg-diagram、ユーザー設定の `svgDiagram.cliPath`、フォルダの外の `node_modules` のものは、そのファイルから上に `.svg-diagram.json` があるときだけ使う（なければ、案件の `node_modules` のもの）。
- **ウィンドウで 1 つの JSON Schema を使う**（VS Code は schema を、どのファイルのためかを言わずに求めるので）。開いている対象の JSON ファイル（`site.json`・デッキ・`.svg-diagram.json`）の案件の svg-diagram が、みな同じ schema のとき（同じ core を別のパスから使う pnpm のモノレポ、同じ版を入れた別のフォルダも同じ）に、それで検査する。svg-diagram と関係ない案件のファイルや、schema の違う svg-diagram の案件のファイルが一緒に開いているときは、どれも検査しない（関係ないファイルに誤りを出さないため。どちらかを閉じると検査する。ほかの拡張がタブなしで読んだファイルは、数分で閉じられる）。git の差分の片側のようにファイルでないものは、そのパスのファイルとして数える（ワークスペースの外のパスなら、どの案件か分からないので検査しない）。どれも開いていなければ、svg-diagram のあるワークスペースフォルダがみな同じ schema のとき、それ。
- 関係ない案件のファイルを開いた直後の一瞬（0.1 秒ほど）、svg-diagram の誤りが出てから消えることがある（VS Code が先に検査するため）。
- ワークスペースフォルダの外のファイル（フォルダを開かずにファイルだけ開いたときも）は、上に `.svg-diagram.json` があるときだけ検査する。
- 開き直したファイルは案件を探し直す（ワークスペースフォルダより下のパッケージに svg-diagram を入れたときは、そのファイルを閉じて開き直すか、ウィンドウにフォーカスを戻す）。
- svg-diagram が 0.8.0 より古いとき、設定 `svgDiagram.jsonSchemas.enabled` が false のときも検査しない。どれを使ったか・なぜ検査しないかは、出力ログに出る。
- デッキが指す図の `.json` は名前が決まっていないので、先頭に `"$schema": "./node_modules/svg-diagram/schema/figure.schema.json"` を書く（パスはそのファイルから）。`"$schema"` を書いたファイルは、拡張によらず VS Code がそれに従う。
- svg-diagram を入れた・上げたときは、ワークスペースフォルダの直下の `node_modules` なら気づいて読み直す。
- Windows でも効く（schema のファイルを読むだけで、CLI は走らせない）。信頼していないワークスペースでは、拡張ごと止まるので効かない。

## プレビュー

図のソースを開いて、エディタ右上のプレビューのボタン、`Ctrl+K V`（Mac は `Cmd+K V`）、またはコマンド「svg-diagram: プレビューを横に開く」。

- `svg-diagram build <ソース> --out <拡張の作業用フォルダ> --no-lint` で描く。**案件には何も書き出さない**（`svg/` の SVG は変わらない）。lint は飛ばす（所見は「問題」パネルに出る）。
- 保存したときに描き直す。同じワークスペースフォルダの `.ts` / `.mts` / `.js` / `.mjs`（共通部品）と `.svg-diagram.json` を保存したときも描き直す（`node_modules` の下は除く）。
- プレビューは 1 枚で、アクティブなエディタの図のソースに付いていく。
- 描けなかったときは、前に描けた図を残したまま「古い図」と表示し、理由（throw した行など）を上に出す。失敗箇所が別のファイルにあるときは、ワークスペースフォルダからの相対パスと行・桁を表示する。フォルダの外なら絶対パスを表示する。
- 表示: 幅に合わせる / 拡大・縮小 / 原寸、背景（白・暗・格子）。VS Code を再読み込みしても開き直す。
- core 0.9.0 など `build --locations` に対応した CLI では、部品や接続線にマウスを置くと枠や線が強調される。クリックすると保存済みのソースで、その部品や接続を書いた位置を選ぶ。ドラッグでは移動しない。描いた後にソースを編集すると、移動時に「保存前の位置です」と表示する。
- SVG は Webview に直接埋め込む。CSP でネットワークと SVG 内のスクリプトを止めている。

## 導入・型検査・ステータスバー

- **「svg-diagram: この案件で svg-diagram を使えるようにする」**: ワークスペースフォルダの直下で、lockfile から pnpm / yarn / bun / npm を選び、足りないもの（`svg-diagram`・`typescript`・`@types/node`）を `add -D` し、`package.json` の `"type": "module"` か `tsconfig.json` が無ければ `svg-diagram init` まで、見えるターミナルで実行する。実行前に、打つコマンドを見せて確認する。
- **「svg-diagram: 型検査（typecheck）」**: アクティブなファイルのプロジェクト（いちばん近い `package.json` のディレクトリ。monorepo の下のパッケージ）で、`svg-diagram typecheck` をタスクとして走らせ、`$tsc` の problem matcher で「問題」パネルに出す。タスク一覧には、svg-diagram を使うフォルダ（直下に `node_modules/svg-diagram` か `.svg-diagram.json` がある）にだけ出る。`tasks.json` にも書ける:

      {"type": "svg-diagram", "command": "typecheck", "problemMatcher": "$tsc"}

- **ステータスバー**: 図のソースかプレビューが前にあるときだけ、左下に `svg-diagram <版>` を出す（検査中は回る。CLI が無ければ警告色で「CLI なし」）。クリックでメニュー（プレビュー、検査、型検査、導入、CLI の場所、ログ）。

## 起動する条件

次のどれかのとき。

- ワークスペースの直下に `node_modules/svg-diagram/package.json` がある
- `.svg-diagram.json` がある（どこの階層でもよい）
- TypeScript / JavaScript のファイルを開いたとき（CLI が PATH や設定にだけある案件のため。svg-diagram と関係ない案件では、ログに 1 行出すだけで何もしない）
- VS Code が `site.json`・`deck.json` などの JSON Schema を求めたとき（関係ない案件では、すべて受け入れる schema を返すだけ）

## 開発

    pnpm install
    pnpm build          # dist/extension.cjs（--watch で監視）
    pnpm typecheck && pnpm lint && pnpm test
    (cd test/fixtures/workspace && npm install --no-package-lock)   # 結合テストが使う core 0.9.0（GitHub のリリースの tarball）
    pnpm test:integration   # 本物の VS Code を落として動かす（画面が要る。CI では xvfb-run）
    pnpm test:e2e       # 本物の VS Code の画面を Playwright で操作する（下）
    pnpm package        # .vsix を作る

### 画面の E2E テスト（`e2e/`）

`@vscode/test-electron` で落とした VS Code を `--remote-debugging-port` 付きで起動して Playwright を CDP でつなぎ（`_electron.launch` は CI でウィンドウの読み込みを取り逃がした）、人と同じようにコマンドパレット・クリックで操作する: ステータスバーの版、「問題」パネルの所見、エディタのプレビューボタン、プレビューの Webview に SVG が描かれること、拡大・背景のボタン、描けない図の理由、ステータスバーのメニュー、共通部品では何も出ないこと。各手順のスクリーンショットと Playwright の trace（`npx playwright show-trace test-results/*/trace/trace.zip`）を `test-results/` に残す。

- CI は {Ubuntu（xvfb）, macOS} × {VS Code 1.100.0（engines の下限）, stable} で走らせ、スクリーンショット・trace・HTML レポートを artifact「e2e-<os>-<版>」に上げる（通ったときも）。
- 手元の Linux で画面がないときは Chromium の headless（`--ozone-platform=headless`）で動く。`VSCODE_VERSION=1.100.0 pnpm test:e2e` で版を選べる。
- 先に `test/fixtures/workspace` で `npm install --no-package-lock`（core 0.9.0。GitHub のリリースの tarball）。
- テストの実行プロセスを kill -9 したときは VS Code が残る（別のプロセスグループで起動するため）: `pkill -f svgd-e2e-`。

VS Code で開いて F5（「拡張を起動」）を押すと、`test/fixtures/workspace` を開いた別ウィンドウで拡張が動く。

core を手元で変えながら試すときは、設定 `svgDiagram.cliPath` を `../svg-diagram/bin/svg-diagram` に向ける（案件のものより優先される）。

## ロードマップ

1. 雛形（済）
2. CI（済）
3. core（CLI）の見つけ方（済）
4. `check --format json` → Problems パネル（済）
5. ライブプレビュー（済）
6. JSON の補完と検査（core 0.8.0 の JSON Schema。済）
7. ステータスバー・`init` / `typecheck` のコマンド（済）
8. 以降: ソース位置（core の ADR）、プレビュー ⇄ ソースのジャンプ、Quick Fix、Markdown、差分、AI 連携、公開

# svg-diagram-vscode — エージェント共通ガイド(Codex・Claude 共通)

svg-diagram(core。別のリポジトリ `cuzic/svg-diagram`)の VS Code 拡張。図のソースの検査を波線に(`check --format json`)、
ライブプレビュー(`build`)、JSON の補完と検査(core の `schema/`)、案件のセットアップ。
**core は公開の出口(CLI と `exports`)からだけ使う。** core の中身に頼る変更が要るなら、core の PR にする(core の ADR が先)。

## 役割分担

| 担当 | 仕事 |
| --- | --- |
| Claude | 設計(core の ADR と、拡張の側の決め事)、タスク仕様を書く、PR の敵対的レビュー、マージ |
| Codex | 仕様に沿った実装、レビュー指摘の修正、main の取り込みと衝突解消、テストの追加 |
| CI | typecheck・lint・単体・結合(xvfb)・パッケージ、e2e(ubuntu・macOS × VS Code 1.100.0・stable) |

- 仕事は「タスク仕様」で渡す。新しい作業は `[codex] …` の Issue、既存 PR への修正はその PR の `## [codex] タスク仕様` コメント。
- レビュー指摘の根拠は、PR ブランチにコミットされた `docs/reviews/prNN-roundK.md`。
- **仕様に無い判断が要るときは、実装で決めない。** PR 本文の「Open questions」に書いて止める。

## 完了の定義(どの PR も)

```sh
pnpm typecheck
pnpm lint
pnpm test                    # 単体(node --test test/unit/*.test.ts)
pnpm build --production
```

- 4 つとも通ること。
- 結合テスト(`pnpm test:integration`。本物の VS Code を開く。画面が要るので Linux は `xvfb-run -a`)と
  e2e(`pnpm test:e2e`。Playwright で VS Code を操作する)は CI が回す。手元で回せなければ「CI に任せた」と報告に書く。
  VS Code の API の振る舞いに頼る変更(診断・プレビュー・ファイルの監視・JSON の検査)には、結合テストを足す。
- **先に再現テストを書く。** 直す前に落ちることを確かめてから直す。
- 新しいコードには、それを壊す変異(手書きでよい)を最低 1 つ当て、テストが落ちることを確かめる。PR 本文に書く。
- 設定・コマンド・起動の条件を変えたら、`package.json` の `contributes` と `test/unit/manifest.test.ts`、README、CHANGELOG を合わせる。

## コードの約束

- `src/` の VS Code に触らない部分(`check.ts`・`cli.ts`・`schemas.ts`・`runs.ts` など)は純粋に保ち、単体テストで確かめる。
  `vscode` を import するのは `extension.ts` と、その周りの薄い層だけ。
- core の版の違いに耐える: 古い core(npm の 0.5.0 など)で落ちない。新しい出力(例: finding の `line` / `column`)はあれば使い、無ければ今の振る舞いに戻る。
- CLI は子プロセスで走らせる(`src/exec.ts`)。シェルを通さない。Windows では CLI を使う操作を理由を出して止める(JSON の補完と検査は効く)。
- 利用者に見せる文(メッセージ・設定の説明・README)は日本語。コードのコメントは英語。
- Node が `.ts` を型の取り除きで動かすスクリプトとテストがある(`scripts/`、`test/unit/`)。`enum`・`namespace`・引数プロパティは書かない。

## 安全の約束

- 試しのファイルや一時ファイルはリポジトリの外に置く。`.vscode-test/`(VS Code のダウンロード)をコミットしない。
- コミット・コメント・PR に、マシン固有の情報(ユーザー名・絶対パス・トークン)を書かない。

## Git の約束

- 1 つの作業に 1 つの `git worktree` とブランチ(`feat/… fix/… docs/… chore/… test/… refactor/…`)。共有の checkout でブランチを切り替えない。
- **merge で追従し、rebase と force-push はしない。** 既存 PR で始める前と push が拒否されたときは `git pull --no-rebase origin <branch>`。
- コミットメッセージは `feat(area): …` / `fix(area): …`(日本語でも英語でもよいが、PR の中ではそろえる)。指摘を直すコミットには指摘 ID。
- コミット末尾に、使っているツールの `Co-Authored-By:` トレーラーを付ける。
- **Codex は PR を作って更新するが、マージしない。** マージは Claude が `.claude/skills/merge-pr` の手順で行う。

## リポジトリの地図

| 場所 | 中身 |
| --- | --- |
| `src/extension.ts` | 起動、コマンド、設定、各機能の組み立て |
| `src/cli.ts`, `src/exec.ts`, `src/runs.ts` | core の CLI を探す(設定 → 案件の `node_modules` → PATH)、走らせる、走りの管理 |
| `src/check.ts`, `src/diagnostics.ts` | `check --format json` を波線に(位置が無い指摘はラベルを探す) |
| `src/preview.ts`, `src/preview-html.ts` | ライブプレビュー(`build` の SVG を webview に) |
| `src/schemas.ts`, `src/schema-provider.ts` | JSON の補完と検査(core の `schema/` を `svg-diagram-schema:` で配る) |
| `src/setup.ts`, `src/tasks.ts`, `src/status.ts` | セットアップ、typecheck のタスク、ステータスバー |
| `test/unit/`, `test/integration/`, `e2e/` | 単体、結合(本物の VS Code)、e2e(Playwright) |
| `test/fixtures/` | 結合テストのワークスペース(core を GitHub release の tarball で入れる) |

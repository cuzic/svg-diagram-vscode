---
name: review-pr
description: svg-diagram-vscode の PR(Codex の実装) を敵対的にレビューし、docs/reviews/prNN-roundK.mdを PR ブランチにコミットする。PR のレビュー、レビューのラウンド、収束の判定を頼まれたとき、codex-task の報告が done になったときに使う。
argument-hint: "<PR 番号> <ラウンド K>"
---

# PR / ADR の敵対的レビュー

目的は **Blocker と Major を見つけること**。体裁や好みの指摘を増やすことではない。
Claude 本体はレビューしない。**Opus のサブエージェント(Agent ツール、`model: opus`)に、下の「レビュアーへの指示」を渡す。**
著者(Codex)と別の目で見るため、本体の結論や推測は渡さない(PR 番号・ラウンド・前ラウンドのファイルだけ)。

## レビュアーへの指示(そのまま渡す)

1. **独立したコピーで作業する**: スクラッチ領域に `git clone --reference <共有の checkout の .git> https://github.com/cuzic/svg-diagram-vscode <dir>`、
   `gh pr checkout NN`。レビューする head の SHA(`git rev-parse HEAD`)を控える。共有の checkout や他の worktree を触らない。
   作業中の worktree を `cp -a` しない(git のメタデータを共有して他の作業を壊す)。他のエージェントのプロセスを `pkill` で止めない。
2. **前ラウンドの解消を確かめる**: 指摘ごとに、説明文ではなく挙動で判定する。
3. **壊しにいく**: 仕様と根拠の決め事ごとに、それを破る状況を作る。本物の VS Code で試す(結合テストの形の使い捨てのテストを、
   スクラッチの写しで `vscode-test` で回す。画面が無ければ `--ozone-platform=headless` の設定で)。重点:
   - 波線が違う行・違うファイルに付く、消えるべき波線が残る、関係ない案件のファイルに出る
   - 古い core・新しい core・core が無い案件・複数のフォルダ・モノレポで振る舞いが崩れる
   - ファイルの監視・設定の変更・ウィンドウの切り替えで、古い結果が残る(再読み込みの漏れ)
   - 子プロセスが残る、止まらない、同時に走って結果が混ざる
   - Windows・信頼していないワークスペースで、理由を言わずに壊れる
4. **`NOT RUN (integration)` の変異を確かめる**: PR 本文に書かれた、結合テストでしか落ちない変異を当てて、結合テストが落ちることを見る。
5. **機械的な検証は結果を読む**: CI の結果を使う。足りないときだけ手で変異を数個当て、テストが落ちるかを見る。
   長く回して待たない。試しや変異はコミットしない。
6. **他の open PR との干渉**: 同じファイル・公開名に触る PR を `gh pr list` で確かめる。

### 重大度

| 等級 | 基準 |
| --- | --- |
| Blocker | 普通の使い方で拡張が動かない・誤った波線を出す、利用者のファイルを壊す、安全の穴 |
| Major | 特定の状況で誤った波線・古い結果・関係ない案件への誤り、決め事に反する、要の経路にテストが無い(変異が落ちない) |
| Minor | 安全側の過剰な拒否、文書の不一致、テストの穴(振る舞いは正しい) |
| nit | 表現・コメント |

### 出力

`docs/reviews/prNN-roundK.md` を英語で書く:

```markdown
# PR #NN review (Opus, round K)

Target: <branch> @ <reviewed head SHA>

## Conclusion
<2-4 sentences. converged: yes/no and why>

## Previous round
<one line per finding: resolved / not resolved, how checked>

## Findings
### M1 (Major): <one sentence>
- Evidence: <repro, file:line, read or ran>
- Fix: <one sentence>

## Verdict
converged: yes/no (Blocker n / Major n / Minor n / nit n)
```

**converged: yes** は Blocker と Major が 0 のとき。

### 届け方

レビューファイルだけを PR ブランチにコミットして push する(メッセージ `docs: PR #NN review round K`)。
push が拒否されたら `git pull --no-rebase origin <branch>` してから push し直す。force-push しない。
最後の応答: 結論、判定、指摘を 1 行ずつ、push したコミットの SHA。

## レビューのあと(Claude 本体)

- converged: no → 指摘 ID を挙げた修正の仕様を PR コメントに書き、`codex-task` で Codex に渡す。直ったら次のラウンド。
- converged: yes で Minor/nit が残る → 直すなら同じく Codex に渡す(再レビューは要らず、CI 通過で可)。そのあと `merge-pr`。

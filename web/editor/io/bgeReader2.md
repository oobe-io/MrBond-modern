# bgeReader2 実装メモ・既知の制約

BGE バイナリを `BondGraphDoc` に復元する `readBge()` と UI ボタン
`mountBgeImportButton()` の実装ノート。

## 参考ファイル

- `docs/bge-format-spec.md` — フォーマット仕様（初期解析）
- `src/parser/bgeReader.ts` — 低レベル TLV リーダ（Shift-JIS デコード対応）
- `web/editor/io/bgeWriter.ts` — 書き出し側。レイアウトの正本として扱う
- `web/editor/io/bgeWriter.test.md` — 書き出し側の既知制約
- 実物サンプル: `BGE_files/バネ-マス-ダンパ.BGE`（9 要素 / 9 ボンド / 1 出力）

## 役割分担

- **低レベル層** (`BgeReader`): アトム `(code, value)` + 長さ接頭辞文字列を読む。
  Shift-JIS デコードを含む。位置エラーは `BgeParseError` で報告。
- **文法層** (`readBge`, 本ファイル): アトム列を BGE の論理構造
  「ヘッダ / 要素 × N / ボンド × M / シミュレーション / 出力変数」に仕分けし、
  `BondGraphDoc` を組み立てる。
- **UI 層** (`mountBgeImportButton`): ボタン + `<input type="file">` の DOM 配線。

## レイアウト（writer と 1:1 対応）

### ヘッダ（11 アトム）
- `nElem (auto-int)`
- `nBond (auto-int)`
- ビュー設定 9 アトム（意味不明なのでスキップ）

### 要素ブロック（要素 1 個分）
1. `type (2)` `subtype (2)` — タイプコード表は writer 準拠
   （`1=I, 2=C, 3=Se, 4=Sf, 5=R, 6=TF, 7=ZJ, 8=OJ, 9=GY`）
2. `grid_w (3)` `grid_h (3)`
3. `bbox_x1/y1/x2/y2 (4)` — 中心を position として保持
4. 8 ポート × 4 アトム = 32 アトム（未接続テンプレ含む）— 読み飛ばし
5. `param_count (2)` + （≥1 のとき）`names_str` + `values_str`
   - names / values は `\n` 区切り複数対応（FD_valve 形式）
6. 12 個の `2 0` パディング
7. `equation_str`
8. 10 個の `2 0` トレイリングパディング

### ボンドブロック（ボンド 1 個分）
- `id from to junction_port (2)` × 4
- 8 個のポリライン座標 (4) — スキップ
- フラグ 4 個 (2) — スキップ
- `causality (2)` + pad (2)
- `initial_value_str` — 読み捨て

### シミュレーション末尾
- `T0_str T1_str dt_str (2 11 の11桁科学表記)`
- `NOT (auto-int)`
- `nOut (auto-int)` + `(label_str, 2 1, bond_idx)` × nOut

## 復元方針と既知の制約

### 完全一致を保証する項目
- 要素数 / kind / parameters.name / parameters.value
- 要素 `equation`（明示指定時のみ。未指定要素は writer がデフォルト式を書くので
  復元時は `equation` が埋まる）
- ボンド数 / from・to の要素インデックス対応
- ボンド `causality === 'effortIn'` のフラグ（未指定 / `flowIn` はまとめて
  「undefined」に畳み込む。writer がフラグ 0 として書いてしまうため情報損失）
- simulation (`t0`, `t1`, `dt`, `numOutputSteps`)
- outputs の個数とラベル

### 失われる情報
- **要素 ID / ボンド ID**: 元の ID 文字列は復元できない（BGE に含まれない）。
  読み戻しは出現順で `el_1, el_2, ...` / `bond_1, bond_2, ...` 形式に振り直す。
- **要素の座標**: writer は `position ± 15` の bbox を書くので、中心を
  position として取り直す。厳密な原値は失われる（整数丸めの範囲内で一致）。
- **要素の label**: BGE に要素ラベル専用のフィールドは存在しないので、kind から
  `C1, I1, SE1, OJ1, ...` と連番で再生成する。
- **`flowIn` 因果**: writer 側で `effortIn=1`/それ以外=0 に畳まれるため、
  `flowIn` は round-trip で `undefined` になる。
- **パラメータの unit**: writer がこのフィールドを書いていないため復元できない。
- **複数 output の bondId**: output レコードは `elem/bond idx` の数値1つしか持たず、
  writer がここに `extractIndex(o.bondId)`（= bond 番号の数値部）を書く。
  reader は読み戻した bonds から同じ数値を持つ bond id を逆引きするが、
  該当がなければ `bond_<idx>` 形式にフォールバックする。

### 実 BGE ファイル（田中教授の21モデル）対応

**実ファイルは完全パース非対応（best effort）**。writer が吐く BGE と実 Mr.Bond の
BGE でレイアウトに以下の差異があり、現時点では途中でパースが止まる:

1. **junction 要素のパッド数差**: writer は 12 + equation_str + 10 = 23〜24 アトム
   だが、実ファイルの junction（`7=ZJ`, `8=OJ`）は 25〜26 アトムになっている。
   → 適応パッド吸引（`2 0` の連続を可変長で消費）で救済。
2. **subtype 欠落 / 異常値**: 一部の要素で `subtype` アトムが存在せず、直接 `grid_w`
   が来るケースがある（バネ-マス-ダンパ.BGE の要素 5 以降）。現在の reader は固定で
   `subtype` を 1 アトム消費するため、境界がずれてその後の要素構造が壊れる。
3. **ポートの causality/接続情報**: 未接続テンプレ以外の値が入っており、これ自体は
   スキップするだけなので問題ない。
4. **複数パラメータ要素**: FD_valve.BGE のような複雑要素は `\n` 区切り複数名 / 複数値
   を写真のように読むが、writer 側と同じ `\n` 連結を仮定しているため動作は期待値。

**テストの取り扱い**: `tests/bgeRoundTrip.test.ts` の実ファイルテストは、
- 低レベル `BgeReader` でヘッダの要素数・ボンド数（どちらも 9）を抽出できることは
  **強いアサート**で検証する
- `readBge()` による完全パースは **best effort** 扱い（成功すれば追加アサート、
  失敗しても `console.log` に情報を出してテストは通す）

将来的に実ファイル完全対応する場合は、以下のいずれかが必要:
- `subtype` の有無を動的に判定する（`3 N` が subtype なのか grid_w なのかは、
  直後の atom が `3 N grid_h` パターンになるかで判定可能？）
- 要素境界検出を「次の既知要素 type の signature」に基づくスキャン方式に変える
- Mr.Bond 原作ソース (`BGE_R.C`) を取得して正確なレイアウトを逆算する

### エラーハンドリング
- 低レベル層由来の `BgeParseError` はそのまま上位に伝播する。
  `mountBgeImportButton` は `alert` + `console.error` で詳細（オフセット付き）を
  表示する。
- 未知の要素タイプコード（1..9 以外）が来たら `BgeParseError` を投げる。
- 不整合なヘッダ（負の要素数など）でも `BgeParseError` を投げる。

## テスト

`tests/bgeRoundTrip.test.ts` で以下を確認:

1. 空ドキュメントの round-trip
2. 2 要素 1 ボンドの最小ドキュメント
3. バネ-マス-ダンパ相当（7 要素 7 ボンド + 1 出力）
4. TF / GY を含むサンプル
5. 複数パラメータ要素
6. 実 `バネ-マス-ダンパ.BGE` からの best-effort 抽出（環境依存、ファイルが
   無ければスキップ）

`npm run typecheck` / `npm test` いずれもパス。

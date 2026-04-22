# bgeWriter 実装メモ・既知の制約

BondGraphDoc を Mr.Bond 互換 BGE バイナリに書き出す `writeBge()` と UI ボタン
`mountBgeExportButton()` の実装ノート。

## 参考ファイル

- `docs/bge-format-spec.md` — フォーマット仕様（初期解析）
- `src/parser/bgeReader.ts` — 低レベル TLV リーダ（Shift-JIS 読み取り対応）
- 実物サンプル: `BGE_files/バネ-マス-ダンパ.BGE`（9 要素 / 9 ボンド / 1 出力）

## 実ファイル解析で確定したこと

- 先頭 13 アトム = ヘッダ: `[nElem][nBond][view×9]`（バネ-マス-ダンパでは `2 1 2 1 2 1 2 1 2 1 2 0 2 0 2 2 2 2` の 9 個）。
- 各要素ブロックのレイアウト（pragmatic 版）:
  1. `type(2)` `subtype(2, 1)`
  2. `grid_w(3)` `grid_h(3)`
  3. `bbox x1/y1/x2/y2(4)`
  4. 8 ポート × 4 アトム = 32 アトム（未接続は `2 0 2 0 2 0 3 -1`）
  5. `param_count(2)` + （あれば）`name_str` + `value_str`
  6. 12 個の `2 0` パディング
  7. `equation_str`（例: `"E=EIN;"`）
  8. 10 個の `2 0` トレイリングパディング
- 要素タイプコード（**実ファイル値。spec の初期推定とは 6/7/8 が食い違う**）:
  - `1=I, 2=C, 3=Se, 4=Sf, 5=R, 7=ZJ(0-junction), 8=OJ(1-junction), 6=TF(推定), 9=GY(推定)`
  - 注意: docs/bge-format-spec.md では `6=0-junction, 7=1-junction, 8=TF` と書かれているが、
    バネ-マス-ダンパ.BGE の実データでは BGS の `OJ` が type=8, `ZJ` が type=7 として記録。
    このライタは実ファイルの値を正とする。
- 各ボンドブロック: `id from to junction_port x1..y4 flag×4 causality pad init_value_str`。
  バネ-マス-ダンパでは全ボンドが `0.0000000E+00`（長さ13の科学表記）。
- シミュレーション末尾: `T0 T1 dt(3 11 の11桁科学表記) NOT(int) 出力変数数 [name_str 2 1 elemIdx ...]`。

## 本実装の pragmatic な割り切り

1. **座標は要素 position を中心とする 30×30 bbox として生成**。
   Mr.Bond 側で開き直したときの配置は崩れるが、トポロジ情報は保たれる。
2. **ポート情報は全て未接続テンプレで埋める**（`2 0 2 0 2 0 3 -1` × 8）。
   実ファイルでは接続ボンドの ID とポート番号が入るが、本ライタは簡略化。
3. **パッディングは固定長**（12 / 10 個）。
   サンプルからの観測値。要素種や Mr.Bond のバージョンで変動する可能性あり。
4. **パラメータは複数ある場合 `\n` 区切りで連結**（FD_valve の形式にならう）。
5. **出力変数レコード**は `name_str + 2 1 + elemIdx` の最小形式。

## 既知の制約（ロードマップ）

- **日本語（Shift-JIS）非対応**: ブラウザ標準の `TextEncoder` は utf-8 固定。
  本実装は純 ASCII のみ書き出し、非 ASCII は `'?'` に置換する lossy 変換。
  将来対応: Node 側は `iconv-lite`、ブラウザは手書き Shift-JIS テーブル or
  `TextDecoder('shift_jis')` の逆方向テーブルを構築する必要がある。
- **TF / GY のタイプコード**は推定値（サンプルファイルに存在しないため未検証）。
- **Mr.Bond 側での完全な再オープン保証はなし**。round-trip の合格基準は
  `BgeReader` で最後までアトム列を歩き切れること。
- **causality の詳細フラグ**は簡略化（`effortIn` → 1, それ以外 → 0）。
  Mr.Bond が保持する因果グラフ情報（causal stroke の位置）は再現されない。
- **複数パラメータ要素のサポート**は改行連結で対応しているが、Mr.Bond 側で
  開いたときの UI 表示が FD_valve 準拠になるかは未検証。

## テスト

`tests/bgeWriter.test.ts` で以下を確認:

- 空 doc → `nElem=0, nBond=0` のヘッダを持つ非空バイト列
- バネ-マス-ダンパ相当 doc → BgeReader でヘッダから末尾まで一貫して歩ける
- シミュレーション設定の 11 桁科学表記が期待通り（`0.00000E+00` / `1.00000E-03`）
- 出力変数レコードが読み戻せる

`npm run typecheck` / `npm test` いずれもパス。

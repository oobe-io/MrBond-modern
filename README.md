# MrBond-modern

Mr.Bond（九州工業大学製ボンドグラフ・シミュレータ）を、現代的なクロスプラットフォーム技術で再実装するプロジェクト。

## 背景

- 原作: Mr.Bond ver 1.5.2（九州工業大学）、32bit Windows 専用ネイティブアプリ
- 原作者が既に逝去されており、保守困難になっている
- 田中教授（九州工業大学）からの依頼で、現代環境でも動作する後継版を開発

## 機能

**ブラウザで動くボンドグラフ描画＆シミュレーション環境**。Mr.Bond 独立で完結する：

- **描画エディタ** (SVG キャンバス)：要素配置、ボンド接続、ドラッグ移動、選択、削除、キーボードショートカット
- **全 9 要素対応**: C / I / R / Se / Sf / TF / GY / 0-junction / 1-junction
- **パラメータ＆式編集**：要素ごとにパラメータ名・値・単位と C 言語式を入力。`if / else` もサポート
- **出力変数設定**：ボンド選択＋変数種別（変位/運動量/Effort/Flow）＋ CSV ラベル
- **自動状態方程式導出**：描いたグラフから SCAP（因果割当）＋ 接合点制約で FUNC/DOUT 自動生成
- **シミュレーション実行**：Runge-Kutta-Gill 4 次で積分、代数ループは SOLV で反復
- **波形プロット**：Canvas で即時描画
- **CSV 出力**：Mr.Bond と同じ `%e` 書式
- **JSON 保存/読込**：モデルの永続化
- **BGE 保存/読込**：Mr.Bond 互換ファイル形式（Shift-JIS 対応）
- **Mr.Bond 互換モード**：Mr.Bond が生成した `temp.c` + `temp.PAR` を貼り付けて実行

## クイックスタート

```bash
npm install
npm run dev
# ブラウザで http://localhost:5173/editor.html を開く
```

### ワークフロー

1. ツールバーから要素配置（または キーボード `C/I/R/E/F/T/G/0/1`）
2. `B` キーでボンドツール → 要素を2回クリックで接続
3. 要素選択 → `Enter` でパラメータ・式を編集
4. ヘッダ `📊 Outputs` で出力変数指定
5. `▶ Run` でシミュレーション実行、波形表示、CSV ダウンロード

### CLI（Mr.Bond の temp.c を直接走らせたい時）

```bash
# シミュレーション実行
npm run sim -- path/to/temp.PAR path/to/temp.c --out result.csv

# 原作 C 実装と突合検証
npm run verify -- path/to/temp.PAR path/to/temp.c
```

## アーキテクチャ

```
src/                   コアランタイム
├─ solver/             Runge-Kutta-Gill 4次 + SOLV（Fortran Runge.f 忠実移植）
├─ parser/
│   ├─ parFile.ts      .PAR ファイル
│   ├─ bgeReader.ts    BGE 低レベルリーダ（Shift-JIS、TLV）
│   └─ bgsFile.ts      .BGS 中間表現
├─ transpiler/         temp.c → TypeScript 自動変換（字句解析+AST+コード生成）
├─ runtime/            Runge.c main() 相当の実行ループ
├─ output/             Mr.Bond 互換 CSV
└─ cli/                sim / verify コマンド

web/editor/            描画エディタ（Vite）
├─ shared/             データモデル + pub-sub ストア
├─ canvas/             SVG キャンバス（配置・ドラッグ・ボンド描画）
├─ toolbar/            ツールバー + パレット + キーボード
├─ dialog/             パラメータ編集モーダル
├─ output/             出力変数設定モーダル
├─ io/
│   ├─ saveLoad.ts     JSON 形式での保存・読込
│   ├─ bgeWriter.ts    Mr.Bond BGE 書き出し（Shift-JIS 対応）
│   └─ bgeReader2.ts   BGE → BondGraphDoc 読み取り
├─ derive/             自動導出（SCAP + 接合点制約）
└─ run/                実行ダイアログ（波形プロット）
```

## 検証実績

### 解析解テスト（独立証明）
- 指数減衰・単振動・減衰振動・エネルギー保存など 7 件、最高 1e-12 精度で一致
- 4 次精度収束率の確認
- SOLV/FUNC 呼び出し回数が Fortran 版と完全一致

### Mr.Bond 参照出力との比較（師岡さん回収 15 モデル）
- **バイト完全一致 (6モデル)**: バネ-マス-ダンパ、FD_valve、SW_pipe_SN_test、SW_valve、TH_valve、arie_jet
- **ULP レベル一致 (2モデル)**: arie_jet_ver2 (96%)、SN_valve (68%) — [known-limitations](docs/known-limitations.md) 参照
- **C 側問題で検証不可 (7モデル)**: Mr.Bond C 生成コード自体が ARM64 Mac でクラッシュ
- **スキップ (2モデル)**: ファイル不足

### 自動導出（エディタで描いたグラフから）
- バネ-マス-ダンパを編集内で構築 → SCAP → シミュ → Mr.Bond リファレンスと 1e-2 精度で一致

**総合 72 テスト全通過**。

## 参照実装

オリジナルソースは Google Drive 上に保管（非公開）。
`Runge.f`（Fortran 90版）を参照実装として優先採用。

## アルゴリズム

- **ソルバ**: Runge-Kutta-Gill 4 次（係数 `CS1 = 1/√2`, `CS2 = √2`、丸め誤差軽減型）
- **SOLV**: 相対誤差 1e-8 の反復収束（代数制約向け）
- **自動導出**: SCAP-lite（1ポート要素 + 接合点の因果伝搬）+ 接合点制約 `Σ(sign_i · e_i) = 0`

詳細仕様は `docs/solver-spec.md`, `docs/bge-format-spec.md`, `docs/known-limitations.md` 参照。

## Mr.Bond 互換の注意点

- **IEEE 754 丸め**: `(T1-T0)/h` は `Math.trunc` で整数化（Math.round だと 1 ステップずれる）
- **サンプリング**: 間隔も切り捨てで計算（NOT=1000 → interval=999）
- **CSV 書式**: C の `%e` を完全模倣（6桁精度、2桁以上ゼロ埋め指数、正値前スペース、負ゼロ保持）
- **グローバル X セマンティクス**: 要素関数はグローバル X を参照、FUNC 内は probe X を参照

## ライセンス

検討中（田中教授との合意が必要）。

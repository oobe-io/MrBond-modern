# MrBond-modern

Mr.Bond（九州工業大学製ボンドグラフ・シミュレータ）を、現代的なクロスプラットフォーム技術で再実装するプロジェクト。

## 背景

- 原作: Mr.Bond ver 1.5.2（九州工業大学）、32bit Windows 専用ネイティブアプリ
- 原作者が既に逝去されており、保守困難になっている
- 田中教授（九州工業大学）からの依頼で、現代環境でも動作する後継版を開発

## 現状

**Mr.Bond 生成の `temp.c` + `temp.PAR` を入力に、オリジナル C 実装とバイト完全一致する CSV を出力できる。**

バネ-マス-ダンパモデルで検証: **1002/1002 行バイト完全一致** を達成済み。

```
 BGE file (Mr.Bond model)
     ↓ (Mr.Bond GUI)
 temp.c  +  temp.PAR         ← Mr.Bond が生成する中間ファイル
     ↓ (MrBond-modern)
 Simulation in TypeScript
     ↓
 CSV output (byte-identical to Mr.Bond's original output)
```

## クイックスタート

```bash
npm install

# 1 モデルを実行して CSV 出力
npm run sim -- path/to/temp.PAR path/to/temp.c --out result.csv

# オリジナル C 実装と TS 実装の出力を突き合わせて検証
npm run verify -- path/to/temp.PAR path/to/temp.c

# テスト実行
npm test

# 型チェック
npm run typecheck
```

`verify` は macOS/Linux 上の `cc` で原作 C コード（Runge.c + temp.c）をコンパイルして実行し、それと TypeScript 版の出力を行単位で比較する。`--runge` フラグで Runge.c のパスを差し替えられる。

## アーキテクチャ

```
src/
├─ solver/          Runge-Kutta-Gill 4次 ソルバ（Fortran版 Runge.f 忠実移植）
├─ parser/
│   ├─ parFile.ts   Mr.Bond .PAR ファイルパーサ
│   └─ bgeReader.ts BGE ファイル低レベルリーダ（Shift-JIS、型コード対応）
├─ transpiler/
│   ├─ cTokenizer   temp.c 用の小さな C 字句解析器
│   ├─ cParser      AST 構築
│   └─ transpileTempC  AST → JS 関数への変換
├─ models/          手動移植されたリファレンスモデル（検証用）
├─ runtime/
│   └─ runSimulation.ts  Runge.c main() 相当のループ
├─ output/
│   └─ csvWriter.ts  Mr.Bond 互換 CSV フォーマッタ
└─ cli/
    ├─ runSim.ts    シミュレーション実行 CLI
    └─ verify.ts    C 実装との一致検証 CLI
```

## 検証内容（2026-04-21 時点）

- 解析解テスト 7 件 (指数減衰 / 単振動 / 減衰振動 など、最高 1e-12 精度で一致)
- 4 次精度収束率の確認
- エネルギー保存則の確認
- Fortran/C 実装との挙動一致 (SOLV/FUNC 呼び出し回数など)
- Mr.Bond 参照 CSV (`CSV_files/test1.csv`) と完全バイト一致 (1002/1002 行)
- 自動 C→TS 変換パイプライン経由でも完全バイト一致

**合計 51 テスト全通過。**

## 参照実装

オリジナルソースは Google Drive 上に保管（非公開）。
`Runge.f`（Fortran 90版）を参照実装として優先採用。C 版 `Runge.c` は制約ソルバ (SOLV) 内に Fortran 版と齟齬があるため一次参照としない。

## アルゴリズム

ソルバは **Runge-Kutta-Gill 4 次**（係数 `CS1 = 1/√2`, `CS2 = √2` を使用する丸め誤差軽減型）。古典 RK4 と位数は同じだが係数が異なる。仕様書は `docs/solver-spec.md` 参照。

## 既知の「再現すべき癖」

Mr.Bond 互換のためには以下を忠実に再現する必要がある:

- **IEEE 754 丸め**: `(T1 - T0) / h` を `Math.trunc` で整数化する必要がある。
  例えば `10 / 1e-5 = 999999.9999...` → 999999 (Math.round なら 1000000 となり
  1 ステップずれる)。
- **サンプリング計算**: サンプル間隔も同じく切り捨てで計算する
  (NOT=1000 のとき interval=999、1000 ではない)。
- **CSV 書式**: C の `%e` を完全に模倣する
  (6 桁精度、2 桁以上ゼロ埋め指数、正値の前にスペース1つ)。

## ライセンス

検討中（田中教授との合意が必要）。

---
created: 2026-04-21
updated: 2026-04-21
---

## 概要

Mr.Bond（九州工業大学製ボンドグラフ・シミュレータ）のソルバ部分の完全仕様。移植時の再現指針として作成。

関連プロジェクト: [[🦎Mr.Bondモダナイゼーション]]
元ファイル: `MRBOND/Runge.c`（422行）, `MRBOND/Runge.f`（323行）, `MRBOND/temp.c`（265行 = サンプルの生成コード）

---

## アーキテクチャ

Mr.Bondは「**モデル固有コード生成 + 汎用ソルバ**」方式。

### ビルド時合成
```
temp.c         (GUIから生成、モデル固有の関数群)
   +
Runge.c        (汎用ソルバ、main()とRunge-Kutta実装)
   ↓ bcc32 コンパイル
temp.exe       (1モデル専用シミュレータ)
```

Fortran版は `temp.f` + `Runge.f`（+ 補助 `bgs.for`）を `f90` でコンパイル。機能的には同等。

### 実行時フロー
```
temp.PAR (パラメータ+初期値+時間設定) → temp.exe → temp.csv
```

---

## ソルバアルゴリズム: Runge-Kutta-Gill 4次

**発見:** 実装は古典RK4ではなく **Gill変法（Gill's 4th-order Runge-Kutta）**。丸め誤差を抑えるために√2を使った係数設計。

係数: `CS1 = 1/√2`, `CS2 = √2`

4ステージの重み:
| ステージ | DXの重み（PHI累積） | X1算出式 |
|---------|-------------------|---------|
| 1 | `+DX[i]` | `X1 = X + 0.5·H·DX` |
| 2 | `+(2 - √2)·DX[i]` | `X1 = X + (CS1 - 0.5)·H·K0 + (1 - CS1)·H·DX` |
| 3 | `+(2 + √2)·DX[i]` | `X1 = X - CS1·H·K0 + (1 + CS1)·H·DX` |
| 4 | `+DX[i]` | — |

**最終更新:** `X[i] += PHI[i] · H / 6.0`

**重み合計の検証:** `1 + (2-√2) + (2+√2) + 1 = 6` ✓（古典RK4の `1+2+2+1=6` に相当）

### 擬似コード（移植用）
```
function runge_gill_step(X, H, t, FUNC, SOLV):
    CS1 = 1/sqrt(2)
    CS2 = sqrt(2)
    N = length(X)
    X1 = copy(X); K0 = zeros(N); PHI = zeros(N); DX = zeros(N)

    SOLV(t, X1); FUNC(t, X1, DX)
    for i in 0..N-1:
        X1[i] = X[i] + 0.5*H*DX[i]
        PHI[i] += DX[i]
        K0[i] = DX[i]

    t += 0.5*H
    SOLV(t, X1); FUNC(t, X1, DX)
    for i in 0..N-1:
        X1[i] = X[i] + (CS1 - 0.5)*H*K0[i] + (1 - CS1)*H*DX[i]
        PHI[i] += (2 - CS2)*DX[i]
        K0[i] = DX[i]

    SOLV(t, X1); FUNC(t, X1, DX)
    for i in 0..N-1:
        X1[i] = X[i] - CS1*H*K0[i] + (1 + CS1)*H*DX[i]
        PHI[i] += (2 + CS2)*DX[i]

    t += 0.5*H
    SOLV(t, X1); FUNC(t, X1, DX)
    for i in 0..N-1:
        PHI[i] += DX[i]
        X[i] += PHI[i]*H/6.0

    SOLV(t, X)
    return X, t
```

---

## SOLV: 制約方程式の反復解法

ボンドグラフでは代数的制約（Derivative causality等）が現れる。SOLVはそれらをガウス・ザイデル的な反復で解く。

```
SOLV(T, Y):
  if ND == 0: return  // 制約なし
  D0 = 1.0e-8         // 相対誤差閾値
  loop:
    ICHK = 0
    for i in 0..ND/2 - 1:
      DE1[i] = FU(2i-1, T, Y)    // DE系の方程式評価
      if |DE1[i] - DE[i]| > D0 * |DE[i]|: ICHK = 1
      DE[i] = DE1[i]
      DF1[i] = FU(2i, T, Y)      // DF系の方程式評価（C版にバグ?: DF1[i]更新が欠落、DF[i]=DF1[i]代入先のみ）
      if |DF1[i] - DF[i]| > D0 * |DE[i]|: ICHK = 1  // ※この判定の D1 はDE基準、意図的か誤植か要検討
      DF[i] = DF1[i]
    if ICHK == 0: break
```

**⚠️ 注意点:** Runge.c の SOLV には Fortran版に比べてバグ臭い箇所がある（`DF1[i]` を代入する行が抜けている、DF更新の判定基準が DE になっている等）。Fortran版を正として移植すべき。

---

## データフロー

### グローバル変数（移植時は構造体化推奨）
| 変数 | 型 | 用途 |
|------|---|------|
| `X[130]` | double[] | 状態変数（積分対象） |
| `DX[130]` | double[] | 状態変数の時間微分（FUNC出力） |
| `OP[100]` | double[] | 出力変数（DOUT出力） |
| `PA[10000]` | double[] | モデルパラメータ（Parameter Array） |
| `DE[40], DF[40]` | double[] | 制約方程式の残差（Differential Effort / Flow） |
| `PT[4]` | double[] | 時間設定: PT[1]=T0, PT[2]=T1, PT[3]=TI（dt） |
| `LABEL[100][20]` | char[][] | 出力変数名 |
| `NS` | int | 状態変数の数（Number of States） |
| `ING` | int | インテグレータ数 |
| `ND` | int | 制約方程式ペア数 × 2 |
| `NOT` | int | 出力タイムステップ数（Number Of Times） |
| `NOUT` | int | 出力変数の数 |
| `T, H` | double | 現在時刻、時間刻み |

### テンポラル分割出力制御
`CONSTVALUE = 10^9` で巨大ステップ数を分割ループ。`QUOTIENT = T / CONSTVALUE`, `ODD = T mod CONSTVALUE` で内外2重ループにしてオーバーフロー回避。モダン実装では単一ループでOK（JavaScriptなら53bit安全整数で全然足りる）。

---

## モデル固有関数（temp.c のパターン）

GUIから生成されるモデル依存コード。要素タイプごとに以下が生成される:

### 要素関数（ボンドグラフ構成則）
| 関数名 | 引数 | 戻り値 | 意味 |
|--------|------|-------|------|
| `E1()`, `E2()`, ... | なし（`T`はグローバル） | 効果 (Effort) | 効果源（Se） |
| `F1()`, `F2()`, ... | なし | 流れ (Flow) | 流源（Sf） |
| `R1(J, Z)`, `R2(J, Z)` | 因果 J, 信号 Z | 効果 or 流れ | 抵抗（R） |
| `C1(Z)`, `C2(Z)` | 変位 Z | 効果 | 容量（C） |
| `L1(Z)`, `L2(Z)` | 運動量 Z | 流れ | インダクタンス（I） |
| `TF1()`, `TF2()` | なし | 変換比 | トランスフォーマ（TF） |
| `GY1()`, ... | なし | ジャイレータ率 | ジャイレータ（GY） |

`PA[N]` を通じてGUI側で設定したパラメータを参照。式はBGE内に保存されてる文字列（例: `E=EIN;`, `L=Z/M;`, `C=PK*Z;`, `R=PCF*Z;`）を要素内で展開したもの。

### DOUT: 出力割当
```c
void DOUT(){
  OP[0] = X[6];                          // 直接状態
  OP[1] = C4(X[5]) / TF1();              // 合成式
  OP[2] = TF2() * C3(X[4]);
  ...
}
```
GUIで「出力したい変数」をユーザーが選択 → その式が並ぶ。

### FUNC: 状態方程式
```c
void FUNC(double T, double X[], int N){
  DX[0] = (E1() - R1(0, L1(X[0])) - C1(X[1]));
  DX[1] = (L1(X[0]) - R2(1, (C1(X[1]) - C4(X[5]))));
  ...
}
```
各 `DX[i]` は1接点/0接点のKCL/KVL相当から組まれる効果和・流れ和。

### FU: 制約残差
代数的制約（derivative causality）がある場合に、残差をゼロにする反復計算のために各制約の現在値を返す。サンプルの `temp.c` では `FU=0.0` で制約なしモデル。

---

## 入力ファイル: .PAR フォーマット

テキスト形式、1行1レコード、レコードタイプ2文字プレフィックス。

| タイプ | 書式 | 意味 |
|--------|------|------|
| `PA NNNN  VVVVVVVV` | `2X,I4,2X,D15.8` | `PA[NNNN] = V`（モデルパラメータ値） |
| `SU NNN  NAMEE` | `2X,I3,2X,A5` | State Variable 名前登録（番号NO、名前NAM） |
| `LA NNN  NAMEE` | `2X,I3,2X,A5` | Label 出力変数名登録 |
| `NS NNNNN` | `5X,I11` | 状態数 |
| `IN NNNNN` | `5X,I11` | インテグレータ数 |
| `ND NNNNN` | `5X,I11` | 制約方程式ペア数×2 |
| `PT N  VVVVV` | `2X,I4,2X,D15.8` | PT[1]=T0, PT[2]=T1, PT[3]=Δt |
| `NO NNNNN` | `5X,I11` | 出力タイムステップ数 |
| `OP NNNNN` | `5X,I11` | 出力変数数 |
| `ST NNN  VVVV` | `2X,I4,2X,D15.8` | State初期値 X[NO-1]=V |
| `END` | — | 終端 |

### C版の注意
`PARM()` の文字列パース実装は位置固定の `LINE[i+offset]` でハードコード。区切りはスペース依存で脆い。Fortran版の `FORMAT` 指定の方が厳密。移植では書式を明示的にパースすること。

---

## 出力ファイル: .csv / .BGS

### CSV出力（`Runge.c`, `PLO()`）
```
TIME         , VAR1_LABEL, VAR2_LABEL, ..., VARN_LABEL
0.000000e+00,  V1,  V2,  ...,  VN
1.000000e-05,  V1,  V2,  ...,  VN
...
```
- 科学表記 `%e` 形式
- 区切りはカンマ
- 1行目ヘッダ（TIMEと各LABEL）
- 2行目以降は `(T1-T0)/NOT` 間隔でサンプリング

### BGS出力
テキスト中間形式のようだが本ソルバ（Runge.c）では直接書き出しなし。Mr.Bondver1.5.2.exe 側で `.csv` を `.BGS` に変換しているか、Graph.exe が `.csv` と `.BGS` の両対応。要 `Fbgsp.exe` / `Cbgsp.exe` 解析。

---

## 移植時のリスクと対策

### 1. Fortran vs C 実装差異
- `Runge.f` が正仕様、`Runge.c` はバグ混入の疑い（SOLV内のDF扱い）
- 移植時は **Fortran版を参照実装として採用**

### 2. 数値精度
- `double`（64bit IEEE754）前提
- JavaScriptのNumberと互換、Python float とも互換
- Rust/WASMなら `f64` 使用

### 3. 反復発散ガード
- `SOLV` は無限ループする可能性あり（収束しない時）
- 移植時は最大反復回数を必ず設定（例: 1000回）
- 収束失敗時は警告 or 停止

### 4. メモリ上限
- `X[130], OP[100], PA[10000], DE/DF[40]` は固定配列
- モダン実装では動的配列（Array, Vec）にして上限撤廃

### 5. I/O の CSV ストリーム化
- 大規模シミュレーションで `OP` の全時刻データをメモリに保持するとブラウザが死ぬ
- ストリーム書き出し or Web Worker + IndexedDB 推奨

---

## モダン実装案

**技術スタック候補:**
- **TypeScript** でソルバ実装（型安全、Webブラウザネイティブ）
- **数値計算だけRust + WASM化** も選択肢（性能重視ならこっち、複雑度UP）
- ソルバの呼び出し interface は `(t0, t1, dt, initialX, FUNC, DOUT, SOLV) → stream of (t, OP)` にして generator/async iterator で返す

**再実装スコープ:**
1. ソルバ（Runge-Kutta-Gill 4次）— 数十行で書ける
2. 制約ソルバ（SOLV）— 反復版、Fortran版忠実移植
3. BGE → 内部AST（次の仕様書参照）
4. AST → FUNC/DOUT/SOLV 式の評価関数（eval排除、tiny DSLパーサ実装）
5. CSV 出力 / プロット（Plotly or Chart.js 連携）

---

## 未解決の疑問

- [ ] `Fbgsp.exe` / `Cbgsp.exe` の役割: GUIから直接呼ばれるバッチ処理系か？
- [ ] `.BGS` バイナリ形式の正確な仕様
- [ ] `Graph.exe` のプロット仕様（CSV列の何をどう描画か）
- [ ] 追加機能: 実験データ補間ロジック（stringsから `expData, expTime, 補間関数` の存在を確認、Mr.Bond GUI で「experimental data import」機能がある模様）
- [ ] パラメータ名 `PA[1]` ～ `PA[N]` の命名規則（GUIでの紐付け方式）

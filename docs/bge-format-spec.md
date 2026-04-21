---
created: 2026-04-21
updated: 2026-04-21
---

## 概要

Mr.Bond のモデルファイル `.BGE`（Bond Graph Editor）の独自テキストフォーマット解析結果。移植時の互換読み込み実装のための仕様メモ。

関連プロジェクト: [[🦎Mr.Bondモダナイゼーション]]
参考ファイル: `BGE_files/バネ-マス-ダンパ.BGE`, `FD_valve.BGE`, `SN_valve.BGE`（全21本中の小規模3本）

**ステータス:** 初期解析完了。全フィールド意味は確定しきってない（「要検証」箇所あり）が、パーサ実装に足る情報は揃った。

---

## 基本構造: 整数ストリーム + 文脈依存の文字列

BGEは **ASCII テキストの1行ファイル**（改行はフィールド内部の文字列のみに存在）。スペース区切りで **「型コード N + 値」** が延々と並ぶ。

### ⚠️ 重要訂正（2026-04-21 実ファイル解析で判明）

**初稿では「型コード3=文字列」と書いたが誤り**。全ての型コード 2/3/4/5 は **整数の幅分類にすぎない**。文字列は型コードで識別されず、**文脈（出現位置）で判定**する。

### 型コード（整数の幅分類）
| 型コード | 意味 | 後続 |
|---------|------|------|
| `2` | 小整数（0〜9程度、単一桁） | 整数1個 |
| `3` | 中整数（10〜99程度 or 負値） | 整数1個 |
| `4` | 中整数（100〜9999、画面座標など） | 整数1個 |
| `5` | 大整数（10000以上） | 整数1個 |

### 文字列の格納形式
**長さアトム（型コード + 値=バイト数）+ 1バイト区切り空白 + 指定バイト数の生データ**

例: `バネ-マス-ダンパ.BGE` 冒頭のパラメータ名 `EIN`:
```
2 3 EIN2 4 10.0
↑   ↑↑↑
code=2, value=3, これは「次の3バイトが文字列」を意味する
(空白1バイト消費後) "EIN" 3バイト
その後 "2 4 10.0" = code=2, value=4, 4バイト文字列 "10.0"
```

値の大きさに応じて長さアトムの型コードは変化する:
- 9バイト以下の文字列: `2 N`
- 10〜99バイト: `3 N`
- 100〜9999バイト: `4 N`
- 10000バイト以上: `5 N`

### 「負値 `3 -1`」のパターン
型コード3で負値が入ることがある（`3 -1` など）。これは「未接続」「無効」を意味する**整数値**であり、文字列ではない。

### パース擬似コード
```
while not EOF:
    type_code = read_int()
    match type_code:
        case 2: value = read_int()       // 0-999 小整数
        case 3:
            length = read_int()
            read_whitespace()            // スペース1つスキップ
            value = read_bytes(length)   // 指定バイト数そのまま
        case 4: value = read_int()       // ~9999
        case 5: value = read_int()       // ~99999+
        case _: error
    tokens.push((type_code, value))
```

**⚠️ 注意:** `3` 型の文字列内には改行が含まれる場合あり（SN_valve等）。長さで固定読み込みすること。

---

## ファイル構造（論理レイアウト）

1. **ヘッダ:** 要素数 / ボンド数 / ビュー設定
2. **要素ブロック:** 要素数ぶん繰り返し（各要素=固定フィールド配列）
3. **ボンドブロック:** ボンド数ぶん繰り返し
4. **シミュレーション設定:** T0 / T1 / Δt / NOT / 出力変数リスト

---

## 1. ヘッダ

バネ-マス-ダンパ.BGEの冒頭:
```
2 9   2 9   2 1 2 1 2 1 2 1 2 1 2 0 2 0 2 2 2 2
↑      ↑     ↑
要素数  ボンド数  表示設定（グリッド、スナップ、等）
```

FD_valve.BGE: `3 11 3 10 2 1 2 1 2 1 2 3 ...` ← 要素11, ボンド10（`3 11`, `3 10` は小整数でも10以上なら `3` でくる?）

**要検証:** 型コード `3` が「長さ11の文字列」なのか「整数11」なのかは文脈依存の可能性。数値コンテキストでは「3桁以上の数字扱い」の可能性大。→ パーサは「次が数値期待コンテキストなら 2/3/4/5 全て整数として読み、文字列コンテキストなら `3` のみ文字列として読む」という状態依存処理が必要そう。

---

## 2. 要素ブロック

各要素は以下の **固定長フィールド配列** で表現される（要素タイプごとに若干差異）:

```
[type] [subtype] [grid_w] [grid_h] [bbox_x1] [bbox_y1] [bbox_x2] [bbox_y2]
 [port0] [port1] [port2] [port3] [port4] [port5] [port6] [port7]       # 8ポート×causality情報
 [param_count] [param_name_str] [param_value_str] [param_unit_str] [param_desc_str]
 [equation_count] [equation_str]
 [output_var_binding] [internal_var_str]
```

### 要素タイプコード（推定）
バネ-マス-ダンパ.BGE の冒頭要素は `2 3 2 1 3 45 3 30 4 714 4 360 4 759 4 390` で始まる。

`2 3` = 要素タイプ3 = Effort源（Se）という推測が成立。以下対応表:

| コード | 略称 | 意味 | サンプル内の該当 |
|--------|------|------|----------------|
| `2 1` | I | Inertia（慣性、質量） | `M` (mass) |
| `2 2` | C | Capacitance（容量、バネ） | `PK`, `PCF` |
| `2 3` | Se | Source of Effort（効果源） | `EIN` |
| `2 4` | Sf | Source of Flow（流源） | `PF` |
| `2 5` | R | Resistance（抵抗） | |
| `2 6` | 0 | 0-junction（並列接合） | |
| `2 7` | 1 | 1-junction（直列接合） | |
| `2 8` | TF | Transformer | |
| `2 9` | GY | Gyrator | |

※ FD_valve.BGE では `3 45 3 30` で始まる行も多い → `3` がここでは座標の大きい値（45）を示してる可能性もあり、要検証。バネ-マス-ダンパ では `3 45 3 30` = 幅45, 高さ30（= `2 45 2 30` と意味的同じ）。→ **「型3は数値で使う時は length=1byteで数字1文字」の可能性あり**。小さな数字でも `3 N` として格納されるケースがある。要サンプル比較検証。

### 座標フィールド
`4 X` 形式で画面ピクセル座標（左上原点）。バネ-マス-ダンパ では `4 714 4 360 4 759 4 390` = (714, 360)-(759, 390) のbbox。

### ポート情報（causality）
8個の「ポート」情報が `2 N 2 M 2 P 3 -1` のようなパターンで続く。各ポートに:
- 接続ボンドID（-1なら未接続、`3 -1` で「文字列"-1"」として記録）
- 因果の向き（1=effort in, 0=flow in 等）
- 補助フラグ

詳細は実ボンドとの対応から逆引き検証必要。

### パラメータセクション
```
2 1 3 N "PARAM_NAME"   // パラメータ数1, 名前文字列
2 M 4 10.0             // 値（※ 4 の後が数値ではなく「文字列でない数値」表現）
```

例: バネ-マス-ダンパ の M要素（質量）:
```
2 1 M 2 4 10.0 ...     // "M" が名前、10.0 が値
```

**要検証:** 数値値のエンコード（「4 10.0」で「10.0」を表す場合、`4` は「次は浮動小数点文字列」を示す型コード?）

### 式文字列
各要素の物理方程式:
- `3 6 "E=EIN;"` — Effort源の式
- `3 6 "L=Z/M;"` — 慣性の式（Z=運動量, L=流れ）
- `3 7 "C=PK*Z;"` — バネの式
- `3 8 "R=PCF*Z;"` — ダンパの式
- `3 5 "F=PF;"` — 流源の式

文字列の長さが正確で、先頭に `3 L` のLength prefix。

### 複雑な式の例（FD_valve）
```
3 41 "AFDD=(PAPAI*PAFDD*PAFDD)/4.0;\nTF=1/AFDD;"
```
改行含みの複数行式も1つの文字列として格納。パーサは `\n` をそのまま保持する。

### 条件分岐式の例
FD_valve.BGE の E要素:
```
3 158 "if(9.1e-003<=POS){\nPOS=9.1e-003;\nXfd=0.0;\nE=-sfd2-sfd3-sfd7-sfd8;\n}else if..."
```
C言語そのまま埋め込み。**これは深い問題:** JS/TS移植時にこのC式を実行する手段が必要。

**対応案:**
- **Option A:** tiny Cサブセットパーサを書く（`if/else/代入/四則/関数呼び出し`）
- **Option B:** eval / Function constructor で動的実行（セキュリティリスクあり）
- **Option C:** acorn等のJSパーサを流用しC→JS変換

推奨: **Option A**。式は限定されたDSLなので、expression-parser級の実装で十分。

---

## 3. ボンドブロック

各ボンドは固定フィールド:
```
2 [id] 2 [from_element] 2 [to_element] 2 [junction_port]
4 [x1] 4 [y1] 4 [x2] 4 [y2] 4 [x3] 4 [y3] 4 [x4] 4 [y4]    // ポリライン 4点
2 [causality] 2 [flow_direction] 2 [power_sign] 2 [active]
3 13 "0.0000000E+00"                                        // 初期値（state初期値?）
```

サンプル:
```
2 1 2 0 2 4 2 0 4 603 4 365 4 602 4 381 4 712 4 383 4 713 4 367 2 0 2 0 2 0 2 0 2 1 2 0 3 13 0.0000000E+00
↑    ↑    ↑    ↑    ↑
id=1  from  to   junc  4点の描画用座標（ベジエ or ポリライン）
```

9本のボンドがすべて `3 13 "0.0000000E+00"` で終わってる → state初期値0（全ての状態変数が時刻0で0）。

---

## 4. シミュレーション設定（ファイル末尾）

バネ-マス-ダンパ末尾:
```
3 11 "0.00000E+00"    // T0 = 0
3 11 "1.00000E+01"    // T1 = 10.0
3 11 "1.00000E-05"    // Δt = 1e-5
2 4 1000              // NOT = 1000 出力ステップ数
2 1 3 12 "Displacement"  // 出力変数1個、名前"Displacement"
2 1 2                 // 終端マーカー?
```

FD_valve末尾:
```
3 11 "0.00000E+00"    // T0
3 11 "1.20000E+01"    // T1 = 12
3 11 "1.00000E-05"    // Δt
2 5 10000             // NOT
2 6                   // 出力6変数
3 12 "Displacement" 2 1 1
3 6 "Effort" 2 1 2
3 6 "Effort" 2 1 3
3 6 "Effort" 2 1 7
3 6 "Effort" 2 1 8
3 6 "Effort" 2 1 4
```

### 出力変数レコード
`2 N 3 L "Name" 2 1 [elem_id]` = 「要素elem_idの N番目の変数をNameとして出力」

---

## 要素内変数バインディング（出力紐付け）

要素定義内に、その要素のどの内部変数を「LA出力」として登録するかの情報がある。FD_valve の E 要素末尾:
```
2 6 2 3 POS 3 12 "Displacement" 2 1 1
           2 3 Xfd 2 8 "Momentum"     2 1 1  // Xfd → 出力番号1 Momentum
           2 4 sfd2 2 6 "Effort"      2 1 2
           2 4 sfd3 2 6 "Effort"      2 1 3
           ...
```
内部変数 `POS`, `Xfd`, `sfd2`, ... が、それぞれラベル `Displacement`, `Momentum`, `Effort` として番号 1, 2, 3, ... で出力される。

---

## 単位・説明フィールド

各パラメータには単位と説明文字列が付く。マルチバイト文字（Shift-JIS）で記述。

FD_valve例:
```
3 12 "PAFDD\nPAPAI"                     // 2個の名前（改行区切り）
3 19 "1.745e-002\n3.141592"             // 2個の値（改行区切り）
4 "m\n-"                                // 単位
3 22 "TH/Vｼｽﾄﾝ直径\n円周率"              // 説明（Shift-JIS）
```

**⚠️ エンコーディング:** ファイルは **Shift-JIS（CP932）**。UTF-8で読むと日本語が化ける。パーサ実装時は `iconv-lite` 等で CP932 → UTF-8 変換必須。

---

## パーサ実装戦略（推奨）

### 段階的アプローチ
1. **Phase A: トークナイザ** — ファイル全体を `{type, value}` のトークン列に変換
2. **Phase B: 構造パーサ** — ヘッダ → 要素×N → ボンド×M → 設定 の順にトークン消費
3. **Phase C: 要素タイプ別パーサ** — 要素タイプごとの固定フィールド処理
4. **Phase D: 式字句解析** — 埋め込まれたC式サブセットを AST化

### TypeScriptでのトークナイザ例（骨格）
```typescript
type Token =
  | { type: 'int'; code: 2 | 4 | 5; value: number }
  | { type: 'str'; length: number; value: string };

function tokenize(buf: Buffer): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < buf.length) {
    // スペース・改行スキップ
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (pos >= buf.length) break;

    // 型コード読み取り
    const typeStart = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    const typeCode = parseInt(buf.slice(typeStart, pos).toString('ascii'), 10);

    if (typeCode === 3) {
      // 文字列: 次の整数が長さ
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      const lenStart = pos;
      while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
      const length = parseInt(buf.slice(lenStart, pos).toString('ascii'), 10);
      // スペース1つ消費
      pos++;
      const strBuf = buf.slice(pos, pos + length);
      const value = iconv.decode(strBuf, 'shift_jis');
      tokens.push({ type: 'str', length, value });
      pos += length;
    } else if ([2, 4, 5].includes(typeCode)) {
      // 整数: 次のトークンが値
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      const valStart = pos;
      while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
      const value = parseInt(buf.slice(valStart, pos).toString('ascii'), 10);
      tokens.push({ type: 'int', code: typeCode as 2|4|5, value });
    }
  }
  return tokens;
}
```

※ 実際には文字列の長さフィールドが `3 L` なのか `4 L` なのかサンプルで混在する可能性あり。両対応が必要かもしれん。

---

## 内部表現（AST）案

BGEをパースした後の中間表現:

```typescript
interface BondGraphModel {
  elements: Element[];
  bonds: Bond[];
  simulation: {
    t0: number;
    t1: number;
    dt: number;
    outputSteps: number;   // NOT
    outputs: OutputVar[];
  };
}

interface Element {
  id: number;
  type: 'Se' | 'Sf' | 'R' | 'I' | 'C' | 'TF' | 'GY' | '0-junction' | '1-junction';
  position: { x1: number; y1: number; x2: number; y2: number };
  parameters: Parameter[];
  equation: string;           // 元C式（or パース済みAST）
  ports: Port[];
  internalVars: InternalVar[];
}

interface Parameter {
  name: string;               // 例: "PK", "PAFDD"
  value: number;
  unit: string;
  description: string;
}

interface Bond {
  id: number;
  from: { element: number; port: number };
  to:   { element: number; port: number };
  polyline: Array<{ x: number; y: number }>;
  causality: number;
  initialValue: number;       // stateの初期値
}

interface OutputVar {
  name: string;                // 例: "Displacement"
  label: string;               // 例: "Effort"
  elementId: number;
  internalVarName: string;     // 要素内部での変数名
}
```

---

## 未解決事項・今後の検証

- [ ] 型コード `3` が「文字列」と「整数」のどちらで読むべきかの厳密判定
- [ ] 要素タイプコード表の全量確定（大規模BGEで検証）
- [ ] ポート causality フィールドの正確な意味
- [ ] 線形グラフ変換器 MTF / MGY（可変トランスフォーマ）の記録形式
- [ ] サブシステム（BGEのサブグラフ参照）がある場合の記録形式
- [ ] Graph.exe のビューポート設定（BGE末尾のビュー座標等）
- [ ] Shift-JIS の化け対策（元ファイルが破損していないか）

---

## 次のアクション

1. パーサプロトタイプ（TypeScript）を実装 → 21個のBGEを全部食わせてエラーフリーで通るか確認
2. `バネ-マス-ダンパ.BGE` を完全デコードして、Mr.Bond で開いた時のモデル図と1:1で対応することを検証（手動で要素位置・パラメータ・式を照合）
3. 式パーサ（C式サブセット）の文法定義
4. AST → JavaScript関数（`FUNC`, `DOUT`, `SOLV`, 要素関数）のコード生成器実装

関連: [[📕Mr.Bondソルバ仕様]]

/// <reference lib="dom" />

/**
 * BGE バイナリ書き出し（Mr.Bond 互換）。
 *
 * BGE は ASCII テキスト1行ファイル（文字列内部のみ改行あり）で、スペース区切りの
 * 「型コード + 値」アトムが並ぶ。型コード 2/3/4/5 は整数の幅分類にすぎず、
 * 文字列は「長さアトム + 1バイト区切り空白 + 生バイト列」で表現される。
 *
 * このライタは `バネ-マス-ダンパ.BGE` を手本に下記レイアウトで書き出す:
 *   1. ヘッダ: 要素数 / ボンド数 / ビュー設定アトム列
 *   2. 要素ブロック: 要素数ぶん繰り返し（type, subtype, grid, bbox, 8ポート×4, params...）
 *   3. ボンドブロック: 各ボンドの id/from/to/junction, ポリライン8座標, フラグ, 初期値
 *   4. シミュレーション設定: T0, T1, dt, NOT, 出力変数リスト
 *
 * 既知の制約（bgeWriter.test.md 参照）:
 * - Shift-JIS は `encoding-japanese` 経由でフル対応（日本語パラメータ名もOK）。
 * - 座標/ポート causality 等は pragmatic 値で埋める（Mr.Bond 側での完全再現は目指さない）。
 * - `BgeReader` で再パースできる round-trip 保証が合格条件。
 *
 * 公開 API:
 *   writeBge(doc)               → Uint8Array（BGE バイナリ）
 *   mountBgeExportButton(c, s)  → cleanup 関数（"Save as BGE" ボタンを差し込む）
 */

import type { Store } from '../shared/store.ts';
import type {
  Bond,
  BondGraphDoc,
  Element,
  ElementKind,
} from '../shared/model.ts';
// @ts-expect-error - encoding-japanese has no types, use any
import Encoding from 'encoding-japanese';

// ---- 要素タイプコード（実ファイル解析に基づく）----
//
// 注意: docs/bge-format-spec.md の初期推定では「6=0-junction, 7=1-junction, 8=TF」と
// 書かれていたが、実ファイル（バネ-マス-ダンパ.BGE）の解析では BGS の `OJ`（1-junction）
// が type=8 として記録されており、`ZJ`（0-junction）が type=7 として記録されていた。
// ここでは実ファイルの値を正とする。
const ELEMENT_TYPE_CODE: Record<ElementKind, number> = {
  I: 1,
  C: 2,
  Se: 3,
  Sf: 4,
  R: 5,
  ZeroJunction: 7,   // ZJ
  OneJunction: 8,    // OJ
  TF: 6,             // 変換器（推定値、サンプルなし）
  GY: 9,             // ジャイレータ（推定値、サンプルなし）
};

// ---- 低レベルアトム/文字列ライタ ----

/**
 * 出力バッファのビルダ。
 * 先頭は絶対にアトムで始まる前提（空文字なら stray スペースを挿入しない）。
 */
class BgeBuffer {
  private chunks: Uint8Array[] = [];

  /** 純ASCIIコード範囲の文字列をそのまま追記（length-prefix なし）。 */
  private pushAscii(text: string): void {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0x7f) {
        // 非 ASCII はロッシーに '?' に置き換え（警告はコンソールへ）
        // 将来 iconv-lite 等で Shift-JIS 変換を追加する際のフック地点。
        bytes[i] = 0x3f; // '?'
      } else {
        bytes[i] = code;
      }
    }
    this.chunks.push(bytes);
  }

  /**
   * `<code> <value>` のアトムを1つ書く。
   * 必要なら先頭に空白を付ける（最初のアトム以外）。
   */
  writeAtom(code: 2 | 3 | 4 | 5, value: number): void {
    if (this.chunks.length > 0) this.pushAscii(' ');
    this.pushAscii(`${code} ${value}`);
  }

  /**
   * 整数値を適切な型コード（2/3/4/5）で自動選択して書き出す。
   * - 0..9  → code 2
   * - それ以外で -99..99 の負値 または 10..99 → code 3
   * - 100..9999 → code 4
   * - それ以外（10000+ or 大きな負値） → code 5
   *
   * ただし「幅コード」は意味論（小さな値でも code 3 で書く事がある）によって
   * 呼び出し側から明示指定したい場面がある。その場合は `writeAtom` を直接使う。
   */
  writeAutoInt(value: number): void {
    const code = pickIntCode(value);
    this.writeAtom(code, value);
  }

  /**
   * 長さアトム + 1バイト区切り空白 + 指定バイト数の文字列。
   * ASCII 範囲のみサポート。非 ASCII は '?' に置換。
   */
  writeLengthPrefixedString(text: string): void {
    const bytes = encodeShiftJis(text);
    const lenCode = pickLengthCode(bytes.length);
    this.writeAtom(lenCode, bytes.length);
    // BgeReader は長さアトム直後の 1 バイトスペースを消費してから length バイト読む。
    // writeAtom は次アトムの手前にスペースを置く設計（= 今回のスペースがその役割）。
    this.pushAscii(' ');
    this.chunks.push(bytes);
    // 文字列の直後にスペースは付けない（次の writeAtom が自分でスペースを置く）。
    // 注意: 長さ0の文字列でも長さアトム+1バイト空白で終わる。
  }

  toUint8Array(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/** 整数値の幅から型コードを自動選択。 */
function pickIntCode(value: number): 2 | 3 | 4 | 5 {
  if (value >= 0 && value <= 9) return 2;
  if (value >= -99 && value <= 99) return 3;
  if (value >= -9999 && value <= 9999) return 4;
  return 5;
}

/** 文字列長から長さアトムの型コードを選択。 */
function pickLengthCode(length: number): 2 | 3 | 4 | 5 {
  if (length <= 9) return 2;
  if (length <= 99) return 3;
  if (length <= 9999) return 4;
  return 5;
}

/**
 * 文字列を Shift-JIS バイト列にエンコード。
 *   - ASCII 範囲: そのまま 1 バイト
 *   - 日本語（ひらがな/カタカナ/漢字）: encoding-japanese で Shift-JIS 2 バイト
 *   - 変換不能文字は '?' に置換
 */
function encodeShiftJis(text: string): Uint8Array {
  if (text === '') return new Uint8Array(0);
  // 全部 ASCII なら高速パスで直書き
  let allAscii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) { allAscii = false; break; }
  }
  if (allAscii) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }
  // 非 ASCII 含む: encoding-japanese で変換
  // 型宣言がないのでキャスト。convert は number[] を返す。
  const bytes: number[] = (Encoding as unknown as {
    convert: (data: string, opts: { to: string; from: string; type: string; fallback?: string }) => number[];
  }).convert(text, { to: 'SJIS', from: 'UNICODE', type: 'array', fallback: 'html-entity' });
  return new Uint8Array(bytes);
}

// ---- ドキュメントシリアライズ ----

/**
 * BondGraphDoc を BGE バイナリに変換する。
 *
 * レイアウト（バネ-マス-ダンパ.BGE を手本にした pragmatic 版）:
 *   [header: 要素数, ボンド数, 9個のビュー設定アトム]
 *   [element × N]
 *   [bond × M]
 *   [T0 str, T1 str, dt str, NOT int]
 *   [output_count, 出力変数レコード × K]
 *   [終端マーカー: `2 1 2`]
 */
export function writeBge(doc: BondGraphDoc): Uint8Array {
  const buf = new BgeBuffer();

  const nElem = doc.elements.length;
  const nBond = doc.bonds.length;

  // ---- 1. ヘッダ ----
  // 要素数
  buf.writeAutoInt(nElem);
  // ボンド数
  buf.writeAutoInt(nBond);
  // ビュー設定（バネ-マス-ダンパ と同じパディングを採用: 2 1 2 1 2 1 2 1 2 1 2 0 2 0 2 2 2 2）
  // 合計 9 アトムで、全て code=2。
  const viewAtoms: readonly number[] = [1, 1, 1, 1, 1, 0, 0, 2, 2];
  for (const v of viewAtoms) buf.writeAtom(2, v);

  // 要素 ID から 0-based index へのマップ（ボンド参照用）
  const elemIndex = new Map<string, number>();
  doc.elements.forEach((e, i) => elemIndex.set(e.id, i));

  // ---- 2. 要素ブロック ----
  for (const el of doc.elements) {
    writeElement(buf, el);
  }

  // ---- 3. ボンドブロック ----
  doc.bonds.forEach((b, i) => {
    writeBond(buf, b, i, elemIndex, doc);
  });

  // ---- 4. シミュレーション設定 ----
  buf.writeLengthPrefixedString(formatSimNum(doc.simulation.t0));
  buf.writeLengthPrefixedString(formatSimNum(doc.simulation.t1));
  buf.writeLengthPrefixedString(formatSimNum(doc.simulation.dt));
  buf.writeAutoInt(doc.simulation.numOutputSteps);

  // 出力変数
  buf.writeAutoInt(doc.outputs.length);
  for (const o of doc.outputs) {
    // 出力レコード: [name_str] [2 1] [bondId or 2 N]
    buf.writeLengthPrefixedString(o.label || o.variableName);
    // 終端マーカー: 2 1 + bond index (バネ-マス-ダンパ の末尾 `2 1 2` にならう)
    buf.writeAtom(2, 1);
    // bond index（bond id の数値部、見つからなければ 0）
    const bondIdx = extractIndex(o.bondId);
    buf.writeAutoInt(bondIdx);
  }

  // 出力が空でも末尾マーカーは付けておく（reader が atEnd で終われるように）。
  // バネ-マス-ダンパ は `2 1 2` で終わっていた（= 出力1個目の 2 1 + 要素idx 2）。
  // 出力ゼロの場合は追加マーカーなしで終わる。

  return buf.toUint8Array();
}

/** Mr.Bond 方式の浮動小数文字列 "0.00000E+00" / "1.00000E-05" のような11桁書式。 */
function formatSimNum(v: number): string {
  // Number.prototype.toExponential(5) → "1.00000e-5" → 指数部を2桁ゼロ埋めに修正
  if (!Number.isFinite(v)) return '0.00000E+00';
  const exp = v.toExponential(5); // "1.00000e-5" or "1.00000e+1"
  const m = /^(-?)(\d+\.\d+)e([+-])(\d+)$/.exec(exp);
  if (!m) return exp.toUpperCase();
  const sign = m[1] ?? '';
  const mant = m[2] ?? '0.00000';
  const esign = m[3] ?? '+';
  const edigits = (m[4] ?? '0').padStart(2, '0');
  return `${sign}${mant}E${esign}${edigits}`;
}

/** "el_12" 等の末尾数値を取り出す（"bond_3" → 3）。見つからなければ 0。 */
function extractIndex(id: string): number {
  const m = /(\d+)$/.exec(id);
  if (!m) return 0;
  const n = Number.parseInt(m[1] ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

// ---- 要素 1 つ分 ----

/**
 * 1要素分を書き出す。
 *
 * レイアウト:
 *   [type(2 N)] [subtype(2 1)] [grid_w] [grid_h]
 *   [bbox_x1] [bbox_y1] [bbox_x2] [bbox_y2]   (code=4 座標)
 *   [8 ports × 4 atoms]                       (各ポート: 3×int + 1×"3 -1"未接続)
 *   [param_count(2 N)]
 *     [name_str] [value_str]                  (param_count>=1 の場合)
 *   [12 × (2 0)]  pad
 *   [equation_str]  (空ならスキップせず長さ0で書く)
 *   [10 × (2 0)]  tail pad
 */
function writeElement(buf: BgeBuffer, el: Element): void {
  // 1) type + subtype
  const typeCode = ELEMENT_TYPE_CODE[el.kind];
  buf.writeAtom(2, typeCode);
  buf.writeAtom(2, 1); // subtype: 既定 1

  // 2) グリッドサイズ（表示のセル単位幅）: サンプルでは要素種ごとに 45/30/15/21 等。
  //    ここでは pragmatic に 30 固定（バネ-マス-ダンパ の junction/I/C/R でも概ね一致）。
  buf.writeAtom(3, 30);
  buf.writeAtom(3, 30);

  // 3) bbox（座標4個）: position を中心とする 30×30 の矩形として生成
  const x = Math.round(el.position.x);
  const y = Math.round(el.position.y);
  const halfW = 15;
  const halfH = 15;
  const x1 = Math.max(0, x - halfW);
  const y1 = Math.max(0, y - halfH);
  const x2 = x + halfW;
  const y2 = y + halfH;
  // 座標は常に code=4 で書く（サンプル準拠）
  buf.writeAtom(4, x1);
  buf.writeAtom(4, y1);
  buf.writeAtom(4, x2);
  buf.writeAtom(4, y2);

  // 4) 8 ports × 4 atoms: 未接続テンプレ (2 0)(2 0)(2 0)(3 -1) を 8 回
  for (let p = 0; p < 8; p++) {
    buf.writeAtom(2, 0);
    buf.writeAtom(2, 0);
    buf.writeAtom(2, 0);
    buf.writeAtom(3, -1);
  }

  // 5) パラメータセクション
  const params = el.parameters;
  // param_count
  buf.writeAtom(2, params.length);
  // 最初の 1 個のみ出力（サンプルは全て 1 パラメータ構造）
  // 複数パラメータは改行区切りで連結するのが FD_valve 等のサンプル形式だが、
  // このライタは pragmatic にまず 1 個だけ name/value を書き出す。
  if (params.length >= 1) {
    // 複数パラメータは FD_valve 形式（改行区切り）で連結して1個の文字列として書く
    const names = params.map((p) => p.name).join('\n');
    const values = params.map((p) => formatParamValue(p.value)).join('\n');
    buf.writeLengthPrefixedString(names);
    buf.writeLengthPrefixedString(values);
  }

  // 6) 12 個の 2 0 パディング（バネ-マス-ダンパ の Se ブロック準拠）
  for (let i = 0; i < 12; i++) buf.writeAtom(2, 0);

  // 7) equation
  const eq = el.equation ?? defaultEquationFor(el.kind);
  buf.writeLengthPrefixedString(eq);

  // 8) 10 個の 2 0 トレイリングパディング
  for (let i = 0; i < 10; i++) buf.writeAtom(2, 0);
}

/** パラメータの数値表示: 整数なら整数、そうでなければ必要最小限の桁。 */
function formatParamValue(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return v.toString();
  return v.toString();
}

/** 要素タイプ別のデフォルト式（ユーザ未設定時のフォールバック）。 */
function defaultEquationFor(kind: ElementKind): string {
  switch (kind) {
    case 'Se': return 'E=EIN;';
    case 'Sf': return 'F=PF;';
    case 'I':  return 'L=Z/M;';
    case 'C':  return 'C=PK*Z;';
    case 'R':  return 'R=PCF*Z;';
    case 'TF': return '';
    case 'GY': return '';
    case 'ZeroJunction': return '';
    case 'OneJunction': return '';
  }
}

// ---- ボンド 1 つ分 ----

/**
 * 1 ボンド分を書き出す。
 *
 * レイアウト（バネ-マス-ダンパ.BGE 準拠）:
 *   [2 id] [2 from_idx] [2 to_idx] [2 junction_port]
 *   [4 x1] [4 y1] [4 x2] [4 y2] [4 x3] [4 y3] [4 x4] [4 y4]   (ポリライン 4 点)
 *   [2 0 × 4] フラグ群
 *   [2 causality_flag] [2 0]
 *   [initial_value_str (11桁科学表記)]
 */
function writeBond(
  buf: BgeBuffer,
  bond: Bond,
  index: number,
  elemIndex: Map<string, number>,
  doc: BondGraphDoc,
): void {
  // id / from / to
  const id = extractIndex(bond.id) || (index + 1);
  const from = elemIndex.get(bond.fromElementId) ?? 0;
  const to = elemIndex.get(bond.toElementId) ?? 0;

  buf.writeAutoInt(id);
  buf.writeAutoInt(from);
  buf.writeAutoInt(to);
  buf.writeAutoInt(0); // junction_port: 既定 0

  // 4 点のポリライン（要素位置間を線形補完）
  const fromEl = doc.elements.find((e) => e.id === bond.fromElementId);
  const toEl = doc.elements.find((e) => e.id === bond.toElementId);
  const fx = fromEl ? Math.round(fromEl.position.x) : 0;
  const fy = fromEl ? Math.round(fromEl.position.y) : 0;
  const tx = toEl ? Math.round(toEl.position.x) : 0;
  const ty = toEl ? Math.round(toEl.position.y) : 0;

  // 4 点 = 始点・1/3点・2/3点・終点
  const pts: ReadonlyArray<readonly [number, number]> = [
    [fx, fy],
    [Math.round(fx + (tx - fx) / 3), Math.round(fy + (ty - fy) / 3)],
    [Math.round(fx + ((tx - fx) * 2) / 3), Math.round(fy + ((ty - fy) * 2) / 3)],
    [tx, ty],
  ];
  for (const [px, py] of pts) {
    buf.writeAtom(4, px);
    buf.writeAtom(4, py);
  }

  // フラグ 4 個（全部 0）
  buf.writeAtom(2, 0);
  buf.writeAtom(2, 0);
  buf.writeAtom(2, 0);
  buf.writeAtom(2, 0);

  // causality フラグ
  const caus = bond.causality === 'effortIn' ? 1 : 0;
  buf.writeAtom(2, caus);
  buf.writeAtom(2, 0);

  // initial_value（state の初期値、0.0 固定）
  buf.writeLengthPrefixedString('0.0000000E+00');
}

// ---- UI ボタン ----

const BGE_STYLE_ID = 'mrbond-bge-export-style';

const BGE_CSS = `
.mb-bge-btn {
  min-height: 32px;
  padding: 4px 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  color: #e8eaee;
  border: 1px solid #6ee7b7;
  border-radius: 6px;
  cursor: pointer;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic', sans-serif;
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1.1;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.mb-bge-btn:hover {
  background: rgba(110, 231, 183, 0.12);
  color: #6ee7b7;
}
.mb-bge-btn:active {
  background: rgba(110, 231, 183, 0.22);
}
.mb-bge-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(110, 231, 183, 0.35);
}
`;

function ensureBgeStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(BGE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BGE_STYLE_ID;
  style.textContent = BGE_CSS;
  document.head.appendChild(style);
}

function buildBgeFilename(now: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `bondgraph-${y}-${m}-${d}-${hh}${mm}${ss}.BGE`;
}

function triggerBgeDownload(filename: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * "Save as BGE" ボタンを `container` に追加する。
 * 返り値は cleanup 関数。
 */
export function mountBgeExportButton(container: HTMLElement, store: Store): () => void {
  ensureBgeStyle();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mb-bge-btn';
  btn.textContent = '\u{1F4BE} Save as BGE';
  btn.title = 'Save current document as Mr.Bond compatible BGE binary';

  const onClick = (): void => {
    try {
      const doc = store.getState().doc;
      const bytes = writeBge(doc);
      triggerBgeDownload(buildBgeFilename(), bytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Save as BGE failed: ${msg}`);
    }
  };
  btn.addEventListener('click', onClick);

  container.appendChild(btn);

  return () => {
    btn.removeEventListener('click', onClick);
    if (btn.parentNode === container) container.removeChild(btn);
  };
}


/// <reference lib="dom" />

/**
 * BGE バイナリ → BondGraphDoc パーサ。
 *
 * `bgeWriter.ts` の出力を逆方向に歩いて `BondGraphDoc` を復元する。
 * 低レベルのアトム / 文字列読みは `src/parser/bgeReader.ts` の `BgeReader` に任せる。
 *
 * レイアウト対応表（writer 側の実装と 1:1 対応）:
 *   [header]     : 要素数 / ボンド数 / ビュー設定 9 アトム
 *   [element×N]  : type, subtype, grid_w, grid_h, bbox×4, ports×32,
 *                  param_count, (param_names_str, param_values_str)?,
 *                  pad×12, equation_str, pad×10
 *   [bond×M]     : id, from, to, junction_port, polyline×8(4 coords),
 *                  flag×4, causality, pad, initial_value_str
 *   [sim]        : T0_str, T1_str, dt_str, NOT_int
 *   [outputs]    : count, (label_str, 2 1, bond_idx)×count
 *
 * 公開 API:
 *   readBge(bytes)              → BondGraphDoc
 *   mountBgeImportButton(c, s)  → cleanup 関数（"Load BGE" ボタンを差し込む）
 *
 * 既知の制約は `bgeReader2.md` 参照。
 */

import { BgeReader, BgeParseError } from '../../../src/parser/bgeReader.ts';
import type { Store } from '../shared/store.ts';
import type {
  Bond,
  BondGraphDoc,
  Element,
  ElementKind,
  Parameter,
} from '../shared/model.ts';

// ---- 要素タイプコード（writer と対応。writer 側の実測値を正とする）----

const ELEMENT_TYPE_CODE: Record<ElementKind, number> = {
  I: 1,
  C: 2,
  Se: 3,
  Sf: 4,
  R: 5,
  TF: 6,
  ZeroJunction: 7,
  OneJunction: 8,
  GY: 9,
};

/** 数値 → ElementKind の逆引きテーブル（未知コードは null）。 */
const ELEMENT_KIND_BY_CODE: ReadonlyMap<number, ElementKind> = new Map(
  (Object.entries(ELEMENT_TYPE_CODE) as [ElementKind, number][]).map(
    ([kind, code]) => [code, kind],
  ),
);

function lookupKind(typeCode: number, offset: number): ElementKind {
  const k = ELEMENT_KIND_BY_CODE.get(typeCode);
  if (k === undefined) {
    throw new BgeParseError(
      `Unknown element type code ${typeCode} at offset ${offset}; known: 1..9`,
      offset,
    );
  }
  return k;
}

// ---- public API ----

/**
 * BGE バイナリを BondGraphDoc に復元する。
 *
 * 戦略:
 *   1. ヘッダ（要素数/ボンド数/9 ビューアトム）を読む
 *   2. 要素を N 個読む
 *   3. ボンドを M 個読む
 *   4. シミュレーション設定（T0/T1/dt/NOT）を読む
 *   5. 出力変数リストを読む
 *
 * 失敗時は `BgeParseError` が throw される（バイト位置 + 失敗内容を含む）。
 */
export function readBge(bytes: Uint8Array): BondGraphDoc {
  const r = new BgeReader(bytes);

  // ---- 1. ヘッダ ----
  const nElem = r.readAtom().value;
  const nBond = r.readAtom().value;
  if (nElem < 0 || nBond < 0) {
    throw new BgeParseError(
      `Invalid header counts: nElem=${nElem}, nBond=${nBond}`,
      0,
    );
  }
  // ビュー設定 9 アトム（意味は不明なのでスキップ）
  for (let i = 0; i < 9; i++) r.readAtom();

  // ---- 2. 要素ブロック ----
  const elements: Element[] = [];
  for (let i = 0; i < nElem; i++) {
    elements.push(readElement(r, i));
  }

  // 要素 ID セット（ボンド参照整合性チェック用）
  const idByIndex = new Map<number, string>();
  elements.forEach((el, i) => idByIndex.set(i, el.id));

  // ---- 3. ボンドブロック ----
  const bonds: Bond[] = [];
  for (let i = 0; i < nBond; i++) {
    bonds.push(readBond(r, i, idByIndex));
  }

  // ---- 4. シミュレーション設定 ----
  const t0Str = r.readLengthPrefixedString();
  const t1Str = r.readLengthPrefixedString();
  const dtStr = r.readLengthPrefixedString();
  const numOutputSteps = r.readAtom().value;

  const t0 = parseSimNum(t0Str);
  const t1 = parseSimNum(t1Str);
  const dt = parseSimNum(dtStr);

  // ---- 5. 出力変数 ----
  const nOut = r.readAtom().value;
  const bondIdByIndex = new Map<number, string>();
  bonds.forEach((b, i) => {
    // bond.id の末尾数値を使った round-trip 用マップ
    const numeric = extractIndex(b.id);
    if (numeric !== null) bondIdByIndex.set(numeric, b.id);
    // 出現順 index でもフォールバック参照できるようにしておく
    if (!bondIdByIndex.has(i + 1)) bondIdByIndex.set(i + 1, b.id);
  });

  type OutputRec = BondGraphDoc['outputs'][number];
  const outputs: OutputRec[] = [];
  for (let i = 0; i < nOut; i++) {
    const label = r.readLengthPrefixedString();
    // 終端マーカー `2 1`（仕様書記載）。writer もこれを書く。
    // 値は 1 である想定だが、違っても続行する（他バージョン互換のため）。
    r.readAtom();
    const bondIdxAtom = r.readAtom();
    const bondIdx = bondIdxAtom.value;
    const bondId =
      bondIdByIndex.get(bondIdx) ??
      (bonds[bondIdx - 1]?.id) ??
      (bonds[bondIdx]?.id) ??
      (bonds[0]?.id) ??
      `bond_${Math.max(1, bondIdx)}`;
    outputs.push({ bondId, variableName: label, label });
  }

  return {
    elements,
    bonds,
    simulation: { t0, t1, dt, numOutputSteps },
    outputs,
  };
}

// ---- 要素 1 つ分を読む ----

function readElement(r: BgeReader, index: number): Element {
  const typeAtom = r.readAtom();
  const kind = lookupKind(typeAtom.value, typeAtom.startPos);
  // subtype
  r.readAtom();
  // grid_w, grid_h
  r.readAtom();
  r.readAtom();
  // bbox 4（x1, y1, x2, y2）
  const x1 = r.readAtom().value;
  const y1 = r.readAtom().value;
  const x2 = r.readAtom().value;
  const y2 = r.readAtom().value;
  // 中心を position とする（writer 側は position ± 15 で bbox を作る）
  const px = Math.round((x1 + x2) / 2);
  const py = Math.round((y1 + y2) / 2);

  // 8 ports × 4 atoms = 32 atoms を読み飛ばす
  for (let p = 0; p < 32; p++) r.readAtom();

  // param_count
  const pc = r.readAtom().value;
  let parameters: Parameter[] = [];
  if (pc >= 1) {
    const namesStr = r.readLengthPrefixedString();
    const valuesStr = r.readLengthPrefixedString();
    parameters = parseParamPair(namesStr, valuesStr);
  }

  // 要素末尾構造は writer 側（12 pads + equation_str + 10 pads）と
  // 実 BGE ファイルで若干異なる（junction では 23 vs 25 pads など）。
  // そのため「`2 0` 連続パッド → 非ゼロアトム」を適応的に検出する方式を採る。
  //
  // アルゴリズム:
  //   1. 連続する `2 0` パッドを消費
  //   2. 次に出た非ゼロアトムが「要素方程式の長さアトム」か「次要素の type」か
  //      「ボンドブロックの先頭」かを peek で判定する:
  //      - 方程式らしい: そのまま length と読んで string を消費、更に末尾 `2 0`
  //        パッドを消費してから return
  //      - それ以外: 方程式は空と扱い、直前の位置に戻して return
  const equation = readElementTail(r);

  const id = `el_${index + 1}`;
  const label = defaultLabelFor(kind, index);
  // exactOptionalPropertyTypes: equation が空なら付けない、
  // そうでなければ付ける、という分岐を明示する。
  if (equation.length > 0) {
    return { id, kind, label, position: { x: px, y: py }, parameters, equation };
  }
  return { id, kind, label, position: { x: px, y: py }, parameters };
}

/**
 * 要素ブロック末尾の「パディング + 方程式文字列 + トレイリングパディング」を
 * 適応的に読む。
 *
 * writer が吐く BGE と実 Mr.Bond の BGE でパッド数が異なる（junction 要素の
 * 場合 23 vs 25 など）ため、固定長の読み取りではなく「`2 0` パッドの連続 →
 * 方程式の長さっぽい非ゼロアトム → 文字列 → 再度 `2 0` パッドの連続」と
 * いうパターンを検出して消費する。
 *
 * 方程式検出ヒューリスティック: 非ゼロアトムの `code` と `value` から、
 *   - 次の length バイトに `=` や `;` が含まれれば方程式と判定
 *   - 含まれていなければ「次要素 / ボンド」の先頭と判定して rewind
 */
function readElementTail(r: BgeReader): string {
  // 1) 先頭の `2 0` パッドを吸う
  skipZeroPads(r);

  // 2) 次の非ゼロアトムを peek して、equation 文字列かどうか判定
  if (r.atEnd()) return '';

  const saved = r.position;
  const a = r.readAtom();

  // 方程式長アトムの候補条件:
  //   - code 2..5 で value > 0（正の長さ）
  //   - バッファ残量内で読める
  //   - 読んだ文字列に `=`, `;`, あるいは C 風識別子のみが含まれる
  if (a.value > 0 && a.value <= 4096 && r.position + a.value + 1 <= r.length) {
    // readStringBytes は長さアトム直後の1バイト空白を自動消費する。
    // 失敗しうるので try/catch で保護。
    const beforeStr = r.position;
    try {
      const candidate = r.readStringBytes(a.value);
      if (looksLikeEquation(candidate)) {
        // 方程式として確定。後続パッドを吸って return。
        skipZeroPads(r);
        return candidate;
      }
      // 方程式じゃない（= 次要素の type / ボンドブロック先頭など）。rewind。
      r.seek(saved);
      return '';
    } catch {
      // 読めなかったら文字列じゃない。rewind。
      r.seek(beforeStr);
      // seek 成功後に先頭の読んだアトムもキャンセルするため saved へ
      r.seek(saved);
      return '';
    }
  }

  // 非ゼロアトムだが長さとして解釈できない → 次要素 / ボンドの先頭。rewind。
  r.seek(saved);
  return '';
}

/** `(code=2, value=0)` の連続アトムを吸い尽くす（位置は終端で止まる）。 */
function skipZeroPads(r: BgeReader): void {
  for (;;) {
    if (r.atEnd()) return;
    const saved = r.position;
    const a = r.readAtom();
    if (!(a.code === 2 && a.value === 0)) {
      r.seek(saved);
      return;
    }
  }
}

/**
 * 文字列が「要素の方程式らしい」かヒューリスティックに判定する。
 * 空文字列は方程式ではない（= パッドを余計に食ってしまうため false にする）。
 */
function looksLikeEquation(s: string): boolean {
  if (s.length === 0) return false;
  // 典型的な要素方程式は `=` を必ず含み、末尾に `;` が付く（"E=EIN;" 等）。
  // 改行区切りの多段式（FD_valve 等）でも `=` は存在する。
  if (s.includes('=')) return true;
  // 例外: 一部の要素で単なる識別子式のケースがある可能性に備えて、
  // ASCII の英字/数字/記号のみで構成され `;` を含むなら方程式扱いにする。
  if (/^[\x20-\x7e\n\r\t]+$/.test(s) && s.includes(';')) return true;
  return false;
}

/** パラメータ名文字列と値文字列（`\n` 区切り）から Parameter[] を構築。 */
function parseParamPair(namesStr: string, valuesStr: string): Parameter[] {
  if (namesStr.length === 0 && valuesStr.length === 0) return [];
  const names = namesStr.split('\n');
  const values = valuesStr.split('\n');
  const n = Math.max(names.length, values.length);
  const out: Parameter[] = [];
  for (let i = 0; i < n; i++) {
    const name = (names[i] ?? '').trim();
    const rawV = (values[i] ?? '').trim();
    if (name.length === 0 && rawV.length === 0) continue;
    const v = Number.parseFloat(rawV);
    out.push({ name: name || `P${i + 1}`, value: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

/** kind から既定ラベル（C1, I1 等）を生成。要素の出現順 index を使った連番。 */
function defaultLabelFor(kind: ElementKind, index: number): string {
  const prefix = (() => {
    switch (kind) {
      case 'C': return 'C';
      case 'I': return 'I';
      case 'R': return 'R';
      case 'Se': return 'SE';
      case 'Sf': return 'SF';
      case 'TF': return 'TF';
      case 'GY': return 'GY';
      case 'ZeroJunction': return 'ZJ';
      case 'OneJunction': return 'OJ';
    }
  })();
  return `${prefix}${index + 1}`;
}

// ---- ボンド 1 つ分を読む ----

function readBond(
  r: BgeReader,
  index: number,
  idByIndex: ReadonlyMap<number, string>,
): Bond {
  const id = r.readAtom().value;
  const fromIdx = r.readAtom().value;
  const toIdx = r.readAtom().value;
  r.readAtom(); // junction_port

  // 4 点ポリライン（8 アトム）スキップ
  for (let j = 0; j < 8; j++) r.readAtom();

  // フラグ 4 個
  for (let j = 0; j < 4; j++) r.readAtom();

  // causality + pad
  const causAtom = r.readAtom();
  r.readAtom(); // pad

  // initial_value（文字列）
  r.readLengthPrefixedString();

  const fromElementId =
    idByIndex.get(fromIdx) ?? `el_${Math.max(1, fromIdx + 1)}`;
  const toElementId = idByIndex.get(toIdx) ?? `el_${Math.max(1, toIdx + 1)}`;

  const bondId = id > 0 ? `bond_${id}` : `bond_${index + 1}`;

  // writer は `effortIn` を 1、それ以外を 0 として書く。
  // 読み戻しでは 1 → effortIn、0 → undefined（未指定）とする（round-trip 維持のため）。
  if (causAtom.value === 1) {
    return { id: bondId, fromElementId, toElementId, causality: 'effortIn' };
  }
  return { id: bondId, fromElementId, toElementId };
}

// ---- 数値パース ----

/** "1.00000E-05" / "0.00000E+00" 形式の文字列を数値に戻す。 */
function parseSimNum(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  const v = Number.parseFloat(trimmed);
  return Number.isFinite(v) ? v : 0;
}

/** "bond_12" 等の末尾数値を取り出す。見つからなければ null。 */
function extractIndex(id: string): number | null {
  const m = /(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

// ---- UI ボタン ----

const BGE_IMPORT_STYLE_ID = 'mrbond-bge-import-style';

const BGE_IMPORT_CSS = `
.mb-bge-import-btn {
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
.mb-bge-import-btn:hover {
  background: rgba(110, 231, 183, 0.12);
  color: #6ee7b7;
}
.mb-bge-import-btn:active {
  background: rgba(110, 231, 183, 0.22);
}
.mb-bge-import-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(110, 231, 183, 0.35);
}
`;

function ensureBgeImportStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(BGE_IMPORT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BGE_IMPORT_STYLE_ID;
  style.textContent = BGE_IMPORT_CSS;
  document.head.appendChild(style);
}

/**
 * "Load BGE" ボタンを `container` に差し込む。
 * ボタンクリックで `<input type="file" accept=".BGE">` が開き、
 * 選択ファイルをパースして `store.dispatch({ type: 'loadDoc', doc })` する。
 *
 * 返り値は cleanup 関数（リスナ解除 + DOM 片付け）。
 */
export function mountBgeImportButton(container: HTMLElement, store: Store): () => void {
  ensureBgeImportStyle();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mb-bge-import-btn';
  btn.textContent = '\u{1F4C2} Load BGE';
  btn.title = 'Load a Mr.Bond BGE file';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.BGE,.bge,application/octet-stream';
  fileInput.style.display = 'none';

  const onClick = (): void => {
    fileInput.value = '';
    fileInput.click();
  };

  const onChange = (): void => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = reader.result;
      if (!(result instanceof ArrayBuffer)) {
        alert('Load BGE failed: file could not be read as binary.');
        return;
      }
      try {
        const bytes = new Uint8Array(result);
        const doc = readBge(bytes);
        store.dispatch({ type: 'loadDoc', doc });
      } catch (e) {
        const msg =
          e instanceof BgeParseError
            ? `${e.message} (offset=${e.offset})`
            : e instanceof Error
              ? e.message
              : String(e);
        alert(`Load BGE failed: ${msg}`);
        // eslint-disable-next-line no-console
        console.error('BGE parse error:', e);
      }
    };
    reader.onerror = (): void => {
      alert('Load BGE failed: could not read file.');
    };
    reader.readAsArrayBuffer(file);
  };

  btn.addEventListener('click', onClick);
  fileInput.addEventListener('change', onChange);

  container.appendChild(btn);
  container.appendChild(fileInput);

  return () => {
    btn.removeEventListener('click', onClick);
    fileInput.removeEventListener('change', onChange);
    if (btn.parentNode === container) container.removeChild(btn);
    if (fileInput.parentNode === container) container.removeChild(fileInput);
  };
}

/**
 * 描画エディタの JSON 保存/読み込み機能。
 *
 * - シリアライザ: BondGraphDoc を `{ format, version, doc }` ラッパで JSON 化
 * - デシリアライザ: 上記ラッパを検証して BondGraphDoc を復元
 * - UI: toolbar と同じ配色規約で Save / Open の 2 ボタンをマウント
 *
 * 公開 API:
 *   serializeDoc(doc)     → string (整形 JSON)
 *   deserializeDoc(json)  → BondGraphDoc (バリデーション失敗時は Error を throw)
 *   mountIoButtons(container, store) → cleanup 関数
 *
 * フォーマット:
 *   {
 *     "format": "mrbond-modern-doc",
 *     "version": 1,
 *     "doc": { elements, bonds, simulation, outputs }
 *   }
 */

import type { Store } from '../shared/store.ts';
import type {
  Bond,
  BondGraphDoc,
  Element,
  ElementKind,
  Parameter,
} from '../shared/model.ts';

// ---- フォーマット定数 ----

const FORMAT_TAG = 'mrbond-modern-doc';
const FORMAT_VERSION = 1;

const KNOWN_ELEMENT_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'C',
  'I',
  'R',
  'Se',
  'Sf',
  'TF',
  'GY',
  'ZeroJunction',
  'OneJunction',
]);

// ---- シリアライズ ----

/** BondGraphDoc を JSON 文字列化（整形付き）。 */
export function serializeDoc(doc: BondGraphDoc): string {
  const envelope = {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    doc,
  };
  return JSON.stringify(envelope, null, 2);
}

// ---- デシリアライズ（バリデーション付き） ----

/** JSON 文字列から BondGraphDoc にパース。不正な入力は明確なエラーで throw。 */
export function deserializeDoc(json: string): BondGraphDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON: ${msg}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error('Document root must be an object.');
  }

  const format = parsed['format'];
  if (format !== FORMAT_TAG) {
    throw new Error(
      `Unexpected format tag: expected ${JSON.stringify(FORMAT_TAG)}, got ${JSON.stringify(format)}.`,
    );
  }

  const version = parsed['version'];
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported version: expected ${FORMAT_VERSION}, got ${JSON.stringify(version)}.`,
    );
  }

  const rawDoc = parsed['doc'];
  if (!isPlainObject(rawDoc)) {
    throw new Error('`doc` field must be an object.');
  }

  return validateDoc(rawDoc);
}

// ---- バリデーションヘルパ ----

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertFiniteNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${path} must be a finite number (got ${JSON.stringify(v)}).`);
  }
  return v;
}

function assertString(v: unknown, path: string): string {
  if (typeof v !== 'string') {
    throw new Error(`${path} must be a string (got ${JSON.stringify(v)}).`);
  }
  return v;
}

function assertArray(v: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(v)) {
    throw new Error(`${path} must be an array.`);
  }
  return v;
}

function validateDoc(raw: Record<string, unknown>): BondGraphDoc {
  const rawElements = assertArray(raw['elements'], 'doc.elements');
  const rawBonds = assertArray(raw['bonds'], 'doc.bonds');
  const rawSimulation = raw['simulation'];
  const rawOutputs = assertArray(raw['outputs'], 'doc.outputs');

  // 1. elements
  const elements: Element[] = rawElements.map((e, i) =>
    validateElement(e, `doc.elements[${i}]`),
  );

  // 要素 ID の一意性チェック
  const idSet = new Set<string>();
  for (const el of elements) {
    if (idSet.has(el.id)) {
      throw new Error(`Duplicate element id: ${JSON.stringify(el.id)}.`);
    }
    idSet.add(el.id);
  }

  // 2. bonds（参照整合性のため elements の id を渡す）
  const bonds: Bond[] = rawBonds.map((b, i) =>
    validateBond(b, `doc.bonds[${i}]`, idSet),
  );

  // bond ID の一意性
  const bondIds = new Set<string>();
  for (const b of bonds) {
    if (bondIds.has(b.id)) {
      throw new Error(`Duplicate bond id: ${JSON.stringify(b.id)}.`);
    }
    bondIds.add(b.id);
  }

  // 3. simulation
  const simulation = validateSimulation(rawSimulation, 'doc.simulation');

  // 4. outputs
  const outputs = rawOutputs.map((o, i) =>
    validateOutput(o, `doc.outputs[${i}]`, bondIds),
  );

  return { elements, bonds, simulation, outputs };
}

function validateElement(raw: unknown, path: string): Element {
  if (!isPlainObject(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const id = assertString(raw['id'], `${path}.id`);
  const kindRaw = raw['kind'];
  if (typeof kindRaw !== 'string' || !KNOWN_ELEMENT_KINDS.has(kindRaw as ElementKind)) {
    throw new Error(
      `${path}.kind is not a valid ElementKind (got ${JSON.stringify(kindRaw)}).`,
    );
  }
  const kind = kindRaw as ElementKind;

  const posRaw = raw['position'];
  if (!isPlainObject(posRaw)) {
    throw new Error(`${path}.position must be an object.`);
  }
  const position = {
    x: assertFiniteNumber(posRaw['x'], `${path}.position.x`),
    y: assertFiniteNumber(posRaw['y'], `${path}.position.y`),
  };

  const rawParams = assertArray(raw['parameters'], `${path}.parameters`);
  const parameters: Parameter[] = rawParams.map((p, j) =>
    validateParameter(p, `${path}.parameters[${j}]`),
  );

  // 型定義（model.ts）のフィールド順にキーを挿入し、round-trip で JSON 文字列が
  // 安定するようにする。exactOptionalPropertyTypes 下では条件ごとに分岐する必要がある。
  const hasLabel = raw['label'] !== undefined;
  const hasEquation = raw['equation'] !== undefined;
  const label = hasLabel ? assertString(raw['label'], `${path}.label`) : undefined;
  const equation = hasEquation ? assertString(raw['equation'], `${path}.equation`) : undefined;

  if (hasLabel && hasEquation) {
    return { id, kind, label: label!, position, parameters, equation: equation! };
  }
  if (hasLabel) {
    return { id, kind, label: label!, position, parameters };
  }
  if (hasEquation) {
    return { id, kind, position, parameters, equation: equation! };
  }
  return { id, kind, position, parameters };
}

function validateParameter(raw: unknown, path: string): Parameter {
  if (!isPlainObject(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const name = assertString(raw['name'], `${path}.name`);
  const value = assertFiniteNumber(raw['value'], `${path}.value`);
  const base: { name: string; value: number; unit?: string } = { name, value };
  if (raw['unit'] !== undefined) {
    base.unit = assertString(raw['unit'], `${path}.unit`);
  }
  return base;
}

function validateBond(
  raw: unknown,
  path: string,
  elementIds: ReadonlySet<string>,
): Bond {
  if (!isPlainObject(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const id = assertString(raw['id'], `${path}.id`);
  const fromElementId = assertString(raw['fromElementId'], `${path}.fromElementId`);
  const toElementId = assertString(raw['toElementId'], `${path}.toElementId`);

  if (!elementIds.has(fromElementId)) {
    throw new Error(
      `${path}.fromElementId references unknown element ${JSON.stringify(fromElementId)}.`,
    );
  }
  if (!elementIds.has(toElementId)) {
    throw new Error(
      `${path}.toElementId references unknown element ${JSON.stringify(toElementId)}.`,
    );
  }

  const base: {
    id: string;
    fromElementId: string;
    toElementId: string;
    causality?: 'effortIn' | 'flowIn';
  } = { id, fromElementId, toElementId };

  if (raw['causality'] !== undefined) {
    const c = raw['causality'];
    if (c !== 'effortIn' && c !== 'flowIn') {
      throw new Error(
        `${path}.causality must be "effortIn" or "flowIn" (got ${JSON.stringify(c)}).`,
      );
    }
    base.causality = c;
  }

  return base;
}

function validateSimulation(raw: unknown, path: string): BondGraphDoc['simulation'] {
  if (!isPlainObject(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  return {
    t0: assertFiniteNumber(raw['t0'], `${path}.t0`),
    t1: assertFiniteNumber(raw['t1'], `${path}.t1`),
    dt: assertFiniteNumber(raw['dt'], `${path}.dt`),
    numOutputSteps: assertFiniteNumber(raw['numOutputSteps'], `${path}.numOutputSteps`),
  };
}

function validateOutput(
  raw: unknown,
  path: string,
  bondIds: ReadonlySet<string>,
): BondGraphDoc['outputs'][number] {
  if (!isPlainObject(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const bondId = assertString(raw['bondId'], `${path}.bondId`);
  const variableName = assertString(raw['variableName'], `${path}.variableName`);
  const label = assertString(raw['label'], `${path}.label`);
  if (!bondIds.has(bondId)) {
    throw new Error(
      `${path}.bondId references unknown bond ${JSON.stringify(bondId)}.`,
    );
  }
  return { bondId, variableName, label };
}

// ---- round-trip 自己チェック（内部用、export しない） ----

/**
 * 開発時の sanity check 用。`serializeDoc → deserializeDoc` で同値になるかを
 * JSON 文字列比較で確認する。失敗したら Error を throw。
 * mountIoButtons からは呼ばない（必要時に手動で呼ぶ）。
 */
function _roundTripCheck(doc: BondGraphDoc): void {
  const s1 = serializeDoc(doc);
  const back = deserializeDoc(s1);
  const s2 = serializeDoc(back);
  if (s1 !== s2) {
    throw new Error('Round-trip mismatch: serializeDoc is not stable across deserializeDoc.');
  }
}
// 未使用警告を抑制しつつ、開発時にいじれるよう export 以外の場所に露出させる
void _roundTripCheck;

// ---- UI ボタン ----

const IO_STYLE_ID = 'mrbond-io-style';

const IO_CSS = `
.mb-io {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: #181c23;
  border: 1px solid #2a2f38;
  border-radius: 8px;
  color: #e8eaee;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic', sans-serif;
  user-select: none;
}
.mb-io-btn {
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
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1.1;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.mb-io-btn:hover {
  background: rgba(110, 231, 183, 0.12);
  color: #6ee7b7;
}
.mb-io-btn:active {
  background: rgba(110, 231, 183, 0.22);
}
.mb-io-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(110, 231, 183, 0.35);
}
`;

function ensureIoStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(IO_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = IO_STYLE_ID;
  style.textContent = IO_CSS;
  document.head.appendChild(style);
}

/** ダウンロード用ファイル名（ローカル時刻ベース） `bondgraph-YYYY-MM-DD-HHMMSS.json` */
function buildFilename(now: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `bondgraph-${y}-${m}-${d}-${hh}${mm}${ss}.json`;
}

function triggerDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // メモリ解放は次ターンに回す（即 revoke するとブラウザによってはダウンロードが中断される）
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 保存 / 読み込みボタンを `container` にマウントする。
 * 返り値は cleanup 関数。
 */
export function mountIoButtons(container: HTMLElement, store: Store): () => void {
  ensureIoStyle();

  const root = document.createElement('div');
  root.className = 'mb-io';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Document I/O');

  // Save ボタン
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mb-io-btn';
  saveBtn.textContent = 'Save';
  saveBtn.title = 'Save current document as JSON';

  const onSave = (): void => {
    try {
      const doc = store.getState().doc;
      const json = serializeDoc(doc);
      triggerDownload(buildFilename(), json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Save failed: ${msg}`);
    }
  };
  saveBtn.addEventListener('click', onSave);
  root.appendChild(saveBtn);

  // Open ボタン + 隠しファイル入力
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'mb-io-btn';
  openBtn.textContent = 'Open';
  openBtn.title = 'Open a JSON document';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';

  const onOpenClick = (): void => {
    // 同じファイルを再選択しても change が発火するよう一度クリア
    fileInput.value = '';
    fileInput.click();
  };

  const onFileChange = (): void => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = reader.result;
      if (typeof result !== 'string') {
        alert('Open failed: file contents were not text.');
        return;
      }
      try {
        const doc = deserializeDoc(result);
        store.dispatch({ type: 'loadDoc', doc });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`Open failed: ${msg}`);
      }
    };
    reader.onerror = (): void => {
      alert('Open failed: could not read file.');
    };
    reader.readAsText(file);
  };

  openBtn.addEventListener('click', onOpenClick);
  fileInput.addEventListener('change', onFileChange);

  root.appendChild(openBtn);
  root.appendChild(fileInput);

  container.appendChild(root);

  // ---- cleanup ----
  return () => {
    saveBtn.removeEventListener('click', onSave);
    openBtn.removeEventListener('click', onOpenClick);
    fileInput.removeEventListener('change', onFileChange);
    if (root.parentNode === container) {
      container.removeChild(root);
    }
  };
}

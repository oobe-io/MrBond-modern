/**
 * 描画エディタのツールバー。
 *
 * - 素の DOM 実装（フレームワーク非依存）
 * - store（web/editor/shared/store.ts）を購読し、アクティブボタンの
 *   ハイライトと削除ボタンの enabled 状態を同期する
 * - キーボードショートカット: V, C, I, R, E, F, T, G, 0, 1, B, Del/Backspace
 *
 * 公開 API: `mountToolbar(container, store)` → cleanup 関数
 */

import type { Store, Tool } from '../shared/store.ts';
import {
  ELEMENT_PALETTE_ORDER,
  ELEMENT_SYMBOL,
  type ElementKind,
} from '../shared/model.ts';

// ---- スタイル（1 ページに 1 度だけ注入） ----

const STYLE_ID = 'mrbond-toolbar-style';

const CSS = `
.mb-toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 60px;
  padding: 8px 4px;
  background: #181c23;
  border: 1px solid #2a2f38;
  border-radius: 8px;
  color: #e8eaee;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic', sans-serif;
  user-select: none;
  outline: none;
}
.mb-toolbar:focus-visible {
  box-shadow: 0 0 0 2px rgba(110, 231, 183, 0.3);
}
.mb-tb-btn {
  width: 48px;
  min-height: 40px;
  padding: 4px 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: transparent;
  color: #e8eaee;
  border: 1px solid #2a2f38;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.1;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.mb-tb-btn:hover:not(:disabled) {
  background: #232833;
  border-color: #3a404c;
}
.mb-tb-btn.is-active {
  background: #6ee7b7;
  color: #0a0e14;
  border-color: #6ee7b7;
}
.mb-tb-btn.is-active .mb-tb-key {
  color: #0a0e14;
  opacity: 0.7;
}
.mb-tb-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.mb-tb-btn .mb-tb-glyph {
  font-size: 0.95rem;
  letter-spacing: 0.02em;
}
.mb-tb-btn .mb-tb-key {
  font-size: 0.65rem;
  color: #9aa0a6;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.mb-tb-divider {
  width: 36px;
  height: 1px;
  background: #2a2f38;
  margin: 2px 0;
}
.mb-tb-spacer {
  flex: 1 1 auto;
  min-height: 8px;
}
.mb-tb-delete.is-enabled {
  border-color: rgba(239, 68, 68, 0.5);
  color: #fca5a5;
}
.mb-tb-delete.is-enabled:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #fecaca;
}
`;

function ensureStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---- ボタン定義テーブル ----

/** ツールバーに並ぶボタンの種別 */
type ButtonSpec =
  | { slot: 'select'; key: string; glyph: string; title: string }
  | { slot: 'palette'; kind: ElementKind; key: string; title: string }
  | { slot: 'bond'; key: string; glyph: string; title: string };

const SELECT_SPEC: ButtonSpec = {
  slot: 'select',
  key: 'V',
  glyph: '↖', // ↖
  title: 'Select / 選択ツール (V)',
};

const BOND_SPEC: ButtonSpec = {
  slot: 'bond',
  key: 'B',
  glyph: '→', // →
  title: 'Bond / ボンド描画 (B)',
};

/** パレット要素ごとのメタ情報（キー／ツールチップ用日本語名） */
const ELEMENT_META: Record<ElementKind, { key: string; title: string }> = {
  C: { key: 'C', title: 'Capacitance / 容量（バネ） (C)' },
  I: { key: 'I', title: 'Inertia / 慣性（質量） (I)' },
  R: { key: 'R', title: 'Resistance / 抵抗（ダンパ） (R)' },
  Se: { key: 'E', title: 'Source of Effort / 努力源 (E)' },
  Sf: { key: 'F', title: 'Source of Flow / 流れ源 (F)' },
  TF: { key: 'T', title: 'Transformer / 変換子 (T)' },
  GY: { key: 'G', title: 'Gyrator / ジャイレータ (G)' },
  ZeroJunction: { key: '0', title: 'Zero Junction / 0接点（effort 共通） (0)' },
  OneJunction: { key: '1', title: 'One Junction / 1接点（flow 共通） (1)' },
};

// ---- ツールのアクティブ判定 ----

function isActive(tool: Tool, spec: ButtonSpec): boolean {
  if (spec.slot === 'select') return tool.kind === 'select';
  if (spec.slot === 'bond') return tool.kind === 'bond';
  return tool.kind === 'place' && tool.element === spec.kind;
}

function toolForSpec(spec: ButtonSpec): Tool {
  if (spec.slot === 'select') return { kind: 'select' };
  if (spec.slot === 'bond') return { kind: 'bond' };
  return { kind: 'place', element: spec.kind };
}

// ---- DOM 構築ヘルパ ----

function createToolButton(spec: ButtonSpec): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mb-tb-btn';
  btn.title = spec.title;

  const glyph = document.createElement('span');
  glyph.className = 'mb-tb-glyph';
  if (spec.slot === 'palette') {
    glyph.textContent = ELEMENT_SYMBOL[spec.kind];
  } else {
    glyph.textContent = spec.glyph;
  }
  btn.appendChild(glyph);

  const key = document.createElement('span');
  key.className = 'mb-tb-key';
  key.textContent = spec.key;
  btn.appendChild(key);

  return btn;
}

// ---- キーボードショートカット ----

/** キー文字列 → 対応する ButtonSpec（select/palette/bond） */
function buildKeyMap(): Map<string, ButtonSpec> {
  const map = new Map<string, ButtonSpec>();
  map.set('v', SELECT_SPEC);
  map.set('b', BOND_SPEC);
  for (const kind of ELEMENT_PALETTE_ORDER) {
    const meta = ELEMENT_META[kind];
    map.set(meta.key.toLowerCase(), { slot: 'palette', kind, key: meta.key, title: meta.title });
  }
  return map;
}

/** IME 変換中や入力要素にフォーカスがある時はショートカットを無視する */
function shouldIgnoreKeyEvent(e: KeyboardEvent): boolean {
  if (e.isComposing || e.keyCode === 229) return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const target = e.target;
  if (target instanceof HTMLElement) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
  }
  return false;
}

// ---- メインエントリ ----

export function mountToolbar(container: HTMLElement, store: Store): () => void {
  ensureStyle();

  // ルート要素
  const root = document.createElement('div');
  root.className = 'mb-toolbar';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Mr.Bond editor toolbar');
  root.tabIndex = 0;

  // ボタン一覧（描画順）を構築しつつ、アクティブ切替用に spec と DOM を紐づけ
  type Entry = { spec: ButtonSpec; btn: HTMLButtonElement };
  const entries: Entry[] = [];

  const addButton = (spec: ButtonSpec): void => {
    const btn = createToolButton(spec);
    btn.addEventListener('click', () => {
      store.dispatch({ type: 'setTool', tool: toolForSpec(spec) });
      // クリック後もキーボードショートカットを効かせるため root にフォーカスを戻す
      root.focus();
    });
    root.appendChild(btn);
    entries.push({ spec, btn });
  };

  // 1. 選択ツール
  addButton(SELECT_SPEC);

  // パレットとの区切り線
  const divider1 = document.createElement('div');
  divider1.className = 'mb-tb-divider';
  root.appendChild(divider1);

  // 2. パレット
  for (const kind of ELEMENT_PALETTE_ORDER) {
    const meta = ELEMENT_META[kind];
    addButton({ slot: 'palette', kind, key: meta.key, title: meta.title });
  }

  // ボンドとの区切り線
  const divider2 = document.createElement('div');
  divider2.className = 'mb-tb-divider';
  root.appendChild(divider2);

  // 3. ボンドツール
  addButton(BOND_SPEC);

  // 4. 余白
  const spacer = document.createElement('div');
  spacer.className = 'mb-tb-spacer';
  root.appendChild(spacer);

  // 5. 削除ボタン
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'mb-tb-btn mb-tb-delete';
  deleteBtn.title = 'Delete selected / 選択中の要素を削除 (Del)';
  {
    const glyph = document.createElement('span');
    glyph.className = 'mb-tb-glyph';
    glyph.textContent = '✕'; // ✕
    deleteBtn.appendChild(glyph);
    const key = document.createElement('span');
    key.className = 'mb-tb-key';
    key.textContent = 'Del';
    deleteBtn.appendChild(key);
  }
  deleteBtn.addEventListener('click', () => {
    const id = store.getState().selectedElementId;
    if (id !== null) {
      store.dispatch({ type: 'deleteElement', id });
      root.focus();
    }
  });
  root.appendChild(deleteBtn);

  container.appendChild(root);

  // ---- 状態同期 ----

  const render = (): void => {
    const state = store.getState();
    for (const { spec, btn } of entries) {
      btn.classList.toggle('is-active', isActive(state.tool, spec));
    }
    const canDelete = state.selectedElementId !== null;
    deleteBtn.disabled = !canDelete;
    deleteBtn.classList.toggle('is-enabled', canDelete);
  };

  render();
  const unsubscribe = store.subscribe(render);

  // ---- キーボードショートカット ----

  const keyMap = buildKeyMap();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (shouldIgnoreKeyEvent(e)) return;

    // Delete / Backspace で選択要素削除
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const id = store.getState().selectedElementId;
      if (id !== null) {
        e.preventDefault();
        store.dispatch({ type: 'deleteElement', id });
      }
      return;
    }

    const k = e.key.length === 1 ? e.key.toLowerCase() : '';
    if (!k) return;
    const spec = keyMap.get(k);
    if (!spec) return;

    e.preventDefault();
    store.dispatch({ type: 'setTool', tool: toolForSpec(spec) });
  };

  window.addEventListener('keydown', onKeyDown);

  // ---- cleanup ----

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    unsubscribe();
    if (root.parentNode === container) {
      container.removeChild(root);
    }
  };
}

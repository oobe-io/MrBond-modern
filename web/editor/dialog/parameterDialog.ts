/**
 * パラメータ編集ダイアログ。
 *
 * 選択中の Element について、label / parameters / equation を編集する
 * モーダルダイアログ。Enter キー押下で開き、保存 / キャンセル / Esc /
 * オーバーレイクリックで閉じる。
 *
 * 設計原則:
 *   - 素の DOM 操作（フレームワーク非依存）
 *   - toolbar.ts と同じ配色（#0f1115 / #181c23 / #6ee7b7 / #e8eaee / #2a2f38）
 *   - 既存 Canvas / Toolbar / Shared ファイルは触らない
 *   - 変更は store.dispatch({ type: 'updateElement', ... }) 経由で反映
 *
 * 公開 API: `mountParameterDialog(container, store)` → cleanup 関数
 */

import type { Store } from '../shared/store.ts';
import type { Element, Parameter } from '../shared/model.ts';
import { ELEMENT_SYMBOL } from '../shared/model.ts';

// ---- スタイル（1 ページに 1 度だけ注入） ----

const STYLE_ID = 'mrbond-dialog-style';

const CSS = `
.mb-dialog-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  z-index: 1000;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic', sans-serif;
  color: #e8eaee;
}
.mb-dialog-overlay[hidden] {
  display: none;
}
.mb-dialog-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: #181c23;
  border: 1px solid #2a2f38;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.mb-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #2a2f38;
  background: #0f1115;
}
.mb-dialog-title {
  font-size: 1rem;
  font-weight: 600;
  color: #6ee7b7;
  letter-spacing: 0.02em;
}
.mb-dialog-title .mb-dialog-kind {
  color: #9aa0a6;
  font-size: 0.8rem;
  font-weight: 500;
  margin-left: 6px;
}
.mb-dialog-close {
  background: transparent;
  border: 1px solid transparent;
  color: #9aa0a6;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.mb-dialog-close:hover {
  background: #232833;
  color: #e8eaee;
  border-color: #2a2f38;
}
.mb-dialog-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: #181c23;
}
.mb-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mb-dialog-label {
  font-size: 0.75rem;
  color: #9aa0a6;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.mb-dialog-input,
.mb-dialog-textarea {
  width: 100%;
  background: #0f1115;
  color: #e8eaee;
  border: 1px solid #2a2f38;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 0.9rem;
  font-family: inherit;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.mb-dialog-textarea {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.85rem;
  resize: vertical;
  min-height: 80px;
}
.mb-dialog-input:focus,
.mb-dialog-textarea:focus {
  border-color: #6ee7b7;
  box-shadow: 0 0 0 2px rgba(110, 231, 183, 0.2);
}
.mb-dialog-params {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mb-dialog-param-row {
  display: grid;
  grid-template-columns: 1fr 1fr 70px auto;
  gap: 6px;
  align-items: center;
}
.mb-dialog-param-row .mb-dialog-input {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.8rem;
  padding: 4px 6px;
}
.mb-dialog-icon-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: #9aa0a6;
  border: 1px solid #2a2f38;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.95rem;
  line-height: 1;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.mb-dialog-icon-btn:hover {
  background: #232833;
  color: #e8eaee;
  border-color: #3a404c;
}
.mb-dialog-icon-btn.is-danger:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #fecaca;
  border-color: rgba(239, 68, 68, 0.5);
}
.mb-dialog-add-btn {
  align-self: flex-start;
  background: transparent;
  color: #6ee7b7;
  border: 1px dashed #3a404c;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.mb-dialog-add-btn:hover {
  background: #232833;
  border-color: #6ee7b7;
}
.mb-dialog-params-empty {
  font-size: 0.75rem;
  color: #9aa0a6;
  padding: 4px 0;
}
.mb-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #2a2f38;
  background: #0f1115;
}
.mb-dialog-btn {
  min-width: 88px;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #2a2f38;
  background: transparent;
  color: #e8eaee;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  font-family: inherit;
}
.mb-dialog-btn:hover {
  background: #232833;
  border-color: #3a404c;
}
.mb-dialog-btn.is-primary {
  background: #6ee7b7;
  color: #0a0e14;
  border-color: #6ee7b7;
}
.mb-dialog-btn.is-primary:hover {
  background: #8aeec7;
  border-color: #8aeec7;
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

// ---- 編集用の内部モデル ----

/** フォーム上の行データ。value は文字列で保持し、保存時に number 化する。 */
interface ParamDraft {
  name: string;
  value: string;
  unit: string;
}

function paramToDraft(p: Parameter): ParamDraft {
  return {
    name: p.name,
    value: Number.isFinite(p.value) ? String(p.value) : '',
    unit: p.unit ?? '',
  };
}

function draftsToParameters(drafts: readonly ParamDraft[]): Parameter[] {
  const out: Parameter[] = [];
  for (const d of drafts) {
    const name = d.name.trim();
    if (name === '') continue; // 空行は捨てる
    const value = Number.parseFloat(d.value);
    const numeric = Number.isFinite(value) ? value : 0;
    const unit = d.unit.trim();
    if (unit === '') {
      out.push({ name, value: numeric });
    } else {
      out.push({ name, value: numeric, unit });
    }
  }
  return out;
}

// ---- IME・入力要素判定 ----

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

export function mountParameterDialog(
  container: HTMLElement,
  store: Store,
): () => void {
  ensureStyle();

  // ---- DOM 構築 ----

  const overlay = document.createElement('div');
  overlay.className = 'mb-dialog-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.hidden = true;

  const card = document.createElement('div');
  card.className = 'mb-dialog-card';
  overlay.appendChild(card);

  // ヘッダ
  const header = document.createElement('div');
  header.className = 'mb-dialog-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'mb-dialog-title';
  header.appendChild(titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mb-dialog-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×'; // ×
  header.appendChild(closeBtn);
  card.appendChild(header);

  // ボディ
  const body = document.createElement('div');
  body.className = 'mb-dialog-body';
  card.appendChild(body);

  // Label フィールド
  const labelField = document.createElement('div');
  labelField.className = 'mb-dialog-field';
  const labelLabel = document.createElement('label');
  labelLabel.className = 'mb-dialog-label';
  labelLabel.textContent = 'Label';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'mb-dialog-input';
  labelInput.placeholder = 'e.g. C1, EIN';
  labelLabel.htmlFor = 'mb-dialog-label-input';
  labelInput.id = 'mb-dialog-label-input';
  labelField.appendChild(labelLabel);
  labelField.appendChild(labelInput);
  body.appendChild(labelField);

  // Parameters フィールド
  const paramsField = document.createElement('div');
  paramsField.className = 'mb-dialog-field';
  const paramsLabel = document.createElement('div');
  paramsLabel.className = 'mb-dialog-label';
  paramsLabel.textContent = 'Parameters';
  paramsField.appendChild(paramsLabel);
  const paramsList = document.createElement('div');
  paramsList.className = 'mb-dialog-params';
  paramsField.appendChild(paramsList);
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'mb-dialog-add-btn';
  addBtn.textContent = '+ パラメータ追加';
  paramsField.appendChild(addBtn);
  body.appendChild(paramsField);

  // Equation フィールド
  const eqField = document.createElement('div');
  eqField.className = 'mb-dialog-field';
  const eqLabel = document.createElement('label');
  eqLabel.className = 'mb-dialog-label';
  eqLabel.textContent = 'Equation';
  const eqInput = document.createElement('textarea');
  eqInput.className = 'mb-dialog-textarea';
  eqInput.rows = 5;
  eqInput.placeholder = 'e.g. C=PK*Z;';
  eqInput.spellcheck = false;
  eqLabel.htmlFor = 'mb-dialog-equation-input';
  eqInput.id = 'mb-dialog-equation-input';
  eqField.appendChild(eqLabel);
  eqField.appendChild(eqInput);
  body.appendChild(eqField);

  // フッタ
  const footer = document.createElement('div');
  footer.className = 'mb-dialog-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'mb-dialog-btn';
  cancelBtn.textContent = 'キャンセル';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mb-dialog-btn is-primary';
  saveBtn.textContent = '保存';
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  card.appendChild(footer);

  container.appendChild(overlay);

  // ---- ダイアログ状態 ----

  /** 現在編集対象の要素 ID（閉じている間は null） */
  let editingId: string | null = null;
  /** 編集中のパラメータ行（フォーム上のドラフト） */
  let drafts: ParamDraft[] = [];

  // ---- パラメータ行の再描画 ----

  function renderParams(): void {
    paramsList.innerHTML = '';
    if (drafts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mb-dialog-params-empty';
      empty.textContent = '（パラメータ未設定）';
      paramsList.appendChild(empty);
      return;
    }
    drafts.forEach((d, idx) => {
      const row = document.createElement('div');
      row.className = 'mb-dialog-param-row';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'mb-dialog-input';
      nameInput.placeholder = 'name';
      nameInput.value = d.name;
      nameInput.addEventListener('input', () => {
        const cur = drafts[idx];
        if (cur) cur.name = nameInput.value;
      });
      row.appendChild(nameInput);

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'mb-dialog-input';
      valueInput.placeholder = 'value';
      valueInput.inputMode = 'decimal';
      valueInput.value = d.value;
      valueInput.addEventListener('input', () => {
        const cur = drafts[idx];
        if (cur) cur.value = valueInput.value;
      });
      row.appendChild(valueInput);

      const unitInput = document.createElement('input');
      unitInput.type = 'text';
      unitInput.className = 'mb-dialog-input';
      unitInput.placeholder = 'unit';
      unitInput.value = d.unit;
      unitInput.addEventListener('input', () => {
        const cur = drafts[idx];
        if (cur) cur.unit = unitInput.value;
      });
      row.appendChild(unitInput);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'mb-dialog-icon-btn is-danger';
      removeBtn.setAttribute('aria-label', 'Remove parameter');
      removeBtn.title = 'この行を削除';
      removeBtn.textContent = '×'; // ×
      removeBtn.addEventListener('click', () => {
        drafts.splice(idx, 1);
        renderParams();
      });
      row.appendChild(removeBtn);

      paramsList.appendChild(row);
    });
  }

  // ---- 開く / 閉じる ----

  function open(el: Element): void {
    editingId = el.id;
    drafts = el.parameters.map(paramToDraft);

    const kindLabel = ELEMENT_SYMBOL[el.kind];
    const displayLabel = el.label ?? kindLabel;
    titleEl.innerHTML = '';
    const strong = document.createElement('span');
    strong.textContent = displayLabel;
    titleEl.appendChild(strong);
    const kindSpan = document.createElement('span');
    kindSpan.className = 'mb-dialog-kind';
    kindSpan.textContent = `(${kindLabel} / ${el.id})`;
    titleEl.appendChild(kindSpan);

    labelInput.value = el.label ?? '';
    eqInput.value = el.equation ?? '';
    renderParams();

    overlay.hidden = false;
    // フォーカス
    queueMicrotask(() => {
      labelInput.focus();
      labelInput.select();
    });
  }

  function close(): void {
    if (editingId === null) return;
    editingId = null;
    drafts = [];
    overlay.hidden = true;
  }

  function save(): void {
    if (editingId === null) return;
    const id = editingId;
    const state = store.getState();
    const el = state.doc.elements.find((e) => e.id === id);
    if (!el) {
      // 保存対象が既に消えている場合は閉じるだけ
      close();
      return;
    }

    const patch: Partial<Omit<Element, 'id'>> = {
      label: labelInput.value.trim(),
      parameters: draftsToParameters(drafts),
      equation: eqInput.value,
    };

    store.dispatch({ type: 'updateElement', id, patch });
    close();
  }

  // ---- イベント ----

  addBtn.addEventListener('click', () => {
    drafts.push({ name: '', value: '0', unit: '' });
    renderParams();
    // 新規行の name にフォーカス
    queueMicrotask(() => {
      const rows = paramsList.querySelectorAll('.mb-dialog-param-row');
      const last = rows[rows.length - 1];
      if (last instanceof HTMLElement) {
        const firstInput = last.querySelector('input');
        if (firstInput instanceof HTMLInputElement) firstInput.focus();
      }
    });
  });

  closeBtn.addEventListener('click', () => close());
  cancelBtn.addEventListener('click', () => close());
  saveBtn.addEventListener('click', () => save());

  // オーバーレイ背景クリック → キャンセル（カード上のクリックは拾わない）
  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) close();
  });

  // ダイアログ内キー: Esc → キャンセル
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      close();
    }
  });

  // グローバル: Enter キーでダイアログを開く
  const onGlobalKeyDown = (e: KeyboardEvent): void => {
    // ダイアログ自身が開いているときはトリガしない
    if (!overlay.hidden) return;
    if (e.key !== 'Enter') return;
    if (shouldIgnoreKeyEvent(e)) return;

    const state = store.getState();
    if (state.selectedElementId === null) return;
    const el = state.doc.elements.find((x) => x.id === state.selectedElementId);
    if (!el) return;

    e.preventDefault();
    open(el);
  };

  window.addEventListener('keydown', onGlobalKeyDown);

  // 選択要素が消えたらダイアログも閉じる（編集中要素が deleteElement された場合等）
  const onStoreChange = (): void => {
    if (editingId === null) return;
    const state = store.getState();
    const stillExists = state.doc.elements.some((e) => e.id === editingId);
    if (!stillExists) close();
  };
  const unsubscribe = store.subscribe(onStoreChange);

  // ---- cleanup ----

  return () => {
    window.removeEventListener('keydown', onGlobalKeyDown);
    unsubscribe();
    if (overlay.parentNode === container) {
      container.removeChild(overlay);
    }
  };
}

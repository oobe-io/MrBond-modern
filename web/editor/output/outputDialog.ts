/**
 * 出力変数の設定ダイアログ。
 *
 * 現状のドキュメントの `outputs` を編集する。各出力は:
 *   - bondId: どのボンドの変数を出力するか
 *   - variableName: "Displacement" / "Momentum" / "Effort" / "Flow" （表示目的）
 *   - label: CSV ヘッダに出る短い名前
 *
 * Mr.Bond 風: 出力変数ダイアログで「追加」ボタンで変数追加、
 * 既存は削除可能。
 */

import type { Store } from '../shared/store.ts';

const STYLE_ID = 'mrbond-output-style';
const STYLE_CSS = `
.mrbond-output-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  backdrop-filter: blur(2px); display: flex; align-items: center;
  justify-content: center; z-index: 1001;
}
.mrbond-output-card {
  background: #181c23; color: #e8eaee; border: 1px solid #2a2f38;
  border-radius: 8px; width: 560px; max-height: 85vh;
  display: flex; flex-direction: column;
}
.mrbond-output-card header {
  padding: 0.8rem 1rem; border-bottom: 1px solid #2a2f38;
  display: flex; align-items: center;
}
.mrbond-output-card header h2 { margin: 0; font-size: 1rem; color: #6ee7b7; flex: 1; }
.mrbond-output-card header .close { background: transparent; border: none; color: #9aa0a6; cursor: pointer; font-size: 1.2rem; }
.mrbond-output-body { padding: 1rem; overflow-y: auto; flex: 1; }
.mrbond-output-body .hint { color: #9aa0a6; font-size: 0.75rem; margin-bottom: 0.8rem; }
.mrbond-output-body table { width: 100%; border-collapse: collapse; }
.mrbond-output-body th, .mrbond-output-body td {
  padding: 0.35rem 0.5rem; font-size: 0.85rem; text-align: left;
  border-bottom: 1px solid #2a2f38;
}
.mrbond-output-body th { color: #9aa0a6; font-weight: 500; font-size: 0.75rem; }
.mrbond-output-body select, .mrbond-output-body input {
  background: #0f1115; color: #e8eaee; border: 1px solid #2a2f38;
  border-radius: 3px; padding: 0.25rem 0.4rem; font-family: inherit;
  font-size: 0.8rem; width: 100%; box-sizing: border-box;
}
.mrbond-output-body button.row-del {
  background: transparent; color: #ef4444; border: 1px solid #ef4444;
  border-radius: 3px; padding: 0.2rem 0.5rem; cursor: pointer; font-size: 0.75rem;
}
.mrbond-output-body button.add-row {
  background: transparent; color: #6ee7b7; border: 1px dashed #6ee7b7;
  padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer;
  font-family: inherit; font-size: 0.8rem; margin-top: 0.6rem; width: 100%;
}
.mrbond-output-card footer {
  padding: 0.8rem 1rem; border-top: 1px solid #2a2f38;
  display: flex; gap: 0.5rem; justify-content: flex-end;
}
.mrbond-output-card footer button {
  background: transparent; color: #6ee7b7; border: 1px solid #6ee7b7;
  padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;
  font-family: inherit; font-size: 0.85rem;
}
.mrbond-output-card footer button.primary {
  background: #6ee7b7; color: #0a0e14; font-weight: 600;
}
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}

export function openOutputDialog(store: Store): void {
  injectStyle();

  const state = store.getState();
  const doc = state.doc;
  // draft outputs (mutable local copy)
  type Draft = { bondId: string; variableName: string; label: string };
  const draft: Draft[] = doc.outputs.map((o) => ({ ...o }));

  const overlay = document.createElement('div');
  overlay.className = 'mrbond-output-overlay';
  const card = document.createElement('div');
  card.className = 'mrbond-output-card';
  overlay.appendChild(card);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  card.innerHTML = `
    <header>
      <h2>出力変数の設定</h2>
      <button class="close" title="閉じる">×</button>
    </header>
    <div class="mrbond-output-body">
      <div class="hint">
        シミュレーション実行時に CSV に出力する変数を設定します。各行の「ボンド」はそのボンドに接続された state 変数（I なら運動量、C なら変位）を参照します。
      </div>
      <table>
        <thead>
          <tr><th>ボンド</th><th>変数名</th><th>ラベル (CSV列)</th><th style="width:40px;"></th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <button class="add-row">+ 出力変数を追加</button>
    </div>
    <footer>
      <button class="cancel-btn">キャンセル</button>
      <button class="primary save-btn">保存</button>
    </footer>
  `;

  const rowsEl = card.querySelector<HTMLTableSectionElement>('#rows')!;
  const addBtn = card.querySelector<HTMLButtonElement>('.add-row')!;
  const saveBtn = card.querySelector<HTMLButtonElement>('.save-btn')!;
  const cancelBtn = card.querySelector<HTMLButtonElement>('.cancel-btn')!;
  const closeBtn = card.querySelector<HTMLButtonElement>('.close')!;

  const bondOptions = doc.bonds
    .map((b) => {
      const fromEl = doc.elements.find((e) => e.id === b.fromElementId);
      const toEl = doc.elements.find((e) => e.id === b.toElementId);
      const fromLabel = fromEl?.label ?? b.fromElementId;
      const toLabel = toEl?.label ?? b.toElementId;
      return `<option value="${b.id}">${b.id}: ${fromLabel} → ${toLabel}</option>`;
    })
    .join('');

  const renderRows = (): void => {
    rowsEl.innerHTML = draft
      .map(
        (row, i) => `
          <tr data-i="${i}">
            <td>
              <select class="bond-sel">
                <option value="">(選択)</option>
                ${bondOptions.replace(`value="${row.bondId}"`, `value="${row.bondId}" selected`)}
              </select>
            </td>
            <td>
              <select class="var-sel">
                <option value="Displacement" ${row.variableName === 'Displacement' ? 'selected' : ''}>Displacement (変位)</option>
                <option value="Momentum" ${row.variableName === 'Momentum' ? 'selected' : ''}>Momentum (運動量)</option>
                <option value="Effort" ${row.variableName === 'Effort' ? 'selected' : ''}>Effort (e)</option>
                <option value="Flow" ${row.variableName === 'Flow' ? 'selected' : ''}>Flow (f)</option>
              </select>
            </td>
            <td><input class="label-in" value="${row.label}" placeholder="DP1"></td>
            <td><button class="row-del" title="削除">×</button></td>
          </tr>
        `,
      )
      .join('');

    rowsEl.querySelectorAll<HTMLTableRowElement>('tr').forEach((tr) => {
      const idx = Number(tr.dataset.i);
      tr.querySelector<HTMLSelectElement>('.bond-sel')!.addEventListener('change', (e) => {
        draft[idx]!.bondId = (e.target as HTMLSelectElement).value;
      });
      tr.querySelector<HTMLSelectElement>('.var-sel')!.addEventListener('change', (e) => {
        draft[idx]!.variableName = (e.target as HTMLSelectElement).value;
      });
      tr.querySelector<HTMLInputElement>('.label-in')!.addEventListener('input', (e) => {
        draft[idx]!.label = (e.target as HTMLInputElement).value;
      });
      tr.querySelector<HTMLButtonElement>('.row-del')!.addEventListener('click', () => {
        draft.splice(idx, 1);
        renderRows();
      });
    });
  };

  addBtn.addEventListener('click', () => {
    draft.push({
      bondId: doc.bonds[0]?.id ?? '',
      variableName: 'Displacement',
      label: `DP${draft.length + 1}`,
    });
    renderRows();
  });

  saveBtn.addEventListener('click', () => {
    // Validate: skip rows with no bondId
    const valid = draft.filter((d) => d.bondId !== '' && d.label.trim() !== '');
    // Dispatch as a new doc with updated outputs
    const newDoc = { ...store.getState().doc, outputs: valid };
    store.dispatch({ type: 'loadDoc', doc: newDoc });
    close();
  });

  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  document.body.appendChild(overlay);
  renderRows();
}

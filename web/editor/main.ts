/**
 * 描画エディタのエントリポイント。
 *
 * toolbar と canvas を共通 store でつないで、右側 Inspector パネルで
 * 選択中要素の詳細を表示する。
 */

import { createStore } from './shared/store.ts';
import { ELEMENT_SYMBOL } from './shared/model.ts';
import { mountCanvas } from './canvas/canvas.ts';
import { mountToolbar } from './toolbar/toolbar.ts';
import { mountParameterDialog } from './dialog/parameterDialog.ts';
import { mountIoButtons } from './io/saveLoad.ts';
import { openRunDialog } from './run/runDialog.ts';

const store = createStore();

const toolbarRoot = document.getElementById('toolbar-root')!;
const canvasRoot = document.getElementById('canvas-root')!;
const inspectorBody = document.getElementById('inspector-body')!;
const statusEl = document.getElementById('status')!;
const ioButtonsRoot = document.getElementById('io-buttons')!;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;

mountToolbar(toolbarRoot, store);
mountCanvas(canvasRoot, store);
mountParameterDialog(document.body, store);
mountIoButtons(ioButtonsRoot, store);
runBtn.addEventListener('click', () => openRunDialog(store));

// Inspector の更新
function renderInspector(): void {
  const state = store.getState();
  const { doc, selectedElementId, tool, pendingBondFrom } = state;

  // ステータス行
  const toolLabel =
    tool.kind === 'select' ? 'Select' :
    tool.kind === 'bond' ? `Bond ${pendingBondFrom ? '(from ' + pendingBondFrom + ')' : ''}` :
    `Place ${ELEMENT_SYMBOL[tool.element]}`;
  statusEl.textContent = `Tool: ${toolLabel}  |  Elements: ${doc.elements.length}  Bonds: ${doc.bonds.length}`;

  // Inspector
  if (selectedElementId === null) {
    inspectorBody.innerHTML = `
      <div class="hint">
        要素を選択するとここに詳細が出ます。<br><br>
        <strong>キーボード:</strong><br>
        V = 選択 / B = ボンド<br>
        C / I / R = 要素配置<br>
        E = SE / F = SF<br>
        T = TF / G = GY<br>
        0 / 1 = ジャンクション<br>
        Del = 削除
      </div>
    `;
    return;
  }
  const el = doc.elements.find((e) => e.id === selectedElementId);
  if (!el) {
    inspectorBody.innerHTML = '<div class="hint">選択要素なし</div>';
    return;
  }
  const connectedBonds = doc.bonds.filter(
    (b) => b.fromElementId === el.id || b.toElementId === el.id,
  );
  inspectorBody.innerHTML = `
    <div style="margin-bottom: 0.8rem;">
      <div style="color: var(--accent); font-size: 1.1rem; font-weight: 600;">${el.label ?? ELEMENT_SYMBOL[el.kind]}</div>
      <div style="color: var(--muted); font-size: 0.8rem;">ID: ${el.id}</div>
      <div style="color: var(--muted); font-size: 0.8rem;">Kind: ${el.kind}</div>
      <div style="color: var(--muted); font-size: 0.8rem;">Pos: (${Math.round(el.position.x)}, ${Math.round(el.position.y)})</div>
    </div>
    <div style="margin-bottom: 0.8rem;">
      <div style="color: var(--fg); font-size: 0.85rem; margin-bottom: 0.3rem;">Parameters (${el.parameters.length})</div>
      ${
        el.parameters.length === 0
          ? '<div class="hint" style="font-size: 0.75rem;">（未設定）</div>'
          : el.parameters
              .map(
                (p) =>
                  `<div style="font-family: 'SF Mono', monospace; font-size: 0.8rem;">${p.name} = ${p.value}${p.unit ? ' ' + p.unit : ''}</div>`,
              )
              .join('')
      }
    </div>
    <div>
      <div style="color: var(--fg); font-size: 0.85rem; margin-bottom: 0.3rem;">Bonds (${connectedBonds.length})</div>
      ${
        connectedBonds.length === 0
          ? '<div class="hint" style="font-size: 0.75rem;">（未接続）</div>'
          : connectedBonds
              .map(
                (b) =>
                  `<div style="font-family: 'SF Mono', monospace; font-size: 0.75rem;">${b.id}: ${b.fromElementId} → ${b.toElementId}</div>`,
              )
              .join('')
      }
    </div>
  `;
}

store.subscribe(renderInspector);
renderInspector();

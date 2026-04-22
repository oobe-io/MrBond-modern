/**
 * 実行ダイアログ:
 *   描画したグラフから Mr.Bond が生成するような temp.c を
 *   ユーザーが貼り付け、それを既存の transpiler + solver に
 *   流して CSV を得る。
 *
 * 将来のタスク:
 *   - グラフからの自動 FUNC/DOUT 導出（因果割当 + 状態方程式生成）
 *   - ここまで自動化できればこのダイアログは不要になる
 *
 * 現状の workflow:
 *   1. エディタでグラフを描く
 *   2. Mr.Bond で同じグラフを開いて temp.c + temp.PAR を生成
 *   3. ここに貼り付けて実行
 *   4. CSV を確認、ダウンロード、または Mr.Bond CSV と突合
 */

import type { Store } from '../shared/store.ts';
import { parsePar } from '../../../src/parser/parFile.ts';
import { buildFuncAndDout } from '../../../src/transpiler/transpileTempC.ts';
import { runSimulation } from '../../../src/runtime/runSimulation.ts';

const STYLE_ID = 'mrbond-run-style';

const STYLE_CSS = `
.mrbond-run-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  backdrop-filter: blur(2px); display: flex; align-items: center;
  justify-content: center; z-index: 1000;
}
.mrbond-run-card {
  background: #181c23; color: #e8eaee; border: 1px solid #2a2f38;
  border-radius: 8px; width: 720px; max-height: 90vh;
  display: flex; flex-direction: column; overflow: hidden;
}
.mrbond-run-card header {
  padding: 0.8rem 1rem; border-bottom: 1px solid #2a2f38;
  display: flex; align-items: center;
}
.mrbond-run-card header h2 { margin: 0; font-size: 1rem; color: #6ee7b7; flex: 1; }
.mrbond-run-card header .close {
  background: transparent; border: none; color: #9aa0a6; cursor: pointer;
  font-size: 1.2rem;
}
.mrbond-run-body { padding: 1rem; overflow-y: auto; flex: 1; }
.mrbond-run-body .field { margin-bottom: 1rem; }
.mrbond-run-body label {
  display: block; font-size: 0.85rem; color: #e8eaee; margin-bottom: 0.3rem;
}
.mrbond-run-body .hint { color: #9aa0a6; font-size: 0.75rem; margin-bottom: 0.4rem; }
.mrbond-run-body textarea {
  width: 100%; min-height: 160px; background: #0f1115; color: #e8eaee;
  border: 1px solid #2a2f38; border-radius: 4px; padding: 0.6rem;
  font-family: 'SF Mono', Monaco, monospace; font-size: 0.8rem; resize: vertical;
}
.mrbond-run-body .result-box {
  background: #0f1115; border: 1px solid #2a2f38; border-radius: 4px;
  padding: 0.6rem; font-family: 'SF Mono', Monaco, monospace;
  font-size: 0.75rem; color: #9aa0a6; max-height: 200px; overflow: auto;
}
.mrbond-run-body .result-box.success { border-color: #3dbe8f; color: #6ee7b7; }
.mrbond-run-body .result-box.error { border-color: #ef4444; color: #fca5a5; }
.mrbond-run-card footer {
  padding: 0.8rem 1rem; border-top: 1px solid #2a2f38;
  display: flex; gap: 0.5rem; justify-content: flex-end;
}
.mrbond-run-card footer button {
  background: transparent; color: #6ee7b7; border: 1px solid #6ee7b7;
  padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;
  font-family: inherit; font-size: 0.85rem;
}
.mrbond-run-card footer button.primary {
  background: #6ee7b7; color: #0a0e14; font-weight: 600;
}
.mrbond-run-card footer button:disabled { opacity: 0.5; cursor: not-allowed; }
.mrbond-run-card footer button:hover:not(:disabled) { opacity: 0.85; }
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}

export function openRunDialog(_store: Store): void {
  injectStyle();

  const overlay = document.createElement('div');
  overlay.className = 'mrbond-run-overlay';
  const card = document.createElement('div');
  card.className = 'mrbond-run-card';
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
      <h2>シミュレーション実行（Mr.Bond 互換）</h2>
      <button class="close" title="閉じる">×</button>
    </header>
    <div class="mrbond-run-body">
      <div class="hint">
        現在の自動導出機能は開発中。Mr.Bond で同じグラフを開いて生成された
        <code>temp.c</code> と <code>temp.PAR</code> をペーストして既存のソルバで実行する。
      </div>
      <div class="field">
        <label for="par-input">temp.PAR（シミュレーション設定 + パラメータ）</label>
        <textarea id="par-input" placeholder="PA   1   1.000000e+001 EIN
NS       2
IN       1
ND       0
PT  1   0.000000e+000
PT  2   1.000000e+001
PT  3   1.000000e-005
NO         1000
OP         1
END"></textarea>
      </div>
      <div class="field">
        <label for="c-input">temp.c（Mr.Bond 生成の C コード）</label>
        <textarea id="c-input" placeholder="#include<stdio.h>
#include<math.h>
...
void FUNC(double T, double X[], int N) {
  DX[0] = ...;
}"></textarea>
      </div>
      <div class="field">
        <label>結果</label>
        <div id="result-box" class="result-box">実行前</div>
      </div>
    </div>
    <footer>
      <button class="cancel-btn">キャンセル</button>
      <button class="download-btn" disabled>CSV ダウンロード</button>
      <button class="primary run-btn">実行</button>
    </footer>
  `;

  const parInput = card.querySelector<HTMLTextAreaElement>('#par-input')!;
  const cInput = card.querySelector<HTMLTextAreaElement>('#c-input')!;
  const resultBox = card.querySelector<HTMLDivElement>('#result-box')!;
  const runBtn = card.querySelector<HTMLButtonElement>('.run-btn')!;
  const cancelBtn = card.querySelector<HTMLButtonElement>('.cancel-btn')!;
  const downloadBtn = card.querySelector<HTMLButtonElement>('.download-btn')!;
  const closeBtn = card.querySelector<HTMLButtonElement>('.close')!;

  let lastCsv: string | null = null;

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  runBtn.addEventListener('click', () => {
    const parSrc = parInput.value.trim();
    const cSrc = cInput.value.trim();
    if (!parSrc || !cSrc) {
      resultBox.className = 'result-box error';
      resultBox.textContent = '両方のフィールドに値を入れてください。';
      return;
    }
    try {
      const t0 = performance.now();
      const par = parsePar(parSrc);
      const { func, dout } = buildFuncAndDout(cSrc, par.pa);
      const result = runSimulation({ par, func, dout });
      const elapsed = performance.now() - t0;

      lastCsv = result.csv;
      downloadBtn.disabled = false;
      resultBox.className = 'result-box success';
      const previewHead = result.csv.split('\n').slice(0, 5).join('\n');
      resultBox.textContent = `✓ ${result.rowCount} 行生成 (${elapsed.toFixed(0)}ms)、最終時刻 t=${result.finalTime.toFixed(5)}s\n\n${previewHead}\n...`;
    } catch (err) {
      resultBox.className = 'result-box error';
      resultBox.textContent = `✘ エラー:\n${(err as Error).message}`;
      downloadBtn.disabled = true;
      lastCsv = null;
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!lastCsv) return;
    const blob = new Blob([lastCsv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `simulation-${ts}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  document.body.appendChild(overlay);
  // 初期フォーカス
  parInput.focus();
}

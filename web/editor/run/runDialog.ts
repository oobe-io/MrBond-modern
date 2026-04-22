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
import { deriveFromGraph, DeriveError } from '../derive/autoDerive.ts';

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
  font-size: 0.75rem; color: #9aa0a6; max-height: 120px; overflow: auto;
  white-space: pre-wrap;
}
.mrbond-run-body .result-box.success { border-color: #3dbe8f; color: #6ee7b7; }
.mrbond-run-body .result-box.error { border-color: #ef4444; color: #fca5a5; }
.mrbond-run-body .plot-container {
  background: #0f1115; border: 1px solid #2a2f38; border-radius: 4px;
  height: 280px; margin-top: 0.5rem; padding: 0;
}
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

.mrbond-run-body .mode-btn {
  background: transparent; color: #6ee7b7; border: 1px solid #6ee7b7;
  padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;
  font-family: inherit; font-size: 0.8rem;
}
.mrbond-run-body .mode-btn.primary {
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

export function openRunDialog(store: Store): void {
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
      <h2>シミュレーション実行</h2>
      <button class="close" title="閉じる">×</button>
    </header>
    <div class="mrbond-run-body">
      <div class="hint">
        <strong>描画グラフから自動導出</strong>：描いた要素とボンドから FUNC/DOUT を自動生成して実行（対応: Se/Sf/I/C/R + 1/0接合点、単純トポロジのみ）。<br>
        <strong>Mr.Bond 互換</strong>：Mr.Bond が生成した temp.c / temp.PAR を貼り付けて実行。
      </div>
      <div class="field">
        <label>モード選択</label>
        <div style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem;">
          <button class="mode-btn primary" data-mode="auto">描画グラフから自動導出</button>
          <button class="mode-btn" data-mode="paste">temp.c/PAR 手動貼り付け</button>
        </div>
      </div>
      <div id="paste-fields" style="display: none;">
        <div class="field">
          <label for="par-input">temp.PAR</label>
          <textarea id="par-input"></textarea>
        </div>
        <div class="field">
          <label for="c-input">temp.c</label>
          <textarea id="c-input"></textarea>
        </div>
      </div>
      <div class="field">
        <label>結果</label>
        <div id="result-box" class="result-box">実行前</div>
        <div id="plot-container" class="plot-container"></div>
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
  const plotContainer = card.querySelector<HTMLDivElement>('#plot-container')!;
  const runBtn = card.querySelector<HTMLButtonElement>('.run-btn')!;
  const cancelBtn = card.querySelector<HTMLButtonElement>('.cancel-btn')!;
  const downloadBtn = card.querySelector<HTMLButtonElement>('.download-btn')!;
  const closeBtn = card.querySelector<HTMLButtonElement>('.close')!;
  const pasteFields = card.querySelector<HTMLDivElement>('#paste-fields')!;
  const modeButtons = card.querySelectorAll<HTMLButtonElement>('.mode-btn');

  let lastCsv: string | null = null;
  let mode: 'auto' | 'paste' = 'auto';

  const setMode = (m: 'auto' | 'paste'): void => {
    mode = m;
    modeButtons.forEach((btn) => {
      btn.classList.toggle('primary', btn.dataset.mode === m);
    });
    pasteFields.style.display = m === 'paste' ? 'block' : 'none';
  };

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode as 'auto' | 'paste');
    });
  });

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  runBtn.addEventListener('click', () => {
    try {
      const t0 = performance.now();
      let result;
      if (mode === 'auto') {
        const doc = store.getState().doc;
        if (doc.elements.length === 0) {
          resultBox.className = 'result-box error';
          resultBox.textContent = 'グラフが空です。要素を配置してから実行してください。';
          return;
        }
        if (doc.outputs.length === 0) {
          resultBox.className = 'result-box error';
          resultBox.textContent = '出力変数が設定されていません。ヘッダーの「📊 Outputs」ボタンで設定してください。';
          return;
        }
        const derived = deriveFromGraph(doc);
        const simResult = runSimulation({ par: derived.par, func: derived.func, dout: derived.dout });
        result = simResult;
        const elapsed = performance.now() - t0;
        lastCsv = simResult.csv;
        downloadBtn.disabled = false;
        resultBox.className = 'result-box success';
        resultBox.textContent = `✓ 自動導出成功\n状態変数: ${derived.stateLabels.join(', ')}  |  出力: ${derived.outputLabels.join(', ')}\n${simResult.rowCount} 行生成 (${elapsed.toFixed(0)}ms)、最終時刻 t=${simResult.finalTime.toFixed(5)}s`;
        renderPlot(plotContainer, simResult.csv);
      } else {
        const parSrc = parInput.value.trim();
        const cSrc = cInput.value.trim();
        if (!parSrc || !cSrc) {
          resultBox.className = 'result-box error';
          resultBox.textContent = '両方のフィールドに値を入れてください。';
          return;
        }
        const par = parsePar(parSrc);
        const { func, dout, fu } = buildFuncAndDout(cSrc, par.pa);
        result = runSimulation({ par, func, dout, fu });
        const elapsed = performance.now() - t0;
        lastCsv = result.csv;
        downloadBtn.disabled = false;
        resultBox.className = 'result-box success';
        resultBox.textContent = `✓ ${result.rowCount} 行生成 (${elapsed.toFixed(0)}ms)、最終時刻 t=${result.finalTime.toFixed(5)}s`;
        renderPlot(plotContainer, result.csv);
      }
    } catch (err) {
      resultBox.className = 'result-box error';
      const prefix = err instanceof DeriveError ? '✘ 導出エラー:\n' : '✘ エラー:\n';
      resultBox.textContent = `${prefix}${(err as Error).message}`;
      downloadBtn.disabled = true;
      lastCsv = null;
      plotContainer.innerHTML = '';
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

  setMode('auto');
  document.body.appendChild(overlay);
}

/** CSV 文字列をパースして Canvas に波形描画 */
function renderPlot(container: HTMLElement, csv: string): void {
  container.innerHTML = '';
  const lines = csv.trimEnd().split('\n');
  if (lines.length < 2) return;
  const header = lines[0]!.split(',').map((s) => s.trim());
  const columnNames = header.slice(1);

  const data: { t: number; vs: number[] }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(',').map((s) => Number.parseFloat(s.trim()));
    if (parts.length < 2) continue;
    data.push({ t: parts[0]!, vs: parts.slice(1) });
  }
  if (data.length < 2) return;

  const canvas = document.createElement('canvas');
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  const margin = { top: 24, right: 16, bottom: 32, left: 64 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const d of data) {
    for (const v of d.vs) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  const yRange = yMax - yMin || 1;
  const yPad = yRange * 0.1;
  yMin -= yPad;
  yMax += yPad;
  const xMin = data[0]!.t;
  const xMax = data[data.length - 1]!.t;
  const xRange = xMax - xMin || 1;

  // Background
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#2a2f38';
  ctx.lineWidth = 1;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillStyle = '#9aa0a6';
  for (let i = 0; i <= 4; i++) {
    const y = margin.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(W - margin.right, y);
    ctx.stroke();
    const v = yMax - ((yMax - yMin) * i) / 4;
    ctx.fillText(v.toExponential(2), 4, y + 3);
  }
  for (let i = 0; i <= 5; i++) {
    const x = margin.left + (plotW * i) / 5;
    const t = xMin + (xRange * i) / 5;
    ctx.fillText(t.toFixed(2), x - 8, H - 12);
  }
  ctx.fillStyle = '#e8eaee';
  ctx.fillText('time [s]', W / 2 - 18, H - 2);

  // Lines
  const colors = ['#6ee7b7', '#fbbf24', '#60a5fa', '#f87171', '#c084fc', '#fb923c'];
  for (let ch = 0; ch < columnNames.length; ch++) {
    ctx.strokeStyle = colors[ch % colors.length]!;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const d = data[i]!;
      const v = d.vs[ch];
      if (v === undefined || !Number.isFinite(v)) continue;
      const x = margin.left + ((d.t - xMin) / xRange) * plotW;
      const y = margin.top + ((yMax - v) / (yMax - yMin)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Legend
  ctx.font = '10px -apple-system, sans-serif';
  for (let ch = 0; ch < columnNames.length; ch++) {
    const x = margin.left + 10 + ch * 80;
    const y = 14;
    ctx.fillStyle = colors[ch % colors.length]!;
    ctx.fillRect(x, y - 6, 12, 2);
    ctx.fillStyle = '#e8eaee';
    ctx.fillText(columnNames[ch]!, x + 16, y);
  }
}

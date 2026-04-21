/**
 * Web シミュレータのエントリポイント。
 *
 * 流れ:
 *   1. tests/fixtures/ からサンプルモデルの .PAR / .c / .BGS を fetch
 *   2. パース → BGS からトポロジ・パラメータ情報を表示
 *   3. 「計算実行」ボタン押下で transpile + シミュレーション → 波形プロット
 */

import { parsePar } from '../src/parser/parFile.ts';
import { parseBgs } from '../src/parser/bgsFile.ts';
import { buildFuncAndDout } from '../src/transpiler/transpileTempC.ts';
import { runSimulation } from '../src/runtime/runSimulation.ts';

const FIXTURE_BASE = '/';
const FIXTURES = {
  par: `${FIXTURE_BASE}springMassDamper.PAR`,
  c: `${FIXTURE_BASE}springMassDamper.model.c`,
  bgs: `${FIXTURE_BASE}springMassDamper.BGS`,
};

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

async function init(): Promise<void> {
  const status = document.getElementById('status')!;
  const paramList = document.getElementById('param-list')!;
  const graphInfo = document.getElementById('graph-info')!;
  const runBtn = document.getElementById('run-btn') as HTMLButtonElement;

  try {
    status.textContent = 'モデル読み込み中…';
    const [parSrc, cSrc, bgsSrc] = await Promise.all([
      fetchText(FIXTURES.par),
      fetchText(FIXTURES.c),
      fetchText(FIXTURES.bgs),
    ]);

    const par = parsePar(parSrc);
    const bgs = parseBgs(bgsSrc);

    // パラメータ表示
    paramList.innerHTML = '';
    for (const [idx, val] of par.pa) {
      const name = par.paNames.get(idx) ?? `PA[${idx}]`;
      const li = document.createElement('li');
      li.innerHTML = `<span>${name}</span><strong>${val}</strong>`;
      paramList.appendChild(li);
    }

    // トポロジ表示
    renderTopology(bgs, graphInfo);

    status.textContent = `モデル準備完了: ${bgs.elements.length} 要素, ${par.pa.size} パラメータ, T=${par.T0}～${par.T1}s, Δt=${par.TI}`;
    status.className = 'status success';

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      status.textContent = 'transpile + シミュレーション実行中…';
      status.className = 'status';
      // UI 更新のため次フレームまで待つ
      await new Promise((r) => setTimeout(r, 16));

      try {
        const t0 = performance.now();
        const { func, dout } = buildFuncAndDout(cSrc, par.pa);
        const result = runSimulation({ par, func, dout });
        const elapsed = performance.now() - t0;

        status.textContent = `完了: ${result.rowCount} 行生成 (${elapsed.toFixed(0)} ms)、最終時刻 t=${result.finalTime.toFixed(5)}s`;
        status.className = 'status success';

        renderPlot(result.csv);
      } catch (err) {
        status.textContent = `エラー: ${(err as Error).message}`;
        status.className = 'status error';
      } finally {
        runBtn.disabled = false;
      }
    });
  } catch (err) {
    status.textContent = `初期化失敗: ${(err as Error).message}`;
    status.className = 'status error';
  }
}

function renderTopology(bgs: Awaited<ReturnType<typeof parseBgs>>, container: HTMLElement): void {
  container.innerHTML = '';
  for (const el of bgs.elements) {
    const div = document.createElement('div');
    div.className = 'element';
    const bonds = el.bonds.join(', ');
    const params = el.parameters.map((p) => `${p.name}=${p.value}`).join(', ');
    const eq = el.equations.length > 0 ? `<span class="equation">${el.equations[0]}</span>` : '';
    div.innerHTML = `<span class="kind">[${el.kind}]</span> ${el.name} <span style="color:#9aa0a6">bonds: ${bonds}</span>${params ? ` ${params}` : ''}${eq}`;
    container.appendChild(div);
  }
}

/**
 * CSV を解析して Canvas に折れ線グラフを描画する。
 * 外部ライブラリなしのミニマル実装。
 */
function renderPlot(csv: string): void {
  const container = document.getElementById('plot-container')!;
  container.innerHTML = '';

  const lines = csv.trimEnd().split('\n');
  if (lines.length < 2) return;

  const header = lines[0]!.split(',').map((s) => s.trim());
  const columnNames = header.slice(1); // TIME 以外

  const data: { t: number; values: number[] }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(',').map((s) => Number.parseFloat(s.trim()));
    if (parts.length < 2) continue;
    data.push({ t: parts[0]!, values: parts.slice(1) });
  }

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
  const margin = { top: 30, right: 20, bottom: 40, left: 70 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  // Y 範囲
  let yMin = Infinity, yMax = -Infinity;
  for (const row of data) {
    for (const v of row.values) {
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

  // 背景
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, W, H);

  // グリッド
  ctx.strokeStyle = '#2a2f38';
  ctx.lineWidth = 1;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillStyle = '#9aa0a6';
  // Y 軸ラベルとグリッド
  for (let i = 0; i <= 5; i++) {
    const y = margin.top + (plotH * i) / 5;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(W - margin.right, y);
    ctx.stroke();
    const v = yMax - ((yMax - yMin) * i) / 5;
    ctx.fillText(v.toExponential(2), 5, y + 3);
  }
  // X 軸ラベル
  for (let i = 0; i <= 5; i++) {
    const x = margin.left + (plotW * i) / 5;
    const t = xMin + (xRange * i) / 5;
    ctx.fillText(t.toFixed(2), x - 10, H - 15);
  }

  // 軸ラベル
  ctx.fillStyle = '#e8eaee';
  ctx.font = '12px -apple-system, sans-serif';
  ctx.fillText('time [s]', W / 2 - 20, H - 3);
  ctx.save();
  ctx.translate(15, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(columnNames.join(', '), 0, 0);
  ctx.restore();

  // データ線
  const colors = ['#6ee7b7', '#fbbf24', '#60a5fa', '#f87171'];
  for (let ch = 0; ch < columnNames.length; ch++) {
    ctx.strokeStyle = colors[ch % colors.length]!;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const row = data[i]!;
      const x = margin.left + ((row.t - xMin) / xRange) * plotW;
      const y = margin.top + ((yMax - row.values[ch]!) / (yMax - yMin)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 凡例
  ctx.font = '11px -apple-system, sans-serif';
  for (let ch = 0; ch < columnNames.length; ch++) {
    const x = margin.left + 10 + ch * 80;
    const y = margin.top - 10;
    ctx.fillStyle = colors[ch % colors.length]!;
    ctx.fillRect(x, y - 6, 14, 3);
    ctx.fillStyle = '#e8eaee';
    ctx.fillText(columnNames[ch]!, x + 18, y);
  }
}

init();

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

    // トポロジ表示（SVGグラフ + 詳細リスト）
    renderGraphSvg(bgs, document.getElementById('graph-svg-container')!);
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

/**
 * BGS のトポロジを SVG で可視化する。
 * 力学的レイアウトは省略し、「Mr.Bond っぽい」シンプルな円形配置を採用。
 * - 0-junction / 1-junction は小さい円で中心に「0」「1」を表示
 * - 要素 (SE/SF/I/C/R/TF/GY) は矩形ラベル
 * - ボンドは線で結び、中央にボンド番号
 */
function renderGraphSvg(
  bgs: ReturnType<typeof parseBgs>,
  container: HTMLElement,
): void {
  container.innerHTML = '';
  const W = container.clientWidth || 600;
  const H = 300;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // 全要素の位置を決定（円形配置）
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) * 0.38;
  const n = bgs.elements.length;
  const positions = new Map<string, { x: number; y: number }>();
  bgs.elements.forEach((el, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    positions.set(el.name, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });

  // ボンド番号 → [端点要素] の逆引きマップ
  const bondEndpoints = new Map<number, string[]>();
  for (const el of bgs.elements) {
    for (const b of el.bonds) {
      const key = Math.abs(b);
      const arr = bondEndpoints.get(key) ?? [];
      arr.push(el.name);
      bondEndpoints.set(key, arr);
    }
  }

  // ボンドの線を先に描画（要素の下に）
  const bondColor = '#4a5568';
  for (const [bondId, endpoints] of bondEndpoints) {
    if (endpoints.length !== 2) continue;
    const p1 = positions.get(endpoints[0]!);
    const p2 = positions.get(endpoints[1]!);
    if (!p1 || !p2) continue;

    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', String(p1.x));
    line.setAttribute('y1', String(p1.y));
    line.setAttribute('x2', String(p2.x));
    line.setAttribute('y2', String(p2.y));
    line.setAttribute('stroke', bondColor);
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);

    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const label = document.createElementNS(svgNs, 'text');
    label.setAttribute('x', String(mid.x));
    label.setAttribute('y', String(mid.y));
    label.setAttribute('fill', '#9aa0a6');
    label.setAttribute('font-size', '10');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = String(bondId);
    svg.appendChild(label);
  }

  // 要素を描画
  const kindStyle: Record<string, { fill: string; stroke: string; symbol: string }> = {
    Se: { fill: '#1e3a5f', stroke: '#60a5fa', symbol: 'SE' },
    Sf: { fill: '#1e3a5f', stroke: '#60a5fa', symbol: 'SF' },
    I: { fill: '#3d2e1f', stroke: '#fbbf24', symbol: 'I' },
    C: { fill: '#1a3a2a', stroke: '#6ee7b7', symbol: 'C' },
    R: { fill: '#3a1a1a', stroke: '#f87171', symbol: 'R' },
    TF: { fill: '#2a1a3a', stroke: '#c084fc', symbol: 'TF' },
    GY: { fill: '#2a1a3a', stroke: '#c084fc', symbol: 'GY' },
    OneJunction: { fill: '#181c23', stroke: '#e8eaee', symbol: '1' },
    ZeroJunction: { fill: '#181c23', stroke: '#e8eaee', symbol: '0' },
  };

  for (const el of bgs.elements) {
    const pos = positions.get(el.name)!;
    const style = kindStyle[el.kind] ?? kindStyle.R!;
    const isJunction = el.kind === 'OneJunction' || el.kind === 'ZeroJunction';

    if (isJunction) {
      // 円形ジャンクション
      const r = 14;
      const circle = document.createElementNS(svgNs, 'circle');
      circle.setAttribute('cx', String(pos.x));
      circle.setAttribute('cy', String(pos.y));
      circle.setAttribute('r', String(r));
      circle.setAttribute('fill', style.fill);
      circle.setAttribute('stroke', style.stroke);
      circle.setAttribute('stroke-width', '1.5');
      svg.appendChild(circle);

      const text = document.createElementNS(svgNs, 'text');
      text.setAttribute('x', String(pos.x));
      text.setAttribute('y', String(pos.y));
      text.setAttribute('fill', style.stroke);
      text.setAttribute('font-size', '13');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.textContent = style.symbol;
      svg.appendChild(text);
    } else {
      // 矩形要素
      const w = 42;
      const h = 22;
      const rect = document.createElementNS(svgNs, 'rect');
      rect.setAttribute('x', String(pos.x - w / 2));
      rect.setAttribute('y', String(pos.y - h / 2));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '3');
      rect.setAttribute('fill', style.fill);
      rect.setAttribute('stroke', style.stroke);
      rect.setAttribute('stroke-width', '1.5');
      svg.appendChild(rect);

      const text = document.createElementNS(svgNs, 'text');
      text.setAttribute('x', String(pos.x));
      text.setAttribute('y', String(pos.y));
      text.setAttribute('fill', style.stroke);
      text.setAttribute('font-size', '11');
      text.setAttribute('font-weight', '600');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.textContent = el.name;
      svg.appendChild(text);
    }
  }

  container.appendChild(svg);
}

function renderTopology(bgs: ReturnType<typeof parseBgs>, container: HTMLElement): void {
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

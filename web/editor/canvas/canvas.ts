/**
 * 描画エディタ - Canvas 部分
 *
 * SVG ベースでボンドグラフの要素・ボンドを描画し、
 * クリック/ドラッグ/キーボード操作を store にアクションとして dispatch する。
 *
 * 責務:
 *   - store の状態を SVG に反映（単純な全再構築方式）
 *   - ツール (select / place / bond) に応じて入力を解釈
 *   - 座標はすべて論理座標 (SVG viewBox = 0 0 800 600)
 *
 * toolbar 側との接点は `shared/store.ts` の Store のみ。
 * このファイルは toolbar/ や shared/ を一切 変更しない。
 */

import type { Store, EditorState } from '../shared/store.ts';
import type { Element, ElementKind } from '../shared/model.ts';
import { ELEMENT_SYMBOL } from '../shared/model.ts';

// ---- 定数 ----

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 800;
const VIEW_H = 600;

const JUNCTION_RADIUS = 16;
const ELEMENT_RECT_W = 48;
const ELEMENT_RECT_H = 26;

const COLOR_BG = '#0f1115';
const COLOR_FG = '#e8eaee';
const COLOR_ACCENT = '#6ee7b7';
const COLOR_BOND = '#8a94a6';
const COLOR_BOND_PENDING = '#6ee7b7';
const COLOR_GRID = '#1a1f2a';

/** 要素種別ごとの配色（web/main.ts の既存配色と統一） */
const KIND_STYLE: Record<ElementKind, { fill: string; stroke: string }> = {
  Se: { fill: '#1e3a5f', stroke: '#60a5fa' },
  Sf: { fill: '#1e3a5f', stroke: '#60a5fa' },
  I: { fill: '#3d2e1f', stroke: '#fbbf24' },
  C: { fill: '#1a3a2a', stroke: '#6ee7b7' },
  R: { fill: '#3a1a1a', stroke: '#f87171' },
  TF: { fill: '#2a1a3a', stroke: '#c084fc' },
  GY: { fill: '#2a1a3a', stroke: '#c084fc' },
  OneJunction: { fill: '#181c23', stroke: '#e8eaee' },
  ZeroJunction: { fill: '#181c23', stroke: '#e8eaee' },
};

// ---- ヒット判定用ヘルパ ----

/**
 * (x, y) が要素 el の「当たり判定」内にあるかを返す。
 * ジャンクションは円、その他は矩形で判定。
 */
function hitTestElement(el: Element, x: number, y: number): boolean {
  const { x: ex, y: ey } = el.position;
  if (el.kind === 'OneJunction' || el.kind === 'ZeroJunction') {
    const dx = x - ex;
    const dy = y - ey;
    return dx * dx + dy * dy <= JUNCTION_RADIUS * JUNCTION_RADIUS;
  }
  const hw = ELEMENT_RECT_W / 2;
  const hh = ELEMENT_RECT_H / 2;
  return x >= ex - hw && x <= ex + hw && y >= ey - hh && y <= ey + hh;
}

/** イベント位置 → SVG 論理座標変換 */
function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  // viewBox は 0 0 800 600 で preserveAspectRatio = meet（デフォルト）
  // ビューポート内のどこに描画されているかを考慮して逆変換する
  const scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
  const renderW = VIEW_W * scale;
  const renderH = VIEW_H * scale;
  const offsetX = (rect.width - renderW) / 2;
  const offsetY = (rect.height - renderH) / 2;
  return {
    x: (clientX - rect.left - offsetX) / scale,
    y: (clientY - rect.top - offsetY) / scale,
  };
}

/**
 * 2 要素間の線分端点をそれぞれの図形の縁で切り詰める。
 * 始点は要素中心そのまま、終点は矩形/円のエッジに合わせ、
 * さらに余白（矢印のため）を確保する。
 */
function computeBondEndpoints(from: Element, to: Element): {
  x1: number; y1: number; x2: number; y2: number;
} {
  const { x: fx, y: fy } = from.position;
  const { x: tx, y: ty } = to.position;
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    return { x1: fx, y1: fy, x2: tx, y2: ty };
  }
  const ux = dx / len;
  const uy = dy / len;

  const shrinkFrom = edgeShrink(from, ux, uy);
  const shrinkTo = edgeShrink(to, -ux, -uy);

  return {
    x1: fx + ux * shrinkFrom,
    y1: fy + uy * shrinkFrom,
    x2: tx - ux * shrinkTo,
    y2: ty - uy * shrinkTo,
  };
}

/** 要素の中心から縁までの距離（単位ベクトル ux,uy の方向） */
function edgeShrink(el: Element, ux: number, uy: number): number {
  if (el.kind === 'OneJunction' || el.kind === 'ZeroJunction') {
    return JUNCTION_RADIUS + 2;
  }
  // 軸並行矩形と直線の交点
  const hw = ELEMENT_RECT_W / 2;
  const hh = ELEMENT_RECT_H / 2;
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  let t = Infinity;
  if (ax > 1e-6) t = Math.min(t, hw / ax);
  if (ay > 1e-6) t = Math.min(t, hh / ay);
  return t + 2;
}

// ---- 描画 ----

/** <svg> の中身を一から構築する */
function render(
  svg: SVGSVGElement,
  state: EditorState,
  pendingPointer: { x: number; y: number } | null,
  attachElementHandlers: (g: SVGGElement, el: Element) => void,
): void {
  // 全クリア
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // 背景（クリック拾い用にも使う）
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', String(VIEW_W));
  bg.setAttribute('height', String(VIEW_H));
  bg.setAttribute('fill', COLOR_BG);
  svg.appendChild(bg);

  // グリッド（軽め）
  drawGrid(svg);

  // 矢印マーカー定義（半矢印：ハーフアロー）
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.appendChild(buildHalfArrowMarker('halfarrow', COLOR_BOND));
  defs.appendChild(buildHalfArrowMarker('halfarrow-pending', COLOR_BOND_PENDING));
  defs.appendChild(buildHalfArrowMarker('halfarrow-selected', COLOR_ACCENT));
  svg.appendChild(defs);

  // ボンド（要素より下層）
  const { elements, bonds } = state.doc;
  const elementById = new Map<string, Element>();
  for (const el of elements) elementById.set(el.id, el);

  // ボンド番号の抽出: "bond_7" → 7
  const bondNumber = (bondId: string): string => {
    const m = /_(\d+)$/.exec(bondId);
    return m ? m[1]! : bondId;
  };

  for (const b of bonds) {
    const from = elementById.get(b.fromElementId);
    const to = elementById.get(b.toElementId);
    if (!from || !to) continue;
    const { x1, y1, x2, y2 } = computeBondEndpoints(from, to);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('stroke', COLOR_BOND);
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('marker-end', 'url(#halfarrow)');
    line.setAttribute('pointer-events', 'none');
    svg.appendChild(line);

    // ボンド番号ラベル（Mr.Bond の慣例表記）。ボンド中点に小さく表示、
    // 線に重ならないよう少しオフセットして配置
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    // 法線方向に 10px オフセット
    const offX = len > 1e-6 ? (-dy / len) * 10 : 0;
    const offY = len > 1e-6 ? (dx / len) * 10 : 0;
    const labelBg = document.createElementNS(SVG_NS, 'circle');
    labelBg.setAttribute('cx', String(midX + offX));
    labelBg.setAttribute('cy', String(midY + offY));
    labelBg.setAttribute('r', '8');
    labelBg.setAttribute('fill', '#0f1115');
    labelBg.setAttribute('stroke', 'none');
    labelBg.setAttribute('pointer-events', 'none');
    svg.appendChild(labelBg);
    const labelText = document.createElementNS(SVG_NS, 'text');
    labelText.setAttribute('x', String(midX + offX));
    labelText.setAttribute('y', String(midY + offY));
    labelText.setAttribute('fill', '#9aa0a6');
    labelText.setAttribute('font-size', '11');
    labelText.setAttribute('font-weight', '500');
    labelText.setAttribute('text-anchor', 'middle');
    labelText.setAttribute('dominant-baseline', 'central');
    labelText.setAttribute('pointer-events', 'none');
    labelText.textContent = bondNumber(b.id);
    svg.appendChild(labelText);
  }

  // ラバーバンド（描画中のボンド）
  if (state.pendingBondFrom !== null && pendingPointer !== null) {
    const from = elementById.get(state.pendingBondFrom);
    if (from) {
      const dx = pendingPointer.x - from.position.x;
      const dy = pendingPointer.y - from.position.y;
      const len = Math.hypot(dx, dy);
      let x1 = from.position.x;
      let y1 = from.position.y;
      if (len > 1e-6) {
        const shrink = edgeShrink(from, dx / len, dy / len);
        x1 = from.position.x + (dx / len) * shrink;
        y1 = from.position.y + (dy / len) * shrink;
      }
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(pendingPointer.x));
      line.setAttribute('y2', String(pendingPointer.y));
      line.setAttribute('stroke', COLOR_BOND_PENDING);
      line.setAttribute('stroke-width', '1.6');
      line.setAttribute('stroke-dasharray', '5 4');
      line.setAttribute('marker-end', 'url(#halfarrow-pending)');
      line.setAttribute('pointer-events', 'none');
      svg.appendChild(line);
    }
  }

  // 要素を描画
  for (const el of elements) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-element-id', el.id);
    g.setAttribute('transform', `translate(${el.position.x}, ${el.position.y})`);
    g.style.cursor = state.tool.kind === 'select' ? 'move' : 'pointer';

    const selected = state.selectedElementId === el.id;
    const pendingSource = state.pendingBondFrom === el.id;
    const style = KIND_STYLE[el.kind];
    const strokeColor = selected || pendingSource ? COLOR_ACCENT : style.stroke;
    const strokeWidth = selected || pendingSource ? 2.5 : 1.5;

    if (el.kind === 'OneJunction' || el.kind === 'ZeroJunction') {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', '0');
      circle.setAttribute('cy', '0');
      circle.setAttribute('r', String(JUNCTION_RADIUS));
      circle.setAttribute('fill', style.fill);
      circle.setAttribute('stroke', strokeColor);
      circle.setAttribute('stroke-width', String(strokeWidth));
      g.appendChild(circle);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', '0');
      text.setAttribute('y', '0');
      text.setAttribute('fill', COLOR_FG);
      text.setAttribute('font-size', '14');
      text.setAttribute('font-weight', '700');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('pointer-events', 'none');
      text.textContent = ELEMENT_SYMBOL[el.kind];
      g.appendChild(text);
    } else {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(-ELEMENT_RECT_W / 2));
      rect.setAttribute('y', String(-ELEMENT_RECT_H / 2));
      rect.setAttribute('width', String(ELEMENT_RECT_W));
      rect.setAttribute('height', String(ELEMENT_RECT_H));
      rect.setAttribute('rx', '5');
      rect.setAttribute('ry', '5');
      rect.setAttribute('fill', style.fill);
      rect.setAttribute('stroke', strokeColor);
      rect.setAttribute('stroke-width', String(strokeWidth));
      g.appendChild(rect);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', '0');
      text.setAttribute('y', '0');
      text.setAttribute('fill', COLOR_FG);
      text.setAttribute('font-size', '12');
      text.setAttribute('font-weight', '600');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('pointer-events', 'none');
      text.textContent = el.label ?? ELEMENT_SYMBOL[el.kind];
      g.appendChild(text);
    }

    attachElementHandlers(g, el);
    svg.appendChild(g);
  }
}

function drawGrid(svg: SVGSVGElement): void {
  const step = 40;
  for (let x = 0; x <= VIEW_W; x += step) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(x));
    line.setAttribute('y1', '0');
    line.setAttribute('x2', String(x));
    line.setAttribute('y2', String(VIEW_H));
    line.setAttribute('stroke', COLOR_GRID);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('pointer-events', 'none');
    svg.appendChild(line);
  }
  for (let y = 0; y <= VIEW_H; y += step) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(VIEW_W));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', COLOR_GRID);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('pointer-events', 'none');
    svg.appendChild(line);
  }
}

/** ボンドグラフ慣例の半矢印マーカー（上側の斜線のみ） */
function buildHalfArrowMarker(id: string, color: string): SVGMarkerElement {
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', id);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '10');
  marker.setAttribute('markerHeight', '10');
  marker.setAttribute('orient', 'auto-start-reverse');
  // 線分の終点(9,5) から始点方向に戻り、上側へ跳ね上がる半矢印
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M 0 0 L 9 5');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-linecap', 'round');
  marker.appendChild(path);
  return marker;
}

// ---- エクスポート ----

/**
 * container に SVG キャンバスをマウントし、store と同期する。
 * 戻り値は cleanup 関数（イベント解除＋DOM 除去）。
 */
export function mountCanvas(container: HTMLElement, store: Store): () => void {
  // ルート SVG
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.display = 'block';
  svg.style.background = COLOR_BG;
  svg.style.userSelect = 'none';
  svg.setAttribute('tabindex', '0'); // キーボードフォーカス用
  container.appendChild(svg);

  // ラバーバンドや再描画ヒント用の可変状態
  let pendingPointer: { x: number; y: number } | null = null;
  let dragging: { id: string; offsetX: number; offsetY: number; moved: boolean } | null = null;

  /** 要素1つ分のイベントハンドラ装着 */
  function attachElementHandlers(g: SVGGElement, el: Element): void {
    g.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      const state = store.getState();
      const tool = state.tool;
      const { x, y } = clientToSvg(svg, ev.clientX, ev.clientY);

      if (tool.kind === 'select') {
        // 選択 + ドラッグ開始
        store.dispatch({ type: 'selectElement', id: el.id });
        dragging = {
          id: el.id,
          offsetX: x - el.position.x,
          offsetY: y - el.position.y,
          moved: false,
        };
        ev.preventDefault();
        return;
      }

      if (tool.kind === 'bond') {
        if (state.pendingBondFrom === null) {
          store.dispatch({ type: 'startBond', fromId: el.id });
        } else {
          store.dispatch({ type: 'completeBond', toId: el.id });
        }
        ev.preventDefault();
        return;
      }

      // place モードでは要素上クリックは無視
    });
  }

  /** 背景クリック: 配置 or 選択解除 */
  function onBackgroundMouseDown(ev: MouseEvent): void {
    // 要素 g が stopPropagation してくるので、ここへ来るのは背景クリックのみ
    const state = store.getState();
    const tool = state.tool;
    const { x, y } = clientToSvg(svg, ev.clientX, ev.clientY);

    // 範囲外クリックは無視
    if (x < 0 || x > VIEW_W || y < 0 || y > VIEW_H) return;

    if (tool.kind === 'place') {
      store.dispatch({ type: 'addElement', kind: tool.element, x, y });
      return;
    }

    if (tool.kind === 'bond') {
      // 空白クリックは何もしない（Esc で取り消せる）
      return;
    }

    // select: 空白 → 選択解除
    store.dispatch({ type: 'selectElement', id: null });
  }

  function onMouseMove(ev: MouseEvent): void {
    const { x, y } = clientToSvg(svg, ev.clientX, ev.clientY);

    // ドラッグ中：要素を移動
    if (dragging !== null) {
      const newX = x - dragging.offsetX;
      const newY = y - dragging.offsetY;
      const clampedX = Math.max(0, Math.min(VIEW_W, newX));
      const clampedY = Math.max(0, Math.min(VIEW_H, newY));
      store.dispatch({ type: 'moveElement', id: dragging.id, x: clampedX, y: clampedY });
      dragging.moved = true;
      return;
    }

    // ボンド描画中：ラバーバンド位置を更新
    const state = store.getState();
    if (state.tool.kind === 'bond' && state.pendingBondFrom !== null) {
      pendingPointer = { x, y };
      // store を変えずに再描画をトリガしたい。最小限のやり方として直接 render を呼ぶ
      render(svg, state, pendingPointer, attachElementHandlers);
    }
  }

  function onMouseUp(_ev: MouseEvent): void {
    dragging = null;
  }

  function onKeyDown(ev: KeyboardEvent): void {
    const state = store.getState();
    if (ev.key === 'Escape') {
      if (state.pendingBondFrom !== null) {
        store.dispatch({ type: 'cancelBond' });
        pendingPointer = null;
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      // input 要素にフォーカスがあるときは無視
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      if (state.selectedElementId !== null) {
        store.dispatch({ type: 'deleteElement', id: state.selectedElementId });
        ev.preventDefault();
      }
    }
  }

  // 背景クリックは SVG 自体で拾う（要素側は stopPropagation）
  svg.addEventListener('mousedown', onBackgroundMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);

  // 初回描画 + store 購読
  const rerender = (): void => {
    const state = store.getState();
    // ボンド描画モードを抜けたらラバーバンドを消す
    if (state.pendingBondFrom === null) pendingPointer = null;
    render(svg, state, pendingPointer, attachElementHandlers);
  };
  rerender();
  const unsubscribe = store.subscribe(rerender);

  // 追加: ヒットテストを元に要素 g をクリックしたかどうかを SVG の mousedown 段階で
  // 自分でも判定しておく。要素 g のハンドラが先に走って stopPropagation するので、
  // 背景ハンドラに届くのは純粋な背景クリックだけになる。上で実装済み。

  // クリーンアップ関数
  return () => {
    unsubscribe();
    svg.removeEventListener('mousedown', onBackgroundMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', onKeyDown);
    if (svg.parentNode === container) {
      container.removeChild(svg);
    }
  };
}

// ---- 内部ユーティリティの export（テスト用、任意） ----

/** テスト用: hitTestElement を外部から呼べるようにする */
export const __internals = {
  hitTestElement,
  computeBondEndpoints,
  clientToSvg,
};

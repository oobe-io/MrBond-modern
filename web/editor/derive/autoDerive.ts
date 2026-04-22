/**
 * ボンドグラフからの自動導出（SCAP の簡易版 + 状態方程式生成）。
 *
 * 対応範囲（MVP）:
 *   - 1-port 要素: Se, Sf, I, C, R （TF/GY は将来対応）
 *   - 接合点: 0-junction, 1-junction
 *   - すべての I, C に積分因果を前提
 *   - ジャンクション同士が繋がっていても可（ツリー形状ならOK、サイクルは未対応）
 *
 * 非対応（将来タスク）:
 *   - 微分因果 / 代数ループ / 制約方程式（ND > 0）
 *   - TF / GY 要素（線形比パラメータを持つ）
 *   - スイッチング要素（FD_valve の if/else クランプ等）
 *
 * 出力:
 *   - `DerivFn` (FUNC) と `DoutFn` (DOUT) のペア
 *   - 合成した `ParFile` （シミュ設定 + PA 配列）
 *   - State ラベルと Output ラベル
 */

import type { Bond, BondGraphDoc, Element } from '../shared/model.ts';
import type { DerivFn } from '../../../src/solver/rungeKuttaGill.ts';
import type { DoutFn } from '../../../src/runtime/runSimulation.ts';
import type { ParFile } from '../../../src/parser/parFile.ts';

export interface DerivedModel {
  readonly func: DerivFn;
  readonly dout: DoutFn;
  readonly par: ParFile;
  readonly stateLabels: readonly string[];
  readonly outputLabels: readonly string[];
  /** デバッグ: 導出途中の注釈 */
  readonly trace: readonly string[];
}

export class DeriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeriveError';
  }
}

// ---- パラメータ/式の評価 ----
//
// 要素の equation は `e=PK*Z;` のような短い C 式。
// Z は「状態変数」を意味する慣習（I なら運動量 p、C なら変位 q）。
// PK 等は要素の parameters[i].name に対応。
//
// 評価戦略: new Function で JS 化して eval。
// 環境: Z (状態値), PA (パラメータ名→値のmap)。

interface EvalContext {
  z: number;
  paValues: Record<string, number>;
}

function compileEquation(raw: string, knownParams: string[]): (ctx: EvalContext) => number {
  // 形式: "<varname>=<expr>;" or just "<expr>"
  let expr = raw.trim();
  if (expr.endsWith(';')) expr = expr.slice(0, -1);
  const eqMatch = /^[A-Za-z_]\w*\s*=\s*(.+)$/.exec(expr);
  if (eqMatch) expr = eqMatch[1]!;
  // 許可: 数字, 演算子, 関数（sin/cos/exp/log/sqrt/pow/fabs）, 識別子
  // JS に渡す際は Z / paValues の参照に書き換える
  const sanitized = expr.replace(/\bfabs\b/g, 'Math.abs')
    .replace(/\bsin\b/g, 'Math.sin')
    .replace(/\bcos\b/g, 'Math.cos')
    .replace(/\bexp\b/g, 'Math.exp')
    .replace(/\blog\b/g, 'Math.log')
    .replace(/\bsqrt\b/g, 'Math.sqrt')
    .replace(/\bpow\b/g, 'Math.pow');

  // 識別子 → `paValues["name"]` or `z`
  // ただし Math.* は触らない
  const replaced = sanitized.replace(/(?<![\w.])([A-Za-z_]\w*)(?![\w(])/g, (m) => {
    if (m === 'Z') return 'z';
    if (knownParams.includes(m)) return `paValues[${JSON.stringify(m)}]`;
    return m;
  });

  // eslint-disable-next-line no-new-func
  const fn = new Function('z', 'paValues', `return (${replaced});`) as (
    z: number,
    paValues: Record<string, number>,
  ) => number;
  return (ctx) => fn(ctx.z, ctx.paValues);
}

// ---- グラフ走査ヘルパ ----

type ElementMap = Map<string, Element>;

function bondsOfElement(doc: BondGraphDoc, elId: string): Bond[] {
  return doc.bonds.filter((b) => b.fromElementId === elId || b.toElementId === elId);
}

function otherEnd(bond: Bond, elId: string): string {
  return bond.fromElementId === elId ? bond.toElementId : bond.fromElementId;
}

// ---- 因果解析 ----
//
// 各ボンドに対して「effort を決める側」と「flow を決める側」を割り当てる。
// 慣習として causalityStroke が付く端点が effort を **受け取る** = 相手側が effort を決める。
//
// ここでは簡易化して「各 bond について、state 側（I or C が繋がる端）を向きに定める」と考える。
// 具体的には:
//   - I 要素: integral 因果 → I は flow を出力（= 相手が effort を出力）
//   - C 要素: integral 因果 → C は effort を出力（= 相手が flow を出力）
//   - Se, Sf: 自身が指定の変数を出力、相手から残りを受け取る
//   - R: どちらでも可。接続先の要求に従う
//   - 接合点は伝搬

type BondOrientation = {
  /** bond.fromElementId 側が effort を出す時 true */
  fromProvidesEffort: boolean;
};

// ---- メインの導出 ----

export function deriveFromGraph(doc: BondGraphDoc): DerivedModel {
  const trace: string[] = [];
  const elMap: ElementMap = new Map(doc.elements.map((e) => [e.id, e]));

  // 1. 状態変数の列挙: I, C 要素を index 0..NS-1 に割当
  const stateElements = doc.elements.filter((e) => e.kind === 'I' || e.kind === 'C');
  if (stateElements.length === 0) {
    throw new DeriveError('状態変数がありません（I または C 要素が必要）');
  }
  const stateIndexOf = new Map<string, number>();
  stateElements.forEach((e, i) => stateIndexOf.set(e.id, i));

  trace.push(`States (${stateElements.length}): ${stateElements.map((e) => `${e.label}(${e.kind})`).join(', ')}`);

  // 2. PA 配列の構築（全要素のパラメータを名前→値で統合、1始まりのPA配列も同時に）
  const paValues: Record<string, number> = {};
  const paArray: number[] = [0]; // index 0 は未使用
  for (const el of doc.elements) {
    for (const p of el.parameters) {
      if (!(p.name in paValues)) {
        paValues[p.name] = p.value;
        paArray.push(p.value);
      }
    }
  }
  const knownParams = Object.keys(paValues);

  // 3. 各要素の「equation」をコンパイル。
  //    I, C は状態依存の出力（Z = 状態値）。
  //    Se, Sf は定数。
  //    R は flow 入力に対する effort 出力（引数 Z = flow）。
  const elementFns = new Map<string, (ctx: EvalContext) => number>();
  for (const el of doc.elements) {
    if (['Se', 'Sf', 'I', 'C', 'R'].includes(el.kind)) {
      const eq = el.equation?.trim();
      if (!eq) {
        // デフォルト式を要素タイプから推測
        if (el.kind === 'Se' || el.kind === 'Sf') {
          // 1つ目のパラメータを定数として使う
          const pname = el.parameters[0]?.name;
          if (!pname) throw new DeriveError(`${el.label ?? el.id}: パラメータが設定されていません`);
          elementFns.set(el.id, (_ctx) => paValues[pname]!);
          continue;
        }
        if (el.kind === 'I') {
          const pname = el.parameters[0]?.name;
          if (!pname) throw new DeriveError(`${el.label ?? el.id}: 質量パラメータが必要です`);
          elementFns.set(el.id, (ctx) => ctx.z / paValues[pname]!);
          continue;
        }
        if (el.kind === 'C') {
          const pname = el.parameters[0]?.name;
          if (!pname) throw new DeriveError(`${el.label ?? el.id}: 容量パラメータが必要です`);
          elementFns.set(el.id, (ctx) => paValues[pname]! * ctx.z);
          continue;
        }
        if (el.kind === 'R') {
          const pname = el.parameters[0]?.name;
          if (!pname) throw new DeriveError(`${el.label ?? el.id}: 抵抗パラメータが必要です`);
          elementFns.set(el.id, (ctx) => paValues[pname]! * ctx.z);
          continue;
        }
      } else {
        elementFns.set(el.id, compileEquation(eq, knownParams));
      }
    }
  }

  // 4. 各 bond の向き: "from" 側が effort を提供するか
  //    ルール:
  //      Se は effort 提供 → bond の Se 側 が effort 提供
  //      Sf は flow 提供 → bond の Sf 側 が flow 提供（= 他端が effort 提供）
  //      I (integral) は flow 提供 → 他端が effort 提供
  //      C (integral) は effort 提供
  //      R, 接合点は後で propagate
  const orient = new Map<string, BondOrientation>();
  for (const b of doc.bonds) {
    const fromEl = elMap.get(b.fromElementId);
    const toEl = elMap.get(b.toElementId);
    if (!fromEl || !toEl) continue;
    let fromProvidesEffort: boolean | undefined;
    if (fromEl.kind === 'Se') fromProvidesEffort = true;
    else if (toEl.kind === 'Se') fromProvidesEffort = false;
    else if (fromEl.kind === 'Sf') fromProvidesEffort = false;
    else if (toEl.kind === 'Sf') fromProvidesEffort = true;
    else if (fromEl.kind === 'I') fromProvidesEffort = false;
    else if (toEl.kind === 'I') fromProvidesEffort = true;
    else if (fromEl.kind === 'C') fromProvidesEffort = true;
    else if (toEl.kind === 'C') fromProvidesEffort = false;
    if (fromProvidesEffort !== undefined) {
      orient.set(b.id, { fromProvidesEffort });
    }
  }

  // 接合点を通じて因果を伝搬:
  //   1-junction: 1 つの bond だけが flow を決定（他は effort 決定）
  //   0-junction: 1 つの bond だけが effort を決定（他は flow 決定）
  // 既に割当済みの bond から推論していく。複数パスで収束させる。
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const el of doc.elements) {
      if (el.kind !== 'OneJunction' && el.kind !== 'ZeroJunction') continue;
      const bonds = bondsOfElement(doc, el.id);
      // 各 bond について、このジャンクション側が effort を受け取るか flow を受け取るか
      const junctionReceivesEffort = bonds.map((b) => {
        const o = orient.get(b.id);
        if (!o) return undefined;
        // from が effort 提供 && from == junction なら、ジャンクションは effort を提供（受け取るのは他端）
        // junction が from の時: junction_provides_effort = o.fromProvidesEffort → 受け取るのは !fromProvidesEffort 側の変数
        const junctionIsFrom = b.fromElementId === el.id;
        const junctionProvidesEffort = junctionIsFrom ? o.fromProvidesEffort : !o.fromProvidesEffort;
        return !junctionProvidesEffort; // 受け取る = effort かどうか
      });
      if (el.kind === 'OneJunction') {
        // 1-junction: 1 bond が flow 決定、他は effort 決定
        // 「flow 決定 bond」 = junction が flow を **受け取る** bond
        const undefIdx: number[] = [];
        let flowProviderCount = 0;
        for (let i = 0; i < bonds.length; i++) {
          const r = junctionReceivesEffort[i];
          if (r === undefined) undefIdx.push(i);
          else if (r === false /* receives flow */) flowProviderCount++;
        }
        if (undefIdx.length === 1 && flowProviderCount === 0) {
          // 唯一の未定 bond が flow provider
          const idx = undefIdx[0]!;
          const b = bonds[idx]!;
          const junctionIsFrom = b.fromElementId === el.id;
          // junction receives flow → junction is flow consumer
          // fromProvidesEffort の値: junction が effort 提供 = junction is from ? from提供=true : from提供=false
          orient.set(b.id, { fromProvidesEffort: junctionIsFrom });
          changed = true;
        } else if (flowProviderCount > 0) {
          // 他はすべて effort provider
          for (const idx of undefIdx) {
            const b = bonds[idx]!;
            const junctionIsFrom = b.fromElementId === el.id;
            // junction receives effort → junction is not effort provider
            // fromProvidesEffort = junctionIsFrom ? !junction's effort provide : junction's effort provide
            // junction doesn't provide effort, so:
            orient.set(b.id, { fromProvidesEffort: !junctionIsFrom });
            changed = true;
          }
        }
      } else {
        // 0-junction: 1 bond が effort 決定、他は flow 決定
        const undefIdx: number[] = [];
        let effortProviderCount = 0;
        for (let i = 0; i < bonds.length; i++) {
          const r = junctionReceivesEffort[i];
          if (r === undefined) undefIdx.push(i);
          else if (r === true /* receives effort */) effortProviderCount++;
        }
        if (undefIdx.length === 1 && effortProviderCount === 0) {
          const idx = undefIdx[0]!;
          const b = bonds[idx]!;
          const junctionIsFrom = b.fromElementId === el.id;
          orient.set(b.id, { fromProvidesEffort: !junctionIsFrom });
          changed = true;
        } else if (effortProviderCount > 0) {
          for (const idx of undefIdx) {
            const b = bonds[idx]!;
            const junctionIsFrom = b.fromElementId === el.id;
            orient.set(b.id, { fromProvidesEffort: junctionIsFrom });
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  // R bond で未定のもの: 任意に割り当て（片側を flow 決定にする）
  for (const b of doc.bonds) {
    if (orient.has(b.id)) continue;
    const fromEl = elMap.get(b.fromElementId)!;
    const toEl = elMap.get(b.toElementId)!;
    if (fromEl.kind === 'R') {
      orient.set(b.id, { fromProvidesEffort: true }); // R gives effort, reads flow
    } else if (toEl.kind === 'R') {
      orient.set(b.id, { fromProvidesEffort: false });
    }
  }

  trace.push(`Bonds oriented: ${orient.size}/${doc.bonds.length}`);

  // 5. 効率/流れの計算関数（x 状態ベクトル → 値）
  type Computer = (x: readonly number[]) => number;

  // memoization でサイクル検出
  const effortCache = new Map<string, Computer | 'computing'>();
  const flowCache = new Map<string, Computer | 'computing'>();

  const keyOf = (bondId: string, fromJunctionId: string): string => `${bondId}@${fromJunctionId}`;

  function effortFromBondToElement(bond: Bond, targetElId: string): Computer {
    const cacheKey = keyOf(bond.id, targetElId);
    const cached = effortCache.get(cacheKey);
    if (cached === 'computing') {
      throw new DeriveError(`effort 計算でサイクル検出: bond ${bond.id}`);
    }
    if (cached !== undefined) return cached;
    effortCache.set(cacheKey, 'computing');
    const computer = buildEffortComputer(bond, targetElId);
    effortCache.set(cacheKey, computer);
    return computer;
  }

  function flowFromBondToElement(bond: Bond, targetElId: string): Computer {
    const cacheKey = keyOf(bond.id, targetElId);
    const cached = flowCache.get(cacheKey);
    if (cached === 'computing') {
      throw new DeriveError(`flow 計算でサイクル検出: bond ${bond.id}`);
    }
    if (cached !== undefined) return cached;
    flowCache.set(cacheKey, 'computing');
    const computer = buildFlowComputer(bond, targetElId);
    flowCache.set(cacheKey, computer);
    return computer;
  }

  /**
   * ボンド B がジャンクション J に「入る」方向なら +1、「出る」方向なら -1。
   * 1-junction: Σ(sign_i * e_i) = 0
   * 0-junction: Σ(sign_i * f_i) = 0
   */
  function junctionSign(bond: Bond, junctionId: string): 1 | -1 {
    return bond.toElementId === junctionId ? 1 : -1;
  }

  // "bond の target 側に流入する effort" を計算するクロージャを構築
  function buildEffortComputer(bond: Bond, targetElId: string): Computer {
    const sourceElId = otherEnd(bond, targetElId);
    const sourceEl = elMap.get(sourceElId)!;
    if (sourceEl.kind === 'Se') {
      const fn = elementFns.get(sourceElId)!;
      return () => fn({ z: 0, paValues });
    }
    if (sourceEl.kind === 'C') {
      const stateIdx = stateIndexOf.get(sourceElId);
      if (stateIdx === undefined) throw new DeriveError(`C state not indexed: ${sourceElId}`);
      const fn = elementFns.get(sourceElId)!;
      return (x) => fn({ z: x[stateIdx]!, paValues });
    }
    if (sourceEl.kind === 'I') {
      throw new DeriveError(`effort not available from I element ${sourceElId} at bond ${bond.id}`);
    }
    if (sourceEl.kind === 'R') {
      // R: effort = R_param * flow。flow を同じボンド経由で取得
      const flowComputer = flowFromBondToElement(bond, sourceElId);
      const fn = elementFns.get(sourceElId)!;
      return (x) => fn({ z: flowComputer(x), paValues });
    }
    if (sourceEl.kind === 'OneJunction') {
      // 1-junction の制約: Σ(sign_i * e_i) = 0
      // e_B = -sign_B * Σ(sign_i * e_i for i != B)
      const junctionId = sourceElId;
      const signB = junctionSign(bond, junctionId);
      const otherBonds = bondsOfElement(doc, junctionId).filter((b) => b.id !== bond.id);
      const computers = otherBonds.map((b) => ({
        sign: junctionSign(b, junctionId),
        fn: effortFromBondToElement(b, junctionId),
      }));
      return (x) => {
        let sum = 0;
        for (const c of computers) sum += c.sign * c.fn(x);
        return -signB * sum;
      };
    }
    if (sourceEl.kind === 'ZeroJunction') {
      // 0-junction: common effort（すべてのボンドで同じ値）
      // 1つの effort provider bond から値を取る
      const bonds0 = bondsOfElement(doc, sourceElId).filter((b) => b.id !== bond.id);
      const provider = bonds0.find((b) => {
        const o = orient.get(b.id);
        if (!o) return false;
        const jIsFrom = b.fromElementId === sourceElId;
        const junctionProvidesEffort = jIsFrom ? o.fromProvidesEffort : !o.fromProvidesEffort;
        return !junctionProvidesEffort;
      });
      if (!provider) {
        throw new DeriveError(`0-junction ${sourceElId} に effort provider が見つかりません`);
      }
      return effortFromBondToElement(provider, sourceElId);
    }
    throw new DeriveError(`未対応の element kind: ${sourceEl.kind}`);
  }

  function buildFlowComputer(bond: Bond, targetElId: string): Computer {
    const sourceElId = otherEnd(bond, targetElId);
    const sourceEl = elMap.get(sourceElId)!;
    if (sourceEl.kind === 'Sf') {
      const fn = elementFns.get(sourceElId)!;
      return () => fn({ z: 0, paValues });
    }
    if (sourceEl.kind === 'I') {
      const stateIdx = stateIndexOf.get(sourceElId);
      if (stateIdx === undefined) throw new DeriveError(`I state not indexed: ${sourceElId}`);
      const fn = elementFns.get(sourceElId)!;
      return (x) => fn({ z: x[stateIdx]!, paValues });
    }
    if (sourceEl.kind === 'C') {
      throw new DeriveError(`flow not available from C element ${sourceElId}`);
    }
    if (sourceEl.kind === 'R') {
      throw new DeriveError(`R element ${sourceElId} の inverse causality は未対応`);
    }
    if (sourceEl.kind === 'ZeroJunction') {
      // 0-junction の制約: Σ(sign_i * f_i) = 0
      const junctionId = sourceElId;
      const signB = junctionSign(bond, junctionId);
      const otherBonds = bondsOfElement(doc, junctionId).filter((b) => b.id !== bond.id);
      const computers = otherBonds.map((b) => ({
        sign: junctionSign(b, junctionId),
        fn: flowFromBondToElement(b, junctionId),
      }));
      return (x) => {
        let sum = 0;
        for (const c of computers) sum += c.sign * c.fn(x);
        return -signB * sum;
      };
    }
    if (sourceEl.kind === 'OneJunction') {
      // 1-junction: common flow
      const bonds1 = bondsOfElement(doc, sourceElId).filter((b) => b.id !== bond.id);
      const provider = bonds1.find((b) => {
        const o = orient.get(b.id);
        if (!o) return false;
        const jIsFrom = b.fromElementId === sourceElId;
        const junctionProvidesEffort = jIsFrom ? o.fromProvidesEffort : !o.fromProvidesEffort;
        return junctionProvidesEffort;
      });
      if (!provider) {
        throw new DeriveError(`1-junction ${sourceElId} に flow provider が見つかりません`);
      }
      return flowFromBondToElement(provider, sourceElId);
    }
    throw new DeriveError(`未対応の element kind for flow: ${sourceEl.kind}`);
  }

  // 6. 各 state に対して DX[i] のコンピュータを構築
  const dxComputers: Computer[] = [];
  for (const s of stateElements) {
    const bonds = bondsOfElement(doc, s.id);
    if (bonds.length !== 1) {
      throw new DeriveError(`${s.label ?? s.id}: state element は1つのbondを持つ必要があります (現在 ${bonds.length})`);
    }
    const b = bonds[0]!;
    if (s.kind === 'I') {
      // dp/dt = effort on bond (流入)
      dxComputers.push(effortFromBondToElement(b, s.id));
    } else {
      // dq/dt = flow on bond
      dxComputers.push(flowFromBondToElement(b, s.id));
    }
  }

  // 7. FUNC 関数を構築
  const func: DerivFn = (_t, xProbe, dx, _xGlobal) => {
    for (let i = 0; i < stateElements.length; i++) {
      dx[i] = dxComputers[i]!(xProbe);
    }
  };

  // 8. DOUT: 出力変数を計算
  const outputLabels: string[] = doc.outputs.map((o) => o.label);
  const outputComputers: Computer[] = [];
  for (const out of doc.outputs) {
    const bond = doc.bonds.find((b) => b.id === out.bondId);
    if (!bond) throw new DeriveError(`output bond not found: ${out.bondId}`);
    // varName が "Displacement" → 積分量、etc. 簡易には bond の state index に対応する x[i]
    // しかし bond は 2 要素間なので、どちらの state に対応するか判断が必要
    // 単純化: from か to のいずれかが state なら、その x[i] を返す
    const fromState = stateIndexOf.get(bond.fromElementId);
    const toState = stateIndexOf.get(bond.toElementId);
    const idx = fromState ?? toState;
    if (idx === undefined) {
      throw new DeriveError(`output bond ${out.bondId} に state element が接続されてません`);
    }
    outputComputers.push((x) => x[idx]!);
  }

  const dout: DoutFn = (x, op) => {
    for (let i = 0; i < outputComputers.length; i++) {
      op[i] = outputComputers[i]!(x);
    }
  };

  // 9. 合成 ParFile
  const paMap = new Map<number, number>();
  paArray.forEach((v, i) => {
    if (i > 0) paMap.set(i, v);
  });
  const par: ParFile = {
    pa: paMap,
    paNames: new Map(),
    stateInit: new Map(),
    labels: new Map(outputLabels.map((l, i) => [i + 1, l])),
    stateSymbols: new Map(),
    NS: stateElements.length,
    ING: 0,
    ND: 0,
    NOT: doc.simulation.numOutputSteps,
    NOUT: outputLabels.length,
    T0: doc.simulation.t0,
    T1: doc.simulation.t1,
    TI: doc.simulation.dt,
  };

  return {
    func,
    dout,
    par,
    stateLabels: stateElements.map((e) => e.label ?? e.id),
    outputLabels,
    trace,
  };
}

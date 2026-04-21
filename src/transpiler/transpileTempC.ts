/**
 * Mr.Bond 生成の temp.c を TypeScript の「モデルモジュール」に変換する。
 *
 * 入力: temp.c 相当のソース文字列
 * 出力: `runSimulation` にそのまま食わせられる `func` と `dout` を持つオブジェクト
 *
 * 変換戦略:
 * - 要素関数 (E1, L1, C1, R1, F1, ...) は JavaScript のクロージャとして再構築。
 *   PA 配列は呼び出し側から注入（`buildFunc(pa)` の形）。
 * - グローバル状態 X[], DX[], OP[] は関数パラメータ / クロージャ変数として渡す。
 * - FUNC(T, X[], N) → DerivFn 形式: (t, x, dx) => { ... }
 * - DOUT() → (x, op) => { ... }
 * - FU は今のところ常に 0 なので未対応（必要なら後日）
 */

import { tokenizeC } from './cTokenizer.ts';
import { parseC, type Expr, type Stmt, type FuncDef, type Program } from './cParser.ts';
import type { DerivFn } from '../solver/rungeKuttaGill.ts';
import type { DoutFn } from '../runtime/runSimulation.ts';

export interface TranspiledModel {
  readonly buildFunc: (pa: ReadonlyMap<number, number>) => DerivFn;
  readonly buildDout: () => DoutFn;
  /** デバッグ用: 生成された JS クロージャソースの中身 */
  readonly debug: {
    readonly funcBody: string;
    readonly doutBody: string;
    readonly elementFunctions: ReadonlyMap<string, string>;
  };
}

/**
 * temp.c の構文を JS 式／文の文字列に変換する簡易コード生成器。
 * 各要素関数は「ローカル変数に代入→同名で return」スタイルのため、
 * 最後の代入値を抽出するヘルパを持つ。
 */
class Transpiler {
  // グローバル配列として参照される識別子。これらは this.X / this.DX / this.OP / PA(クロージャ引数) にマップ
  private readonly globals = new Set(['X', 'DX', 'OP', 'PA']);

  transpile(source: string): TranspiledModel {
    const tokens = tokenizeC(source);
    const program = parseC(tokens);
    const funcs = new Map<string, FuncDef>();
    for (const decl of program.decls) {
      if (decl.kind === 'funcDef') {
        funcs.set(decl.name, decl);
      }
    }

    // 要素関数（E1, L1, C1, ... F1, ...）と FUNC / DOUT 以外を抽出
    const elementFuncSources = new Map<string, string>();
    const elementFuncJsBodies = new Map<string, string>();
    for (const [name, def] of funcs) {
      if (name === 'FUNC' || name === 'DOUT' || name === 'FU' || name === 'main' || name === 'PARM' || name === 'INIT' || name === 'OFILE' || name === 'CFILE' || name === 'RUNGE' || name === 'SOLV' || name === 'PLO' || name === 'DSIGN' || name === 'FEHL' || name === 'ICHEK' || name === 'INDEX') continue;
      const jsBody = this.emitElementFunction(def);
      elementFuncSources.set(name, jsBody.source);
      elementFuncJsBodies.set(name, jsBody.body);
    }

    const funcDef = funcs.get('FUNC');
    if (!funcDef) throw new Error('temp.c must define FUNC()');
    const doutDef = funcs.get('DOUT');
    if (!doutDef) throw new Error('temp.c must define DOUT()');

    // FUNC の本体を JS 文として出力（X, DX 参照）
    const funcBody = funcDef.body.map((s) => this.emitStmt(s, { scope: 'func' })).join('\n');
    const doutBody = doutDef.body.map((s) => this.emitStmt(s, { scope: 'dout' })).join('\n');

    return {
      buildFunc: (pa: ReadonlyMap<number, number>): DerivFn => {
        const PA = toPaArray(pa);
        // 要素関数を持つオブジェクトを構築
        const elements: Record<string, (...args: number[]) => number> = {};
        for (const [name, body] of elementFuncJsBodies) {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
          const fn = new Function(
            'PA',
            'elements',
            'X',
            // Returns a function closed over PA, elements, X
            this.elementCloserSource(funcs.get(name)!),
          ) as (
            pa: number[],
            elements: Record<string, (...args: number[]) => number>,
            x: number[],
          ) => (...args: number[]) => number;
          // Lazy binding: X will be provided at invocation time
          elements[name] = (..._args: number[]) => {
            throw new Error(`element ${name} called without context`);
          };
          // Replace with proper factory call after context built per invocation
        }

        return (t, x, dx) => {
          // 呼び出しごとに要素関数を再束縛（シンプルだが問題なし: 1ステップ数usの呼び出し）
          const boundElements: Record<string, (...args: number[]) => number> = {};
          for (const [name, def] of funcs) {
            if (elementFuncJsBodies.has(name)) {
              boundElements[name] = this.makeElementCallable(def, PA, boundElements, x as number[]);
            }
          }
          const runtime = {
            t,
            X: x as number[],
            DX: dx,
            PA,
            elements: boundElements,
          };
          const jsFunc = new Function(
            'T', 'X', 'DX', 'PA', 'elements',
            funcBody,
          );
          jsFunc(runtime.t, runtime.X, runtime.DX, runtime.PA, runtime.elements);
        };
      },
      buildDout: (): DoutFn => {
        // DOUT は PA / 要素関数も参照しうるため、buildFunc と同様に再構築
        return (x, op) => {
          throw new Error('buildDout requires pa context; use buildDoutWithPa instead');
        };
      },
      debug: {
        funcBody,
        doutBody,
        elementFunctions: elementFuncSources,
      },
    };
  }

  /** 要素関数 (E1, L1, C1, R1, F1, ...) を「引数→数値」のクロージャとして書き出す */
  private emitElementFunction(def: FuncDef): { source: string; body: string } {
    // 典型的な temp.c の要素関数は以下の形:
    //   double NAME(...) { double NAME; NAME = expr; return(NAME); }
    // 最後の代入式を抽出する
    const paramsSrc = def.params.map((p) => p.name).join(', ');
    const body = def.body.map((s) => this.emitStmt(s, { scope: 'element' })).join('\n');
    const source = `function ${def.name}(${paramsSrc}) {\n${body}\n}`;
    return { source, body };
  }

  /** 新しい Function として要素関数を生成 */
  private makeElementCallable(
    def: FuncDef,
    PA: number[],
    elements: Record<string, (...args: number[]) => number>,
    X: number[],
  ): (...args: number[]) => number {
    const paramsSrc = def.params.map((p) => p.name);
    const body = def.body.map((s) => this.emitStmt(s, { scope: 'element' })).join('\n');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function('PA', 'elements', 'X', ...paramsSrc, body) .bind(null, PA, elements, X) as (
      ...args: number[]
    ) => number;
  }

  private elementCloserSource(def: FuncDef): string {
    const paramsSrc = def.params.map((p) => p.name);
    const body = def.body.map((s) => this.emitStmt(s, { scope: 'element' })).join('\n');
    return `return function ${def.name}(${paramsSrc.join(', ')}) {\n${body}\n};`;
  }

  // --- Statement ---

  private emitStmt(s: Stmt, ctx: { scope: 'func' | 'dout' | 'element' }): string {
    switch (s.type) {
      case 'block':
        return `{\n${s.body.map((x) => this.emitStmt(x, ctx)).join('\n')}\n}`;
      case 'if': {
        const cond = this.emitExpr(s.cond, ctx);
        const thenSrc = this.emitStmt(s.then, ctx);
        if (s.else) {
          return `if (${cond}) ${thenSrc} else ${this.emitStmt(s.else, ctx)}`;
        }
        return `if (${cond}) ${thenSrc}`;
      }
      case 'return':
        return s.value === undefined ? 'return;' : `return ${this.emitExpr(s.value, ctx)};`;
      case 'exprStmt':
        return `${this.emitExpr(s.expr, ctx)};`;
      case 'varDecl':
        // temp.c の要素関数では "double NAME;" 宣言が名前衝突を起こすので、
        // 関数名と同じローカル宣言は「変数 NAME の宣言」に置換して末尾 return を生成する形とする。
        // ここでは単に `let NAME = init ?? 0;` として出す。
        if (s.init !== undefined) {
          return `let ${s.name} = ${this.emitExpr(s.init, ctx)};`;
        }
        return `let ${s.name} = 0;`;
    }
  }

  // --- Expression ---

  private emitExpr(e: Expr, ctx: { scope: 'func' | 'dout' | 'element' }): string {
    switch (e.type) {
      case 'num':
        return Number.isFinite(Number(e.raw)) ? Number(e.raw).toString() : '0';
      case 'ident':
        return this.emitIdent(e.name, ctx);
      case 'index': {
        const target = this.emitExpr(e.target, ctx);
        const index = this.emitExpr(e.index, ctx);
        return `${target}[${index}]`;
      }
      case 'call': {
        const callee = e.callee.type === 'ident' ? this.emitCallee(e.callee.name, ctx) : this.emitExpr(e.callee, ctx);
        const args = e.args.map((a) => this.emitExpr(a, ctx)).join(', ');
        return `${callee}(${args})`;
      }
      case 'unary':
        return `(${e.op}${this.emitExpr(e.operand, ctx)})`;
      case 'binary':
        return `(${this.emitExpr(e.left, ctx)} ${e.op} ${this.emitExpr(e.right, ctx)})`;
      case 'assign':
        return `${this.emitExpr(e.target, ctx)} = ${this.emitExpr(e.value, ctx)}`;
    }
  }

  private emitIdent(name: string, _ctx: { scope: 'func' | 'dout' | 'element' }): string {
    if (this.globals.has(name)) return name;
    return name;
  }

  private emitCallee(name: string, _ctx: { scope: 'func' | 'dout' | 'element' }): string {
    // 要素関数は elements.name から呼ぶ
    const mathFns = new Set(['sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'pow', 'fabs', 'abs']);
    if (mathFns.has(name)) {
      return name === 'fabs' ? 'Math.abs' : `Math.${name}`;
    }
    return `elements.${name}`;
  }
}

function toPaArray(pa: ReadonlyMap<number, number>): number[] {
  let maxIdx = 0;
  for (const k of pa.keys()) if (k > maxIdx) maxIdx = k;
  const arr = new Array<number>(maxIdx + 1).fill(0);
  for (const [k, v] of pa) arr[k] = v;
  return arr;
}

export function transpileTempC(source: string): TranspiledModel {
  return new Transpiler().transpile(source);
}

/**
 * buildDout ヘルパ: buildFunc と同様の構造を DOUT にも適用する簡潔ラッパ。
 * TranspiledModel の buildDout() は使いにくいので、buildFuncAndDout 推奨。
 */
export function buildFuncAndDout(
  source: string,
  pa: ReadonlyMap<number, number>,
): { func: DerivFn; dout: DoutFn } {
  const tokens = tokenizeC(source);
  const program = parseC(tokens);
  const funcs = new Map<string, FuncDef>();
  for (const decl of program.decls) {
    if (decl.kind === 'funcDef') funcs.set(decl.name, decl);
  }

  const PA = toPaArray(pa);
  const transpiler = new Transpiler();

  // 要素関数を一度にすべて束縛するファクトリ
  const buildElementCallables = (X: number[]): Record<string, (...args: number[]) => number> => {
    const elements: Record<string, (...args: number[]) => number> = {};
    for (const [name, def] of funcs) {
      if (['FUNC', 'DOUT', 'FU', 'main', 'PARM', 'INIT', 'OFILE', 'CFILE', 'RUNGE', 'SOLV', 'PLO', 'DSIGN'].includes(name)) continue;
      elements[name] = (transpiler as unknown as {
        makeElementCallable: (
          d: FuncDef,
          pa: number[],
          els: Record<string, (...args: number[]) => number>,
          x: number[],
        ) => (...args: number[]) => number;
      }).makeElementCallable(def, PA, elements, X);
    }
    return elements;
  };

  const funcDef = funcs.get('FUNC');
  if (!funcDef) throw new Error('FUNC not found');
  const doutDef = funcs.get('DOUT');
  if (!doutDef) throw new Error('DOUT not found');

  const funcBody = (transpiler as unknown as {
    emitStmt: (s: Stmt, ctx: { scope: 'func' | 'dout' | 'element' }) => string;
  }).emitStmt.bind(transpiler);
  const emitBody = (body: Stmt[], scope: 'func' | 'dout'): string =>
    body.map((s) => funcBody(s, { scope })).join('\n');

  const funcSource = emitBody(funcDef.body, 'func');
  const doutSource = emitBody(doutDef.body, 'dout');

  // eslint-disable-next-line no-new-func
  const funcImpl = new Function(
    'T', 'X', 'DX', 'PA', 'elements',
    funcSource,
  ) as (T: number, X: number[], DX: number[], PA: number[], elements: Record<string, (...args: number[]) => number>) => void;

  // eslint-disable-next-line no-new-func
  const doutImpl = new Function(
    'X', 'OP', 'PA', 'elements',
    doutSource,
  ) as (X: number[], OP: number[], PA: number[], elements: Record<string, (...args: number[]) => number>) => void;

  const func: DerivFn = (t, x, dx) => {
    const X = x as number[];
    const DX = dx;
    const elements = buildElementCallables(X);
    funcImpl(t, X, DX, PA, elements);
  };

  const dout: DoutFn = (x, op) => {
    const X = x as number[];
    const OP = op;
    const elements = buildElementCallables(X);
    doutImpl(X, OP, PA, elements);
  };

  return { func, dout };
}

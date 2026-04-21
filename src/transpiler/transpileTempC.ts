/**
 * Mr.Bond 生成の temp.c を TypeScript の「モデルモジュール」に変換する。
 *
 * 入力: temp.c 相当のソース文字列
 * 出力: `runSimulation` にそのまま食わせられる `func` と `dout`
 *
 * 方針:
 * - **ビルド時に一度だけ**、要素関数と FUNC/DOUT を含むひとつのJS関数にまとめて
 *   `new Function()` でコンパイルする。以降の呼び出しは通常の関数呼び出しのみ。
 * - PA は呼び出し側から注入（クロージャとしてキャプチャ）。
 * - 要素関数は FUNC/DOUT 内部からローカル関数として見えるようスコープを構成。
 *
 * Mr.Bond 生成コードで扱える文法範囲:
 * - double/void/int 関数、配列アクセス、四則演算、比較、論理、if/else、return
 * - 数学関数: sin, cos, exp, log, sqrt, pow, fabs など (Math.* にマップ)
 */

import { tokenizeC } from './cTokenizer.ts';
import { parseC, type Expr, type Stmt, type FuncDef } from './cParser.ts';
import type { DerivFn } from '../solver/rungeKuttaGill.ts';
import type { DoutFn } from '../runtime/runSimulation.ts';

/** ソルバ本体が提供する関数名（temp.c に存在しうるので要素関数扱いから除外） */
const RESERVED_NAMES = new Set([
  'FUNC', 'DOUT', 'FU', 'main', 'PARM', 'INIT', 'OFILE', 'CFILE', 'RUNGE', 'SOLV', 'PLO',
  'DSIGN', 'FEHL', 'ICHEK', 'INDEX',
]);

const MATH_FUNCS = new Map<string, string>([
  ['sin', 'Math.sin'], ['cos', 'Math.cos'], ['tan', 'Math.tan'],
  ['asin', 'Math.asin'], ['acos', 'Math.acos'], ['atan', 'Math.atan'], ['atan2', 'Math.atan2'],
  ['exp', 'Math.exp'], ['log', 'Math.log'], ['log10', 'Math.log10'],
  ['sqrt', 'Math.sqrt'], ['pow', 'Math.pow'],
  ['fabs', 'Math.abs'], ['abs', 'Math.abs'],
  ['floor', 'Math.floor'], ['ceil', 'Math.ceil'],
]);

/** 代入ターゲットになりうる「関数と同名のローカル変数」を書き換えるため、関数本体の戻り値パターンを解析 */
interface EmittedFunction {
  /** 引数名のリスト */
  readonly params: string[];
  /** 関数本体のJS文字列（return を含む） */
  readonly bodyJs: string;
}

/** temp.c のグローバル名前空間に存在する「配列参照」の名前（コード生成では素通り） */
const GLOBAL_ARRAYS = new Set(['X', 'DX', 'OP', 'PA']);

class Transpiler {
  /** 式を JS 文字列に変換。要素関数呼び出しは直接関数名として出す（スコープで解決） */
  emitExpr(e: Expr, fnNameInScope?: string): string {
    switch (e.type) {
      case 'num': {
        const n = Number(e.raw);
        return Number.isFinite(n) ? String(n) : '0';
      }
      case 'ident':
        return e.name;
      case 'index':
        return `${this.emitExpr(e.target, fnNameInScope)}[${this.emitExpr(e.index, fnNameInScope)}]`;
      case 'call': {
        const callee = e.callee.type === 'ident'
          ? (MATH_FUNCS.get(e.callee.name) ?? e.callee.name)
          : this.emitExpr(e.callee, fnNameInScope);
        const args = e.args.map((a) => this.emitExpr(a, fnNameInScope)).join(', ');
        return `${callee}(${args})`;
      }
      case 'unary':
        return `(${e.op}${this.emitExpr(e.operand, fnNameInScope)})`;
      case 'binary':
        return `(${this.emitExpr(e.left, fnNameInScope)} ${e.op} ${this.emitExpr(e.right, fnNameInScope)})`;
      case 'assign':
        return `${this.emitExpr(e.target, fnNameInScope)} = ${this.emitExpr(e.value, fnNameInScope)}`;
    }
  }

  emitStmt(s: Stmt, fnNameInScope?: string): string {
    switch (s.type) {
      case 'block':
        return `{\n${s.body.map((x) => this.emitStmt(x, fnNameInScope)).join('\n')}\n}`;
      case 'if': {
        const cond = this.emitExpr(s.cond, fnNameInScope);
        const thenSrc = this.emitStmt(s.then, fnNameInScope);
        if (s.else) return `if (${cond}) ${thenSrc} else ${this.emitStmt(s.else, fnNameInScope)}`;
        return `if (${cond}) ${thenSrc}`;
      }
      case 'return':
        return s.value === undefined ? 'return;' : `return ${this.emitExpr(s.value, fnNameInScope)};`;
      case 'exprStmt':
        return `${this.emitExpr(s.expr, fnNameInScope)};`;
      case 'varDecl':
        // C 慣習: double NAME; NAME=expr; return(NAME); で戻り値を受けることが多い。
        // この変数が関数名と同じなら、`let NAME` を作って最後に return NAME; する。
        // JS では関数名も変数名もトップレベルの束縛なので、let NAME とすれば素通り可能。
        if (s.init !== undefined) return `let ${s.name} = ${this.emitExpr(s.init, fnNameInScope)};`;
        return `let ${s.name} = 0;`;
    }
  }

  /** 要素関数を JS 関数宣言として出力する */
  emitElementFunction(def: FuncDef): EmittedFunction {
    const params = def.params.map((p) => p.name);
    // 本体に「同名の let 宣言 + 代入」があっても問題ない。最後に return NAME; を自動付与する必要があるか判定。
    const hasExplicitReturn = def.body.some(
      (s) => s.type === 'return' || (s.type === 'block' && this.blockHasReturn(s.body)),
    );
    const bodyStmts = def.body.map((s) => this.emitStmt(s, def.name)).join('\n');
    let bodyJs = bodyStmts;
    if (!hasExplicitReturn) {
      bodyJs = `${bodyStmts}\nreturn ${def.name};`;
    }
    return { params, bodyJs };
  }

  private blockHasReturn(stmts: Stmt[]): boolean {
    return stmts.some((s) => {
      if (s.type === 'return') return true;
      if (s.type === 'block') return this.blockHasReturn(s.body);
      if (s.type === 'if') {
        const thenHas = s.then.type === 'return' || (s.then.type === 'block' && this.blockHasReturn(s.then.body));
        const elseHas = s.else
          ? (s.else.type === 'return' || (s.else.type === 'block' && this.blockHasReturn(s.else.body)))
          : false;
        return thenHas && elseHas;
      }
      return false;
    });
  }
}

/** PA マップを 1-indexed 配列（index 0 は未使用）に変換 */
function toPaArray(pa: ReadonlyMap<number, number>): number[] {
  let maxIdx = 0;
  for (const k of pa.keys()) if (k > maxIdx) maxIdx = k;
  const arr = new Array<number>(maxIdx + 1).fill(0);
  for (const [k, v] of pa) arr[k] = v;
  return arr;
}

/** メインエントリポイント: temp.c ソースから DerivFn/DoutFn を構築 */
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

  const transpiler = new Transpiler();

  // 要素関数の JS 宣言を集める
  const elementDecls: string[] = [];
  for (const [name, def] of funcs) {
    if (RESERVED_NAMES.has(name)) continue;
    const { params, bodyJs } = transpiler.emitElementFunction(def);
    elementDecls.push(`function ${name}(${params.join(', ')}) {\n${bodyJs}\n}`);
  }

  const funcDef = funcs.get('FUNC');
  if (!funcDef) throw new Error('FUNC not found in temp.c');
  const doutDef = funcs.get('DOUT');
  if (!doutDef) throw new Error('DOUT not found in temp.c');

  const funcBodyJs = funcDef.body.map((s) => transpiler.emitStmt(s)).join('\n');
  const doutBodyJs = doutDef.body.map((s) => transpiler.emitStmt(s)).join('\n');

  // すべてを内包する1つの JS ソースを構築。PA/X/DX/OP/T はクロージャ or 引数。
  // - PA: クロージャキャプチャ（buildFuncAndDout の引数から）
  // - FUNC の引数: (T, X, DX, N)
  // - DOUT の引数: (X, OP)
  const funcSource = [
    ...elementDecls,
    `function __FUNC__(T, X, DX, N) {\n${funcBodyJs}\n}`,
    `return __FUNC__;`,
  ].join('\n');

  const doutSource = [
    ...elementDecls,
    `function __DOUT__(X, OP) {\n${doutBodyJs}\n}`,
    `return __DOUT__;`,
  ].join('\n');

  const PA = toPaArray(pa);

  // 'PA' を引数として受け、そのクロージャで閉じた __FUNC__/__DOUT__ を返すファクトリを作る
  // eslint-disable-next-line no-new-func
  const funcFactory = new Function('PA', funcSource) as (pa: number[]) => (T: number, X: number[], DX: number[], N: number) => void;
  // eslint-disable-next-line no-new-func
  const doutFactory = new Function('PA', doutSource) as (pa: number[]) => (X: number[], OP: number[]) => void;

  const compiledFunc = funcFactory(PA);
  const compiledDout = doutFactory(PA);

  const func: DerivFn = (t, x, dx) => {
    compiledFunc(t, x as number[], dx, x.length);
  };

  const dout: DoutFn = (x, op) => {
    compiledDout(x as number[], op);
  };

  return { func, dout };
}

/** デバッグ用: コンパイルしたJSソースを文字列として取得 */
export function debugTranspile(source: string): { funcSource: string; doutSource: string } {
  const tokens = tokenizeC(source);
  const program = parseC(tokens);
  const funcs = new Map<string, FuncDef>();
  for (const decl of program.decls) {
    if (decl.kind === 'funcDef') funcs.set(decl.name, decl);
  }

  const transpiler = new Transpiler();
  const elementDecls: string[] = [];
  for (const [name, def] of funcs) {
    if (RESERVED_NAMES.has(name)) continue;
    const { params, bodyJs } = transpiler.emitElementFunction(def);
    elementDecls.push(`function ${name}(${params.join(', ')}) {\n${bodyJs}\n}`);
  }

  const funcDef = funcs.get('FUNC')!;
  const doutDef = funcs.get('DOUT')!;
  const funcBodyJs = funcDef.body.map((s) => transpiler.emitStmt(s)).join('\n');
  const doutBodyJs = doutDef.body.map((s) => transpiler.emitStmt(s)).join('\n');

  return {
    funcSource: `${elementDecls.join('\n\n')}\n\nfunction FUNC(T, X, DX, N) {\n${funcBodyJs}\n}`,
    doutSource: `${elementDecls.join('\n\n')}\n\nfunction DOUT(X, OP) {\n${doutBodyJs}\n}`,
  };
}

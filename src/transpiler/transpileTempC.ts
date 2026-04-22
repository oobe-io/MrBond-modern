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
  // ユーザー宣言のグローバル変数（POS, Xfd, sfd2 など）。
  // Mr.Bond が temp.c の FUNC/DOUT/要素関数間で共有される中間変数として出力する。
  // temp.c が既定で宣言する X, DX, OP, PA, T, H, DSIGN, FU 等の「インフラ変数」は除外。
  const globalVars: string[] = [];
  const INFRA_GLOBALS = new Set(['X', 'DX', 'OP', 'PA', 'T', 'H']);
  for (const decl of program.decls) {
    if (decl.kind === 'funcDef') {
      funcs.set(decl.name, decl);
    } else if (decl.kind === 'varDecl' && !decl.isArray) {
      if (!INFRA_GLOBALS.has(decl.name)) {
        globalVars.push(decl.name);
      }
    }
  }

  const transpiler = new Transpiler();

  // グローバル変数の宣言（関数群の直前、クロージャスコープ内に置く）
  const globalDecls: string[] = globalVars.map((v) => `let ${v} = 0;`);

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
  // FUNC と DOUT で「同じ要素関数・同じグローバル変数・同じ X/DX/OP」を共有する必要がある。
  // 例: FUNC 内で R2(J, Z) が X[6] を参照、E2() 内で POS/Xfd/sfd* の値を書き換え、
  //     次の DOUT 呼び出しでその副作用が見える必要がある。
  // そのため **FUNC と DOUT は同一クロージャ内で構築** し、共有 let 変数を介して連携する。
  // Mr.Bond のC生成コードは以下のセマンティクスを持つ:
  //   - FUNC 内の `X[i]` 直接参照は**関数パラメータ X**（RK 試算点）を指す
  //   - 要素関数内の `X[i]` 参照は**グローバル X**（積分対象の状態）を指す
  //   - 一部の要素関数（valve 型のクランプ）はグローバル X を書き換え、
  //     その副作用は同じ RK ステップの後続ステージに伝播する
  // これを再現するため、クロージャ `X` をグローバル状態として保持し、
  // FUNC 本体では同名の LOCAL const `X` を試算点パラメータから束縛してシャドウする。
  const combinedSource = [
    // クロージャ共有のステート（X = グローバル状態、要素関数はこちらを参照）
    'let X = null, DX = null, OP = null, T = 0;',
    // ユーザー定義のグローバル変数（要素間で状態共有される中間量）
    ...globalDecls,
    // 要素関数群（X/PA/グローバル変数をクロージャ経由で参照）
    ...elementDecls,
    // FUNC: state → derivs
    //   xGlobal が与えられればクロージャ X はそれ、そうでなければ probe と同じ
    //   FUNC 本体は IIFE で probe を local X として受ける（要素関数からの参照はクロージャに抜ける）
    `function __FUNC__(t_, x_probe, dx_, n_, x_global) {`,
    `  T = t_;`,
    `  X = x_global !== undefined ? x_global : x_probe;`,
    `  DX = dx_;`,
    `  (function (X) {`,
    funcBodyJs,
    `  })(x_probe);`,
    `}`,
    // DOUT: 呼び出し時点のグローバル状態を X に設定（要素関数も同じ X を参照）
    `function __DOUT__(x_, op_) {`,
    `  X = x_; OP = op_;`,
    doutBodyJs,
    `}`,
    // 両方を返す
    `return { __FUNC__, __DOUT__ };`,
  ].join('\n');

  const PA = toPaArray(pa);

  // 'PA' を引数として受け、クロージャ内の __FUNC__/__DOUT__ を返すファクトリを作る
  // eslint-disable-next-line no-new-func
  const combinedFactory = new Function('PA', combinedSource) as (
    pa: number[],
  ) => {
    __FUNC__: (t: number, x: number[], dx: number[], n: number) => void;
    __DOUT__: (x: number[], op: number[]) => void;
  };

  const compiled = combinedFactory(PA);

  const func: DerivFn = (t, xProbe, dx, xGlobal) => {
    // xGlobal が与えられなかった場合（通常呼び出し）は probe 自身を global 扱い
    const globalState = xGlobal ?? (xProbe as number[]);
    compiled.__FUNC__(t, xProbe as number[], dx, xProbe.length, globalState);
  };

  const dout: DoutFn = (x, op) => {
    compiled.__DOUT__(x as number[], op);
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

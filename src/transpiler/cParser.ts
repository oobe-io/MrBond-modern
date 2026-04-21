/**
 * Mr.Bond temp.c 用の最小限の C → AST パーサ。
 *
 * 文法（実装範囲）:
 *   program    := topDecl*
 *   topDecl    := funcDecl | funcDef | varDecl
 *   funcDecl   := type IDENT '(' params ')' ';'
 *   funcDef    := type IDENT '(' params ')' '{' stmts '}'
 *   varDecl    := type varNameList ';'   // e.g. "double OP[100];"
 *   params     := (param (',' param)*)?
 *   param      := type IDENT ('[' ']')?
 *
 *   stmt       := block | ifStmt | returnStmt | exprStmt | varDecl
 *   block      := '{' stmts '}'
 *   ifStmt     := 'if' '(' expr ')' stmt ('else' stmt)?
 *   returnStmt := 'return' '(' expr? ')' ';'
 *              | 'return' expr? ';'
 *   exprStmt   := expr ';'
 *
 *   expr       := assignExpr
 *   assignExpr := orExpr ('=' assignExpr)?
 *   orExpr     := andExpr ('||' andExpr)*
 *   andExpr    := cmpExpr ('&&' cmpExpr)*
 *   cmpExpr    := addExpr (('==' | '!=' | '<' | '<=' | '>' | '>=') addExpr)*
 *   addExpr    := mulExpr (('+' | '-') mulExpr)*
 *   mulExpr    := unary (('*' | '/') unary)*
 *   unary      := ('+' | '-' | '!')? postfix
 *   postfix    := primary ('(' args ')' | '[' expr ']')*
 *   primary    := number | IDENT | '(' expr ')'
 */

import type { Token } from './cTokenizer.ts';

// --- AST 型定義 ---

export type Expr =
  | { type: 'num'; value: number; raw: string }
  | { type: 'ident'; name: string }
  | { type: 'index'; target: Expr; index: Expr }
  | { type: 'call'; callee: Expr; args: Expr[] }
  | { type: 'unary'; op: '+' | '-' | '!'; operand: Expr }
  | { type: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { type: 'assign'; target: Expr; value: Expr };

export type BinaryOp =
  | '+' | '-' | '*' | '/'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '&&' | '||';

export type Stmt =
  | { type: 'block'; body: Stmt[] }
  | { type: 'if'; cond: Expr; then: Stmt; else?: Stmt }
  | { type: 'return'; value?: Expr }
  | { type: 'exprStmt'; expr: Expr }
  | { type: 'varDecl'; cType: string; name: string; isArray: boolean; init?: Expr };

export interface Param {
  readonly cType: string;
  readonly name: string;
  readonly isArray: boolean;
}

export interface FuncDef {
  readonly kind: 'funcDef';
  readonly returnType: string;
  readonly name: string;
  readonly params: Param[];
  readonly body: Stmt[];
}

export interface FuncDecl {
  readonly kind: 'funcDecl';
  readonly returnType: string;
  readonly name: string;
  readonly params: Param[];
}

export interface GlobalVarDecl {
  readonly kind: 'varDecl';
  readonly cType: string;
  readonly name: string;
  readonly isArray: boolean;
}

export type TopDecl = FuncDef | FuncDecl | GlobalVarDecl;

export interface Program {
  readonly decls: TopDecl[];
}

// --- パーサ実装 ---

export class CParseError extends Error {
  readonly token: Token;
  constructor(message: string, token: Token) {
    super(`${message} (line ${token.line}, token '${token.text}')`);
    this.name = 'CParseError';
    this.token = token;
  }
}

class Parser {
  private cursor = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[this.cursor + offset] ?? this.tokens[this.tokens.length - 1]!;
  }
  private take(): Token {
    const t = this.tokens[this.cursor];
    if (!t) throw new Error('unexpected EOF');
    this.cursor++;
    return t;
  }
  private expect(text: string): Token {
    const t = this.take();
    if (t.text !== text) throw new CParseError(`expected '${text}'`, t);
    return t;
  }
  private match(text: string): boolean {
    if (this.peek().text === text) {
      this.cursor++;
      return true;
    }
    return false;
  }

  parseProgram(): Program {
    const decls: TopDecl[] = [];
    while (this.peek().kind !== 'eof') {
      decls.push(this.parseTopDecl());
    }
    return { decls };
  }

  private parseTopDecl(): TopDecl {
    const returnType = this.parseType();
    const name = this.take();
    if (name.kind !== 'ident') throw new CParseError('expected identifier', name);

    if (this.peek().text === '(') {
      // 関数宣言 or 定義
      this.expect('(');
      const params = this.parseParams();
      this.expect(')');
      if (this.match(';')) {
        return { kind: 'funcDecl', returnType, name: name.text, params };
      }
      this.expect('{');
      const body = this.parseStatements();
      this.expect('}');
      return { kind: 'funcDef', returnType, name: name.text, params, body };
    }

    // グローバル変数宣言: 例 `double OP[100];` or `double H,X[130],T;`
    // 最初の変数だけ返す。同一行の追加宣言は無視（将来必要になれば対応）
    let isArray = false;
    if (this.match('[')) {
      // 配列サイズ読み飛ばし
      while (!this.match(']')) this.take();
      isArray = true;
    }
    while (this.peek().text === ',') {
      this.take();
      // 次の識別子とその配列指定子を読み飛ばし
      this.take();
      if (this.match('[')) {
        while (!this.match(']')) this.take();
      }
    }
    this.expect(';');
    return { kind: 'varDecl', cType: returnType, name: name.text, isArray };
  }

  private parseType(): string {
    const t = this.take();
    if (t.kind !== 'keyword' && t.kind !== 'ident') {
      throw new CParseError('expected type', t);
    }
    return t.text;
  }

  private parseParams(): Param[] {
    const params: Param[] = [];
    if (this.peek().text === ')') return params;
    while (true) {
      const cType = this.parseType();
      const name = this.take();
      if (name.kind !== 'ident') throw new CParseError('expected param name', name);
      let isArray = false;
      if (this.match('[')) {
        // 任意のサイズ指定を読み飛ばす (C は 'double X[]' を許す)
        while (!this.match(']')) this.take();
        isArray = true;
      }
      params.push({ cType, name: name.text, isArray });
      if (!this.match(',')) break;
    }
    return params;
  }

  private parseStatements(): Stmt[] {
    const stmts: Stmt[] = [];
    while (this.peek().text !== '}' && this.peek().kind !== 'eof') {
      stmts.push(this.parseStatement());
    }
    return stmts;
  }

  private parseStatement(): Stmt {
    const t = this.peek();
    if (t.text === '{') {
      this.take();
      const body = this.parseStatements();
      this.expect('}');
      return { type: 'block', body };
    }
    if (t.kind === 'keyword' && t.text === 'if') {
      this.take();
      this.expect('(');
      const cond = this.parseExpr();
      this.expect(')');
      const thenStmt = this.parseStatement();
      let elseStmt: Stmt | undefined;
      if (this.match('else')) {
        elseStmt = this.parseStatement();
      }
      return elseStmt ? { type: 'if', cond, then: thenStmt, else: elseStmt } : { type: 'if', cond, then: thenStmt };
    }
    if (t.kind === 'keyword' && t.text === 'return') {
      this.take();
      // return; or return expr; or return(expr);
      if (this.match(';')) return { type: 'return' };
      const value = this.parseExpr();
      this.expect(';');
      return { type: 'return', value };
    }
    // ローカル変数宣言
    if (t.kind === 'keyword' && (t.text === 'double' || t.text === 'int' || t.text === 'FILE')) {
      const cType = this.parseType();
      // ポインタ '*' は読み飛ばし（FILE *fp のため）
      while (this.match('*')) {}
      const name = this.take();
      if (name.kind !== 'ident') throw new CParseError('expected variable name', name);
      let isArray = false;
      if (this.match('[')) {
        while (!this.match(']')) this.take();
        isArray = true;
      }
      let init: Expr | undefined;
      if (this.match('=')) {
        init = this.parseExpr();
      }
      // 同行追加宣言 (`,name2,...`) は読み飛ばし（最初のだけ保持）
      while (this.peek().text === ',') {
        this.take();
        this.take(); // name
        if (this.match('[')) {
          while (!this.match(']')) this.take();
        }
        if (this.match('=')) {
          this.parseExpr();
        }
      }
      this.expect(';');
      return init ? { type: 'varDecl', cType, name: name.text, isArray, init } : { type: 'varDecl', cType, name: name.text, isArray };
    }
    // 式文
    const expr = this.parseExpr();
    this.expect(';');
    return { type: 'exprStmt', expr };
  }

  // --- 式 ---

  private parseExpr(): Expr {
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    const left = this.parseOr();
    if (this.peek().text === '=') {
      this.take();
      const value = this.parseAssign();
      return { type: 'assign', target: left, value };
    }
    return left;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek().text === '||') {
      this.take();
      const right = this.parseAnd();
      left = { type: 'binary', op: '||', left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.peek().text === '&&') {
      this.take();
      const right = this.parseCmp();
      left = { type: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseCmp(): Expr {
    let left = this.parseAdd();
    const cmpOps = ['==', '!=', '<', '<=', '>', '>='];
    while (cmpOps.includes(this.peek().text)) {
      const op = this.take().text as BinaryOp;
      const right = this.parseAdd();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.peek().text === '+' || this.peek().text === '-') {
      const op = this.take().text as '+' | '-';
      const right = this.parseMul();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.peek().text === '*' || this.peek().text === '/') {
      const op = this.take().text as '*' | '/';
      const right = this.parseUnary();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().text === '+' || this.peek().text === '-' || this.peek().text === '!') {
      const op = this.take().text as '+' | '-' | '!';
      const operand = this.parseUnary();
      return { type: 'unary', op, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let node = this.parsePrimary();
    while (true) {
      if (this.peek().text === '(') {
        this.take();
        const args: Expr[] = [];
        if (this.peek().text !== ')') {
          args.push(this.parseExpr());
          while (this.match(',')) {
            args.push(this.parseExpr());
          }
        }
        this.expect(')');
        node = { type: 'call', callee: node, args };
      } else if (this.peek().text === '[') {
        this.take();
        const index = this.parseExpr();
        this.expect(']');
        node = { type: 'index', target: node, index };
      } else {
        break;
      }
    }
    return node;
  }

  private parsePrimary(): Expr {
    const t = this.take();
    if (t.kind === 'number') {
      return { type: 'num', value: Number(t.text), raw: t.text };
    }
    if (t.kind === 'ident') {
      return { type: 'ident', name: t.text };
    }
    if (t.text === '(') {
      const expr = this.parseExpr();
      this.expect(')');
      return expr;
    }
    throw new CParseError('expected expression', t);
  }
}

export function parseC(tokens: readonly Token[]): Program {
  return new Parser(tokens).parseProgram();
}

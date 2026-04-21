/**
 * Mr.Bond の temp.c に特化した、最小限の C 字句解析器。
 *
 * Mr.Bond 生成コードで実際に出現する文法要素だけをカバーする:
 *   - 型キーワード: double, void, int
 *   - 制御: if, else, return
 *   - 記号: ( ) { } [ ] , ; = == != < > <= >= + - * / !
 *   - 識別子 / 数値リテラル / 文字列リテラル（出現稀）
 *
 * 本格的な C パーサではない。preprocessor ディレクティブ (#include) は
 * 行ごと無視。コメントは扱わない（Mr.Bond 生成物には存在しない）。
 */

export type TokenKind =
  | 'keyword'
  | 'ident'
  | 'number'
  | 'string'
  | 'punct'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly pos: number;
  readonly line: number;
}

const KEYWORDS = new Set(['double', 'void', 'int', 'if', 'else', 'return', 'static', 'FILE']);

const PUNCT_TWO_CHAR = new Set(['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=']);
const PUNCT_ONE_CHAR = new Set([
  '(', ')', '{', '}', '[', ']', ',', ';', '=', '<', '>', '+', '-', '*', '/', '!', '&', '|', '?', ':',
]);

export function tokenizeC(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;

  const skipLineComment = (): void => {
    while (pos < source.length && source[pos] !== '\n') pos++;
  };

  const skipBlockComment = (): void => {
    pos += 2;
    while (pos + 1 < source.length && !(source[pos] === '*' && source[pos + 1] === '/')) {
      if (source[pos] === '\n') line++;
      pos++;
    }
    pos += 2;
  };

  const skipPreprocessor = (): void => {
    // #include など、行末まで
    while (pos < source.length && source[pos] !== '\n') pos++;
  };

  while (pos < source.length) {
    const ch = source[pos]!;

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pos++;
      continue;
    }
    if (ch === '\n') {
      line++;
      pos++;
      continue;
    }

    // コメント
    if (ch === '/' && source[pos + 1] === '/') {
      skipLineComment();
      continue;
    }
    if (ch === '/' && source[pos + 1] === '*') {
      skipBlockComment();
      continue;
    }

    // プリプロセッサ（行頭の # 判定は緩めに、空白スキップ後の # で判定）
    if (ch === '#') {
      skipPreprocessor();
      continue;
    }

    // 識別子 / キーワード
    if (/[A-Za-z_]/.test(ch)) {
      const start = pos;
      while (pos < source.length && /[A-Za-z0-9_]/.test(source[pos]!)) pos++;
      const text = source.slice(start, pos);
      tokens.push({
        kind: KEYWORDS.has(text) ? 'keyword' : 'ident',
        text,
        pos: start,
        line,
      });
      continue;
    }

    // 数値リテラル: 整数 or 浮動小数（指数含む）
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[pos + 1] ?? ''))) {
      const start = pos;
      // 整数部
      while (pos < source.length && /[0-9]/.test(source[pos]!)) pos++;
      // 小数部
      if (source[pos] === '.') {
        pos++;
        while (pos < source.length && /[0-9]/.test(source[pos]!)) pos++;
      }
      // 指数部
      if (source[pos] === 'e' || source[pos] === 'E') {
        pos++;
        if (source[pos] === '+' || source[pos] === '-') pos++;
        while (pos < source.length && /[0-9]/.test(source[pos]!)) pos++;
      }
      tokens.push({
        kind: 'number',
        text: source.slice(start, pos),
        pos: start,
        line,
      });
      continue;
    }

    // 文字列リテラル
    if (ch === '"') {
      const start = pos;
      pos++;
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') pos++;
        if (source[pos] === '\n') line++;
        pos++;
      }
      pos++; // 終端の "
      tokens.push({ kind: 'string', text: source.slice(start, pos), pos: start, line });
      continue;
    }

    // 2文字記号
    const two = source.slice(pos, pos + 2);
    if (PUNCT_TWO_CHAR.has(two)) {
      tokens.push({ kind: 'punct', text: two, pos, line });
      pos += 2;
      continue;
    }

    // 1文字記号
    if (PUNCT_ONE_CHAR.has(ch)) {
      tokens.push({ kind: 'punct', text: ch, pos, line });
      pos++;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at line ${line} (offset ${pos})`);
  }

  tokens.push({ kind: 'eof', text: '', pos: source.length, line });
  return tokens;
}

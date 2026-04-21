/**
 * BGE ファイル用の低レベルリーダ。
 *
 * 実ファイル解析で判明した重要事実:
 * - 型コード 2/3/4/5 は整数の「幅分類」にすぎない。文字列かどうかは
 *   型コードから判定できない。**文法（出現位置）に依存**する。
 * - 文字列は「長さ整数 + 1バイト区切り（空白）+ 指定バイト数の生データ」
 *   という形式で格納される。例: `2 3 EIN` = 長さ3、内容 "EIN"。
 *   `2 4 10.0` = 長さ4、内容 "10.0"（数値も文字列として保存される）。
 * - 整数 -1 は「未接続」などの意味で頻出し、符号付きで扱う必要あり。
 *
 * 設計方針:
 * - Reader は「現在位置」を持つステートフルなカーソル。
 * - `readAtom()` で次の `(code, value)` 対を消費。
 * - `readStringBytes(len)` で指定バイト数の Shift-JIS 文字列を消費。
 *   この呼び出しのタイミングは文法パーサが決める。
 * - 先頭の空白は自動スキップ、整数直後の1バイト区切り空白も自動消費。
 */

export type AtomCode = 2 | 3 | 4 | 5;

export interface Atom {
  readonly code: AtomCode;
  readonly value: number;
  /** このアトムがバッファのどのバイトから始まるか */
  readonly startPos: number;
}

const SP_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d]);

export class BgeReader {
  private readonly buf: Uint8Array;
  private readonly sjisDecoder = new TextDecoder('shift_jis', { fatal: false });
  private readonly asciiDecoder = new TextDecoder('ascii');
  private cursor = 0;

  constructor(buffer: Uint8Array) {
    this.buf = buffer;
  }

  get position(): number {
    return this.cursor;
  }

  get length(): number {
    return this.buf.length;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.buf.length) {
      throw new RangeError(`seek ${pos} out of range [0, ${this.buf.length}]`);
    }
    this.cursor = pos;
  }

  atEnd(): boolean {
    this.skipWhitespace();
    return this.cursor >= this.buf.length;
  }

  /**
   * 次の `(code, value)` 対を読み込む。
   * 末尾の区切りスペース（あれば）は自動で消費しない（呼び出し側が文字列読みに
   * 進む可能性があるため、区切り消費はそれぞれのメソッドに閉じる）。
   */
  readAtom(): Atom {
    this.skipWhitespace();
    const startPos = this.cursor;
    const code = this.readAsciiInt();
    if (code !== 2 && code !== 3 && code !== 4 && code !== 5) {
      throw new BgeParseError(
        `Unexpected type code ${code} at byte offset ${startPos}; expected 2/3/4/5`,
        startPos,
      );
    }
    this.skipWhitespace();
    const value = this.readAsciiInt();
    return { code: code as AtomCode, value, startPos };
  }

  /**
   * 整数値を期待する。`readAtom` を呼んで値だけ返す簡易版。
   */
  readInt(): number {
    return this.readAtom().value;
  }

  /**
   * 次のアトムが指定コードであることを検証して値を返す。
   * 主に header のスキーマ検証用。
   */
  readIntOfCode(expectedCode: AtomCode): number {
    const atom = this.readAtom();
    if (atom.code !== expectedCode) {
      throw new BgeParseError(
        `Expected code ${expectedCode}, got code ${atom.code} (value=${atom.value}) at offset ${atom.startPos}`,
        atom.startPos,
      );
    }
    return atom.value;
  }

  /**
   * 直前の「長さアトム」のあとに続く生バイト文字列を読み込む。
   *
   * 書式: `<length_atom> <space> <length bytes>`。長さアトム自体は
   * `readAtom()` で読んでもらってから、得た value を渡すこと。
   * ここでは1バイトのスペース区切りを消費してから、length バイトを取る。
   */
  readStringBytes(length: number): string {
    if (length < 0) {
      throw new BgeParseError(`negative string length ${length} at offset ${this.cursor}`, this.cursor);
    }
    if (length === 0) return '';
    // 長さアトム直後のスペース1バイトを消費
    if (this.cursor < this.buf.length && SP_BYTES.has(this.buf[this.cursor]!)) {
      this.cursor++;
    }
    if (this.cursor + length > this.buf.length) {
      throw new BgeParseError(
        `String of length ${length} exceeds buffer; cursor=${this.cursor}, total=${this.buf.length}`,
        this.cursor,
      );
    }
    const slice = this.buf.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return this.sjisDecoder.decode(slice);
  }

  /**
   * アトム + 文字列 を一発で読む簡易ラッパ。
   * コード制約がある場合は expectedCode を指定する。
   */
  readLengthPrefixedString(expectedCode?: AtomCode): string {
    const lengthAtom = this.readAtom();
    if (expectedCode !== undefined && lengthAtom.code !== expectedCode) {
      throw new BgeParseError(
        `Expected string length with code ${expectedCode}, got code ${lengthAtom.code} at offset ${lengthAtom.startPos}`,
        lengthAtom.startPos,
      );
    }
    return this.readStringBytes(lengthAtom.value);
  }

  /**
   * 次のアトムを先読み（消費しない）。
   */
  peekAtom(): Atom {
    const saved = this.cursor;
    try {
      return this.readAtom();
    } finally {
      this.cursor = saved;
    }
  }

  // ----- private -----

  private skipWhitespace(): void {
    while (this.cursor < this.buf.length && SP_BYTES.has(this.buf[this.cursor]!)) {
      this.cursor++;
    }
  }

  private readAsciiInt(): number {
    const start = this.cursor;
    if (this.cursor < this.buf.length && this.buf[this.cursor] === 0x2d /* - */) {
      this.cursor++;
    }
    while (
      this.cursor < this.buf.length &&
      this.buf[this.cursor]! >= 0x30 &&
      this.buf[this.cursor]! <= 0x39
    ) {
      this.cursor++;
    }
    if (this.cursor === start) {
      throw new BgeParseError(`expected integer at offset ${start}`, start);
    }
    const text = this.asciiDecoder.decode(this.buf.subarray(start, this.cursor));
    const v = Number.parseInt(text, 10);
    if (!Number.isFinite(v)) {
      throw new BgeParseError(`invalid integer "${text}" at offset ${start}`, start);
    }
    return v;
  }
}

export class BgeParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'BgeParseError';
    this.offset = offset;
  }
}

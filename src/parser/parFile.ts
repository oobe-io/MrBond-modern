/**
 * Mr.Bond の .PAR ファイル（シミュレーション設定＋パラメータ）パーサ。
 *
 * 参照実装: MRBOND/Runge.f SUBROUTINE PARM、MRBOND/Runge.c PARM()
 *
 * 書式（1レコード1行、先頭2文字でタイプ判定）:
 *   PA NNNN  V     - PA[NNNN] = V      （モデルパラメータ配列）
 *   SU NNN  NAME   - 状態変数の名前登録（使用は限定的）
 *   LA NNN  NAME   - 出力ラベル登録
 *   NS NNNNNNN     - 状態変数の数
 *   IN NNNNNNN     - インテグレータ数
 *   ND NNNNNNN     - 制約方程式ペア数 × 2
 *   PT N  V        - 時間設定 (1=T0, 2=T1, 3=Δt)
 *   NO NNNNNNN     - 出力タイムステップ数
 *   OP NNNNNNN     - 出力変数数
 *   ST NNN  V      - 状態初期値 X[NNN-1] = V
 *   END            - 終端
 *
 * パースは「先頭2文字でディスパッチ + 残りを空白で分割」の方式。Fortran版の
 * FIXED-FORMAT (2X,I4,2X,D15.8) に厳密には従わないが、実ファイルの揺れに
 * 対して頑健に動作する。数値は `D15.8` = D-exponent（Fortranの倍精度）を
 * `E` に変換してパース。
 */

export interface ParFile {
  /** PA[index] = value */
  readonly pa: ReadonlyMap<number, number>;
  /** PA の名前情報（あれば） index → name */
  readonly paNames: ReadonlyMap<number, string>;
  /** 状態変数初期値 X[index0-based] = value */
  readonly stateInit: ReadonlyMap<number, number>;
  /** 出力ラベル LA: index → name */
  readonly labels: ReadonlyMap<number, string>;
  /** 状態変数シンボル SU: index → name */
  readonly stateSymbols: ReadonlyMap<number, string>;
  readonly NS: number;
  readonly ING: number;
  readonly ND: number;
  readonly NOT: number;
  readonly NOUT: number;
  readonly T0: number;
  readonly T1: number;
  readonly TI: number;
}

export class ParParseError extends Error {
  readonly lineNumber: number;
  readonly line: string;
  constructor(message: string, lineNumber: number, line: string) {
    super(`${message} (line ${lineNumber}: "${line}")`);
    this.name = 'ParParseError';
    this.lineNumber = lineNumber;
    this.line = line;
  }
}

/**
 * Fortran の D 指数表記 (1.5D+03) を JavaScript の E 表記に変換してパース。
 */
function parseFortranDouble(text: string): number {
  const normalized = text.trim().replace(/[dD]/g, 'e').replace(/\s+/g, '');
  const v = Number.parseFloat(normalized);
  if (!Number.isFinite(v)) {
    throw new Error(`invalid number "${text}"`);
  }
  return v;
}

function parseIntStrict(text: string): number {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`invalid integer "${text}"`);
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * 行の先頭から最初の数値トークンだけ取り出して返す。末尾に人間用コメント
 * (例: "NS       2               NUMBER OF STATE VARIABLES") が入っても動く。
 */
function firstIntToken(text: string): number {
  const match = text.trim().match(/^-?\d+/);
  if (!match) {
    throw new Error(`no integer found in "${text}"`);
  }
  return Number.parseInt(match[0], 10);
}

export function parsePar(source: string): ParFile {
  const pa = new Map<number, number>();
  const paNames = new Map<number, string>();
  const stateInit = new Map<number, number>();
  const labels = new Map<number, string>();
  const stateSymbols = new Map<number, string>();
  let NS = 0;
  let ING = 0;
  let ND = 0;
  let NOT = 0;
  let NOUT = 0;
  const pt: (number | undefined)[] = [undefined, undefined, undefined, undefined];
  let ended = false;

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    if (ended) break;
    if (rawLine.trim() === '') continue;

    // 先頭2文字をタイプ識別子として取得
    const type = rawLine.slice(0, 2).toUpperCase();
    const rest = rawLine.slice(2);

    try {
      switch (type) {
        case 'PA': {
          // 実ファイル例: "PA   1   1.000000e+001 EIN   "
          //   → 番号, 値, 名前（オプション）
          const parts = rest.trim().split(/\s+/);
          if (parts.length < 2) {
            throw new Error('PA record requires index and value');
          }
          const idx = parseIntStrict(parts[0]!);
          const val = parseFortranDouble(parts[1]!);
          pa.set(idx, val);
          if (parts.length >= 3 && parts[2]!.length > 0) {
            paNames.set(idx, parts[2]!);
          }
          break;
        }
        case 'ST': {
          const parts = rest.trim().split(/\s+/);
          if (parts.length < 2) throw new Error('ST requires index and value');
          const idx = parseIntStrict(parts[0]!);
          const val = parseFortranDouble(parts[1]!);
          // Runge.c: X[NO-1] = V  → 0-based index に変換
          stateInit.set(idx - 1, val);
          break;
        }
        case 'LA': {
          const parts = rest.trim().split(/\s+/);
          if (parts.length < 2) throw new Error('LA requires index and name');
          const idx = parseIntStrict(parts[0]!);
          const name = parts.slice(1).join(' ');
          labels.set(idx, name);
          break;
        }
        case 'SU': {
          const parts = rest.trim().split(/\s+/);
          if (parts.length < 2) throw new Error('SU requires index and name');
          const idx = parseIntStrict(parts[0]!);
          const name = parts.slice(1).join(' ');
          stateSymbols.set(idx, name);
          break;
        }
        case 'NS':
          NS = firstIntToken(rest);
          break;
        case 'IN':
          ING = firstIntToken(rest);
          break;
        case 'ND':
          ND = firstIntToken(rest);
          break;
        case 'NO':
          NOT = firstIntToken(rest);
          break;
        case 'OP':
          NOUT = firstIntToken(rest);
          break;
        case 'PT': {
          const parts = rest.trim().split(/\s+/);
          if (parts.length < 2) throw new Error('PT requires index and value');
          const idx = parseIntStrict(parts[0]!);
          const val = parseFortranDouble(parts[1]!);
          if (idx < 1 || idx > 3) {
            throw new Error(`PT index out of range: ${idx}`);
          }
          pt[idx] = val;
          break;
        }
        case 'EN':
          if (rawLine.slice(0, 3).toUpperCase() === 'END') {
            ended = true;
          } else {
            throw new Error(`unknown record type "${type}"`);
          }
          break;
        default:
          throw new Error(`unknown record type "${type}"`);
      }
    } catch (err) {
      throw new ParParseError((err as Error).message, i + 1, rawLine);
    }
  }

  if (!ended) {
    throw new Error('PAR file missing END record');
  }
  if (pt[1] === undefined || pt[2] === undefined || pt[3] === undefined) {
    throw new Error('PT records incomplete: require PT 1, 2, 3');
  }

  return {
    pa,
    paNames,
    stateInit,
    labels,
    stateSymbols,
    NS,
    ING,
    ND,
    NOT,
    NOUT,
    T0: pt[1],
    T1: pt[2],
    TI: pt[3],
  };
}

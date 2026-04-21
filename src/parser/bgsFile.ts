/**
 * Mr.Bond の BGS ファイルパーサ。
 *
 * BGS は Mr.Bond が BGE を解釈した結果を書き出す「構造化中間表現」。
 * 実ファイル例: tests/fixtures/springMassDamper.BGS
 *
 * 書式:
 *   1行目: "BOND SYMBOL EXPR OUT DEFIN PARM INIT" （ヘッダ、無視）
 *   続いて要素行（要素名 + 付随するボンド番号の並び、負値は因果反転）
 *   例:
 *     SE1    1
 *     OJ     3     2     -1    4       (1-junction, bonds 3,2,-1,4)
 *     II1    2                          (I element at bond 2)
 *     ZJ     8     5     -3             (0-junction)
 *     CI1    5                          (C element)
 *     RE1    6                          (R element)
 *     SF1    9                          (flow source)
 *
 *   "/"  で区切られたあと、出力変数行:
 *     BC: DP2   DP2
 *
 *   "/"  で区切られたあと、要素ごとの詳細（順に繰り返し）:
 *     SE1
 *     PA: EIN    10.0
 *     E=EIN;
 *     EOD
 *     II1
 *     PA: M      10.0
 *     L=Z/M;
 *     EOD
 *     ...
 *
 *   "/"  で区切られたあと、シミュレーション設定（1行）:
 *     0.00000E+00  1.00000E+01  1.00000E-05   1000
 *
 *   最終 "/" 以降はファイル末尾。
 *
 * 要素の型は先頭 2 文字で判別:
 *   SE = Source of Effort
 *   SF = Source of Flow
 *   II = Inertia (I)
 *   CI = Capacitance (C)
 *   RE = Resistance (R)
 *   TF = Transformer
 *   GY = Gyrator
 *   OJ = One-Junction (1-junction)
 *   ZJ = Zero-Junction (0-junction)
 */

export type ElementKind = 'Se' | 'Sf' | 'I' | 'C' | 'R' | 'TF' | 'GY' | 'OneJunction' | 'ZeroJunction';

export interface Element {
  /** 要素名（例: "SE1", "II1", "OJ", "ZJ"） */
  readonly name: string;
  readonly kind: ElementKind;
  /** 接続ボンド番号（負値は因果反転を示す） */
  readonly bonds: number[];
  /** パラメータ名と値の配列（詳細セクションから取得、順序保持） */
  readonly parameters: { name: string; value: number }[];
  /** 要素の式（例: "E=EIN;", "L=Z/M;", "C=PK*Z;"）。複数行可 */
  readonly equations: string[];
}

export interface OutputBondSpec {
  /** 出力変数名（例: "DP2"） */
  readonly variable: string;
  /** ボンド上の変数名表示（Mr.Bondでは同じ文字列が2回出ることが多い） */
  readonly label: string;
}

export interface BgsFile {
  readonly elements: Element[];
  readonly outputs: OutputBondSpec[];
  readonly simulation: {
    readonly T0: number;
    readonly T1: number;
    readonly dt: number;
    readonly numOutputSteps: number;
  };
}

const TYPE_PREFIX: Record<string, ElementKind> = {
  SE: 'Se',
  SF: 'Sf',
  II: 'I',
  CI: 'C',
  RE: 'R',
  TF: 'TF',
  GY: 'GY',
  OJ: 'OneJunction',
  ZJ: 'ZeroJunction',
};

function classifyElement(name: string): ElementKind | undefined {
  const prefix = name.slice(0, 2).toUpperCase();
  return TYPE_PREFIX[prefix];
}

export class BgsParseError extends Error {
  readonly lineNumber: number;
  constructor(message: string, lineNumber: number) {
    super(`${message} (line ${lineNumber})`);
    this.name = 'BgsParseError';
    this.lineNumber = lineNumber;
  }
}

export function parseBgs(source: string): BgsFile {
  const rawLines = source.split(/\r?\n/);

  // セクション分割: "/" で区切られる
  const sections: { startLine: number; lines: string[] }[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (line.trim() === '/') {
      sections.push({ startLine: currentStart, lines: currentLines });
      currentLines = [];
      currentStart = i + 2;
    } else {
      currentLines.push(line);
    }
  }
  // 最後のセクション（末尾に "/" がない場合や、トレイリング空行のみの場合）
  if (currentLines.some((l) => l.trim() !== '')) {
    sections.push({ startLine: currentStart, lines: currentLines });
  }

  if (sections.length < 3) {
    throw new BgsParseError(
      `expected at least 3 sections separated by '/', got ${sections.length}`,
      1,
    );
  }

  // --- Section 1: トポロジ ---
  const topologySec = sections[0]!;
  const elementsPartial = parseTopologySection(topologySec.lines, topologySec.startLine);

  // --- Section 2: 出力変数 ---
  const outputSec = sections[1]!;
  const outputs = parseOutputSection(outputSec.lines, outputSec.startLine);

  // --- Section 3: 要素詳細 ---
  const detailSec = sections[2]!;
  const detailsByName = parseDetailsSection(detailSec.lines, detailSec.startLine);

  // --- Section 4 (optional): シミュレーション設定 ---
  const simSec = sections[3];
  const simulation = simSec
    ? parseSimulationSection(simSec.lines, simSec.startLine)
    : { T0: 0, T1: 0, dt: 0, numOutputSteps: 0 };

  // トポロジ要素と詳細セクションをマージ
  const elements: Element[] = elementsPartial.map((el) => {
    const detail = detailsByName.get(el.name);
    return {
      ...el,
      parameters: detail?.parameters ?? [],
      equations: detail?.equations ?? [],
    };
  });

  return { elements, outputs, simulation };
}

interface PartialElement {
  name: string;
  kind: ElementKind;
  bonds: number[];
}

function parseTopologySection(lines: string[], sectionStart: number): PartialElement[] {
  const elements: PartialElement[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('BOND SYMBOL')) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 2) {
      throw new BgsParseError(`topology row requires element name + at least one bond`, sectionStart + i);
    }
    const name = tokens[0]!;
    const kind = classifyElement(name);
    if (!kind) {
      throw new BgsParseError(`unknown element prefix in "${name}"`, sectionStart + i);
    }
    const bonds = tokens.slice(1).map((t, j) => {
      const v = Number.parseInt(t, 10);
      if (!Number.isFinite(v)) {
        throw new BgsParseError(`invalid bond number "${t}" (col ${j + 1})`, sectionStart + i);
      }
      return v;
    });
    elements.push({ name, kind, bonds });
  }
  return elements;
}

function parseOutputSection(lines: string[], sectionStart: number): OutputBondSpec[] {
  const outputs: OutputBondSpec[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('BC:')) {
      throw new BgsParseError(`output line must start with "BC:": "${trimmed}"`, sectionStart + i);
    }
    const rest = trimmed.slice(3).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 1) continue;
    outputs.push({
      variable: parts[0]!,
      label: parts[1] ?? parts[0]!,
    });
  }
  return outputs;
}

interface PartialDetail {
  parameters: { name: string; value: number }[];
  equations: string[];
}

function parseDetailsSection(lines: string[], sectionStart: number): Map<string, PartialDetail> {
  const map = new Map<string, PartialDetail>();
  let currentName: string | null = null;
  let currentDetail: PartialDetail | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;

    if (trimmed === 'EOD') {
      if (currentName && currentDetail) {
        map.set(currentName, currentDetail);
      }
      currentName = null;
      currentDetail = null;
      continue;
    }

    if (trimmed.startsWith('PA:')) {
      if (!currentDetail) {
        throw new BgsParseError(`PA: outside element context`, sectionStart + i);
      }
      const rest = trimmed.slice(3).trim();
      const parts = rest.split(/\s+/);
      if (parts.length < 2) {
        throw new BgsParseError(`PA: requires name and value`, sectionStart + i);
      }
      const name = parts[0]!;
      const value = Number.parseFloat(parts[1]!);
      if (!Number.isFinite(value)) {
        throw new BgsParseError(`PA: invalid value "${parts[1]}"`, sectionStart + i);
      }
      currentDetail.parameters.push({ name, value });
      continue;
    }

    // それ以外の行: 要素名 or 式
    if (currentName === null) {
      // 要素名開始
      currentName = trimmed;
      currentDetail = { parameters: [], equations: [] };
    } else {
      // 式として収集
      currentDetail!.equations.push(trimmed);
    }
  }

  if (currentName && currentDetail) {
    // EOD なしで終わった場合も採用
    map.set(currentName, currentDetail);
  }

  return map;
}

function parseSimulationSection(lines: string[], sectionStart: number): BgsFile['simulation'] {
  // シミュレーション設定は 1 行で、空白区切り: T0 T1 dt NOT
  const allText = lines.map((l) => l.trim()).filter((l) => l !== '').join(' ');
  if (allText === '') {
    throw new BgsParseError('missing simulation settings', sectionStart);
  }
  const parts = allText.split(/\s+/);
  if (parts.length < 4) {
    throw new BgsParseError(`simulation section requires T0 T1 dt NOT (got ${parts.length})`, sectionStart);
  }
  const T0 = Number.parseFloat(parts[0]!);
  const T1 = Number.parseFloat(parts[1]!);
  const dt = Number.parseFloat(parts[2]!);
  const numOutputSteps = Number.parseInt(parts[3]!, 10);
  if (![T0, T1, dt].every(Number.isFinite) || !Number.isFinite(numOutputSteps)) {
    throw new BgsParseError(`invalid simulation values`, sectionStart);
  }
  return { T0, T1, dt, numOutputSteps };
}

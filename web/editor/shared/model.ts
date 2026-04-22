/**
 * 描画エディタ共通データモデル。
 *
 * Canvas / Toolbar / ParameterDialog / シリアライザ などすべてが
 * この型を介して通信する。
 *
 * 設計原則:
 * - 純粋なデータ（クラスやビヘイビアを持たない）
 * - すべての ID は生成時 UUID or カウンタベース文字列
 * - 座標系は論理座標（SVG/キャンバス座標、pixelではなくユニット）
 * - 変異は必ず reducer 経由（将来 undo/redo 実装のため）
 */

// ---- 要素タイプ（Mr.Bond のツールバー順） ----

export type ElementKind =
  | 'C'             // Capacitance（バネ/容量）
  | 'I'             // Inertia（慣性/質量）
  | 'R'             // Resistance（抵抗/ダンパ）
  | 'Se'            // Source of Effort
  | 'Sf'            // Source of Flow
  | 'TF'            // Transformer
  | 'GY'            // Gyrator
  | 'ZeroJunction'  // 0-junction (effort common)
  | 'OneJunction';  // 1-junction (flow common)

/** Mr.Bond 方式の表示記号 */
export const ELEMENT_SYMBOL: Record<ElementKind, string> = {
  C: 'C',
  I: 'I',
  R: 'R',
  Se: 'SE',
  Sf: 'SF',
  TF: 'TF',
  GY: 'GY',
  ZeroJunction: '0',
  OneJunction: '1',
};

/** パレット表示順（Mr.Bond 画面の並び）*/
export const ELEMENT_PALETTE_ORDER: ElementKind[] = [
  'C', 'I', 'R', 'Se', 'Sf', 'TF', 'GY', 'ZeroJunction', 'OneJunction',
];

// ---- ドキュメント本体 ----

export interface Parameter {
  readonly name: string;    // e.g. "EIN", "M", "PK"
  readonly value: number;
  readonly unit?: string;   // e.g. "N", "kg", "N/m"
}

export interface Element {
  readonly id: string;                  // "el_1", "el_2" など
  readonly kind: ElementKind;
  readonly label?: string;              // 表示ラベル（例: "C1", "I1"）。未指定時は kind から自動生成
  readonly position: { x: number; y: number };  // 論理座標
  readonly parameters: readonly Parameter[];    // ユーザ設定
  readonly equation?: string;                   // C式サブセット（e.g. "C=PK*Z;"）
}

export interface Bond {
  readonly id: string;
  /** 接続元要素 ID。因果は causality フィールドで別途管理 */
  readonly fromElementId: string;
  readonly toElementId: string;
  /** 因果: effortIn = from へ effort が入る、flowIn = from へ flow が入る */
  readonly causality?: 'effortIn' | 'flowIn';
}

export interface BondGraphDoc {
  readonly elements: readonly Element[];
  readonly bonds: readonly Bond[];
  readonly simulation: {
    readonly t0: number;
    readonly t1: number;
    readonly dt: number;
    readonly numOutputSteps: number;
  };
  /** 出力変数（どのボンドの何を CSV に出すか） */
  readonly outputs: readonly {
    readonly bondId: string;
    readonly variableName: string;  // e.g. "Displacement", "Effort"
    readonly label: string;
  }[];
}

// ---- 初期ドキュメント ----

export function emptyDoc(): BondGraphDoc {
  return {
    elements: [],
    bonds: [],
    simulation: { t0: 0, t1: 10, dt: 1e-5, numOutputSteps: 1000 },
    outputs: [],
  };
}

// ---- ID 生成ヘルパ ----

export function nextElementId(doc: BondGraphDoc): string {
  const nums = doc.elements
    .map((e) => Number.parseInt(e.id.replace(/^el_/, ''), 10))
    .filter(Number.isFinite);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `el_${next}`;
}

export function nextBondId(doc: BondGraphDoc): string {
  const nums = doc.bonds
    .map((b) => Number.parseInt(b.id.replace(/^bond_/, ''), 10))
    .filter(Number.isFinite);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `bond_${next}`;
}

/** 同種要素の連番ラベル: C→C1,C2... */
export function nextLabelFor(doc: BondGraphDoc, kind: ElementKind): string {
  const sym = ELEMENT_SYMBOL[kind];
  const existing = doc.elements.filter((e) => e.kind === kind);
  return `${sym}${existing.length + 1}`;
}

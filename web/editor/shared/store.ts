/**
 * 描画エディタの中央状態ストア（pub-sub 方式）。
 *
 * React・Vue・素の DOM いずれからも使えるよう、フレームワーク非依存の
 * 小さな実装にする。useSyncExternalStore 等でブリッジ可能。
 *
 * 状態変更は `dispatch(action)` 経由。undo/redo は後日スタックに拡張。
 */

import {
  type BondGraphDoc,
  type Element,
  type ElementKind,
  type Bond,
  emptyDoc,
  nextElementId,
  nextBondId,
  nextLabelFor,
} from './model.ts';

// ---- ツールバーのモード（ボタン選択状態） ----

export type Tool =
  | { kind: 'select' }          // 既定: クリックで選択
  | { kind: 'place'; element: ElementKind }  // 要素配置モード
  | { kind: 'bond' };           // ボンド描画モード（2要素を順クリック）

// ---- UI 状態 ----

export interface EditorState {
  readonly doc: BondGraphDoc;
  readonly tool: Tool;
  /** 選択中の要素 ID（複数選択はいったん未対応） */
  readonly selectedElementId: string | null;
  /** ボンド描画中の始点要素 ID */
  readonly pendingBondFrom: string | null;
}

export function initialState(): EditorState {
  return {
    doc: emptyDoc(),
    tool: { kind: 'select' },
    selectedElementId: null,
    pendingBondFrom: null,
  };
}

// ---- アクション定義 ----

export type Action =
  | { type: 'setTool'; tool: Tool }
  | { type: 'selectElement'; id: string | null }
  | { type: 'addElement'; kind: ElementKind; x: number; y: number }
  | { type: 'moveElement'; id: string; x: number; y: number }
  | { type: 'updateElement'; id: string; patch: Partial<Omit<Element, 'id'>> }
  | { type: 'deleteElement'; id: string }
  | { type: 'startBond'; fromId: string }
  | { type: 'completeBond'; toId: string }
  | { type: 'cancelBond' }
  | { type: 'deleteBond'; id: string }
  | { type: 'loadDoc'; doc: BondGraphDoc };

// ---- reducer ----

export function reduce(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'setTool': {
      return { ...state, tool: action.tool, pendingBondFrom: null };
    }
    case 'selectElement': {
      return { ...state, selectedElementId: action.id };
    }
    case 'addElement': {
      const id = nextElementId(state.doc);
      const label = nextLabelFor(state.doc, action.kind);
      const newElement: Element = {
        id,
        kind: action.kind,
        label,
        position: { x: action.x, y: action.y },
        parameters: [],
      };
      return {
        ...state,
        doc: {
          ...state.doc,
          elements: [...state.doc.elements, newElement],
        },
        selectedElementId: id,
      };
    }
    case 'moveElement': {
      return {
        ...state,
        doc: {
          ...state.doc,
          elements: state.doc.elements.map((e) =>
            e.id === action.id ? { ...e, position: { x: action.x, y: action.y } } : e,
          ),
        },
      };
    }
    case 'updateElement': {
      return {
        ...state,
        doc: {
          ...state.doc,
          elements: state.doc.elements.map((e) =>
            e.id === action.id ? { ...e, ...action.patch } : e,
          ),
        },
      };
    }
    case 'deleteElement': {
      return {
        ...state,
        doc: {
          ...state.doc,
          elements: state.doc.elements.filter((e) => e.id !== action.id),
          bonds: state.doc.bonds.filter(
            (b) => b.fromElementId !== action.id && b.toElementId !== action.id,
          ),
        },
        selectedElementId: state.selectedElementId === action.id ? null : state.selectedElementId,
      };
    }
    case 'startBond': {
      return { ...state, pendingBondFrom: action.fromId };
    }
    case 'completeBond': {
      if (state.pendingBondFrom === null) return state;
      if (state.pendingBondFrom === action.toId) {
        return { ...state, pendingBondFrom: null };
      }
      const id = nextBondId(state.doc);
      const newBond: Bond = {
        id,
        fromElementId: state.pendingBondFrom,
        toElementId: action.toId,
      };
      return {
        ...state,
        doc: { ...state.doc, bonds: [...state.doc.bonds, newBond] },
        pendingBondFrom: null,
      };
    }
    case 'cancelBond': {
      return { ...state, pendingBondFrom: null };
    }
    case 'deleteBond': {
      return {
        ...state,
        doc: { ...state.doc, bonds: state.doc.bonds.filter((b) => b.id !== action.id) },
      };
    }
    case 'loadDoc': {
      return { ...initialState(), doc: action.doc };
    }
  }
}

// ---- pub-sub ストア ----

export interface Store {
  getState(): EditorState;
  dispatch(action: Action): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: EditorState = initialState()): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action: Action) => {
      state = reduce(state, action);
      listeners.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

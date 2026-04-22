# editor/io

描画エディタのドキュメント入出力（JSON 保存/読み込み）モジュール。

## 公開 API (`saveLoad.ts`)

```ts
serializeDoc(doc: BondGraphDoc): string
deserializeDoc(json: string): BondGraphDoc       // 失敗時 Error throw
mountIoButtons(container: HTMLElement, store: Store): () => void
```

- `serializeDoc` は `{ format, version, doc }` ラッパで包んで 2 スペース整形 JSON を返す。
- `deserializeDoc` は JSON パース + フォーマット検証 + 型/参照整合性チェックを行う。
- `mountIoButtons` は Save / Open の 2 ボタンを `container` に差し込む。
  - Save: 現在の `store.getState().doc` を `bondgraph-YYYY-MM-DD-HHMMSS.json` でダウンロード。
  - Open: 隠し `<input type="file" accept=".json">` でファイル選択 → `loadDoc` アクションを dispatch。
  - 失敗時は `alert()` で簡易表示（UX は将来改善）。
- スタイルは `<style id="mrbond-io-style">` を `document.head` に 1 度だけ注入する。

## JSON フォーマット

```json
{
  "format": "mrbond-modern-doc",
  "version": 1,
  "doc": {
    "elements": [
      {
        "id": "el_1",
        "kind": "C",
        "label": "C1",
        "position": { "x": 10, "y": 20 },
        "parameters": [
          { "name": "PK", "value": 100, "unit": "N/m" }
        ]
      },
      {
        "id": "el_2",
        "kind": "OneJunction",
        "position": { "x": 50, "y": 60 },
        "parameters": []
      }
    ],
    "bonds": [
      { "id": "bond_1", "fromElementId": "el_1", "toElementId": "el_2" },
      { "id": "bond_2", "fromElementId": "el_2", "toElementId": "el_1", "causality": "effortIn" }
    ],
    "simulation": {
      "t0": 0,
      "t1": 10,
      "dt": 0.00001,
      "numOutputSteps": 1000
    },
    "outputs": [
      { "bondId": "bond_1", "variableName": "Effort", "label": "F_spring" }
    ]
  }
}
```

- `format` と `version` はフォワード互換のための目印。現在は `version: 1` のみ受け付ける。
- element の `label` / `equation`、bond の `causality`、parameter の `unit` は optional。
- `id` は elements/bonds 内でそれぞれユニーク。
- `bond.fromElementId` / `bond.toElementId` は既存 element の `id` を参照している必要がある。
- `output.bondId` も既存 bond を参照していなければならない。

## バリデーションで拒否する主なケース

- パースできない JSON
- `format !== "mrbond-modern-doc"`
- `version !== 1`
- `element.kind` が ElementKind 以外
- `position.x / y` が非有限数
- element/bond の id 重複
- bond が存在しない element を指す
- output が存在しない bond を指す
- optional フィールドに誤った型（数値を期待する場所に文字列 等）

## 統合時のメモ

- `mountIoButtons` は `mountToolbar` と同じ配色規約（`#0f1115` bg, `#181c23` panel, `#6ee7b7` accent, `#e8eaee` fg, `#2a2f38` border）に揃えてある。
- `main.ts` から呼ぶ際は、toolbar/canvas とは別の親コンテナ（例: ヘッダやメニューバー用 `<div>`）を渡すことを想定。
- Parameter Dialog と UI 領域は独立しているため衝突しない想定。

## 内部実装メモ

- `_roundTripCheck(doc)` を内部に持つが export しない（開発時の手動 sanity check 用）。
- 実運用では `serializeDoc → deserializeDoc → serializeDoc` で完全に同一文字列に戻るよう、
  element 構築時のキー挿入順を `model.ts` の型定義順に合わせている。

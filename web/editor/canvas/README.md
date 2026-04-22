# Canvas

描画エディタの **キャンバス領域** 実装。SVG ベース、外部ライブラリなし。

## API

```ts
import { mountCanvas } from './canvas.ts';
const cleanup = mountCanvas(container, store);
// ...
cleanup();  // イベント解除 + SVG 除去
```

- `container`: SVG をマウントする親要素（任意サイズ）
- `store`: `../shared/store.ts` の `Store`
- 戻り値: クリーンアップ関数

## 描画仕様

- SVG `viewBox = 0 0 800 600` 固定（ズーム/パンは将来対応）
- ジャンクション (0/1): 半径 16 の円、中央に `0` / `1`
- 要素 (C/I/R/Se/Sf/TF/GY): 48×26 の角丸矩形、中央にラベル
- カラーリングは `web/main.ts` の既存配色と統一（Se/Sf 青、I 黄、C 緑、R 赤、TF/GY 紫、ジャンクション白/グレー）
- 選択中・ボンド始点要素は accent 色 (`#6ee7b7`) で太め stroke
- ボンドは直線 + ボンドグラフ慣例の **半矢印**（終点側）
- ボンド描画中は始点からマウスまで **点線ラバーバンド**
- 背景には薄いグリッド

## インタラクション

`store.tool.kind` で分岐:

### `select`
- 要素クリック → `selectElement`
- 要素ドラッグ → `moveElement`（mousemove で連続更新）
- 空白クリック → `selectElement: null`
- Delete / Backspace → 選択要素を `deleteElement`

### `place`
- 空白クリック → `addElement` at pointer
- 要素クリックは無視

### `bond`
- 1回目要素クリック → `startBond`
- 2回目要素クリック → `completeBond`（同一要素ならキャンセル相当）
- Esc → `cancelBond`

## 実装メモ

- 再描画は `store.subscribe` 経由で全 SVG を一度クリアして再構築（単純化優先。〜50 要素規模なら性能問題なし）
- クリック座標は `viewBox` の `preserveAspectRatio=xMidYMid meet` を考慮して論理座標へ逆変換
- 要素 `<g>` は `mousedown` で `stopPropagation` し、背景クリックとは排他に処理
- ドラッグ/マウスアップは `window` で拾う（SVG 外までドラッグが追従するため）
- キー入力は `window.keydown`。ただし `INPUT` / `TEXTAREA` にフォーカスがある場合は Delete を無視
- ラバーバンド描画時のみ store を介さず直接 `render` を呼んで pendingPointer を反映（store に座標を入れず、UI だけの状態として持つ）

## 触らない領域

- `../toolbar/` と `../shared/` は read-only（別エージェントと共有）
- `web/main.ts` / `web/index.html` も別 entry なので触らない

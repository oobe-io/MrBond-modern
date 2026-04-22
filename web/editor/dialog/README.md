# パラメータ編集ダイアログ

選択中 Element の `label` / `parameters` / `equation` をモーダルで編集する。

## 構成

```
web/editor/dialog/
├─ parameterDialog.ts   ダイアログ本体（mountParameterDialog エクスポート）
└─ README.md
```

## 公開 API

```typescript
mountParameterDialog(container: HTMLElement, store: Store): () => void
```

- `container`: オーバーレイを append する親要素（`document.body` か任意のアプリコンテナ）
- 戻り値: cleanup 関数（DOM 除去 + keydown リスナー解除）

## 起動トリガ

- `Enter` キー押下、かつ `store.selectedElementId` が有効な要素 ID のときダイアログを開く
- 入力フォーカスが INPUT / TEXTAREA / SELECT / contentEditable にある時や IME 変換中は無視（Toolbar と同ポリシー）
- ダイアログ自身が開いている間は Enter トリガしない

## 閉じる操作

- フッタ「キャンセル」 / 右上 × / `Esc` / オーバーレイ背景クリック → 変更破棄
- フッタ「保存」 → `dispatch({ type: 'updateElement', id, patch })` で反映して閉じる

## 編集フィールド

1. **Label** — `<input>`。空欄で保存すると `label: ''` になる
2. **Parameters** — 動的リスト。各行 `name / value / unit(optional)` + 削除ボタン / 「+ パラメータ追加」ボタン
   - `name` が空の行は保存時に捨てる
   - `value` は `Number.parseFloat`、失敗時は 0 に落とす
   - `unit` が空文字なら `Parameter.unit` を付けない（`exactOptionalPropertyTypes` 対応）
3. **Equation** — `<textarea>` 複数行可（C 式サブセット）

## スタイル

- Toolbar と同じ配色規約: `#0f1115` bg / `#181c23` panel / `#6ee7b7` accent / `#e8eaee` fg / `#2a2f38` border
- `<style id="mrbond-dialog-style">` を `document.head` に 1 度だけ注入（重複ガード済み）
- オーバーレイ: `position: fixed; inset: 0; rgba(0,0,0,0.5) + backdrop-filter: blur(2px)`
- モーダルカード: 480px 幅、縦スクロール可能

## 依存境界

- 既存 Canvas / Toolbar / Shared ファイルは一切編集していない
- `shared/store.ts` / `shared/model.ts` を import 経由で利用のみ

## 統合例

```typescript
import { mountParameterDialog } from './dialog/parameterDialog.ts';

const store = createStore();
// ... mountToolbar / mountCanvas と同じ感覚で
const cleanup = mountParameterDialog(document.body, store);
// or: mountParameterDialog(appRoot, store);
```

## 補足

- 編集中に対象 Element が別操作で削除されたら自動で閉じる（store 購読で検知）
- 新規パラメータ行追加時は新しい行の `name` 入力に自動フォーカス
- 開いたときは `Label` 入力にフォーカスして全選択

# Toolbar

Mr.Bond 風の縦並びツールバー。素の DOM + `shared/store.ts` の pub-sub ストアで実装。

## 公開 API

```ts
import { mountToolbar } from './toolbar/toolbar.ts';

const cleanup = mountToolbar(containerEl, store);
// ...画面遷移時など
cleanup();
```

- `mountToolbar(container, store)` は cleanup 関数を返す。
- cleanup は `window` の keydown リスナを外し、store の購読を解除し、ツールバー DOM を削除する。

## レイアウト

上から順に:

1. 選択ツール `↖`（`V`）→ `{ kind: 'select' }`
2. 区切り線
3. パレット（`ELEMENT_PALETTE_ORDER` の順）
   - `C` / `I` / `R` / `SE` / `SF` / `TF` / `GY` / `0` / `1`
   - 表示ラベルは `ELEMENT_SYMBOL[kind]`
   - クリックで `{ kind: 'place', element: kind }` に切替
4. 区切り線
5. ボンドツール `→`（`B`）→ `{ kind: 'bond' }`
6. 余白（flex spacer）
7. 削除ボタン `✕`（`Del`）
   - `store.selectedElementId` が `null` のとき disabled
   - クリックで `{ type: 'deleteElement', id }`

各ボタンの下には小さくショートカットキーを表示、`title` 属性には日本語名入り。

## アクティブ表示

`store.subscribe` で `tool` の変化を購読し、各ボタンの `is-active` クラスを切り替える。
削除ボタンは `selectedElementId` の有無で `disabled` / `is-enabled` を切り替え。
DOM は初回 `mountToolbar` 時に一度だけ構築し、以降はクラス切替のみ。

## キーボードショートカット

| キー | 動作 |
| --- | --- |
| `V` | 選択ツール |
| `C` / `I` / `R` | 要素配置モード（C / I / R） |
| `E` | Se（Source of Effort） |
| `F` | Sf（Source of Flow） |
| `T` | TF（Transformer） |
| `G` | GY（Gyrator） |
| `0` | 0 接点 |
| `1` | 1 接点 |
| `B` | ボンド描画モード |
| `Del` / `Backspace` | 選択要素を削除 |

`window` に `keydown` を登録しつつ、以下の場合は無視する:

- IME 変換中（`e.isComposing` / `keyCode === 229`）
- Ctrl / Meta / Alt 修飾キー併用時
- `<input>` / `<textarea>` / `<select>` / `contentEditable` にフォーカスがある時

これで将来パラメータダイアログなどで数値入力中にショートカットが暴発するのを防ぐ。
ツールバー自体は `tabindex=0` で focusable、ボタンクリック後は root に focus を戻してキー操作を継続できる。

## スタイル

`web/style.css` の配色（`#0f1115` / `#181c23` / `#2a2f38` / `#e8eaee` / `#9aa0a6` / `#6ee7b7`）
をハードコードで合わせた専用 CSS を `toolbar.ts` 内に文字列として持ち、
`<style id="mrbond-toolbar-style">` を `document.head` に一度だけ注入する
（重複注入はガードあり）。共有 `web/style.css` は触らない。

## 非編集ファイル

- `web/editor/canvas/` — Canvas エージェント担当
- `web/editor/shared/` — read-only（型と store のみ import）
- `web/main.ts` / `web/index.html` / `web/style.css` — 触らない

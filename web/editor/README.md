# 描画エディタ

Mr.Bond 風のボンドグラフ描画エディタ。2 エージェント並列開発。

## 構成

```
web/editor/
├─ shared/       共通型・ストア（全員が import）
│   ├─ model.ts  Element, Bond, BondGraphDoc 等のデータ型
│   └─ store.ts  pub-sub ストア + reducer
├─ canvas/       キャンバス領域（SVG ベース、要素配置・ドラッグ・ボンド描画）
├─ toolbar/      ツールバー + パレット + ツールモード切替
└─ (root)        editor.html, main.ts で組み合わせる
```

## 責務分担

- **Canvas**: SVG 描画、要素ノードの配置/移動、ボンド線描画、選択、クリック→配置/接続
- **Toolbar**: 左側にパレット（C I R SE SF TF GY 0 1）、選択ツール、ボンドツール。ツール状態を `store.setTool` で更新
- **Shared**: どちらも `shared/store.ts` の `createStore` と `dispatch` で同期

## モード

- `select`: 要素クリックで選択、ドラッグで移動
- `place:C` 等: キャンバスクリックで該当要素を配置
- `bond`: 1つ目要素クリック→始点、2つ目要素クリック→ボンド確定

## 最小動作

`web/editor.html` を開くと Canvas + Toolbar が並ぶ。両方とも同じ store を共有して動く。

後続作業: パラメータダイアログ、BGE シリアライザ、シミュレーション実行ボタン。

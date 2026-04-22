import { defineConfig } from 'vite';

/**
 * MrBond-modern Web UI のための Vite 設定。
 *
 * - ルートは `web/`（HTML と main.ts 置き場）
 * - tests/fixtures/ を読み込めるように `publicDir` を指定
 *   （または vite の `server.fs.allow` を使う）
 * - TS 型チェックは `npm run typecheck` で別途実行（Vite は型チェックしない）
 */
export default defineConfig({
  root: 'web',
  publicDir: '../tests/fixtures',
  server: {
    port: 5173,
    fs: {
      // プロジェクトルート全体からファイルを読めるようにする（src/ や tests/fixtures/）
      allow: ['..'],
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'web/index.html',
        editor: 'web/editor.html',
      },
    },
  },
});

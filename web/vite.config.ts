import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 画面のビルド設定。
//   ・出力先は ../public/app/ （Workerが静的アセットとして配る場所）
//   ・base は '/app/' 。生成されるHTMLが /app/assets/... を読むようにするため
//   ・成果物はgitにコミットする。購入者は `npm ci` も `npm run build:web` もせずにデプロイできる
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: '../public/app',
    // 前回の成果物（古いハッシュのJS/CSS）を毎回消す。rootの外なので明示が要る
    emptyOutDir: true,
    // 購入者が改造してエラーを追えるように、ソースマップは出さないが圧縮は素直な設定にする
    target: 'es2022',
    chunkSizeWarningLimit: 800,
  },
  server: {
    // `npm run dev`（Vite）で画面だけ動かすとき、APIは別で動かした wrangler dev へ回す。
    //   端末1: npx wrangler dev      （http://localhost:8787）
    //   端末2: npm --prefix web run dev
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/auth': 'http://127.0.0.1:8787',
    },
  },
});

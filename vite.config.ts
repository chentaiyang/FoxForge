/**
 * 灵狐工坊的 Vite 配置：渲染进程 React 开发/打包，并经 vite-plugin-electron
 * 同时构建 electron/main.ts 与 preload.ts。
 *
 * sharp 必须打进 external，避免被卷进 Electron 主进程包。
 * 真实 vips 操作只允许在系统 Node 子进程的 sharp-worker.mjs 里发生。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

export default defineConfig({
  // 生产环境用 loadFile 打开 dist/index.html，根路径 /mascot-*.png 会变成 file:///mascot-*.png。
  // 相对 base 才能让 public 资源和打包后的 JS/CSS 在安装包里正确加载。
  base: './',
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['sharp'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
      },
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

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

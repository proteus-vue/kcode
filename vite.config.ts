import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tauri 期望固定端口；失败时不静默换端口，避免 devUrl 指向错误目标
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    // React 19 要求显式声明处于 act 环境，否则每次都打警告
    setupFiles: ['./src/testSetup.ts'],
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});

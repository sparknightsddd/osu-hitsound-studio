import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    // Electron 走 file://，<script type="module" crossorigin> 会被 CORS 拦下；
    // 产物本身已经是 iife，这里把标签降级成经典脚本即可。
    {
      name: 'classic-script-for-file-protocol',
      enforce: 'post',
      transformIndexHtml(html) {
        // 必须保留 defer：module 脚本天生延迟执行，经典脚本不 defer 会在 <body> 之前就跑
        return html.replace(/<script type="module"\s+crossorigin\s+/g, '<script defer ')
      },
    },
  ],
  // Electron 用 file:// 加载 dist，资源路径必须是相对的
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Electron 用 file:// 打开 dist，ES module 会被 CORS 拦下，
    // 所以打成经典脚本（iife）单文件，动态 import 也一并内联。
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
})

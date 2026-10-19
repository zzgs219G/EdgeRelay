import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 同源部署：前端构建产物由 Cloudflare Worker 通过 [assets] 托管，
// 因此 base 用相对路径 './'，不写死域名。
// /api/* 由 Worker 处理，不会被 assets 拦截（run_worker_first = true）。
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

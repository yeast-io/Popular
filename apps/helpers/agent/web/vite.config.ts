import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { proxy: { '/api': { target: 'http://127.0.0.1:1423', changeOrigin: false } } },
});

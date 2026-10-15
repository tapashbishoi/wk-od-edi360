import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // 5174 so it can run beside edi-360 (5173); the API is on 3100 beside edi-360's 3000
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:3100', changeOrigin: true },
    },
  },
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/v1': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/anthropic': 'http://localhost:3000',
      '/v1beta': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
})

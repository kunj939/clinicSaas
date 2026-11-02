import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the API runs on :4000 and is reached through the /api proxy, so the
// session cookie stays on the same origin. In production set VITE_API_BASE_URL instead.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4000' } },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});

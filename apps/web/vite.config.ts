import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.API_URL ?? 'http://localhost:3000';
// Các route của SPA (/login, /room, /library, /camera, /settings...) không trùng tiền tố API.
const apiPaths = ['/auth', '/users', '/rooms', '/devices', '/videos', '/files', '/health'];

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      ...Object.fromEntries(apiPaths.map((p) => [p, { target: API }])),
      '/socket.io': { target: API, ws: true },
    },
  },
});

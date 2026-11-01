import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { Codes } from '@multicam/shared';
import { env } from './env';
import { errorHandler, send } from './lib/http';
import { authRouter } from './routes/auth';
import { roomsRouter } from './routes/rooms';
import { filesRouter, videosRouter } from './routes/videos';

// Bảng đường dẫn API để phân biệt "sai method" (9997) với "không tồn tại".
const API_ROUTES: { pattern: RegExp; methods: string[] }[] = [
  { pattern: /^\/auth\/signup$/, methods: ['POST'] },
  { pattern: /^\/auth\/verify-code$/, methods: ['POST'] },
  { pattern: /^\/auth\/verify-code\/check$/, methods: ['POST'] },
  { pattern: /^\/auth\/login$/, methods: ['POST'] },
  { pattern: /^\/auth\/refresh$/, methods: ['POST'] },
  { pattern: /^\/auth\/password\/forgot$/, methods: ['POST'] },
  { pattern: /^\/auth\/password$/, methods: ['PUT'] },
  { pattern: /^\/auth\/logout$/, methods: ['POST'] },
  { pattern: /^\/users\/me$/, methods: ['DELETE'] },
  { pattern: /^\/rooms$/, methods: ['POST'] },
  { pattern: /^\/rooms\/join$/, methods: ['POST'] },
  { pattern: /^\/rooms\/[^/]+\/members$/, methods: ['GET'] },
  { pattern: /^\/rooms\/[^/]+\/members\/[^/]+$/, methods: ['DELETE'] },
  { pattern: /^\/rooms\/[^/]+\/leave$/, methods: ['POST'] },
  { pattern: /^\/rooms\/[^/]+$/, methods: ['DELETE'] },
  { pattern: /^\/devices\/[^/]+\/sync$/, methods: ['POST'] },
  { pattern: /^\/rooms\/[^/]+\/sync$/, methods: ['GET'] },
  { pattern: /^\/rooms\/[^/]+\/recording\/(start|stop)$/, methods: ['POST'] },
  { pattern: /^\/rooms\/[^/]+\/camera$/, methods: ['POST'] },
  { pattern: /^\/videos\/uploads$/, methods: ['POST'] },
  { pattern: /^\/videos\/uploads\/[^/]+\/chunks\/[^/]+$/, methods: ['PUT'] },
  { pattern: /^\/videos\/uploads\/[^/]+$/, methods: ['GET'] },
  { pattern: /^\/videos\/uploads\/[^/]+\/complete$/, methods: ['POST'] },
  { pattern: /^\/videos$/, methods: ['GET'] },
  { pattern: /^\/videos\/bulk-delete$/, methods: ['POST'] },
  { pattern: /^\/videos\/[^/]+$/, methods: ['GET', 'DELETE'] },
  { pattern: /^\/videos\/[^/]+\/download$/, methods: ['GET'] },
];

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => send(res, { server_time: new Date().toISOString(), version: '1.0.0' }));

  app.use(authRouter);
  app.use(roomsRouter);
  app.use(videosRouter);
  app.use(filesRouter);

  // Bản web build sẵn (npm run build -w @multicam/web) được phục vụ cùng cổng với API.
  const webIndex = path.join(env.webDist, 'index.html');
  app.use(express.static(env.webDist, { index: false }));

  app.use((req, res) => {
    const known = API_ROUTES.find((r) => r.pattern.test(req.path));
    if (known) return send(res, { allowed: known.methods }, Codes.METHOD_INVALID);
    if (req.method === 'GET' && req.accepts('html') && existsSync(webIndex)) return res.sendFile(webIndex);
    res.status(404).json({ code: Codes.METHOD_INVALID, message: 'Not found', data: {} });
  });

  app.use(errorHandler);
  return app;
}

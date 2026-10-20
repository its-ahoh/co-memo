import { Pool, assertSchema } from './db.js';
import { api } from './http.js';
if (!process.env.DATABASE_URL || !process.env.CURSOR_SIGNING_KEY)
  throw new Error('DATABASE_URL and CURSOR_SIGNING_KEY are required');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 3000,
});
await assertSchema(pool);
const server = api(pool, Buffer.from(process.env.CURSOR_SIGNING_KEY, 'base64url'));
server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () =>
  console.log('M1 API listening on loopback'),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close(() => {
      void pool.end();
    });
  });

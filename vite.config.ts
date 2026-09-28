// ============================================================================
// FILE: vite.config.ts
// MODULE: PROPER VITE PLUGIN BACKEND FOR QUANT APIS & LLM EVENT GATEWAY
// ============================================================================

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { AI_GATEWAY_MAX_BODY_BYTES } from './src/lib/aiGatewayContract';
import { handleAiGatewayRequest } from './server/aiGateway';
import { handleMarketGatewayRequest } from './server/marketGateway';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'quant-api-gateway',
        configureServer(server) {
          // 1. DEVELOPMENT MARKET ADAPTER: delegate to the shared market gateway.
          const useMarketGateway = (mountPath: string) => {
            server.middlewares.use(mountPath, async (req, res, next) => {
              const requestUrl = new URL(req.url || '/', 'http://localhost');
              const pathname = requestUrl.pathname.startsWith(mountPath)
                ? requestUrl.pathname
                : `${mountPath}${requestUrl.pathname}`;
              const result = await handleMarketGatewayRequest({
                method: req.method,
                pathname,
                query: requestUrl.searchParams,
              });

              if (result === null) {
                next();
                return;
              }

              res.statusCode = result.statusCode;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('X-Content-Type-Options', 'nosniff');
              res.end(JSON.stringify(result.body));
            });
          };

          useMarketGateway('/api/binance');
          useMarketGateway('/api/yahoo');
          useMarketGateway('/api/vndirect/finfo');
          useMarketGateway('/api/vndirect/dchart');

          // 3. LOCAL/DEV ADAPTER: SAME-ORIGIN AI GATEWAY CONTRACT
          // This Vite middleware is not the final production hosting topology.
          server.middlewares.use('/api/ai-advisor', async (req, res) => {
            const bodyChunks: Buffer[] = [];
            let bodyByteLength = 0;
            req.on('data', chunk => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              bodyByteLength += buffer.byteLength;
              if (bodyByteLength <= AI_GATEWAY_MAX_BODY_BYTES) bodyChunks.push(buffer);
            });
            req.on('end', async () => {
              const result = await handleAiGatewayRequest(
                {
                  method: req.method,
                  rawBody: Buffer.concat(bodyChunks).toString('utf8'),
                  bodyByteLength,
                },
                { apiKey: env.GEMINI_API_KEY }
              );
              res.statusCode = result.statusCode;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result.body));
            });
          });

          // 4. DORMANT EVENT ADAPTER: intentionally unavailable until a
          // canonical production event source and consumer are approved.
          // Register at the root so Connect does not rewrite req.url before
          // exact-path and nested-path semantics are distinguished.
          server.middlewares.use((req, res, next) => {
            const pathname = new URL(req.url || '/', 'http://localhost').pathname;
            const quantEventsPath = '/api/quant-events';
            if (pathname !== quantEventsPath && !pathname.startsWith(`${quantEventsPath}/`)) {
              next();
              return;
            }

            if (pathname !== quantEventsPath) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('X-Content-Type-Options', 'nosniff');
              res.setHeader('X-Frame-Options', 'DENY');
              res.end(JSON.stringify({
                error: {
                  code: 'NOT_FOUND',
                  message: 'API route not found',
                },
              }));
              return;
            }

            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.setHeader('Allow', 'GET');
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('X-Content-Type-Options', 'nosniff');
              res.end(JSON.stringify({
                error: {
                  code: 'METHOD_NOT_ALLOWED',
                  message: 'Method not allowed',
                },
              }));
              return;
            }

            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.end(JSON.stringify({
              status: 'FAILURE',
              error: {
                code: 'UNAVAILABLE',
                message: 'Quant event feed is not connected to a production source.',
              },
            }));
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
    },
    build: {
      manifest: true,
    },
  };
});

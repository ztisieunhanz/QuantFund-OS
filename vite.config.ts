import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      configureServer(server) {
        // PROXY DÀNH CHO YAHOO FINANCE: Giữ nguyên không thay đổi
        server.middlewares.use('/api/yahoo', async (req, res) => {
          try {
            const targetUrl = `https://query1.finance.yahoo.com${req.url || ''}`;
            const response = await fetch(targetUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
              },
            });

            const data = await response.text();
            res.statusCode = response.status;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(data);
          } catch (err: any) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Failed to proxy Yahoo Finance', details: err.message }));
          }
        });

        // HANDLER DÀNH CHO GEMINI AI (Đã tối ưu hóa xử lý Auth Header & Endpoint)
        server.middlewares.use('/api/ai-advisor', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { prompt } = JSON.parse(body);
              const apiKey = (env.VITE_GEMINI_API_KEY || '').trim();

              if (!apiKey) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: { message: 'VITE_GEMINI_API_KEY is missing in environment variables.' } }));
                return;
              }

              const authHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
              };

              let targetAiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

              // Phân biệt chuẩn xác loại Key để tránh lỗi 400/403 Bad Request từ Google API
              if (apiKey.startsWith('AQ.')) {
                authHeaders['Authorization'] = `Bearer ${apiKey}`;
              } else if (apiKey.startsWith('AIzaSy')) {
                targetAiUrl = `${targetAiUrl}?key=${apiKey}`;
              } else {
                authHeaders['x-goog-api-key'] = apiKey;
              }

              const response = await fetch(targetAiUrl, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.2 }
                })
              });

              const responseText = await response.text();
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = response.status;
              res.end(responseText);
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: { message: err.message } }));
            }
          });
        });
      }
    }
  };
});
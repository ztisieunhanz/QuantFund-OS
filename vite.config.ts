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

              // Tự động nhận diện loại key: AQ. dùng Bearer, AIzaSy dùng x-goog-api-key
              const authHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
              };

              if (apiKey.startsWith('AQ.')) {
                authHeaders['Authorization'] = `Bearer ${apiKey}`;
              } else {
                authHeaders['x-goog-api-key'] = apiKey;
              }

              const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {
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
              res.end(responseText); // Trả về nguyên bản text để frontend tự xử lý an toàn
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
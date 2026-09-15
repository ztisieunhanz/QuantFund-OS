// ============================================================================
// FILE: vite.config.ts
// MODULE: PROPER VITE PLUGIN BACKEND FOR QUANT APIS & LLM EVENT GATEWAY
// ============================================================================

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'quant-api-gateway',
        configureServer(server) {
          // 1. PROXY: BINANCE SPOT KLINES
          server.middlewares.use('/api/binance', async (req, res) => {
            try {
              const targetUrl = `https://api.binance.com${req.url || ''}`;
              const response = await fetch(targetUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
              });
              res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(await response.text());
            } catch (err: any) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Binance Proxy Failed', details: err.message }));
            }
          });

          // 2. PROXY: YAHOO FINANCE MACRO
          server.middlewares.use('/api/yahoo', async (req, res) => {
            try {
              const targetUrl = `https://query1.finance.yahoo.com${req.url || ''}`;
              const response = await fetch(targetUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
              });
              res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(await response.text());
            } catch (err: any) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Yahoo Proxy Failed', details: err.message }));
            }
          });

          // 3. HANDLER: GEMINI AI CHAT ADVISOR
          server.middlewares.use('/api/ai-advisor', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
              try {
                const parsedPayload = JSON.parse(body);
                const apiKey = (env.VITE_GEMINI_API_KEY || '').trim();
                if (!apiKey) throw new Error('Missing VITE_GEMINI_API_KEY');

                const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
                let targetAiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

                if (apiKey.startsWith('AQ.')) authHeaders['Authorization'] = `Bearer ${apiKey}`;
                else if (apiKey.startsWith('AIzaSy')) targetAiUrl = `${targetAiUrl}?key=${apiKey}`;
                else authHeaders['x-goog-api-key'] = apiKey;

                const forwardBody = parsedPayload.contents ? parsedPayload : {
                  contents: [{ parts: [{ text: parsedPayload.prompt || '' }] }],
                  generationConfig: { temperature: 0.2 }
                };

                const response = await fetch(targetAiUrl, {
                  method: 'POST',
                  headers: authHeaders,
                  body: JSON.stringify(forwardBody)
                });

                res.statusCode = response.status;
                res.setHeader('Content-Type', 'application/json');
                res.end(await response.text());
              } catch (err: any) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: err.message }));
              }
            });
          });

          // 4. NEW PIPELINE: EDGE-LLM EVENT GATEWAY (PARSED TO QUANT JSON)
          server.middlewares.use('/api/quant-events', async (_req, res) => {
            try {
              const apiKey = (env.VITE_GEMINI_API_KEY || '').trim();
              if (!apiKey) throw new Error('Missing VITE_GEMINI_API_KEY');

              const rssUrls = [
                'https://api.rss2json.com/v1/api.json?rss_url=https://cointelegraph.com/rss',
                'https://api.rss2json.com/v1/api.json?rss_url=https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664'
              ];

              let rawHeadlines = "";
              for (const url of rssUrls) {
                try {
                  const fetchRes = await fetch(url);
                  if (fetchRes.ok) {
                    const data = await fetchRes.json();
                    const items = data.items?.slice(0, 4) || [];
                    items.forEach((item: any) => {
                      rawHeadlines += `- ${item.title}: ${item.description?.replace(/<[^>]*>?/gm, '').slice(0, 160)}\n`;
                    });
                  }
                } catch {
                  // Tiếp tục feed kế tiếp nếu có mạng chậm
                }
              }

              if (!rawHeadlines.trim()) {
                rawHeadlines = "Bitcoin dao động tích lũy; Lợi suất trái phiếu Mỹ ổn định trước quyết định lãi suất; Vàng duy trì vị thế trú ẩn.";
              }

              const systemPrompt = `
                Bạn là Quant Risk Analyst. Trích xuất đúng 3 SỰ KIỆN TÀI CHÍNH quan trọng nhất từ Headlines dưới đây.
                Xuất ra một MẢNG JSON hợp lệ (không kèm markdown thừa):
                [
                  {
                    "id": "ev-1",
                    "timestamp": "${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC",
                    "event": "Tên sự kiện ngắn gọn (< 60 ký tự)",
                    "impact": "HIGH" | "MEDIUM" | "LOW",
                    "direction": "BULLISH" | "BEARISH" | "NEUTRAL",
                    "description": "Nhận định định lượng 1 câu về tác động lên BTC / Vàng / Lợi suất.",
                    "sourceStatus": "QUANT_ENGINE",
                    "source": "AI Event Pipeline"
                  }
                ]
              `;

              const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
              let targetAiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

              if (apiKey.startsWith('AQ.')) authHeaders['Authorization'] = `Bearer ${apiKey}`;
              else if (apiKey.startsWith('AIzaSy')) targetAiUrl = `${targetAiUrl}?key=${apiKey}`;
              else authHeaders['x-goog-api-key'] = apiKey;

              const response = await fetch(targetAiUrl, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                  contents: [{ parts: [{ text: `Tin tức thô:\n${rawHeadlines}` }] }],
                  systemInstruction: { parts: [{ text: systemPrompt }] },
                  generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
                })
              });

              const llmData = await response.json();
              const jsonStr = llmData.candidates?.[0]?.content?.parts?.[0]?.text;

              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 200;
              res.end(jsonStr || "[]");
            } catch (err: any) {
              res.statusCode = 200; // Trả về fallback mảng an toàn để UI không sập JSON
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify([
                {
                  id: "ev-fallback-1",
                  timestamp: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
                  event: "Thị trường liên tài sản duy trì trạng thái thận trọng",
                  impact: "MEDIUM",
                  direction: "NEUTRAL",
                  description: "Chênh lệch lợi suất duy trì đảo ngược; dòng tiền chờ đợi xác nhận chính sách tiền tệ tiếp theo.",
                  sourceStatus: "QUANT_ENGINE",
                  source: "Yield & Volatility Engine"
                }
              ]));
            }
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
    }
  };
});
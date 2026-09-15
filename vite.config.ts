// ============================================================================
// FILE: vite.config.ts
// MODULE: EDGE-LLM GATEWAY & PROXY AGGREGATOR
// ============================================================================

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
        // 1. PROXY: BINANCE (Kéo nến thật)
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
            res.end(JSON.stringify({ error: 'Binance Proxy Failed' }));
          }
        });

        // 2. PROXY: YAHOO FINANCE (Kéo Vĩ mô)
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
            res.end(JSON.stringify({ error: 'Yahoo Proxy Failed' }));
          }
        });

        // 3. HANDLER: GEMINI AI CHAT (Giữ nguyên đã fix model flash-latest)
        server.middlewares.use('/api/ai-advisor', async (req, res) => {
          if (req.method !== 'POST') return res.end();
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const parsedPayload = JSON.parse(body);
              const apiKey = (env.VITE_GEMINI_API_KEY || '').trim();
              if (!apiKey) throw new Error('Missing API Key');

              const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
              let targetAiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

              if (apiKey.startsWith('AQ.')) authHeaders['Authorization'] = `Bearer ${apiKey}`;
              else if (apiKey.startsWith('AIzaSy')) targetAiUrl = `${targetAiUrl}?key=${apiKey}`;
              else authHeaders['x-goog-api-key'] = apiKey;

              const forwardBody = parsedPayload.contents ? parsedPayload : {
                contents: [{ parts: [{ text: parsedPayload.prompt || '' }] }],
                generationConfig: { temperature: 0.2 }
              };

              const response = await fetch(targetAiUrl, { method: 'POST', headers: authHeaders, body: JSON.stringify(forwardBody) });
              res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(await response.text());
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
        });

        // 4. NEW PIPELINE: EDGE-LLM QUANT EVENT GATEWAY
        // Tự động kéo tin tức tài chính miễn phí, dùng Gemini parse thành Event Định lượng
        server.middlewares.use('/api/quant-events', async (req, res) => {
          try {
            const apiKey = (env.VITE_GEMINI_API_KEY || '').trim();
            if (!apiKey) throw new Error('Missing Gemini Key for Event Pipeline');

            // Kéo feed tin tức miễn phí từ rss2json (Crypto/Macro) - Tránh cài thêm thư viện
            const rssUrls = [
              'https://api.rss2json.com/v1/api.json?rss_url=https://cointelegraph.com/rss', // Crypto
              'https://api.rss2json.com/v1/api.json?rss_url=https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664' // Finance
            ];

            let rawHeadlines = "";
            for (const url of rssUrls) {
              const fetchRes = await fetch(url);
              if (fetchRes.ok) {
                const data = await fetchRes.json();
                const items = data.items?.slice(0, 5) || [];
                items.forEach((item: any) => { rawHeadlines += `- ${item.title}: ${item.description.replace(/<[^>]*>?/gm, '').slice(0, 200)}\n`; });
              }
            }

            if (!rawHeadlines) rawHeadlines = "Thị trường biến động hẹp, chờ đợi dữ liệu vĩ mô mới.";

            // Prompt ép Gemini hoạt động như một cỗ máy trích xuất sự kiện định lượng
            const systemPrompt = `
              Phân tích các tiêu đề tin tức sau đây và trích xuất ra đúng 3 SỰ KIỆN TÀI CHÍNH quan trọng nhất.
              Trả về MẢNG JSON nghiêm ngặt theo cấu trúc sau, tuyệt đối không chứa văn bản thừa ngoài JSON:
              [
                {
                  "id": "event-unique-id",
                  "timestamp": "YYYY-MM-DD HH:MM UTC",
                  "event": "Tiêu đề sự kiện cực kỳ ngắn gọn (Vd: SEC phê duyệt ETF, FED giữ nguyên lãi suất)",
                  "impact": "HIGH" hoặc "MEDIUM" hoặc "LOW",
                  "direction": "BULLISH" hoặc "BEARISH" hoặc "NEUTRAL",
                  "description": "Phân tích 1 câu tác động định lượng lên giá BTC/Vàng/USD.",
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
                contents: [{ parts: [{ text: `Headlines:\n${rawHeadlines}` }] }],
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
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Event Pipeline Failed', details: err.message }));
          }
        });

      }
    }
  };
});
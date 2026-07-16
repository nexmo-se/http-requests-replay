const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Load log file ──────────────────────────────────────────────────────────────
app.post('/api/load', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: `File not found: ${resolved}` });
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const data = JSON.parse(raw);
    const requests = (data.requests || []).reverse();
    res.json({ requests, total: requests.length });
  } catch (e) {
    res.status(500).json({ error: `Failed to parse file: ${e.message}` });
  }
});

// ── Check if file exists ───────────────────────────────────────────────────────
app.post('/api/exists', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.json({ exists: false });
  res.json({ exists: fs.existsSync(path.resolve(filePath)) });
});

// ── Save log file ──────────────────────────────────────────────────────────────
app.post('/api/save', (req, res) => {
  const { filePath, requests } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });
  try {
    const out = { uri: '/api/requests/http', requests };
    fs.writeFileSync(path.resolve(filePath), JSON.stringify(out, null, 2), 'utf8');
    res.json({ ok: true, saved: requests.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Replay a single request ────────────────────────────────────────────────────
app.post('/api/replay', async (req, res) => {
  const { targetUrl, method, headers, body } = req.body;
  if (!targetUrl) return res.status(400).json({ error: 'targetUrl is required' });
  try {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const bodyBuffer = body ? Buffer.from(body, 'utf8') : null;
    const skip = new Set(['content-length','transfer-encoding','connection','keep-alive',
      'upgrade','proxy-authorization','x-forwarded-for','x-forwarded-host','x-forwarded-proto','host']);
    const safeHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (!skip.has(k.toLowerCase())) safeHeaders[k] = Array.isArray(v) ? v[0] : v;
    }
    safeHeaders['Host'] = url.host;
    if (bodyBuffer) safeHeaders['Content-Length'] = bodyBuffer.length;
    const options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search, method: method || 'POST',
      headers: safeHeaders, rejectUnauthorized: false, timeout: 30000
    };
    const startTime = Date.now();
    const proxyReq = lib.request(options, (proxyRes) => {
      let responseBody = '';
      proxyRes.on('data', chunk => { responseBody += chunk; });
      proxyRes.on('end', () => {
        res.json({ status: proxyRes.statusCode, statusText: proxyRes.statusMessage,
          headers: proxyRes.headers, body: responseBody, duration: Date.now() - startTime });
      });
    });
    proxyReq.on('error', (e) => res.status(502).json({ error: e.message }));
    proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).json({ error: 'Request timed out' }); });
    if (bodyBuffer) proxyReq.write(bodyBuffer);
    proxyReq.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 HTTP Replayer running at http://localhost:${PORT}\n`));
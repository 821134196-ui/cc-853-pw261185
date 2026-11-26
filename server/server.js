'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { LockLab } = require('./lab');

const lab = new LockLab();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(Object.assign(new Error('JSON 解析失败'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(config.publicDir, relative));
  if (!filePath.startsWith(config.publicDir + path.sep) && filePath !== path.join(config.publicDir, 'index.html')) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(config.publicDir, 'index.html'), (fallbackError, index) => {
        if (fallbackError) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(index);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      try {
        const health = await lab.health();
        return sendJson(res, 200, { ok: true, ...health });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error.message, code: error.code || null });
      }
    }

    if (pathname === '/api/scenarios' && req.method === 'GET') {
      return sendJson(res, 200, { scenarios: lab.listScenarios() });
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, lab.getState());
    }

    if (pathname === '/api/runs' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const state = await lab.createRun(body.scenarioId || 'normal-block', body.options || body);
      return sendJson(res, 201, state);
    }

    if (pathname === '/api/runs/current/reset' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const state = await lab.resetCurrentRun(body);
      return sendJson(res, 201, state);
    }

    if (pathname === '/api/advance' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      try {
        const state = await lab.advance(body);
        return sendJson(res, 200, state);
      } catch (error) {
        if (error.state) return sendJson(res, error.statusCode || 500, error.state);
        throw error;
      }
    }

    if (pathname === '/api/snapshots' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const snapshot = await lab.takeSnapshot({
        budgetMs: body.budgetMs,
        intervalMs: body.intervalMs,
        reason: body.reason || 'manual-api',
      });
      return sendJson(res, 201, snapshot);
    }

    if (pathname === '/api/samples' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 300;
      return sendJson(res, 200, { samples: lab.getSamples({ limit }) });
    }

    if (pathname === '/api/analysis' && req.method === 'GET') {
      const analysis = lab.getAnalysis({
        stride: url.searchParams.get('stride') || 1,
        minIntervalMs: url.searchParams.get('minIntervalMs') || null,
      });
      if (!analysis) return sendJson(res, 409, { error: '尚未创建运行' });
      return sendJson(res, 200, analysis);
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const state = await lab.updateSettings(body);
      return sendJson(res, 200, state);
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error('[api-error]', error);
    return sendJson(res, statusCode, {
      error: error.message,
      code: error.code || null,
      statusCode,
    });
  }
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log(`Lock diagnostic bench: http://${config.host}:${config.port}`);
    console.log(`PostgreSQL target:`, config.pg.connectionString || `${config.pg.user}@${config.pg.host}:${config.pg.port}/${config.pg.database}`);
    lab.createRun('normal-block').then(() => {
      console.log('Default reproducible run is ready.');
    }).catch((error) => {
      console.warn('Could not create default run yet:', error.message);
      console.warn('Run `npm run setup`, then restart, or configure DATABASE_URL/PG*.');
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`\n${signal} received; closing...`);
      server.close();
      await lab.close().catch(() => {});
      process.exit(0);
    });
  }
}

module.exports = { server, lab };

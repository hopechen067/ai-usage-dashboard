import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exec, execSync, spawn } from 'node:child_process';
import * as initialCollector from './collector.mjs';

const PORT = Number(process.env.PORT || 4321);
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
const COLLECTOR_PATH = path.resolve(import.meta.dirname, 'collector.mjs');
const PRICING_PATH = path.resolve(import.meta.dirname, 'pricing.mjs');
const HOOK_SCRIPT_PATH = path.resolve(import.meta.dirname, 'hook-receiver.mjs').replace(/\\/g, '/');
const FLOATING_BALL_SCRIPT = path.resolve(import.meta.dirname, 'floating-ball.ps1');
const shouldOpenBrowser = process.argv.includes('--open');
const shouldOpenWidget = process.argv.includes('--widget');

let activeCollector = initialCollector;
let lastCollectorSig = '';
try {
  lastCollectorSig = `${fs.statSync(COLLECTOR_PATH).mtimeMs}:${fs.statSync(PRICING_PATH).mtimeMs}`;
} catch {}

async function getCollector() {
  try {
    const sig = `${fs.statSync(COLLECTOR_PATH).mtimeMs}:${fs.statSync(PRICING_PATH).mtimeMs}`;
    if (sig !== lastCollectorSig) {
      lastCollectorSig = sig;
      const modUrl = `${pathToFileURL(COLLECTOR_PATH).href}?v=${Date.now()}`;
      activeCollector = await import(modUrl);
    }
  } catch {}
  return activeCollector;
}

function launchFloatingBall() {
  if (process.platform !== 'win32') {
    return { ok: false, error: '当前仅支持 Windows 原生桌面悬浮球' };
  }
  if (!fs.existsSync(FLOATING_BALL_SCRIPT)) {
    return { ok: false, error: '未找到 floating-ball.ps1 脚本' };
  }
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Sta',
      '-File',
      FLOATING_BALL_SCRIPT,
      '-Port',
      String(PORT)
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  );
  child.unref();
  return { ok: true, pid: child.pid };
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(` explorer "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      const daysParam = url.searchParams.get('days') || '30';
      const days =
        daysParam === 'all' || daysParam === 'today' ? daysParam : Number(daysParam) || 30;
      const collector = await getCollector();
      const snapshot = await collector.getDashboardSnapshot({ days });
      snapshot.hookScriptPath = HOOK_SCRIPT_PATH;
      return sendJson(res, 200, snapshot);
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const collector = await getCollector();
      const updated = collector.saveUserSettings(body);
      return sendJson(res, 200, { ok: true, settings: updated });
    }

    if (req.method === 'POST' && url.pathname === '/api/live-quota') {
      const body = await readJsonBody(req);
      if (!body.platform) return sendJson(res, 400, { error: 'Missing platform' });
      const collector = await getCollector();
      const updated = collector.saveLiveQuota(body.platform, body);
      return sendJson(res, 200, { ok: true, liveQuota: updated });
    }

    if (req.method === 'POST' && url.pathname === '/api/launch-widget') {
      const result = launchFloatingBall();
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    if (req.method === 'GET' && (url.pathname === '/voxel-orb.ico' || url.pathname === '/favicon.ico')) {
      const icoPath = path.join(PUBLIC_DIR, 'voxel-orb.ico');
      if (fs.existsSync(icoPath)) {
        const buf = fs.readFileSync(icoPath);
        res.writeHead(200, {
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=86400'
        });
        return res.end(buf);
      }
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const htmlPath = path.join(PUBLIC_DIR, 'index.html');
      const content = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      return res.end(content);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

let retriedPortReplace = false;

function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', timeout: 3000 });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (/LISTENING/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          const pid = Number(parts.at(-1));
          if (pid && pid !== process.pid) pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch {}
      }
      return pids.size > 0;
    } else {
      execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: 'ignore', timeout: 3000 });
      return true;
    }
  } catch {
    return false;
  }
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    if (!retriedPortReplace && killProcessOnPort(PORT)) {
      retriedPortReplace = true;
      console.log(`  检测到旧版后台服务占用端口 ${PORT}，正在自动热替换重启...`);
      setTimeout(() => {
        server.listen(PORT, '127.0.0.1');
      }, 350);
      return;
    }
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`================================================================`);
    console.log(`  全局使用量仪表盘服务已在后台运行中！`);
    console.log(`  直接访问: ${url}`);
    console.log(`================================================================`);
    if (shouldOpenBrowser) {
      openBrowser(url);
    }
    if (shouldOpenWidget) {
      launchFloatingBall();
    }
    process.exit(0);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`================================================================`);
  console.log(`  AI Usage & Quota Global Dashboard 已启动！`);
  console.log(`  浏览器访问地址: ${url}`);
  console.log(`================================================================`);
  if (shouldOpenBrowser) {
    openBrowser(url);
  }
  if (shouldOpenWidget) {
    launchFloatingBall();
  }
});

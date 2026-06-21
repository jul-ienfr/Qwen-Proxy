#!/usr/bin/env node
/**
 * E2E Integration Test — Verifies all speed optimizations work together
 *
 * Usage:
 *   node bench/e2e-test.js [--url http://localhost:3000] [--api-key xxx]
 */

const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const BASE_URL = getArg('--url', 'http://localhost:3000');
const API_KEY = getArg('--api-key', '');

function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function api(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const client = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

    const req = client.request(url, { method: options.method || 'GET', headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testHealthCheck() {
  console.log('\n📋 Health Check');
  const res = await api('/health');
  assert('Status is healthy', res.status === 200, `got ${res.status}`);
  assert('Browser connected', res.data?.browser?.connected === true);
  assert('Accounts available', res.data?.accounts?.total > 0);
  assert('TLS pool exists', res.data?.tlsPool !== undefined);
  assert('Signaling exists', res.data?.signaling !== undefined);
  return res.data;
}

async function testPerformanceEndpoint() {
  console.log('\n⚡ Performance Endpoint');
  const res = await api('/v1/performance');
  assert('Performance endpoint responds', res.status === 200);
  assert('Has pathSelection', typeof res.data?.pathSelection === 'string');
  assert('Has pathStats', typeof res.data?.pathStats === 'object');
  assert('Has config', typeof res.data?.config === 'object');
  assert('FastStreamProxy config', res.data?.config?.fastStreamProxy === true);
  assert('DirectFetch config', res.data?.config?.directFetch === true);
  assert('TLS Pool Size', res.data?.config?.tlsPoolSize > 0);
  return res.data;
}

async function testModelsEndpoint() {
  console.log('\n🤖 Models Endpoint');
  const res = await api('/v1/models');
  assert('Models endpoint responds', res.status === 200);
  assert('Has models array', Array.isArray(res.data?.data));
  assert('Has qwen models', res.data?.data?.length > 0);
  return res.data;
}

async function testWebSocketSignaling() {
  console.log('\n📡 WebSocket Signaling');
  const wsUrl = BASE_URL.replace('http', 'ws') + '/ws/signaling';

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let receivedWelcome = false;

    const timeout = setTimeout(() => {
      ws.close();
      assert('WebSocket connected', false, 'timeout');
      resolve();
    }, 5000);

    ws.on('open', () => {
      assert('WebSocket connected', true);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'welcome') {
          receivedWelcome = true;
          clearTimeout(timeout);
          assert('Received welcome message', true);
          assert('Has clientId', typeof msg.clientId === 'string');

          // Test auth
          ws.send(JSON.stringify({ type: 'auth', apiKey: API_KEY || 'test' }));
        }
        if (msg.type === 'auth:success') {
          assert('Authentication successful', true);
          assert('Has accountId', typeof msg.accountId === 'string');
          assert('Has headers', typeof msg.headers === 'object');
          ws.close();
          resolve();
        }
        if (msg.type === 'error') {
          // Auth might fail with test key, that's ok
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch {}
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      assert('WebSocket no error', false, err.message);
      resolve();
    });
  });
}

async function testStreamingEndpoint() {
  console.log('\n🚀 Streaming Endpoint');

  return new Promise((resolve) => {
    const url = new URL('/v1/chat/completions', BASE_URL);
    const client = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

    const body = JSON.stringify({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'Say hi in 2 words.' }],
      stream: true,
    });

    const startTime = Date.now();
    let firstByteTime = 0;
    let chunkCount = 0;

    const req = client.request(url, { method: 'POST', headers }, (res) => {
      assert('Streaming response status', res.statusCode === 200, `got ${res.statusCode}`);

      res.on('data', (chunk) => {
        if (firstByteTime === 0) firstByteTime = Date.now() - startTime;
        chunkCount++;
      });

      res.on('end', () => {
        const totalTime = Date.now() - startTime;
        assert('Has streaming data', chunkCount > 0, `${chunkCount} chunks`);
        assert('TTFB < 5000ms', firstByteTime < 5000, `${firstByteTime}ms`);
        assert('Total time < 30000ms', totalTime < 30000, `${totalTime}ms`);
        console.log(`  📊 TTFB: ${firstByteTime}ms, Total: ${totalTime}ms, Chunks: ${chunkCount}`);
        resolve();
      });
    });

    req.on('error', (err) => {
      assert('Streaming request succeeded', false, err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

async function testConfigHotReload() {
  console.log('\n🔄 Config Hot-Reload');

  // Read current config
  const res1 = await api('/api/config/server?section=server');
  assert('Config endpoint responds', res1.status === 200);

  // Toggle fastStreamProxy
  const res2 = await api('/api/config/server', {
    method: 'PUT',
    body: { path: 'fastStreamProxy', value: false },
  });
  assert('Config update succeeds', res2.data?.success === true);
  assert('Old value was true', res2.data?.oldValue === true);
  assert('New value is false', res2.data?.newValue === false);

  // Verify
  const res3 = await api('/v1/performance');
  assert('Config reflected in performance', res3.data?.config?.fastStreamProxy === false);

  // Restore
  await api('/api/config/server', {
    method: 'PUT',
    body: { path: 'fastStreamProxy', value: true },
  });
}

async function testMetricsEndpoint() {
  console.log('\n📈 Metrics Endpoint');
  const res = await api('/metrics');
  assert('Metrics endpoint responds', res.status === 200);
  assert('Metrics is text format', typeof res.data === 'string');
}

async function testHistoryEndpoint() {
  console.log('\n📋 History Endpoint');
  const res = await api('/api/history');
  assert('History endpoint responds', res.status === 200 || res.status === 404);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        QwenProxy E2E Integration Test — Speed Optimizations ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  Target: ${BASE_URL}\n`);

  try {
    await testHealthCheck();
    await testPerformanceEndpoint();
    await testModelsEndpoint();
    await testWebSocketSignaling();
    await testStreamingEndpoint();
    await testConfigHotReload();
    await testMetricsEndpoint();
    await testHistoryEndpoint();
  } catch (err) {
    console.error(`\n💥 Fatal error: ${err.message}`);
    failed++;
  }

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${passed} passed, ${failed} failed${' '.repeat(Math.max(0, 35 - String(passed).length - String(failed).length))}║`);
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  process.exit(failed > 0 ? 1 : 0);
}

main();

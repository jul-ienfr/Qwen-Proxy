#!/usr/bin/env node
/**
 * QwenProxy Speed Benchmark — Mesure les gains réels de chaque phase
 *
 * Usage:
 *   node bench/speed-test.js [--url http://localhost:3000] [--api-key xxx] [--iterations 10]
 *
 * Tests:
 *   1. TTFB (Time To First Byte) — direct fetch vs browser fetch
 *   2. Streaming throughput — chunks/seconde
 *   3. Cache hit latency
 *   4. TLS pool warm vs cold
 *   5. End-to-end comparison
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ─── Configuration ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const BASE_URL = getArg('--url', 'http://localhost:3000');
const API_KEY = getArg('--api-key', '');
const ITERATIONS = parseInt(getArg('--iterations', '5'), 10);
const WARMUP = parseInt(getArg('--warmup', '2'), 10);

function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

function makeRequest(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (API_KEY) {
      reqHeaders['Authorization'] = `Bearer ${API_KEY}`;
    }

    const req = client.request(url, {
      method: 'POST',
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function makeStreamingRequest(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (API_KEY) {
      reqHeaders['Authorization'] = `Bearer ${API_KEY}`;
    }

    const startTime = process.hrtime.bigint();
    let firstByteTime = 0;
    let chunkCount = 0;
    let totalBytes = 0;

    const req = client.request(url, {
      method: 'POST',
      headers: reqHeaders,
    }, (res) => {
      res.on('data', (chunk) => {
        if (firstByteTime === 0) {
          firstByteTime = Number(process.hrtime.bigint() - startTime) / 1e6;
        }
        chunkCount++;
        totalBytes += chunk.length;
      });

      res.on('end', () => {
        const totalMs = Number(process.hrtime.bigint() - startTime) / 1e6;
        resolve({
          status: res.statusCode,
          ttfb: firstByteTime,
          totalMs,
          chunkCount,
          totalBytes,
          throughput: totalBytes / (totalMs / 1000),
        });
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Benchmark Tests ─────────────────────────────────────────────────────────

async function testHealthCheck() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  🔍 Health Check');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    const url = new URL('/health', BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const data = await new Promise((resolve, reject) => {
      client.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    console.log(`  Status: ${data.status}`);
    console.log(`  Uptime: ${Math.round(data.uptime)}s`);
    console.log(`  Memory: ${Math.round(data.memory.heapUsed / 1024 / 1024)}MB`);
    console.log(`  Browser: ${data.browser.connected ? '✅' : '❌'}`);
    console.log(`  Accounts: ${data.accounts.total} (${data.accounts.active} active)`);

    if (data.tlsPool) {
      console.log(`  TLS Pool: ${data.tlsPool.alive}/${data.tlsPool.total} sessions, ${data.tlsPool.totalRequests} requests`);
    }

    if (data.signaling) {
      console.log(`  Signaling: ${data.signaling.connectedClients} clients, ${data.signaling.activeChats} chats`);
    }

    return data;
  } catch (err) {
    console.error(`  ❌ Health check failed: ${err.message}`);
    return null;
  }
}

async function testPerformanceConfig() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ⚡ Performance Config');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    const url = new URL('/v1/performance', BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const data = await new Promise((resolve, reject) => {
      const reqHeaders = {};
      if (API_KEY) reqHeaders['Authorization'] = `Bearer ${API_KEY}`;

      client.get(url, { headers: reqHeaders }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    console.log(`  Path Selection: ${data.pathSelection}`);
    console.log(`  Fast Stream Proxy: ${data.config.fastStreamProxy ? '✅' : '❌'}`);
    console.log(`  WS Bridge: ${data.config.useWsBridge ? '✅' : '❌'}`);
    console.log(`  Direct Fetch: ${data.config.directFetch ? '✅' : '❌'}`);
    console.log(`  TLS Pool Size: ${data.config.tlsPoolSize}`);

    if (data.pathStats) {
      console.log('\n  Path Stats:');
      for (const [path, stats] of Object.entries(data.pathStats)) {
        if (stats.requestCount > 0) {
          console.log(`    ${path}: avg=${stats.avgLatency}ms, ttfb=${stats.avgTTFB}ms, success=${stats.successRate}%, count=${stats.requestCount}`);
        }
      }
    }

    return data;
  } catch (err) {
    console.error(`  ❌ Performance config failed: ${err.message}`);
    return null;
  }
}

async function testStreamingLatency() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  🚀 Streaming Latency Benchmark');
  console.log('═══════════════════════════════════════════════════════════════');

  const testBody = {
    model: 'qwen-plus',
    messages: [{ role: 'user', content: 'Say "hello world" in exactly 3 words.' }],
    stream: true,
  };

  // Warmup
  console.log(`  Warming up (${WARMUP} iterations)...`);
  for (let i = 0; i < WARMUP; i++) {
    try {
      await makeStreamingRequest('/v1/chat/completions', testBody);
    } catch {}
  }

  // Benchmark
  const results = [];
  console.log(`  Running ${ITERATIONS} iterations...`);

  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const result = await makeStreamingRequest('/v1/chat/completions', testBody);
      results.push(result);
      process.stdout.write(`  [${i + 1}/${ITERATIONS}] TTFB: ${result.ttfb.toFixed(1)}ms, Total: ${result.totalMs.toFixed(1)}ms, Chunks: ${result.chunkCount}, Throughput: ${Math.round(result.throughput)}B/s\n`);
    } catch (err) {
      console.error(`  [${i + 1}/${ITERATIONS}] ❌ Error: ${err.message}`);
    }
  }

  if (results.length === 0) {
    console.log('  ❌ No successful requests');
    return null;
  }

  // Calculate stats
  const avgTTFB = results.reduce((s, r) => s + r.ttfb, 0) / results.length;
  const avgTotal = results.reduce((s, r) => s + r.totalMs, 0) / results.length;
  const avgChunks = results.reduce((s, r) => s + r.chunkCount, 0) / results.length;
  const avgThroughput = results.reduce((s, r) => s + r.throughput, 0) / results.length;
  const minTTFB = Math.min(...results.map(r => r.ttfb));
  const maxTTFB = Math.max(...results.map(r => r.ttfb));

  console.log('\n  ─── Results ─────────────────────────────────────────────');
  console.log(`  Avg TTFB:      ${avgTTFB.toFixed(1)}ms (min: ${minTTFB.toFixed(1)}ms, max: ${maxTTFB.toFixed(1)}ms)`);
  console.log(`  Avg Total:     ${avgTotal.toFixed(1)}ms`);
  console.log(`  Avg Chunks:    ${avgChunks.toFixed(0)}`);
  console.log(`  Avg Throughput: ${Math.round(avgThroughput)}B/s`);
  console.log(`  Success Rate:  ${(results.length / ITERATIONS * 100).toFixed(0)}%`);

  return { avgTTFB, avgTotal, avgChunks, avgThroughput };
}

async function testCachePerformance() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  💾 Cache Performance');
  console.log('═══════════════════════════════════════════════════════════════');

  const testBody = {
    model: 'qwen-plus',
    messages: [{ role: 'user', content: 'What is 2+2?' }],
    stream: false,
  };

  // First request (cache miss)
  console.log('  Request 1 (cache miss)...');
  const start1 = Date.now();
  try {
    await makeRequest('/v1/chat/completions', testBody);
    const missTime = Date.now() - start1;
    console.log(`  Cache miss: ${missTime}ms`);

    // Second request (cache hit)
    console.log('  Request 2 (cache hit)...');
    const start2 = Date.now();
    await makeRequest('/v1/chat/completions', testBody);
    const hitTime = Date.now() - start2;
    console.log(`  Cache hit: ${hitTime}ms`);
    console.log(`  Speedup: ${(missTime / hitTime).toFixed(1)}x`);

    return { missTime, hitTime };
  } catch (err) {
    console.error(`  ❌ Cache test failed: ${err.message}`);
    return null;
  }
}

async function testTLSPool() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  🔐 TLS Pool Benchmark');
  console.log('═══════════════════════════════════════════════════════════════');

  const testBody = {
    model: 'qwen-plus',
    messages: [{ role: 'user', content: 'Say hi' }],
    stream: true,
  };

  // Cold start (no pool)
  console.log('  Cold start (first request)...');
  const coldStart = Date.now();
  try {
    await makeStreamingRequest('/v1/chat/completions', testBody);
    const coldTime = Date.now() - coldStart;
    console.log(`  Cold: ${coldTime}ms`);

    // Warm requests (pool active)
    const warmTimes = [];
    for (let i = 0; i < 3; i++) {
      const warmStart = Date.now();
      await makeStreamingRequest('/v1/chat/completions', testBody);
      warmTimes.push(Date.now() - warmStart);
    }

    const avgWarm = warmTimes.reduce((a, b) => a + b, 0) / warmTimes.length;
    console.log(`  Warm avg: ${avgWarm.toFixed(0)}ms`);
    console.log(`  Pool speedup: ${(coldTime / avgWarm).toFixed(1)}x`);

    return { coldTime, avgWarm };
  } catch (err) {
    console.error(`  ❌ TLS pool test failed: ${err.message}`);
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║          QwenProxy Speed Benchmark — Vitesse Éclair          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Iterations: ${ITERATIONS}`);
  console.log(`  Warmup: ${WARMUP}`);

  const health = await testHealthCheck();
  if (!health) {
    console.error('\n❌ Server is not running. Start it with: npm start');
    process.exit(1);
  }

  await testPerformanceConfig();
  const streaming = await testStreamingLatency();
  const cache = await testCachePerformance();
  const tls = await testTLSPool();

  // Summary
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                      📊 Summary                              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  if (streaming) {
    console.log(`  Streaming TTFB: ${streaming.avgTTFB.toFixed(1)}ms`);
    console.log(`  Streaming Total: ${streaming.avgTotal.toFixed(1)}ms`);
  }

  if (cache) {
    console.log(`  Cache Hit Speedup: ${(cache.missTime / cache.hitTime).toFixed(1)}x`);
  }

  if (tls) {
    console.log(`  TLS Pool Speedup: ${(tls.coldTime / tls.avgWarm).toFixed(1)}x`);
  }

  console.log('\n  ✅ Benchmark complete');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Streaming benchmark — fast path vs standard path
 * Uses hot-reload API to toggle without restart
 */

const BASE = 'http://localhost:3000';
const URL = `${BASE}/v1/chat/completions`;
const CONFIG_URL = `${BASE}/v1/config/fastStreamProxy`;
const MODEL = 'qwen3.5-flash';
const PROMPT = 'Say hello in exactly 3 words';
const RUNS = 3;

async function toggleFastPath(enabled) {
  await fetch(CONFIG_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: enabled }),
  });
  await new Promise(r => setTimeout(r, 200)); // let config propagate
}

async function runStream() {
  const start = Date.now();
  let ttft = null;
  let chunks = 0;
  let content = '';

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PROMPT }],
      stream: true,
    }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        chunks++;
        if (chunk.choices?.[0]?.delta?.content) {
          if (ttft === null) ttft = Date.now() - start;
          content += chunk.choices[0].delta.content;
        }
      } catch {}
    }
  }
  return { ttft, totalMs: Date.now() - start, chunks, content };
}

async function bench(label, count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const r = await runStream();
    results.push(r);
    const ttftStr = r.ttft !== null ? `${r.ttft}ms` : 'N/A';
    console.log(`  Run ${i+1}: TTFT=${ttftStr}  Total=${r.totalMs}ms  Chunks=${r.chunks}  "${r.content.trim()}"`);
  }
  const avg = (key) => {
    const vals = results.map(r => r[key]).filter(v => v !== null && v !== undefined);
    return vals.length ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length) : null;
  };
  return { ttft: avg('ttft'), totalMs: avg('totalMs'), chunks: avg('chunks') };
}

async function main() {
  console.log(`\n🏎️  Streaming Benchmark — ${RUNS} runs each`);
  console.log(`   Model: ${MODEL} | Prompt: "${PROMPT}"\n`);

  // Warmup
  console.log('⏳ Warmup...');
  await runStream();

  // Fast path
  await toggleFastPath(true);
  console.log('\n⚡ FAST PATH (streamer writer):');
  const fast = await bench('fast', RUNS);

  // Standard path
  await toggleFastPath(false);
  console.log('\n📦 STANDARD PATH:');
  const standard = await bench('standard', RUNS);

  // Re-enable fast path
  await toggleFastPath(true);

  // Summary
  console.log('\n═══════════════════════════════════════');
  console.log('📊 RÉSULTATS');
  console.log('═══════════════════════════════════════');
  console.log(`                  Fast Path    Standard`);
  console.log(`  TTFT moyen:     ${fast.ttft ?? 'N/A'}ms      ${standard.ttft ?? 'N/A'}ms`);
  console.log(`  Total moyen:    ${fast.totalMs}ms     ${standard.totalMs}ms`);
  console.log(`  Chunks moyen:   ${fast.chunks}         ${standard.chunks}`);

  if (fast.ttft && standard.ttft) {
    const r = (standard.ttft / fast.ttft).toFixed(1);
    console.log(`\n  ⚡ TTFT:     ${r}x ${r > 1 ? 'faster' : 'slower'}`);
  }
  if (fast.totalMs && standard.totalMs) {
    const r = (standard.totalMs / fast.totalMs).toFixed(1);
    console.log(`  ⚡ Total:    ${r}x ${r > 1 ? 'faster' : 'slower'}`);
  }
  console.log('═══════════════════════════════════════\n');
}

main().catch(console.error);

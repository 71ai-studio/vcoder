// Smoke test: send a tool-calling chat and verify our XML parser extracts it.
// Run: node scripts/smoke.js
const HOST = 'http://192.168.1.220:11434';
const MODEL = 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf';
const KEY = process.env.VDSX_KEY;
if (!KEY) { console.error('Set VDSX_KEY env var.'); process.exit(1); }

function normalizeAssistant(msg) {
  let content = msg.content ?? '';
  const tool_calls = [];
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    msg.tool_calls.forEach((tc, i) => {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      tool_calls.push({ id: tc.id ?? `call_${i}`, function: { name: fn.name, arguments: args || {} } });
    });
  }
  if (tool_calls.length === 0 && content) {
    const re = /<(tool_call|tools)>\s*(\{[\s\S]*?\})\s*<\/\1>/g;
    let m, idx = 0;
    while ((m = re.exec(content)) !== null) {
      try {
        const obj = JSON.parse(m[2]);
        if (obj.name) tool_calls.push({ id: `xml_${idx++}`, function: { name: obj.name, arguments: obj.arguments ?? obj.parameters ?? {} } });
      } catch {}
    }
    if (tool_calls.length) content = content.replace(re, '').trim();
  }
  return { role: 'assistant', content, tool_calls: tool_calls.length ? tool_calls : undefined };
}

async function main() {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You have a multiply tool. Use it.' },
      { role: 'user', content: 'What is 17 times 23?' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'multiply',
        description: 'Multiply two integers',
        parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] }
      }
    }],
    temperature: 0.1,
    stream: false
  };
  const res = await fetch(HOST + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body)
  });
  console.log('HTTP', res.status);
  const data = await res.json();
  console.log('RAW message:', JSON.stringify(data.choices[0].message, null, 2));
  const parsed = normalizeAssistant(data.choices[0].message);
  console.log('PARSED:', JSON.stringify(parsed, null, 2));
  console.log('TOOL CALLS DETECTED:', parsed.tool_calls?.length ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

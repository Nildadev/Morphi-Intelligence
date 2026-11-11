/* eslint-disable */
/**
 * Live round-trip for the DeepSeek Web provider: reads server/.deepseek-auth.json (written by
 * deepseek-web-login.cjs), runs ONE real turn with a tool available, and prints the routed events.
 * Verifies outside the lab: PoW header, the patch stream, the tool-call router and the transcript
 * guard. Never prints the credential.
 *
 * Run:  npx ts-node scripts/deepseek-web-live.ts ["câu hỏi tuỳ ý"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DeepSeekWebAdapter } from '../src/harness/llm/deepseekWeb';
import type { StreamEvent } from '../src/harness/llm/types';

const AUTH_FILE = path.join(__dirname, '..', '.deepseek-auth.json');
if (!fs.existsSync(AUTH_FILE)) {
  console.error('No credential file. Run: node scripts/deepseek-web-login.cjs');
  process.exit(1);
}

const adapter = new DeepSeekWebAdapter();
adapter.setApiKey(fs.readFileSync(AUTH_FILE, 'utf8'));

const question = process.argv[2] ?? 'Trời hôm nay ở Hà Nội thế nào? Dùng tool get_weather để tra trước khi trả lời.';

const request = {
  model: 'deepseek-web',
  messages: [{ role: 'user' as const, content: question }],
  tools: [
    {
      name: 'get_weather',
      description: 'Tra thoi tiet hien tai cua mot thanh pho',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'Ten thanh pho' } },
        required: ['city'],
      },
    },
  ],
  signal: new AbortController().signal,
};

(async () => {
  const models = await adapter.listModels();
  console.log(`[live] models visible: ${models.map((m) => m.id).join(', ') || '(none — credential rejected?)'}`);
  if (models.length === 0) process.exit(1);

  console.log(`[live] turn: "${question}"`);
  let text = '';
  let thinking = '';
  for await (const event of adapter.stream(request) as AsyncIterable<StreamEvent>) {
    if (event.type === 'text_delta') {
      text += event.text;
      process.stdout.write(event.text);
    } else if (event.type === 'reasoning_delta') {
      thinking += event.text;
    } else if (event.type === 'tool_call_start') {
      console.log(`\n[live] tool_call_start: ${event.name} (${event.callId})`);
    } else if (event.type === 'tool_call_end') {
      console.log(`[live] tool_call_end: ${event.name} args=${JSON.stringify(event.args)}`);
    } else if (event.type === 'error') {
      console.log(`\n[live] ERROR ${event.error.code}: ${event.error.message}`);
    } else if (event.type === 'finish') {
      console.log(`\n[live] finish: ${event.reason}`);
    }
  }
  console.log(`[live] text ${text.length} chars, thinking ${thinking.length} chars`);
})().catch((err) => {
  console.error(`[live] failed — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

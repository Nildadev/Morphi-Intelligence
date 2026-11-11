import { describe, expect, it } from 'vitest';
import {
  buildToolsSystemPrompt,
  findToolCallMarkerStart,
  parseToolCallsFromText,
  StreamingToolCallRouter,
  stripToolCallBlocks,
  type ToolCallChunk,
} from './deepseekWebTools';

const collect = (chunks: Iterable<ToolCallChunk>): ToolCallChunk[] => [...chunks];

const toolCalls = (chunks: readonly ToolCallChunk[]): Array<{ name: string; args: unknown }> =>
  chunks
    .filter((chunk): chunk is Extract<ToolCallChunk, { type: 'tool_call' }> => chunk.type === 'tool_call')
    .map((chunk) => ({ name: chunk.name, args: JSON.parse(chunk.argumentsPart) as unknown }));

const texts = (chunks: readonly ToolCallChunk[]): string =>
  chunks
    .filter((chunk): chunk is Extract<ToolCallChunk, { type: 'text' }> => chunk.type === 'text')
    .map((chunk) => chunk.content)
    .join('');

describe('buildToolsSystemPrompt', () => {
  it('lists the tools compactly and demands the fenced protocol', () => {
    const prompt = buildToolsSystemPrompt([
      {
        name: 'studio.multi_edit',
        description: 'Edit a script in the datamodel',
        parameters: {
          properties: {
            target_file: { type: 'string' },
            edits: { type: 'array', items: { type: 'object' } },
          },
          required: ['target_file', 'edits'],
        },
      },
    ]);
    expect(prompt).toContain('# Tool usage protocol (MANDATORY)');
    expect(prompt).toContain('```tool_call');
    const listed = JSON.parse(prompt.slice(prompt.indexOf('Available tools (compact):') + 'Available tools (compact):'.length)) as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({
      name: 'studio.multi_edit',
      args: ['target_file', 'edits'],
      types: { edits: 'object[]' },
      required: ['target_file', 'edits'],
    });
  });
});

describe('parseToolCallsFromText', () => {
  it('parses the fenced protocol call', () => {
    const chunks = collect(
      parseToolCallsFromText('Tôi sẽ sửa file.\n\n```tool_call\n{"name":"studio.multi_edit","arguments":{"target_file":"a.lua","edits":[]}}\n```'),
    );
    expect(toolCalls(chunks)).toEqual([
      { name: 'studio.multi_edit', args: { target_file: 'a.lua', edits: [] } },
    ]);
    // Text before the marker never reaches this parser in the streaming router — it was already
    // emitted while the buffer was still pending — so the parse result is calls only.
    expect(texts(chunks)).toBe('');
  });

  it('parses the bare tagged form and keeps unparsable tags as text', () => {
    const good = collect(parseToolCallsFromText('<tool_call{"name":"read_file","arguments":{"path":"/a"}} Close'));
    expect(toolCalls(good)).toEqual([{ name: 'read_file', args: { path: '/a' } }]);

    const bad = collect(parseToolCallsFromText('<tool_call not json at all Close'));
    expect(toolCalls(bad)).toEqual([]);
    expect(texts(bad)).toContain('not json at all');
  });

  it('parses the Anthropic-style invoke dialect DeepSeek falls back to', () => {
    const chunks = collect(
      parseToolCallsFromText(
        '<function_calls>\n<invoke name="studio.read_file">\n<parameter name="target_file">Main.lua</parameter>\n</invoke>\n</function_calls>',
      ),
    );
    expect(toolCalls(chunks)).toEqual([{ name: 'studio.read_file', args: { target_file: 'Main.lua' } }]);
  });

  it('parses the namespaced DSML variant with fullwidth bars', () => {
    const chunks = collect(
      parseToolCallsFromText(
        '<｜｜DSML｜｜invoke name="read_file"><parameter name="filePath">/a/b.ts</parameter></｜｜DSML｜｜invoke>',
      ),
    );
    expect(toolCalls(chunks)).toEqual([{ name: 'read_file', args: { filePath: '/a/b.ts' } }]);
  });

  it('parses the attribute form and the tool_name/tool_arguments pair', () => {
    const attr = collect(parseToolCallsFromText('<tool_call name="get_errors">{"filePaths": []}'));
    expect(toolCalls(attr)).toEqual([{ name: 'get_errors', args: { filePaths: [] } }]);

    const pair = collect(
      parseToolCallsFromText('<tool_name>read_file</tool_name><tool_arguments>{"path":"x"}</tool_arguments>'),
    );
    expect(toolCalls(pair)).toEqual([{ name: 'read_file', args: { path: 'x' } }]);
  });

  it('repairs broken JSON and unwraps invented envelopes', () => {
    // A raw newline inside a string value — the most common breakage.
    const repaired = collect(
      parseToolCallsFromText('```tool_call\n{"name":"write_file","arguments":{"path":"a.lua","content":"line1\nline2"}}\n```'),
    );
    expect(toolCalls(repaired)).toEqual([
      { name: 'write_file', args: { path: 'a.lua', content: 'line1\nline2' } },
    ]);

    const wrapped = collect(parseToolCallsFromText('{"tool_call":{"name":"read_file","arguments":{"path":"p"}}}'));
    expect(toolCalls(wrapped)).toEqual([{ name: 'read_file', args: { path: 'p' } }]);
  });

  it('leaves ordinary JSON data alone; bare name(...) prose is only parsed behind a marker', () => {
    const chunks = collect(parseToolCallsFromText('Kết quả: {"name":"my-pkg","version":"1.0"}'));
    expect(toolCalls(chunks)).toEqual([]);
    expect(texts(chunks)).toContain('{"name":"my-pkg","version":"1.0"}');
  });

  it('drops the protocol example echoed back as a call', () => {
    const chunks = collect(
      parseToolCallsFromText('```tool_call\n{"name":"tool_name","arguments":{"param":"value"}}\n```'),
    );
    expect(toolCalls(chunks)).toEqual([]);
  });
});

describe('findToolCallMarkerStart / stripToolCallBlocks', () => {
  it('finds full and split markers', () => {
    expect(findToolCallMarkerStart('trước ```tool_call sau')).toBeGreaterThan(0);
    expect(findToolCallMarkerStart('trước ```tool_')).toBe(6);
    expect(findToolCallMarkerStart('không có gì')).toBe(-1);
  });

  it('strips fenced and tagged calls from final text', () => {
    expect(stripToolCallBlocks('a\n```tool_call\n{"name":"x","arguments":{}}\n```\nb')).toBe('a\n\n\n\nb');
    expect(stripToolCallBlocks('a <tool_call{"name":"x","arguments":{}} Close b')).toBe('a <tool_call Close b');
  });
});

describe('StreamingToolCallRouter', () => {
  const route = (router: StreamingToolCallRouter, pieces: string[]): ToolCallChunk[] => {
    const out: ToolCallChunk[] = [];
    for (const piece of pieces) out.push(...router.route(piece));
    out.push(...router.finish());
    return out;
  };

  it('holds a marker split across chunks and emits one complete call', () => {
    const router = new StreamingToolCallRouter(true);
    const chunks = route(router, ['Để tôi kiểm tra. ```tool', '_call\n{"name":"studio.read', '_file","arguments":{"path":"a"}}\n``` xong']);
    expect(texts(chunks)).toBe('Để tôi kiểm tra. xong');
    expect(toolCalls(chunks)).toEqual([{ name: 'studio.read_file', args: { path: 'a' } }]);
  });

  it('releases held text that turned out to be ordinary content', () => {
    const router = new StreamingToolCallRouter(true);
    const chunks = route(router, ['```json\n{"name":"my-pkg","version":"1.0"}\n```']);
    expect(toolCalls(chunks)).toEqual([]);
    expect(texts(chunks)).toContain('{"name":"my-pkg","version":"1.0"}');
  });

  it('cuts the fabricated next turn the model plays out', () => {
    const router = new StreamingToolCallRouter(true);
    const chunks = route(router, ['Xong rồi.\n\nUser: viết tiếp giúp tôi\n\nAssistant:']);
    expect(texts(chunks)).toBe('Xong rồi.');
    expect(router.cut).toBe(true);
  });

  it('does not cut transcript markers inside a code block', () => {
    const router = new StreamingToolCallRouter(true);
    const chunks = route(router, ['```\nUser: đây là ví dụ\n```\nHết.']);
    expect(router.cut).toBe(false);
    expect(texts(chunks)).toContain('User: đây là ví dụ');
    expect(texts(chunks)).toContain('Hết.');
  });

  it('strips stray closing tags that arrive alone', () => {
    const router = new StreamingToolCallRouter(true);
    const chunks = route(router, ['kết quả\n', '</tool_call', '>\nTiếp.']);
    expect(texts(chunks)).toBe('kết quả\nTiếp.');
  });

  it('passes everything through untouched when tool calls are not allowed', () => {
    const router = new StreamingToolCallRouter(false);
    const chunks = route(router, ['```tool_call\n{"name":"x","arguments":{}}\n```']);
    expect(texts(chunks)).toContain('```tool_call');
    expect(toolCalls(chunks)).toEqual([]);
  });
});

export function parseSSEChunk(buffer: string, chunk: string, flush = false): { data: string[]; rest: string } {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  const tail = lines.pop() ?? '';
  if (flush && tail.trim()) lines.push(tail);
  const data = lines.map((line) => line.trim()).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  return { data, rest: flush ? '' : tail };
}

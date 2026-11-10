/**
 * Incremental Server-Sent Events parser.
 *
 * Feed raw decoded chunks with `feed(chunk)`. Call `feed('', true)` once the
 * stream ends to flush a trailing line that was not newline-terminated.
 */
export function createSSEParser(onData: (data: string) => void) {
  let buffer = '';
  return (chunk: string, flush = false) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = flush ? '' : lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) onData(trimmed.slice(5).trim());
    }
  };
}

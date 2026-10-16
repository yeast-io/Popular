export async function* readSseJsonStream<T>(response: Response): AsyncIterable<T> {
  if (!response.body) throw new Error('Streaming response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let boundary = findEventBoundary(buffer);
    while (boundary) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const parsed = parseEventBlock<T>(block);
      if (parsed !== undefined) yield parsed;
      boundary = findEventBoundary(buffer);
    }

    if (done) break;
  }

  const parsed = parseEventBlock<T>(buffer);
  if (parsed !== undefined) yield parsed;
}

function findEventBoundary(value: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseEventBlock<T>(block: string): T | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return undefined;
  return JSON.parse(data) as T;
}

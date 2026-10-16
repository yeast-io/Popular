import { describe, expect, it } from 'vitest';
import { readSseJsonStream } from './sse';

describe('SSE JSON reader', () => {
  it('parses events split across chunks and UTF-8 code points', async () => {
    const bytes = new TextEncoder().encode([
      'event: delta\r\n',
      'data: {"type":"delta","delta":"你"}\r\n\r\n',
      'event: completed\n',
      'data: {"type":"completed"}\n\n',
    ].join(''));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const response = new Response(body);
    const events = [];

    for await (const event of readSseJsonStream(response)) events.push(event);

    expect(events).toEqual([
      { type: 'delta', delta: '你' },
      { type: 'completed' },
    ]);
  });
});

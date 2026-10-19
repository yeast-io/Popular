export async function loadTmdbPoster(path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  if (!/^\/[a-zA-Z0-9_.-]+\.(jpg|png|webp)$/i.test(path)) return;
  const response = await fetch(`https://image.tmdb.org/t/p/w500${path}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (
    !response.ok ||
    !/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('content-type') ?? '') ||
    !response.body
  ) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5 * 1024 * 1024) return;
      chunks.push(value);
    }
    return size ? Buffer.concat(chunks) : undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

import type { FastifyInstance } from 'fastify';

const apacheMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function registerAccessLog(app: FastifyInstance, enabled: boolean): void {
  if (!enabled) return;
  app.addHook('onResponse', (request, reply, done) => {
    const timestamp = formatApacheUtc(new Date());
    const length = reply.getHeader('content-length') ?? '-';
    const referer = sanitize(request.headers.referer);
    const userAgent = sanitize(request.headers['user-agent']);
    const line = `${sanitize(request.ip)} - - [${timestamp}] "${request.method} ${sanitize(request.raw.url)} HTTP/${request.raw.httpVersion}" ${reply.statusCode} ${length} "${referer}" "${userAgent}"`;
    process.stdout.write(`${line}\n`);
    done();
  });
}

function sanitize(value: string | undefined): string {
  return (value ?? '-').replace(/[\r\n"]/g, '_');
}

function formatApacheUtc(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(date.getUTCDate())}/${apacheMonths[date.getUTCMonth()]}/${date.getUTCFullYear()}:${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

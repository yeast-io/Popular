import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../http/app-error.js';
import { AiTrace, withAiTrace } from '../logging/ai-trace.js';
import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';
import type { QBittorrentClientPort } from '../../modules/integrations/qbittorrent.types.js';
import type { TransmissionClientPort } from '../../modules/integrations/transmission.types.js';
import { QBittorrentDownloadAdapter } from '../qbittorrent/qbittorrent-download.adapter.js';
import { TransmissionDownloadAdapter } from '../transmission/transmission-download.adapter.js';

test('both adapters preserve error chains and redact torrent URLs with verbose diagnostics disabled', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    for (const provider of ['qbittorrent', 'transmission'] as const) {
      const url = 'https://site.example/torrent?passkey=test-secret';
      const cause = new Error(url);
      const original = new IntegrationValidationError('timeout', 'upstream timed out', { cause });
      const raw = { addTorrent: async () => {
        throw original;
      } };
      const adapter = provider === 'qbittorrent'
        ? new QBittorrentDownloadAdapter(raw as unknown as QBittorrentClientPort, 'https://qb.example.com', { authMethod: 'api_key', apiKey: 'key' }, locale)
        : new TransmissionDownloadAdapter(raw as unknown as TransmissionClientPort, 'https://tr.example.com', { username: 'alice', password: 'password' }, locale);
      const logs: unknown[] = [];
      const trace = new AiTrace({ error: (fields: unknown) => logs.push(fields), info: () => assert.fail('verbose logs disabled') },
        { correlationId: 'adapter-correlation' }, '', 'download.create', false);
      await withAiTrace(trace, async () => {
        await assert.rejects(adapter.add(url, 'tag'), (error) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, provider === 'qbittorrent' ? 'QBITTORRENT_TIMEOUT' : 'TRANSMISSION_TIMEOUT');
          assert.equal(error.cause, original);
          assert.equal(original.cause, cause);
          assert.match(error.message, locale === 'zh-CN' ? /无法访问/ : /Could not access/);
          trace.fail(error);
          return true;
        });
      });
      assert.equal(logs.length, 1);
      const serialized = JSON.stringify(logs);
      assert.equal(serialized.includes('adapter-correlation'), true);
      assert.equal(serialized.includes('download.client.submit'), true);
      assert.equal(serialized.includes('test-secret'), false);
    }
  }
});

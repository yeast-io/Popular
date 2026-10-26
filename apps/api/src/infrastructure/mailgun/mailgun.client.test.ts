import assert from 'node:assert/strict';
import test from 'node:test';
import { MailgunClient } from './mailgun.client.js';

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Mailgun sends a localized verification email (${locale}) using configured region and domain`, async () => {
    const client = new MailgunClient('test-key', 'https://api.eu.mailgun.net', 'mail.gofloat.cn', 'Popular <noreply@mail.gofloat.cn>', async (url, options) => {
      assert.equal(String(url), 'https://api.eu.mailgun.net/v3/mail.gofloat.cn/messages');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.equal((options?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('api:test-key').toString('base64')}`);
      const body = options?.body as FormData;
      assert.equal(body.get('to'), 'recipient@example.com');
      assert.equal(body.get('from'), 'Popular <noreply@mail.gofloat.cn>');
      assert.match(String(body.get('text')), /123456/);
      assert.match(String(body.get('text')), locale === 'zh-CN' ? /24 小时/ : /24 hours/);
      assert.equal(body.get('o:tracking'), 'no');
      return Response.json({ message: 'Queued' });
    });
    await client.send('recipient@example.com', '123456', locale);
  });
}

test('Mailgun errors preserve status without exposing provider response or credentials', async () => {
  const client = new MailgunClient('test-key', 'https://api.mailgun.net', 'mail.gofloat.cn', 'noreply@mail.gofloat.cn', async () => new Response('private provider payload', { status: 401 }));
  await assert.rejects(client.send('recipient@example.com', '123456', 'en-US'), /^Error: Mailgun HTTP 401$/);
});

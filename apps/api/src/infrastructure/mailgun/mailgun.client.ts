import type { Locale } from '@movie-hub/contract';
import type { VerificationEmailSender } from '../../modules/auth/email-verification.types.js';
import { emailVerificationMessages } from '../../modules/auth/email-verification.messages.js';
import { currentAiTrace } from '../logging/ai-trace.js';

export class MailgunClient implements VerificationEmailSender {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    private readonly domain: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async send(email: string, code: string, locale: Locale): Promise<void> {
    if (!this.apiKey) throw new Error('MAILGUN_API_KEY is not configured');
    const trace = currentAiTrace();
    trace?.sensitive(this.apiKey);
    trace?.sensitive(email);
    trace?.sensitive(code);
    const copy = emailVerificationMessages[locale];
    const body = new FormData();
    body.set('from', this.from);
    body.set('to', email);
    body.set('subject', copy.subject);
    body.set('text', copy.body(code));
    body.set('o:tracking', 'no');
    if (trace) body.set('h:X-Correlation-ID', trace.correlationId);
    const response = await this.fetcher(new URL(`/v3/${this.domain}/messages`, this.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}` },
      body,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Mailgun HTTP ${response.status}`);
  }
}

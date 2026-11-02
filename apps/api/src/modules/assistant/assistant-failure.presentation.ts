import type { Locale } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { LlmProviderError } from '../llm/llm.errors.js';

const messages = {
  'zh-CN': {
    credentials: 'AI 暂时不可用，请在系统设置中检查默认 AI 助手的 API 密钥、额度和第三方调用限制。',
    failed: '本次 AI 处理未完成，请稍后重新发送消息。没有执行任何资源查询或下载操作。',
    structured: 'AI 未返回有效的结构化结果，或拒绝了本次请求，处理已中止。请稍后重新发送消息。',
  },
  'en-US': {
    credentials: 'AI is unavailable. Check the default AI assistant’s API key, balance, and provider limits in Settings.',
    failed: 'AI processing did not complete. Send the message again later. No resource searches or downloads were performed.',
    structured: 'AI returned an invalid structured result or refused the request. Processing stopped. Send the message again later.',
  },
};
export function assistantFailureReply(error: unknown, locale: Locale): string {
  if (error instanceof LlmProviderError && ['invalid_json', 'invalid_schema', 'refusal'].includes(error.diagnostics?.reason ?? ''))
    return messages[locale].structured;
  const credentialFailure = error instanceof AppError && [
    'AI_NOT_CONFIGURED', 'AI_AUTH_FAILED', 'AI_QUOTA_EXCEEDED', 'AI_RATE_LIMITED', 'AI_MODEL_UNSUPPORTED',
    'OPENAI_NOT_CONFIGURED', 'OPENAI_AUTH_FAILED', 'OPENAI_QUOTA_EXCEEDED', 'OPENAI_RATE_LIMITED',
  ].includes(error.code);
  return messages[locale][credentialFailure ? 'credentials' : 'failed'];
}

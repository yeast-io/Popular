export const resourceSiteMessages = {
  en: {
    passkeyRequired: 'Configure a Passkey before downloading.',
    notConfigured: 'Configure this resource site before querying or downloading.',
    authentication: 'The resource site Cookie has expired. Update it in settings.',
    blocked: 'The resource site requires verification or has denied access. Requests have stopped.',
    rateLimited: 'The resource site request limit was reached. Try again later.',
    invalidResponse: 'The resource site response could not be parsed.',
    network: 'The resource site could not be reached.',
    timeout: 'The resource site request timed out.',
    invalidCredential: 'A valid Cookie is required.',
  },
  zh: {
    passkeyRequired: '请先配置 Passkey，再下载。',
    notConfigured: '请先配置该资源站点，再查询或下载。',
    authentication: '资源站点 Cookie 已失效，请在设置中更新。',
    blocked: '资源站点要求验证或拒绝访问，已停止请求。',
    rateLimited: '已达到资源站点请求限制，请稍后重试。',
    invalidResponse: '无法解析资源站点响应。',
    network: '无法连接资源站点。',
    timeout: '资源站点请求超时。',
    invalidCredential: '请提供有效的 Cookie。',
  },
} as const;

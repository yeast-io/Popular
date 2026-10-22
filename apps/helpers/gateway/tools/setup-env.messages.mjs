export const setupMessages = {
  'zh-CN': {
    completed: 'Gateway 配置已更新。HTTPS/WSS 由 Nginx 处理，Gateway 使用 HTTP/WS。',
    failed: '配置生成失败；请根据错误码检查配置，已有凭据不会被自动轮换。',
    usage: 'node tools/setup-env.mjs [--env-path 路径] [--secrets-dir 路径] [--locale zh-CN|en-US]',
  },
  'en-US': {
    completed: 'Gateway configuration updated. Nginx handles HTTPS/WSS; Gateway uses HTTP/WS.',
    failed: 'Setup failed. Check the error code; existing credentials are never rotated automatically.',
    usage: 'node tools/setup-env.mjs [--env-path path] [--secrets-dir path] [--locale zh-CN|en-US]',
  },
};

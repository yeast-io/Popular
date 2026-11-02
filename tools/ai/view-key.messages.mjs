export const messages = {
  'zh-CN': {
    usage: '用法：node tools/ai/view-key.mjs <deepseek|openai|claude> <--email 邮箱|--owner-id 用户ID> [--locale zh-CN|en-US]\n只读取指定账户已保存的密钥，完整密钥输出到标准输出。',
    INVALID_ARGUMENTS: '参数错误：必须指定平台，并用 --email 或 --owner-id 指定唯一账户。',
    INVALID_CONFIGURATION: '缺少或无效的 MONGODB_URI、MONGODB_DB_NAME 或 INTEGRATION_SECRET_KEY 配置。',
    USER_NOT_FOUND: '没有找到指定账户。',
    AMBIGUOUS_USER: '匹配到多个账户，请改用 --owner-id。',
    KEY_NOT_FOUND: '该账户未保存此平台的密钥，或密钥已删除。',
    DECRYPT_FAILED: '解密失败：请检查 INTEGRATION_SECRET_KEY 是否与保存密钥时一致。',
    FAILED: '读取失败，请检查 MongoDB 连接和读取权限。',
  },
  'en-US': {
    usage: 'Usage: node tools/ai/view-key.mjs <deepseek|openai|claude> <--email email|--owner-id userId> [--locale zh-CN|en-US]\nReads only the selected account. The full key is written to stdout.',
    INVALID_ARGUMENTS: 'Invalid arguments: specify a provider and exactly one account using --email or --owner-id.',
    INVALID_CONFIGURATION: 'Missing or invalid MONGODB_URI, MONGODB_DB_NAME or INTEGRATION_SECRET_KEY configuration.',
    USER_NOT_FOUND: 'The selected account was not found.',
    AMBIGUOUS_USER: 'Multiple accounts matched. Use --owner-id instead.',
    KEY_NOT_FOUND: 'No saved key exists for this account and provider, or it was removed.',
    DECRYPT_FAILED: 'Decryption failed. Check that INTEGRATION_SECRET_KEY matches the value used when saving the key.',
    FAILED: 'Could not read the key. Check MongoDB connectivity and read permissions.',
  },
};

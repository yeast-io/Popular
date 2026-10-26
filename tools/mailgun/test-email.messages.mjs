export const messages = {
  'zh-CN': {
    subject: 'Popular · Mailgun 邮件发送测试',
    text: '这是一封来自 Popular 的测试邮件，用于检查 mail.gofloat.cn 的 Mailgun 发信配置。\n\n收到此邮件即表示本次邮件已送达。无需回复或操作。',
    accepted: 'Mailgun 已接受邮件，等待投递；请检查收件箱和垃圾邮件。',
    dryRun: '配置检查通过，尚未发送邮件。',
    failed: '邮件测试失败，请检查错误阶段和 HTTP 状态。',
  },
  'en-US': {
    subject: 'Popular · Mailgun email delivery test',
    text: 'This is a test email from Popular to check the Mailgun sending configuration for mail.gofloat.cn.\n\nReceiving this email confirms delivery of this message. No reply or action is needed.',
    accepted: 'Mailgun accepted the email for delivery; check your inbox and spam folder.',
    dryRun: 'Configuration checks passed. No email was sent.',
    failed: 'Email test failed; check the error stage and HTTP status.',
  },
};

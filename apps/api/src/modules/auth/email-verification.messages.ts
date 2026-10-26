export const emailVerificationMessages = {
  'zh-CN': {
    subject: 'Popular 注册邮箱验证码',
    body: (code: string) => `你的 Popular 注册验证码是：${code}\n\n验证码与待验证注册将在 24 小时后过期。请勿向他人提供验证码。\n如果不是你本人注册，请忽略本邮件。`,
    invalid: '验证码错误、已过期或错误次数已达上限，请重新注册。',
    limit: '24 小时内的邮件发送额度已用完，请稍后再试。',
    unavailable: '暂时无法发送验证邮件，请稍后再试。',
    userLimit: '注册名额暂时已满，请稍后再试。',
    conflict: '该邮箱已注册，请直接登录。',
  },
  'en-US': {
    subject: 'Popular registration verification code',
    body: (code: string) => `Your Popular registration verification code is: ${code}\n\nThe code and pending registration expire after 24 hours. Do not share this code.\nIf you did not register, ignore this email.`,
    invalid: 'The code is incorrect, expired, or has reached the attempt limit. Please register again.',
    limit: 'The email limit for the last 24 hours has been reached. Please try again later.',
    unavailable: 'Verification email is temporarily unavailable. Please try again later.',
    userLimit: 'Registration is currently full. Please try again later.',
    conflict: 'This email is already registered. Please sign in.',
  },
};

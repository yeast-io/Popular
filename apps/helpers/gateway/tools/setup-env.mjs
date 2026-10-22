import { parseArgs } from 'node:util';
import { setupGatewayEnvironment } from './setup-env.service.mjs';
import { setupMessages } from './setup-env.messages.mjs';

let messages = setupMessages['zh-CN'];
try {
  const { values } = parseArgs({
    options: {
      'env-path': { type: 'string' },
      'secrets-dir': { type: 'string' },
      'locale': { type: 'string', default: 'zh-CN' },
      'help': { type: 'boolean', default: false },
    },
  });
  if (!Object.hasOwn(setupMessages, values.locale)) throw Object.assign(new Error(), { code: 'INVALID_LOCALE' });
  messages = setupMessages[values.locale];
  if (values.help) console.log(messages.usage);
  else {
    const result = await setupGatewayEnvironment({
      envFile: values['env-path'],
      secretsDirectory: values['secrets-dir'],
    });
    console.log(JSON.stringify({ ...result, message: messages.completed }, null, 2));
  }
} catch (error) {
  // Do not print error messages, argv, dotenv contents or private JWK parse fragments.
  console.error(
    JSON.stringify({
      error: { code: typeof error.code === 'string' ? error.code : 'SETUP_FAILED', message: messages.failed },
    })
  );
  process.exitCode = 1;
}

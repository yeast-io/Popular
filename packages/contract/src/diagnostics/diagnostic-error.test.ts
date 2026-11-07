import assert from 'node:assert/strict';
import test from 'node:test';
import { redactDiagnosticText, serializeDiagnosticError } from './diagnostic-error.js';

test('redacts signed torrent and CSRF parameters from messages, stacks and cause chains', () => {
  const url = 'https://hdwing.org/download.php?hash=private-signature&uid=123&csrf=private-csrf';
  assert.equal(redactDiagnosticText(url), 'https://hdwing.org/download.php?hash=[REDACTED]&uid=123&csrf=[REDACTED]');
  const serialized = JSON.stringify(serializeDiagnosticError(new Error(url, { cause: new Error(url) })));
  assert.equal(serialized.includes('private-signature'), false);
  assert.equal(serialized.includes('private-csrf'), false);
});

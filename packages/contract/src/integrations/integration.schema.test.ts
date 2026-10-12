import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { MTeamConfigurationSchema, SaveMTeamConfigurationRequestSchema } from './integration.schema.js';

test('M-Team response cannot expose an API key', () => {
  assert.equal(Value.Check(MTeamConfigurationSchema, {
    provider: 'mteam', status: 'configured_valid', baseUrl: 'https://api.m-team.cc', apiKey: 'secret',
  }), false);
});

test('M-Team save request supports retaining an existing key', () => {
  assert.equal(Value.Check(SaveMTeamConfigurationRequestSchema, {
    baseUrl: 'https://api.m-team.cc', apiKey: 'secret',
  }), true);
  assert.equal(Value.Check(SaveMTeamConfigurationRequestSchema, { baseUrl: 'https://api.m-team.cc' }), true);
  assert.equal(Value.Check(SaveMTeamConfigurationRequestSchema, { baseUrl: 'https://api.m-team.cc', apiKey: '' }), false);
});

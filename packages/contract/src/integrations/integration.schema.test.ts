import assert from 'node:assert/strict';
import test from 'node:test';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  TransmissionConfigurationSchema,
  SaveTransmissionConfigurationRequestSchema,
  MTeamConfigurationSchema,
  QBittorrentConfigurationSchema,
  SaveMTeamConfigurationRequestSchema,
  SaveQBittorrentConfigurationRequestSchema,
} from './integration.schema.js';

FormatRegistry.Set('uri', (value) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});

test('M-Team response cannot expose an API key', () => {
  assert.equal(
    Value.Check(MTeamConfigurationSchema, {
      provider: 'mteam',
      status: 'configured_valid',
      baseUrl: 'https://api.m-team.cc',
      apiKey: 'secret',
    }
    ),
    false,
  );
});

test('qBittorrent configuration supports either credential mode without exposing secrets', () => {
  assert.equal(
    Value.Check(SaveQBittorrentConfigurationRequestSchema, {
      baseUrl: 'http://nas:8080',
      authMethod: 'api_key',
      apiKey: 'qbt_secret',
    }
    ),
    true,
  );
  assert.equal(
    Value.Check(SaveQBittorrentConfigurationRequestSchema, {
      baseUrl: 'http://nas:8080',
      authMethod: 'username_password',
      username: 'daniel',
      password: 'secret',
    }
    ),
    true,
  );
  assert.equal(
    Value.Check(SaveQBittorrentConfigurationRequestSchema, {
      baseUrl: 'http://nas:8080',
      authMethod: 'api_key',
      username: 'not-allowed',
    }
    ),
    false,
  );
  assert.equal(
    Value.Check(QBittorrentConfigurationSchema, {
      provider: 'qbittorrent',
      status: 'configured_valid',
      baseUrl: 'http://nas:8080',
      apiKey: 'must-not-leak',
    }
    ),
    false,
  );
});

test('M-Team save request supports retaining an existing key', () => {
  assert.equal(
    Value.Check(SaveMTeamConfigurationRequestSchema, {
      baseUrl: 'https://api.m-team.cc',
      webBaseUrl: 'https://kp.m-team.cc',
      apiKey: 'secret',
    }
    ),
    true,
  );
  assert.equal(Value.Check(SaveMTeamConfigurationRequestSchema, { baseUrl: 'https://api.m-team.cc' }), true);
  assert.equal(
    Value.Check(SaveMTeamConfigurationRequestSchema, { baseUrl: 'https://api.m-team.cc', apiKey: '' }),
    false,
  );
});

test('Transmission accepts username/password configuration and cannot expose credentials', () => {
  const config = {
    provider: 'transmission',
    status: 'configured_valid',
    baseUrl: 'http://nas:9091',
    username: 'daniel',
  };
  assert.equal(Value.Check(TransmissionConfigurationSchema, config), true);
  for (const secret of [{ password: 'secret' }, { encryptedCredential: 'encrypted' }]) {
    assert.equal(Value.Check(TransmissionConfigurationSchema, { ...config, ...secret }), false);
  }
  assert.equal(
    Value.Check(SaveTransmissionConfigurationRequestSchema, {
      baseUrl: 'http://nas:9091',
      username: 'daniel',
      password: 'secret',
    }
    ),
    true,
  );
  assert.equal(
    Value.Check(SaveTransmissionConfigurationRequestSchema, { baseUrl: 'http://nas:9091', username: 'daniel' }),
    true,
  );
  assert.equal(
    Value.Check(SaveTransmissionConfigurationRequestSchema, { baseUrl: 'http://nas:9091', username: '' }),
    false,
  );
  assert.equal(
    Value.Check(SaveTransmissionConfigurationRequestSchema, { baseUrl: 'http://nas:9091', apiKey: 'secret' }),
    false,
  );
});

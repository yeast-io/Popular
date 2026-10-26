// Explicitly owner-scoped collections; shared media/catalog data is excluded.
export const userOwnedCollections = [
  'auth_identities', 'assistant_messages', 'assistant_workflow_sessions',
  'assistant_resource_queries', 'taste_profiles', 'preference_jobs', 'recommendation_tasks',
  'conversation_threads', 'conversation_messages', 'user_movie_states',
  'user_tv_preferences', 'user_tv_watchlist', 'resource_notifications',
  'notification_preferences', 'telegram_bindings', 'whatsapp_sessions',
  'integration_configs', 'integration_preferences', 'openai_configs',
  'transmission_configs', 'qbittorrent_configs', 'resource_site_credentials',
  'remote_client_authorizations', 'remote_client_devices', 'remote_client_commands',
  'resource_download_limits', 'movie_downloads', 'movie_resource_checks',
  'movie_resource_check_tasks', 'movie_resource_sync_batches',
  'external_request_events', 'external_usage_daily',
];

export type AuthField = 'displayName' | 'email' | 'password';

export type Page
  = | 'home'
    | 'link-agent'
    | 'notification-tests'
    | 'movies'
    | 'tv-shows'
    | 'viewing-preferences'
    | 'watchlist'
    | 'resource-notifications'
    | 'ai'
    | 'settings'
    | 'usage'
    | 'movie-detail'
    | 'tv-show-detail'
    | 'login'
    | 'register';

export type SettingsSection = 'profile' | 'language' | 'ai' | 'preferences' | 'resources' | 'downloads' | 'keys' | 'notifications';

export type ListPage = 'movies' | 'tv-shows' | 'viewing-preferences' | 'watchlist' | 'resource-notifications';

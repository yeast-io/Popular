export type AuthField = 'displayName' | 'email' | 'password';

export type Page
  = | 'notification-tests'
    | 'movies'
    | 'tv-shows'
    | 'viewing-preferences'
    | 'watchlist'
    | 'ai'
    | 'settings'
    | 'usage'
    | 'movie-detail'
    | 'tv-show-detail'
    | 'login'
    | 'register';

export type SettingsSection = 'profile' | 'ai' | 'preferences' | 'resources' | 'downloads' | 'keys' | 'notifications';

export type ListPage = 'movies' | 'tv-shows' | 'viewing-preferences' | 'watchlist';

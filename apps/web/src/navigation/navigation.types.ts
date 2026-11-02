import type { useNavigation } from './navigation.composable';
import type { PageScrollController } from '../scroll/page-scroll.types';
import type { AuthMode } from '../features/authentication/authentication.types';
import type { AuthUser } from '@movie-hub/contract';

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

export interface NavigationOptions {
  isAuthenticated: () => boolean;
  aiEnabled: () => boolean;
  notificationTestEnabled: () => boolean;
  scroll: PageScrollController;
  onPageChanged: (page: Page) => void;
  onAuthRequested: (mode: AuthMode) => void;
}
export type NavigationController = ReturnType<typeof useNavigation>;
export interface SiteHeaderProps {
  navigation: NavigationController;
  user: AuthUser | null;
  loading: boolean;
  aiAssistantEnabled: boolean;
  notificationTestEnabled: boolean;
  avatarUrl: string;
}

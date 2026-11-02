import type { AuthUser } from '@movie-hub/contract';
import type { Ref } from 'vue';
import type { useAccountSettings } from './account-settings.composable';
import type { SettingsSection } from '../../navigation/navigation.types';

export interface AccountSettingsOptions {
  user: Readonly<Ref<AuthUser | null>>;
  onUserUpdated: (user: AuthUser) => void;
}
export type AccountSettingsController = ReturnType<typeof useAccountSettings>;
export interface AccountSettingsProps {
  account: AccountSettingsController;
  user: AuthUser;
  section: SettingsSection;
}

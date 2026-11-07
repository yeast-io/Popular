import type { SettingsSection } from '../../navigation/navigation.types';

export interface SettingsNavigationProps {
  section: SettingsSection;
  sections: readonly SettingsSection[];
}

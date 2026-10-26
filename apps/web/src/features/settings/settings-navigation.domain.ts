import type { SettingsSection } from '../../app.types';

const sectionSlugs: Record<SettingsSection, string> = {
  profile: 'profile',
  language: 'language',
  ai: 'ai-assistant',
  preferences: 'movie-preferences',
  resources: 'sources',
  downloads: 'tools',
  keys: 'keys',
  notifications: 'messages',
};

export function settingsSectionSlug(section: SettingsSection): string {
  return sectionSlugs[section];
}

export function settingsSectionFromSearch(search: string): SettingsSection {
  const slug = new URLSearchParams(search).get('section');
  return (Object.keys(sectionSlugs) as SettingsSection[]).find((section) => sectionSlugs[section] === slug) ?? 'profile';
}

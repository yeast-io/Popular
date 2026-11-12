import type { Page } from './navigation.types';

export const PAGE_PATHS: ReadonlyMap<Page, string> = new Map([
  ['home', '/'],
  ['link-agent', '/link-agent'],
  ['notification-tests', '/dev/notification-tests'],
  ['usage', '/usage'],
  ['resource-notifications', '/resource-notifications'],
  ['watchlist', '/watchlist'],
  ['viewing-preferences', '/viewing-preferences'],
  ['ai', '/ai'],
  ['tv-shows', '/tv-shows'],
]);

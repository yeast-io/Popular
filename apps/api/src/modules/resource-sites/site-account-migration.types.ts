export interface SiteAccountMigrationEntry {
  ownerId: string;
  site: 'mteam' | 'hdarea';
  encryptedCredential: string;
}

export interface SiteAccountMigrationStore {
  listPending(): Promise<SiteAccountMigrationEntry[]>;
  assign(entry: SiteAccountMigrationEntry, externalUserId: string): Promise<boolean>;
}

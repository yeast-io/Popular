import { createHash, randomUUID } from 'node:crypto';
import type { PreferenceProposal } from './preference.types.js';
import type { TasteEntry, TasteProfile } from '@movie-hub/contract';

export const MINIMUM_RATINGS = 5;
export const emptyProfile = (): TasteProfile => {
  return {
    version: 0,
    autoMaintain: true,
    entries: [],
    withdrawn: [],
    revisions: [],
    generatedAt: null,
    generatedFingerprint: null,
    updatedAt: null,
  };
};
export function profileText(profile: TasteProfile): string {
  return ['explicit', 'inferred']
    .map((section) => {
      return `${section === 'explicit' ? '用户明确表达 / Explicit' : '根据记录推测 / Inferred'}:\n${
        profile.entries
          .filter((entry) => entry.section === section)
          .map(
          (entry) => `- [${entry.id}] ${entry.content}`
        )
          .join(
          '\n'
        ) || '(none)'
      }`;
    })
    .join('\n\n');
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Validate provenance and immutable boundaries before applying any model-proposed edits. */
export function applyProposal(
  profile: TasteProfile,
  proposal: PreferenceProposal,
  sources: string[],
  kind: 'manual' | 'chat',
  source: string,
): TasteProfile {
  const allowed = new Set(sources);
  const entries: TasteEntry[] = structuredClone(profile.entries);
  const touched = new Set<string>();
  const now = new Date().toISOString();
  for (const change of proposal.changes) {
    if (
      change.evidenceRefs.some((ref) => {
        return !allowed.has(ref);
      })
    )
      throw new Error('Unknown preference evidence');
    if (kind === 'manual' && change.section !== 'inferred')
      throw new Error('Movie evidence cannot create explicit preferences');
    if (kind === 'chat' && change.section !== 'explicit')
      throw new Error('Chat maintenance only records explicit statements');
    const existing = entries.find((entry) => entry.id === change.entryId);
    if (change.operation !== 'add') {
      if (!existing || existing.section !== change.section || existing.protected || touched.has(existing.id))
        throw new Error('Invalid preference target');
      touched.add(existing.id);
    } else if (change.entryId !== null) throw new Error('New preference cannot choose its ID');
    if (change.operation !== 'remove' && !change.content.trim()) throw new Error('Empty preference');
    // User removals cannot be restored by regenerating from the same evidence. New statements may express a new choice.
    if (
      kind === 'manual' &&
      change.evidenceRefs.some((ref) => {
        return profile.withdrawn.includes(ref);
      })
    )
      continue;
    if (change.operation === 'remove') entries.splice(entries.indexOf(existing!), 1);
    else {
      const entry: TasteEntry = {
        id: existing?.id ?? randomUUID(),
        section: change.section,
        content: change.content.trim(),
        evidenceRefs: change.evidenceRefs,
        updatedAt: now,
        protected: false,
      };
      if (existing) entries.splice(entries.indexOf(existing), 1, entry);
      else if (
        !entries.some((item) => {
          return item.section === entry.section && item.content === entry.content;
        })
      )
        entries.push(entry);
    }
  }
  const supported =
    kind === 'manual'
      ? entries.filter((entry) => {
          return entry.section !== 'inferred' || entry.protected || entry.evidenceRefs.every((ref) => allowed.has(ref));
        })
      : entries;
  if (supported.length > 80) throw new Error('Preference profile limit reached');
  return {
    ...profile,
    entries: supported,
    updatedAt: now,
    version: profile.version + 1,
    revisions: [...profile.revisions, { version: profile.version, at: now, source, entries: profile.entries }].slice(
      -30,
    ),
  };
}

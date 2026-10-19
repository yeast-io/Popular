import { randomUUID } from 'node:crypto';
import type { Locale, TasteProfileResponse } from '@movie-hub/contract';
import type { PreferenceStore, PreferenceEvidence, PreferenceJob } from './preference.types.js';
import type { MovieCatalogStore, MovieSearchProvider, MovieStatusStore } from '../movies/movie.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { fingerprint, MINIMUM_RATINGS, profileText } from './preference.domain.js';

export class PreferenceService {
  constructor(
    readonly store: PreferenceStore,
    private readonly statuses: MovieStatusStore,
    private readonly catalog: MovieCatalogStore,
    private readonly provider: MovieSearchProvider,
    private readonly locale: Locale,
    private readonly requireModel: (ownerId: string) => Promise<unknown>
  ) {}
  private async marks(ownerId: string) {
    const first = await this.statuses.list(ownerId, undefined, 1, 500);
    const rows = [...first.items];
    for (let page = 2; (page - 1) * 500 < first.total; page++)
      rows.push(...(await this.statuses.list(ownerId, undefined, page, 500)).items);
    const items = [
      ...new Map(
        rows.map((item) => {
          return [item.tmdbId, item];
        }),
      ).values(),
    ].sort((a, b) => {
      return a.tmdbId - b.tmdbId;
    });
    return {
      items,
      count: items.filter((item) => item.preference !== 'neutral').length,
      fingerprint: fingerprint(
        items.map(({ tmdbId, status, preference }) => {
          return { tmdbId, status, preference };
        }),
      ),
    };
  }
  async get(ownerId: string): Promise<TasteProfileResponse> {
    const [profile, marks, task] = await Promise.all([
      this.store.read(ownerId),
      this.marks(ownerId),
      this.store.latest(ownerId),
    ]);
    return {
      ...profile,
      text: profileText(profile),
      ratedCount: marks.count,
      minimumRatings: MINIMUM_RATINGS,
      marksChanged: Boolean(profile.generatedFingerprint && profile.generatedFingerprint !== marks.fingerprint),
      task,
    };
  }
  async generate(ownerId: string) {
    const marks = await this.marks(ownerId);
    const profile = await this.store.read(ownerId);
    if (!profile.generatedAt && marks.count < MINIMUM_RATINGS)
      throw new AppError(400, 'INSUFFICIENT_MOVIE_RATINGS', 'Rate at least five different movies first.');
    await this.requireModel(ownerId);
    const task = await this.store.latest(ownerId);
    if (task && ['pending', 'processing'].includes(task.status)) return this.get(ownerId);
    const evidence: PreferenceEvidence[] = [];
    // Bound metadata calls and input size; preserve negative samples in the initial analysis.
    const sample = [
      ...marks.items
        .filter((item) => {
          return item.preference === 'liked';
        })
        .sort((a, b) => {
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        })
        .slice(0, 15),
      ...marks.items
        .filter((item) => {
          return item.preference === 'disliked';
        })
        .sort((a, b) => {
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        })
        .slice(0, 15),
      ...marks.items
        .filter((item) => {
          return item.preference === 'neutral' && item.status !== 'unwatched';
        })
        .sort((a, b) => {
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        })
        .slice(0, 5),
    ];
    for (const mark of sample)
      evidence.push({ ref: `movie:${mark.tmdbId}:${mark.preference}`, text: JSON.stringify(mark) });
    await this.store.enqueue(ownerId, `manual:${randomUUID()}`, 'manual', evidence, marks.fingerprint);
    return this.get(ownerId);
  }
  async enrich(job: PreferenceJob, signal?: AbortSignal): Promise<PreferenceJob> {
    if ((await this.marks(job.ownerId)).fingerprint !== job.fingerprint)
      throw new Error('Movie feedback changed; generate again');
    const evidence: PreferenceEvidence[] = [];
    let lookups = 0;
    const summaries = await this.catalog.readMovies(
      job.evidence.map((item) => {
        return (JSON.parse(item.text) as { tmdbId: number }).tmdbId;
      }),
      this.locale,
    );
    for (const item of job.evidence) {
      signal?.throwIfAborted();
      const mark = JSON.parse(item.text) as { tmdbId: number; status: string; preference: string };
      let movie = await this.catalog.readMovieDetail(mark.tmdbId, this.locale);
      if (!movie && lookups++ < 10) {
        try {
          movie = await this.provider.fetchDetails(mark.tmdbId, this.locale, {
            actorType: 'user',
            ownerId: job.ownerId,
            trigger: 'manual_refresh',
          });
          await this.catalog.writeMovieDetail(movie, new Date(), this.locale);
        } catch {
          /* Missing credits do not justify invented preferences. */
        }
      }
      const summary = summaries.find((summary) => summary.tmdbId === mark.tmdbId);
      // Send taste evidence, not whole catalog documents (plots, image paths, votes and timestamps).
      evidence.push({
        ref: item.ref,
        text: JSON.stringify({
          tmdbId: mark.tmdbId,
          status: mark.status,
          preference: mark.preference,
          title: movie?.title ?? summary?.title,
          genreIds: movie?.genreIds ?? summary?.genreIds,
          ...(movie
            ? {
                genres: movie.genres.map((genre) => {
                  return genre.name;
                }),
                directors: movie.directors.map((item) => {
                  return item.person.name;
                }),
                cast: movie.cast.slice(0, 5).map((item) => {
                  return item.person.name;
                }),
              }
            : {}),
        }),
      });
    }
    return { ...job, evidence };
  }
  async chatEvidence(ownerId: string, eventId: string, text: string, history: string[]) {
    if (!(await this.store.read(ownerId)).autoMaintain) return;
    await this.store.enqueue(ownerId, `chat:${eventId}`, 'chat', [
      {
        ref: eventId,
        text: JSON.stringify({
          latestUserMessage: text,
          recentContext: history.slice(-6).map((item) => {
            return item.slice(0, 1500);
          }),
        }),
      },
    ]);
  }
  async edit(
    ownerId: string,
    expectedVersion: number,
    action: {
      autoMaintain?: boolean | undefined;
      entryId?: string | undefined;
      content?: string | undefined;
      clear?: boolean | undefined;
    },
  ) {
    const profile = await this.store.read(ownerId);
    if (profile.version !== expectedVersion)
      throw new AppError(409, 'PREFERENCE_VERSION_CONFLICT', 'Reload preferences before editing.');
    const now = new Date().toISOString();
    const next = structuredClone(profile);
    if (action.clear) {
      next.withdrawn = [
        ...new Set([
          ...next.withdrawn,
          ...next.entries.flatMap((entry) => {
            return entry.evidenceRefs;
          }),
        ]),
      ];
      next.entries = [];
      next.autoMaintain = false;
    } else if (action.entryId) {
      const entry = next.entries.find((item) => item.id === action.entryId);
      if (!entry) throw new AppError(404, 'NOT_FOUND', 'Preference entry not found.');
      next.withdrawn = [...new Set([...next.withdrawn, ...entry.evidenceRefs])];
      if (action.content !== undefined) {
        entry.content = action.content.trim();
        entry.section = 'explicit';
        entry.protected = true;
        entry.evidenceRefs = [`user-edit:${randomUUID()}`];
        entry.updatedAt = now;
      } else next.entries = next.entries.filter((item) => item.id !== action.entryId);
    }
    if (action.autoMaintain !== undefined) next.autoMaintain = action.autoMaintain;
    next.version++;
    next.updatedAt = now;
    next.revisions = [
      ...profile.revisions,
      { version: profile.version, at: now, source: 'user-edit', entries: profile.entries },
    ].slice(-30);
    if (!(await this.store.save(ownerId, profile.version, next)))
      throw new AppError(409, 'PREFERENCE_VERSION_CONFLICT', 'Preferences changed; reload.');
    // Version fencing prevents already-running tasks overwriting this edit. Clear/disable cancels queued work too.
    if (action.clear || action.autoMaintain === false) await this.store.cancel(ownerId);
    return this.get(ownerId);
  }
}

import type { MyMoviesFilter } from '@movie-hub/contract';

export type ViewingPreferenceFilter = Exclude<MyMoviesFilter, 'interested'>;

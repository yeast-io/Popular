export interface TmdbMovie {
  id: number;
  title?: string;
  original_title?: string;
  original_language?: string;
  overview?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
}

export interface TmdbTrendingResponse {
  page: number;
  results: TmdbMovie[];
  total_pages: number;
  total_results: number;
}

export interface TmdbDetail extends TmdbMovie {
  imdb_id?: string | null;
  tagline?: string;
  runtime?: number | null;
  genres?: Array<{ id: number; name: string }>;
  credits?: {
    cast?: Array<{
      id: number;
      credit_id: string;
      name?: string;
      original_name?: string;
      character?: string;
      profile_path?: string | null;
      order?: number;
    }>;
    crew?: Array<{
      id: number;
      credit_id: string;
      name?: string;
      original_name?: string;
      job?: string;
      profile_path?: string | null;
    }>;
  };
  translations?: {
    translations?: Array<{
      iso_639_1?: string;
      iso_3166_1?: string;
      data?: { title?: string; overview?: string; tagline?: string };
    }>;
  };
  videos?: { results?: TmdbVideo[] };
}

export interface TmdbVideo {
  id?: string;
  iso_639_1?: string;
  iso_3166_1?: string;
  key?: string;
  name?: string;
  official?: boolean;
  published_at?: string;
  site?: string;
  type?: string;
}

import type { Connection } from 'mongoose';
import { createAuthIdentityModel } from './auth-identity.schema.js';
import { createMovieResultSetModel } from './movie-result-set.schema.js';
import { createMovieModel } from './movie.schema.js';
import { createMovieLocalizationModel } from './movie-localization.schema.js';
import { createSyncJobModel } from './sync-job.schema.js';
import { createUserMovieStateModel } from './user-movie-state.schema.js';
import { createUserModel } from './user.schema.js';
import { createPersonModel } from './person.schema.js';
import { createMovieCreditModel } from './movie-credit.schema.js';
import { createIntegrationConfigModel } from './integration-config.schema.js';
import { createMovieResourceCheckModel } from './movie-resource-check.schema.js';
import { createMovieResourceCheckTaskModel } from './movie-resource-check-task.schema.js';

export function createModels(connection: Connection) {
  return {
    users: createUserModel(connection),
    authIdentities: createAuthIdentityModel(connection),
    movies: createMovieModel(connection),
    movieLocalizations: createMovieLocalizationModel(connection),
    movieResultSets: createMovieResultSetModel(connection),
    userMovieStates: createUserMovieStateModel(connection),
    syncJobs: createSyncJobModel(connection),
    people: createPersonModel(connection),
    movieCredits: createMovieCreditModel(connection),
    integrationConfigs: createIntegrationConfigModel(connection),
    movieResourceChecks: createMovieResourceCheckModel(connection),
    movieResourceCheckTasks: createMovieResourceCheckTaskModel(connection),
  };
}

export type Models = ReturnType<typeof createModels>;

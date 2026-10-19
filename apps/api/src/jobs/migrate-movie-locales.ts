import '../config/load-env.js';
import { loadMigrationConfig } from '../config/env.js';
import { MongoDbConnector } from '../infrastructure/mongodb/connector.js';
import { migrateMovieLocales } from '../infrastructure/mongodb/movies/movie-locale-migration.js';

const supportedArguments = new Set(['--', '--dry-run']);
const unknownArguments = process.argv.slice(2).filter((argument) => {
  return !supportedArguments.has(argument);
});
if (unknownArguments.length > 0) {
  throw new Error(`Unknown migration argument(s): ${unknownArguments.join(', ')}`);
}

const config = loadMigrationConfig();
const mongodb = new MongoDbConnector(config.MONGODB_URI, config.MONGODB_DB_NAME);

try {
  const connection = await mongodb.connect();
  const report = await migrateMovieLocales(connection, { dryRun: process.argv.includes('--dry-run') });
  console.log(JSON.stringify(report));
} finally {
  await mongodb.close();
}

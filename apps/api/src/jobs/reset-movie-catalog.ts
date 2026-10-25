import '../config/load-env.js';
import { loadMongoMaintenanceConfig } from '../config/env.js';
import { MongoDbConnector } from '../infrastructure/mongodb/connector.js';

const config = loadMongoMaintenanceConfig();
const mongodb = new MongoDbConnector(config.MONGODB_URI, config.MONGODB_DB_NAME);

try {
  const connection = await mongodb.connect();
  const database = connection.db;
  if (!database) throw new Error('MongoDB database handle is unavailable');
  const collections = ['movie_credits', 'people', 'movie_result_sets', 'movie_localizations', 'movies'] as const;
  for (const name of collections) {
    const result = await database.collection(name).deleteMany({});
    console.log(JSON.stringify({ collection: name, deleted: result.deletedCount }));
  }
} finally {
  await mongodb.close();
}

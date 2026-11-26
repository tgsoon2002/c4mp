import { detectSqlFiles, readSqlSchema } from './sqlMigrations';
import type { StorageReader } from './reader';

// P23 (b212 D3): SQL migration files as reader #2 of the gateway. Adapter only; the logic is in sqlMigrations.ts.
// `extensions` tells the caller to list .sql files too (the scan walk lists source-code extensions only).

const sqlMigrationsReader: StorageReader = {
  id: 'sql-migrations',
  family: 'static',
  techs: ['postgres', 'mysql', 'sqlite'],
  extensions: ['.sql'],
  detect: detectSqlFiles,
  read: readSqlSchema,
};

export default sqlMigrationsReader;

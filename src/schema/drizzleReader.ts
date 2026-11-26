import * as fs from 'fs';
import * as path from 'path';
import { readDrizzleSchema } from './drizzle';
import type { StorageReader } from './reader';

// P23-D3c (b275): Drizzle as reader #1 of the gateway. Adapter only; readDrizzleSchema is unchanged.

const drizzleReader: StorageReader = {
  id: 'drizzle',
  family: 'static',
  techs: ['postgres'],
  // Text sniff: a .ts file that mentions drizzle-orm/ (pg-core or another dialect; read() sorts that out).
  detect: (repoRoot, repoFiles) =>
    repoFiles.filter((f) => f.endsWith('.ts') && fs.readFileSync(path.join(repoRoot, f), 'utf8').includes('drizzle-orm/')),
  read: readDrizzleSchema,
};

export default drizzleReader;

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Cap every run (also when a caller forgets --maxWorkers) and recycle bloated workers.
  maxWorkers: '50%',
  workerIdleMemoryLimit: '512MB',
  // Transpile only: type checking is done by `npm run typecheck` (tsc -p tsconfig.test.json).
  // ts-jest 29.4 deprecates the transform option isolatedModules; the tsconfig flag is the supported switch.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  globalSetup: '<rootDir>/test/globalSetup.js',
  globalTeardown: '<rootDir>/test/globalTeardown.js',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/test/fixtures'],
};

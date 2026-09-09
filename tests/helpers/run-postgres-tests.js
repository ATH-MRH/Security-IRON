const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testEnvironment } = require('./postgres-test-config');
try {
  testEnvironment(); // Refuse before starting any test or opening a database.
  const result = spawnSync(process.execPath, ['--test','tests/postgres-config.test.js','tests/postgres-database.test.js'], {
    cwd:path.join(__dirname,'../..'), env:process.env, stdio:'inherit',
  });
  process.exitCode = result.status ?? 1;
} catch(error) { console.error(error.message); process.exitCode=1; }

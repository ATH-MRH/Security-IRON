const { app } = require('electron');

function testSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(':memory:');
    d.exec('CREATE TABLE t(x)');
    d.prepare('INSERT INTO t VALUES(?)').run(42);
    const r = d.prepare('SELECT x FROM t').get();
    return 'OK ' + JSON.stringify(r);
  } catch (e) {
    return 'FAIL: ' + e.message;
  }
}

app.whenReady().then(() => {
  process.stdout.write('PROBE_VERS ' + JSON.stringify(process.versions) + '\n');
  process.stdout.write('PROBE_SQLITE ' + testSqlite() + '\n');
  app.quit();
});
app.on('window-all-closed', () => app.quit());

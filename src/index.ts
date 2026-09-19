import { readConfig } from './config.js';
import { RecipeStore } from './database.js';
import { createApp } from './http.js';


try {
  const config = readConfig();
  const store = new RecipeStore(config.databasePath);
  const http = createApp(store, config).listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      event: 'listening',
      name: '따바라 한모금 SIP',
      host: config.host,
      port: config.port,
      endpoint: '/mcp',
      databasePath: config.databasePath,
    }));
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 15_000;
  http.on('error', (error) => {
    console.error('서버 시작 오류:', error);
    store.close();
    process.exitCode = 1;
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = setTimeout(() => { http.closeAllConnections(); }, 5_000);
    timer.unref();
    http.close(() => {
      clearTimeout(timer);
      store.close();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : '서버 초기화 오류');
  process.exitCode = 1;
}

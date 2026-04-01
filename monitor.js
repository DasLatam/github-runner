const { fetchBatch } = require('./lib/fetchBatch');
const { pushResults } = require('./lib/pushResults');
const { runVisit, createBrowser } = require('./lib/runVisit');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

async function runWithConcurrency(items, browser, limit = 2) {
  const results = [];
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) return;
      const item = items[currentIndex];
      console.log(`Visitando [${item.id}] ${item.url}`);
      const result = await runVisit(item, browser);
      results.push(result);
      console.log(`Resultado [${item.id}] ${result.status} ${result.load_ms || '-'} ms`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  requiredEnv('MONITOR_PULL_URL');
  requiredEnv('MONITOR_PUSH_URL');
  requiredEnv('MONITOR_SHARED_SECRET');

  const batch = await fetchBatch();
  if (!batch.items || batch.items.length === 0) {
    console.log('No hay URLs pendientes.');
    return;
  }

  console.log(`Lote recibido: ${batch.items.length} URL(s)`);
  const browser = await createBrowser();

  try {
    const results = await runWithConcurrency(batch.items, browser, 2);
    await pushResults({
      lease_token: batch.lease_token,
      results
    });
    console.log(`Resultados enviados: ${results.length}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

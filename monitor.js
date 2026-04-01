const { fetchBatch } = require('./lib/fetchBatch');
const { pushResults } = require('./lib/pushResults');
const { runVisit, createBrowser } = require('./lib/runVisit');

async function mapLimit(items, limit, asyncMapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await asyncMapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const batch = await fetchBatch();

  const items = Array.isArray(batch.items) ? batch.items : [];
  const leaseToken = batch.lease_token || '';

  console.log(`Lote recibido: ${items.length} URL(s)`);

  if (items.length === 0) {
    console.log('No hay URLs pendientes para revisar.');
    return;
  }

  const browser = await createBrowser();

  try {
    const results = await mapLimit(items, 2, async (item) => {
      console.log(`Visitando [${item.id}] ${item.url}`);
      const result = await runVisit(item, browser);
      console.log(`Resultado [${item.id}] ${result.status} ${result.load_ms} ms`);
      return result;
    });

    const pushed = await pushResults(leaseToken, results);
    console.log(`Resultados enviados: ${pushed.updated_count ?? results.length}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

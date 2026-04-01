const { chromium } = require('playwright');

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isThirdParty(url, originHost) {
  try {
    const u = new URL(url);
    return u.hostname !== originHost && !u.hostname.endsWith('.' + originHost);
  } catch {
    return true;
  }
}

async function dismissCommonBanners(page) {
  const candidates = [
    page.getByRole('button', { name: /aceptar todo|accept all/i }),
    page.getByRole('button', { name: /aceptar|accept|ok|entendido|de acuerdo/i }),
    page.getByRole('link', { name: /aceptar|accept/i }),
  ];

  for (const locator of candidates) {
    try {
      const target = locator.first();
      if (await target.isVisible({ timeout: 1500 })) {
        await target.click({ timeout: 3000 });
        await sleep(800);
        return true;
      }
    } catch {}
  }
  return false;
}

async function waitForNetworkDrain(page, idleMs = 2500, maxWaitMs = 10000) {
  let inflight = 0;
  let lastChange = Date.now();

  const onRequest = () => {
    inflight++;
    lastChange = Date.now();
  };

  const onDone = () => {
    inflight = Math.max(0, inflight - 1);
    lastChange = Date.now();
  };

  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  const start = Date.now();
  try {
    while (Date.now() - start < maxWaitMs) {
      const quietFor = Date.now() - lastChange;
      if (inflight === 0 && quietFor >= idleMs) return true;
      await sleep(250);
    }
    return false;
  } finally {
    page.removeListener('request', onRequest);
    page.removeListener('requestfinished', onDone);
    page.removeListener('requestfailed', onDone);
  }
}

async function runVisit(item, browser) {
  const startedAt = nowSql();
  const pageErrors = [];
  const requestFailures = [];
  const consoleErrors = [];
  const integrationFailures = [];
  const coreFailures = [];

  let context;
  let page;
  let httpCode = null;
  let loadMs = null;
  let finalUrl = item.url;
  let status = 'fail';
  let errorSummary = '';

  const start = Date.now();

  try {
    const originHost = new URL(item.url).hostname;

    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      screen: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      extraHTTPHeaders: {
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8'
      }
    });

    page = await context.newPage();
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    page.on('pageerror', (err) => {
      pageErrors.push(String(err.message || err));
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('requestfailed', (request) => {
      const entry = `${request.method()} ${request.url()} => ${request.failure()?.errorText || 'unknown'}`;
      requestFailures.push(entry);

      if (isThirdParty(request.url(), originHost)) {
        integrationFailures.push(entry);
      } else {
        coreFailures.push(entry);
      }
    });

    try {
      await page.addLocatorHandler(
        page.locator('body'),
        async () => {
          await dismissCommonBanners(page);
        },
        { noWaitAfter: true }
      );
    } catch {}

    const response = await page.goto(item.url, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });

    httpCode = response ? response.status() : null;
    loadMs = Date.now() - start;
    finalUrl = page.url();

    try {
      await page.waitForLoadState('load', { timeout: 15000 });
    } catch {}

    try {
      await page.mouse.move(300, 250);
      await page.waitForTimeout(600);
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(1200);
      await page.mouse.wheel(0, -400);
    } catch {}

    await dismissCommonBanners(page);

    await page.waitForTimeout(60000);

    await waitForNetworkDrain(page, 2500, 10000);

    const fatalByHttp = httpCode !== null && httpCode >= 500;
    const severeJsErrors = pageErrors.length >= 1;
    const coreNetworkProblems = coreFailures.length >= 1;
    const externalProblems = integrationFailures.length >= 1;

    if (fatalByHttp) {
      status = 'fail';
      errorSummary = `HTTP ${httpCode}`;
    } else if (severeJsErrors || coreNetworkProblems) {
      status = 'fail';
      errorSummary = [
        pageErrors[0] ? `pageerror: ${pageErrors[0]}` : '',
        coreFailures[0] ? `core-requestfailed: ${coreFailures[0]}` : '',
        consoleErrors[0] ? `console: ${consoleErrors[0]}` : ''
      ].filter(Boolean).join(' | ');
    } else if (externalProblems) {
      status = 'warn';
      errorSummary = `integration-requestfailed: ${integrationFailures[0]}`;
    } else {
      status = 'ok';
      errorSummary = '';
    }
  } catch (error) {
    status = 'fail';
    loadMs = Date.now() - start;
    errorSummary = String(error.message || error).slice(0, 1000);
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }

  const finishedAt = nowSql();

  return {
    url_id: item.id,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    http_code: httpCode,
    load_ms: loadMs,
    observe_seconds: 60,
    page_errors: pageErrors.length,
    request_failures: requestFailures.length,
    console_errors: consoleErrors.length,
    final_url: finalUrl,
    error_summary: errorSummary,
    raw: {
      pageErrors,
      requestFailures,
      consoleErrors,
      integrationFailures,
      coreFailures,
      label: item.label,
      url: item.url
    },
    runner_source: 'github_actions'
  };
}

async function createBrowser() {
  return chromium.launch({
    headless: false,
    channel: 'chromium'
  });
}

module.exports = { runVisit, createBrowser };

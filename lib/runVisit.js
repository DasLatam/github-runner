const { chromium } = require('playwright');

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function runVisit(item, browser) {
  const startedAt = nowSql();
  const pageErrors = [];
  const requestFailures = [];
  const consoleErrors = [];

  let context;
  let page;
  let httpCode = null;
  let loadMs = null;
  let finalUrl = item.url;
  let status = 'fail';
  let errorSummary = '';

  const start = Date.now();

  try {
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires'
    });

    page = await context.newPage();
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    page.on('pageerror', (err) => {
      pageErrors.push(String(err.message || err));
    });

    page.on('requestfailed', (request) => {
      requestFailures.push(`${request.method()} ${request.url()} => ${request.failure()?.errorText || 'unknown'}`);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    const response = await page.goto(item.url, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });

    httpCode = response ? response.status() : null;
    loadMs = Date.now() - start;
    finalUrl = page.url();

    await page.waitForTimeout(60000);

    const fatalByHttp = httpCode !== null && httpCode >= 500;
    const severeJsErrors = pageErrors.length >= 1;
    const manyRequestFailures = requestFailures.length >= 3;

    if (fatalByHttp) {
      status = 'fail';
      errorSummary = `HTTP ${httpCode}`;
    } else if (severeJsErrors || manyRequestFailures) {
      status = 'warn';
      errorSummary = [
        pageErrors[0] ? `pageerror: ${pageErrors[0]}` : '',
        requestFailures[0] ? `requestfailed: ${requestFailures[0]}` : '',
        consoleErrors[0] ? `console: ${consoleErrors[0]}` : ''
      ].filter(Boolean).join(' | ');
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
      label: item.label,
      url: item.url
    },
    runner_source: 'github_actions'
  };
}

async function createBrowser() {
  return chromium.launch({ headless: true });
}

module.exports = { runVisit, createBrowser };

const { chromium } = require('playwright');

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeUrlHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isSameSite(hostname, originHost) {
  return hostname === originHost || hostname.endsWith('.' + originHost);
}

function looksLikeSeverePageError(message) {
  return /ReferenceError|SyntaxError|Cannot read properties|is not defined|Unexpected token/i.test(message || '');
}

function classifyFailure(request, originHost) {
  const url = request.url();
  const hostname = safeUrlHost(url);
  const resourceType = request.resourceType();
  const sameSite = isSameSite(hostname, originHost);
  const failureText = String(request.failure()?.errorText || 'unknown');

  const ignorableTypes = new Set(['image', 'media', 'font']);
  const hardTypes = new Set(['document', 'script', 'stylesheet']);
  const softSameSiteTypes = new Set(['xhr', 'fetch']);

  const ignore = ignorableTypes.has(resourceType) && /ERR_ABORTED/i.test(failureText);
  const isHard = sameSite && hardTypes.has(resourceType) && !ignore;
  const isSoftSameSite = sameSite && softSameSiteTypes.has(resourceType) && !ignore;
  const isExternal = !sameSite && !ignore;

  return {
    url,
    hostname,
    resourceType,
    sameSite,
    failureText,
    ignore,
    isHard,
    isSoftSameSite,
    isExternal,
  };
}

async function dismissCommonBanners(page) {
  const candidates = [
    page.getByRole('button', { name: /aceptar todo|accept all/i }),
    page.getByRole('button', { name: /aceptar|accept|ok|entendido|de acuerdo|allow all/i }),
    page.getByRole('link', { name: /aceptar|accept/i }),
  ];

  for (const locator of candidates) {
    try {
      const target = locator.first();
      if (await target.isVisible({ timeout: 1200 })) {
        await target.click({ timeout: 2500 });
        await sleep(800);
        return 'banner';
      }
    } catch {}
  }
  return '';
}

async function waitForNetworkDrain(page, idleMs = 2000, maxWaitMs = 8000) {
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

async function basicHumanActivity(page, actionsPerformed) {
  try {
    await page.mouse.move(300, 250);
    await page.waitForTimeout(500);
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(900);
    await page.mouse.wheel(0, -300);
    actionsPerformed.push('scroll');
  } catch {}
}

async function clickSelectorIfPresent(page, selector, actionsPerformed) {
  if (!selector) return false;
  try {
    const target = page.locator(selector).first();
    if (await target.isVisible({ timeout: 2500 })) {
      await target.click({ timeout: 4000 });
      await page.waitForTimeout(1200);
      actionsPerformed.push(`click:${selector}`);
      return true;
    }
  } catch {}
  return false;
}

async function tryVideoInteraction(page, actionsPerformed) {
  const selectors = [
    'button[aria-label*="Play"]',
    'button[title*="Play"]',
    'button.ytp-play-button',
    'video',
    '.html5-video-player',
    '[data-title-no-tooltip="Play"]'
  ];

  for (const selector of selectors) {
    try {
      const target = page.locator(selector).first();
      if (await target.isVisible({ timeout: 1800 })) {
        await target.click({ timeout: 3000 });
        await page.waitForTimeout(1200);
        actionsPerformed.push(`media:${selector}`);
        return true;
      }
    } catch {}
  }

  try {
    await page.keyboard.press('k');
    await page.waitForTimeout(1000);
    actionsPerformed.push('media:key-k');
    return true;
  } catch {}

  return false;
}

function buildSummary(status, data) {
  const pieces = [];
  if (status === 'ok') {
    if (data.softSameSiteFailures.length > 0) pieces.push(`same-site ${data.softSameSiteFailures.length}`);
    if (data.externalFailures.length > 0) pieces.push(`externos ${data.externalFailures.length}`);
    if (data.consoleErrors.length > 0) pieces.push(`console ${data.consoleErrors.length}`);
    if (data.actionsPerformed.length > 0) pieces.push(`acciones ${data.actionsPerformed.join(',')}`);
    return pieces.length > 0 ? `No críticos: ${pieces.join(' | ')}` : '';
  }

  if (status === 'warn') {
    if (data.softSameSiteFailures.length > 0) pieces.push(`same-site ${data.softSameSiteFailures.length}`);
    if (data.externalFailures.length > 0) pieces.push(`externos ${data.externalFailures.length}`);
    if (data.consoleErrors.length > 0) pieces.push(`console ${data.consoleErrors.length}`);
    if (data.actionsPerformed.length > 0) pieces.push(`acciones ${data.actionsPerformed.join(',')}`);
    return pieces.join(' | ');
  }

  return data.errorSummary || '';
}

async function runVisit(item, browser) {
  const startedAt = nowSql();
  const pageErrors = [];
  const requestFailures = [];
  const consoleErrors = [];
  const externalFailures = [];
  const softSameSiteFailures = [];
  const hardFailures = [];
  const actionsPerformed = [];

  let context;
  let page;
  let httpCode = null;
  let loadMs = null;
  let finalUrl = item.url;
  let status = 'fail';
  let errorSummary = '';

  const visitMode = item.visit_mode || 'simple';
  const clickSelector = item.click_selector || '';
  const start = Date.now();

  try {
    const originHost = safeUrlHost(item.url);

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
      const info = classifyFailure(request, originHost);
      if (info.ignore) {
        return;
      }

      const entry = `${request.method()} ${request.url()} => ${info.failureText} [${info.resourceType}]`;
      requestFailures.push(entry);

      if (info.isHard) {
        hardFailures.push(entry);
      } else if (info.isSoftSameSite) {
        softSameSiteFailures.push(entry);
      } else if (info.isExternal) {
        externalFailures.push(entry);
      }
    });

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

    const dismissed = await dismissCommonBanners(page);
    if (dismissed) actionsPerformed.push(dismissed);

    await basicHumanActivity(page, actionsPerformed);

    if (visitMode === 'cookies') {
      const dismissedAgain = await dismissCommonBanners(page);
      if (dismissedAgain) actionsPerformed.push('cookies');
    }

    if (visitMode === 'click_selector' && clickSelector) {
      await clickSelectorIfPresent(page, clickSelector, actionsPerformed);
    }

    if (visitMode === 'video') {
      await tryVideoInteraction(page, actionsPerformed);
    }

    await page.waitForTimeout(45000);
    await waitForNetworkDrain(page, 2000, 8000);

    const fatalByHttp = httpCode === null || httpCode >= 400;
    const severePageErrors = pageErrors.filter(looksLikeSeverePageError);
    const tooManySoftSameSite = softSameSiteFailures.length >= 4;
    const tooManyExternal = externalFailures.length >= 8;
    const tooManyConsole = consoleErrors.length >= 3;

    if (fatalByHttp) {
      status = 'fail';
      errorSummary = httpCode === null ? 'No hubo respuesta HTTP' : `HTTP ${httpCode}`;
    } else if (hardFailures.length >= 1) {
      status = 'fail';
      errorSummary = `core-requestfailed: ${hardFailures[0]}`;
    } else if (severePageErrors.length >= 1) {
      status = 'fail';
      errorSummary = `pageerror: ${severePageErrors[0]}`;
    } else if (tooManySoftSameSite || tooManyExternal || tooManyConsole) {
      status = 'warn';
      errorSummary = buildSummary('warn', { softSameSiteFailures, externalFailures, consoleErrors, actionsPerformed });
    } else {
      status = 'ok';
      errorSummary = buildSummary('ok', { softSameSiteFailures, externalFailures, consoleErrors, actionsPerformed });
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
    observe_seconds: 45,
    page_errors: pageErrors.length,
    request_failures: requestFailures.length,
    console_errors: consoleErrors.length,
    final_url: finalUrl,
    error_summary: errorSummary,
    raw: {
      pageErrors,
      requestFailures,
      consoleErrors,
      externalFailures,
      softSameSiteFailures,
      hardFailures,
      actionsPerformed,
      visitMode,
      clickSelector,
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

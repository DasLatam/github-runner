function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, label = 'request') {
  const attempts = [15000, 25000, 35000];
  let lastError = null;

  for (let i = 0; i < attempts.length; i++) {
    const timeoutMs = attempts[i];
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      return response;
    } catch (error) {
      lastError = error;
      const isLast = i === attempts.length - 1;
      console.warn(`[${label}] intento ${i + 1}/${attempts.length} falló: ${error.message || error}`);
      if (!isLast) {
        await sleep(2000 * (i + 1));
      }
    }
  }

  throw new Error(`[${label}] fetch failed tras ${attempts.length} intentos: ${lastError?.message || lastError}`);
}

async function pushResults(leaseToken, results) {
  const url = process.env.MONITOR_PUSH_URL;
  const secret = process.env.MONITOR_SHARED_SECRET;

  if (!url) {
    throw new Error('Falta MONITOR_PUSH_URL');
  }
  if (!secret) {
    throw new Error('Falta MONITOR_SHARED_SECRET');
  }

  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: JSON.stringify({
        lease_token: leaseToken,
        results,
      }),
    },
    'push-results'
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`No se pudieron enviar resultados: HTTP ${response.status} - ${text.slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Respuesta inválida en push-results: ${text.slice(0, 500)}`);
  }

  return data;
}

module.exports = { pushResults };

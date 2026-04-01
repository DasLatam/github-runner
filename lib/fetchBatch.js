async function fetchBatch() {
  const url = process.env.MONITOR_PULL_URL;
  const secret = process.env.MONITOR_SHARED_SECRET;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`No se pudo pedir lote: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || 'Respuesta inválida de pull');
  }

  return data;
}

module.exports = { fetchBatch };

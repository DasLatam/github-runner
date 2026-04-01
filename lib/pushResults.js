async function pushResults(payload) {
  const url = process.env.MONITOR_PUSH_URL;
  const secret = process.env.MONITOR_SHARED_SECRET;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`No se pudieron enviar resultados: HTTP ${response.status} - ${text}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || 'Respuesta inválida de push');
  }

  return data;
}

module.exports = { pushResults };

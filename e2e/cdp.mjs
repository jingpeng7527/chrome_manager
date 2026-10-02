// Minimal Chrome DevTools Protocol client. Node 22 ships fetch and WebSocket,
// so driving a real browser needs no dependencies.

export async function listTargets() {
  return (await fetch('http://localhost:9222/json')).json();
}

export async function openTarget(url) {
  return (await fetch(`http://localhost:9222/json/new?${url}`, { method: 'PUT' })).json();
}

export async function closeTarget(id) {
  await fetch(`http://localhost:9222/json/close/${id}`).catch(() => {});
}

export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let nextId = 0;
  const open = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  const send = async (method, params = {}) => {
    await open;
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  return { send, events, close: () => ws.close() };
}

export async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const failure = r.result?.exceptionDetails;
  if (failure) {
    throw new Error(failure.exception?.description ?? failure.text ?? 'evaluate failed');
  }
  return r.result?.result?.value;
}

export function exceptionsOf(cdp) {
  return cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text);
}

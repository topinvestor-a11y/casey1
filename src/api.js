async function handle(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  if (!res.ok) {
    const message = (body && body.error) || `요청이 실패했어요 (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function fetchBootstrap() {
  return fetch("/api/bootstrap").then(handle);
}

export function createRequest(payload) {
  return fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(handle);
}

export function respondToRequest(id, accept) {
  return fetch(`/api/requests/${id}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accept }),
  }).then(handle);
}

export function cancelRequest(id) {
  return fetch(`/api/requests/${id}/cancel`, { method: "POST" }).then(handle);
}

export function generateNextWeek(pin) {
  return fetch("/api/shifts/generate-next-week", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  }).then(handle);
}

export function replaceEmployee(payload) {
  return fetch("/api/admin/replace-employee", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(handle);
}

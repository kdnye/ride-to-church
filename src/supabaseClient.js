const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

export async function sbRequest(endpoint, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.message ?? `Supabase request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.code;
    error.details = data?.details;
    error.hint = data?.hint;
    error.payload = data;
    throw error;
  }

  return data;
}


export async function createSession({ id, userId, role, approvalStatus, expiresAt }) {
  const rows = await sbRequest('/rest/v1/sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id,
      user_id: userId,
      role,
      approval_status: approvalStatus,
      expires_at: expiresAt,
    }),
  });

  return rows[0] ?? null;
}

export async function fetchSessionById(sessionId) {
  const rows = await sbRequest(`/rest/v1/sessions?id=eq.${sessionId}&select=id,user_id,role,approval_status,expires_at&limit=1`);
  return rows[0] ?? null;
}

export async function deleteSessionById(sessionId) {
  await sbRequest(`/rest/v1/sessions?id=eq.${sessionId}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

export async function deleteSessionsByUserId(userId) {
  await sbRequest(`/rest/v1/sessions?user_id=eq.${userId}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

export async function extendSessionExpiry({ sessionId, expiresAt }) {
  await sbRequest(`/rest/v1/sessions?id=eq.${sessionId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ expires_at: expiresAt }),
  });
}

export async function deleteExpiredSessions(nowIso = new Date().toISOString()) {
  await sbRequest(`/rest/v1/sessions?expires_at=lt.${encodeURIComponent(nowIso)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

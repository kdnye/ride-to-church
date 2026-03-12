const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

export async function sbRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...options.headers,
    },
  });

  const text = await res.text();
  
  if (!res.ok) {
    // If Supabase returns an error, safely throw it
    throw new Error(text);
  }
  
  // Safely parse the text only if it exists
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Supabase returned invalid JSON:", text);
    throw new Error("Failed to parse database response");
  }
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

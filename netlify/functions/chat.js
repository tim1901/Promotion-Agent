// ── Rate limit config ──────────────────────────────────────────
// Adjust these numbers anytime in your Netlify env vars:
//   DAILY_PLAN_LIMIT   (default: 3)  — full strategy generations per IP per day
//   DAILY_CHAT_LIMIT   (default: 15) — follow-up chat messages per IP per day
// In-memory store resets on each function cold start (good enough for abuse prevention)
const planLimit  = parseInt(process.env.DAILY_PLAN_LIMIT  || '3');
const chatLimit  = parseInt(process.env.DAILY_CHAT_LIMIT  || '15');

const store = {}; // { ip: { date, plans, chats } }

function getRecord(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (!store[ip] || store[ip].date !== today) {
    store[ip] = { date: today, plans: 0, chats: 0 };
  }
  return store[ip];
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  // Get caller IP
  const ip =
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  const rec = getRecord(ip);

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }

  const { messages, systemPrompt, requestType } = body;
  // requestType: 'plan' for initial generation, 'chat' for follow-ups
  const isPlan = requestType === 'plan';

  // ── Check limits ──────────────────────────────────────────────
  if (isPlan && rec.plans >= planLimit) {
    return new Response(JSON.stringify({
      error: 'rate_limit',
      message: `You've used your ${planLimit} free plan${planLimit > 1 ? 's' : ''} for today. Come back tomorrow for a fresh start!`,
      resetAt: 'midnight'
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }

  if (!isPlan && rec.chats >= chatLimit) {
    return new Response(JSON.stringify({
      error: 'rate_limit',
      message: `You've reached your ${chatLimit} follow-up messages for today. Come back tomorrow!`,
      resetAt: 'midnight'
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }

  // ── Call Claude ───────────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: systemPrompt,
        messages
      })
    });

    const data = await response.json();

    // Only count against limit on success
    if (data.content) {
      if (isPlan) rec.plans++;
      else rec.chats++;
    }

    // Send back remaining counts so the UI can show them
    return new Response(JSON.stringify({
      ...data,
      _usage: {
        plansUsed:  rec.plans,
        plansLimit: planLimit,
        chatsUsed:  rec.chats,
        chatsLimit: chatLimit,
      }
    }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
};

export const config = { path: '/api/chat' };

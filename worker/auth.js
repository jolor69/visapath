// Magic-link auth for the Document Readiness Checker. Reuses VISAPATH_KV for
// short-lived link tokens and APP_DB (sessions table) for logged-in sessions,
// matching the existing repo's KV-for-ephemeral / D1-for-persistent split.

var MAGIC_LINK_TTL_SECONDS = 900; // 15 minutes to click the link
var SESSION_TTL_SECONDS = 2592000; // 30 days

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders)
  });
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendMagicLinkEmail(env, email, link) {
  if (!env.RESEND_API_KEY) {
    // No email provider configured yet — log so `wrangler tail` shows the link during dev/testing.
    console.log("[auth] RESEND_API_KEY not set — magic link for " + email + ": " + link);
    return;
  }
  // "noreply@neulab.xyz", not a visapath.neulab.xyz subdomain — the Resend API key is
  // domain-restricted to the exact verified domain (neulab.xyz) and 403s on subdomains.
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "VisaPath <noreply@neulab.xyz>",
      to: email,
      subject: "Your VisaPath sign-in link",
      html: "<p>Click below to sign in to VisaPath. This link expires in 15 minutes.</p><p><a href=\"" + link + "\">Sign in to VisaPath</a></p>"
    })
  });

  if (!res.ok) {
    throw new Error("Resend API error " + res.status + ": " + (await res.text()));
  }
}

async function getOrCreateUser(env, email) {
  var existing = await env.APP_DB.prepare("SELECT id, email, plan FROM users WHERE email = ?").bind(email).first();
  if (existing) return existing;

  var id = crypto.randomUUID();
  var now = new Date().toISOString();
  await env.APP_DB.prepare("INSERT INTO users (id, email, created_at, plan) VALUES (?, ?, ?, 'free')")
    .bind(id, email, now).run();
  return { id: id, email: email, plan: "free" };
}

async function handleRequestLink(request, env, corsHeaders) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  var email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    return jsonResponse({ error: "invalid_request", message: "A valid email is required" }, 400, corsHeaders);
  }

  var linkToken = crypto.randomUUID();
  await env.VISAPATH_KV.put("magiclink:" + linkToken, email, { expirationTtl: MAGIC_LINK_TTL_SECONDS });

  var origin = request.headers.get("Origin") || "https://visapath.neulab.xyz";
  var link = origin + "/documents.html?login_token=" + linkToken;

  try {
    await sendMagicLinkEmail(env, email, link);
  } catch (e) {
    return jsonResponse({ error: "email_failed", message: "Could not send sign-in email" }, 502, corsHeaders);
  }

  return jsonResponse({ sent: true }, 200, corsHeaders);
}

async function handleVerify(request, env, corsHeaders) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  var linkToken = body.token;
  if (!linkToken) {
    return jsonResponse({ error: "invalid_request", message: "token is required" }, 400, corsHeaders);
  }

  var email = await env.VISAPATH_KV.get("magiclink:" + linkToken);
  if (!email) {
    return jsonResponse({ error: "invalid_or_expired_token", message: "This sign-in link is invalid or has expired. Request a new one." }, 401, corsHeaders);
  }
  await env.VISAPATH_KV.delete("magiclink:" + linkToken);

  var user = await getOrCreateUser(env, email);

  var sessionToken = crypto.randomUUID();
  var expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.APP_DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(sessionToken, user.id, expiresAt).run();

  return jsonResponse({ session_token: sessionToken, user_id: user.id, plan: user.plan }, 200, corsHeaders);
}

// Resolves the authenticated user for a request, or null if missing/expired.
// Deletes expired sessions opportunistically rather than running a separate cleanup job.
async function requireAuth(request, env) {
  var authHeader = request.headers.get("Authorization") || "";
  var match = /^Bearer\s+(.+)$/.exec(authHeader);
  if (!match) return null;

  var token = match[1];
  var row = await env.APP_DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").bind(token).first();
  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.APP_DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }

  var user = await env.APP_DB.prepare("SELECT id, email, plan FROM users WHERE id = ?").bind(row.user_id).first();
  return user || null;
}

export { handleRequestLink, handleVerify, requireAuth, isValidEmail };

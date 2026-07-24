const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// Rate limit config
var FREE_DAILY_LIMIT = 5;
var WINDOW_SECONDS = 86400; // 24 hours

// PayPal config (sandbox)
var PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
var PER_TRIP_PRICE_USD = "2.00";
var PAID_TOKEN_TTL_SECONDS = 3600; // 1 hour to redeem after payment

var SYSTEM_PROMPT = "You are VisaPath, a visa requirements data API. You MUST respond with raw JSON only. No markdown. No backticks. No explanation. No preamble. Your entire response must be a single valid JSON object that can be passed directly to JSON.parse().\n\nCRITICAL URL RULES:\n- official_url: Must be the REAL, LIVE official government page for visa info. Use well-known domains only: canada.ca, gov.uk, homeaffairs.gov.au, mfa.gov.sg, mofa.go.jp, mfa.gov.cn, state.gov, etc. NEVER use subdomains like canadainternational.gc.ca or missions.gc.ca as they are often retired. When in doubt about a URL, set it to null rather than guessing.\n- embassy_url: Must be the REAL, LIVE embassy or consulate website in the passport holder's country. Use the main embassy domain. If unsure, set to null.\n- NEVER fabricate or guess URLs. A null URL is better than a dead link.\n\nKNOWN CORRECT URLS (always use these):\n- Canada visa info: https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada.html\n- UK visa info: https://www.gov.uk/check-uk-visa\n- Australia visa info: https://immi.homeaffairs.gov.au\n- USA visa info: https://travel.state.gov/content/travel/en/us-visas.html\n- Japan visa info: https://www.mofa.go.jp/j_info/visit/visa/index.html\n- Singapore MFA: https://www.mfa.gov.sg\n- Schengen/EU: https://home-affairs.ec.europa.eu/policies/schengen-borders-and-visa_en\n\nRespond ONLY with this exact JSON structure:\n{\n  \"visa_required\": true | false | \"visa_on_arrival\" | \"e_visa\" | \"unknown\",\n  \"visa_type\": \"string or null\",\n  \"max_stay_days\": number or null,\n  \"cost_usd\": number or null,\n  \"cost_local\": \"string or null\",\n  \"processing_days_min\": number or null,\n  \"processing_days_max\": number or null,\n  \"entry_type\": \"single\" | \"multiple\" | \"varies\" | null,\n  \"validity_days\": number or null,\n  \"documents_required\": [\"array of strings\"],\n  \"special_notes\": [\"array of important notes, warnings, or conditions\"],\n  \"official_url\": \"string or null\",\n  \"embassy_url\": \"string or null\",\n  \"last_known_update\": \"string\",\n  \"confidence\": \"high\" | \"medium\" | \"low\",\n  \"summary\": \"2-3 sentence plain English summary\"\n}";

function getClientIP(request) {
  return request.headers.get("CF-Connecting-IP") ||
         request.headers.get("X-Forwarded-For") ||
         "unknown";
}

async function checkRateLimit(env, ip) {
  if (!env.VISAPATH_KV) return { allowed: true, remaining: FREE_DAILY_LIMIT, reset: 0 };

  var key = "rl:" + ip;
  var now = Math.floor(Date.now() / 1000);
  var windowStart = now - WINDOW_SECONDS;

  var raw = null;
  try {
    raw = await env.VISAPATH_KV.get(key);
  } catch (e) {
    // KV unavailable - fail open
    return { allowed: true, remaining: FREE_DAILY_LIMIT, reset: 0 };
  }

  var data = raw ? JSON.parse(raw) : { count: 0, window_start: now };

  // Reset if window expired
  if (data.window_start < windowStart) {
    data = { count: 0, window_start: now };
  }

  var remaining = FREE_DAILY_LIMIT - data.count;
  var resetAt = data.window_start + WINDOW_SECONDS;

  if (data.count >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0, reset: resetAt };
  }

  // Increment
  data.count += 1;
  try {
    await env.VISAPATH_KV.put(key, JSON.stringify(data), { expirationTtl: WINDOW_SECONDS });
  } catch (e) {
    // KV write failed - still allow
  }

  return { allowed: true, remaining: FREE_DAILY_LIMIT - data.count, reset: resetAt };
}

async function getPayPalAccessToken(env) {
  var creds = btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_SECRET);
  var res = await fetch(PAYPAL_API_BASE + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + creds,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) {
    throw new Error("PayPal auth failed: " + (await res.text()));
  }
  var data = await res.json();
  return data.access_token;
}

async function handlePayPalCreateOrder(request, env) {
  var accessToken;
  try {
    accessToken = await getPayPalAccessToken(env);
  } catch (e) {
    return new Response(JSON.stringify({ error: "PayPal unavailable" }), {
      status: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var orderRes = await fetch(PAYPAL_API_BASE + "/v2/checkout/orders", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        description: "VisaPath - 1 trip check",
        amount: { currency_code: "USD", value: PER_TRIP_PRICE_USD }
      }]
    })
  });

  if (!orderRes.ok) {
    return new Response(JSON.stringify({ error: "Could not create PayPal order" }), {
      status: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var order = await orderRes.json();
  return new Response(JSON.stringify({ id: order.id }), {
    status: 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
  });
}

async function handlePayPalCaptureOrder(request, env) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var orderID = body.orderID;
  if (!orderID) {
    return new Response(JSON.stringify({ error: "orderID is required" }), {
      status: 400,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var accessToken;
  try {
    accessToken = await getPayPalAccessToken(env);
  } catch (e) {
    return new Response(JSON.stringify({ error: "PayPal unavailable" }), {
      status: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var captureRes = await fetch(PAYPAL_API_BASE + "/v2/checkout/orders/" + orderID + "/capture", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "application/json"
    }
  });

  var captureData = await captureRes.json();
  var status = captureData.status;
  var completed = status === "COMPLETED" ||
    (captureData.purchase_units &&
     captureData.purchase_units[0] &&
     captureData.purchase_units[0].payments &&
     captureData.purchase_units[0].payments.captures &&
     captureData.purchase_units[0].payments.captures[0] &&
     captureData.purchase_units[0].payments.captures[0].status === "COMPLETED");

  if (!captureRes.ok || !completed) {
    return new Response(JSON.stringify({ error: "Payment not completed", status: status || "unknown" }), {
      status: 402,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var token = crypto.randomUUID();
  if (env.VISAPATH_KV) {
    try {
      await env.VISAPATH_KV.put("paid:" + token, "1", { expirationTtl: PAID_TOKEN_TTL_SECONDS });
    } catch (e) {
      // KV write failed - payment still succeeded, but token can't be redeemed
      return new Response(JSON.stringify({ error: "Payment captured but could not issue access" }), {
        status: 500,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, token: token }), {
    status: 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
  });
}

async function redeemPaidToken(env, token) {
  if (!token || !env.VISAPATH_KV) return false;
  var key = "paid:" + token;
  var val = await env.VISAPATH_KV.get(key);
  if (!val) return false;
  await env.VISAPATH_KV.delete(key);
  return true;
}

async function handleVisaCheck(request, env) {
  var ip = getClientIP(request);

  // Allow a paid ($2/trip) token to bypass the free daily limit
  var bodyForToken;
  try {
    bodyForToken = await request.clone().json();
  } catch (e) {
    bodyForToken = {};
  }
  var paidAccess = await redeemPaidToken(env, bodyForToken.paid_token);

  var rateCheck = paidAccess
    ? { allowed: true, remaining: FREE_DAILY_LIMIT, reset: 0 }
    : await checkRateLimit(env, ip);

  if (!rateCheck.allowed) {
    var resetDate = new Date(rateCheck.reset * 1000).toUTCString();
    return new Response(JSON.stringify({
      error: "rate_limited",
      message: "You have reached the free limit of " + FREE_DAILY_LIMIT + " checks per day. Limit resets at " + resetDate + ".",
      reset_at: rateCheck.reset
    }), {
      status: 429,
      headers: Object.assign({
        "Content-Type": "application/json",
        "X-RateLimit-Limit": String(FREE_DAILY_LIMIT),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(rateCheck.reset)
      }, CORS_HEADERS)
    });
  }

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var passport = body.passport;
  var destination = body.destination;
  var purpose = body.purpose || "tourism";

  if (!passport || !destination) {
    return new Response(JSON.stringify({ error: "passport and destination are required" }), {
      status: 400,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var userPrompt = "Passport: " + passport + "\nDestination: " + destination + "\nPurpose: " + purpose + "\n\nProvide current visa requirements for this combination. IMPORTANT: Respond with raw JSON only. No markdown, no backticks, no explanation — just the JSON object.";

  var payload = {
    model: "deepseek/deepseek-chat",
    max_tokens: 1500,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ]
  };

  var orResponse;
  try {
    orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.OPENROUTER_API_KEY,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://visapath.neulab.xyz",
        "X-Title": "VisaPath by NeuLab"
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "AI service unreachable" }), {
      status: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  if (!orResponse.ok) {
    var errText = await orResponse.text();
    return new Response(JSON.stringify({ error: "AI service error", detail: errText }), {
      status: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var orData = await orResponse.json();
  var rawContent = "";
  try {
    rawContent = orData.choices[0].message.content;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Unexpected AI response shape" }), {
      status: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var cleaned = rawContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    try {
      parsed = JSON.parse(cleaned.replace(/'/g, '"'));
    } catch (e2) {
      return new Response(JSON.stringify({ error: "Could not parse AI response", raw: rawContent }), {
        status: 502,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
      });
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    data: parsed,
    meta: { remaining: rateCheck.remaining, limit: FREE_DAILY_LIMIT }
  }), {
    status: 200,
    headers: Object.assign({
      "Content-Type": "application/json",
      "X-RateLimit-Limit": String(FREE_DAILY_LIMIT),
      "X-RateLimit-Remaining": String(rateCheck.remaining),
      "X-RateLimit-Reset": String(rateCheck.reset)
    }, CORS_HEADERS)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    var url = new URL(request.url);

    if (url.pathname === "/visa-check" && request.method === "POST") {
      return handleVisaCheck(request, env);
    }

    if (url.pathname === "/paypal/create-order" && request.method === "POST") {
      return handlePayPalCreateOrder(request, env);
    }

    if (url.pathname === "/paypal/capture-order" && request.method === "POST") {
      return handlePayPalCaptureOrder(request, env);
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "visapath-worker" }), {
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }
};

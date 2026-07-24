const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// Rate limit config
var FREE_MONTHLY_LIMIT = 5;
var WINDOW_SECONDS = 2592000; // 30 days

// PayPal config (sandbox)
var PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
var PER_TRIP_PRICE_USD = "2.00";
var PAID_TOKEN_TTL_SECONDS = 3600; // 1 hour to redeem after payment

// Subscription plans
var PLAN_CONFIG = {
  "P-88G05256MP579394MNJR4V2Q": { name: "traveller", cap: 100 },
  "P-9FJ341183H741142NNJR4V2Y": { name: "nomad_pro", cap: 400 }
};

var SYSTEM_PROMPT = "You are VisaPath, a visa requirements data API. You MUST respond with raw JSON only. No markdown. No backticks. No explanation. No preamble. Your entire response must be a single valid JSON object that can be passed directly to JSON.parse().\n\nCRITICAL URL RULES:\n- official_url: Must be the REAL, LIVE official government page for visa info. Use well-known domains only: canada.ca, gov.uk, homeaffairs.gov.au, mfa.gov.sg, mofa.go.jp, mfa.gov.cn, state.gov, etc. NEVER use subdomains like canadainternational.gc.ca or missions.gc.ca as they are often retired. When in doubt about a URL, set it to null rather than guessing.\n- embassy_url: Must be the REAL, LIVE embassy or consulate website in the passport holder's country. Use the main embassy domain. If unsure, set to null.\n- NEVER fabricate or guess URLs. A null URL is better than a dead link.\n\nKNOWN CORRECT URLS (always use these):\n- Canada visa info: https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada.html\n- UK visa info: https://www.gov.uk/check-uk-visa\n- Australia visa info: https://immi.homeaffairs.gov.au\n- USA visa info: https://travel.state.gov/content/travel/en/us-visas.html\n- Japan visa info: https://www.mofa.go.jp/j_info/visit/visa/index.html\n- Singapore MFA: https://www.mfa.gov.sg\n- Schengen/EU: https://home-affairs.ec.europa.eu/policies/schengen-borders-and-visa_en\n\nRespond ONLY with this exact JSON structure:\n{\n  \"visa_required\": true | false | \"visa_on_arrival\" | \"e_visa\" | \"unknown\",\n  \"visa_type\": \"string or null\",\n  \"max_stay_days\": number or null,\n  \"cost_usd\": number or null,\n  \"cost_local\": \"string or null\",\n  \"processing_days_min\": number or null,\n  \"processing_days_max\": number or null,\n  \"entry_type\": \"single\" | \"multiple\" | \"varies\" | null,\n  \"validity_days\": number or null,\n  \"documents_required\": [\"array of strings\"],\n  \"special_notes\": [\"array of important notes, warnings, or conditions\"],\n  \"official_url\": \"string or null\",\n  \"embassy_url\": \"string or null\",\n  \"last_known_update\": \"string\",\n  \"confidence\": \"high\" | \"medium\" | \"low\",\n  \"summary\": \"2-3 sentence plain English summary\"\n}";

function getClientIP(request) {
  return request.headers.get("CF-Connecting-IP") ||
         request.headers.get("X-Forwarded-For") ||
         "unknown";
}

async function checkRateLimit(env, ip) {
  if (!env.VISAPATH_KV) return { allowed: true, remaining: FREE_MONTHLY_LIMIT, reset: 0 };

  var key = "rl:" + ip;
  var now = Math.floor(Date.now() / 1000);
  var windowStart = now - WINDOW_SECONDS;

  var raw = null;
  try {
    raw = await env.VISAPATH_KV.get(key);
  } catch (e) {
    // KV unavailable - fail open
    return { allowed: true, remaining: FREE_MONTHLY_LIMIT, reset: 0 };
  }

  var data = raw ? JSON.parse(raw) : { count: 0, window_start: now };

  // Reset if window expired
  if (data.window_start < windowStart) {
    data = { count: 0, window_start: now };
  }

  var remaining = FREE_MONTHLY_LIMIT - data.count;
  var resetAt = data.window_start + WINDOW_SECONDS;

  if (data.count >= FREE_MONTHLY_LIMIT) {
    return { allowed: false, remaining: 0, reset: resetAt };
  }

  // Increment
  data.count += 1;
  try {
    await env.VISAPATH_KV.put(key, JSON.stringify(data), { expirationTtl: WINDOW_SECONDS });
  } catch (e) {
    // KV write failed - still allow
  }

  return { allowed: true, remaining: FREE_MONTHLY_LIMIT - data.count, reset: resetAt };
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

async function handlePayPalVerifySubscription(request, env) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var subscriptionID = body.subscriptionID;
  if (!subscriptionID) {
    return new Response(JSON.stringify({ error: "subscriptionID is required" }), {
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

  var subRes = await fetch(PAYPAL_API_BASE + "/v1/billing/subscriptions/" + subscriptionID, {
    headers: { "Authorization": "Bearer " + accessToken }
  });

  if (!subRes.ok) {
    return new Response(JSON.stringify({ error: "Could not verify subscription" }), {
      status: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var sub = await subRes.json();
  var planConfig = PLAN_CONFIG[sub.plan_id];

  if (!planConfig || sub.status !== "ACTIVE") {
    return new Response(JSON.stringify({ error: "Subscription is not active", status: sub.status || "unknown" }), {
      status: 402,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  var token = crypto.randomUUID();
  var now = Math.floor(Date.now() / 1000);
  var record = {
    subscription_id: subscriptionID,
    plan: planConfig.name,
    cap: planConfig.cap,
    cycle_start: now,
    used: 0,
    active: true
  };

  if (!env.VISAPATH_KV) {
    return new Response(JSON.stringify({ error: "Storage unavailable" }), {
      status: 500,
      headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
    });
  }

  await env.VISAPATH_KV.put("sub:" + token, JSON.stringify(record));
  await env.VISAPATH_KV.put("subid:" + subscriptionID, token);

  return new Response(JSON.stringify({
    ok: true, token: token, plan: planConfig.name, cap: planConfig.cap
  }), {
    status: 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
  });
}

async function handlePayPalWebhook(request, env) {
  var rawBody = await request.text();
  var webhookEvent;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch (e) {
    return new Response("Invalid payload", { status: 400 });
  }

  var accessToken;
  try {
    accessToken = await getPayPalAccessToken(env);
  } catch (e) {
    return new Response("PayPal unavailable", { status: 502 });
  }

  var verifyRes = await fetch(PAYPAL_API_BASE + "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      auth_algo: request.headers.get("paypal-auth-algo"),
      cert_url: request.headers.get("paypal-cert-url"),
      transmission_id: request.headers.get("paypal-transmission-id"),
      transmission_sig: request.headers.get("paypal-transmission-sig"),
      transmission_time: request.headers.get("paypal-transmission-time"),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: webhookEvent
    })
  });

  var verifyData = await verifyRes.json();
  if (!verifyRes.ok || verifyData.verification_status !== "SUCCESS") {
    return new Response("Signature verification failed", { status: 400 });
  }

  var eventType = webhookEvent.event_type;
  var subscriptionID = webhookEvent.resource && webhookEvent.resource.id;

  if (subscriptionID && env.VISAPATH_KV) {
    var token = await env.VISAPATH_KV.get("subid:" + subscriptionID);
    if (token) {
      var raw = await env.VISAPATH_KV.get("sub:" + token);
      if (raw) {
        var record = JSON.parse(raw);
        if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {
          record.active = true;
        } else if (
          eventType === "BILLING.SUBSCRIPTION.CANCELLED" ||
          eventType === "BILLING.SUBSCRIPTION.EXPIRED" ||
          eventType === "BILLING.SUBSCRIPTION.SUSPENDED"
        ) {
          record.active = false;
        }
        await env.VISAPATH_KV.put("sub:" + token, JSON.stringify(record));
      }
    }
  }

  return new Response("OK", { status: 200 });
}

async function redeemPaidToken(env, token) {
  if (!token || !env.VISAPATH_KV) return false;
  var key = "paid:" + token;
  var val = await env.VISAPATH_KV.get(key);
  if (!val) return false;
  await env.VISAPATH_KV.delete(key);
  return true;
}

async function checkSubQuota(env, subToken) {
  if (!subToken || !env.VISAPATH_KV) return null;
  var raw = await env.VISAPATH_KV.get("sub:" + subToken);
  if (!raw) return { valid: false };

  var record = JSON.parse(raw);
  if (!record.active) return { valid: true, active: false, plan: record.plan };

  var now = Math.floor(Date.now() / 1000);
  if (now - record.cycle_start >= WINDOW_SECONDS) {
    record.used = 0;
    record.cycle_start = now;
  }

  if (record.used >= record.cap) {
    await env.VISAPATH_KV.put("sub:" + subToken, JSON.stringify(record));
    return {
      valid: true, active: true, allowed: false,
      plan: record.plan, cap: record.cap, remaining: 0,
      reset: record.cycle_start + WINDOW_SECONDS
    };
  }

  record.used += 1;
  await env.VISAPATH_KV.put("sub:" + subToken, JSON.stringify(record));
  return {
    valid: true, active: true, allowed: true,
    plan: record.plan, cap: record.cap, remaining: record.cap - record.used,
    reset: record.cycle_start + WINDOW_SECONDS
  };
}

async function handleVisaCheck(request, env) {
  var ip = getClientIP(request);

  var bodyForToken;
  try {
    bodyForToken = await request.clone().json();
  } catch (e) {
    bodyForToken = {};
  }

  var rateCheck;
  var accessPlan = "free";
  var accessLimit = FREE_MONTHLY_LIMIT;
  var paidAccess = await redeemPaidToken(env, bodyForToken.paid_token);

  if (paidAccess) {
    // One-off $2/trip unlock
    accessPlan = "per_trip";
    rateCheck = { allowed: true, remaining: 1, reset: 0 };
  } else if (bodyForToken.sub_token) {
    // Active subscription plan (Traveller / Nomad Pro)
    var subResult = await checkSubQuota(env, bodyForToken.sub_token);
    if (!subResult || !subResult.valid) {
      return new Response(JSON.stringify({
        error: "invalid_subscription_token",
        message: "This subscription token is not recognised. Please subscribe again or contact support."
      }), {
        status: 400,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
      });
    }
    if (!subResult.active) {
      return new Response(JSON.stringify({
        error: "subscription_inactive",
        message: "Your subscription is no longer active. Please resubscribe to continue."
      }), {
        status: 402,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
      });
    }
    if (!subResult.allowed) {
      var subResetDate = new Date(subResult.reset * 1000).toUTCString();
      return new Response(JSON.stringify({
        error: "plan_limit_reached",
        message: "You've used all " + subResult.cap + " checks in your plan this cycle. Resets at " + subResetDate + ".",
        reset_at: subResult.reset
      }), {
        status: 429,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
      });
    }
    accessPlan = subResult.plan;
    accessLimit = subResult.cap;
    rateCheck = { allowed: true, remaining: subResult.remaining, reset: subResult.reset };
  } else {
    // Free IP-based monthly limit
    rateCheck = await checkRateLimit(env, ip);
  }

  if (!rateCheck.allowed) {
    var resetDate = new Date(rateCheck.reset * 1000).toUTCString();
    return new Response(JSON.stringify({
      error: "rate_limited",
      message: "You have reached the free limit of " + FREE_MONTHLY_LIMIT + " checks per month. Limit resets at " + resetDate + ".",
      reset_at: rateCheck.reset
    }), {
      status: 429,
      headers: Object.assign({
        "Content-Type": "application/json",
        "X-RateLimit-Limit": String(FREE_MONTHLY_LIMIT),
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
    meta: { remaining: rateCheck.remaining, limit: accessLimit, plan: accessPlan }
  }), {
    status: 200,
    headers: Object.assign({
      "Content-Type": "application/json",
      "X-RateLimit-Limit": String(accessLimit),
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

    if (url.pathname === "/paypal/verify-subscription" && request.method === "POST") {
      return handlePayPalVerifySubscription(request, env);
    }

    if (url.pathname === "/paypal/webhook" && request.method === "POST") {
      return handlePayPalWebhook(request, env);
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const SYSTEM_PROMPT = `You are VisaPath, a visa requirements data API. You MUST respond with raw JSON only. No markdown. No backticks. No explanation. No preamble. Your entire response must be a single valid JSON object that can be passed directly to JSON.parse(). If you add any text outside the JSON object, the system will break.

Respond ONLY with this exact JSON structure:
{
  "visa_required": true | false | "visa_on_arrival" | "e_visa" | "unknown",
  "visa_type": "string or null",
  "max_stay_days": number or null,
  "cost_usd": number or null,
  "cost_local": "string or null",
  "processing_days_min": number or null,
  "processing_days_max": number or null,
  "entry_type": "single" | "multiple" | "varies" | null,
  "validity_days": number or null,
  "documents_required": ["array of strings"],
  "special_notes": ["array of important notes, warnings, or conditions"],
  "official_url": "string or null",
  "embassy_url": "string or null",
  "last_known_update": "string — your best estimate of when this policy was last updated",
  "confidence": "high" | "medium" | "low",
  "summary": "2-3 sentence plain English summary of what the traveller needs to know"
}`;

async function handleVisaCheck(request, env) {
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

  // Strip markdown fences if present
  var cleaned = rawContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Attempt single-quote fix (DeepSeek-style)
    try {
      parsed = JSON.parse(cleaned.replace(/'/g, '"'));
    } catch (e2) {
      return new Response(JSON.stringify({ error: "Could not parse AI response", raw: rawContent }), {
        status: 502,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, data: parsed }), {
    status: 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
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

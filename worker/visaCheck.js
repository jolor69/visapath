// RAG-grounded visa requirement check, extracted from worker/index.js so it can be
// reused by both the /visa-check HTTP route and the document-readiness rules engine
// (readiness.js needs to know "is a visa required for this destination?" without
// duplicating a country-rules table — see visapath-rag-handover.md and the engineering
// blueprint's readiness-rules section).
import { embedTexts } from "./ingest.js";
import { resolveCountryCode } from "./countries.js";

var SYSTEM_PROMPT = "You are VisaPath, a visa requirements data API. You MUST respond with raw JSON only. No markdown. No backticks. No explanation. No preamble. Your entire response must be a single valid JSON object that can be passed directly to JSON.parse().\n\nCRITICAL URL RULES:\n- official_url: Must be the REAL, LIVE official government page for visa info. Use well-known domains only: canada.ca, gov.uk, homeaffairs.gov.au, mfa.gov.sg, mofa.go.jp, mfa.gov.cn, state.gov, etc. NEVER use subdomains like canadainternational.gc.ca or missions.gc.ca as they are often retired. When in doubt about a URL, set it to null rather than guessing.\n- embassy_url: Must be the REAL, LIVE embassy or consulate website in the passport holder's country. Use the main embassy domain. If unsure, set to null.\n- NEVER fabricate or guess URLs. A null URL is better than a dead link.\n\nKNOWN CORRECT URLS (always use these):\n- Canada visa info: https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada.html\n- UK visa info: https://www.gov.uk/check-uk-visa\n- Australia visa info: https://immi.homeaffairs.gov.au\n- USA visa info: https://travel.state.gov/content/travel/en/us-visas.html\n- Japan visa info: https://www.mofa.go.jp/j_info/visit/visa/index.html\n- Singapore MFA: https://www.mfa.gov.sg\n- Schengen/EU: https://home-affairs.ec.europa.eu/policies/schengen-borders-and-visa_en\n\nRespond ONLY with this exact JSON structure:\n{\n  \"visa_required\": true | false | \"visa_on_arrival\" | \"e_visa\" | \"unknown\",\n  \"visa_type\": \"string or null\",\n  \"max_stay_days\": number or null,\n  \"cost_usd\": number or null,\n  \"cost_local\": \"string or null\",\n  \"processing_days_min\": number or null,\n  \"processing_days_max\": number or null,\n  \"entry_type\": \"single\" | \"multiple\" | \"varies\" | null,\n  \"validity_days\": number or null,\n  \"documents_required\": [\"array of strings\"],\n  \"special_notes\": [\"array of important notes, warnings, or conditions\"],\n  \"official_url\": \"string or null\",\n  \"embassy_url\": \"string or null\",\n  \"last_known_update\": \"string\",\n  \"confidence\": \"high\" | \"medium\" | \"low\",\n  \"summary\": \"2-3 sentence plain English summary\",\n  \"citations\": []\n}";

var GROUNDED_PROMPT_PREFIX = "You are answering with RETRIEVED SOURCE CHUNKS below, not from memory. Rules:\n1. Base every factual claim (visa type, stay duration, cost, documents, processing time) ONLY on the chunks provided.\n2. If the chunks do not cover something, set that field to null and note the gap in special_notes rather than filling it from your own knowledge.\n3. Set \"citations\" to an array of objects, one per chunk actually used: {\"source_url\": string, \"source_tier\": string, \"last_verified_date\": string}.\n4. If none of the chunks are relevant to the question, say so in summary and return citations: [].\n\nRETRIEVED SOURCE CHUNKS:\n";

async function retrieveGroundingChunks(env, destination, purpose) {
  var countryCode = resolveCountryCode(destination);
  if (!countryCode || !env.VECTORIZE || !env.RULES_DB) return { countryCode: countryCode, chunks: [] };

  var queryText = "Visa requirements for " + destination + ", purpose: " + purpose;
  var queryVector;
  try {
    var vectors = await embedTexts(env, [queryText]);
    queryVector = vectors[0];
  } catch (e) {
    return { countryCode: countryCode, chunks: [] };
  }

  var matches;
  try {
    var result = await env.VECTORIZE.query(queryVector, { topK: 6, filter: { country_code: countryCode } });
    matches = result.matches || [];
  } catch (e) {
    return { countryCode: countryCode, chunks: [] };
  }

  if (matches.length === 0) return { countryCode: countryCode, chunks: [] };

  var vectorIds = matches.map(function (m) { return m.id; });
  var placeholders = vectorIds.map(function () { return "?"; }).join(",");
  var rows;
  try {
    var stmt = env.RULES_DB.prepare(
      "SELECT chunk_text, source_url, source_tier, last_verified_date FROM rule_chunks WHERE vector_id IN (" + placeholders + ")"
    );
    var boundStmt = stmt.bind.apply(stmt, vectorIds);
    var d1Res = await boundStmt.all();
    rows = d1Res.results || [];
  } catch (e) {
    return { countryCode: countryCode, chunks: [] };
  }

  return { countryCode: countryCode, chunks: rows };
}

function buildGroundedPrompt(chunks) {
  var lines = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    lines.push("[" + (i + 1) + "] (source: " + c.source_url + ", tier: " + c.source_tier + ", verified: " + c.last_verified_date + ")\n" + c.chunk_text);
  }
  return GROUNDED_PROMPT_PREFIX + lines.join("\n\n");
}

async function performVisaAICheck(env, passport, destination, purpose) {
  var grounding = await retrieveGroundingChunks(env, destination, purpose);
  var groundedPromptBlock = grounding.chunks.length > 0 ? buildGroundedPrompt(grounding.chunks) + "\n\n" : "";

  var userPrompt = groundedPromptBlock + "Passport: " + passport + "\nDestination: " + destination + "\nPurpose: " + purpose + "\n\nProvide current visa requirements for this combination. IMPORTANT: Respond with raw JSON only. No markdown, no backticks, no explanation — just the JSON object.";

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
    return { ok: false, error: "AI service unreachable" };
  }

  if (!orResponse.ok) {
    var errText = await orResponse.text();
    return { ok: false, error: "AI service error", detail: errText };
  }

  var orData = await orResponse.json();
  var rawContent = "";
  try {
    rawContent = orData.choices[0].message.content;
  } catch (e) {
    return { ok: false, error: "Unexpected AI response shape" };
  }

  var cleaned = rawContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  var parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    try {
      parsed = JSON.parse(cleaned.replace(/'/g, '"'));
    } catch (e2) {
      return { ok: false, error: "Could not parse AI response", raw: rawContent };
    }
  }

  if (!Array.isArray(parsed.citations)) parsed.citations = [];
  parsed.grounded = grounding.chunks.length > 0;
  return { ok: true, data: parsed };
}

export { performVisaAICheck, retrieveGroundingChunks, buildGroundedPrompt, SYSTEM_PROMPT, GROUNDED_PROMPT_PREFIX };

import { OFFICIAL_TIER_COUNTRIES } from "./countries.js";

var CHUNK_TARGET_CHARS = 1800; // ~400-450 tokens
var EMBEDDING_MODEL = "openai/text-embedding-3-small";

async function sha256Hex(text) {
  var data = new TextEncoder().encode(text);
  var digest = await crypto.subtle.digest("SHA-256", data);
  var bytes = new Uint8Array(digest);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function stripHtml(html) {
  var text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

// Heuristic filter for nav/footer/cookie-banner boilerplate that survives tag-stripping:
// such blocks are dominated by short, terse lines (link labels) rather than prose sentences.
function looksLikeBoilerplate(chunkStr) {
  var lines = chunkStr.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  if (lines.length < 3) return false;
  var shortLineCount = 0;
  for (var i = 0; i < lines.length; i++) {
    var wordCount = lines[i].split(/\s+/).length;
    if (wordCount <= 4) shortLineCount++;
  }
  if (shortLineCount / lines.length > 0.6) return true;
  if (/cookies on |we use some essential cookies|accessibility statement|terms and conditions|privacy statement/i.test(chunkStr)) return true;
  return false;
}

function chunkText(text) {
  var paragraphs = text.split("\n").map(function (p) { return p.trim(); }).filter(Boolean);
  var chunks = [];
  var current = "";
  for (var i = 0; i < paragraphs.length; i++) {
    var p = paragraphs[i];
    if (current.length + p.length + 1 > CHUNK_TARGET_CHARS && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? "\n" : "") + p;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(function (c) { return c.length > 40 && !looksLikeBoilerplate(c); });
}

// Automated ToS pre-check: fetch robots.txt and refuse to proceed if the source path
// is disallowed. This is a first-pass filter, not a substitute for manual ToS review —
// per visapath-rag-handover.md §1 / the RAG design plan, any source this can't clear
// automatically must be flagged for manual review before ingestion, not force-ingested.
async function checkRobotsAllowed(sourceUrl) {
  try {
    var u = new URL(sourceUrl);
    var robotsUrl = u.origin + "/robots.txt";
    var res = await fetch(robotsUrl, { headers: { "User-Agent": "VisaPathBot/1.0 (+https://visapath.neulab.xyz)" } });
    if (!res.ok) return { allowed: true, checked: false, reason: "no robots.txt (assumed allowed)" };
    var body = await res.text();
    var lines = body.split("\n");
    var applies = false;
    var disallowedPaths = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/^user-agent:\s*\*/i.test(line)) { applies = true; continue; }
      if (/^user-agent:/i.test(line)) { applies = false; continue; }
      if (applies && /^disallow:/i.test(line)) {
        var path = line.split(":").slice(1).join(":").trim();
        if (path) disallowedPaths.push(path);
      }
    }
    for (var j = 0; j < disallowedPaths.length; j++) {
      if (disallowedPaths[j] === "/" || u.pathname.indexOf(disallowedPaths[j]) === 0) {
        return { allowed: false, checked: true, reason: "robots.txt disallows " + disallowedPaths[j] };
      }
    }
    return { allowed: true, checked: true, reason: "robots.txt permits this path" };
  } catch (e) {
    return { allowed: true, checked: false, reason: "robots.txt check failed: " + e.message };
  }
}

async function fetchSource(sourceUrl) {
  var res = await fetch(sourceUrl, {
    headers: { "User-Agent": "VisaPathBot/1.0 (+https://visapath.neulab.xyz)" }
  });
  if (!res.ok) throw new Error("fetch failed with status " + res.status);
  return await res.text();
}

async function embedTexts(env, texts) {
  var res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://visapath.neulab.xyz",
      "X-Title": "VisaPath Ingestion"
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts })
  });
  if (!res.ok) {
    var errText = await res.text();
    throw new Error("embedding request failed: " + errText);
  }
  var data = await res.json();
  return data.data.map(function (d) { return d.embedding; });
}

async function sendDowngradeAlert(env, countryCode, countryName, reason) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO) return; // no-op until secrets are configured
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "VisaPath Ingestion <ingestion@visapath.neulab.xyz>",
        to: [env.ALERT_EMAIL_TO],
        subject: "VisaPath tier downgrade: " + countryName + " (" + countryCode + ")",
        text: "Official source ingestion failed for " + countryName + " (" + countryCode + "). Reason: " + reason + ". This country's answers will fall back to ungrounded (no citations) until the source is fixed."
      })
    });
  } catch (e) {
    // best-effort alert only, never block ingestion on this
  }
}

async function ingestCountry(env, country, runId, startedAt) {
  var log = {
    run_id: runId, started_at: startedAt, country_code: country.country_code,
    source: country.official_source_url, source_tier: "official",
    chunks_added: 0, chunks_updated: 0, tier_downgraded: 0, errors: null
  };

  var robotsCheck = await checkRobotsAllowed(country.official_source_url);
  if (!robotsCheck.allowed) {
    log.tier_downgraded = 1;
    log.errors = "blocked by ToS pre-check: " + robotsCheck.reason;
    await sendDowngradeAlert(env, country.country_code, country.country_name, log.errors);
    return log;
  }

  var rawHtml;
  try {
    rawHtml = await fetchSource(country.official_source_url);
  } catch (e) {
    log.tier_downgraded = 1;
    log.errors = "source fetch failed: " + e.message;
    await sendDowngradeAlert(env, country.country_code, country.country_name, log.errors);
    return log;
  }

  var dateStr = startedAt.slice(0, 10);
  if (env.RAW_SOURCES) {
    var r2Key = country.country_code + "/official/" + dateStr + ".html";
    await env.RAW_SOURCES.put(r2Key, rawHtml, { httpMetadata: { contentType: "text/html" } });
  }

  var text = stripHtml(rawHtml);
  var chunks = chunkText(text);
  if (chunks.length === 0) {
    log.errors = "no extractable text chunks after stripping HTML";
    return log;
  }

  var hashes = [];
  for (var i = 0; i < chunks.length; i++) {
    hashes.push(await sha256Hex(chunks[i]));
  }

  var existingRows = [];
  if (env.RULES_DB) {
    var existingRes = await env.RULES_DB.prepare(
      "SELECT id, chunk_hash FROM rule_chunks WHERE country_code = ? AND source_tier = 'official'"
    ).bind(country.country_code).all();
    existingRows = existingRes.results || [];
  }
  var existingHashSet = {};
  for (var e2 = 0; e2 < existingRows.length; e2++) {
    existingHashSet[existingRows[e2].chunk_hash] = existingRows[e2].id;
  }

  var toEmbedIdx = [];
  for (var c = 0; c < chunks.length; c++) {
    if (!existingHashSet[hashes[c]]) toEmbedIdx.push(c);
  }

  if (toEmbedIdx.length > 0) {
    var textsToEmbed = toEmbedIdx.map(function (idx) { return chunks[idx]; });
    var vectors = await embedTexts(env, textsToEmbed);

    var vectorizeEntries = [];
    var d1Statements = [];
    for (var k = 0; k < toEmbedIdx.length; k++) {
      var idx = toEmbedIdx[k];
      var vectorId = country.country_code + "-official-" + hashes[idx].slice(0, 16);
      vectorizeEntries.push({
        id: vectorId,
        values: vectors[k],
        metadata: { country_code: country.country_code, source_tier: "official" }
      });
      if (env.RULES_DB) {
        d1Statements.push(env.RULES_DB.prepare(
          "INSERT OR REPLACE INTO rule_chunks (id, country_code, source_url, source_tier, chunk_text, chunk_hash, last_verified_date, vector_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(vectorId, country.country_code, country.official_source_url, "official", chunks[idx], hashes[idx], dateStr, vectorId));
      }
    }

    if (env.VECTORIZE && vectorizeEntries.length > 0) {
      await env.VECTORIZE.upsert(vectorizeEntries);
    }
    if (env.RULES_DB && d1Statements.length > 0) {
      await env.RULES_DB.batch(d1Statements);
    }
    log.chunks_added = toEmbedIdx.length;
  }
  log.chunks_updated = chunks.length - toEmbedIdx.length;

  return log;
}

async function writeIngestionLog(env, log) {
  if (!env.RULES_DB) return;
  await env.RULES_DB.prepare(
    "INSERT INTO ingestion_log (run_id, started_at, country_code, source, source_tier, chunks_added, chunks_updated, tier_downgraded, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    log.run_id, log.started_at, log.country_code, log.source, log.source_tier,
    log.chunks_added, log.chunks_updated, log.tier_downgraded, log.errors
  ).run();
}

async function runIngestion(env, countryCodesFilter) {
  var runId = crypto.randomUUID();
  var startedAt = new Date().toISOString();
  var countries = OFFICIAL_TIER_COUNTRIES;
  if (Array.isArray(countryCodesFilter) && countryCodesFilter.length > 0) {
    countries = countries.filter(function (c) { return countryCodesFilter.indexOf(c.country_code) !== -1; });
  }

  var results = [];
  for (var i = 0; i < countries.length; i++) {
    var log;
    try {
      log = await ingestCountry(env, countries[i], runId, startedAt);
    } catch (e) {
      log = {
        run_id: runId, started_at: startedAt, country_code: countries[i].country_code,
        source: countries[i].official_source_url, source_tier: "official",
        chunks_added: 0, chunks_updated: 0, tier_downgraded: 1, errors: "unexpected error: " + e.message
      };
    }
    await writeIngestionLog(env, log);
    results.push(log);
  }

  return { run_id: runId, started_at: startedAt, countries_processed: results.length, results: results };
}

export { runIngestion, embedTexts, checkRobotsAllowed };

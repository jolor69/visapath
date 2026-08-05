// Deterministic readiness rules engine — no LLM in the scoring path itself (the one
// exception, isVisaRequired(), calls the existing grounded visa-check AI and caches the
// result; every other rule below is pure date/string comparison). Kept deterministic and
// explainable per the PRD's "avoid false certainty" requirement — see plan Section 5.
import { jsonResponse } from "./http.js";
import { performVisaAICheck } from "./visaCheck.js";

var VISA_REQUIRED_CACHE_TTL_SECONDS = 86400; // visa rules don't change daily; avoid re-calling the AI on every edit

// PLACEHOLDER — small illustrative set of countries commonly requiring a yellow-fever /
// health certificate for entry. Not exhaustive or authoritative; same caveat as
// countries.js's OFFICIAL_TIER_COUNTRIES list. Replace with a maintained source before
// this becomes a hard gate rather than an advisory warning.
var HEALTH_CERT_LIKELY_REQUIRED = ["KE", "TZ", "UG", "GH", "NG", "BR", "CD", "AO", "CM", "CI"];

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86400000);
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function levenshtein(a, b) {
  var m = a.length, n = b.length;
  var d = [];
  for (var i = 0; i <= m; i++) d.push([i]);
  for (var j = 0; j <= n; j++) d[0][j] = j;
  for (i = 1; i <= m; i++) {
    for (j = 1; j <= n; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

async function isVisaRequired(env, nationality, destination) {
  if (!nationality || !destination) return null;
  var cacheKey = "visareq:" + nationality.toLowerCase() + ":" + destination.toLowerCase();

  if (env.VISAPATH_KV) {
    var cached = await env.VISAPATH_KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  var result = await performVisaAICheck(env, nationality, destination, "tourism");
  if (!result.ok) return null;

  var required = result.data.visa_required;
  var value = { required: required === true || required === "visa_on_arrival" || required === "e_visa" };

  if (env.VISAPATH_KV) {
    await env.VISAPATH_KV.put(cacheKey, JSON.stringify(value), { expirationTtl: VISA_REQUIRED_CACHE_TTL_SECONDS });
  }
  return value;
}

function effectiveValue(field) {
  return field.edited_value != null ? field.edited_value : field.field_value;
}

function fieldsByName(fields) {
  var map = {};
  fields.forEach(function (f) {
    map[f.field_name] = effectiveValue(f);
  });
  return map;
}

function makeIssue(tripId, travelerId, severity, issueType, description, actionRequired, dueDate) {
  return {
    id: crypto.randomUUID(),
    trip_id: tripId,
    traveler_id: travelerId,
    severity: severity,
    issue_type: issueType,
    description: description,
    action_required: actionRequired,
    due_date: dueDate || null,
    status: "open",
    created_at: new Date().toISOString()
  };
}

async function computeReadinessIssues(env, trip, travelers, documentsByTraveler, fieldsByDocument) {
  var issues = [];
  var destinations = JSON.parse(trip.destination_countries);
  var isInternational = destinations.some(function (d) {
    return !trip.origin_country || d.toLowerCase() !== trip.origin_country.toLowerCase();
  });

  for (var t = 0; t < travelers.length; t++) {
    var traveler = travelers[t];
    var docs = documentsByTraveler[traveler.id] || [];
    var passportDoc = docs.find(function (d) { return d.document_type === "passport"; });
    var visaDoc = docs.find(function (d) { return d.document_type === "visa"; });
    var healthDoc = docs.find(function (d) { return d.document_type === "health_cert"; });

    // --- Missing passport / passport expiry ---
    if (isInternational && !passportDoc) {
      issues.push(makeIssue(trip.id, traveler.id, "critical", "missing_document",
        traveler.full_name + " has no passport uploaded for an international trip.",
        "Scan and upload " + traveler.full_name + "'s passport.", trip.start_date));
    } else if (passportDoc) {
      var passportFields = fieldsByName(fieldsByDocument[passportDoc.id] || []);
      var expiry = passportFields.expiry_date;
      if (expiry) {
        var daysToExpiryPastReturn = daysBetween(trip.end_date, expiry);
        if (daysToExpiryPastReturn < 0) {
          issues.push(makeIssue(trip.id, traveler.id, "critical", "passport_expiry",
            traveler.full_name + "'s passport appears to expire before the trip ends.",
            "Renew passport before travel — it must be valid through the return date.", trip.end_date));
        } else if (daysToExpiryPastReturn < 180) {
          issues.push(makeIssue(trip.id, traveler.id, daysToExpiryPastReturn < 0 ? "critical" : "warning", "passport_expiry",
            traveler.full_name + "'s passport may not meet the common 6-month post-trip validity rule some destinations require.",
            "Please verify official entry rules — passport renewal may be advisable.", trip.end_date));
        }
      }

      // --- Name mismatch across this traveler's documents ---
      var passportName = normalizeName(passportFields.full_name);
      if (passportName) {
        docs.forEach(function (otherDoc) {
          if (otherDoc.id === passportDoc.id) return;
          var otherFields = fieldsByName(fieldsByDocument[otherDoc.id] || []);
          var otherName = normalizeName(otherFields.full_name);
          if (!otherName) return;
          if (otherName === passportName) return;
          var distance = levenshtein(passportName, otherName);
          var severity = distance > 3 ? "critical" : "warning";
          issues.push(makeIssue(trip.id, traveler.id, severity, "name_mismatch",
            "Name on " + otherDoc.document_type + " (\"" + otherFields.full_name + "\") does not match the name on the passport (\"" + passportFields.full_name + "\").",
            "Please verify these refer to the same person, or correct whichever field is wrong."));
        });
      }
    }

    // --- Visa required but missing (reuses the existing grounded visa-check) ---
    if (isInternational && passportDoc) {
      var nationality = fieldsByName(fieldsByDocument[passportDoc.id] || []).nationality;
      for (var d = 0; d < destinations.length; d++) {
        var destination = destinations[d];
        if (nationality && destination.toLowerCase() !== nationality.toLowerCase()) {
          var visaCheck = await isVisaRequired(env, nationality, destination);
          if (visaCheck && visaCheck.required && !visaDoc) {
            issues.push(makeIssue(trip.id, traveler.id, "critical", "visa_missing",
              destination + " may require a visa for " + traveler.full_name + ", and none has been uploaded.",
              "Please verify official entry rules and apply for a visa if required.", trip.start_date));
          }
        }
      }
    }

    // --- Visa validity gap ---
    if (visaDoc) {
      var visaFields = fieldsByName(fieldsByDocument[visaDoc.id] || []);
      var validStart = visaFields.visa_validity_start;
      var validEnd = visaFields.visa_validity_end;
      if (validStart && validEnd) {
        var startOk = daysBetween(validStart, trip.start_date) >= 0;
        var endOk = daysBetween(trip.end_date, validEnd) >= 0;
        if (!startOk || !endOk) {
          issues.push(makeIssue(trip.id, traveler.id, "critical", "visa_validity_gap",
            traveler.full_name + "'s visa validity window (" + validStart + " to " + validEnd + ") does not appear to cover the full trip.",
            "Please verify official entry rules — the visa may need to be reissued or extended.", trip.start_date));
        }
      }
    }

    // --- Vaccination/health requirement (advisory, small placeholder list) ---
    var needsHealthCert = destinations.some(function (d) { return HEALTH_CERT_LIKELY_REQUIRED.indexOf(d.toUpperCase()) !== -1; });
    if (needsHealthCert && !healthDoc) {
      issues.push(makeIssue(trip.id, traveler.id, "warning", "vaccination_missing",
        "This destination may require a yellow-fever or other health certificate that hasn't been uploaded for " + traveler.full_name + ".",
        "Please verify official entry/health requirements for this destination."));
    }

    // --- Image quality ---
    docs.forEach(function (doc) {
      if (doc.quality_status && doc.quality_status !== "ok" && doc.quality_status !== "pending") {
        issues.push(makeIssue(trip.id, traveler.id, "warning", "image_quality",
          "The " + doc.document_type + " scan for " + traveler.full_name + " appears " + doc.quality_status + ".",
          "Retake the photo: hold steady, improve lighting, and include the full document edges."));
      }
    });
  }

  return issues;
}

function scoreFromIssues(issues) {
  var criticalCount = issues.filter(function (i) { return i.severity === "critical"; }).length;
  var warningCount = issues.filter(function (i) { return i.severity === "warning"; }).length;

  if (criticalCount > 0) {
    return { status: "urgent_issue", score: Math.max(10, 40 - criticalCount * 10) };
  }
  if (warningCount > 0) {
    return { status: "needs_attention", score: Math.max(40, 89 - warningCount * 10) };
  }
  return { status: "ready", score: 100 };
}

async function recomputeReadiness(env, tripId) {
  var trip = await env.APP_DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return;

  var travelers = (await env.APP_DB.prepare("SELECT * FROM travelers WHERE trip_id = ?").bind(tripId).all()).results || [];
  var documents = (await env.APP_DB.prepare("SELECT * FROM documents WHERE trip_id = ? AND extraction_status != 'failed'").bind(tripId).all()).results || [];

  var documentsByTraveler = {};
  documents.forEach(function (doc) {
    if (!doc.traveler_id) return;
    if (!documentsByTraveler[doc.traveler_id]) documentsByTraveler[doc.traveler_id] = [];
    documentsByTraveler[doc.traveler_id].push(doc);
  });

  var fieldsByDocument = {};
  for (var i = 0; i < documents.length; i++) {
    var rows = (await env.APP_DB.prepare("SELECT * FROM extracted_fields WHERE document_id = ?").bind(documents[i].id).all()).results || [];
    fieldsByDocument[documents[i].id] = rows;
  }

  var issues = await computeReadinessIssues(env, trip, travelers, documentsByTraveler, fieldsByDocument);
  var scored = scoreFromIssues(issues);

  // Preserve reviewer notes/status on issues that are semantically unchanged by matching
  // on (traveler_id, issue_type, description) before wiping and reinserting — simplest
  // correct approach given issues are cheap to regenerate and D1 has no natural issue key.
  var existing = (await env.APP_DB.prepare("SELECT * FROM validation_issues WHERE trip_id = ?").bind(tripId).all()).results || [];
  var existingByKey = {};
  existing.forEach(function (row) {
    existingByKey[row.traveler_id + "|" + row.issue_type + "|" + row.description] = row;
  });

  await env.APP_DB.prepare("DELETE FROM validation_issues WHERE trip_id = ?").bind(tripId).run();

  for (var j = 0; j < issues.length; j++) {
    var issue = issues[j];
    var match = existingByKey[issue.traveler_id + "|" + issue.issue_type + "|" + issue.description];
    if (match) {
      issue.status = match.status;
      issue.reviewer_note = match.reviewer_note;
      issue.id = match.id;
    }
    await env.APP_DB.prepare(
      "INSERT INTO validation_issues (id, trip_id, traveler_id, severity, issue_type, description, action_required, due_date, status, reviewer_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(issue.id, issue.trip_id, issue.traveler_id, issue.severity, issue.issue_type, issue.description, issue.action_required, issue.due_date, issue.status, issue.reviewer_note || null, issue.created_at).run();
  }

  await env.APP_DB.prepare("UPDATE trips SET status = ?, readiness_score = ?, updated_at = ? WHERE id = ?")
    .bind(scored.status, scored.score, new Date().toISOString(), tripId).run();

  // Per-traveler status: urgent if they have any open critical issue, else needs_attention
  // if any warning, else ready — mirrors the trip-level rollup logic above.
  var openIssues = issues.filter(function (i) { return i.status !== "resolved"; });
  for (var k = 0; k < travelers.length; k++) {
    var travelerIssues = openIssues.filter(function (i) { return i.traveler_id === travelers[k].id; });
    var travelerScored = scoreFromIssues(travelerIssues);
    await env.APP_DB.prepare("UPDATE travelers SET status = ? WHERE id = ?").bind(travelerScored.status, travelers[k].id).run();
  }
}

async function handlePatchIssue(issueId, request, env, user, corsHeaders) {
  var issue = await env.APP_DB.prepare(
    "SELECT validation_issues.* FROM validation_issues JOIN trips ON validation_issues.trip_id = trips.id WHERE validation_issues.id = ? AND trips.user_id = ?"
  ).bind(issueId, user.id).first();
  if (!issue) return jsonResponse({ error: "not_found", message: "Issue not found" }, 404, corsHeaders);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  if (["reviewed", "resolved", "open"].indexOf(body.status) === -1) {
    return jsonResponse({ error: "invalid_request", message: "status must be one of open, reviewed, resolved" }, 400, corsHeaders);
  }

  await env.APP_DB.prepare("UPDATE validation_issues SET status = ?, reviewer_note = ? WHERE id = ?")
    .bind(body.status, body.reviewer_note || null, issueId).run();

  return jsonResponse({ updated: true }, 200, corsHeaders);
}

export { recomputeReadiness, handlePatchIssue };

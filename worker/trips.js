import { jsonResponse } from "./http.js";
import { recomputeReadiness } from "./readiness.js";

function nowIso() {
  return new Date().toISOString();
}

function isValidDateString(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

async function loadTripFull(env, tripId, userId) {
  var trip = await env.APP_DB.prepare("SELECT * FROM trips WHERE id = ? AND user_id = ?").bind(tripId, userId).first();
  if (!trip) return null;

  var travelers = (await env.APP_DB.prepare("SELECT * FROM travelers WHERE trip_id = ?").bind(tripId).all()).results || [];
  var documents = (await env.APP_DB.prepare("SELECT * FROM documents WHERE trip_id = ?").bind(tripId).all()).results || [];
  var issues = (await env.APP_DB.prepare("SELECT * FROM validation_issues WHERE trip_id = ? ORDER BY severity, created_at").bind(tripId).all()).results || [];

  return {
    id: trip.id,
    title: trip.title,
    start_date: trip.start_date,
    end_date: trip.end_date,
    origin_country: trip.origin_country,
    destination_countries: JSON.parse(trip.destination_countries),
    status: trip.status,
    readiness_score: trip.readiness_score,
    travelers: travelers,
    documents: documents,
    issues: issues
  };
}

async function handleCreateTrip(request, env, user, corsHeaders) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  var title = typeof body.title === "string" ? body.title.trim() : "";
  var startDate = body.start_date;
  var endDate = body.end_date;
  var destinations = body.destinations;

  if (!title) return jsonResponse({ error: "invalid_request", message: "title is required" }, 400, corsHeaders);
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    return jsonResponse({ error: "invalid_request", message: "start_date and end_date must be YYYY-MM-DD" }, 400, corsHeaders);
  }
  if (endDate < startDate) {
    return jsonResponse({ error: "invalid_request", message: "end_date must be on or after start_date" }, 400, corsHeaders);
  }
  if (!Array.isArray(destinations) || destinations.length === 0) {
    return jsonResponse({ error: "invalid_request", message: "destinations must be a non-empty array of country codes/names" }, 400, corsHeaders);
  }

  var id = crypto.randomUUID();
  var now = nowIso();
  await env.APP_DB.prepare(
    "INSERT INTO trips (id, user_id, title, start_date, end_date, origin_country, destination_countries, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_attention', ?, ?)"
  ).bind(id, user.id, title, startDate, endDate, body.origin || null, JSON.stringify(destinations), now, now).run();

  // Trip owner is implicitly the first traveler unless the caller adds others.
  var travelerId = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO travelers (id, trip_id, full_name, relationship, status, created_at) VALUES (?, ?, ?, 'self', 'needs_attention', ?)"
  ).bind(travelerId, id, user.email, now).run();

  // Compute initial readiness immediately rather than waiting for the first document
  // upload — a brand-new international trip with zero documents is itself an issue
  // ("no passport uploaded"), and that should be visible right away.
  await recomputeReadiness(env, id);

  return jsonResponse({ trip_id: id, traveler_id: travelerId }, 201, corsHeaders);
}

async function handleListTrips(request, env, user, corsHeaders) {
  var rows = (await env.APP_DB.prepare(
    "SELECT id, title, start_date, end_date, status, readiness_score FROM trips WHERE user_id = ? ORDER BY start_date"
  ).bind(user.id).all()).results || [];
  return jsonResponse(rows, 200, corsHeaders);
}

async function handleGetTrip(tripId, env, user, corsHeaders) {
  var trip = await loadTripFull(env, tripId, user.id);
  if (!trip) return jsonResponse({ error: "not_found", message: "Trip not found" }, 404, corsHeaders);
  return jsonResponse(trip, 200, corsHeaders);
}

async function handlePatchTrip(tripId, request, env, user, corsHeaders) {
  var existing = await env.APP_DB.prepare("SELECT id FROM trips WHERE id = ? AND user_id = ?").bind(tripId, user.id).first();
  if (!existing) return jsonResponse({ error: "not_found", message: "Trip not found" }, 404, corsHeaders);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  var fields = [];
  var values = [];

  if (typeof body.title === "string" && body.title.trim()) {
    fields.push("title = ?");
    values.push(body.title.trim());
  }
  if (body.start_date !== undefined) {
    if (!isValidDateString(body.start_date)) return jsonResponse({ error: "invalid_request", message: "start_date must be YYYY-MM-DD" }, 400, corsHeaders);
    fields.push("start_date = ?");
    values.push(body.start_date);
  }
  if (body.end_date !== undefined) {
    if (!isValidDateString(body.end_date)) return jsonResponse({ error: "invalid_request", message: "end_date must be YYYY-MM-DD" }, 400, corsHeaders);
    fields.push("end_date = ?");
    values.push(body.end_date);
  }
  if (Array.isArray(body.destinations)) {
    fields.push("destination_countries = ?");
    values.push(JSON.stringify(body.destinations));
  }
  if (body.origin !== undefined) {
    fields.push("origin_country = ?");
    values.push(body.origin);
  }

  if (fields.length === 0) {
    return jsonResponse({ error: "invalid_request", message: "No updatable fields provided" }, 400, corsHeaders);
  }

  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(tripId);

  var updateStmt = env.APP_DB.prepare("UPDATE trips SET " + fields.join(", ") + " WHERE id = ?");
  await updateStmt.bind.apply(updateStmt, values).run();

  // Dates/destinations changing shifts which rules apply (e.g. passport expiry margin,
  // visa-required destinations) so readiness must be recomputed, not just the row patched.
  await recomputeReadiness(env, tripId);

  return jsonResponse({ updated: true }, 200, corsHeaders);
}

async function handleDeleteTrip(tripId, env, user, corsHeaders) {
  var existing = await env.APP_DB.prepare("SELECT id FROM trips WHERE id = ? AND user_id = ?").bind(tripId, user.id).first();
  if (!existing) return jsonResponse({ error: "not_found", message: "Trip not found" }, 404, corsHeaders);

  var documents = (await env.APP_DB.prepare("SELECT id, r2_key FROM documents WHERE trip_id = ?").bind(tripId).all()).results || [];
  for (var i = 0; i < documents.length; i++) {
    try {
      await env.USER_DOCUMENTS.delete(documents[i].r2_key);
    } catch (e) {
      // best-effort; D1 rows below are the source of truth for existence
    }
    await env.APP_DB.prepare("DELETE FROM extracted_fields WHERE document_id = ?").bind(documents[i].id).run();
  }
  await env.APP_DB.prepare("DELETE FROM documents WHERE trip_id = ?").bind(tripId).run();
  await env.APP_DB.prepare("DELETE FROM validation_issues WHERE trip_id = ?").bind(tripId).run();
  await env.APP_DB.prepare("DELETE FROM travelers WHERE trip_id = ?").bind(tripId).run();
  await env.APP_DB.prepare("DELETE FROM trips WHERE id = ?").bind(tripId).run();

  return jsonResponse({ deleted: true }, 200, corsHeaders);
}

async function handleAddTraveler(tripId, request, env, user, corsHeaders) {
  var trip = await env.APP_DB.prepare("SELECT id FROM trips WHERE id = ? AND user_id = ?").bind(tripId, user.id).first();
  if (!trip) return jsonResponse({ error: "not_found", message: "Trip not found" }, 404, corsHeaders);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  var fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  if (!fullName) return jsonResponse({ error: "invalid_request", message: "full_name is required" }, 400, corsHeaders);

  var id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO travelers (id, trip_id, full_name, dob, nationality, relationship, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'needs_attention', ?)"
  ).bind(id, tripId, fullName, body.dob || null, body.nationality || null, body.relationship || "other", nowIso()).run();

  await recomputeReadiness(env, tripId);

  return jsonResponse({ traveler_id: id }, 201, corsHeaders);
}

async function handlePatchTraveler(travelerId, request, env, user, corsHeaders) {
  var traveler = await env.APP_DB.prepare(
    "SELECT travelers.id, travelers.trip_id FROM travelers JOIN trips ON travelers.trip_id = trips.id WHERE travelers.id = ? AND trips.user_id = ?"
  ).bind(travelerId, user.id).first();
  if (!traveler) return jsonResponse({ error: "not_found", message: "Traveler not found" }, 404, corsHeaders);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  var fields = [];
  var values = [];
  ["full_name", "dob", "nationality", "relationship"].forEach(function (key) {
    if (body[key] !== undefined) {
      fields.push(key + " = ?");
      values.push(body[key]);
    }
  });

  if (fields.length === 0) {
    return jsonResponse({ error: "invalid_request", message: "No updatable fields provided" }, 400, corsHeaders);
  }
  values.push(travelerId);

  var stmt = env.APP_DB.prepare("UPDATE travelers SET " + fields.join(", ") + " WHERE id = ?");
  await stmt.bind.apply(stmt, values).run();

  await recomputeReadiness(env, traveler.trip_id);

  return jsonResponse({ updated: true }, 200, corsHeaders);
}

export {
  handleCreateTrip,
  handleListTrips,
  handleGetTrip,
  handlePatchTrip,
  handleDeleteTrip,
  handleAddTraveler,
  handlePatchTraveler,
  loadTripFull,
  isValidDateString
};

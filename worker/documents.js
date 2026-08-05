import { jsonResponse } from "./http.js";
import { extractDocument } from "./extraction.js";
import { recomputeReadiness } from "./readiness.js";

var DELETE_AFTER_DAYS = 30;
var NEEDS_REVIEW_CONFIDENCE_THRESHOLD = 0.6;
var MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB, generous for a phone photo
var ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(dateStr, days) {
  var d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function extForMime(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/heic") return "heic";
  return "jpg";
}

async function handleUploadDocument(tripId, request, env, user, corsHeaders) {
  var trip = await env.APP_DB.prepare("SELECT id, end_date FROM trips WHERE id = ? AND user_id = ?").bind(tripId, user.id).first();
  if (!trip) return jsonResponse({ error: "not_found", message: "Trip not found" }, 404, corsHeaders);

  var form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Expected multipart/form-data" }, 400, corsHeaders);
  }

  var file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return jsonResponse({ error: "invalid_request", message: "file is required" }, 400, corsHeaders);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: "file_too_large", message: "File exceeds 15MB limit" }, 400, corsHeaders);
  }

  var mimeType = file.type || "image/jpeg";
  if (ALLOWED_MIME_TYPES.indexOf(mimeType) === -1) {
    return jsonResponse({ error: "unsupported_file_type", message: "Only JPEG, PNG, WEBP, or HEIC images are supported" }, 400, corsHeaders);
  }

  var travelerId = form.get("traveler_id") || null;
  if (travelerId) {
    var travelerCheck = await env.APP_DB.prepare("SELECT id FROM travelers WHERE id = ? AND trip_id = ?").bind(travelerId, tripId).first();
    if (!travelerCheck) return jsonResponse({ error: "invalid_request", message: "traveler_id does not belong to this trip" }, 400, corsHeaders);
  }
  var documentTypeHint = form.get("document_type_hint") || null;

  var arrayBuffer = await file.arrayBuffer();
  var imageBytes = new Uint8Array(arrayBuffer);

  var documentId = crypto.randomUUID();
  var r2Key = "documents/" + user.id + "/" + documentId + "." + extForMime(mimeType);

  await env.USER_DOCUMENTS.put(r2Key, imageBytes, { httpMetadata: { contentType: mimeType } });

  var uploadedAt = nowIso();
  var deleteAfter = addDaysIso(trip.end_date, DELETE_AFTER_DAYS);

  // Row is written as "processing" first so a crash mid-extraction still leaves a
  // recoverable record rather than an orphaned R2 object with no D1 trace.
  await env.APP_DB.prepare(
    "INSERT INTO documents (id, trip_id, traveler_id, document_type, type_confidence, r2_key, quality_status, extraction_status, uploaded_at, delete_after) VALUES (?, ?, ?, 'unknown', 0, ?, 'pending', 'processing', ?, ?)"
  ).bind(documentId, tripId, travelerId, r2Key, uploadedAt, deleteAfter).run();

  var extraction = await extractDocument(env, imageBytes, mimeType, documentTypeHint);

  if (!extraction.ok) {
    await env.APP_DB.prepare("UPDATE documents SET extraction_status = 'failed' WHERE id = ?").bind(documentId).run();
    return jsonResponse({ document_id: documentId, status: "failed", error: extraction.error }, 200, corsHeaders);
  }

  var avgConfidence = extraction.fields.length > 0
    ? extraction.fields.reduce(function (sum, f) { return sum + f.confidence; }, 0) / extraction.fields.length
    : 0;
  var extractionStatus = avgConfidence < NEEDS_REVIEW_CONFIDENCE_THRESHOLD ? "needs_review" : "extracted";

  await env.APP_DB.prepare(
    "UPDATE documents SET document_type = ?, type_confidence = ?, quality_status = ?, extraction_status = ?, extraction_model = ? WHERE id = ?"
  ).bind(extraction.document_type, extraction.type_confidence, extraction.quality_status, extractionStatus, extraction.model_used, documentId).run();

  for (var i = 0; i < extraction.fields.length; i++) {
    var f = extraction.fields[i];
    await env.APP_DB.prepare(
      "INSERT INTO extracted_fields (id, document_id, field_name, field_value, normalized_value, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), documentId, f.field_name, f.field_value, f.field_value.trim().toLowerCase(), f.confidence).run();
  }

  await recomputeReadiness(env, tripId);

  return jsonResponse({
    document_id: documentId,
    status: extractionStatus,
    document_type: extraction.document_type,
    quality_status: extraction.quality_status
  }, 200, corsHeaders);
}

async function handleGetDocument(documentId, env, user, corsHeaders) {
  var doc = await env.APP_DB.prepare(
    "SELECT documents.* FROM documents JOIN trips ON documents.trip_id = trips.id WHERE documents.id = ? AND trips.user_id = ?"
  ).bind(documentId, user.id).first();
  if (!doc) return jsonResponse({ error: "not_found", message: "Document not found" }, 404, corsHeaders);

  var fields = (await env.APP_DB.prepare("SELECT * FROM extracted_fields WHERE document_id = ?").bind(documentId).all()).results || [];

  return jsonResponse({
    id: doc.id,
    trip_id: doc.trip_id,
    traveler_id: doc.traveler_id,
    document_type: doc.document_type,
    type_confidence: doc.type_confidence,
    quality_status: doc.quality_status,
    extraction_status: doc.extraction_status,
    uploaded_at: doc.uploaded_at,
    fields: fields
  }, 200, corsHeaders);
}

async function handlePatchDocumentFields(documentId, request, env, user, corsHeaders) {
  var doc = await env.APP_DB.prepare(
    "SELECT documents.id, documents.trip_id FROM documents JOIN trips ON documents.trip_id = trips.id WHERE documents.id = ? AND trips.user_id = ?"
  ).bind(documentId, user.id).first();
  if (!doc) return jsonResponse({ error: "not_found", message: "Document not found" }, 404, corsHeaders);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_request", message: "Invalid request body" }, 400, corsHeaders);
  }

  if (typeof body.field_name !== "string" || body.edited_value === undefined) {
    return jsonResponse({ error: "invalid_request", message: "field_name and edited_value are required" }, 400, corsHeaders);
  }

  var field = await env.APP_DB.prepare("SELECT id FROM extracted_fields WHERE document_id = ? AND field_name = ?").bind(documentId, body.field_name).first();

  if (field) {
    await env.APP_DB.prepare("UPDATE extracted_fields SET edited_value = ?, edited_at = ? WHERE id = ?")
      .bind(String(body.edited_value), nowIso(), field.id).run();
  } else {
    // Field wasn't extracted (e.g. model missed it) — user is adding it manually.
    await env.APP_DB.prepare(
      "INSERT INTO extracted_fields (id, document_id, field_name, field_value, normalized_value, confidence, edited_value, edited_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)"
    ).bind(crypto.randomUUID(), documentId, body.field_name, String(body.edited_value), nowIso()).run();
  }

  await recomputeReadiness(env, doc.trip_id);

  return jsonResponse({ updated: true }, 200, corsHeaders);
}

async function handleDeleteDocument(documentId, env, user, corsHeaders) {
  var doc = await env.APP_DB.prepare(
    "SELECT documents.id, documents.trip_id, documents.r2_key FROM documents JOIN trips ON documents.trip_id = trips.id WHERE documents.id = ? AND trips.user_id = ?"
  ).bind(documentId, user.id).first();
  if (!doc) return jsonResponse({ error: "not_found", message: "Document not found" }, 404, corsHeaders);

  try {
    await env.USER_DOCUMENTS.delete(doc.r2_key);
  } catch (e) {
    // best-effort — D1 cleanup below still proceeds
  }
  await env.APP_DB.prepare("DELETE FROM extracted_fields WHERE document_id = ?").bind(documentId).run();
  await env.APP_DB.prepare("DELETE FROM documents WHERE id = ?").bind(documentId).run();

  await recomputeReadiness(env, doc.trip_id);

  return jsonResponse({ deleted: true }, 200, corsHeaders);
}

export { handleUploadDocument, handleGetDocument, handlePatchDocumentFields, handleDeleteDocument };

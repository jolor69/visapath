// Vision-LLM document classification + OCR + field extraction, via OpenRouter.
// Model choice: Gemini 2.5 Flash primary (best OCR accuracy-per-dollar for dense
// printed text like passport MRZ/visa stickers), Gemini 2.5 Flash-Lite as a
// same-provider fallback if the primary call errors/times out. See the engineering
// blueprint (plan Section 0, assumption 2) for the cost/accuracy comparison behind
// this choice — per-scan cost is negligible either way at MVP volume.
var PRIMARY_MODEL = "google/gemini-2.5-flash";
var FALLBACK_MODEL = "google/gemini-2.5-flash-lite";

var VALID_DOCUMENT_TYPES = ["passport", "visa", "health_cert", "id_card", "unknown"];
var VALID_QUALITY_STATUSES = ["ok", "blurry", "glare", "cropped", "low_res", "unreadable"];

var EXTRACTION_SYSTEM_PROMPT = "You are a travel document analyzer for VisaPath. You MUST respond with raw JSON only — no markdown, no backticks, no explanation, no preamble. Your entire response must be a single valid JSON object parsable by JSON.parse().\n\n" +
  "Given a photo of a single travel document, do three things:\n" +
  "1. Classify document_type as one of: \"passport\", \"visa\", \"health_cert\" (vaccination/health certificate), \"id_card\" (national ID or residence permit), or \"unknown\" if it doesn't match any of those or isn't a document at all.\n" +
  "2. Assess image quality as one of: \"ok\", \"blurry\", \"glare\", \"cropped\" (edges cut off), \"low_res\", \"unreadable\". Be strict — if you are guessing at any field because the text is hard to read, quality is not \"ok\".\n" +
  "3. Extract every relevant field you can actually read from the image. Do not guess or fabricate a value you cannot see. Use these field_name values where applicable: full_name, date_of_birth, passport_number, nationality, issue_date, expiry_date, visa_type, visa_validity_start, visa_validity_end, destination_country, entry_type, document_number, vaccine_name, date_administered.\n\n" +
  "Respond ONLY with this exact JSON structure:\n" +
  "{\n" +
  "  \"document_type\": \"passport\" | \"visa\" | \"health_cert\" | \"id_card\" | \"unknown\",\n" +
  "  \"type_confidence\": number between 0 and 1,\n" +
  "  \"quality_status\": \"ok\" | \"blurry\" | \"glare\" | \"cropped\" | \"low_res\" | \"unreadable\",\n" +
  "  \"fields\": [ { \"field_name\": string, \"field_value\": string, \"confidence\": number between 0 and 1 } ]\n" +
  "}\n\n" +
  "If quality is bad enough that you can't extract reliable fields, still return your best-effort document_type and quality_status, with fields: [] or partial fields at low confidence rather than fabricating values.";

function bytesToBase64(bytes) {
  var binary = "";
  var chunkSize = 0x8000;
  for (var i = 0; i < bytes.length; i += chunkSize) {
    var chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function sanitizeExtractionResult(parsed) {
  var documentType = VALID_DOCUMENT_TYPES.indexOf(parsed.document_type) !== -1 ? parsed.document_type : "unknown";
  var qualityStatus = VALID_QUALITY_STATUSES.indexOf(parsed.quality_status) !== -1 ? parsed.quality_status : "unreadable";
  var typeConfidence = typeof parsed.type_confidence === "number" ? parsed.type_confidence : 0;
  var fields = Array.isArray(parsed.fields) ? parsed.fields.filter(function (f) {
    return f && typeof f.field_name === "string" && f.field_value != null;
  }).map(function (f) {
    return {
      field_name: f.field_name,
      field_value: String(f.field_value),
      confidence: typeof f.confidence === "number" ? f.confidence : 0
    };
  }) : [];

  return { document_type: documentType, type_confidence: typeConfidence, quality_status: qualityStatus, fields: fields };
}

async function callVisionModel(env, model, base64Image, mimeType, documentTypeHint) {
  var userText = documentTypeHint
    ? "The uploader indicated this is likely a: " + documentTypeHint + ". Verify and correct if wrong."
    : "Classify and extract this travel document.";

  var payload = {
    model: model,
    max_tokens: 1200,
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + base64Image } }
        ]
      }
    ]
  };

  var response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://visapath.neulab.xyz",
      "X-Title": "VisaPath by NeuLab"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("OpenRouter error " + response.status + ": " + (await response.text()));
  }

  var data = await response.json();
  var rawContent = data.choices[0].message.content;
  var cleaned = rawContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  return JSON.parse(cleaned);
}

// Returns { ok, model_used, document_type, type_confidence, quality_status, fields } on success,
// or { ok: false, error } if both primary and fallback models fail.
async function extractDocument(env, imageBytes, mimeType, documentTypeHint) {
  var base64Image = bytesToBase64(imageBytes);

  var models = [PRIMARY_MODEL, FALLBACK_MODEL];
  var lastError = null;

  for (var i = 0; i < models.length; i++) {
    try {
      var parsed = await callVisionModel(env, models[i], base64Image, mimeType, documentTypeHint);
      var clean = sanitizeExtractionResult(parsed);
      return {
        ok: true,
        model_used: models[i],
        document_type: clean.document_type,
        type_confidence: clean.type_confidence,
        quality_status: clean.quality_status,
        fields: clean.fields
      };
    } catch (e) {
      lastError = e;
      // Primary failed — fall through to try the fallback model.
    }
  }

  return { ok: false, error: "extraction_failed", detail: lastError ? String(lastError.message || lastError) : "unknown error" };
}

export { extractDocument };

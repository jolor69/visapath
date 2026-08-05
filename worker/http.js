// Shared response helper for the Document Readiness Checker routes.
function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders)
  });
}

export { jsonResponse };

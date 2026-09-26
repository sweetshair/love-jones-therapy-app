function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(body)
  };
}

function parseJsonBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch (error) {
    throw new Error("The request body is invalid.");
  }
}

module.exports = { jsonResponse, parseJsonBody };

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = allowed.includes(origin) ? origin : "";
  return {
    ...(selected ? { "access-control-allow-origin": selected } : {}),
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function apiError(error) {
  const status = Number(error?.status || 500);
  return {
    status,
    body: {
      success: false,
      message: status >= 500 ? "Backend temporarily unavailable" : String(error?.message || "Request failed"),
      retryable: Boolean(error?.retryable || status === 408 || status === 429 || status >= 500),
    },
  };
}


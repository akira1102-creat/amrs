(function attachAmrsAccessControl(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmrsAccessControl = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createModule() {
  "use strict";

  const ACCESS_TOKEN_KEY = "_amrs_access_token_v1";
  const LEGACY_DEPLOY_ID_KEY = "_ml_gas";
  const SESSION_KEY = "_amrs_cloud_session_v1";

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function credentialKind(value) {
    return /^amrs_[a-z0-9_-]{20,}$/i.test(text(value)) ? "personal" : "legacy";
  }

  function extractDeployId(value) {
    const raw = text(value).replace(/^['"]|['"]$/g, "");
    if (!/^https?:\/\//i.test(raw)) return raw.replace(/\/(?:exec|dev)\/?$/i, "");
    try {
      const url = new URL(raw);
      const match = url.pathname.match(/^\/macros\/s\/([^/]+)(?:\/(?:exec|dev))?\/?$/i);
      return url.hostname.toLowerCase() === "script.google.com" && match ? match[1] : "";
    } catch {
      return "";
    }
  }

  function saveCredential(storage, value) {
    const raw = text(value);
    if (!raw || !storage) throw new Error("Token is required");
    const kind = credentialKind(raw);
    storage.removeItem?.(SESSION_KEY);
    if (kind === "personal") {
      storage.setItem?.(ACCESS_TOKEN_KEY, raw);
      storage.removeItem?.(LEGACY_DEPLOY_ID_KEY);
      return { kind, value: raw };
    }
    const deployId = extractDeployId(raw);
    if (!deployId) throw new Error("Invalid legacy Deploy ID");
    storage.setItem?.(LEGACY_DEPLOY_ID_KEY, deployId);
    storage.removeItem?.(ACCESS_TOKEN_KEY);
    return { kind, value: deployId };
  }

  function clearCredential(storage) {
    [ACCESS_TOKEN_KEY, LEGACY_DEPLOY_ID_KEY, SESSION_KEY].forEach((key) => storage?.removeItem?.(key));
  }

  function normalizePermissions(permissions) {
    const source = Array.isArray(permissions) ? permissions : [];
    return [...new Set(source.map(text).filter((permission) => ["schedule", "ae", "cvcs", "admin"].includes(permission)))];
  }

  function hasPermission(permissions, permission) {
    return !permission || normalizePermissions(permissions).includes(permission);
  }

  function pagePermission(page) {
    const value = text(page).toLowerCase();
    if (value.includes("token") || value.includes("admin")) return "admin";
    if (value.startsWith("cvcs")) return "cvcs";
    if (value.includes("schedule") || value.includes("work-arrangement")) return "schedule";
    return "ae";
  }

  function filterVisiblePages(pages, permissions) {
    return (Array.isArray(pages) ? pages : []).filter((page) => hasPermission(permissions, pagePermission(page)));
  }

  return {
    ACCESS_TOKEN_KEY,
    LEGACY_DEPLOY_ID_KEY,
    SESSION_KEY,
    clearCredential,
    credentialKind,
    extractDeployId,
    filterVisiblePages,
    hasPermission,
    normalizePermissions,
    pagePermission,
    saveCredential,
  };
}));

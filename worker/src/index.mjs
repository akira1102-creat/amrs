import { handleRequest } from "./api.mjs";
import { createGoogleAccessTokenProvider } from "./google.mjs";
import { createSheetsClient } from "./sheets.mjs";
import { createCloudflareCacheAdapter } from "./cloudflare-cache.mjs";
import { readPublicGalaxyCsv } from "./public-galaxy.mjs";
import { createRepository } from "./repository.mjs";

const repositoryByEnv = new WeakMap();

function getRepository(env) {
  const existing = repositoryByEnv.get(env);
  if (existing) return existing;
  const tokenProvider = createGoogleAccessTokenProvider(env.GOOGLE_SERVICE_ACCOUNT);
  const sheetsClient = createSheetsClient({
    tokenProvider,
    credentials: env.GOOGLE_SERVICE_ACCOUNT,
    maxAttempts: 5,
    retryBaseMs: 750,
    retryMaxMs: 8_000,
  });
  const repository = createRepository(env, {
    sheetsClient,
    readPublicGalaxyCsv,
    cacheAdapter: createCloudflareCacheAdapter(),
  });
  repositoryByEnv.set(env, repository);
  return repository;
}

export default {
  async fetch(request, env, context) {
    return handleRequest(request, env, { context, repositoryFactory: () => getRepository(env) });
  },
};

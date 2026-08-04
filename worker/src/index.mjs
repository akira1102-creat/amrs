import { handleRequest } from "./api.mjs";

export default {
  async fetch(request, env, context) {
    return handleRequest(request, env, { context });
  },
};


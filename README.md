# AMRS

This repository publishes a generic sign-in entry. The authenticated application and business configuration are deployed separately to the existing API runtime, not included in the public static output.

## Build

- Public site: `node scripts/build-public.mjs <empty-output-directory>`
- Protected interface: restore the separately retained private source archive into `.private-runtime/source`, then run `node scripts/build-private-client.mjs`.
- API deployment: use `worker/deploy-private.jsonc`. Preserve the existing bindings and secrets. Never add `.private-runtime`, generated bundles, runtime secrets, exports or local data to this repository.
- Tests: `node --test test/*.test.mjs`. Run the original application and API suites from the separately retained private source before releasing the API bundle.

The original source is retained locally and needs a separate private backup. A clone of this public repository does not contain the private application implementation.

Removing implementation files from the current revision does not remove earlier public commits, forks or downloaded copies. Repository visibility and historical exposure require separate handling. Authorized users can inspect content delivered to their browsers.

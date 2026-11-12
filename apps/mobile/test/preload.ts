// Bun test runs @tail/protocol and @tail/brand from source. packages/protocol has no node_modules.
// Resolve its @noble imports from this app's node_modules, as metro.config.js does for the app.
import { plugin } from "bun";

const app = new URL("..", import.meta.url).pathname;
const protocol = new URL("../../../packages/protocol/", import.meta.url).pathname;
const brand = new URL("../../../packages/brand/", import.meta.url).pathname;

plugin({
  name: "tail-protocol-deps",
  setup(build) {
    build.onResolve({ filter: /^@noble\// }, (args) =>
      args.importer.startsWith(protocol) ? { path: Bun.resolveSync(args.path, app) } : undefined,
    );
    build.onResolve({ filter: /^@tail\/protocol$/ }, () => ({ path: `${protocol}src/index.ts` }));
    build.onResolve({ filter: /^@tail\/brand$/ }, () => ({ path: `${brand}src/index.ts` }));
  },
});

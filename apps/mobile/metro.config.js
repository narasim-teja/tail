// Metro reads the shared packages from source: @tail/protocol (one wire format) and @tail/brand
// (one set of colours, marks and icons), never copies. packages/protocol has no node_modules of
// its own, so its @noble imports are resolved from this app's node_modules, which pins the same
// versions.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const app = __dirname;
const shared = {
  "@tail/protocol": path.resolve(app, "../../packages/protocol"),
  "@tail/brand": path.resolve(app, "../../packages/brand"),
};

const config = getDefaultConfig(app);
config.watchFolders = [...(config.watchFolders ?? []), ...Object.values(shared)];
config.resolver.extraNodeModules = { ...config.resolver.extraNodeModules, ...shared };
config.resolver.nodeModulesPaths = [path.join(app, "node_modules")];

const upstream = config.resolver.resolveRequest;
const fromShared = (origin) => Object.values(shared).some((dir) => origin.startsWith(dir));
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (moduleName.startsWith("@noble/") && fromShared(context.originModulePath)) {
    // Resolve as if imported from the app, so there is exactly one copy of each @noble package.
    return resolve({ ...context, originModulePath: path.join(app, "index.ts") }, moduleName, platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;

const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [
  ...new Set([
    ...config.watchFolders,
    path.resolve(__dirname, "../lib"),
    path.resolve(__dirname, "../public"),
  ]),
];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  ...config.resolver.nodeModulesPaths,
];
module.exports = config;

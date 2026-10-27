const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// pnpm monorepo：让 Metro 同时监视 workspace 根，并按 mobile → 根的顺序解析模块
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;

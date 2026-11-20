// CommonJS config consumed by sequelize-cli (which require()s it). The app
// runtime (src/db/index.ts) stays native ESM; only this CLI bridge is .cjs.
// sequelize-cli reads NODE_ENV to pick the matching entry.
const common = {
  use_env_variable: 'DATABASE_URL',
  dialect: 'postgres',
};

module.exports = {
  development: common,
  test: common,
  production: common,
};

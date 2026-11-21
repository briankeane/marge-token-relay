'use strict';

/**
 * kv_store: the relay's single-use, TTL'd session/state store, moved off Redis
 * so production needs no separate key-value instance. Reads filter on
 * expires_at, so expired rows are simply invisible.
 * CommonJS (.cjs) because sequelize-cli require()s migration files; the rest of
 * the server package is native ESM.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('kv_store', {
      key: {
        type: Sequelize.TEXT,
        primaryKey: true,
        allowNull: false,
      },
      val: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
    await queryInterface.addIndex('kv_store', ['expires_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('kv_store');
  },
};

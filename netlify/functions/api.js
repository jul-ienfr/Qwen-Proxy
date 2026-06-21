/**
 * Netlify Functions Entry Point
 * Wraps the Express/Hono app for Netlify serverless
 */

const serverless = require('serverless-http');
const { app } = require('../../dist/api/server.js');

const handler = serverless(app.fetch || app);

module.exports.handler = handler;

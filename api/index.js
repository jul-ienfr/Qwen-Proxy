/**
 * Vercel Serverless Entry Point
 * Handles all API requests through Vercel's serverless functions
 */

const { app } = require('../dist/api/server.js');

module.exports = app;

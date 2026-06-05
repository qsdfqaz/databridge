// Vercel serverless entry point for DataBridge
// Vercel injects env vars into process.env — no dotenv needed

// Ensure writable /tmp for data files
const fs = require('fs');
try {
  if (!fs.existsSync('/tmp/users.json')) fs.writeFileSync('/tmp/users.json', '{}');
  if (!fs.existsSync('/tmp/usage.json')) fs.writeFileSync('/tmp/usage.json', '[]');
  if (!fs.existsSync('/tmp/templates.json')) fs.writeFileSync('/tmp/templates.json', '[]');
} catch(e) {}

// Override data file paths to use /tmp (Vercel's only writable dir)
const path = require('path');
const originalJoin = path.join;
path.join = function(...args) {
  const result = originalJoin(...args);
  // Redirect any data/ paths to /tmp
  if (result.includes('data' + path.sep + 'users.json')) return '/tmp/users.json';
  if (result.includes('data' + path.sep + 'usage.json')) return '/tmp/usage.json';
  if (result.includes('data' + path.sep + 'templates.json')) return '/tmp/templates.json';
  return result;
};

// Import the Express app
const app = require('../server.js');

module.exports = app;

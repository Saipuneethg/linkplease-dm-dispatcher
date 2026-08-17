// LinkPlease Automation Engine Root Entrypoint
const backend = require('./backend/server');

if (require.main === module) {
  backend.startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = backend;

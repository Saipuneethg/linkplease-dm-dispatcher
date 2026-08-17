const { app, startServer } = require('../server');

module.exports = async (req, res) => {
  try {
    await startServer();
  } catch (err) {
    console.error('Serverless init error:', err);
  }
  return app(req, res);
};

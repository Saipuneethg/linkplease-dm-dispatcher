const { app, initServerless } = require('../server');

module.exports = async (req, res) => {
  try {
    await initServerless();
  } catch (err) {
    console.error('Vercel serverless init error:', err);
  }
  return app(req, res);
};

const { app, initServerless } = require('../server');

module.exports = async (req, res) => {
  try {
    await initServerless();
  } catch (err) {
    console.error('Serverless init error:', err.message);
  }
  return app(req, res);
};

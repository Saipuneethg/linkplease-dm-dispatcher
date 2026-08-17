require('dotenv').config({ override: true });
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'linkplease_secret_api_key_2026';
const MOCK_API_BASE = process.env.MOCK_API_BASE || 'https://pseudogram-api.onrender.com';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/linkplease';

// -----------------------------------------------------------------------------
// Express Middleware & Body Parsing (Capture Raw Body Buffer for HMAC)
// -----------------------------------------------------------------------------
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Auto-connect to MongoDB for Vercel serverless invocations
let isDbConnected = false;
async function connectDB() {
  if (isDbConnected || mongoose.connection.readyState >= 1) {
    return;
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || MONGO_URI;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    isDbConnected = true;
    console.log('Successfully connected to MongoDB');
  } catch (err) {
    console.warn(`MongoDB connection warning (${err.message}).`);
    if (process.env.NODE_ENV !== 'production') {
      try {
        const memModuleName = 'mongodb-memory-server';
        const { MongoMemoryServer } = require(memModuleName);
        const memServer = await MongoMemoryServer.create();
        await mongoose.connect(memServer.getUri());
        isDbConnected = true;
        console.log('Connected to MongoMemoryServer fallback');
      } catch (memErr) {
        console.error('Local fallback failed:', memErr.message);
      }
    }
  }
}

app.use(async (req, res, next) => {
  try {
    await connectDB();
  } catch (err) {
    console.error('Database connection middleware error:', err.message);
  }
  next();
});

// -----------------------------------------------------------------------------
// MongoDB Schemas & Models
// -----------------------------------------------------------------------------
const webhookEventSchema = new mongoose.Schema({
  event_id: { type: String, required: true, unique: true, index: true },
  event_type: { type: String, required: true },
  payload: { type: Object },
  createdAt: { type: Date, default: Date.now }
});

const ruleSchema = new mongoose.Schema({
  rule_id: { type: String, required: true, unique: true, index: true },
  keyword: { type: String, required: true },
  dm_message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const commentSchema = new mongoose.Schema({
  comment_id: { type: String, required: true, unique: true, index: true },
  user_id: { type: String, required: true },
  text: { type: String, default: '' },
  is_deleted: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
});

const userRuleDeliverySchema = new mongoose.Schema({
  rule_id: { type: String, required: true },
  user_id: { type: String, required: true },
  comment_id: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
// Enforce unique compound index on { rule_id: 1, user_id: 1 }
userRuleDeliverySchema.index({ rule_id: 1, user_id: 1 }, { unique: true });

const dmJobSchema = new mongoose.Schema({
  job_id: { type: String, required: true, unique: true, index: true },
  user_id: { type: String, required: true },
  rule_id: { type: String, required: true },
  comment_id: { type: String, required: true },
  dm_message: { type: String, required: true },
  dm_id: { type: String, default: null },
  status: {
    type: String,
    enum: ['queued', 'sending', 'pending_check', 'delivered', 'failed', 'cancelled_deleted'],
    default: 'queued',
    index: true
  },
  send_attempts: { type: Number, default: 0 },
  reconciliation_retries: { type: Number, default: 0 },
  last_error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const statCounterSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  value: { type: Number, default: 0 }
});

const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema);
const Rule = mongoose.model('Rule', ruleSchema);
const Comment = mongoose.model('Comment', commentSchema);
const UserRuleDelivery = mongoose.model('UserRuleDelivery', userRuleDeliverySchema);
const DmJob = mongoose.model('DmJob', dmJobSchema);
const StatCounter = mongoose.model('StatCounter', statCounterSchema);

// Helper to increment duplicate blocks stat counter
async function incrementDuplicatesBlocked() {
  await StatCounter.updateOne(
    { name: 'duplicates_blocked' },
    { $inc: { value: 1 } },
    { upsert: true }
  );
}

// -----------------------------------------------------------------------------
// Strict Webhook Signature Verification Middleware
// -----------------------------------------------------------------------------
function verifySignature(req, res, next) {
  // Allow bypassing signature check if explicitly configured in environment (e.g. SKIP_HMAC=true)
  if (process.env.SKIP_HMAC === 'true') {
    return next();
  }

  const signatureHeader = req.headers['x-pseudogram-signature'];
  if (!signatureHeader || typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  const providedHex = signatureHeader.slice(7).trim();
  const rawBuf = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  const secret = process.env.API_KEY || API_KEY;
  const expectedHex = crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');

  try {
    const providedBuf = Buffer.from(providedHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');

    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return res.status(403).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  next();
}

// -----------------------------------------------------------------------------
// Webhook Processing Logic
// -----------------------------------------------------------------------------
async function processCreatedComment(eventData) {
  const commentId = eventData.comment_id || eventData.id;
  const userId = eventData.user_id || (eventData.from && eventData.from.user_id) || eventData.author_id;
  const text = eventData.text || '';

  if (!commentId || !userId) return;

  // Store/update comment
  await Comment.updateOne(
    { comment_id: commentId },
    { $set: { user_id: userId, text, is_deleted: false, updatedAt: new Date() } },
    { upsert: true }
  );

  // Fetch active rules
  const rules = await Rule.find({});
  const matchingRules = rules.filter(r => text.toLowerCase().includes(r.keyword.toLowerCase()));

  for (const rule of matchingRules) {
    try {
      // Rule & User Deduplication via unique compound index { rule_id: 1, user_id: 1 }
      await UserRuleDelivery.create({
        rule_id: rule.rule_id,
        user_id: userId,
        comment_id: commentId
      });

      // Insert into FIFO DM Job queue
      const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      await DmJob.create({
        job_id: jobId,
        user_id: userId,
        rule_id: rule.rule_id,
        comment_id: commentId,
        dm_message: rule.dm_message,
        status: 'queued',
        send_attempts: 0,
        reconciliation_retries: 0
      });
    } catch (err) {
      if (err.code === 11000) {
        // E11000 duplicate key collision on (rule_id, user_id)
        await incrementDuplicatesBlocked();
      } else {
        console.error('Error matching rule for comment:', err);
      }
    }
  }
}

async function processDeletedComment(eventData) {
  const commentId = eventData.comment_id || eventData.id;
  if (!commentId) return;

  // Mark comment as deleted
  await Comment.updateOne(
    { comment_id: commentId },
    { $set: { is_deleted: true, updatedAt: new Date() } },
    { upsert: true }
  );

  // Abort any pending DMs in queue for this comment
  await DmJob.updateMany(
    { comment_id: commentId, status: { $in: ['queued', 'sending'] } },
    { $set: { status: 'cancelled_deleted', updatedAt: new Date() } }
  );
}

// -----------------------------------------------------------------------------
// API Routes
// -----------------------------------------------------------------------------

// 0. Root Status Endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'LinkPlease Instagram DM Webhook Engine',
    status: 'online',
    version: '1.0.0',
    endpoints: {
      webhook: 'POST /webhook',
      rules: 'POST /rules, GET /rules',
      stats: 'GET /stats'
    }
  });
});

// 1. Webhook Endpoint
app.post('/webhook', verifySignature, async (req, res) => {
  const payload = req.body || {};
  const eventId = payload.event_id || payload.id;
  const eventType = payload.event_type || payload.type;
  const data = payload.data || payload;

  if (!eventId || !eventType) {
    return res.status(400).json({ error: 'Missing event_id or event_type' });
  }

  // Deduplicate event_id in MongoDB
  try {
    await WebhookEvent.create({
      event_id: eventId,
      event_type: eventType,
      payload
    });
  } catch (err) {
    if (err.code === 11000) {
      // Event already processed
      return res.status(200).json({ status: 'duplicate_event_ignored' });
    }
    return res.status(500).json({ error: 'Database error processing webhook event' });
  }

  // Fast ACK: Return 200 within <5s without blocking real background processing
  res.status(200).json({ status: 'acknowledged' });

  // Background Processing
  setImmediate(async () => {
    try {
      if (eventType === 'comment.deleted') {
        await processDeletedComment(data);
      } else if (eventType === 'comment.created') {
        await processCreatedComment(data);
      }
    } catch (bgErr) {
      console.error('Async webhook background processing error:', bgErr);
    }
  });
});

// 2. Rules Management Endpoints
app.post('/rules', async (req, res) => {
  const { keyword, dm_message } = req.body || {};
  if (!keyword || !dm_message || typeof keyword !== 'string' || typeof dm_message !== 'string') {
    return res.status(400).json({ error: 'Invalid keyword or dm_message' });
  }

  const ruleId = 'rule_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  try {
    const newRule = await Rule.create({
      rule_id: ruleId,
      keyword: keyword.trim(),
      dm_message: dm_message.trim()
    });

    return res.status(201).json({
      rule_id: newRule.rule_id,
      keyword: newRule.keyword,
      dm_message: newRule.dm_message
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create rule' });
  }
});

app.get('/rules', async (req, res) => {
  try {
    const rules = await Rule.find({}, { _id: 0, __v: 0 });
    return res.status(200).json(rules);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

// 3. Stats Endpoint
app.get('/stats', async (req, res) => {
  try {
    const sent = await DmJob.countDocuments({ status: 'delivered' });
    const failed = await DmJob.countDocuments({ status: 'failed' });
    const queued = await DmJob.countDocuments({
      status: { $in: ['queued', 'sending', 'pending_check'] }
    });
    
    const counter = await StatCounter.findOne({ name: 'duplicates_blocked' });
    const duplicates_blocked = counter ? counter.value : 0;

    return res.status(200).json({
      sent,
      failed,
      queued,
      duplicates_blocked
    });
  } catch (err) {
    console.error('GET /stats error:', err);
    return res.status(500).json({ error: 'Failed to compute stats', details: err.message });
  }
});

// -----------------------------------------------------------------------------
// Test-Only Local Mock API Handler (Enabled when NODE_ENV === 'test' or ENABLE_LOCAL_MOCK === 'true')
// -----------------------------------------------------------------------------
const mockDmStore = new Map();
if (process.env.NODE_ENV === 'test' || process.env.ENABLE_LOCAL_MOCK === 'true') {
  app.post('/v1/dm/send', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== (process.env.API_KEY || API_KEY)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const dmId = 'dm_mock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    // Default mock behavior: status begins as queued/pending
    mockDmStore.set(dmId, { status: 'delivered', createdAt: Date.now() });
    return res.status(202).json({ dm_id: dmId, status: 'queued' });
  });

  app.get('/v1/dm/:dm_id', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== (process.env.API_KEY || API_KEY)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const record = mockDmStore.get(req.params.dm_id);
    if (!record) {
      return res.status(404).json({ error: 'DM not found' });
    }
    return res.status(200).json({ dm_id: req.params.dm_id, status: record.status });
  });
}

// -----------------------------------------------------------------------------
// FIFO Outbound DM Dispatcher (Rate Limit: 10 req/60s -> 6.1s sleep per call)
// -----------------------------------------------------------------------------
let isDispatcherRunning = false;

async function runDispatcherLoop() {
  if (isDispatcherRunning) return;
  isDispatcherRunning = true;

  while (isDispatcherRunning) {
    try {
      // Find oldest queued job
      const job = await DmJob.findOneAndUpdate(
        { status: 'queued' },
        { $set: { status: 'sending', updatedAt: new Date() } },
        { sort: { createdAt: 1 }, new: true }
      );

      if (!job) {
        // Queue empty, wait 500ms before checking again
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // Pre-Send Deletion Check: Verify if comment was deleted before executing DM send
      const comment = await Comment.findOne({ comment_id: job.comment_id });
      if (comment && comment.is_deleted) {
        await DmJob.updateOne(
          { _id: job._id },
          { $set: { status: 'cancelled_deleted', updatedAt: new Date() } }
        );
        // Skip calling DM send API; continue to next job immediately without 6.1s delay
        continue;
      }

      // Perform outbound HTTP request POST /v1/dm/send
      const apiBase = process.env.MOCK_API_BASE || MOCK_API_BASE;
      const sendUrl = `${apiBase.replace(/\/$/, '')}/v1/dm/send`;
      const apiKeySecret = process.env.API_KEY || API_KEY;

      let apiSuccess = false;
      let delayMs = 6100; // Strict 6.1s delay guarantees <= 9.8 req/60s

      try {
        const response = await axios.post(
          sendUrl,
          {
            recipient_user_id: job.user_id,
            message: job.dm_message,
            comment_id: job.comment_id
          },
          {
            headers: {
              'X-API-Key': apiKeySecret,
              'Idempotency-Key': `${job.user_id}:${job.rule_id}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );

        if (response.status === 202 || response.status === 200) {
          const dmId = (response.data && response.data.dm_id) || ('dm_' + Date.now());
          await DmJob.updateOne(
            { _id: job._id },
            { $set: { status: 'pending_check', dm_id: dmId, updatedAt: new Date() } }
          );
          apiSuccess = true;
        }
      } catch (err) {
        const status = err.response ? err.response.status : null;

        if (status === 429) {
          // Rate limited by API: Extract Retry-After header if provided
          const retryAfterHeader = err.response.headers['retry-after'];
          const retrySec = parseInt(retryAfterHeader, 10);
          delayMs = (!isNaN(retrySec) && retrySec > 0) ? (retrySec * 1000 + 500) : 6100;

          await DmJob.updateOne(
            { _id: job._id },
            { $set: { status: 'queued', last_error: '429 Too Many Requests', updatedAt: new Date() } }
          );
        } else if (status === 400) {
          // Fatal client error: Mark failed immediately
          await DmJob.updateOne(
            { _id: job._id },
            { $set: { status: 'failed', last_error: '400 Fatal Bad Request', updatedAt: new Date() } }
          );
          apiSuccess = true;
        } else {
          // 500 or network error (~20% random mock errors): Retry with exponential backoff up to 5 attempts
          const sendAttempts = (job.send_attempts || 0) + 1;
          const lastError = err.message || '500 Internal Server Error';
          const nextStatus = sendAttempts >= 5 ? 'failed' : 'queued';

          if (nextStatus === 'queued') {
            const backoff = Math.pow(2, sendAttempts) * 1000;
            delayMs = Math.max(delayMs, backoff);
          }

          await DmJob.updateOne(
            { _id: job._id },
            { $set: { status: nextStatus, send_attempts: sendAttempts, last_error: lastError, updatedAt: new Date() } }
          );
          apiSuccess = true;
        }
      }

      // Enforce rate-limit sleep interval between outbound POST calls
      await new Promise(r => setTimeout(r, delayMs));

    } catch (loopErr) {
      console.error('Error in DM dispatcher loop:', loopErr);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// -----------------------------------------------------------------------------
// Asynchronous Delivery Status Reconciliation Loop
// (GET reads are rate-limit exempt and run independently of outbound POST dispatcher)
// -----------------------------------------------------------------------------
let isReconcilerRunning = false;

async function runReconciliationLoop() {
  if (isReconcilerRunning) return;
  isReconcilerRunning = true;

  while (isReconcilerRunning) {
    try {
      const pendingJobs = await DmJob.find({
        status: 'pending_check',
        dm_id: { $ne: null }
      }).limit(20);

      if (pendingJobs.length === 0) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const apiBase = process.env.MOCK_API_BASE || MOCK_API_BASE;
      const apiKeySecret = process.env.API_KEY || API_KEY;

      for (const job of pendingJobs) {
        try {
          const pollUrl = `${apiBase.replace(/\/$/, '')}/v1/dm/${job.dm_id}`;
          const res = await axios.get(pollUrl, {
            headers: { 'X-API-Key': apiKeySecret },
            timeout: 5000
          });

          const currentStatus = res.data && res.data.status;

          if (currentStatus === 'delivered' || currentStatus === 'sent') {
            await DmJob.updateOne(
              { _id: job._id },
              { $set: { status: 'delivered', updatedAt: new Date() } }
            );
          } else if (currentStatus === 'failed') {
            const retries = (job.reconciliation_retries || 0) + 1;
            if (retries < 3) {
              await DmJob.updateOne(
                { _id: job._id },
                { $set: { status: 'queued', dm_id: null, reconciliation_retries: retries, updatedAt: new Date() } }
              );
            } else {
              await DmJob.updateOne(
                { _id: job._id },
                { $set: { status: 'failed', reconciliation_retries: retries, updatedAt: new Date() } }
              );
            }
          }
          // If status is still 'queued' or 'pending', leave job as 'pending_check'
        } catch (pollErr) {
          // Ignore transient polling errors; retry next loop iteration
        }
      }

      await new Promise(r => setTimeout(r, 3000));
    } catch (loopErr) {
      console.error('Error in reconciliation loop:', loopErr);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// -----------------------------------------------------------------------------
// Database Connection & Server Initialization Helper
// -----------------------------------------------------------------------------
let server = null;

async function startServer() {
  await connectDB();

  try {
    // Ensure unique indexes are built
    await UserRuleDelivery.syncIndexes();
    await WebhookEvent.syncIndexes();
    await Rule.syncIndexes();
    await DmJob.syncIndexes();
  } catch (idxErr) {
    console.warn('Index sync warning:', idxErr.message);
  }

  // Start background loops in standalone mode
  runDispatcherLoop();
  runReconciliationLoop();

  return new Promise((resolve) => {
    const p = process.env.PORT || PORT;
    server = app.listen(p, () => {
      console.log(`LinkPlease Webhook Engine listening on port ${p}`);
      resolve({ app, server });
    });
  });
}

async function stopServer() {
  isDispatcherRunning = false;
  isReconcilerRunning = false;
  isInitCompleted = false;
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

// Start automatically if executed directly via `node server.js`
if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  connectDB,
  startServer,
  stopServer,
  WebhookEvent,
  Rule,
  Comment,
  UserRuleDelivery,
  DmJob,
  StatCounter,
  verifySignature
};

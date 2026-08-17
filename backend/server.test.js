const request = require('supertest');
const crypto = require('crypto');
const {
  app,
  startServer,
  stopServer,
  WebhookEvent,
  Rule,
  DmJob,
  Comment,
  StatCounter
} = require('./server');

describe('LinkPlease Engine Complete Integration Test Suite', () => {

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.API_KEY = 'test_secret_key_123';
    await startServer();
  }, 30000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  beforeEach(async () => {
    await WebhookEvent.deleteMany({});
    await Rule.deleteMany({});
    await DmJob.deleteMany({});
    await Comment.deleteMany({});
    await StatCounter.deleteMany({});
  });

  // Helper to sign test payloads
  function computeSignature(payloadObj) {
    const rawBuf = Buffer.from(JSON.stringify(payloadObj));
    const hmac = crypto.createHmac('sha256', process.env.API_KEY);
    return 'sha256=' + hmac.update(rawBuf).digest('hex');
  }

  // 1. Webhook Signature Verification
  describe('1. Webhook Signature Verification (HMAC-SHA256)', () => {
    it('should return 403 Forbidden if X-PseudoGram-Signature header is missing', async () => {
      const res = await request(app)
        .post('/webhook')
        .send({ event_id: 'evt_001', event_type: 'comment.created' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Invalid signature' });
    });

    it('should return 403 Forbidden if X-PseudoGram-Signature is invalid', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', 'sha256=invalid_hex_string_12345')
        .send({ event_id: 'evt_001', event_type: 'comment.created' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Invalid signature' });
    });

    it('should return 200 OK when X-PseudoGram-Signature is valid', async () => {
      const payload = {
        event_id: 'evt_valid_001',
        event_type: 'comment.created',
        data: { comment_id: 'c1', user_id: 'u1', text: 'Hello' }
      };
      const sig = computeSignature(payload);

      const res = await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'acknowledged' });
    });
  });

  // 2. Event Deduplication
  describe('2. Event Deduplication (event_id)', () => {
    it('should return duplicate_event_ignored on receiving duplicate event_id', async () => {
      const payload = {
        event_id: 'evt_dup_100',
        event_type: 'comment.created',
        data: { comment_id: 'c2', user_id: 'u2', text: 'PRICE' }
      };
      const sig = computeSignature(payload);

      // First call
      const res1 = await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', sig)
        .send(payload);
      expect(res1.status).toBe(200);

      // Second call with same event_id
      const res2 = await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', sig)
        .send(payload);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ status: 'duplicate_event_ignored' });
    });
  });

  // 3. Rules Engine API
  describe('3. Rules Engine API (/rules)', () => {
    it('should create a new rule with 201 Created', async () => {
      const res = await request(app)
        .post('/rules')
        .send({ keyword: 'PRICE', dm_message: 'Here is the price list: $99' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('rule_id');
      expect(res.body.keyword).toBe('PRICE');
      expect(res.body.dm_message).toBe('Here is the price list: $99');
    });

    it('should list active rules via GET /rules', async () => {
      await request(app)
        .post('/rules')
        .send({ keyword: 'LINK', dm_message: 'https://linkplease.ai' });

      const res = await request(app).get('/rules');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  // 4. Keyword Matching & Rule-User Deduplication
  describe('4. Keyword Matching & Rule-User Deduplication', () => {
    it('should queue a DM job for keyword match (case-insensitive)', async () => {
      // Create Rule
      await request(app)
        .post('/rules')
        .send({ keyword: 'PRICE', dm_message: 'Special Price DM' });

      // Send Webhook Comment containing lower-case 'price'
      const payload = {
        event_id: 'evt_match_55',
        event_type: 'comment.created',
        data: { comment_id: 'cmt_55', user_id: 'user_55', text: 'Can I get the price please?' }
      };
      const sig = computeSignature(payload);

      await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', sig)
        .send(payload);

      // Wait briefly for async background processing
      await new Promise(r => setTimeout(r, 250));

      const job = await DmJob.findOne({ user_id: 'user_55' });
      expect(job).not.toBeNull();
      expect(job.dm_message).toBe('Special Price DM');
    });

    it('should parse user_id from nested data.from.user_id matching exact spec payload shape', async () => {
      await request(app)
        .post('/rules')
        .send({ keyword: 'INFO', dm_message: 'Info Sent' });

      const payload = {
        event_id: 'evt_nested_01',
        event_type: 'comment.created',
        data: {
          comment_id: 'cmt_nest_1',
          text: 'Send INFO please',
          from: { user_id: 'usr_nested_99' }
        }
      };
      const sig = computeSignature(payload);

      await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', sig)
        .send(payload);

      await new Promise(r => setTimeout(r, 250));

      const job = await DmJob.findOne({ user_id: 'usr_nested_99' });
      expect(job).not.toBeNull();
    });

    it('should block duplicate DMs for same user and rule, incrementing duplicates_blocked', async () => {
      // Create Rule
      const ruleRes = await request(app)
        .post('/rules')
        .send({ keyword: 'DEAL', dm_message: 'Exclusive Deal' });
      
      const ruleId = ruleRes.body.rule_id;

      // First Comment from user_x
      const payload1 = {
        event_id: 'evt_deal_1',
        event_type: 'comment.created',
        data: { comment_id: 'cmt_d1', user_id: 'user_x', text: 'I want DEAL' }
      };
      await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', computeSignature(payload1))
        .send(payload1);

      await new Promise(r => setTimeout(r, 150));

      // Second Comment from same user_x for same rule
      const payload2 = {
        event_id: 'evt_deal_2',
        event_type: 'comment.created',
        data: { comment_id: 'cmt_d2', user_id: 'user_x', text: 'Another DEAL comment' }
      };
      await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', computeSignature(payload2))
        .send(payload2);

      await new Promise(r => setTimeout(r, 150));

      const jobs = await DmJob.find({ user_id: 'user_x', rule_id: ruleId });
      expect(jobs.length).toBe(1); // Only 1 DM job queued

      const statsRes = await request(app).get('/stats');
      expect(statsRes.body.duplicates_blocked).toBeGreaterThanOrEqual(1);
    });
  });

  // 5. Pre-Send Deletion Handling
  describe('5. Pre-Send Deletion Handling', () => {
    it('should cancel pending DM job when comment.deleted event arrives', async () => {
      await request(app)
        .post('/rules')
        .send({ keyword: 'SALE', dm_message: 'Sale Details' });

      // Comment Created
      const createdPayload = {
        event_id: 'evt_sale_1',
        event_type: 'comment.created',
        data: { comment_id: 'cmt_sale_1', user_id: 'usr_sale_1', text: 'Is SALE active?' }
      };
      await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', computeSignature(createdPayload))
        .send(createdPayload);

      await new Promise(r => setTimeout(r, 100));

      // Comment Deleted
      const deletedPayload = {
        event_id: 'evt_sale_2',
        event_type: 'comment.deleted',
        data: { comment_id: 'cmt_sale_1' }
      };
      await request(app)
        .post('/webhook')
        .set('X-PseudoGram-Signature', computeSignature(deletedPayload))
        .send(deletedPayload);

      await new Promise(r => setTimeout(r, 150));

      const job = await DmJob.findOne({ comment_id: 'cmt_sale_1' });
      expect(job.status).toBe('cancelled_deleted');
    });
  });

  // 6. GET /stats Endpoint
  describe('6. GET /stats Endpoint', () => {
    it('should return accurate sent, failed, queued, and duplicates_blocked counts', async () => {
      const res = await request(app).get('/stats');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sent');
      expect(res.body).toHaveProperty('failed');
      expect(res.body).toHaveProperty('queued');
      expect(res.body).toHaveProperty('duplicates_blocked');
    });
  });

});

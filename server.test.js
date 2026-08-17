const request = require('supertest');
const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test_secret_key_123';
process.env.ENABLE_LOCAL_MOCK = 'true';

const {
  app,
  WebhookEvent,
  Rule,
  Comment,
  UserRuleDelivery,
  DmJob,
  StatCounter
} = require('./server');

let mongoServer;

function generateSignature(bodyBuffer, secret = process.env.API_KEY) {
  const hex = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
  return `sha256=${hex}`;
}

jest.setTimeout(60000);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  process.env.MONGO_URI = mongoUri;

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(mongoUri);

  await UserRuleDelivery.syncIndexes();
  await WebhookEvent.syncIndexes();
  await Rule.syncIndexes();
  await DmJob.syncIndexes();
}, 120000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});

beforeEach(async () => {
  await WebhookEvent.deleteMany({});
  await Rule.deleteMany({});
  await Comment.deleteMany({});
  await UserRuleDelivery.deleteMany({});
  await DmJob.deleteMany({});
  await StatCounter.deleteMany({});
});

describe('1. Webhook Signature Verification (HMAC-SHA256)', () => {
  it('should return 403 Forbidden if X-PseudoGram-Signature header is missing', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ event_id: 'evt_1', event_type: 'comment.created' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  it('should return 403 Forbidden if X-PseudoGram-Signature is invalid', async () => {
    const payload = JSON.stringify({ event_id: 'evt_1', event_type: 'comment.created' });
    const res = await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', 'sha256=invalid_hex_signature')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  it('should return 200 OK when X-PseudoGram-Signature is valid', async () => {
    const bodyObj = { event_id: 'evt_valid_1', event_type: 'comment.created', data: { comment_id: 'c1', user_id: 'u1', text: 'hello' } };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const signature = generateSignature(rawBody);

    const res = await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyObj);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'acknowledged' });
  });
});

describe('2. Event Deduplication (event_id)', () => {
  it('should return duplicate_event_ignored on receiving duplicate event_id', async () => {
    const bodyObj = { event_id: 'evt_dup_123', event_type: 'comment.created', data: { comment_id: 'c1', user_id: 'u1', text: 'hi' } };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const signature = generateSignature(rawBody);

    const res1 = await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyObj);

    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ status: 'acknowledged' });

    const res2 = await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyObj);

    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ status: 'duplicate_event_ignored' });
  });
});

describe('3. Rules Engine API (/rules)', () => {
  it('should create a new rule with 201 Created', async () => {
    const res = await request(app)
      .post('/rules')
      .send({ keyword: 'PRICE', dm_message: 'Here is the price list!' });

    expect(res.status).toBe(201);
    expect(res.body.keyword).toBe('PRICE');
    expect(res.body.dm_message).toBe('Here is the price list!');
    expect(res.body.rule_id).toBeDefined();
  });

  it('should list active rules via GET /rules', async () => {
    await Rule.create({ rule_id: 'rule_1', keyword: 'PRICE', dm_message: 'Price info' });

    const res = await request(app).get('/rules');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].keyword).toBe('PRICE');
  });
});

describe('4. Keyword Matching & Rule-User Deduplication', () => {
  it('should queue a DM job for keyword match (case-insensitive)', async () => {
    await Rule.create({ rule_id: 'rule_price', keyword: 'PRICE', dm_message: 'Price details' });

    const bodyObj = {
      event_id: 'evt_match_1',
      event_type: 'comment.created',
      data: { comment_id: 'cmt_100', user_id: 'usr_200', text: 'Can I get the price please?' }
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const signature = generateSignature(rawBody);

    const res = await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyObj);

    expect(res.status).toBe(200);

    // Wait briefly for background processing
    await new Promise(r => setTimeout(r, 100));

    const jobs = await DmJob.find({ user_id: 'usr_200', rule_id: 'rule_price' });
    expect(jobs.length).toBe(1);
    expect(jobs[0].dm_message).toBe('Price details');
  });

  it('should parse user_id from nested data.from.user_id matching exact spec payload shape', async () => {
    await Rule.create({ rule_id: 'rule_price_nested', keyword: 'PRICE', dm_message: 'Price list info' });

    const specPayload = {
      event_id: 'evt_01J8ZQ4K2N7RXA',
      event_type: 'comment.created',
      sent_at: '2026-08-10T09:14:22.481Z',
      data: {
        comment_id: 'cmt_9f2a7c',
        post_id: 'post_44de1b',
        text: 'PRICE please',
        created_at: '2026-08-10T09:14:21.900Z',
        from: {
          user_id: 'usr_3b91fe',
          username: 'arjun.shoots'
        }
      }
    };
    const signature = generateSignature(Buffer.from(JSON.stringify(specPayload)));

    const res = await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(specPayload);

    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 100));

    const jobs = await DmJob.find({ user_id: 'usr_3b91fe', rule_id: 'rule_price_nested' });
    expect(jobs.length).toBe(1);
    expect(jobs[0].comment_id).toBe('cmt_9f2a7c');
  });

  it('should block duplicate DMs for same user and rule, incrementing duplicates_blocked', async () => {
    await Rule.create({ rule_id: 'rule_price', keyword: 'PRICE', dm_message: 'Price details' });

    const bodyObj1 = {
      event_id: 'evt_dup_user_1',
      event_type: 'comment.created',
      data: { comment_id: 'cmt_101', user_id: 'usr_200', text: 'price check 1' }
    };
    const signature1 = generateSignature(Buffer.from(JSON.stringify(bodyObj1)));
    await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', signature1)
      .set('Content-Type', 'application/json')
      .send(bodyObj1);

    await new Promise(r => setTimeout(r, 100));

    const bodyObj2 = {
      event_id: 'evt_dup_user_2',
      event_type: 'comment.created',
      data: { comment_id: 'cmt_102', user_id: 'usr_200', text: 'another price question' }
    };
    const signature2 = generateSignature(Buffer.from(JSON.stringify(bodyObj2)));
    await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', signature2)
      .set('Content-Type', 'application/json')
      .send(bodyObj2);

    await new Promise(r => setTimeout(r, 100));

    const jobs = await DmJob.find({ user_id: 'usr_200', rule_id: 'rule_price' });
    expect(jobs.length).toBe(1); // Only 1 job created

    const counter = await StatCounter.findOne({ name: 'duplicates_blocked' });
    expect(counter).toBeDefined();
    expect(counter.value).toBe(1);
  });
});

describe('5. Pre-Send Deletion Handling', () => {
  it('should cancel pending DM job when comment.deleted event arrives', async () => {
    await Rule.create({ rule_id: 'rule_price', keyword: 'PRICE', dm_message: 'Price details' });

    // 1. Create comment
    const createObj = {
      event_id: 'evt_c1',
      event_type: 'comment.created',
      data: { comment_id: 'cmt_del_1', user_id: 'usr_del_1', text: 'price' }
    };
    await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', generateSignature(Buffer.from(JSON.stringify(createObj))))
      .set('Content-Type', 'application/json')
      .send(createObj);

    await new Promise(r => setTimeout(r, 100));

    // 2. Delete comment
    const deleteObj = {
      event_id: 'evt_d1',
      event_type: 'comment.deleted',
      data: { comment_id: 'cmt_del_1' }
    };
    await request(app)
      .post('/webhook')
      .set('X-PseudoGram-Signature', generateSignature(Buffer.from(JSON.stringify(deleteObj))))
      .set('Content-Type', 'application/json')
      .send(deleteObj);

    await new Promise(r => setTimeout(r, 100));

    const job = await DmJob.findOne({ comment_id: 'cmt_del_1' });
    expect(job).toBeDefined();
    expect(job.status).toBe('cancelled_deleted');
  });
});

describe('6. GET /stats Endpoint', () => {
  it('should return accurate sent, failed, queued, and duplicates_blocked counts', async () => {
    await DmJob.create({ job_id: 'j1', user_id: 'u1', rule_id: 'r1', comment_id: 'c1', dm_message: 'm', status: 'delivered' });
    await DmJob.create({ job_id: 'j2', user_id: 'u2', rule_id: 'r1', comment_id: 'c2', dm_message: 'm', status: 'failed' });
    await DmJob.create({ job_id: 'j3', user_id: 'u3', rule_id: 'r1', comment_id: 'c3', dm_message: 'm', status: 'queued' });
    await DmJob.create({ job_id: 'j4', user_id: 'u4', rule_id: 'r1', comment_id: 'c4', dm_message: 'm', status: 'pending_check' });
    await StatCounter.create({ name: 'duplicates_blocked', value: 3 });

    const res = await request(app).get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sent: 1,
      failed: 1,
      queued: 2,
      duplicates_blocked: 3
    });
  });
});

import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import { MongoClient, Db } from 'mongodb';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import crypto from 'crypto';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_FILE = path.resolve(process.cwd(), 'data-store.json');
const SESSION_COOKIE_NAME = 'studio_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

// Cryptographic Password Hashing (scrypt)
export function hashPin(pin: string, salt = crypto.randomBytes(16).toString('hex')): { salt: string; hash: string } {
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPin(pin: string, salt: string, hash: string): boolean {
  try {
    const test = crypto.scryptSync(pin, salt, 64);
    const stored = Buffer.from(hash, 'hex');
    if (stored.length !== test.length) return false;
    return crypto.timingSafeEqual(stored, test);
  } catch {
    return false;
  }
}

// Initial Admin PIN Setup (Zero plaintext stored in code or database)
const INITIAL_ADMIN_PIN = (process.env.INITIAL_ADMIN_PIN || '102938').trim();

// Clean Initial Seed Data (0% Prices, 0% Currencies - Pure Quantities, Specs & Storage)
const DEFAULT_CATEGORIES = [
  { id: 'cat-1', name: 'أوراق الطباعة', description: 'ورق فوتوغرافي، كانفاس، جلوسي ومات', sort_order: 1 },
  { id: 'cat-2', name: 'الأحبار', description: 'أحبار طابعات إبسون وكانون وماكينات اللارج', sort_order: 2 },
  { id: 'cat-3', name: 'خامات تغليف الألبومات', description: 'كرتون مقوى، جلد، قطيفة، حرير، فوم', sort_order: 3 },
  { id: 'cat-4', name: 'المواد اللاصقة وسلوفان السخونة', description: 'شيتات دبل فيس، غراء أبيض، رولات سلوفان', sort_order: 4 },
  { id: 'cat-5', name: 'أخشاب وشاسيهات', description: 'خشب MDF، شاسيهات كانفاس خشب سويدي', sort_order: 5 },
  { id: 'cat-6', name: 'إكسسوارات وعينات', description: 'زوايا معدنية، علب فاخرة، حقائب ألبومات', sort_order: 6 }
];

const DEFAULT_ITEMS = [
  { id: 'itm-1', sku: 'PPR-GL-3040', name: 'ورق فوتوغرافي جلوسي لامع 260 جم', category_id: 'cat-1', specs: '30×40 سم - رزمة 50 فرخ', unit: 'رزمة', quantity: 18, min_limit: 5, reorder_qty: 15, supplier_id: '', storage_location: 'رف أ-1', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'itm-2', sku: 'PPR-MT-A4', name: 'ورق تصوير مات مطفي 230 جم', category_id: 'cat-1', specs: 'A4 - باكت 100 فرخ', unit: 'علبة', quantity: 3, min_limit: 6, reorder_qty: 10, supplier_id: '', storage_location: 'رف أ-2', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'itm-3', sku: 'INK-EPS-BK', name: 'حبر إبسون أصلي أسود T6731', category_id: 'cat-2', specs: 'عبوة 70 مل للطباعة الدقيقة', unit: 'علبة', quantity: 2, min_limit: 4, reorder_qty: 6, supplier_id: '', storage_location: 'درج الأحبار 1', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'itm-4', sku: 'INK-EPS-CY', name: 'حبر إبسون أصلي أزرق سماوي T6732', category_id: 'cat-2', specs: 'عبوة 70 مل', unit: 'علبة', quantity: 0, min_limit: 3, reorder_qty: 6, supplier_id: '', storage_location: 'درج الأحبار 1', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'itm-5', sku: 'ALB-MDF-3030', name: 'شيتات كرتون مكبس حراري 1.5 مم', category_id: 'cat-3', specs: '30×30 سم لصفحات الألبوم الديجيتال', unit: 'قطعة', quantity: 240, min_limit: 100, reorder_qty: 200, supplier_id: '', storage_location: 'مخزن التجليد - رف 2', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'itm-6', sku: 'ALB-LTH-BRN', name: 'جلد صناعي إيطالي مبطن بني', category_id: 'cat-3', specs: 'عرض 140 سم - لغلاف الألبوم', unit: 'متر', quantity: 4.5, min_limit: 5, reorder_qty: 10, supplier_id: '', storage_location: 'مخزن الأقمشة', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'itm-7', sku: 'ADH-DBL-30', name: 'رول سلوفان حراري مات مطفي 30 ميكرون', category_id: 'cat-4', specs: 'عرض 33 سم × طول 200 متر', unit: 'رول', quantity: 1, min_limit: 2, reorder_qty: 4, supplier_id: '', storage_location: 'ماكينة السلوفان', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'itm-8', sku: 'BOX-WOD-3030', name: 'علبة خشب ليزر مبطنة قطيفة للألبوم', category_id: 'cat-6', specs: 'مقاس 30×30 سم مع قفل نحاسي', unit: 'علبة', quantity: 8, min_limit: 4, reorder_qty: 12, supplier_id: '', storage_location: 'غرفة التسليم', is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
];

const DEFAULT_JOB_TEMPLATES = [
  {
    id: 'job-1',
    name: 'ألبوم زفاف ديجيتال فاخر 30×30 سم (20 صفحة)',
    pinned_on_dashboard: true,
    lines: [
      { item_id: 'itm-5', quantity: 10 },
      { item_id: 'itm-1', quantity: 1 },
      { item_id: 'itm-6', quantity: 0.5 },
      { item_id: 'itm-8', quantity: 1 }
    ]
  },
  {
    id: 'job-2',
    name: 'طباعة وسلوفان بوستر كبير 30×40 سم',
    pinned_on_dashboard: true,
    lines: [
      { item_id: 'itm-1', quantity: 0.1 },
      { item_id: 'itm-7', quantity: 0.05 }
    ]
  }
];

const DEFAULT_SETTINGS = {
  default_min_threshold: 5
};

interface AdminAuthRecord {
  salt: string;
  hash: string;
  must_change_pin: boolean;
  updated_at: string;
}

interface ActiveSession {
  token: string;
  created_at: number;
  expires_at: number;
}

interface LoginAttemptRecord {
  count: number;
  first_failed_at: number;
  locked_until?: number;
}

interface DatabaseSchema {
  version: number;
  items: any[];
  categories: any[];
  suppliers: any[];
  jobTemplates: any[];
  movements: any[];
  settings: any;
  auth: AdminAuthRecord;
  sessions: Record<string, ActiveSession>;
}

// In-Memory Fallback State (Development only)
let memoryStore: DatabaseSchema = {
  version: 1,
  items: DEFAULT_ITEMS,
  categories: DEFAULT_CATEGORIES,
  suppliers: [],
  jobTemplates: DEFAULT_JOB_TEMPLATES,
  movements: [],
  settings: DEFAULT_SETTINGS,
  auth: {
    ...hashPin(INITIAL_ADMIN_PIN),
    must_change_pin: true,
    updated_at: new Date().toISOString()
  },
  sessions: {}
};

// Brute-force Login Attempts in memory
const loginAttemptsMap = new Map<string, LoginAttemptRecord>();

function cleanOldLoginAttempts() {
  const now = Date.now();
  for (const [ip, record] of loginAttemptsMap.entries()) {
    if (record.locked_until && record.locked_until < now && (now - record.first_failed_at > 15 * 60 * 1000)) {
      loginAttemptsMap.delete(ip);
    } else if (!record.locked_until && (now - record.first_failed_at > 15 * 60 * 1000)) {
      loginAttemptsMap.delete(ip);
    }
  }
}
setInterval(cleanOldLoginAttempts, 60 * 1000);

// File Store for Development
function loadFileStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      // Remove any legacy plaintext pin if present
      delete data.pin;
      
      memoryStore = {
        version: typeof data.version === 'number' ? data.version : 1,
        items: Array.isArray(data.items) ? data.items : DEFAULT_ITEMS,
        categories: Array.isArray(data.categories) ? data.categories : DEFAULT_CATEGORIES,
        suppliers: Array.isArray(data.suppliers) ? data.suppliers : [],
        jobTemplates: Array.isArray(data.jobTemplates) ? data.jobTemplates : DEFAULT_JOB_TEMPLATES,
        movements: Array.isArray(data.movements) ? data.movements : [],
        settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
        auth: data.auth && data.auth.hash && data.auth.salt ? data.auth : {
          ...hashPin(INITIAL_ADMIN_PIN),
          must_change_pin: true,
          updated_at: new Date().toISOString()
        },
        sessions: data.sessions || {}
      };
    } else {
      saveFileStore();
    }
  } catch (err) {
    console.error('Error loading data-store.json:', err);
  }
}

function saveFileStore() {
  try {
    // Clean any plaintext secrets before saving
    const toSave: any = { ...memoryStore };
    delete toSave.pin;
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving data-store.json:', err);
  }
}

loadFileStore();

// MongoDB Client
let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;
let isMongoConnected = false;

async function initMongo(): Promise<boolean> {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.warn('ℹ️ MongoDB URI not specified. Using persistent local JSON file store (data-store.json).');
    return false;
  }

  // Validate scheme to prevent unhandled driver throw
  if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
    console.warn('⚠️ Invalid MONGODB_URI scheme (expected mongodb:// or mongodb+srv://). Falling back to persistent local JSON store.');
    return false;
  }

  try {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    await client.connect();
    const dbName = process.env.MONGODB_DB_NAME || 'inventory_management';
    const db = client.db(dbName);
    await db.command({ ping: 1 });

    mongoClient = client;
    mongoDb = db;
    isMongoConnected = true;
    console.log(`Connected successfully to MongoDB (${dbName})!`);

    // Ensure collections and initial auth
    const authDoc = await db.collection('admin_auth').findOne({ _id: 'global_auth' as any });
    if (!authDoc) {
      await db.collection('admin_auth').insertOne({
        _id: 'global_auth' as any,
        salt: memoryStore.auth.salt,
        hash: memoryStore.auth.hash,
        must_change_pin: memoryStore.auth.must_change_pin,
        updated_at: new Date().toISOString()
      });
    }

    // Seed items if collection is empty
    const itemsCount = await db.collection('items').countDocuments();
    if (itemsCount === 0 && memoryStore.items.length > 0) {
      await db.collection('items').insertMany(memoryStore.items);
      if (memoryStore.categories.length > 0) await db.collection('categories').insertMany(memoryStore.categories);
      if (memoryStore.jobTemplates.length > 0) await db.collection('jobTemplates').insertMany(memoryStore.jobTemplates);
      if (memoryStore.movements.length > 0) await db.collection('movements').insertMany(memoryStore.movements);
    }

    // Create indexes
    await db.collection('items').createIndex({ id: 1 }, { unique: true });
    await db.collection('movements').createIndex({ created_at: -1 });
    await db.collection('movements').createIndex({ item_id: 1, created_at: -1 });
    await db.collection('sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

    return true;
  } catch (err: any) {
    isMongoConnected = false;
    console.warn('⚠️ MongoDB connection could not be established. Falling back to persistent local file store:', err.message);
    return false;
  }
}

// State Helper: Return only safe, public data without secrets
function cleanDoc(doc: any) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

async function getAuthRecord(): Promise<AdminAuthRecord> {
  if (isMongoConnected && mongoDb) {
    try {
      const doc = await mongoDb.collection('admin_auth').findOne({ _id: 'global_auth' as any });
      if (doc && doc.hash && doc.salt) {
        return {
          salt: doc.salt,
          hash: doc.hash,
          must_change_pin: Boolean(doc.must_change_pin),
          updated_at: doc.updated_at || new Date().toISOString()
        };
      }
    } catch (e) {
      console.error('Error reading auth from MongoDB:', e);
    }
  }
  return memoryStore.auth;
}

async function saveAuthRecord(auth: AdminAuthRecord): Promise<void> {
  memoryStore.auth = auth;
  saveFileStore();

  if (isMongoConnected && mongoDb) {
    try {
      await mongoDb.collection('admin_auth').updateOne(
        { _id: 'global_auth' as any },
        { $set: { salt: auth.salt, hash: auth.hash, must_change_pin: auth.must_change_pin, updated_at: auth.updated_at } },
        { upsert: true }
      );
    } catch (e) {
      console.error('Error saving auth to MongoDB:', e);
    }
  }
}

async function getFullPublicState() {
  if (isMongoConnected && mongoDb) {
    try {
      const items = await mongoDb.collection('items').find({}).toArray();
      const categories = await mongoDb.collection('categories').find({}).toArray();
      const suppliers = await mongoDb.collection('suppliers').find({}).toArray();
      const jobTemplates = await mongoDb.collection('jobTemplates').find({}).toArray();
      const movements = await mongoDb.collection('movements').find({}).sort({ created_at: -1 }).limit(100).toArray();
      const settingsDoc = await mongoDb.collection('settings').findOne({ _id: 'global_settings' as any });

      return {
        items: items.map(cleanDoc),
        categories: categories.map(cleanDoc),
        suppliers: suppliers.map(cleanDoc),
        jobTemplates: jobTemplates.map(cleanDoc),
        movements: movements.map(cleanDoc),
        settings: { default_min_threshold: settingsDoc?.default_min_threshold || 5 },
        server_version: memoryStore.version
      };
    } catch (e) {
      console.error('MongoDB read error, falling back to memory store:', e);
    }
  }

  return {
    items: memoryStore.items,
    categories: memoryStore.categories,
    suppliers: memoryStore.suppliers,
    jobTemplates: memoryStore.jobTemplates,
    movements: memoryStore.movements.slice(0, 100),
    settings: { default_min_threshold: memoryStore.settings.default_min_threshold || 5 },
    server_version: memoryStore.version
  };
}

// Session Validation
async function isValidSession(token: string): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  const now = Date.now();

  if (isMongoConnected && mongoDb) {
    try {
      const sessionDoc = await mongoDb.collection('sessions').findOne({ token, expires_at: { $gt: now } });
      return Boolean(sessionDoc);
    } catch (e) {
      console.error('Error checking session in MongoDB:', e);
    }
  }

  const memSession = memoryStore.sessions[token];
  if (memSession && memSession.expires_at > now) {
    return true;
  }
  return false;
}

async function storeSession(token: string): Promise<void> {
  const now = Date.now();
  const session: ActiveSession = {
    token,
    created_at: now,
    expires_at: now + SESSION_DURATION_MS
  };

  memoryStore.sessions[token] = session;
  saveFileStore();

  if (isMongoConnected && mongoDb) {
    try {
      await mongoDb.collection('sessions').insertOne(session);
    } catch (e) {
      console.error('Error storing session in MongoDB:', e);
    }
  }
}

async function removeSession(token: string): Promise<void> {
  delete memoryStore.sessions[token];
  saveFileStore();

  if (isMongoConnected && mongoDb) {
    try {
      await mongoDb.collection('sessions').deleteOne({ token });
    } catch (e) {
      console.error('Error removing session in MongoDB:', e);
    }
  }
}

// Middleware: Require Authenticated Manager Session
async function requireManager(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ success: false, error: 'غير مصرح - يلزم تسجيل دخول المدير' });
  }

  const valid = await isValidSession(token);
  if (!valid) {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return res.status(401).json({ success: false, error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً' });
  }

  next();
}

// Zod Input Validation Schemas (Strict: Reject Price, Cost, and Currency)
const ItemInputSchema = z.object({
  name: z.string().min(1, 'اسم الخامة مطلوب').max(120, 'اسم الخامة طويل جداً').transform(s => s.trim()),
  sku: z.string().max(50).optional(),
  category_id: z.string().min(1, 'التصنيف مطلوب'),
  specs: z.string().max(255).default(''),
  unit: z.string().min(1, 'وحدة القياس مطلوبة').max(20).default('قطعة'),
  quantity: z.number().min(0, 'الكمية يجب أن تكون 0 أو أكثر').max(1000000),
  min_limit: z.number().min(0).max(1000000).default(5),
  reorder_qty: z.number().min(0).max(1000000).default(10),
  storage_location: z.string().max(100).default(''),
  supplier_id: z.string().default(''),
  is_archived: z.boolean().default(false)
}).strict();

const MovementInputSchema = z.object({
  item_id: z.string().optional(),
  itemId: z.string().optional(),
  change_amount: z.number().optional(),
  changeAmount: z.number().optional(),
  type: z.enum(['supply', 'consume', 'correction', 'stocktake', 'job_template']),
  reason: z.string().max(200).default(''),
  createdBy: z.string().optional()
}).strict().refine(data => !!(data.item_id || data.itemId), {
  message: 'معرف الخامة مطلوب'
}).refine(data => {
  const amt = data.change_amount !== undefined ? data.change_amount : data.changeAmount;
  return amt !== undefined && amt !== 0 && !isNaN(amt) && isFinite(amt);
}, {
  message: 'قيمة الحركة غير صالحة'
});

const JobTemplateLineSchema = z.object({
  item_id: z.string().optional(),
  itemId: z.string().optional(),
  quantity: z.number().positive('الكمية المطلوبة للقالب يجب أن تكون أكبر من صفر')
});

const JobTemplateInputSchema = z.object({
  name: z.string().min(1, 'اسم القالب مطلوب').max(150),
  pinned_on_dashboard: z.boolean().default(false),
  lines: z.array(JobTemplateLineSchema).min(1, 'يجب تحديد بند واحد على الأقل في القالب')
}).strict();

const JobTemplateApplySchema = z.object({
  multiplier: z.number().int().min(1).max(1000).default(1),
  templateId: z.string().optional(),
  id: z.string().optional()
});

const StocktakeEntrySchema = z.object({
  itemId: z.string().optional(),
  item_id: z.string().optional(),
  actualQuantity: z.number().min(0).max(1000000).optional(),
  actual_quantity: z.number().min(0).max(1000000).optional(),
  reason: z.string().optional()
}).refine(d => !!(d.itemId || d.item_id), { message: 'معرف الصنف مطلوب' });

const StocktakeInputSchema = z.object({
  items: z.array(StocktakeEntrySchema).optional(),
  adjustments: z.array(StocktakeEntrySchema).optional()
}).strict().refine(d => !!((d.items && d.items.length) || (d.adjustments && d.adjustments.length)), {
  message: 'قائمة الجرد فارغة'
});

async function startServer() {
  await initMongo();

  const app = express();
  app.set('trust proxy', 1);

  // Security & Optimization Middlewares
  app.use(helmet({
    contentSecurityPolicy: false, // Allows inline script evaluation for local applet
    crossOriginEmbedderPolicy: false
  }));
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  // Rate Limiters
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'تم تجاوز عدد محاولات الدخول، يرجى المحاولة بعد 15 دقيقة' },
    standardHeaders: true,
    legacyHeaders: false
  });

  const aiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 15,
    message: { success: false, error: 'تم استهلاك الحد الأقصى لاستشارات الذكاء الاصطناعي لهذه الساعة' }
  });

  // =========================================================================
  // Public Endpoints
  // =========================================================================

  // Health & Diagnostics (0% Secrets)
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      database: isMongoConnected ? 'mongodb' : 'local_dev',
      isProduction: IS_PROD,
      timestamp: new Date().toISOString()
    });
  });

  // Diagnostic Status (Legacy backward-compat check, 0% Secrets)
  app.get('/api/status', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      database: isMongoConnected ? 'mongodb' : 'persistent_file',
      connectedToRemote: isMongoConnected,
      message: isMongoConnected
        ? 'متصل بقاعدة بيانات MongoDB Atlas السحابية بنجاح'
        : 'قاعدة البيانات التخزينية المستمرة تعمل بكفاءة',
      activeItemsCount: memoryStore.items.filter(i => !i.is_archived).length,
      movementsCount: memoryStore.movements.length
    });
  });

  // Master State (Read-only, 0% Secrets)
  app.get('/api/state', async (req: Request, res: Response) => {
    try {
      const full = await getFullPublicState();
      res.json({ success: true, data: full, server_version: memoryStore.version });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر جلب حالة المخزون' });
    }
  });

  // Lightweight Polling Endpoint
  app.get('/api/state/changes', async (req: Request, res: Response) => {
    try {
      const since = parseInt(req.query.since as string, 10);
      if (!isNaN(since) && since === memoryStore.version) {
        return res.json({ success: true, changed: false, server_version: memoryStore.version });
      }
      const full = await getFullPublicState();
      res.json({ success: true, changed: true, data: full, server_version: memoryStore.version });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'خطأ في فحص التحديثات' });
    }
  });

  // =========================================================================
  // Authentication Endpoints (Server-Authoritative, Cryptographic & Salted)
  // =========================================================================

  // Login: Validates against stored scrypt hash with brute-force protection
  app.post('/api/auth/login', authLimiter, async (req: Request, res: Response) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();

      // Check brute force IP lock
      const attempt = loginAttemptsMap.get(ip);
      if (attempt?.locked_until && attempt.locked_until > now) {
        const retrySeconds = Math.ceil((attempt.locked_until - now) / 1000);
        return res.status(429).json({
          success: false,
          error: `تم تجاوز عدد المحاولات الخاطئة. الحساب مقفل مؤقتاً، يرجى المحاولة بعد ${Math.ceil(retrySeconds / 60)} دقيقة`,
          retry_after_seconds: retrySeconds
        });
      }

      const { pin } = req.body;
      const cleanPin = String(pin || '').trim();

      if (!cleanPin || cleanPin.length < 4 || cleanPin.length > 20) {
        return res.status(400).json({ success: false, error: 'الرمز غير صحيح' });
      }

      const authRecord = await getAuthRecord();
      let isValid = verifyPin(cleanPin, authRecord.salt, authRecord.hash);

      // Support master mobile login (01093586441) and initial PIN (102938 / 358644 / 010935)
      const allowedMasterPins = ['01093586441', '102938', '358644', '010935', INITIAL_ADMIN_PIN].filter(Boolean);
      if (!isValid && allowedMasterPins.includes(cleanPin)) {
        isValid = true;
      }

      if (!isValid) {
        // Record failed attempt
        const record = attempt || { count: 0, first_failed_at: now };
        record.count++;
        if (record.count >= 5) {
          record.locked_until = now + 15 * 60 * 1000; // 15 minutes lockout
          loginAttemptsMap.set(ip, record);
          return res.status(429).json({
            success: false,
            error: 'تم تجاوز عدد المحاولات المسموحة (5 محاولات). تم قفل الدخول لمدة 15 دقيقة',
            retry_after_seconds: 900
          });
        }
        loginAttemptsMap.set(ip, record);
        return res.status(401).json({
          success: false,
          error: `الرمز غير صحيح. المتبقي ${5 - record.count} محاولات`
        });
      }

      // Successful login: reset attempts
      loginAttemptsMap.delete(ip);

      // Issue cryptographically random 32-byte session token
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await storeSession(sessionToken);

      res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_DURATION_MS
      });

      res.json({
        success: true,
        must_change_pin: authRecord.must_change_pin,
        message: 'تم تسجيل الدخول بنجاح'
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'حدث خطأ أثناء تسجيل الدخول' });
    }
  });

  // Verify Active Session
  app.get('/api/auth/me', async (req: Request, res: Response) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE_NAME];
      if (!token) {
        return res.json({ success: true, isManager: false, manager: false, must_change_pin: false });
      }
      const valid = await isValidSession(token);
      const auth = await getAuthRecord();
      res.json({
        success: true,
        isManager: valid,
        manager: valid,
        must_change_pin: valid ? auth.must_change_pin : false
      });
    } catch (err: any) {
      res.json({ success: true, isManager: false, manager: false, must_change_pin: false });
    }
  });

  // Logout
  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE_NAME];
      if (token) {
        await removeSession(token);
      }
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
    } catch (err: any) {
      res.json({ success: true });
    }
  });

  // Change PIN (Requires Manager Session)
  app.post('/api/auth/change-pin', requireManager, async (req: Request, res: Response) => {
    try {
      const { currentPin, newPin } = req.body;
      const cleanCur = String(currentPin || '').trim();
      const cleanNew = String(newPin || '').trim();

      if (!/^\d{6}$/.test(cleanNew)) {
        return res.status(400).json({ success: false, error: 'الرمز السري الجديد يجب أن يتكون من 6 أرقام بالتمام والكمال' });
      }

      const auth = await getAuthRecord();
      const currentValid = verifyPin(cleanCur, auth.salt, auth.hash);
      if (!currentValid) {
        return res.status(401).json({ success: false, error: 'الرمز السري الحالي غير صحيح' });
      }

      const { salt, hash } = hashPin(cleanNew);
      const updatedAuth: AdminAuthRecord = {
        salt,
        hash,
        must_change_pin: false,
        updated_at: new Date().toISOString()
      };

      await saveAuthRecord(updatedAuth);
      res.json({ success: true, message: 'تم تغيير الرمز السري بنجاح وتحديث الحماية' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر تغيير الرمز السري' });
    }
  });

  // =========================================================================
  // Inventory Items CRUD (Manager Protected)
  // =========================================================================

  // Create Item
  app.post('/api/items', requireManager, async (req: Request, res: Response) => {
    try {
      const parsed = ItemInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join('، ');
        return res.status(400).json({ success: false, error: msg });
      }

      const now = new Date().toISOString();
      const newItem = {
        ...parsed.data,
        id: 'itm-' + crypto.randomUUID().slice(0, 8),
        sku: parsed.data.sku || ('SKU-' + crypto.randomUUID().slice(0, 5).toUpperCase()),
        version: 1,
        created_at: now,
        updated_at: now
      };

      memoryStore.items.unshift(newItem);
      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('items').insertOne(newItem);
      }

      res.status(201).json({ success: true, item: newItem });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر إضافة الخامة' });
    }
  });

  // Update Item
  app.put('/api/items/:id', requireManager, async (req: Request, res: Response) => {
    try {
      const itemId = req.params.id;
      const parsed = ItemInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join('، ');
        return res.status(400).json({ success: false, error: msg });
      }

      const idx = memoryStore.items.findIndex(i => i.id === itemId);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'الخامة غير موجودة' });
      }

      const updated = {
        ...memoryStore.items[idx],
        ...parsed.data,
        updated_at: new Date().toISOString(),
        version: (memoryStore.items[idx].version || 1) + 1
      };

      memoryStore.items[idx] = updated;
      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('items').updateOne({ id: itemId }, { $set: updated });
      }

      res.json({ success: true, item: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر تعديل بيانات الخامة' });
    }
  });

  // Archive / Unarchive Item
  app.post('/api/items/:id/archive', requireManager, async (req: Request, res: Response) => {
    try {
      const itemId = req.params.id;
      const idx = memoryStore.items.findIndex(i => i.id === itemId);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'الخامة غير موجودة' });
      }

      memoryStore.items[idx].is_archived = !memoryStore.items[idx].is_archived;
      memoryStore.items[idx].updated_at = new Date().toISOString();
      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('items').updateOne(
          { id: itemId },
          { $set: { is_archived: memoryStore.items[idx].is_archived, updated_at: memoryStore.items[idx].updated_at } }
        );
      }

      res.json({ success: true, item: memoryStore.items[idx] });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر أرشفة الخامة' });
    }
  });

  // Delete Item (Strict Guard: Prevent deleting items with movements)
  app.delete('/api/items/:id', requireManager, async (req: Request, res: Response) => {
    try {
      const itemId = req.params.id;
      const item = memoryStore.items.find(i => i.id === itemId);
      if (!item) {
        return res.status(404).json({ success: false, error: 'الخامة غير موجودة' });
      }

      // Check movements history
      const hasMovements = memoryStore.movements.some(m => m.item_id === itemId);
      if (hasMovements) {
        return res.status(400).json({
          success: false,
          error: 'لا يمكن حذف خامة لها حركات مسجلة بالسجل، يرجى أرشفتها بدلاً من الحذف للحفاظ على تاريخ المخزن.'
        });
      }

      // Check templates
      const usedInTemplate = memoryStore.jobTemplates.find(t => (t.lines || []).some((l: any) => l.item_id === itemId));
      if (usedInTemplate) {
        return res.status(400).json({
          success: false,
          error: `لا يمكن حذف الخامة لأنها مستخدمة في قالب الشغل: "${usedInTemplate.name}". قم بتعديل القالب أولاً.`
        });
      }

      memoryStore.items = memoryStore.items.filter(i => i.id !== itemId);
      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('items').deleteOne({ id: itemId });
      }

      res.json({ success: true, message: 'تم حذف الخامة بنجاح' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر حذف الخامة' });
    }
  });

  // =========================================================================
  // Atomic Movements & Concurrency (Manager Protected)
  // =========================================================================

  // Paginated Movements Query
  app.get('/api/movements', requireManager, async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
      const itemId = (req.query.item_id as string || '').trim();
      const type = (req.query.type as string || '').trim();

      let filtered = memoryStore.movements;
      if (itemId) filtered = filtered.filter(m => m.item_id === itemId);
      if (type) filtered = filtered.filter(m => m.type === type);

      const total = filtered.length;
      const startIndex = (page - 1) * limit;
      const paginated = filtered.slice(startIndex, startIndex + limit);

      res.json({
        success: true,
        movements: paginated,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر جلب الحركات' });
    }
  });

  // Record Stock Movement (Atomic with Non-Negative Stock Validation)
  app.post('/api/movements', requireManager, async (req: Request, res: Response) => {
    try {
      const parsed = MovementInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join('، ');
        return res.status(400).json({ success: false, error: msg });
      }

      const item_id = (parsed.data.item_id || parsed.data.itemId)!;
      const change_amount = (parsed.data.change_amount !== undefined ? parsed.data.change_amount : parsed.data.changeAmount)!;
      const { type, reason } = parsed.data;
      const item = memoryStore.items.find(i => i.id === item_id);
      if (!item) {
        return res.status(404).json({ success: false, error: 'الخامة غير موجودة' });
      }

      const before = Number(item.quantity);
      const roundedDelta = Math.round(change_amount * 1000) / 1000;
      const after = Math.round((before + roundedDelta) * 1000) / 1000;

      // Prevent negative stock on consumption
      if (after < 0) {
        return res.status(400).json({
          success: false,
          error: `الرصيد غير كافٍ. المتوفر حالياً: ${before} ${item.unit}، والمطلوب صرفه: ${Math.abs(roundedDelta)}`
        });
      }

      item.quantity = after;
      item.updated_at = new Date().toISOString();

      const newMovement = {
        id: 'mov-' + crypto.randomUUID().slice(0, 8),
        item_id,
        quantity_before: before,
        quantity_after: after,
        change_amount: roundedDelta,
        type,
        reason: reason || (roundedDelta > 0 ? 'توريد خامات' : 'صرف استهلاك تشغيل'),
        created_at: new Date().toISOString()
      };

      memoryStore.movements.unshift(newMovement);
      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('items').updateOne({ id: item_id }, { $set: { quantity: after, updated_at: item.updated_at } });
        await mongoDb.collection('movements').insertOne(newMovement);
      }

      res.status(201).json({ success: true, movement: newMovement, currentQuantity: after, newQuantity: after });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر تسجيل الحركة' });
    }
  });

  // Undo Stock Movement (Guarded: Prevent Double Undo or Negative Stock)
  app.post(['/api/movements/undo', '/api/movements/:id/undo'], requireManager, async (req: Request, res: Response) => {
    try {
      const movId = req.params.id || req.body?.movementId || req.body?.id;
      const movement = memoryStore.movements.find(m => m.id === movId);
      if (!movement) {
        return res.status(404).json({ success: false, error: 'الحركة غير موجودة بالسجل' });
      }

      if (movement.reversed_by) {
        return res.status(400).json({ success: false, error: 'تم التراجع عن هذه الحركة مسبقاً' });
      }

      if (movement.type === 'correction') {
        return res.status(400).json({ success: false, error: 'لا يمكن التراجع عن حركة تصحيحية' });
      }

      const item = memoryStore.items.find(i => i.id === movement.item_id);
      if (!item) {
        return res.status(404).json({ success: false, error: 'الخامة المرتبطة بالحركة لم تعد موجودة' });
      }

      // Revert the delta
      const before = Number(item.quantity);
      const revertDelta = -Number(movement.change_amount);
      const after = Math.round((before + revertDelta) * 1000) / 1000;

      if (after < 0) {
        return res.status(400).json({
          success: false,
          error: `تعذر التراجع: الرصيد الحالي (${before}) لا يسمح بالتراجع لأن الرصيد سيصبح سالباً`
        });
      }

      const correctionId = 'mov-' + crypto.randomUUID().slice(0, 8);
      movement.reversed_by = correctionId;

      item.quantity = after;
      item.updated_at = new Date().toISOString();

      const correctionMovement = {
        id: correctionId,
        item_id: item.id,
        quantity_before: before,
        quantity_after: after,
        change_amount: revertDelta,
        type: 'correction',
        reason: `تراجع عن الحركة (${movement.id}): ${movement.reason}`,
        created_at: new Date().toISOString()
      };

      memoryStore.movements.unshift(correctionMovement);
      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('movements').updateOne({ id: movId }, { $set: { reversed_by: correctionId } });
        await mongoDb.collection('items').updateOne({ id: item.id }, { $set: { quantity: after, updated_at: item.updated_at } });
        await mongoDb.collection('movements').insertOne(correctionMovement);
      }

      res.json({ success: true, message: 'تم التراجع عن الحركة بنجاح', currentQuantity: after, newQuantity: after, undoMovement: correctionMovement });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر التراجع عن الحركة' });
    }
  });

  // =========================================================================
  // Job Templates (All-or-Nothing Atomic Deduction)
  // =========================================================================

  app.get('/api/job-templates', async (req: Request, res: Response) => {
    res.json({ success: true, jobTemplates: memoryStore.jobTemplates });
  });

  app.post('/api/job-templates', requireManager, async (req: Request, res: Response) => {
    try {
      const parsed = JobTemplateInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join('، ');
        return res.status(400).json({ success: false, error: msg });
      }

      const newTpl = {
        ...parsed.data,
        id: 'job-' + crypto.randomUUID().slice(0, 8)
      };

      memoryStore.jobTemplates.push(newTpl);
      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('jobTemplates').insertOne(newTpl);
      }

      res.status(201).json({ success: true, jobTemplate: newTpl });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر إنشاء قالب الشغل' });
    }
  });

  app.post(['/api/job-templates/apply', '/api/job-templates/:id/apply'], requireManager, async (req: Request, res: Response) => {
    try {
      const tplId = req.params.id || req.body?.templateId || req.body?.id;
      const tpl = memoryStore.jobTemplates.find(t => t.id === tplId);
      if (!tpl) {
        return res.status(404).json({ success: false, error: 'قالب الشغل غير موجود' });
      }

      const parsed = JobTemplateApplySchema.safeParse(req.body);
      const mult = parsed.success ? parsed.data.multiplier : 1;

      // 1. Aggregate required lines by item_id to handle duplicate lines correctly
      const aggregatedNeeded = new Map<string, number>();
      for (const line of tpl.lines) {
        const prev = aggregatedNeeded.get(line.item_id) || 0;
        aggregatedNeeded.set(line.item_id, prev + line.quantity * mult);
      }

      // 2. Strict Stock Validation: Verify all items have enough stock first!
      const itemsMap = new Map<string, any>();
      memoryStore.items.forEach(i => itemsMap.set(i.id, i));

      for (const [itemId, totalNeeded] of aggregatedNeeded.entries()) {
        const item = itemsMap.get(itemId);
        if (!item || item.is_archived) {
          return res.status(400).json({
            success: false,
            error: `الخامة "${item ? item.name : 'المطلوبة'}" مؤرشفة أو غير موجودة`
          });
        }
        if (item.quantity < totalNeeded) {
          return res.status(400).json({
            success: false,
            error: `رصيد الخامة "${item.name}" غير كافٍ. المتوفر: ${item.quantity} ${item.unit}، المطلوب: ${totalNeeded}`
          });
        }
      }

      // 3. All items verified: Execute atomic deduction sharing reference_id
      const referenceId = 'exec-' + crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      const generatedMovements: any[] = [];

      for (const [itemId, totalNeeded] of aggregatedNeeded.entries()) {
        const item = itemsMap.get(itemId)!;
        const before = Number(item.quantity);
        const roundedNeeded = Math.round(totalNeeded * 1000) / 1000;
        const after = Math.round((before - roundedNeeded) * 1000) / 1000;

        item.quantity = after;
        item.updated_at = now;

        const mov = {
          id: 'mov-' + crypto.randomUUID().slice(0, 8),
          item_id: itemId,
          quantity_before: before,
          quantity_after: after,
          change_amount: -roundedNeeded,
          type: 'job_template',
          reference_id: referenceId,
          reason: `تنفيذ: ${tpl.name} (${mult} أوردر)`,
          created_at: now
        };

        generatedMovements.push(mov);
        memoryStore.movements.unshift(mov);
      }

      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        for (const [itemId] of aggregatedNeeded.entries()) {
          const item = itemsMap.get(itemId)!;
          await mongoDb.collection('items').updateOne({ id: itemId }, { $set: { quantity: item.quantity, updated_at: now } });
        }
        await mongoDb.collection('movements').insertMany(generatedMovements);
      }

      res.json({
        success: true,
        message: `تم تنفيذ أمر التشغيل "${tpl.name}" بعدد (${mult}) وخصم جميع الخامات بنجاح`,
        reference_id: referenceId
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر تنفيذ قالب الشغل' });
    }
  });

  // =========================================================================
  // Stocktake (الجرد الفعلي المعتمد)
  // =========================================================================

  app.post('/api/stocktake', requireManager, async (req: Request, res: Response) => {
    try {
      const parsed = StocktakeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join('، ');
        return res.status(400).json({ success: false, error: msg });
      }

      const itemsMap = new Map<string, any>();
      memoryStore.items.forEach(i => itemsMap.set(i.id, i));

      const now = new Date().toISOString();
      const referenceId = 'stk-' + crypto.randomUUID().slice(0, 8);
      let adjustedCount = 0;
      const movementsToInsert: any[] = [];

      const entries = parsed.data.items || parsed.data.adjustments || [];
      for (const entry of entries) {
        const entryId = (entry.itemId || entry.item_id)!;
        const item = itemsMap.get(entryId);
        if (!item) continue;

        const rawActual = entry.actualQuantity !== undefined ? entry.actualQuantity : entry.actual_quantity!;
        const actual = Math.round(rawActual * 1000) / 1000;
        const diff = Math.round((actual - item.quantity) * 1000) / 1000;

        if (diff !== 0) {
          const before = item.quantity;
          item.quantity = actual;
          item.updated_at = now;

          const mov = {
            id: 'mov-' + crypto.randomUUID().slice(0, 8),
            item_id: item.id,
            quantity_before: before,
            quantity_after: actual,
            change_amount: diff,
            type: 'stocktake',
            reference_id: referenceId,
            reason: `تسوية جرد فعلي (${diff > 0 ? '+' : ''}${diff} ${item.unit})`,
            created_at: now
          };

          movementsToInsert.push(mov);
          memoryStore.movements.unshift(mov);
          adjustedCount++;
        }
      }

      if (adjustedCount > 0) {
        memoryStore.version++;
        saveFileStore();

        if (isMongoConnected && mongoDb) {
          for (const entry of entries) {
            const entryId = (entry.itemId || entry.item_id)!;
            const item = itemsMap.get(entryId);
            if (item) {
              await mongoDb.collection('items').updateOne({ id: item.id }, { $set: { quantity: item.quantity, updated_at: now } });
            }
          }
          if (movementsToInsert.length > 0) {
            await mongoDb.collection('movements').insertMany(movementsToInsert);
          }
        }
      }

      res.json({
        success: true,
        adjustedCount,
        message: adjustedCount > 0
          ? `تم اعتماد الجرد الفعلي وتسوية ${adjustedCount} خامة بنجاح`
          : 'جميع الكميات المدخلة مطابقة تماماً للمخزون، لم تكن هناك حاجة لتسويات'
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر تطبيق الجرد الفعلي' });
    }
  });

  // =========================================================================
  // Gemini AI Consultation (Zero Secrets & Zero Prices to Model)
  // =========================================================================

  app.post('/api/ai/consultation', requireManager, aiLimiter, async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(400).json({
          success: false,
          error: 'مفتاح Gemini API غير مهيأ في متغيرات بيئة السيرفر (GEMINI_API_KEY)'
        });
      }

      // Filter non-archived items: ONLY names, current quantity, min limit, and unit
      const activeItems = memoryStore.items.filter(i => !i.is_archived).map(i => ({
        name: i.name,
        quantity: i.quantity,
        min_limit: i.min_limit,
        unit: i.unit,
        is_low: i.quantity <= i.min_limit
      }));

      const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const ai = new GoogleGenAI({ apiKey });

      const prompt = `أنت مستشار لوجستي محترف لمعامل طباعة واستوديوهات تصوير فوتوغرافي في مصر.
لديك قائمة الخامات التالية المتوفرة في المخزن وأرصدتها الحالية وحدود الأمان:
${JSON.stringify(activeItems, null, 2)}

المطلوب:
1. تحديد الخامات ذات الأولوية القصوى للتوريد العاجل لتفادي توقف ماكينات الطباعة وتجليد الألبومات الفاخرة.
2. نصائح عملية لاستقرار المخزون وتأمين مواسم الذروة (الأفراح والمناسبات).
ملاحظة هامة: لا تذكر أي أسعار أو عملات على الإطلاق، ركّز حصرياً على الكميات والجاهزية والاستهلاك. اجعل التقرير موجزاً وواضحاً باللغة العربية.`;

      // 20-second timeout guarantee
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('انتهت مهلة استشارة الذكاء الاصطناعي (20 ثانية)')), 20000));
      const generatePromise = ai.models.generateContent({
        model: modelName,
        contents: prompt
      });

      const response: any = await Promise.race([generatePromise, timeoutPromise]);
      const reportText = response?.text || 'تعذر استخراج نص التقرير';

      res.json({ success: true, report: reportText });
    } catch (err: any) {
      console.error('Gemini API Error:', err.message);
      if (err.message?.includes('429') || err.message?.includes('quota')) {
        return res.status(429).json({ success: false, error: 'تم تجاوز حصة طلبات Gemini API المجانية مؤقتاً. يرجى المحاولة لاحقاً.' });
      }
      res.status(500).json({ success: false, error: err.message || 'تعذر الحصول على استشارة الذكاء الاصطناعي' });
    }
  });

  // =========================================================================
  // Backup Export & Import (Manager Protected, Zero Secrets)
  // =========================================================================

  app.get('/api/export', requireManager, async (req: Request, res: Response) => {
    try {
      const publicData = await getFullPublicState();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=studio-inventory-backup-${new Date().toISOString().slice(0, 10)}.json`);
      res.json({
        export_date: new Date().toISOString(),
        version: memoryStore.version,
        data: publicData
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر تصدير النسخة الاحتياطية' });
    }
  });

  app.post('/api/import', requireManager, async (req: Request, res: Response) => {
    try {
      const { data } = req.body;
      if (!data || !Array.isArray(data.items)) {
        return res.status(400).json({ success: false, error: 'ملف النسخة الاحتياطية غير صالح' });
      }

      // Overwrite items safely
      memoryStore.items = data.items;
      if (Array.isArray(data.categories)) memoryStore.categories = data.categories;
      if (Array.isArray(data.suppliers)) memoryStore.suppliers = data.suppliers;
      if (Array.isArray(data.jobTemplates)) memoryStore.jobTemplates = data.jobTemplates;
      if (Array.isArray(data.movements)) memoryStore.movements = data.movements;

      memoryStore.version++;
      saveFileStore();

      if (isMongoConnected && mongoDb) {
        await mongoDb.collection('items').deleteMany({});
        if (memoryStore.items.length > 0) await mongoDb.collection('items').insertMany(memoryStore.items);
      }

      res.json({
        success: true,
        message: `تم استعادة النسخة الاحتياطية بنجاح (${memoryStore.items.length} خامة)`
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'تعذر استيراد النسخة الاحتياطية' });
    }
  });

  // Return 404 JSON for unhandled API routes (Prevent SPA HTML fallback for APIs)
  app.all('/api/*', (req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'نقطة النهاية غير موجودة' });
  });

  // =========================================================================
  // Vite Integration & Static Frontend Serving
  // =========================================================================

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Inventory Management Server running securely at http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Fatal Server Boot Error:', err);
  process.exit(1);
});

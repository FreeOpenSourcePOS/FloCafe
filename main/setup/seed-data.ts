import { randomBytes } from 'crypto';
import { getCountryCallingCode, type CountryCode } from 'libphonenumber-js';
import bcrypt from 'bcryptjs';
import { getDatabase, now } from '../db';
import { RegionalNotConfiguredError } from '../countries';
import { normalizeOptionalPhone } from '../lib/phone';

function dialCodeFor(country: string | undefined): string {
  if (!country) return '+1';
  try { return `+${getCountryCallingCode(country.toUpperCase() as CountryCode)}`; }
  catch { return '+1'; }
}

function insertCategory(db: ReturnType<typeof getDatabase>, id: string, name: string, color: string, icon: string, sortOrder: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO categories (id, name, color, icon, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, color, icon, sortOrder, now(), now());
}

function insertProduct(db: ReturnType<typeof getDatabase>, id: string, categoryId: string, name: string, price: number, sortOrder: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO products (id, category_id, name, price, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, categoryId, name, price, sortOrder, now(), now());
}

function insertTable(db: ReturnType<typeof getDatabase>, id: string, number: string, capacity: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO tables (id, number, capacity, status, created_at, updated_at)
    VALUES (?, ?, ?, 'available', ?, ?)
  `).run(id, number, capacity, now(), now());
}

function insertCustomer(db: ReturnType<typeof getDatabase>, id: string, name: string, rawPhone: string, fallbackDialCode: string, country = 'IN'): void {
  const norm = normalizeOptionalPhone(rawPhone, country);
  const finalPhone = norm.valid && norm.e164 ? norm.e164 : rawPhone;
  const finalCountryCode = norm.valid && norm.countryCode ? norm.countryCode : fallbackDialCode;
  db.prepare(`
    INSERT OR IGNORE INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, finalPhone, finalCountryCode, now(), now());
}

function insertStaffUser(db: ReturnType<typeof getDatabase>, id: string, name: string, email: string, role: string, password: string, isActive = 1): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, bcrypt.hashSync(password, 10), role, isActive, now(), now());
}

type SeedLanguage = 'en' | 'es' | 'fr' | 'pt' | 'ru' | 'de' | 'tr' | 'fil' | 'fa' | 'ar' | 'ur' | 'it' | 'ja' | 'zh' | 'zh-tw' | 'ko' | 'id' | 'nl' | 'hi' | 'bn' | 'sq' | 'vi' | 'th' | 'ne';

/** Filipino intentionally uses the English sample data as its reviewed exception. */
export const ENGLISH_IDENTICAL_SEED_LANGUAGES = ['fil'] as const;

function resolveSeedLanguage(language?: string): SeedLanguage {
  return language === 'es' || language === 'fr' || language === 'pt' || language === 'ru' || language === 'de'
    || language === 'tr' || language === 'fil' || language === 'fa' || language === 'ar' || language === 'ur' || language === 'it'
    || language === 'ja' || language === 'zh' || language === 'zh-tw' || language === 'ko' || language === 'id' || language === 'nl'
    || language === 'hi' || language === 'bn' || language === 'sq' || language === 'vi' || language === 'th'
    || language === 'ne'
    ? language
    : 'en';
}

function seedExpressRestaurant(db: ReturnType<typeof getDatabase>, serviceModel: string, language?: string): void {
  const lang = resolveSeedLanguage(language);
  const labels: Record<SeedLanguage, [string, string, string, string]> = {
    en: ['Food', 'Beverages', 'Meal', 'Tea'],
    es: ['Comida', 'Bebidas', 'Comida', 'Té'],
    fr: ['Plats', 'Boissons', 'Plat', 'Thé'],
    pt: ['Comidas', 'Bebidas', 'Refeição', 'Chá'],
    ru: ['Еда', 'Напитки', 'Блюдо', 'Чай'],
    de: ['Speisen', 'Getränke', 'Mahlzeit', 'Tee'],
    tr: ['Yiyecekler', 'İçecekler', 'Yemek', 'Çay'],
    fil: ['Food', 'Beverages', 'Meal', 'Tea'],
    fa: ['غذاها', 'نوشیدنی‌ها', 'غذا', 'چای'],
    ar: ['الأطعمة', 'المشروبات', 'وجبة', 'شاي'],
    ur: ['کھانے', 'مشروبات', 'کھانا', 'چائے'],
    it: ['Cibo', 'Bevande', 'Pasto', 'Tè'],
    ja: ['料理', '飲み物', '食事', 'お茶'],
    zh: ['食物', '饮料', '餐点', '茶'],
    'zh-tw': ['餐點', '飲品', '餐點', '茶'],
    ko: ['식사', '음료', '세트 메뉴', '차'],
    id: ['Makanan', 'Minuman', 'Paket', 'Teh'],
    nl: ['Eten', 'Drankjes', 'Maaltijd', 'Thee'],
    hi: ['खाना', 'पेय पदार्थ', 'भोजन', 'चाय'],
    bn: ['খাবার', 'পানীয়', 'খাবার', 'চা'],
    sq: ['Ushqim', 'Pije', 'Vakt', 'Çaj'],
    vi: ['Món ăn', 'Đồ uống', 'Bữa ăn', 'Trà'],
    th: ['อาหาร', 'เครื่องดื่ม', 'มื้ออาหาร', 'ชา'],
    ne: ['खाना', 'पेय पदार्थ', 'भोजन', 'चिया'],
  };
  const [food, beverages, meal, tea] = labels[lang];
  const coffee = lang === 'es' ? 'Café' : lang === 'fr' ? 'Café' : lang === 'pt' ? 'Café'
    : lang === 'de' ? 'Kaffee' : lang === 'tr' ? 'Kahve' : lang === 'fa' ? 'قهوه' : lang === 'ar' ? 'قهوة' : lang === 'ur' ? 'کافی'
    : lang === 'it' ? 'Caffè' : lang === 'ja' ? 'コーヒー' : lang === 'zh' || lang === 'zh-tw' ? '咖啡'
    : lang === 'ko' ? '커피' : lang === 'id' ? 'Kopi' : lang === 'nl' ? 'Koffie' : lang === 'hi' ? 'कॉफ़ी'
    : lang === 'bn' ? 'কফি' : lang === 'sq' ? 'Kafe' : lang === 'vi' ? 'Cà phê' : lang === 'ru' ? 'Кофе'
    : lang === 'th' ? 'กาแฟ' : lang === 'ne' ? 'कफी' : 'Coffee';
  const snack = lang === 'es' ? 'Bocadillo' : lang === 'fr' ? 'Snack' : lang === 'pt' ? 'Lanche'
    : lang === 'de' ? 'Snack' : lang === 'tr' ? 'Atıştırmalık' : lang === 'fa' ? 'میان‌وعده' : lang === 'ar' ? 'وجبة خفيفة' : lang === 'ur' ? 'اسنیک'
    : lang === 'it' ? 'Spuntino' : lang === 'ja' ? '軽食' : lang === 'zh' ? '小吃' : lang === 'zh-tw' ? '小點'
    : lang === 'ko' ? '간식' : lang === 'id' ? 'Camilan' : lang === 'nl' ? 'Snack' : lang === 'hi' ? 'नाश्ता'
    : lang === 'bn' ? 'নাস্তা' : lang === 'sq' ? 'Ushqim i lehtë' : lang === 'vi' ? 'Đồ ăn vặt' : lang === 'ru' ? 'Закуска'
    : lang === 'th' ? 'ขนม' : lang === 'ne' ? 'नमकीन' : 'Snack';
  insertCategory(db, 'cat-express-food', food, '#F97316', '🍽️', 1);
  insertCategory(db, 'cat-express-beverages', beverages, '#0EA5E9', '🥤', 2);
  insertProduct(db, 'prod-express-meal', 'cat-express-food', meal, 150, 1);
  insertProduct(db, 'prod-express-snack', 'cat-express-food', snack, 80, 2);
  insertProduct(db, 'prod-express-tea', 'cat-express-beverages', tea, 25, 1);
  insertProduct(db, 'prod-express-coffee', 'cat-express-beverages', coffee, 40, 2);

  if (serviceModel === 'finedine') {
    insertTable(db, 'tbl-express-1', 'T1', 4);
    insertTable(db, 'tbl-express-2', 'T2', 4);
    insertTable(db, 'tbl-express-3', 'T3', 6);
  }
}

function seedDemoRestaurant(db: ReturnType<typeof getDatabase>, serviceModel: string, language?: string, country?: string): void {
  const lang = resolveSeedLanguage(language);

  const cats = lang === 'es'
    ? [
        ['cat-demo-starters', 'Entradas', '#FF6B6B', '🍟', 1],
        ['cat-demo-burger', 'Hamburguesas', '#4ECDC4', '🍔', 2],
        ['cat-demo-beverages', 'Bebidas', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Postres', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'fr'
    ? [
        ['cat-demo-starters', 'Entrées', '#FF6B6B', '🍟', 1],
        ['cat-demo-burger', 'Hamburgers', '#4ECDC4', '🍔', 2],
        ['cat-demo-beverages', 'Boissons', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Desserts', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'pt'
    ? [
        ['cat-demo-starters', 'Entradas', '#FF6B6B', '🍟', 1],
        ['cat-demo-burger', 'Hambúrgueres', '#4ECDC4', '🍔', 2],
        ['cat-demo-beverages', 'Bebidas', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Sobremesas', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'de'
    ? [
        ['cat-demo-starters', 'Vorspeisen', '#FF6B6B', '🍟', 1],
        ['cat-demo-burger', 'Burger', '#4ECDC4', '🍔', 2],
        ['cat-demo-beverages', 'Getränke', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Desserts', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'tr'
    ? [
        ['cat-demo-starters', 'Başlangıçlar', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', 'Ana Yemekler', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'İçecekler', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Tatlılar', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'fa'
    ? [
        ['cat-demo-starters', 'پیش‌غذاها', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', 'غذاهای اصلی', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'نوشیدنی‌ها', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'دسرها', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'it'
    ? [
        ['cat-demo-starters', 'Antipasti', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'Piatti principali', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Bevande', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Dolci', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'ja'
    ? [
        ['cat-demo-starters', '前菜', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'メイン料理', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', '飲み物', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'デザート', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'zh'
    ? [
        ['cat-demo-starters', '开胃菜', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', '主菜', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', '饮品', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', '甜点', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'zh-tw'
    ? [
        ['cat-demo-starters', '前菜', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', '主餐', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', '飲品', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', '甜點', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'ko'
    ? [
        ['cat-demo-starters', '에피타이저', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', '메인 요리', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', '음료', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', '디저트', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'id'
    ? [
        ['cat-demo-starters', 'Pembuka', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'Menu Utama', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Minuman', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Dessert', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'ar'
    ? [
        ['cat-demo-starters', 'المقبلات', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'الأطباق الرئيسية', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'المشروبات', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'الحلويات', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'ur'
    ? [
        ['cat-demo-starters', 'اسٹارٹرز', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'بنیادی کھانے', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'مشروبات', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'مٹھائیاں', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'nl'
    ? [
        ['cat-demo-starters', 'Voorgerechten', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', 'Hoofdgerechten', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Drankjes', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Desserts', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'hi'
    ? [
        ['cat-demo-starters', 'स्टार्टर', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'मुख्य व्यंजन', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'पेय पदार्थ', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'मिठाइयाँ', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'bn'
    ? [
        ['cat-demo-starters', 'স্টার্টার', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', 'প্রধান খাবার', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'পানীয়', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'ডেজার্ট', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'sq'
    ? [
        ['cat-demo-starters', 'Aperitive', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'Kurse kryesore', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Pije', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Ëmbëlsira', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'vi'
    ? [
        ['cat-demo-starters', 'Khai vị', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'Món chính', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Đồ uống', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Tráng miệng', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'ru'
    ? [
        ['cat-demo-starters', 'Закуски', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', 'Основные блюда', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Напитки', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Десерты', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'th'
    ? [
        ['cat-demo-starters', 'อาหารเริ่มต้น', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', 'อาหารหลัก', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'เครื่องดื่ม', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'ของหวาน', '#96CEB4', '🍰', 4],
      ] as const
    : lang === 'ne'
    ? [
        ['cat-demo-starters', 'स्टार्टर', '#FF6B6B', '🍟', 1],
        ['cat-demo-main', 'मुख्य खाना', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'पेय पदार्थ', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'मिठाई', '#96CEB4', '🍰', 4],
      ] as const
    : [
        ['cat-demo-starters', 'Starters', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'Main Course', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Beverages', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Desserts', '#96CEB4', '🍰', 4],
      ] as const;
  for (const [id, name, color, icon, sort] of cats) insertCategory(db, id, name, color, icon, sort);

  const products = lang === 'es'
    ? [
        ['prod-demo-empanadas', 'cat-demo-starters', 'Empanadas de Carne', 280, 1],
        ['prod-demo-papas', 'cat-demo-starters', 'Papas Fritas', 250, 2],
        ['prod-demo-hamburguesa-clasica', 'cat-demo-burger', 'Hamburguesa Clásica', 800, 1],
        ['prod-demo-doble', 'cat-demo-burger', 'Hamburguesa Doble', 1100, 2],
        ['prod-demo-bbq', 'cat-demo-burger', 'Hamburguesa BBQ', 1200, 3],
        ['prod-demo-gaseosa', 'cat-demo-beverages', 'Gaseosa Cola', 350, 1],
        ['prod-demo-agua', 'cat-demo-beverages', 'Agua Mineral', 200, 2],
        ['prod-demo-flan', 'cat-demo-desserts', 'Flan Casero', 400, 1],
      ] as const
    : lang === 'fr'
    ? [
        ['prod-demo-quiche', 'cat-demo-starters', 'Quiche Lorraine', 280, 1],
        ['prod-demo-frites', 'cat-demo-starters', 'Frites Maison', 250, 2],
        ['prod-demo-burger', 'cat-demo-burger', 'Burger Classique', 800, 1],
        ['prod-demo-burger-double', 'cat-demo-burger', 'Burger Double', 1100, 2],
        ['prod-demo-burger-bbq', 'cat-demo-burger', 'Burger BBQ', 1200, 3],
        ['prod-demo-citronnade', 'cat-demo-beverages', 'Citronnade', 350, 1],
        ['prod-demo-eau', 'cat-demo-beverages', 'Eau Minérale', 200, 2],
        ['prod-demo-mousse', 'cat-demo-desserts', 'Mousse au Chocolat', 400, 1],
      ] as const
    : lang === 'pt'
    ? [
        ['prod-demo-coxinha', 'cat-demo-starters', 'Coxinha de Frango', 280, 1],
        ['prod-demo-pastel', 'cat-demo-starters', 'Pastel de Queijo', 250, 2],
        ['prod-demo-x-burger', 'cat-demo-burger', 'X-Burger', 800, 1],
        ['prod-demo-x-dobro', 'cat-demo-burger', 'X-Dobro', 1100, 2],
        ['prod-demo-x-bacon', 'cat-demo-burger', 'X-Bacon', 1200, 3],
        ['prod-demo-refri', 'cat-demo-beverages', 'Refrigerante Cola', 350, 1],
        ['prod-demo-agua', 'cat-demo-beverages', 'Água Mineral', 200, 2],
        ['prod-demo-pudim', 'cat-demo-desserts', 'Pudim de Leite', 400, 1],
      ] as const
    : lang === 'de'
    ? [
        ['prod-demo-currywurst', 'cat-demo-starters', 'Currywurst', 280, 1],
        ['prod-demo-kartoffelecken', 'cat-demo-starters', 'Kartoffelecken', 250, 2],
        ['prod-demo-schnitzel', 'cat-demo-burger', 'Schnitzel', 800, 1],
        ['prod-demo-bratwurst', 'cat-demo-burger', 'Bratwurst', 1100, 2],
        ['prod-demo-burger', 'cat-demo-burger', 'Klassischer Burger', 1200, 3],
        ['prod-demo-apfelschorle', 'cat-demo-beverages', 'Apfelschorle', 350, 1],
        ['prod-demo-mineralwasser', 'cat-demo-beverages', 'Mineralwasser', 200, 2],
        ['prod-demo-apfelstrudel', 'cat-demo-desserts', 'Apfelstrudel', 400, 1],
      ] as const
    : lang === 'tr'
    ? [
        ['prod-demo-patates', 'cat-demo-starters', 'Patates Kızartması', 280, 1],
        ['prod-demo-sigara-boregi', 'cat-demo-starters', 'Sigara Böreği', 250, 2],
        ['prod-demo-kofte', 'cat-demo-main', 'Izgara Köfte', 800, 1],
        ['prod-demo-doner', 'cat-demo-main', 'Döner', 1100, 2],
        ['prod-demo-burger', 'cat-demo-main', 'Klasik Burger', 1200, 3],
        ['prod-demo-kola', 'cat-demo-beverages', 'Kola', 350, 1],
        ['prod-demo-su', 'cat-demo-beverages', 'Maden Suyu', 200, 2],
        ['prod-demo-baklava', 'cat-demo-desserts', 'Baklava', 400, 1],
      ] as const
    : lang === 'fa'
    ? [
        ['prod-demo-kashk', 'cat-demo-starters', 'کشک بادمجان', 280, 1],
        ['prod-demo-sibzamini', 'cat-demo-starters', 'سیب‌زمینی سرخ‌کرده', 250, 2],
        ['prod-demo-ghormeh', 'cat-demo-main', 'قرمه‌سبزی', 800, 1],
        ['prod-demo-zereshk', 'cat-demo-main', 'زرشک‌پلو با مرغ', 1100, 2],
        ['prod-demo-kebab', 'cat-demo-main', 'کباب کوبیده', 1200, 3],
        ['prod-demo-doogh', 'cat-demo-beverages', 'دوغ', 350, 1],
        ['prod-demo-water', 'cat-demo-beverages', 'آب معدنی', 200, 2],
        ['prod-demo-sholeh', 'cat-demo-desserts', 'شله‌زرد', 400, 1],
      ] as const
    : lang === 'it'
    ? [
        ['prod-demo-bruschetta', 'cat-demo-starters', 'Bruschetta al Pomodoro', 280, 1],
        ['prod-demo-arancini', 'cat-demo-starters', 'Arancini', 250, 2],
        ['prod-demo-pasta-pomodoro', 'cat-demo-main', 'Pasta al Pomodoro', 800, 1],
        ['prod-demo-risotto', 'cat-demo-main', 'Risotto ai Funghi', 1100, 2],
        ['prod-demo-pizza-margherita', 'cat-demo-main', 'Pizza Margherita', 1200, 3],
        ['prod-demo-acqua', 'cat-demo-beverages', 'Acqua Minerale', 350, 1],
        ['prod-demo-spremuta', 'cat-demo-beverages', "Spremuta d'Arancia", 200, 2],
        ['prod-demo-tiramisu', 'cat-demo-desserts', 'Tiramisù', 400, 1],
      ] as const
    : lang === 'ja'
    ? [
        ['prod-demo-karaage', 'cat-demo-starters', '唐揚げ', 280, 1],
        ['prod-demo-edamame', 'cat-demo-starters', '枝豆', 250, 2],
        ['prod-demo-ramen', 'cat-demo-main', 'ラーメン', 800, 1],
        ['prod-demo-sushi', 'cat-demo-main', '寿司盛り合わせ', 1100, 2],
        ['prod-demo-curry', 'cat-demo-main', 'カレーライス', 1200, 3],
        ['prod-demo-matcha', 'cat-demo-beverages', '抹茶ラテ', 350, 1],
        ['prod-demo-water', 'cat-demo-beverages', 'ミネラルウォーター', 200, 2],
        ['prod-demo-mochi', 'cat-demo-desserts', '抹茶もち', 400, 1],
      ] as const
    : lang === 'zh'
    ? [
        ['prod-demo-spring-rolls', 'cat-demo-starters', '春卷', 280, 1],
        ['prod-demo-dumplings', 'cat-demo-starters', '饺子', 250, 2],
        ['prod-demo-noodles', 'cat-demo-main', '牛肉面', 800, 1],
        ['prod-demo-fried-rice', 'cat-demo-main', '蛋炒饭', 1100, 2],
        ['prod-demo-sweet-sour', 'cat-demo-main', '糖醋里脊', 1200, 3],
        ['prod-demo-tea', 'cat-demo-beverages', '绿茶', 350, 1],
        ['prod-demo-water', 'cat-demo-beverages', '矿泉水', 200, 2],
        ['prod-demo-mango', 'cat-demo-desserts', '芒果布丁', 400, 1],
      ] as const
    : lang === 'zh-tw'
    ? [
        ['prod-demo-spring-rolls', 'cat-demo-starters', '春捲', 280, 1],
        ['prod-demo-dumplings', 'cat-demo-starters', '餃子', 250, 2],
        ['prod-demo-noodles', 'cat-demo-main', '牛肉麵', 800, 1],
        ['prod-demo-fried-rice', 'cat-demo-main', '蛋炒飯', 1100, 2],
        ['prod-demo-sweet-sour', 'cat-demo-main', '糖醋里肌', 1200, 3],
        ['prod-demo-tea', 'cat-demo-beverages', '綠茶', 350, 1],
        ['prod-demo-water', 'cat-demo-beverages', '礦泉水', 200, 2],
        ['prod-demo-mango', 'cat-demo-desserts', '芒果布丁', 400, 1],
      ] as const
    : lang === 'ko'
    ? [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', '치즈 꼬치', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', '치킨 윙', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', '버터 치킨', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', '크림 렌틸 카레', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', '큐민 라이스', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', '콜라', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', '레몬 소다', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', '장미 볼', 80, 1],
      ] as const
    : lang === 'id'
    ? [
        ['prod-demo-sate', 'cat-demo-starters', 'Sate Ayam', 280, 1],
        ['prod-demo-tempe', 'cat-demo-starters', 'Tempe Goreng', 250, 2],
        ['prod-demo-nasi-goreng', 'cat-demo-main', 'Nasi Goreng', 800, 1],
        ['prod-demo-ayam-bakar', 'cat-demo-main', 'Ayam Bakar', 1100, 2],
        ['prod-demo-rendang', 'cat-demo-main', 'Rendang Sapi', 1200, 3],
        ['prod-demo-es-teh', 'cat-demo-beverages', 'Es Teh', 350, 1],
        ['prod-demo-air-mineral', 'cat-demo-beverages', 'Air Mineral', 200, 2],
        ['prod-demo-pisang-goreng', 'cat-demo-desserts', 'Pisang Goreng', 400, 1],
      ] as const
    : lang === 'ar'
    ? [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', 'بانير تيكا', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', 'أجنحة الدجاج', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', 'دجاج بالزبدة', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', 'دال ماخاني', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', 'أرز بالكمون', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', 'كولا', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', 'صودا الليمون', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'جولاب جامون', 80, 1],
      ] as const
    : lang === 'ur'
    ? [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', 'پنیر ٹکّا', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', 'چکن ونگز', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', 'مکھنی چکن', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', 'دال مکھنی', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', 'ذیرہ چاول', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', 'کولا', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', 'لیمون سوڈا', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'گلاب جامن', 80, 1],
      ] as const
    : lang === 'nl'
    ? [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', 'Paneer tikka', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', 'Kippenvleugels', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', 'Kip in botersaus', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', 'Dhal Makhani', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', 'Jeerarijs', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', 'Cola', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', 'Limonade', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'Gulab jamun', 80, 1],
      ] as const
    : lang === 'hi'
    ? [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', 'पनीर टिक्का', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', 'चिकन विंग्स', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', 'बटर चिकन', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', 'दाल मखनी', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', 'जीरा चावल', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', 'कोला', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', 'नींबू सोडा', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'गुलाब जामुन', 80, 1],
      ] as const
    : lang === 'bn'
    ? [
        ['prod-demo-fuchka', 'cat-demo-starters', 'ফুচকা', 280, 1],
        ['prod-demo-singara', 'cat-demo-starters', 'সিঙ্গারা', 250, 2],
        ['prod-demo-bhuna-khichuri', 'cat-demo-main', 'ভুনা খিচুড়ি', 800, 1],
        ['prod-demo-ilish-bhaja', 'cat-demo-main', 'ইলিশ ভাজা', 1100, 2],
        ['prod-demo-mug-dal-rice', 'cat-demo-main', 'মুগ ডাল ভাত', 1200, 3],
        ['prod-demo-tea', 'cat-demo-beverages', 'চা', 350, 1],
        ['prod-demo-water', 'cat-demo-beverages', 'পানি', 200, 2],
        ['prod-demo-rosogolla', 'cat-demo-desserts', 'রসগোলা', 400, 1],
      ] as const
    : lang === 'sq'
    ? [
        ['prod-demo-skewers', 'cat-demo-starters', 'Sata me pulë', 280, 1],
        ['prod-demo-pita', 'cat-demo-starters', 'Pita me djathë', 250, 2],
        ['prod-demo-burrek', 'cat-demo-main', 'Byrek me djathë', 800, 1],
        ['prod-demo-hamburger', 'cat-demo-main', 'Hamburger', 1100, 2],
        ['prod-demo-kulec', 'cat-demo-main', 'Kuleç me kripë', 1200, 3],
        ['prod-demo-kafe', 'cat-demo-beverages', 'Kafe', 60, 1],
        ['prod-demo-uje', 'cat-demo-beverages', 'Ujë mineral', 70, 2],
        ['prod-demo-bakllavan', 'cat-demo-desserts', 'Bakllavan', 80, 1],
      ] as const
    : lang === 'vi'
    ? [
        ['prod-demo-nem-ran', 'cat-demo-starters', 'Nem rán', 280, 1],
        ['prod-demo-khoai-tay-chien', 'cat-demo-starters', 'Khoai tây chiên', 250, 2],
        ['prod-demo-pho-bo', 'cat-demo-main', 'Phở bò', 800, 1],
        ['prod-demo-pho-bo-dac-biet', 'cat-demo-main', 'Phở bò đặc biệt', 1100, 2],
        ['prod-demo-bun-bo-hue', 'cat-demo-main', 'Bún bò Huế', 1200, 3],
        ['prod-demo-coca-cola', 'cat-demo-beverages', 'Coca-Cola', 350, 1],
        ['prod-demo-nuoc-khoang', 'cat-demo-beverages', 'Nước khoáng', 200, 2],
        ['prod-demo-banh-flan', 'cat-demo-desserts', 'Bánh flan', 400, 1],
      ] as const
    : lang === 'ru'
    ? [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', 'Шашлык из панира', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', 'Куриные крылышки', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', 'Курица в сливочном соусе', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', 'Дал-махани', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', 'Рис с кумином', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', 'Кола', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', 'Лимонад', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'Гулаб джамун', 80, 1],
      ] as const
    : lang === 'th'
    ? [
        ['prod-demo-satay', 'cat-demo-starters', 'สะเต๊ะไก่', 280, 1],
        ['prod-demo-tempeh', 'cat-demo-starters', 'เต้าหู้ทอดกรอบ', 250, 2],
        ['prod-demo-pad-krapow', 'cat-demo-main', 'ผัดกะเพราไก่', 800, 1],
        ['prod-demo-ayam-goreng', 'cat-demo-main', 'ไก่ทอดแกง', 1100, 2],
        ['prod-demo-khao-soi', 'cat-demo-main', 'ข้าวซอย', 1200, 3],
        ['prod-demo-teh-tarik', 'cat-demo-beverages', 'ชาเย็น', 350, 1],
        ['prod-demo-mineral-water', 'cat-demo-beverages', 'น้ำแร่', 200, 2],
        ['prod-demo-mango-sticky-rice', 'cat-demo-desserts', 'ข้าวเหนียวมะม่วง', 400, 1],
      ] as const
    : lang === 'ne'
    ? [
        ['prod-demo-samosa', 'cat-demo-starters', 'समोसे', 280, 1],
        ['prod-demo-fried-potato', 'cat-demo-starters', 'फ्राइड आलु', 250, 2],
        ['prod-demo-dal-bhat', 'cat-demo-main', 'दाल भात', 800, 1],
        ['prod-demo-mug-bhat', 'cat-demo-main', 'मुग भात', 1100, 2],
        ['prod-demo-tarkari', 'cat-demo-main', 'तरकारी', 1200, 3],
        ['prod-demo-chai', 'cat-demo-beverages', 'चिया', 60, 1],
        ['prod-demo-water', 'cat-demo-beverages', 'पानी', 70, 2],
        ['prod-demo-apple', 'cat-demo-desserts', 'स्याउ', 80, 1],
      ] as const
    : [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', 'Paneer Tikka', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', 'Chicken Wings', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', 'Butter Chicken', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', 'Dal Makhani', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', 'Jeera Rice', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', 'Cola', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', 'Lemon Soda', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'Gulab Jamun', 80, 1],
      ] as const;
  for (const [id, categoryId, name, price, sort] of products) insertProduct(db, id, categoryId, name, price, sort);

  if (serviceModel === 'finedine') {
    const tableLabel = lang === 'es' ? 'M' : lang === 'pt' ? 'M' : lang === 'vi' ? 'B' : lang === 'ru' ? 'С' : 'T';
    insertTable(db, 'tbl-demo-1', `${tableLabel}1`, 4);
    insertTable(db, 'tbl-demo-2', `${tableLabel}2`, 4);
    insertTable(db, 'tbl-demo-3', `${tableLabel}3`, 6);
    insertTable(db, 'tbl-demo-4', `${tableLabel}4`, 2);
  }

  // country is independent of UI language, but the demo profile needs a real
  // one to seed demo customers with a plausible phone number — the caller
  // (POST /setup/initialize) always supplies the owner's selected country.
  if (!country) throw new RegionalNotConfiguredError(country);
  const demoCountry = country;
  const dialCode = dialCodeFor(demoCountry);
  if (lang === 'es') {
    insertCustomer(db, 'cust-demo-1', 'Juan Pérez', '+541145678901', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'María González', '+541145678902', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Carlos Rodríguez', '+541145678903', dialCode, demoCountry);
  } else if (lang === 'fr') {
    insertCustomer(db, 'cust-demo-1', 'Camille Martin', '+33145678901', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Julien Bernard', '+33145678902', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Sophie Dubois', '+33145678903', dialCode, demoCountry);
  } else if (lang === 'pt') {
    insertCustomer(db, 'cust-demo-1', 'João Silva', '+5511987654321', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Maria Santos', '+5511987654322', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Carlos Oliveira', '+5511987654323', dialCode, demoCountry);
  } else if (lang === 'de') {
    insertCustomer(db, 'cust-demo-1', 'Anna Müller', '+4915123456789', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Lukas Schneider', '+4915123456790', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Sophie Weber', '+4915123456791', dialCode, demoCountry);
  } else if (lang === 'tr') {
    insertCustomer(db, 'cust-demo-1', 'Ayşe Yılmaz', '+905321234567', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Mehmet Kaya', '+905321234568', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Elif Demir', '+905321234569', dialCode, demoCountry);
  } else if (lang === 'fa') {
    insertCustomer(db, 'cust-demo-1', 'علی رضایی', '+989121234567', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'سارا محمدی', '+989121234568', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'مریم کریمی', '+989121234569', dialCode, demoCountry);
  } else if (lang === 'it') {
    insertCustomer(db, 'cust-demo-1', 'Giulia Rossi', '+393331234567', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Marco Bianchi', '+393331234568', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Anna Ferrari', '+393331234569', dialCode, demoCountry);
  } else if (lang === 'ja') {
    insertCustomer(db, 'cust-demo-1', '佐藤 花子', '+819012345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', '鈴木 太郎', '+819012345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', '田中 美咲', '+819012345670', dialCode, demoCountry);
  } else if (lang === 'zh') {
    insertCustomer(db, 'cust-demo-1', '李娜', '+8613800138071', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', '王伟', '+8613800138072', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', '张敏', '+8613800138073', dialCode, demoCountry);
  } else if (lang === 'zh-tw') {
    insertCustomer(db, 'cust-demo-1', '李娜', '+886912345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', '王偉', '+886912345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', '張敏', '+886912345670', dialCode, demoCountry);
  } else if (lang === 'ko') {
    insertCustomer(db, 'cust-demo-1', '김민수', '+821012345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', '이지은', '+821012345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', '박서연', '+821012345670', dialCode, demoCountry);
  } else if (lang === 'id') {
    insertCustomer(db, 'cust-demo-1', 'Budi Santoso', '+6281234567801', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Siti Rahayu', '+6281234567802', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Andi Wijaya', '+6281234567803', dialCode, demoCountry);
  } else if (lang === 'ar') {
    insertCustomer(db, 'cust-demo-1', 'علي حسن', '+966512345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'سارة أحمد', '+966512345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'مريم خالد', '+966512345670', dialCode, demoCountry);
  } else if (lang === 'ur') {
    insertCustomer(db, 'cust-demo-1', 'عمر احمد', '+923001234567', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'عائشہ خان', '+923001234568', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'زینب علی', '+923001234569', dialCode, demoCountry);
  } else if (lang === 'nl') {
    insertCustomer(db, 'cust-demo-1', 'Sanne de Jong', '+31612345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Bram Jansen', '+31612345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Fleur Visser', '+31612345680', dialCode, demoCountry);
  } else if (lang === 'hi') {
    insertCustomer(db, 'cust-demo-1', 'आरव शर्मा', '+919876543210', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'माया अयर', '+919876543211', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'कबीर खान', '+919876543212', dialCode, demoCountry);
  } else if (lang === 'bn') {
    insertCustomer(db, 'cust-demo-1', 'রাফেকুল ইসলাম', '+8801712345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'সাদিয়া আফরিন', '+8801712345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'তানভীর আহমেদ', '+8801712345680', dialCode, demoCountry);
  } else if (lang === 'sq') {
    insertCustomer(db, 'cust-demo-1', 'Arben Krasni', '+355671234567', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Elira Gjoni', '+355691234567', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Murat Hoxha', '+355681234567', dialCode, demoCountry);
  } else if (lang === 'vi') {
    insertCustomer(db, 'cust-demo-1', 'Nguyễn Minh Anh', '+84912345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Trần Quốc Bảo', '+84912345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Lê Thu Hà', '+84912345680', dialCode, demoCountry);
  } else if (lang === 'ru') {
    insertCustomer(db, 'cust-demo-1', 'Иван Петров', '+79161234567', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Ольга Смирнова', '+79161234568', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Дмитрий Козлов', '+79161234569', dialCode, demoCountry);
  } else if (lang === 'th') {
    insertCustomer(db, 'cust-demo-1', 'สมชาย รักดี', '+66812345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'สุดา วงศ์ทอง', '+66812345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'ประเสริฐ ทองดี', '+66812345680', dialCode, demoCountry);
  } else if (lang === 'ne') {
    insertCustomer(db, 'cust-demo-1', 'अनिश अधिकारी', '+9779812345678', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'सुमन थिडी', '+9779812345679', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'प्रिया गिरी', '+9779812345680', dialCode, demoCountry);
  } else {
    insertCustomer(db, 'cust-demo-1', 'Aarav Sharma', '+919876543210', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-2', 'Maya Iyer', '+919876543211', dialCode, demoCountry);
    insertCustomer(db, 'cust-demo-3', 'Kabir Khan', '+919876543212', dialCode, demoCountry);
  }

  const managerName = lang === 'es' ? 'Gerente Demo' : lang === 'fr' ? 'Gérant Démo' : lang === 'pt' ? 'Gerente Demo'
    : lang === 'de' ? 'Demo-Manager' : lang === 'tr' ? 'Demo Müdürü' : lang === 'fa' ? 'مدیر نمایشی' : lang === 'ar' ? 'مدير تجريبي' : lang === 'ur' ? 'ڈیمو منیجر'
    : lang === 'it' ? 'Responsabile Demo' : lang === 'ja' ? 'デモマネージャー' : lang === 'zh' ? '演示经理' : lang === 'zh-tw' ? '示範經理'
    : lang === 'ko' ? '예시 매니저' : lang === 'id' ? 'Manajer Demo' : lang === 'nl' ? 'Demomanager' : lang === 'hi' ? 'डेमो मैनेजर'
    : lang === 'bn' ? 'ম্যানেজার ডেমো' : lang === 'sq' ? 'Menaxher Demo' : lang === 'vi' ? 'Quản lý Demo' : lang === 'ru' ? 'Демо-менеджер' : lang === 'th' ? 'ผู้จัดการสาธิต' : lang === 'ne' ? 'डेमो प्रबन्धक' : 'Demo Manager';
  const cashierName = lang === 'es' ? 'Cajero Demo' : lang === 'fr' ? 'Caissier Démo' : lang === 'pt' ? 'Caixa Demo'
    : lang === 'de' ? 'Demo-Kassierer' : lang === 'tr' ? 'Demo Kasiyer' : lang === 'fa' ? 'صندوقدار نمایشی' : lang === 'ar' ? 'أمين صندوق تجريبي' : lang === 'ur' ? 'ڈیمو کیشیئر'
    : lang === 'it' ? 'Cassiere Demo' : lang === 'ja' ? 'デモキャッシャー' : lang === 'zh' ? '演示收银员' : lang === 'zh-tw' ? '示範收銀員'
    : lang === 'ko' ? '예시 계산원' : lang === 'id' ? 'Kasir Demo' : lang === 'nl' ? 'Demo-kassier' : lang === 'hi' ? 'डेमो कैशियर'
    : lang === 'bn' ? 'ক্যাশিয়ার ডেমো' : lang === 'sq' ? 'Arkëtar Demo' : lang === 'vi' ? 'Thu ngân Demo' : lang === 'ru' ? 'Демо-кассир' : lang === 'th' ? 'แคชเชียร์สาธิต' : lang === 'ne' ? 'डेमो क्यासियर' : 'Demo Cashier';
  const chefName = lang === 'es' ? 'Cocinero Demo' : lang === 'fr' ? 'Chef Démo' : lang === 'pt' ? 'Cozinheiro Demo'
    : lang === 'de' ? 'Demo-Koch' : lang === 'tr' ? 'Demo Aşçı' : lang === 'fa' ? 'آشپز نمایشی' : lang === 'ar' ? 'طاهٍ تجريبي' : lang === 'ur' ? 'ڈیمو شیف'
    : lang === 'it' ? 'Cuoco Demo' : lang === 'ja' ? 'デモシェフ' : lang === 'zh' ? '演示厨师' : lang === 'zh-tw' ? '示範廚師'
    : lang === 'ko' ? '예시 셰프' : lang === 'id' ? 'Koki Demo' : lang === 'nl' ? 'Demo-kok' : lang === 'hi' ? 'डेमो शेफ'
    : lang === 'bn' ? 'শেফ ডেমো' : lang === 'sq' ? 'Shef Demo' : lang === 'vi' ? 'Đầu bếp Demo' : lang === 'ru' ? 'Демо-повар' : lang === 'th' ? 'เชฟสาธิต' : lang === 'ne' ? 'डेमो रसोइया' : 'Demo Chef';
  // Demo staff accounts are inactive with random passwords to prevent usable default credentials.
  insertStaffUser(db, 'user-demo-manager', managerName, 'manager@flo.local', 'manager', randomBytes(32).toString('hex'), 0);
  insertStaffUser(db, 'user-demo-cashier', cashierName, 'cashier@flo.local', 'cashier', randomBytes(32).toString('hex'), 0);
  insertStaffUser(db, 'user-demo-chef', chefName, 'chef@flo.local', 'chef', randomBytes(32).toString('hex'), 0);
}

export function seedSetupProfile(db: ReturnType<typeof getDatabase>, profile: string, serviceModel: string, language?: string, country?: string): void {
  if (profile === 'express') {
    seedExpressRestaurant(db, serviceModel, language);
  } else if (profile === 'demo') {
    seedDemoRestaurant(db, serviceModel, language, country);
  }
}

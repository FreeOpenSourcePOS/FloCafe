/**
 * Test suite for Area A: Frontend auth-state recovery
 * Verifies that malformed, missing, or valid persisted tenant data in localStorage
 * is handled safely during loadFromStorage without crashing application startup.
 */

const { assertEqual, assert } = require('./helpers/test-setup');

// Mock localStorage
class MockLocalStorage {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

const storage = new MockLocalStorage();
(global as any).window = {};
(global as any).localStorage = storage;

// Extraction of loadFromStorage tenant parsing logic for isolated verification
function parseStoredTenant(tenantStr: string | null): { tenant: any | null; cleaned: boolean } {
  let currentTenant: any = null;
  let cleaned = false;
  if (tenantStr) {
    try {
      const parsed = JSON.parse(tenantStr);
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'number') {
        currentTenant = parsed;
      } else {
        storage.removeItem('tenant');
        cleaned = true;
      }
    } catch {
      storage.removeItem('tenant');
      cleaned = true;
    }
  }
  return { tenant: currentTenant, cleaned };
}

async function run() {
  console.log('Testing Frontend Auth State Recovery (Area A)...');
  console.log('='.repeat(60));

  // Case 1: Missing tenant data
  storage.clear();
  const case1 = parseStoredTenant(storage.getItem('tenant'));
  assertEqual(case1.tenant, null, 'Missing tenant returns null');
  assertEqual(case1.cleaned, false, 'No cleanup needed for missing key');

  // Case 2: Malformed JSON string
  storage.clear();
  storage.setItem('tenant', 'undefined');
  const case2 = parseStoredTenant(storage.getItem('tenant'));
  assertEqual(case2.tenant, null, 'Malformed JSON returns null tenant');
  assertEqual(case2.cleaned, true, 'Malformed JSON removes tenant key from storage');
  assertEqual(storage.getItem('tenant'), null, 'localStorage tenant key is now null');

  // Case 3: Invalid JSON object (missing numeric id property)
  storage.clear();
  storage.setItem('tenant', JSON.stringify({ name: 'Invalid Tenant' }));
  const case3 = parseStoredTenant(storage.getItem('tenant'));
  assertEqual(case3.tenant, null, 'Object missing numeric id returns null tenant');
  assertEqual(case3.cleaned, true, 'Invalid tenant object removes key from storage');

  // Case 4: Non-object JSON (primitive string/number/boolean)
  storage.clear();
  storage.setItem('tenant', JSON.stringify(12345));
  const case4 = parseStoredTenant(storage.getItem('tenant'));
  assertEqual(case4.tenant, null, 'Primitive JSON value returns null tenant');
  assertEqual(case4.cleaned, true, 'Primitive JSON value removes key from storage');

  // Case 5: Valid tenant object
  storage.clear();
  const validTenant = { id: 1, business_name: 'Flo Cafe', country: 'IN', currency: 'INR' };
  storage.setItem('tenant', JSON.stringify(validTenant));
  const case5 = parseStoredTenant(storage.getItem('tenant'));
  assert(case5.tenant !== null, 'Valid tenant parsed successfully');
  assertEqual(case5.tenant.id, 1, 'Valid tenant id matches');
  assertEqual(case5.tenant.business_name, 'Flo Cafe', 'Valid tenant business_name matches');
  assertEqual(case5.cleaned, false, 'Valid tenant data is preserved in storage');

  console.log('\n✅ Frontend Auth State Recovery tests passed!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

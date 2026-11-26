import { now } from '../db';

/**
 * The kitchen ticket the print test sends. It is made up here, so a test print never reads, and
 * can never print, a real order.
 */
export function sampleKotOrder() {
  return {
    id: 0,
    order_number: 'TEST-001',
    type: 'takeaway',
    created_at: now(),
    special_instructions: null,
    items: [
      {
        id: 1,
        product_name: 'Sample Item',
        quantity: 2,
        addons: [{ name: 'Sample add-on', quantity: 1 }],
        special_instructions: 'Sample note',
        status: 'pending',
      },
      { id: 2, product_name: 'Second Sample Item', quantity: 1, addons: [], status: 'pending' },
    ],
  };
}

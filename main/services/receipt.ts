/**
 * Unified Print Receipt Service
 *
 * Logs print actions (receipt/reprint) to the print_logs table
 * and updates the bill's printed_at timestamp.
 */

import { getDatabase, withTxn, now } from '../db';

export type PrintType = 'receipt' | 'reprint';

export async function printReceipt(
  billId: number,
  userId: string,
  printType: PrintType
): Promise<{ success: boolean; printLogId?: number }> {
  const db = getDatabase();

  // Log the print action and update bill timestamp atomically
  const result = withTxn(() => {
    const bill = db.prepare('SELECT id FROM bills WHERE id = ?').get(billId) as { id: number } | undefined;
    if (!bill) {
      throw new Error('Bill not found');
    }

    const insertResult = db.prepare(
      'INSERT INTO print_logs (bill_id, user_id, print_type, printed_at) VALUES (?, ?, ?, ?)'
    ).run(billId, userId, printType, now());

    // Update bill's printed_at timestamp
    db.prepare('UPDATE bills SET printed_at = ?, updated_at = ? WHERE id = ?')
      .run(now(), now(), billId);

    return insertResult;
  });

  return { success: true, printLogId: result.lastInsertRowid as number };
}

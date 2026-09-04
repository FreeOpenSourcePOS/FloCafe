/** WebUSB adapter for the shared mixed-mode raster contract. */
import {
  encodeMixedPrintParts,
  type MixedPrintPart,
} from '@print/raster';
import type { ThermalPrinterCapabilities } from '@print/thermal-capabilities';

export function buildWebUsbMixedRasterBytes(
  parts: readonly MixedPrintPart[],
  capabilities: ThermalPrinterCapabilities,
  cutMode: 'full' | 'partial',
): Uint8Array {
  return encodeMixedPrintParts(parts, capabilities, cutMode);
}

'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';

export interface FittingCalculationInput<T extends { key: string }> {
  choices: T[];
  mandatoryKeys?: string[];
  availableWidth: number;
  chipWidths: Map<string, number>;
  labelWidth?: number;
  toggleWidth?: number;
  gap?: number;
}

export interface FittingCalculationResult<T> {
  allFit: boolean;
  visibleChoices: T[];
}

/**
 * Pure fitting calculation for collapsible POS choices rows.
 *
 * 1. Checks if all choices fit with the label without a toggle.
 * 2. If not, reserves space for the label, toggle button, and all mandatory
 *    choices (e.g. All and the selected category).
 * 3. Fills remaining space with the maximal prefix of non-mandatory choices in
 *    their existing order.
 * 4. Preserves source order of all visible choices (never reorders mandatory
 *    keys ahead of preceding items).
 */
export function calculateFittingChoices<T extends { key: string }>({
  choices,
  mandatoryKeys = [],
  availableWidth,
  chipWidths,
  labelWidth = 0,
  toggleWidth = 0,
  gap = 8,
}: FittingCalculationInput<T>): FittingCalculationResult<T> {
  if (availableWidth <= 0 || choices.length === 0) {
    return { allFit: true, visibleChoices: choices };
  }

  // 1. Total width if all choices are rendered without toggle
  let totalChipsWidth = 0;
  for (const choice of choices) {
    totalChipsWidth += chipWidths.get(choice.key) ?? 0;
  }

  const totalElementsWithoutToggle = (labelWidth > 0 ? 1 : 0) + choices.length;
  const totalGapsWithoutToggle =
    totalElementsWithoutToggle > 1 ? (totalElementsWithoutToggle - 1) * gap : 0;
  const totalWidthWithoutToggle = labelWidth + totalChipsWidth + totalGapsWithoutToggle;

  if (totalWidthWithoutToggle <= availableWidth) {
    return { allFit: true, visibleChoices: choices };
  }

  // 2. Not all fit. Toggle is required.
  // Reserve space for:
  // - label (if present)
  // - toggle button
  // - all mandatory keys that exist in choices
  const mandatorySet = new Set(mandatoryKeys);
  const mandatoryChoices = choices.filter((c) => mandatorySet.has(c.key));

  let mandatoryChipsWidth = 0;
  for (const mc of mandatoryChoices) {
    mandatoryChipsWidth += chipWidths.get(mc.key) ?? 0;
  }

  // Count items that MUST be rendered when collapsed:
  // (label if present) + (toggle button) + (mandatory items)
  const fixedItemCount = (labelWidth > 0 ? 1 : 0) + 1 + mandatoryChoices.length;
  const fixedGaps = fixedItemCount > 1 ? (fixedItemCount - 1) * gap : 0;
  const fixedReservedWidth = labelWidth + toggleWidth + mandatoryChipsWidth + fixedGaps;

  const visibleKeySet = new Set<string>(mandatoryChoices.map((c) => c.key));

  // Available width remaining for prefix of non-mandatory choices
  let remainingWidth = availableWidth - fixedReservedWidth;

  // Include maximal prefix of remaining choices in existing order that fits
  for (const choice of choices) {
    if (mandatorySet.has(choice.key)) {
      // Already accounted for in mandatory choices
      continue;
    }
    const chipW = chipWidths.get(choice.key) ?? 0;
    const needed = chipW + gap;
    if (needed <= remainingWidth) {
      remainingWidth -= needed;
      visibleKeySet.add(choice.key);
    } else {
      // Maximal prefix: stop at first non-fitting choice
      break;
    }
  }

  // Filter choices in EXACT ORIGINAL ORDER so mandatory choices are NEVER moved to front
  const visibleChoices = choices.filter((c) => visibleKeySet.has(c.key));
  return { allFit: false, visibleChoices };
}

interface Props {
  /** Keyed choice buttons in source order; consumers keep selection and clicks. */
  choices: Array<{ key: string; node: ReactNode }>;
  /** Always-visible keys when collapsed (e.g. All and the selected category). */
  mandatoryKeys?: string[];
  /** Optional leading label rendered before the choices. */
  label?: ReactNode;
  /** Changed consumer context resets the expansion state (e.g. customer identity). */
  resetKey?: string | null;
  /** Accessible name for the row region. */
  ariaLabel: string;
  'data-testid'?: string;
}

const EMPTY_MANDATORY: string[] = [];

function areKeysEqual(a: Array<{ key: string }>, b: Array<{ key: string }>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false;
  }
  return true;
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * One measured collapse row for the two POS choice rows (categories, favorites).
 *
 * Chip widths come from the rendered choices in the row itself, so the visible row never
 * scrolls sideways: it shows either everything (if it fits), the mandatory keys
 * plus the maximal fitting prefix in original order, or every choice wrapped when expanded.
 * Purely presentational: data, selection and clicks stay with the consumers.
 */
export default function CollapsiblePosChoices({
  choices,
  mandatoryKeys = EMPTY_MANDATORY,
  label,
  resetKey,
  ariaLabel,
  'data-testid': testId,
}: Props) {
  const t = useTranslations('pos');
  const toggleId = useId();
  const [expanded, setExpanded] = useState(false);
  // null = not measured yet; Set of fitting keys when collapsed
  const [fittingKeySet, setFittingKeySet] = useState<Set<string> | null>(null);
  const [allFit, setAllFit] = useState(false);
  const [probeMounted, setProbeMounted] = useState(true);

  const rowRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const toggleProbeRef = useRef<HTMLSpanElement | null>(null);
  const probeRefs = useRef<Map<string, HTMLElement>>(new Map());
  const chipWidthsRef = useRef<Map<string, number>>(new Map());

  // One choice cannot overflow, and a status-only row has nothing to expand.
  const expandable = choices.length > 1;

  // A consumer context change (customer switch/clear) resets the expansion.
  const [syncedResetKey, setSyncedResetKey] = useState(resetKey);
  if (syncedResetKey !== resetKey) {
    setSyncedResetKey(resetKey);
    if (expanded) setExpanded(false);
    setProbeMounted(true);
  }

  // Remeasure whenever choices or mandatory keys change
  const [syncedChoices, setSyncedChoices] = useState(choices);
  const [syncedMandatory, setSyncedMandatory] = useState(mandatoryKeys);
  if (
    !areKeysEqual(syncedChoices, choices) ||
    !areStringArraysEqual(syncedMandatory, mandatoryKeys)
  ) {
    setSyncedChoices(choices);
    setSyncedMandatory(mandatoryKeys);
    setProbeMounted(true);
  }

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const available = row.clientWidth;
    if (available <= 0) return;

    // Cache current chip widths from the probe pass
    for (const choice of choices) {
      const chip = probeRefs.current.get(choice.key);
      if (chip && chip.offsetWidth > 0) {
        chipWidthsRef.current.set(choice.key, chip.offsetWidth);
      }
    }

    const labelWidth = labelRef.current ? labelRef.current.offsetWidth : 0;
    const toggleWidth = toggleProbeRef.current ? toggleProbeRef.current.offsetWidth : 80;

    const result = calculateFittingChoices({
      choices,
      mandatoryKeys,
      availableWidth: available,
      chipWidths: chipWidthsRef.current,
      labelWidth,
      toggleWidth,
      gap: 8,
    });

    setAllFit(result.allFit);
    if (result.allFit) {
      setFittingKeySet(null);
    } else {
      setFittingKeySet(new Set(result.visibleChoices.map((c) => c.key)));
    }
  }, [choices, mandatoryKeys]);

  // Measurement pass: mount all chips, read widths, then apply visible subset.
  useEffect(() => {
    if (!probeMounted || expanded) return;
    const frame = requestAnimationFrame(() => {
      measure();
      setProbeMounted(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [probeMounted, expanded, measure]);

  // Re-measure when the available container width changes.
  useEffect(() => {
    if (expanded) return;
    const row = rowRef.current;
    if (row && typeof ResizeObserver !== 'undefined') {
      let lastWidth = row.clientWidth;
      const observer = new ResizeObserver(() => {
        const width = row.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        setProbeMounted(true);
      });
      observer.observe(row);
      return () => observer.disconnect();
    }
    return undefined;
  }, [expanded]);

  // Remeasure after custom fonts finish loading
  useEffect(() => {
    if (expanded) return;
    if (!document.fonts?.ready) return;
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) setProbeMounted(true);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  const showToggle = expandable && !expanded && !allFit;

  // While the measure pass runs or before first measure, all choices are rendered
  // so exact DOM widths can be read. After measurement, only fitting choices are visible.
  const visible = (() => {
    if (expanded || allFit || fittingKeySet === null || probeMounted) return choices;
    return choices.filter((c) => fittingKeySet.has(c.key));
  })();

  return (
    <div className="relative min-w-0 flex-1">
      {/* Invisible toggle probe to measure exact localized toggle width */}
      <span
        ref={toggleProbeRef}
        aria-hidden="true"
        className="invisible absolute -left-[9999px] top-0 pointer-events-none whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium"
      >
        {t('viewMore')}
      </span>

      <div
        ref={rowRef}
        aria-label={ariaLabel}
        data-testid={testId}
        className={`relative flex min-w-0 items-center gap-2 ${
          expanded ? 'flex-wrap' : 'flex-nowrap overflow-hidden'
        }`}
      >
        {label !== undefined && (
          <span ref={labelRef} className="flex shrink-0 items-center whitespace-nowrap">
            {label}
          </span>
        )}
        {visible.map((choice) => (
          <span
            key={choice.key}
            ref={(node) => {
              if (node) probeRefs.current.set(choice.key, node);
              else probeRefs.current.delete(choice.key);
            }}
            className={`flex min-w-0 ${
              !expanded &&
              !probeMounted &&
              mandatoryKeys.includes(choice.key) &&
              choice.key !== mandatoryKeys[0]
                ? 'shrink'
                : 'shrink-0'
            }`}
          >
            {choice.node}
          </span>
        ))}
        {showToggle && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={toggleId}
            onClick={() => setExpanded(true)}
            className="ms-auto shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            {t('viewMore')}
          </button>
        )}
        {expanded && expandable && !allFit && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={toggleId}
            onClick={() => {
              setExpanded(false);
              setProbeMounted(true);
            }}
            className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            {t('viewLess')}
          </button>
        )}
      </div>
    </div>
  );
}

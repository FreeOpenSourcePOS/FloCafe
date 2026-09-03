'use client';

// Floorplan editor for issue #356: drag tables onto a canvas, persist X/Y per
// floor as percent coordinates (dnd-kit is sortable-list semantics — wrong tool
// for free 2D placement; native pointer events instead).

import { useEffect, useMemo, useRef, useState } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Eye, LayoutGrid, Maximize2, Minimize2, Pencil, Plus, Sparkles, Table2, Trash2, Users } from 'lucide-react';
import type { Order, Table } from '@/lib/types';
import { useTranslations } from 'use-intl';
import { TABLE_STATUS_LABEL_KEYS } from '@/lib/i18n';
import { TableTurnoverBadge } from '@/components/tables/TableTurnoverBadge';
import { Ltr } from '@/components/layout/Ltr';

type XY = { x: number; y: number } | null;

const statusRing: Record<Table['status'], string> = {
  available: 'border-emerald-500',
  occupied: 'border-red-500',
  reserved: 'border-amber-500',
  cleaning: 'border-gray-400',
  held: 'border-sky-500',
};

const statusText: Record<Table['status'], string> = {
  available: 'text-emerald-600',
  occupied: 'text-red-600',
  reserved: 'text-amber-600',
  cleaning: 'text-gray-500',
  held: 'text-sky-600',
};

const statusDot: Record<Table['status'], string> = {
  available: 'bg-emerald-500',
  occupied: 'bg-red-500',
  reserved: 'bg-amber-500',
  cleaning: 'bg-gray-400',
  held: 'bg-sky-500',
};

const LEGEND: Table['status'][] = ['available', 'occupied', 'reserved', 'cleaning', 'held'];

const ALL_FLOORS = '__all__';

// Fixed virtual coordinate space for the canvas: positions are percentages
// of this width, so tables, labels, and aisles scale down proportionally
// on narrow terminals instead of overlapping.
const VIRTUAL_WIDTH = 1000;

const round2 = (v: number) => Math.round(v * 100) / 100;

// Table geometry by seating: round for couples, square for four, rectangles
// for bigger parties, banquet for the very large. Chairs split across the
// long edges of rects, ring around circles.
function shapeFor(capacity: number, s = 1) {
  if (capacity <= 2) return { w: 78 * s, h: 78 * s, round: true };
  if (capacity <= 4) return { w: 96 * s, h: 96 * s, round: false };
  if (capacity <= 6) return { w: 138 * s, h: 82 * s, round: false };
  if (capacity <= 8) return { w: 172 * s, h: 82 * s, round: false };
  return { w: 214 * s, h: 82 * s, round: false };
}

function chairPoints(capacity: number, w: number, h: number, round: boolean) {
  const pts: { x: number; y: number }[] = [];
  if (round) {
    const r = w / 2 + 9;
    for (let i = 0; i < capacity; i++) {
      const a = (i / capacity) * Math.PI * 2 - Math.PI / 2;
      pts.push({ x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) });
    }
  } else {
    const top = Math.ceil(capacity / 2);
    const bottom = capacity - top;
    for (let i = 0; i < top; i++) pts.push({ x: ((i + 1) / (top + 1)) * w, y: -8 });
    for (let i = 0; i < bottom; i++) pts.push({ x: ((i + 1) / (bottom + 1)) * w, y: h + 8 });
  }
  return pts;
}

interface DragCtx {
  id: string;
  rect: DOMRect;
  offX: number;
  offY: number;
  halfX: number;
  halfY: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface TableForm {
  name: string;
  capacity: string;
  floor: string;
  section: string;
}

const EMPTY_FORM: TableForm = { name: '', capacity: '4', floor: '', section: '' };

// Auto-fit canvas aspect ratio to the bounding box of placed tables (uses saved
// positions only — pending edits are excluded so the canvas stays stable during
// drag and "settles" to its fit size after Save). A 4-table cafe no longer gets
// a 16:10 sea of dots; a packed fine-dining room keeps its full grid.
function computeCanvasAspect(placed: Table[]): number {
  if (placed.length === 0) return 4 / 3;
  let minX = 100, maxX = 0, minY = 100, maxY = 0;
  for (const tb of placed) {
    minX = Math.min(minX, tb.position_x!);
    maxX = Math.max(maxX, tb.position_x!);
    minY = Math.min(minY, tb.position_y!);
    maxY = Math.max(maxY, tb.position_y!);
  }
  const PAD = 18; // padding around the bbox, in canvas-percentage units
  const w = Math.max(maxX - minX + PAD * 2, 40); // floor: at least 40% wide
  const h = Math.max(maxY - minY + PAD * 2, 40); // floor: at least 40% tall
  const aspect = w / h;
  if (aspect > 16 / 10) return 16 / 10;
  if (aspect < 1) return 1;
  return aspect;
}

// Approximate table "radius" in canvas-percent units, by seat count. Used for
// grid-based overlap detection when auto-placing new tables and finding free
// corners. Generous on purpose — better to leave a gap than to stack tables.
function tableRadius(capacity: number): number {
  if (capacity <= 2) return 7;
  if (capacity <= 4) return 9;
  if (capacity <= 6) return 11;
  if (capacity <= 8) return 14;
  return 17;
}

// Find the first empty grid cell (5% step) starting top-left so newly added
// tables drop into a free corner and never overlap existing ones.
function findNextFreePosition(
  capacity: number,
  others: Array<{ x: number; y: number; capacity: number }>,
  gridStep = 5,
): { x: number; y: number } {
  const margin = 8; // keep tables inside the visible canvas area
  const r = tableRadius(capacity);
  for (let y = margin; y <= 100 - margin; y += gridStep) {
    for (let x = margin; x <= 100 - margin; x += gridStep) {
      let ok = true;
      for (const o of others) {
        const or = tableRadius(o.capacity);
        if (Math.abs(x - o.x) < r + or && Math.abs(y - o.y) < r + or) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, y };
    }
  }
  return { x: 50, y: 50 }; // canvas full — drop near the centre as a last resort
}

// Persist the per-floor canvas size so the user's room dimensions survive a
// reload. Floor key: "__unassigned__" for the null-floor bucket.
type SavedCanvasSize = { mode: 'auto' | 'custom'; w: number; h: number };
function loadSavedCanvasSize(floor: string): SavedCanvasSize {
  const key = `floorplan.size.${floor || '__unassigned__'}`;
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.mode === 'auto' || parsed.mode === 'custom') && typeof parsed.w === 'number' && typeof parsed.h === 'number') {
        return { mode: parsed.mode, w: parsed.w, h: parsed.h };
      }
    }
  } catch { /* ignore — fall back to defaults */ }
  return { mode: 'auto', w: 10, h: 6 };
}
function saveSavedCanvasSize(floor: string, size: SavedCanvasSize): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`floorplan.size.${floor || '__unassigned__'}`, JSON.stringify(size));
  } catch { /* quota / private mode — fail silently */ }
}

export default function FloorplanEditor({ mode, canManage = false, tables, ordersByTable, onSaved, onReserve, onViewOrder }: {
  mode: 'edit' | 'service';
  canManage?: boolean;
  tables: Table[];
  ordersByTable?: Map<string, Order[]>;
  onSaved?: () => void;
  onReserve?: (tb: Table) => void;
  onViewOrder?: () => void;
}) {
  const edit = mode === 'edit' && canManage;
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const canvasRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragCtx | null>(null);
  const [edits, setEdits] = useState<Record<string, XY>>({});
  const [isOverTray, setIsOverTray] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [activeFloor, setActiveFloor] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<TableForm>(EMPTY_FORM);
  const [formSaving, setFormSaving] = useState(false);
  const [floorFormOpen, setFloorFormOpen] = useState(false);
  const [floorForm, setFloorForm] = useState({ name: '', tableName: '', capacity: '4' });
  const [floorFormSaving, setFloorFormSaving] = useState(false);
  const [actionTable, setActionTable] = useState<Table | null>(null);

  // Drop a stale action-sheet selection when entering edit mode so it never
  // pops up unexpectedly on the way back to service mode (render-time
  // adjustment, same pattern as prevFloor below).
  const [wasEdit, setWasEdit] = useState(edit);
  if (wasEdit !== edit) {
    setWasEdit(edit);
    if (edit) setActionTable(null);
  }
  const [newFloorMode, setNewFloorMode] = useState(false);
  const [newFloorName, setNewFloorName] = useState('');
  const [canvasMode, setCanvasMode] = useState<'auto' | 'custom'>(() => loadSavedCanvasSize('').mode);
  const [canvasW, setCanvasW] = useState<number>(() => loadSavedCanvasSize('').w);
  const [canvasH, setCanvasH] = useState<number>(() => loadSavedCanvasSize('').h);

  const [canvasWidth, setCanvasWidth] = useState(VIRTUAL_WIDTH);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setFormOpen(false);
      setEditingId(null);
      setFloorFormOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Render-time prop adjustment: drop converged or deleted-table overrides.
  const [syncedTables, setSyncedTables] = useState(tables);
  if (tables !== syncedTables) {
    setSyncedTables(tables);
    const prune = (prev: Record<string, XY>) => {
      let changed = false;
      const next: Record<string, XY> = {};
      for (const [id, p] of Object.entries(prev)) {
        const tb = tables.find((x) => x.id === id);
        if (!tb) {
          changed = true;
          continue;
        }
        if (p === null) {
          if (tb.position_x == null && tb.position_y == null) {
            changed = true;
            continue;
          }
        } else {
          const converged =
            tb.position_x != null &&
            tb.position_y != null &&
            Math.abs(tb.position_x - p.x) < 0.005 &&
            Math.abs(tb.position_y - p.y) < 0.005;
          if (converged) {
            changed = true;
            continue;
          }
        }
        next[id] = p;
      }
      return changed ? next : prev;
    };
    setEdits(prune);
  }

  const floors = useMemo(() => {
    const count = (f: string) => tables.filter((tb) => (tb.floor || '') === f).length;
    const named = [...new Set(tables.map((tb) => tb.floor).filter((f): f is string => Boolean(f)))]
      .sort((a, b) => count(b) - count(a) || a.localeCompare(b));
    const hasUnassigned = tables.some((tb) => !tb.floor);
    return hasUnassigned ? [...named, ''] : named;
  }, [tables]);

  const overview = activeFloor === ALL_FLOORS;
  const floor = overview ? '' : (floors.includes(activeFloor) ? activeFloor : (floors[0] ?? ''));
  const namedFloors = floors.filter((f) => f !== '');

  // Load per-floor canvas size from localStorage when the active floor changes,
  // and persist on every size change so the user's W×H (mode/w/h) survives reload.
  const [prevFloor, setPrevFloor] = useState(floor);
  if (prevFloor !== floor) {
    setPrevFloor(floor);
    const saved = loadSavedCanvasSize(floor);
    setCanvasMode(saved.mode);
    setCanvasW(saved.w);
    setCanvasH(saved.h);
  }
  useEffect(() => {
    saveSavedCanvasSize(floor, { mode: canvasMode, w: canvasW, h: canvasH });
  }, [floor, canvasMode, canvasW, canvasH]);

  const posOf = (tb: Table): { x: number; y: number } | null => {
    if (tb.id in edits) return edits[tb.id];
    if (tb.position_x != null && tb.position_y != null) return { x: tb.position_x, y: tb.position_y };
    return null;
  };

  const floorTables = tables.filter((tb) => (tb.floor || '') === floor);
  const placed = floorTables.filter((tb) => posOf(tb) !== null);
  const unplaced = floorTables.filter((tb) => posOf(tb) === null);
  // Saved positions only (no pending edits) → canvas size is stable while
  // dragging; resizes to fit on the next render after Save.
  const placedSaved = floorTables.filter((tb) => tb.position_x != null && tb.position_y != null);
  const fitAspect = computeCanvasAspect(placedSaved);
  const safeW = Math.max(1, Math.min(100, canvasW));
  const safeH = Math.max(1, Math.min(100, canvasH));
  const aspectNum = canvasMode === 'auto' ? fitAspect : safeW / safeH;
  const virtualHeight = Math.round(VIRTUAL_WIDTH / aspectNum);
  const canvasScale = canvasWidth > 0 ? canvasWidth / VIRTUAL_WIDTH : 1;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setCanvasWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Count tables per floor (including the empty-string "Unassigned" bucket)
  // so each tab can show "(N)" — makes Unassigned actionable, not mysterious.
  const floorCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const tb of tables) {
      const f = tb.floor || '';
      map.set(f, (map.get(f) ?? 0) + 1);
    }
    return map;
  }, [tables]);

  const byId = (id: string) => tables.find((tb) => tb.id === id);

  const suggestName = () => {
    const nums = tables
      .map((tb) => /(\d+)\s*$/.exec(tb.name)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  };

  const openCreate = () => {
    if (!canManage) return;
    setEditingId(null);
    setNewFloorMode(false);
    setNewFloorName('');
    setForm({ ...EMPTY_FORM, name: suggestName(), floor: !overview && namedFloors.includes(floor) ? floor : '' });
    setFormOpen(true);
  };

  const openEdit = (tb: Table) => {
    if (!canManage) return;
    setEditingId(tb.id);
    setNewFloorMode(false);
    setNewFloorName('');
    setForm({ name: tb.name, capacity: String(tb.capacity), floor: tb.floor ?? '', section: tb.section ?? '' });
    setFormOpen(true);
  };

  // Snap to a 5% grid so placements align with other tables and feel predictable.
  // (Half-step rounding so halfX/halfY padding still keeps the chip on-canvas.)
  const GRID_STEP = 5;
  const clamp = (id: string, x: number, y: number, halfX: number, halfY: number) => {
    const cx = Math.min(100 - halfX, Math.max(halfX, x));
    const cy = Math.min(100 - halfY, Math.max(halfY, y));
    setEdits((p) => ({
      ...p,
      [id]: {
        x: round2(Math.round(cx / GRID_STEP) * GRID_STEP),
        y: round2(Math.round(cy / GRID_STEP) * GRID_STEP),
      },
    }));
  };

  const startDrag = (tb: Table, centerOnPointer = false) => (e: React.PointerEvent<HTMLElement>) => {
    if (!edit) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const chip = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      id: tb.id,
      rect,
      offX: centerOnPointer ? chip.width / 2 : e.clientX - chip.left,
      offY: centerOnPointer ? chip.height / 2 : e.clientY - chip.top,
      halfX: (chip.width / 2 / rect.width) * 100,
      halfY: (chip.height / 2 / rect.height) * 100,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    setDragId(tb.id);
  };

  const onDragMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      d.moved = true;
    }
    const tray = trayRef.current;
    if (tray) {
      const tr = tray.getBoundingClientRect();
      const over =
        e.clientX >= tr.left &&
        e.clientX <= tr.right &&
        e.clientY >= tr.top &&
        e.clientY <= tr.bottom;
      setIsOverTray(over);
    }
    const x = ((e.clientX - d.rect.left - d.offX) / d.rect.width) * 100 + d.halfX;
    const y = ((e.clientY - d.rect.top - d.offY) / d.rect.height) * 100 + d.halfY;
    clamp(d.id, x, y, d.halfX, d.halfY);
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragId(null);
    setIsOverTray(false);
    if (isOverTray) {
      if (d) setEdits((p) => ({ ...p, [d.id]: null }));
      return;
    }
    if (edit && d && !d.moved) {
      const tb = byId(d.id);
      if (tb) openEdit(tb);
    }
  };

  const onChipKeyDown = (tb: Table, fromTray: boolean) => (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (fromTray) {
        const canvas = canvasRef.current;
        if (canvas && edit) {
          clamp(tb.id, 50, 50, 0, 0);
          requestAnimationFrame(() => {
            canvas.querySelector<HTMLElement>(`[data-testid="floorplan-chip-${CSS.escape(tb.name)}"]`)?.focus();
          });
        }
      } else if (edit) {
        openEdit(tb);
      } else {
        setActionTable(tb);
      }
      return;
    }
    if (fromTray || !edit) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setEdits((p) => ({ ...p, [tb.id]: null }));
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    };
    const delta = arrows[e.key];
    if (!delta) return;
    e.preventDefault();
    const cur = posOf(tb) ?? { x: 50, y: 50 };
    const canvas = canvasRef.current;
    // Step a whole grid cell so plain arrows always visibly move (a 1% nudge
    // would snap straight back); Shift jumps two cells.
    const step = e.shiftKey ? GRID_STEP * 2 : GRID_STEP;
    const rect = canvas?.getBoundingClientRect();
    const half = rect && rect.width > 0 && rect.height > 0
      ? {
          halfX: (e.currentTarget.offsetWidth / 2 / rect.width) * 100,
          halfY: (e.currentTarget.offsetHeight / 2 / rect.height) * 100,
        }
      : { halfX: 0, halfY: 0 };
    clamp(tb.id, cur.x + delta[0] * step, cur.y + delta[1] * step, half.halfX, half.halfY);
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    const capacity = parseInt(form.capacity, 10);
    const floor = newFloorMode ? newFloorName.trim() : form.floor;
    if (!name || !Number.isFinite(capacity) || capacity < 1 || (newFloorMode && !floor)) return;
    setFormSaving(true);
    try {
      if (editingId) {
        await api.put(`/tables/${editingId}`, {
          number: name,
          capacity,
          floor,
          section: form.section,
        });
        toast.success(t('tableUpdated'), { position: 'top-center' });
      } else {
        // Auto-place on the canvas at the next free grid corner so the new
        // table appears ready-to-use instead of dumping into the tray. Skip if
        // the user is in the Unassigned bucket (no floor → no placement yet).
        let position_x: number | null = null;
        let position_y: number | null = null;
        if (floor) {
          const others = placedSaved
            .filter((tb) => tb.position_x != null && tb.position_y != null)
            .map((tb) => ({ x: tb.position_x!, y: tb.position_y!, capacity: tb.capacity }));
          const pos = findNextFreePosition(capacity, others);
          position_x = pos.x;
          position_y = pos.y;
        }
        await api.post('/tables', {
          number: name,
          capacity,
          floor: floor || null,
          section: form.section || null,
          position_x,
          position_y,
        });
        toast.success(t('tableCreated'), { position: 'top-center' });
      }
      setFormOpen(false);
      setEditingId(null);
      onSaved?.();
    } catch {
      toast.error(t('tableUpdateFailed'), { position: 'top-center' });
    } finally {
      setFormSaving(false);
    }
  };

  const submitFloorForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = floorForm.name.trim();
    const tableName = floorForm.tableName.trim();
    const capacity = parseInt(floorForm.capacity, 10);
    if (!name || !tableName || !Number.isFinite(capacity) || capacity < 1) return;
    setFloorFormSaving(true);
    try {
      // First table of a brand-new floor — drop it at the top-left grid corner
      // so the new floor starts with a placed table, not an empty tray.
      const others = placedSaved
        .filter((tb) => tb.position_x != null && tb.position_y != null)
        .map((tb) => ({ x: tb.position_x!, y: tb.position_y!, capacity: tb.capacity }));
      const pos = findNextFreePosition(capacity, others);
      await api.post('/tables', {
        number: tableName,
        capacity,
        floor: name,
        position_x: pos.x,
        position_y: pos.y,
      });
      toast.success(t('tableCreated'), { position: 'top-center' });
      setFloorFormOpen(false);
      setActiveFloor(name);
      setFloorForm({ name: '', tableName: '', capacity: '4' });
      onSaved?.();
    } catch {
      toast.error(t('tableCreateFailed'), { position: 'top-center' });
    } finally {
      setFloorFormSaving(false);
    }
  };

  const seats = (capacity: number) => (
    <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
      <Users size={10} className="text-muted-foreground" />
      {t('capacitySeats', { count: capacity })}
    </span>
  );

  const activeOrderOf = (tb: Table): Order | null => {
    const list = ordersByTable?.get(tb.id);
    return list && list.length > 0 ? list[0] : null;
  };

  const TableObject = ({ tb, scale = 1, dragging = false }: { tb: Table; scale?: number; dragging?: boolean }) => {
    const { w, h, round } = shapeFor(tb.capacity, scale);
    const chairs = chairPoints(tb.capacity, w, h, round);
    const reservedName = tb.status === 'reserved' ? tb.reservation_customer_name : null;
    const activeOrder = activeOrderOf(tb);
    const seatedAt = tb.seated_at || activeOrder?.created_at;

    return (
      <div className="relative" data-seats={tb.capacity} style={{ width: w, height: h }}>
        {chairs.map((c, i) => (
          <span
            key={i}
            className={`absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-card shadow-sm ${
              scale < 1 ? 'h-[6px] w-[6px]' : ''
            }`}
            style={{ left: c.x, top: c.y }}
          />
        ))}
        <div
          className={`flex h-full w-full flex-col items-center justify-center gap-0.5 bg-card px-1 ${
            round ? 'rounded-full' : 'rounded-xl'
          } border-[3px] ${statusRing[tb.status]} ${dragging ? 'shadow-2xl' : 'shadow-md'}`}
        >
          <span className={`max-w-full truncate font-bold leading-tight text-foreground ${scale < 1 ? 'text-[9px]' : 'text-[13px]'}`}>
            <Ltr>{tb.name}</Ltr>
          </span>
          {scale >= 1 && (
            <>
              <span className={`text-[9px] font-semibold uppercase tracking-wide ${statusText[tb.status]}`}>
                {t(TABLE_STATUS_LABEL_KEYS[tb.status])}
              </span>
              {tb.status === 'occupied' && seatedAt && (
                <div className="max-w-full truncate">
                  <TableTurnoverBadge seatedAt={seatedAt} />
                </div>
              )}
              {activeOrder && (
                <span className="max-w-full truncate text-[9px] font-semibold text-muted-foreground">
                  <Ltr>#{activeOrder.order_number}</Ltr>
                </span>
              )}
              {reservedName && (
                <span className="max-w-full truncate text-[9px] font-medium text-amber-600 dark:text-amber-400" title={reservedName}>
                  {reservedName}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const setTableStatus = async (tb: Table, status: Table['status']) => {
    try {
      await api.patch(`/tables/${tb.id}/status`, { status });
      toast.success(t(TABLE_STATUS_LABEL_KEYS[status]), { position: 'top-center' });
      setActionTable(null);
      onSaved?.();
    } catch {
      toast.error(t('tableUpdateFailed'), { position: 'top-center' });
    }
  };

  const sheetActionsFor = (tb: Table) => {
    const actions: Array<{ label: string; icon: React.ReactNode; run: () => void }> = [];
    if (tb.status === 'available') {
      actions.push({ label: t('reserveTable'), icon: <Users size={15} />, run: () => { setActionTable(null); onReserve?.(tb); } });
      actions.push({ label: t('markCleaning'), icon: <Sparkles size={15} />, run: () => setTableStatus(tb, 'cleaning') });
    }
    if (tb.status === 'occupied' && onViewOrder) {
      actions.push({ label: t('viewOrder'), icon: <Eye size={15} />, run: () => { setActionTable(null); onViewOrder(); } });
    }
    if (tb.status !== 'available' && tb.status !== 'occupied') {
      actions.push({ label: t('markAvailable'), icon: <Table2 size={15} />, run: () => setTableStatus(tb, 'available') });
    }
    if (canManage) {
      actions.push({ label: t('editTable'), icon: <Pencil size={15} />, run: () => { setActionTable(null); openEdit(tb); } });
      if (posOf(tb) !== null) {
        actions.push({
          label: tCommon('remove'),
          icon: <Trash2 size={15} />,
          run: () => {
            setActionTable(null);
            setEdits((p) => ({ ...p, [tb.id]: null }));
          },
        });
      }
    }
    return actions;
  };

  const renderChip = (tb: Table) => {
    const p = posOf(tb)!;
    const dragging = dragId === tb.id;
    return (
      <div
        key={tb.id}
        role="button"
        tabIndex={0}
        data-testid={`floorplan-chip-${tb.name}`}
        aria-label={`${tb.name} — ${t(TABLE_STATUS_LABEL_KEYS[tb.status])}. ${t('floorplanAriaHint')}`}
        aria-keyshortcuts="Enter ArrowUp ArrowDown ArrowLeft ArrowRight"
        title={t('floorplanEditHint')}
        onPointerDown={startDrag(tb)}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onChipKeyDown(tb, false)}
        onClick={!edit ? () => setActionTable(tb) : undefined}
        className={`absolute -translate-x-1/2 -translate-y-1/2 select-none touch-none rounded-2xl p-[9px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
          edit
            ? `cursor-grab ${dragging ? 'z-20 scale-110 cursor-grabbing shadow-2xl' : 'transition-transform hover:scale-[1.03]'}`
            : 'cursor-pointer'
        } ${!tb.is_active ? 'opacity-50' : ''}`}
        style={{ left: `${p.x}%`, top: `${p.y}%` }}
      >
        <TableObject tb={tb} dragging={dragging} />
      </div>
    );
  };

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-1 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-b-2xl bg-card px-2 py-2.5 shadow-sm">
        <div data-testid="floorplan-floor-tabs" className="flex flex-wrap items-center gap-1 rounded-xl bg-muted/50 p-1 border border-border">
          <button
            onClick={() => setActiveFloor(ALL_FLOORS)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
              overview ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <LayoutGrid size={14} /> {t('floorplanAllFloors')}
          </button>
          {floors.map((f) => {
            const count = floorCounts.get(f) ?? 0;
            const label = f || t('floorplanUnassigned');
            return (
              <button
                key={f || 'unassigned'}
                onClick={() => setActiveFloor(f)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                  !overview && f === floor ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                title={f === '' ? t('floorplanUnassignedHint') : undefined}
              >
                {label}
                {count > 0 && (
                  <span className={`rounded-full px-1.5 text-[10px] font-semibold ${
                    !overview && f === floor ? 'bg-muted text-foreground' : 'bg-card/70 text-muted-foreground'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          {canManage && (
            <button
              data-testid="floorplan-add-floor"
              onClick={() => {
                setFloorForm({ name: '', tableName: suggestName(), capacity: '4' });
                setFloorFormOpen(true);
              }}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:text-brand"
              title={t('addFloor')}
            >
              <Plus size={14} /> {t('addFloor')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center gap-1 rounded-xl bg-muted/50 p-1 border border-border"
            role="group"
            aria-label={t('floorplanCanvasSize')}
          >
            <button
              onClick={() => setCanvasMode('auto')}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                canvasMode === 'auto' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              title={t('floorplanAutoHint')}
              aria-pressed={canvasMode === 'auto'}
            >
              <Minimize2 size={12} /> {t('floorplanAuto')}
            </button>
            <div
              className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs ${
                edit ? 'cursor-text' : 'cursor-not-allowed'
              } ${
                canvasMode === 'custom' && edit ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
              }`}
              title={edit ? t('floorplanCustomHint') : t('floorplanCustomLockedHint')}
              onClick={() => edit && setCanvasMode('custom')}
            >
              <Maximize2 size={12} />
              <input
                type="number"
                value={canvasW}
                disabled={!edit}
                onFocus={() => edit && setCanvasMode('custom')}
                onChange={(e) => {
                  if (!edit) return;
                  setCanvasMode('custom');
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setCanvasW(n);
                }}
                className={`w-12 rounded border px-1 py-0.5 text-center text-xs font-medium ${
                  edit
                    ? 'border-border bg-card text-foreground focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'
                    : 'border-border/50 bg-muted/50 text-muted-foreground/50 cursor-not-allowed'
                }`}
                min={1}
                max={100}
                step={0.5}
                aria-label={t('floorplanCanvasWidth')}
              />
              <span className="text-muted-foreground">×</span>
              <input
                type="number"
                value={canvasH}
                disabled={!edit}
                onFocus={() => edit && setCanvasMode('custom')}
                onChange={(e) => {
                  if (!edit) return;
                  setCanvasMode('custom');
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setCanvasH(n);
                }}
                className={`w-12 rounded border px-1 py-0.5 text-center text-xs font-medium ${
                  edit
                    ? 'border-border bg-card text-foreground focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'
                    : 'border-border/50 bg-muted/50 text-muted-foreground/50 cursor-not-allowed'
                }`}
                min={1}
                max={100}
                step={0.5}
                aria-label={t('floorplanCanvasHeight')}
              />
              <span className="text-muted-foreground">m</span>
            </div>
          </div>
          {edit && (
            <button
              data-testid="floorplan-add"
              onClick={openCreate}
              className="flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
              title={t('addTable')}
            >
              <Plus size={14} /> {t('addTable')}
            </button>
          )}
          {edit && (
            <>
              {Object.keys(edits).length > 0 && (
                <span className="flex items-center gap-1.5 rounded-full bg-amber-50 dark:bg-amber-950/40 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  {Object.keys(edits).length}
                </span>
              )}
              {Object.keys(edits).length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setEdits({})} disabled={saving}>
                  {tCommon('cancel')}
                </Button>
              )}
              <Button onClick={save} disabled={saving || Object.keys(edits).length === 0} className="shadow">
                {saving ? tCommon('saving') : tCommon('save')}
              </Button>
            </>
          )}
        </div>
      </div>

      {overview ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {floors.map((f) => {
            const ft = tables.filter((tb) => (tb.floor || '') === f);
            const ftPlaced = ft.filter((tb) => posOf(tb) !== null);
            const ftPlacedSaved = ft.filter((tb) => tb.position_x != null && tb.position_y != null);
            return (
              <div key={f || 'unassigned'} data-testid={`floorplan-mini-${f || 'unassigned'}`} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-bold text-foreground">{f || t('floorplanUnassigned')}</p>
                  <button
                    onClick={() => setActiveFloor(f)}
                    className="text-xs font-semibold text-brand hover:text-brand-hover"
                  >
                    {tCommon('edit')} →
                  </button>
                </div>
                <div
                  className="pointer-events-none relative mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card/50 text-muted-foreground/30"
                  style={{
                    aspectRatio: computeCanvasAspect(ftPlacedSaved),
                    backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)',
                    backgroundSize: '22px 22px',
                  }}
                >
                  {ftPlaced.map((tb) => {
                    const p = posOf(tb)!;
                    return (
                      <div
                        key={tb.id}
                        className="absolute -translate-x-1/2 -translate-y-1/2"
                        style={{ left: `${p.x}%`, top: `${p.y}%` }}
                      >
                        <TableObject tb={tb} scale={0.5} />
                      </div>
                    );
                  })}
                  {ftPlaced.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <p className="text-xs text-muted-foreground">{t('noTablesYet')}</p>
                    </div>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('floorplanUnplaced')}: {ft.filter((tb) => posOf(tb) === null).length}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">{t('floorplanHint')}</p>

          <div
            ref={canvasRef}
            data-testid="floorplan-canvas"
            className={`relative mx-auto w-full overflow-hidden rounded-2xl border border-border bg-card/50 text-muted-foreground/30 shadow-inner ${
              canvasMode === 'auto' ? 'max-w-3xl' : ''
            }`}
            style={{
              aspectRatio: aspectNum,
              backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)',
              backgroundSize: '26px 26px',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: VIRTUAL_WIDTH,
                height: virtualHeight,
                transform: `scale(${canvasScale})`,
                transformOrigin: 'top left',
              }}
            >
              <div className="relative w-full h-full">
                {placed.map(renderChip)}
              </div>
            </div>
            {placed.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Table2 size={16} className="shrink-0" />
                  {tables.length === 0 ? t('noTablesYet') : t('floorplanEmptyCanvas')}
                </p>
              </div>
            )}
          </div>
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {LEGEND.map((s) => (
          <span key={s} className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
            <span className={`inline-block h-2 w-2 rounded-full ${statusDot[s]}`} />
            {t(TABLE_STATUS_LABEL_KEYS[s])}
          </span>
        ))}
      </div>

      {!overview && (edit || unplaced.length > 0) && (
        <div
          ref={trayRef}
          className={`mt-5 rounded-2xl border-2 border-dashed p-3 transition-colors ${
            isOverTray
              ? 'border-brand bg-brand/10 ring-2 ring-brand'
              : 'border-border bg-card/60'
          }`}
        >
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('floorplanUnplaced')} ({unplaced.length})
            </p>
            {edit && (
              <span className="text-[11px] text-muted-foreground">
                {t('floorplanEmptyCanvas')}
              </span>
            )}
          </div>
          {unplaced.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {t('floorplanEmptyCanvas')}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {unplaced.map((tb) => (
                <div
                  key={tb.id}
                  role="button"
                  tabIndex={0}
                  data-testid={`floorplan-tray-${tb.name}`}
                  aria-label={`${tb.name} — ${t('floorplanUnplaced')}. ${t('floorplanAriaHint')}`}
                  aria-keyshortcuts="Enter"
                  title={t('floorplanEditHint')}
                  onPointerDown={startDrag(tb, true)}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onClick={!edit ? () => setActionTable(tb) : undefined}
                  onKeyDown={onChipKeyDown(tb, true)}
                  className={`flex select-none items-center gap-2.5 rounded-xl border-2 bg-card px-3 py-2 shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                    statusRing[tb.status]
                  } ${edit ? 'cursor-grab touch-none' : 'cursor-pointer'} ${dragId === tb.id ? 'opacity-40' : ''}`}
                >
                  <span className={`h-7 w-7 rounded-lg border-2 ${statusRing[tb.status]} ${tb.capacity <= 2 ? 'rounded-full' : ''}`} />
                  <span className="text-sm font-bold text-foreground">
                    <Ltr>{tb.name}</Ltr>
                  </span>
                  {seats(tb.capacity)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {actionTable && !edit && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={() => setActionTable(null)}>
          <div
            className="w-full max-w-sm rounded-t-2xl bg-card p-5 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={actionTable.name}
          >
            <div className="mb-4 flex items-center gap-3">
              <span className={`h-3 w-3 rounded-full ${statusDot[actionTable.status]}`} />
              <div>
                <p className="text-base font-bold text-foreground">
                  <Ltr>{actionTable.name}</Ltr>
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className={`text-xs font-semibold uppercase tracking-wide ${statusText[actionTable.status]}`}>
                    {t(TABLE_STATUS_LABEL_KEYS[actionTable.status])} · {seats(actionTable.capacity)}
                  </p>
                  {actionTable.status === 'occupied' && (actionTable.seated_at || activeOrderOf(actionTable)?.created_at) && (
                    <TableTurnoverBadge seatedAt={(actionTable.seated_at || activeOrderOf(actionTable)?.created_at)!} />
                  )}
                </div>
              </div>
            </div>
            <div className="space-y-2">
              {sheetActionsFor(actionTable).map((a) => (
                <button
                  key={a.label}
                  onClick={() => a.run()}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  {a.icon}
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {formOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => { setFormOpen(false); setEditingId(null); }}>
          <div className="bg-card text-foreground rounded-2xl p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="floorplan-table-form" role="dialog" aria-modal="true">
            <h2 className="text-lg font-bold mb-4">{editingId ? t('editTable') : t('addTable')}</h2>
            <form onSubmit={submitForm} className="space-y-4">
              <div>
                <label htmlFor="floorplan-table-name" className="block text-sm font-medium text-foreground mb-1">
                  {t('tableName')}
                </label>
                <input
                  id="floorplan-table-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('tableNamePlaceholder')}
                  className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  autoFocus
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="floorplan-table-capacity" className="block text-sm font-medium text-foreground mb-1">
                    {t('capacity')}
                  </label>
                  <input
                    id="floorplan-table-capacity"
                    type="number"
                    min="1"
                    value={form.capacity}
                    onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="floorplan-table-floor" className="block text-sm font-medium text-foreground mb-1">
                    {t('floor')}
                  </label>
                  {newFloorMode ? (
                    <input
                      id="floorplan-table-newfloor"
                      type="text"
                      value={newFloorName}
                      onChange={(e) => setNewFloorName(e.target.value)}
                      placeholder={t('floorName')}
                      className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                      autoFocus
                      required
                    />
                  ) : (
                    <select
                      id="floorplan-table-floor"
                      value={form.floor}
                      onChange={(e) => {
                        if (e.target.value === '__new__') {
                          setNewFloorMode(true);
                          setNewFloorName('');
                        } else {
                          setForm({ ...form, floor: e.target.value });
                        }
                      }}
                      className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    >
                      {form.floor === '' && <option value="">{t('floorplanUnassigned')}</option>}
                      {namedFloors.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                      {form.floor !== '' && !namedFloors.includes(form.floor) && (
                        <option value={form.floor}>{form.floor}</option>
                      )}
                      <option value="__new__">+ {t('newFloor')}</option>
                    </select>
                  )}
                </div>
              </div>
              <div>
                <label htmlFor="floorplan-table-section" className="block text-sm font-medium text-foreground mb-1">
                  {t('section')}
                </label>
                <input
                  id="floorplan-table-section"
                  type="text"
                  value={form.section}
                  onChange={(e) => setForm({ ...form, section: e.target.value })}
                  className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setFormOpen(false);
                    setEditingId(null);
                  }}
                  disabled={formSaving}
                >
                  {tCommon('cancel')}
                </Button>
                <Button type="submit" className="flex-1" disabled={formSaving}>
                  {formSaving ? tCommon('saving') : editingId ? tCommon('save') : t('createTable')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {floorFormOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setFloorFormOpen(false)}>
          <div className="bg-card text-foreground rounded-2xl p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="floorplan-floor-form" role="dialog" aria-modal="true">
            <h2 className="text-lg font-bold mb-4">{t('newFloor')}</h2>
            <form onSubmit={submitFloorForm} className="space-y-4">
              <div>
                <label htmlFor="floorplan-floor-name" className="block text-sm font-medium text-foreground mb-1">
                  {t('floorName')}
                </label>
                <input
                  id="floorplan-floor-name"
                  type="text"
                  value={floorForm.name}
                  onChange={(e) => setFloorForm({ ...floorForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  autoFocus
                  required
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('floorplanEmptyCanvas')}</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="floorplan-floor-table" className="block text-sm font-medium text-foreground mb-1">
                    {t('tableName')}
                  </label>
                  <input
                    id="floorplan-floor-table"
                    type="text"
                    value={floorForm.tableName}
                    onChange={(e) => setFloorForm({ ...floorForm, tableName: e.target.value })}
                    className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="floorplan-floor-capacity" className="block text-sm font-medium text-foreground mb-1">
                    {t('capacity')}
                  </label>
                  <input
                    id="floorplan-floor-capacity"
                    type="number"
                    min="1"
                    value={floorForm.capacity}
                    onChange={(e) => setFloorForm({ ...floorForm, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    required
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setFloorFormOpen(false)} disabled={floorFormSaving}>
                  {tCommon('cancel')}
                </Button>
                <Button type="submit" className="flex-1" disabled={floorFormSaving}>
                  {floorFormSaving ? tCommon('saving') : t('createTable')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );

  async function save() {
    if (!canManage) return;
    const known = new Set(tables.map((tb) => tb.id));
    const changed = Object.entries(edits).filter(([id]) => known.has(id));
    if (changed.length === 0) return;
    setSaving(true);
    try {
      await api.patch('/tables/positions', {
        positions: changed.map(([id, p]) => ({
          id,
          position_x: p ? p.x : null,
          position_y: p ? p.y : null,
        })),
      });
      setEdits({});
      onSaved?.();
      toast.success(t('floorplanSaved'), { position: 'top-center' });
    } catch {
      toast.error(t('floorplanSaveFailed'), { position: 'top-center' });
    } finally {
      setSaving(false);
    }
  }
}

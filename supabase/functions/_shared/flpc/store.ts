// Postgres-backed store (hosted counterpart of api/flpc/store.py).
//
// The data tables live in the `flpc` schema and are replaced as a whole by
// flpc.load_bundle(). Small dimensions (periods, companies, groups, policy
// types, metric availability) are cached per function instance and reloaded
// when meta.load_id changes, which a cheap one-row read detects.

export interface Db {
  /** Rows as arrays, in select-list order. */
  values(sql: string, params?: unknown[]): Promise<unknown[][]>;
  /** Rows as objects. */
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Company {
  naic: string;
  name: string;
  names: string[];
  group_id: string;
  group_name: string;
  first: string;
  last: string;
}

export interface Group {
  name: string;
  standalone: boolean;
  members: string[];
}

export interface PolicyType {
  id: string;
  name: string;
  line: string;
  product: string;
  wind_only: boolean;
}

/** Non-metric columns of flpc.facts; every other column is a metric. */
export const FACT_DIMS = ["period", "idx", "naic", "group_id", "pt_id", "line", "product", "wind_only"];

const RECHECK_MS = 5_000;

export class Store {
  db: Db;
  loadId: string | null = null;
  version = 0;
  lastError: string | null = null;
  meta: Record<string, string> = {};
  periods: [string, number][] = [];
  periodIdx = new Map<string, number>();
  idxPeriod = new Map<number, string>();
  metricCols: string[] = [];
  metricAvail = new Map<string, [number, number]>();
  companies = new Map<string, Company>();
  groups = new Map<string, Group>();
  policyTypes = new Map<string, PolicyType>();
  sizeCache: [number, Map<string, number>] | null = null;
  private checkedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  get latestIdx(): number {
    return this.periods[this.periods.length - 1][1];
  }

  get loaded(): boolean {
    return this.periods.length > 0;
  }

  available(metric: string, idx: number): boolean {
    const a = this.metricAvail.get(metric);
    return !!a && a[0] <= idx && idx <= a[1];
  }

  /** Make sure the cached dimensions match the loaded data (checked every few seconds). */
  async ensure(force = false): Promise<this> {
    const now = Date.now();
    if (!force && this.loaded && now - this.checkedAt < RECHECK_MS) return this;
    if (this.loading) {
      await this.loading;
      return this;
    }
    this.loading = (async () => {
      const r = await this.db.rows<{ value: string }>("SELECT value FROM flpc.meta WHERE key = 'load_id'");
      const lid = r[0]?.value ?? null;
      if (force || lid !== this.loadId || !this.loaded) await this.loadDims(lid);
      this.checkedAt = Date.now();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
    return this;
  }

  /** Forget the cache (after a data load in this instance). */
  invalidate() {
    this.checkedAt = 0;
    this.loadId = "\0stale";
  }

  private async loadDims(lid: string | null) {
    const db = this.db;
    const [meta, periods, cols, avail, comps, groups, pts] = await Promise.all([
      db.rows<{ key: string; value: string }>("SELECT key, value FROM flpc.meta"),
      db.rows<{ period: string; idx: number }>("SELECT period, idx FROM flpc.periods ORDER BY idx"),
      db.rows<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'flpc' AND table_name = 'facts' " +
          "ORDER BY ordinal_position"),
      db.rows<{ metric: string; first_period: string; last_period: string }>(
        "SELECT metric, first_period, last_period FROM flpc.metrics"),
      db.rows<Record<string, string>>(
        "SELECT naic, name, names, group_id, group_name, first_period, last_period FROM flpc.companies ORDER BY ord"),
      db.rows<{ group_id: string; group_name: string; standalone: number; members: string }>(
        "SELECT group_id, group_name, standalone, members FROM flpc.groups ORDER BY ord"),
      db.rows<{ pt_id: string; policy_type: string; line: string; product: string; wind_only: number }>(
        `SELECT pt_id, policy_type, line, product, wind_only FROM flpc.policy_types ORDER BY pt_id COLLATE "C"`),
    ]);
    if (!periods.length) throw new Error("no data loaded yet: run the ETL with --push (see docs/SUPABASE.md)");
    this.meta = Object.fromEntries(meta.map((r) => [r.key, r.value]));
    this.periods = periods.map((r) => [r.period, r.idx]);
    this.periodIdx = new Map(this.periods);
    this.idxPeriod = new Map(this.periods.map(([p, i]) => [i, p]));
    this.metricCols = cols.map((r) => r.column_name).filter((c) => !FACT_DIMS.includes(c));
    this.metricAvail = new Map(avail.map((r) => [r.metric, [this.periodIdx.get(r.first_period)!,
      this.periodIdx.get(r.last_period)!]]));
    this.companies = new Map(comps.map((r) => [r.naic, {
      naic: r.naic, name: r.name, names: r.names ? r.names.split(" | ") : [], group_id: r.group_id,
      group_name: r.group_name, first: r.first_period, last: r.last_period,
    }]));
    this.groups = new Map(groups.map((r) => [r.group_id, {
      name: r.group_name, standalone: !!r.standalone, members: r.members.split(","),
    }]));
    this.policyTypes = new Map(pts.map((r) => [r.pt_id, {
      id: r.pt_id, name: r.policy_type, line: r.line, product: r.product, wind_only: !!r.wind_only,
    }]));
    this.loadId = lid;
    this.sizeCache = null;
    this.version++;
  }
}

import { pickRandom } from './BaseGenerator'

export interface ErrorTemplate {
  message: string
  level: 'WARN' | 'ERROR' | 'FATAL'
}

/**
 * Each error scenario maps to a set of realistic log messages that would
 * appear during that type of incident.  Generators pick randomly from
 * the array so successive ticks look slightly different.
 */

// ─── shared across all services ───────────────────────────────────────
const CONNECTION_REFUSED: ErrorTemplate[] = [
  { message: 'connect() failed: Connection refused', level: 'ERROR' },
  { message: 'Connection refused (ECONNREFUSED)', level: 'ERROR' },
]
const CONNECTION_TIMEOUT: ErrorTemplate[] = [
  { message: 'Connection timed out', level: 'ERROR' },
  { message: 'Connection timed out after 30000ms', level: 'ERROR' },
]
const CONNECTION_RESET: ErrorTemplate[] = [
  { message: 'Connection reset by peer', level: 'ERROR' },
  { message: 'Connection reset (ECONNRESET)', level: 'ERROR' },
]

// ─── Node.js ──────────────────────────────────────────────────────────
const NODEJS_SCENARIOS: Record<string, ErrorTemplate[]> = {
  'connection-refused': [
    { message: 'Error: connect ECONNREFUSED 127.0.0.1:5432', level: 'ERROR' },
    { message: 'Error: connect ECONNREFUSED 127.0.0.1:6379', level: 'ERROR' },
    { message: 'Error: connect ECONNREFUSED 10.0.1.5:3306', level: 'ERROR' },
  ],
  'connection-timeout': [
    { message: 'Error: ETIMEDOUT: connection timed out', level: 'ERROR' },
    { message: 'Error: ESOCKETTIMEDOUT: socket timed out waiting for connect', level: 'ERROR' },
  ],
  'heap-oom': [
    { message: 'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory', level: 'FATAL' },
    { message: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', level: 'FATAL' },
    { message: 'Error: ENOMEM: not enough memory, cannot allocate', level: 'ERROR' },
  ],
  'unhandled-rejection': [
    { message: 'UnhandledPromiseRejectionWarning: Error: Request timeout after 30000ms', level: 'ERROR' },
    { message: 'UnhandledPromiseRejectionWarning: TypeError: fetch failed', level: 'ERROR' },
    { message: 'UnhandledPromiseRejectionWarning: Error: socket hang up', level: 'ERROR' },
  ],
  'type-error': [
    { message: "TypeError: Cannot read properties of undefined (reading 'id')", level: 'ERROR' },
    { message: "TypeError: Cannot read properties of null (reading 'map')", level: 'ERROR' },
    { message: "TypeError: Cannot read properties of undefined (reading 'length')", level: 'ERROR' },
    { message: "TypeError: response.json is not a function", level: 'ERROR' },
  ],
  'econnreset': [
    { message: 'Error: ECONNRESET: socket hang up', level: 'ERROR' },
    { message: 'Error: read ECONNRESET', level: 'ERROR' },
    { message: 'Error: write ECONNRESET', level: 'ERROR' },
  ],
  'disk-pressure': [
    { message: 'Error: ENOSPC: no space left on device, write', level: 'ERROR' },
    { message: 'Error: ENOSPC: no space left on device, open \'/tmp/upload-123\'', level: 'ERROR' },
  ],
  'too-many-open-files': [
    { message: 'Error: EMFILE: too many open files, open \'/var/log/app.log\'', level: 'ERROR' },
    { message: 'Error: ENFILE: file table overflow', level: 'ERROR' },
  ],
  'event-loop-blocked': [
    { message: 'WARNING: Event loop blocked for 2345ms', level: 'WARN' },
    { message: 'WARNING: Event loop lag detected: 5012ms', level: 'WARN' },
    { message: 'RangeError: Maximum call stack size exceeded', level: 'ERROR' },
  ],
}

// ─── Golang ───────────────────────────────────────────────────────────
const GOLANG_SCENARIOS: Record<string, ErrorTemplate[]> = {
  'connection-refused': [
    { message: 'dial tcp 10.0.1.5:5432: connect: connection refused', level: 'ERROR' },
    { message: 'dial tcp 10.0.1.8:6379: connect: connection refused', level: 'ERROR' },
  ],
  'connection-timeout': [
    { message: 'dial tcp 10.0.1.5:5432: i/o timeout', level: 'ERROR' },
    { message: 'context deadline exceeded', level: 'ERROR' },
    { message: 'context deadline exceeded (Client.Timeout exceeded while awaiting headers)', level: 'ERROR' },
  ],
  'nil-pointer': [
    { message: 'panic: runtime error: invalid memory address or nil pointer dereference', level: 'FATAL' },
    { message: 'panic: runtime error: invalid memory address or nil pointer dereference\n\tgoroutine 42 [running]', level: 'FATAL' },
  ],
  'index-out-of-range': [
    { message: 'panic: runtime error: index out of range [5] with length 3', level: 'FATAL' },
    { message: 'panic: runtime error: index out of range [0] with length 0', level: 'FATAL' },
  ],
  'broken-pipe': [
    { message: 'write tcp 10.0.0.5:8080->10.0.0.1:54321: write: broken pipe', level: 'ERROR' },
    { message: 'write tcp 10.0.0.5:8080->10.0.0.2:49812: write: connection reset by peer', level: 'ERROR' },
  ],
  'context-canceled': [
    { message: 'context canceled', level: 'WARN' },
    { message: 'http: server closed idle connection', level: 'WARN' },
    { message: 'http2: server sent GOAWAY and closed the connection', level: 'WARN' },
  ],
  'tls-error': [
    { message: 'tls: failed to verify certificate: x509: certificate has expired', level: 'ERROR' },
    { message: 'tls: failed to verify certificate: x509: certificate signed by unknown authority', level: 'ERROR' },
  ],
  'goroutine-leak': [
    { message: 'runtime: goroutine stack exceeds 1000000000-byte limit', level: 'FATAL' },
    { message: 'runtime: too many goroutines (100001)', level: 'FATAL' },
    { message: 'WARNING: goroutine count at 50234, possible leak detected', level: 'WARN' },
  ],
}

// ─── PostgreSQL ───────────────────────────────────────────────────────
const POSTGRES_SCENARIOS: Record<string, ErrorTemplate[]> = {
  'connection-refused': CONNECTION_REFUSED,
  'too-many-connections': [
    { message: 'FATAL:  too many connections for role "app"', level: 'FATAL' },
    { message: 'FATAL:  remaining connection slots are reserved for non-replication superuser connections', level: 'FATAL' },
  ],
  'deadlock': [
    { message: 'ERROR:  deadlock detected', level: 'ERROR' },
    { message: 'DETAIL:  Process 12345 waits for ShareLock on transaction 67890; blocked by process 11111.', level: 'ERROR' },
  ],
  'unique-violation': [
    { message: 'ERROR:  duplicate key value violates unique constraint "users_email_key"', level: 'ERROR' },
    { message: 'ERROR:  duplicate key value violates unique constraint "orders_pkey"', level: 'ERROR' },
    { message: 'DETAIL:  Key (email)=(user@example.com) already exists.', level: 'ERROR' },
  ],
  'statement-timeout': [
    { message: 'ERROR:  canceling statement due to statement timeout', level: 'ERROR' },
    { message: 'ERROR:  canceling autovacuum task', level: 'ERROR' },
  ],
  'auth-failure': [
    { message: 'FATAL:  password authentication failed for user "app"', level: 'FATAL' },
    { message: 'FATAL:  no pg_hba.conf entry for host "10.0.0.5", user "app", database "app_db"', level: 'FATAL' },
  ],
  'out-of-memory': [
    { message: 'ERROR:  out of shared memory', level: 'ERROR' },
    { message: 'HINT:  You might need to increase max_locks_per_transaction.', level: 'ERROR' },
  ],
  'disk-full': [
    { message: 'PANIC:  could not write to file "pg_wal/xlogtemp.123": No space left on device', level: 'FATAL' },
    { message: 'ERROR:  could not extend file "base/16384/16385": No space left on device', level: 'ERROR' },
    { message: 'LOG:  checkpointer process (PID 123) was terminated by signal 9: Killed', level: 'ERROR' },
  ],
  'serialization-failure': [
    { message: 'ERROR:  could not serialize access due to concurrent update', level: 'ERROR' },
    { message: 'ERROR:  could not serialize access due to read/write dependencies among transactions', level: 'ERROR' },
  ],
}

// ─── MySQL ────────────────────────────────────────────────────────────
const MYSQL_SCENARIOS: Record<string, ErrorTemplate[]> = {
  'connection-refused': [
    { message: "ERROR 2003 (HY000): Can't connect to MySQL server on '10.0.1.5' (111)", level: 'ERROR' },
    { message: "ERROR 2003 (HY000): Can't connect to MySQL server on '10.0.1.5' (110 Connection timed out)", level: 'ERROR' },
  ],
  'too-many-connections': [
    { message: 'ERROR 1040 (HY000): Too many connections', level: 'ERROR' },
    { message: "[Warning] Aborted connection 1234 to db: 'app_db' user: 'app' host: '10.0.0.5' (Got timeout reading communication packets)", level: 'WARN' },
  ],
  'deadlock': [
    { message: 'ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction', level: 'ERROR' },
  ],
  'lock-wait-timeout': [
    { message: 'ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction', level: 'ERROR' },
  ],
  'duplicate-entry': [
    { message: "ERROR 1062 (23000): Duplicate entry 'user@example.com' for key 'users.email'", level: 'ERROR' },
    { message: "ERROR 1062 (23000): Duplicate entry '42' for key 'PRIMARY'", level: 'ERROR' },
  ],
  'table-not-found': [
    { message: "ERROR 1146 (42S02): Table 'app_db.nonexistent' doesn't exist", level: 'ERROR' },
  ],
  'access-denied': [
    { message: "ERROR 1045 (28000): Access denied for user 'app'@'10.0.0.5' (using password: YES)", level: 'ERROR' },
  ],
  'disk-full': [
    { message: "ERROR 1114 (HY000): The table 'events' is full", level: 'ERROR' },
    { message: "ERROR 1016 (HY000): Can't open file: 'events.ibd' (errno: 24 - Too many open files)", level: 'ERROR' },
    { message: '[ERROR] InnoDB: Unable to lock ./ibdata1 error: 11', level: 'ERROR' },
  ],
  'lost-connection': [
    { message: 'ERROR 2013 (HY000): Lost connection to MySQL server during query', level: 'ERROR' },
    { message: "ERROR 2006 (HY000): MySQL server has gone away", level: 'ERROR' },
  ],
}

// ─── Redis ────────────────────────────────────────────────────────────
const REDIS_SCENARIOS: Record<string, ErrorTemplate[]> = {
  'connection-refused': CONNECTION_REFUSED,
  'oom': [
    { message: "OOM command not allowed when used memory > 'maxmemory'", level: 'ERROR' },
    { message: "OOM command not allowed when used memory > 'maxmemory'. Used: 268435456, max: 268435456", level: 'ERROR' },
  ],
  'readonly-replica': [
    { message: "READONLY You can't write against a read only replica", level: 'ERROR' },
    { message: "READONLY You can't write against a read only replica.", level: 'ERROR' },
  ],
  'cluster-down': [
    { message: 'CLUSTERDOWN The cluster is down', level: 'FATAL' },
    { message: 'CLUSTERDOWN Hash slot not served', level: 'FATAL' },
  ],
  'busy-script': [
    { message: 'BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.', level: 'ERROR' },
  ],
  'persistence-error': [
    { message: 'MISCONF Redis is configured to save RDB snapshots, but is currently not able to persist on disk.', level: 'ERROR' },
    { message: "Can't save in background: fork: Cannot allocate memory", level: 'ERROR' },
  ],
  'max-clients': [
    { message: 'ERR max number of clients reached', level: 'ERROR' },
  ],
  'loading': [
    { message: 'LOADING Redis is loading the dataset in memory', level: 'ERROR' },
    { message: 'LOADING Redis is loading the dataset in memory. Loading 67% complete.', level: 'ERROR' },
  ],
}

// ─── Nginx ────────────────────────────────────────────────────────────
const NGINX_SCENARIOS: Record<string, ErrorTemplate[]> = {
  'connection-refused': [
    { message: 'connect() failed (111: Connection refused) while connecting to upstream', level: 'ERROR' },
  ],
  'upstream-timeout': [
    { message: 'upstream timed out (110: Connection timed out) while reading response header from upstream', level: 'ERROR' },
    { message: 'upstream timed out (110: Connection timed out) while connecting to upstream', level: 'ERROR' },
  ],
  'no-live-upstreams': [
    { message: 'no live upstreams while connecting to upstream', level: 'ERROR' },
  ],
  'upstream-reset': [
    { message: 'recv() failed (104: Connection reset by peer) while reading response header from upstream', level: 'ERROR' },
    { message: 'upstream prematurely closed connection while reading response header from upstream', level: 'ERROR' },
  ],
  'ssl-error': [
    { message: 'SSL_do_handshake() failed (SSL: error:14094410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure)', level: 'ERROR' },
    { message: 'SSL_do_handshake() failed (SSL: error:14094412:SSL routines:ssl3_read_bytes:sslv3 alert bad certificate)', level: 'ERROR' },
  ],
  'request-too-large': [
    { message: 'client intended to send too large body: 10485760 bytes', level: 'ERROR' },
    { message: 'client intended to send too large body: 52428800 bytes', level: 'ERROR' },
  ],
  'worker-connections': [
    { message: 'worker_connections are not enough while connecting to upstream', level: 'ERROR' },
    { message: '1024 worker_connections are not enough', level: 'ERROR' },
  ],
}

// ─── Registry of all scenarios per service ────────────────────────────
const ALL_SCENARIOS: Record<string, Record<string, ErrorTemplate[]>> = {
  nodejs: NODEJS_SCENARIOS,
  golang: GOLANG_SCENARIOS,
  postgres: POSTGRES_SCENARIOS,
  mysql: MYSQL_SCENARIOS,
  redis: REDIS_SCENARIOS,
  nginx: NGINX_SCENARIOS,
}

/**
 * Pick an error template for a given service & chosen scenario.
 * If scenario is 'none' or empty, returns null (no error).
 */
export function pickError(serviceType: string, scenario: string, rng: () => number): ErrorTemplate | null {
  if (!scenario || scenario === 'none') return null

  const scenarios = ALL_SCENARIOS[serviceType]
  if (!scenarios) return { message: 'Unknown error', level: 'ERROR' }

  const templates = scenarios[scenario]
  if (!templates || templates.length === 0) return { message: 'Unknown error', level: 'ERROR' }

  return pickRandom(templates, rng)
}

/** Return the list of scenario options for a given service type (for UI dropdowns). */
export function getErrorScenarios(serviceType: string): { value: string; label: string }[] {
  const common = [{ value: 'none', label: 'None' }]

  const shared = [
    { value: 'connection-refused', label: 'Connection Refused' },
  ]

  const serviceSpecific: Record<string, { value: string; label: string }[]> = {
    nodejs: [
      ...shared,
      { value: 'connection-timeout', label: 'Connection Timeout' },
      { value: 'heap-oom', label: 'Heap Out of Memory' },
      { value: 'unhandled-rejection', label: 'Unhandled Promise Rejection' },
      { value: 'type-error', label: 'TypeError (null/undefined)' },
      { value: 'econnreset', label: 'ECONNRESET' },
      { value: 'disk-pressure', label: 'Disk Pressure (ENOSPC)' },
      { value: 'too-many-open-files', label: 'Too Many Open Files' },
      { value: 'event-loop-blocked', label: 'Event Loop Blocked' },
    ],
    golang: [
      ...shared,
      { value: 'connection-timeout', label: 'Connection Timeout' },
      { value: 'nil-pointer', label: 'Nil Pointer Dereference' },
      { value: 'index-out-of-range', label: 'Index Out of Range' },
      { value: 'broken-pipe', label: 'Broken Pipe' },
      { value: 'context-canceled', label: 'Context Canceled' },
      { value: 'tls-error', label: 'TLS/Certificate Error' },
      { value: 'goroutine-leak', label: 'Goroutine Leak' },
    ],
    postgres: [
      ...shared,
      { value: 'too-many-connections', label: 'Too Many Connections' },
      { value: 'deadlock', label: 'Deadlock Detected' },
      { value: 'unique-violation', label: 'Unique Constraint Violation' },
      { value: 'statement-timeout', label: 'Statement Timeout' },
      { value: 'auth-failure', label: 'Authentication Failure' },
      { value: 'out-of-memory', label: 'Out of Shared Memory' },
      { value: 'disk-full', label: 'Disk Full' },
      { value: 'serialization-failure', label: 'Serialization Failure' },
    ],
    mysql: [
      ...shared,
      { value: 'too-many-connections', label: 'Too Many Connections' },
      { value: 'deadlock', label: 'Deadlock' },
      { value: 'lock-wait-timeout', label: 'Lock Wait Timeout' },
      { value: 'duplicate-entry', label: 'Duplicate Entry' },
      { value: 'table-not-found', label: 'Table Not Found' },
      { value: 'access-denied', label: 'Access Denied' },
      { value: 'disk-full', label: 'Disk Full' },
      { value: 'lost-connection', label: 'Lost Connection' },
    ],
    redis: [
      ...shared,
      { value: 'oom', label: 'OOM (maxmemory)' },
      { value: 'readonly-replica', label: 'READONLY Replica' },
      { value: 'cluster-down', label: 'Cluster Down' },
      { value: 'busy-script', label: 'Busy Script' },
      { value: 'persistence-error', label: 'Persistence Error' },
      { value: 'max-clients', label: 'Max Clients Reached' },
      { value: 'loading', label: 'Loading Dataset' },
    ],
    nginx: [
      ...shared,
      { value: 'upstream-timeout', label: 'Upstream Timeout' },
      { value: 'no-live-upstreams', label: 'No Live Upstreams' },
      { value: 'upstream-reset', label: 'Upstream Reset/Closed' },
      { value: 'ssl-error', label: 'SSL Handshake Failure' },
      { value: 'request-too-large', label: 'Request Too Large' },
      { value: 'worker-connections', label: 'Worker Connections Exhausted' },
    ],
  }

  return [...common, ...(serviceSpecific[serviceType] || shared)]
}

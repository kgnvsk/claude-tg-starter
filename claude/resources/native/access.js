// @bun
// modules/telegram-corporate/capability-store.ts
import { Database } from "bun:sqlite";
import { createHash as createHash2, randomUUID } from "crypto";

// modules/telegram-corporate/resource-control.ts
function resourceFromControl(input, current) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.id))
    throw new Error("invalid resource id");
  if (input.action === "revoke") {
    if (Object.keys(input).some((key) => !["action", "id"].includes(key)) || !current)
      throw new Error("invalid resource revocation");
    return null;
  }
  if (input.action !== "register" || Object.keys(input).some((key) => !["action", "id", "label", "connector", "kind", "account", "spreadsheetId", "access"].includes(key)) || input.connector !== "google" || input.kind !== "sheet" || !["read", "read_write"].includes(input.access) || typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 120 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(input.label) || typeof input.account !== "string" || input.account.length > 254 || !/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(input.account) || typeof input.spreadsheetId !== "string" || !/^[A-Za-z0-9_-]{10,256}$/.test(input.spreadsheetId))
    throw new Error("invalid Google sheet resource");
  const fileKey = "sheet." + input.spreadsheetId;
  if (current && (current.connector !== "google" || current.config.account !== input.account || current.config.allowCreate !== false || typeof current.config[fileKey] !== "string" || Object.keys(current.config).some((key) => !["account", "allowCreate", fileKey].includes(key)) || current.capabilityIds.some((id) => !["google.sheets.read", "google.sheets.write"].includes(id))))
    throw new Error("existing resource scope cannot be replaced through chat");
  return {
    id: input.id,
    label: input.label.trim(),
    connector: "google",
    capabilityIds: input.access === "read_write" ? ["google.sheets.read", "google.sheets.write"] : ["google.sheets.read"],
    config: { account: input.account, allowCreate: false, [fileKey]: input.label.trim() }
  };
}

// modules/telegram-corporate/resource-google-files.ts
var GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;
function createdGoogleSheetIds(db, resourceId) {
  const rows = db.query(`SELECT DISTINCT receipt_id AS id FROM corporate_actions
     WHERE resource_id=? AND capability_id='google.sheets.write'
       AND operation='create' AND state='succeeded' AND receipt_id IS NOT NULL
     ORDER BY receipt_id`).all(resourceId);
  return rows.flatMap((row) => typeof row.id === "string" && GOOGLE_FILE_ID.test(row.id) ? [row.id] : []);
}
function createdGoogleSheetFiles(db, resourceId) {
  const rows = db.query(`SELECT receipt_id AS id,arguments_json AS argumentsJson FROM corporate_actions
     WHERE resource_id=? AND capability_id='google.sheets.write'
       AND operation='create' AND state='succeeded' AND receipt_id IS NOT NULL
     ORDER BY rowid DESC LIMIT 60`).all(resourceId);
  const files = new Map;
  for (const row of rows) {
    if (!GOOGLE_FILE_ID.test(row.id) || files.has(row.id))
      continue;
    let title;
    try {
      title = JSON.parse(row.argumentsJson).title;
    } catch {}
    files.set(row.id, { id: row.id, kind: "sheet", label: typeof title === "string" ? title.slice(0, 120) : row.id });
  }
  return [...files.values()];
}
function createdGoogleDocFiles(db, resourceId) {
  const rows = db.query(`SELECT receipt_id AS id,arguments_json AS argumentsJson FROM corporate_actions
     WHERE resource_id=? AND capability_id='google.docs.write'
       AND operation='create' AND state='succeeded' AND receipt_id IS NOT NULL
     ORDER BY rowid DESC LIMIT 60`).all(resourceId);
  const files = new Map;
  for (const row of rows) {
    if (!GOOGLE_FILE_ID.test(row.id) || files.has(row.id))
      continue;
    let title;
    try {
      title = JSON.parse(row.argumentsJson).title;
    } catch {}
    files.set(row.id, { id: row.id, kind: "doc", label: typeof title === "string" ? title.slice(0, 120) : row.id });
  }
  return [...files.values()];
}
var FILE_KEY = /^(sheet|doc|slide|file)\.([A-Za-z0-9_-]{10,256})$/;
function allowedGoogleFiles(resource, kind) {
  if (resource.connector !== "google")
    return [];
  const files = new Map;
  for (const [key, value] of Object.entries(resource.config)) {
    const match = FILE_KEY.exec(key);
    if (match == null || kind != null && match[1] !== kind)
      continue;
    const id = match[2];
    if (files.has(id))
      continue;
    const label = typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 120) : id;
    files.set(id, { id, label, kind: match[1] });
  }
  return [...files.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

// modules/telegram-corporate/resource-google-slides.ts
function createdGoogleSlideIds(db, resourceId) {
  const rows = db.query(`SELECT DISTINCT receipt_id AS id FROM corporate_actions
     WHERE resource_id=? AND capability_id='google.slides.write'
       AND operation='create' AND state='succeeded' AND receipt_id IS NOT NULL
     ORDER BY receipt_id`).all(resourceId);
  return rows.flatMap((row) => typeof row.id === "string" && GOOGLE_FILE_ID.test(row.id) ? [row.id] : []);
}
function createdGoogleSlideFiles(db, resourceId) {
  const rows = db.query(`SELECT receipt_id AS id,arguments_json AS argumentsJson FROM corporate_actions
     WHERE resource_id=? AND capability_id='google.slides.write'
       AND operation='create' AND state='succeeded' AND receipt_id IS NOT NULL
     ORDER BY rowid DESC LIMIT 60`).all(resourceId);
  const files = new Map;
  for (const row of rows) {
    if (!GOOGLE_FILE_ID.test(row.id) || files.has(row.id))
      continue;
    let title;
    try {
      title = JSON.parse(row.argumentsJson).title;
    } catch {}
    files.set(row.id, { id: row.id, label: typeof title === "string" ? title.slice(0, 120) : row.id, kind: "slide" });
  }
  return [...files.values()];
}

// modules/telegram-corporate/group-action.ts
import { createHash } from "crypto";

// modules/telegram-corporate/capabilities.ts
function capability(id, options) {
  return { id, delegable: true, ...options };
}
var CAPABILITY_CATALOG = Object.freeze({
  "integrations.manage": capability("integrations.manage", {
    kind: "write",
    adapter: "builtin",
    operations: ["status", "connect", "run", "disconnect", "cancel"],
    sharedAllowed: false,
    requiresResource: false,
    requiresConfirmation: false,
    namedPersonOnly: true
  }),
  "browser.read": capability("browser.read", {
    kind: "read",
    adapter: "browser",
    operations: ["navigate", "snapshot", "screenshot"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "research.web": capability("research.web", {
    kind: "read",
    adapter: "builtin",
    operations: ["search", "fetch"],
    sharedAllowed: true,
    requiresResource: false,
    requiresConfirmation: false
  }),
  "research.delegate": capability("research.delegate", {
    kind: "read",
    adapter: "builtin",
    operations: ["research"],
    sharedAllowed: true,
    requiresResource: false,
    requiresConfirmation: false
  }),
  "memory.company.read": capability("memory.company.read", {
    kind: "read",
    adapter: "memory",
    operations: ["search"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "image.generate": capability("image.generate", {
    kind: "write",
    adapter: "image",
    operations: ["generate", "edit"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.gmail.read": capability("google.gmail.read", {
    kind: "read",
    adapter: "google",
    operations: ["search", "get"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.calendar.read": capability("google.calendar.read", {
    kind: "read",
    adapter: "google",
    operations: ["list", "get"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.drive.read": capability("google.drive.read", {
    kind: "read",
    adapter: "google",
    operations: ["search", "get", "list", "download"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.drive.share": capability("google.drive.share", {
    kind: "write",
    adapter: "google",
    operations: ["share"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.docs.read": capability("google.docs.read", {
    kind: "read",
    adapter: "google",
    operations: ["get"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.docs.write": capability("google.docs.write", {
    kind: "write",
    adapter: "google",
    operations: ["replace", "append", "create"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.slides.read": capability("google.slides.read", {
    kind: "read",
    adapter: "google",
    operations: ["get"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.slides.write": capability("google.slides.write", {
    kind: "write",
    adapter: "google",
    operations: ["create"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.sheets.read": capability("google.sheets.read", {
    kind: "read",
    adapter: "google",
    operations: ["get", "metadata", "read_format", "read_layout"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.contacts.read": capability("google.contacts.read", {
    kind: "read",
    adapter: "google",
    operations: ["search", "get"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.tasks.read": capability("google.tasks.read", {
    kind: "read",
    adapter: "google",
    operations: ["list", "get"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.gmail.send": capability("google.gmail.send", {
    kind: "outbound",
    adapter: "google",
    operations: ["send"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.calendar.write": capability("google.calendar.write", {
    kind: "write",
    adapter: "google",
    operations: ["create", "update"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.sheets.write": capability("google.sheets.write", {
    kind: "write",
    adapter: "google",
    operations: ["update_cells", "create", "add_tab", "batch_update"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.contacts.write": capability("google.contacts.write", {
    kind: "write",
    adapter: "google",
    operations: ["create", "update"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.tasks.write": capability("google.tasks.write", {
    kind: "write",
    adapter: "google",
    operations: ["create", "update", "complete"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.analytics.read": capability("google.analytics.read", {
    kind: "read",
    adapter: "google",
    operations: ["report"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.search_console.read": capability("google.search_console.read", {
    kind: "read",
    adapter: "google",
    operations: ["report"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "meta.ads.read": capability("meta.ads.read", {
    kind: "read",
    adapter: "meta",
    operations: ["list_campaigns"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "meta.insights.read": capability("meta.insights.read", {
    kind: "read",
    adapter: "meta",
    operations: ["report"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.ads.read": capability("google.ads.read", {
    kind: "read",
    adapter: "gads",
    operations: ["list_campaigns", "report"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "telegram.message.send": capability("telegram.message.send", {
    kind: "outbound",
    adapter: "telegram",
    operations: ["send"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "telegram.group.read": capability("telegram.group.read", {
    kind: "read",
    adapter: "telegram",
    operations: ["history"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "telegram.chat.read": capability("telegram.chat.read", {
    kind: "read",
    adapter: "telegram",
    operations: ["history"],
    sharedAllowed: true,
    requiresResource: false,
    requiresConfirmation: false
  }),
  "sql.read": capability("sql.read", {
    kind: "read",
    adapter: "sql",
    operations: ["query"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  })
});
function isSharedSubject(subject) {
  return subject.startsWith("group:") || subject.startsWith("topic:");
}
var AGENT_DEFAULT_SUBJECT = "agent:default";
function isInstalledAgentSubject(subject) {
  return /^agent:installed:[A-Za-z0-9_-]{1,100}:[1-9]\d{2,9}$/.test(subject);
}
function isValidSubject(subject) {
  return subject === AGENT_DEFAULT_SUBJECT || isInstalledAgentSubject(subject) || /^user:\d+$/.test(subject) || /^group:-?\d+$/.test(subject) || /^topic:-?\d+:\d+$/.test(subject);
}

// modules/telegram-corporate/protocol.ts
var malformed = { ok: false, reason: "malformed" };
var RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var MAX_ANSWER = 12000;
var MAX_ARGUMENTS = 12000;
var MAX_RAW = 25000;
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseWorkerEnvelope(raw, catalog = CAPABILITY_CATALOG) {
  if (raw.length === 0 || raw.length > MAX_RAW)
    return malformed;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed;
  }
  if (!plainObject(parsed) || typeof parsed.kind !== "string")
    return malformed;
  if (parsed.kind === "no_reply")
    return exactKeys(parsed, ["kind"]) ? { kind: "no_reply" } : malformed;
  if (parsed.kind === "answer") {
    if (!exactKeys(parsed, ["kind", "text"]))
      return malformed;
    if (typeof parsed.text !== "string" || parsed.text.length === 0 || parsed.text.length > MAX_ANSWER)
      return malformed;
    return { kind: "answer", text: parsed.text };
  }
  if (parsed.kind !== "action_request")
    return malformed;
  if (!exactKeys(parsed, [
    "kind",
    "capability",
    "operation",
    "resourceId",
    "arguments"
  ]))
    return malformed;
  if (typeof parsed.capability !== "string" || typeof parsed.operation !== "string" || typeof parsed.resourceId !== "string" || !RESOURCE_ID.test(parsed.resourceId) || !plainObject(parsed.arguments))
    return malformed;
  const definition = catalog[parsed.capability];
  if (definition == null || !definition.delegable || definition.adapter === "builtin" || !definition.requiresResource || !definition.operations.includes(parsed.operation))
    return malformed;
  let argumentSize;
  try {
    argumentSize = JSON.stringify(parsed.arguments).length;
  } catch {
    return malformed;
  }
  if (argumentSize > MAX_ARGUMENTS)
    return malformed;
  return {
    kind: "action_request",
    capability: parsed.capability,
    operation: parsed.operation,
    resourceId: parsed.resourceId,
    arguments: parsed.arguments
  };
}

// modules/telegram-corporate/group-action.ts
function groupActionJson(value) {
  function ordered(item) {
    if (Array.isArray(item))
      return item.map(ordered);
    if (item === null || typeof item !== "object")
      return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])]));
  }
  return JSON.stringify(ordered(value));
}
function groupActionDeliveryId(sourceJobId, request) {
  return `corporate-group-action:${sourceJobId}:${createHash("sha256").update(groupActionJson(request)).digest("hex")}`;
}
function readQueuedGroupAction(db, jobId) {
  try {
    const row = db.query(`SELECT delivery_id AS deliveryId,conversation_key AS conversationKey,
      actor_user_id AS actorUserId,chat_id AS chatId,thread_id AS threadId,
      message_id AS messageId,prompt_json AS promptJson FROM conversation_jobs WHERE job_id=?`).get(jobId);
    if (row == null || row.chatId !== row.actorUserId || row.conversationKey !== `user:${row.actorUserId}` || row.threadId !== null || row.messageId >= 0)
      return null;
    const queued = JSON.parse(row.promptJson)?.groupAction;
    if (queued?.groupOrigin == null || queued.request == null)
      return null;
    const request = parseWorkerEnvelope(JSON.stringify(queued.request));
    if (!("kind" in request) || request.kind !== "action_request")
      return null;
    const source = db.query(`SELECT job_id AS sourceJobId,conversation_key AS conversationKey,
      actor_user_id AS actorUserId,chat_id AS chatId,thread_id AS threadId,message_id AS messageId
      FROM conversation_jobs WHERE job_id=?`).get(queued.groupOrigin.sourceJobId);
    if (source == null || !/^-\d+$/.test(source.chatId) || !/^\d+$/.test(source.actorUserId) || source.messageId <= 0 || source.actorUserId !== row.actorUserId || source.conversationKey !== `group:${source.chatId}` && !(source.threadId != null && source.conversationKey === `topic:${source.chatId}:${source.threadId}`) || groupActionJson(queued.groupOrigin) !== groupActionJson(source) || row.deliveryId !== groupActionDeliveryId(source.sourceJobId, request))
      return null;
    return { request, groupOrigin: source };
  } catch {
    return null;
  }
}

// modules/telegram-corporate/capability-store.ts
var SECRET_KEY = /token|secret|password|credential|authorization|cookie|api.?key|private.?key/i;
var RESOURCE_ID2 = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var SCHEMA = `
CREATE TABLE IF NOT EXISTS corporate_resources (
  resource_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  connector TEXT NOT NULL,
  capability_ids_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS corporate_policies (
  subject TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version >= 1),
  grants_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS corporate_policy_previews (
  token TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK(base_version >= 0),
  grants_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','cancelled','expired','stale')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS corporate_resource_previews (
  token TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  resource_json TEXT,
  base_revision INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','applied','cancelled','expired','stale')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS corporate_actions (
  action_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
  capability_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'previewed','approved','sending','succeeded','cancelled',
    'denied','failed','uncertain','expired'
  )),
  expires_at INTEGER NOT NULL,
  receipt_id TEXT,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  sending_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_corporate_actions_state_expiry
  ON corporate_actions(state,expires_at);
CREATE INDEX IF NOT EXISTS idx_corporate_actions_origin_job
  ON corporate_actions(CASE WHEN json_valid(payload_json)
    THEN json_extract(payload_json,'$.originJobId') END);

CREATE TABLE IF NOT EXISTS corporate_capability_audit (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS corporate_capability_audit_no_update
BEFORE UPDATE ON corporate_capability_audit BEGIN
  SELECT RAISE(ABORT, 'audit is append-only');
END;
CREATE TRIGGER IF NOT EXISTS corporate_capability_audit_no_delete
BEFORE DELETE ON corporate_capability_audit BEGIN
  SELECT RAISE(ABORT, 'audit is append-only');
END;
`;
function sortedUniqueGrants(grants) {
  const values = new Map;
  for (const grant of grants) {
    const resourceId = grant.resourceId ?? null;
    values.set(`${grant.capabilityId}\x00${resourceId ?? ""}`, {
      capabilityId: grant.capabilityId,
      resourceId,
      ...grant.trusted === true ? { trusted: true } : {}
    });
  }
  return [...values.values()].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId) || (left.resourceId ?? "").localeCompare(right.resourceId ?? ""));
}
function safeJson(value) {
  const encoded = JSON.stringify(value);
  if (encoded.length > 16384)
    throw new Error("value is too large");
  return encoded;
}
function canonicalValue(value) {
  if (Array.isArray(value))
    return value.map(canonicalValue);
  if (value === null || typeof value !== "object")
    return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalValue(value[key]);
  }
  return output;
}
function canonicalJson(value) {
  return safeJson(canonicalValue(value));
}

class CapabilityStore {
  db;
  primaryOwnerId;
  catalog;
  constructor(path, options) {
    this.primaryOwnerId = options.primaryOwnerId;
    this.catalog = options.catalog ?? CAPABILITY_CATALOG;
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.exec(SCHEMA);
    this.db.transaction(() => {
      const columns = new Set(this.db.query("PRAGMA table_info(corporate_policy_previews)").all().map((c) => c.name));
      for (const name of ["resource_versions_json", "agent_request_id", "agent_request_json", "agent_message_json"]) {
        if (!columns.has(name))
          this.db.exec(`ALTER TABLE corporate_policy_previews ADD COLUMN ${name} TEXT`);
      }
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS corporate_agent_request ON corporate_policy_previews(agent_request_id)");
    })();
    if (!this.db.query("PRAGMA table_info(corporate_resources)").all().some((column) => column.name === "revision")) {
      this.db.exec("ALTER TABLE corporate_resources ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
  }
  registerResource(resource, actorUserId, now) {
    if (actorUserId !== this.primaryOwnerId) {
      throw new Error("only the primary owner can register a resource");
    }
    this.validateResource(resource);
    const capabilityIds = [...new Set(resource.capabilityIds)].sort();
    this.db.transaction(() => {
      this.db.query(`INSERT INTO corporate_resources(
           resource_id,label,connector,capability_ids_json,config_json,
           active,created_at,updated_at
         ) VALUES(?,?,?,?,?,1,?,?)
         ON CONFLICT(resource_id) DO UPDATE SET
           label=excluded.label,
           connector=excluded.connector,
           capability_ids_json=excluded.capability_ids_json,
           config_json=excluded.config_json,
           active=1,
           revision=corporate_resources.revision+1,
           updated_at=excluded.updated_at`).run(resource.id, resource.label.trim(), resource.connector, safeJson(capabilityIds), safeJson(resource.config), now, now);
      this.audit("resource", actorUserId, "resource_registered", {
        resourceId: resource.id,
        connector: resource.connector,
        capabilityIds
      }, now);
    })();
  }
  resourceRevision(id) {
    return this.db.query("SELECT revision FROM corporate_resources WHERE resource_id=?").get(id)?.revision ?? 0;
  }
  resourceForControl(id) {
    const row = this.db.query("SELECT label,connector,capability_ids_json AS capabilities,config_json AS config FROM corporate_resources WHERE resource_id=?").get(id);
    return row ? { id, label: row.label, connector: row.connector, capabilityIds: JSON.parse(row.capabilities), config: JSON.parse(row.config) } : null;
  }
  createResourcePreview(input, actorUserId, expiresAt, now) {
    if (actorUserId !== this.primaryOwnerId)
      throw new Error("only the primary owner can preview a resource");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      throw new Error("invalid resource preview expiry");
    return this.db.transaction(() => {
      const current = typeof input?.id === "string" ? this.resourceForControl(input.id) : null;
      const resource = resourceFromControl(input, current);
      if (resource)
        this.validateResource(resource);
      const token = randomUUID(), baseRevision = this.resourceRevision(input.id);
      this.db.query(`INSERT INTO corporate_resource_previews(token,resource_id,resource_json,base_revision,requested_by,expires_at,state,created_at)
        VALUES(?,?,?,?,?,?,'pending',?)`).run(token, input.id, resource ? canonicalJson(resource) : null, baseRevision, actorUserId, expiresAt, now);
      this.audit("resource", actorUserId, "resource_previewed", { resourceId: input.id, action: input.action, baseRevision }, now);
      return { token, resourceId: input.id, label: resource?.label ?? current.label, resource, expiresAt };
    }).immediate();
  }
  resourcePreview(token) {
    return this.db.query(`SELECT token,resource_id AS resourceId,resource_json AS resourceJson,base_revision AS baseRevision,
      requested_by AS requestedBy,expires_at AS expiresAt,state FROM corporate_resource_previews WHERE token=?`).get(token);
  }
  resourcePreviewError(row, actor, now, state) {
    if (!row)
      return { ok: false, reason: "missing" };
    if (actor !== this.primaryOwnerId || row.requestedBy !== actor)
      return { ok: false, reason: "actor" };
    if (row.state !== state)
      return { ok: false, reason: "used" };
    const reason = now > row.expiresAt ? "expired" : this.resourceRevision(row.resourceId) !== row.baseRevision ? "stale" : null;
    if (!reason)
      return null;
    this.db.query("UPDATE corporate_resource_previews SET state=?,resolved_at=? WHERE token=?").run(reason, now, row.token);
    return { ok: false, reason };
  }
  claimResourcePreview(token, actor, now) {
    return this.db.transaction(() => {
      const row = this.resourcePreview(token), error = this.resourcePreviewError(row, actor, now, "pending");
      if (error)
        return error;
      this.db.query("UPDATE corporate_resource_previews SET state='claimed',resolved_at=? WHERE token=?").run(now, token);
      this.audit("resource", actor, "resource_approved", { resourceId: row.resourceId, baseRevision: row.baseRevision }, now);
      return { ok: true };
    }).immediate();
  }
  hasSendingActions() {
    return this.db.query("SELECT 1 FROM corporate_actions WHERE state='sending' LIMIT 1").get() != null;
  }
  applyResourcePreview(token, actor, now) {
    return this.db.transaction(() => {
      const row = this.resourcePreview(token), error = this.resourcePreviewError(row, actor, now, "claimed");
      if (error)
        return error;
      if (this.hasSendingActions())
        return { ok: false, reason: "busy" };
      const resource = row.resourceJson ? JSON.parse(row.resourceJson) : null;
      if (resource)
        this.registerResource(resource, actor, now);
      else {
        this.db.query("UPDATE corporate_resources SET active=0,revision=revision+1,updated_at=? WHERE resource_id=?").run(now, row.resourceId);
        this.audit("resource", actor, "resource_revoked", { resourceId: row.resourceId }, now);
      }
      for (const policy of this.db.query("SELECT subject,version,grants_json AS grantsJson FROM corporate_policies").all()) {
        const grants = JSON.parse(policy.grantsJson);
        const retained = grants.filter((grant) => grant.resourceId !== row.resourceId || resource?.capabilityIds.includes(grant.capabilityId));
        if (retained.length === grants.length)
          continue;
        this.db.query("UPDATE corporate_policies SET version=version+1,grants_json=?,updated_at=? WHERE subject=?").run(safeJson(retained), now, policy.subject);
        this.audit(policy.subject, actor, "resource_grants_revoked", { resourceId: row.resourceId, version: policy.version + 1 }, now);
      }
      this.db.query("UPDATE corporate_actions SET state='cancelled',updated_at=?,completed_at=? WHERE resource_id=? AND state='previewed'").run(now, now, row.resourceId);
      this.db.query("UPDATE corporate_resource_previews SET state='applied',resolved_at=? WHERE token=?").run(now, token);
      return { ok: true, resourceId: row.resourceId };
    }).immediate();
  }
  cancelResourcePreview(token, actor, now) {
    return this.db.transaction(() => {
      const row = this.resourcePreview(token), error = this.resourcePreviewError(row, actor, now, "pending");
      if (error)
        return error;
      this.db.query("UPDATE corporate_resource_previews SET state='cancelled',resolved_at=? WHERE token=?").run(now, token);
      this.audit("resource", actor, "resource_cancelled", { resourceId: row.resourceId }, now);
      return { ok: true };
    }).immediate();
  }
  listResources() {
    const rows = this.db.query(`SELECT resource_id AS resourceId,label,connector,
              capability_ids_json AS capabilityIdsJson,config_json AS configJson
       FROM corporate_resources WHERE active=1 ORDER BY resource_id`).all();
    return rows.map((row) => ({
      id: row.resourceId,
      label: row.label,
      connector: row.connector,
      capabilityIds: JSON.parse(row.capabilityIdsJson),
      config: JSON.parse(row.configJson)
    }));
  }
  getResource(resourceId) {
    if (!RESOURCE_ID2.test(resourceId))
      return null;
    const row = this.db.query(`SELECT resource_id AS resourceId,label,connector,
              capability_ids_json AS capabilityIdsJson,config_json AS configJson
       FROM corporate_resources WHERE resource_id=? AND active=1`).get(resourceId);
    if (row == null)
      return null;
    return {
      id: row.resourceId,
      label: row.label,
      connector: row.connector,
      capabilityIds: JSON.parse(row.capabilityIdsJson),
      config: JSON.parse(row.configJson)
    };
  }
  resolve(subject) {
    if (!isValidSubject(subject))
      throw new Error("invalid policy subject");
    const row = this.policyRow(subject);
    if (row != null)
      return { subject, version: row.version, grants: this.activeGrants(row) };
    const fallback = subject === AGENT_DEFAULT_SUBJECT || isInstalledAgentSubject(subject) ? null : this.policyRow(AGENT_DEFAULT_SUBJECT);
    if (fallback == null)
      return { subject, version: 0, grants: [] };
    return { subject, version: 0, grants: this.activeGrants(fallback).filter((grant) => !this.catalog[grant.capabilityId]?.namedPersonOnly), inheritedFrom: AGENT_DEFAULT_SUBJECT };
  }
  integrationAuthorizationKey(identity) {
    if (identity.chatType !== "private" || !/^[1-9]\d{0,15}$/.test(identity.userId) || identity.chatId !== identity.userId)
      return null;
    const subject = `user:${identity.userId}`;
    const policy = this.policyRow(subject);
    if (policy == null || policy.version < 1 || !JSON.parse(policy.grantsJson).some((grant) => grant.capabilityId === "integrations.manage" && grant.resourceId == null))
      return null;
    return `${subject}:${policy.version}`;
  }
  resolveForActor(subject, actorUserId) {
    const policy = this.resolve(subject);
    if (!/^\d+$/.test(actorUserId))
      return { ...policy, grants: [] };
    if (!isSharedSubject(subject)) {
      return subject === `user:${actorUserId}` ? policy : { ...policy, grants: [] };
    }
    const actor = this.resolve(`user:${actorUserId}`);
    return { ...policy, grants: policy.grants.filter((grant) => this.catalog[grant.capabilityId]?.sharedAllowed === true && actor.grants.some((personal) => personal.capabilityId === grant.capabilityId && personal.resourceId === grant.resourceId)) };
  }
  policyRow(subject) {
    return this.db.query(`SELECT version,grants_json AS grantsJson
       FROM corporate_policies WHERE subject=?`).get(subject);
  }
  activeGrants(row) {
    const grants = JSON.parse(row.grantsJson);
    const activeResources = new Set(this.listResources().map((resource) => resource.id));
    return grants.filter((grant) => grant.resourceId == null || activeResources.has(grant.resourceId));
  }
  createPolicyPreview(input, now) {
    if (input.requestedBy !== this.primaryOwnerId) {
      throw new Error("only the primary owner can create a policy preview");
    }
    if (!isValidSubject(input.subject))
      throw new Error("invalid policy subject");
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw new Error("policy preview expiry must be in the future");
    }
    const proposedGrants = sortedUniqueGrants(input.proposedGrants);
    this.validateGrants(input.subject, proposedGrants);
    const baseVersion = this.resolve(input.subject).version;
    const token = randomUUID();
    this.db.transaction(() => {
      this.db.query(`INSERT INTO corporate_policy_previews(
           token,subject,base_version,grants_json,requested_by,expires_at,state,created_at,resource_versions_json
         ) VALUES(?,?,?,?,?,?,'pending',?,?)`).run(token, input.subject, baseVersion, safeJson(proposedGrants), input.requestedBy, input.expiresAt, now, this.resourceVersions(proposedGrants));
      this.audit(input.subject, input.requestedBy, "policy_previewed", {
        tokenHash: token.slice(0, 8),
        baseVersion,
        proposedVersion: baseVersion + 1,
        grants: proposedGrants
      }, now);
    })();
    return {
      token,
      subject: input.subject,
      baseVersion,
      proposedVersion: baseVersion + 1,
      proposedGrants,
      expiresAt: input.expiresAt
    };
  }
  approvePolicyPreview(token, actorUserId, now, message) {
    return this.db.transaction(() => {
      const row = this.preview(token);
      if (row == null)
        return { ok: false, reason: "missing" };
      if (actorUserId !== this.primaryOwnerId || actorUserId !== row.requestedBy) {
        return { ok: false, reason: "actor" };
      }
      if (!this.validAgentMessage(row, message))
        return { ok: false, reason: "actor" };
      if (row.state !== "pending")
        return { ok: false, reason: "used" };
      if (now > row.expiresAt) {
        this.resolvePreview(token, "expired", now);
        return { ok: false, reason: "expired" };
      }
      const currentVersion = this.resolve(row.subject).version;
      if (currentVersion !== row.baseVersion) {
        this.resolvePreview(token, "stale", now);
        return { ok: false, reason: "stale" };
      }
      const grants = JSON.parse(row.grantsJson);
      if (row.resourceVersionsJson !== this.resourceVersions(grants)) {
        this.resolvePreview(token, "stale", now);
        return { ok: false, reason: "stale" };
      }
      this.validateGrants(row.subject, grants);
      const version = row.baseVersion + 1;
      if (row.baseVersion === 0) {
        this.db.query(`INSERT INTO corporate_policies(subject,version,grants_json,updated_at)
           VALUES(?,?,?,?)`).run(row.subject, version, row.grantsJson, now);
      } else {
        const update = this.db.query(`UPDATE corporate_policies SET version=?,grants_json=?,updated_at=?
           WHERE subject=? AND version=?`).run(version, row.grantsJson, now, row.subject, row.baseVersion);
        if (update.changes !== 1) {
          this.resolvePreview(token, "stale", now);
          return { ok: false, reason: "stale" };
        }
      }
      this.resolvePreview(token, "approved", now);
      this.audit(row.subject, actorUserId, "policy_approved", {
        baseVersion: row.baseVersion,
        version,
        grants
      }, now);
      return { ok: true, version };
    })();
  }
  cancelPolicyPreview(token, actorUserId, now, message) {
    return this.db.transaction(() => {
      const row = this.preview(token);
      if (row == null)
        return { ok: false, reason: "missing" };
      if (actorUserId !== this.primaryOwnerId || actorUserId !== row.requestedBy) {
        return { ok: false, reason: "actor" };
      }
      if (!this.validAgentMessage(row, message))
        return { ok: false, reason: "actor" };
      if (row.state !== "pending")
        return { ok: false, reason: "used" };
      if (now > row.expiresAt) {
        this.resolvePreview(token, "expired", now);
        return { ok: false, reason: "expired" };
      }
      this.resolvePreview(token, "cancelled", now);
      this.audit(row.subject, actorUserId, "policy_cancelled", {}, now);
      return { ok: true };
    })();
  }
  invalidatePendingPreviews(actorUserId, now) {
    if (!actorUserId || actorUserId.length > 128)
      throw new Error("invalid actor");
    return this.db.transaction(() => {
      const policies = this.db.query(`SELECT token,subject FROM corporate_policy_previews
         WHERE state='pending'`).all();
      for (const policy of policies) {
        this.resolvePreview(policy.token, "cancelled", now);
        this.audit(policy.subject, actorUserId, "policy_invalidated", {
          reason: "phase2_disabled"
        }, now);
      }
      const actions = this.db.query(`SELECT action_id AS actionId,token,subject,
                actor_user_id AS actorUserId,chat_id AS chatId,
                policy_version AS policyVersion,
                capability_id AS capabilityId,operation,
                resource_id AS resourceId,arguments_json AS argumentsJson,
                payload_json AS payloadJson,payload_sha256 AS payloadSha256,
                state,expires_at AS expiresAt,receipt_id AS receiptId
         FROM corporate_actions WHERE state='previewed'`).all();
      for (const action of actions) {
        this.finishWithoutSend(action, "denied", "phase2_disabled", now);
      }
      this.db.query("UPDATE corporate_resource_previews SET state='cancelled',resolved_at=? WHERE state IN ('pending','claimed')").run(now);
      return {
        policyPreviews: policies.length,
        actionPreviews: actions.length
      };
    })();
  }
  recordCapabilityEvent(subject, actorUserId, eventType, metadata, now) {
    if (!isValidSubject(subject))
      throw new Error("invalid audit subject");
    this.audit(subject, actorUserId, eventType, metadata, now);
  }
  groupWritePolicy(request, actorUserId, groupSubject) {
    if (!/^\d+$/.test(actorUserId) || !isValidSubject(groupSubject) || !isSharedSubject(groupSubject))
      return null;
    const definition = this.catalog[request.capability];
    const readId = request.capability.replace(/\.write$/, ".read");
    const read = this.catalog[readId];
    const resource = this.getResource(request.resourceId);
    if (definition == null || definition.kind !== "write" || !definition.requiresConfirmation || !definition.delegable || !definition.operations.includes(request.operation) || readId === request.capability || read?.kind !== "read" || !read.sharedAllowed || read.requiresConfirmation || resource == null || resource.connector !== definition.adapter || read.adapter !== definition.adapter || !resource.capabilityIds.includes(request.capability) || !resource.capabilityIds.includes(readId) || request.capability === "google.docs.write" && resource.config.docsAppendOnly === true && request.operation !== "append")
      return null;
    const actor = this.resolve(`user:${actorUserId}`);
    const group = this.resolve(groupSubject);
    return actor.grants.some((grant) => grant.capabilityId === request.capability && grant.resourceId === request.resourceId) && group.grants.some((grant) => grant.capabilityId === readId && grant.resourceId === request.resourceId) ? group.version : null;
  }
  delegatedMetaActionAuthorized(input) {
    const key = `user:${input.actorUserId}:${input.policyVersion}`;
    const args = input.arguments;
    return input.subject === `user:${input.actorUserId}` && input.chatId === input.actorUserId && input.operation === "meta.run" && input.resourceId === "delegated:meta" && input.groupOrigin == null && this.integrationAuthorizationKey({ chatType: "private", chatId: input.chatId, userId: input.actorUserId }) === key && args != null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).sort().join(",") === "args,authorizationKey,confirmationToken,connectionKey" && Array.isArray(args.args) && args.args.length > 0 && args.args.every((value) => typeof value === "string") && args.authorizationKey === key && typeof args.connectionKey === "string" && args.connectionKey.trim().length > 0 && typeof args.confirmationToken === "string" && args.confirmationToken.trim().length > 0;
  }
  createActionPreview(input, now) {
    if (input.subject !== `user:${input.actorUserId}` || input.chatId !== input.actorUserId || input.expiresAt <= now)
      throw new Error("write previews require the verified private actor");
    const policy = this.resolve(input.subject);
    if (policy.version !== input.policyVersion)
      throw new Error("stale action policy");
    const definition = this.catalog[input.capability];
    const resource = this.getResource(input.resourceId);
    const queued = input.originJobId == null ? null : readQueuedGroupAction(this.db, input.originJobId);
    if (input.capability === "integrations.manage") {
      if (queued != null || !this.delegatedMetaActionAuthorized(input))
        throw new Error("action is not authorized");
    } else if (definition == null || !definition.requiresConfirmation || !definition.operations.includes(input.operation) || resource == null || resource.connector !== definition.adapter || !resource.capabilityIds.includes(input.capability) || !policy.grants.some((grant) => grant.capabilityId === input.capability && grant.resourceId === input.resourceId))
      throw new Error("action is not authorized");
    const argumentsJson = canonicalJson(input.arguments);
    let groupOrigin;
    if (input.groupOrigin != null || queued != null) {
      if (input.groupOrigin == null)
        throw new Error("group origin is required");
      const request = {
        kind: "action_request",
        capability: input.capability,
        operation: input.operation,
        resourceId: input.resourceId,
        arguments: input.arguments
      };
      const groupVersion = this.groupWritePolicy(request, input.actorUserId, input.groupOrigin.conversationKey);
      if (queued == null || groupVersion == null || queued.groupOrigin.actorUserId !== input.actorUserId || groupActionJson(queued.groupOrigin) !== groupActionJson(input.groupOrigin) || groupActionJson(queued.request) !== groupActionJson(request))
        throw new Error("group origin is not authorized");
      groupOrigin = { ...queued.groupOrigin, policyVersion: groupVersion };
    }
    const payload = {
      capability: input.capability,
      operation: input.operation,
      resourceId: input.resourceId,
      arguments: JSON.parse(argumentsJson),
      ...input.originJobId ? { originJobId: input.originJobId } : {},
      ...groupOrigin ? { groupOrigin } : {}
    };
    const payloadJson = canonicalJson(payload);
    const payloadSha256 = createHash2("sha256").update(payloadJson).digest("hex");
    const { groupOrigin: _unfrozenOrigin, ...ordinaryInput } = input;
    const action = {
      actionId: randomUUID(),
      token: randomUUID(),
      ...ordinaryInput,
      ...groupOrigin ? { groupOrigin } : {},
      arguments: JSON.parse(argumentsJson)
    };
    this.db.transaction(() => {
      this.db.query(`INSERT INTO corporate_actions(
           action_id,token,subject,actor_user_id,chat_id,policy_version,
           capability_id,operation,resource_id,arguments_json,payload_json,
           payload_sha256,state,expires_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'previewed',?,?,?)`).run(action.actionId, action.token, action.subject, action.actorUserId, action.chatId, action.policyVersion, action.capability, action.operation, action.resourceId, argumentsJson, payloadJson, payloadSha256, action.expiresAt, now, now);
      this.audit(action.subject, action.actorUserId, "action_previewed", {
        actionId: action.actionId,
        capability: action.capability,
        operation: action.operation,
        resourceId: action.resourceId,
        policyVersion: action.policyVersion,
        payloadSha256
      }, now);
    })();
    return action;
  }
  actionStatus(token) {
    const row = this.db.query(`SELECT state,receipt_id AS receiptId FROM corporate_actions WHERE token=?`).get(token);
    return row == null ? null : { state: row.state, receiptId: row.receiptId };
  }
  actionCapability(token) {
    const row = this.db.query("SELECT capability_id AS capability FROM corporate_actions WHERE token=?").get(token);
    return row?.capability ?? null;
  }
  reconcileSendingActions(now) {
    const rows = this.db.query(`SELECT token FROM corporate_actions WHERE state='sending' ORDER BY action_id`).all();
    let reconciled = 0;
    for (const row of rows) {
      if (this.finishAction(row.token, "uncertain", null, "runtime_recovery", now))
        reconciled += 1;
    }
    return reconciled;
  }
  createdSheets(resourceId) {
    return createdGoogleSheetFiles(this.db, resourceId);
  }
  createdDocuments(resourceId) {
    return createdGoogleDocFiles(this.db, resourceId);
  }
  createdPresentations(resourceId) {
    return createdGoogleSlideFiles(this.db, resourceId);
  }
  claimAction(token, actorUserId, chatId, now) {
    const claim = this.db.transaction(() => {
      const row = this.action(token);
      if (row == null)
        return { ok: false, reason: "missing" };
      if (row.actorUserId !== actorUserId || row.chatId !== chatId) {
        return { ok: false, reason: "actor" };
      }
      if (row.state === "sending" || row.state === "uncertain") {
        return { ok: false, reason: "uncertain" };
      }
      if (row.state !== "previewed")
        return { ok: false, reason: "used" };
      const hasRuntimeState = this.db.query(`SELECT 1 FROM sqlite_master
         WHERE type='table' AND name='corporate_runtime_state'`).get() != null;
      if (hasRuntimeState) {
        const runtime = this.db.query(`SELECT isolation_activated AS isolationActivated,
                  admission_state AS admissionState
           FROM corporate_runtime_state WHERE singleton=1`).get();
        if (runtime?.isolationActivated === 1 && runtime.admissionState !== "active") {
          return { ok: false, reason: "stale" };
        }
      }
      if (now > row.expiresAt) {
        this.finishWithoutSend(row, "expired", "expired", now);
        return { ok: false, reason: "expired" };
      }
      if (createHash2("sha256").update(row.payloadJson).digest("hex") !== row.payloadSha256) {
        this.finishWithoutSend(row, "denied", "tampered", now);
        return { ok: false, reason: "tampered" };
      }
      const payload = JSON.parse(row.payloadJson);
      const delegated = row.capabilityId === "integrations.manage";
      if (delegated) {
        if (payload.capability !== row.capabilityId || payload.operation !== row.operation || payload.resourceId !== row.resourceId || payload.arguments == null || canonicalJson(payload.arguments) !== row.argumentsJson) {
          this.finishWithoutSend(row, "denied", "tampered", now);
          return { ok: false, reason: "tampered" };
        }
        const queued = payload.originJobId == null ? null : readQueuedGroupAction(this.db, payload.originJobId);
        if (queued != null || !this.delegatedMetaActionAuthorized({
          ...row,
          arguments: payload.arguments,
          groupOrigin: payload.groupOrigin
        })) {
          this.finishWithoutSend(row, "denied", "stale", now);
          return { ok: false, reason: "stale" };
        }
      }
      if (payload.groupOrigin != null) {
        const { policyVersion, ...origin } = payload.groupOrigin;
        const request = {
          kind: "action_request",
          capability: row.capabilityId,
          operation: row.operation,
          resourceId: row.resourceId,
          arguments: JSON.parse(row.argumentsJson)
        };
        const queued = payload.originJobId == null ? null : readQueuedGroupAction(this.db, payload.originJobId);
        if (queued == null || queued.groupOrigin.actorUserId !== actorUserId || groupActionJson(queued.groupOrigin) !== groupActionJson(origin) || groupActionJson(queued.request) !== groupActionJson(request) || this.groupWritePolicy(request, actorUserId, origin.conversationKey) !== policyVersion) {
          this.finishWithoutSend(row, "denied", "stale", now);
          return { ok: false, reason: "stale" };
        }
      }
      const policy = this.resolve(row.subject);
      const definition = this.catalog[row.capabilityId];
      const resource = this.getResource(row.resourceId);
      if (!delegated && (policy.version !== row.policyVersion || definition == null || !definition.requiresConfirmation || !definition.operations.includes(row.operation) || resource == null || resource.connector !== definition.adapter || !resource.capabilityIds.includes(row.capabilityId) || !policy.grants.some((grant) => grant.capabilityId === row.capabilityId && grant.resourceId === row.resourceId))) {
        this.finishWithoutSend(row, "denied", "stale", now);
        return { ok: false, reason: "stale" };
      }
      const approved = this.db.query(`UPDATE corporate_actions SET state='approved',approved_at=?,updated_at=?
         WHERE action_id=? AND state='previewed'`).run(now, now, row.actionId);
      if (approved.changes !== 1)
        return { ok: false, reason: "used" };
      this.db.query(`UPDATE corporate_actions SET state='sending',sending_at=?,updated_at=?
         WHERE action_id=? AND state='approved'`).run(now, now, row.actionId);
      this.audit(row.subject, actorUserId, "action_approved", {
        actionId: row.actionId,
        capability: row.capabilityId,
        operation: row.operation,
        resourceId: row.resourceId,
        policyVersion: row.policyVersion
      }, now);
      return {
        ok: true,
        action: {
          actionId: row.actionId,
          token: row.token,
          subject: row.subject,
          actorUserId: row.actorUserId,
          chatId: row.chatId,
          policyVersion: row.policyVersion,
          capability: row.capabilityId,
          operation: row.operation,
          resourceId: row.resourceId,
          arguments: JSON.parse(row.argumentsJson),
          expiresAt: row.expiresAt,
          ...payload.groupOrigin ? { groupOrigin: payload.groupOrigin } : {}
        }
      };
    });
    return claim.immediate();
  }
  finishAction(token, state, receiptId, failureCode, now) {
    if (receiptId != null && receiptId.length > 512)
      throw new Error("receipt is too long");
    return this.db.transaction(() => {
      const row = this.action(token);
      if (row == null || row.state !== "sending")
        return false;
      const updated = this.db.query(`UPDATE corporate_actions SET state=?,receipt_id=?,failure_code=?,
                completed_at=?,updated_at=?
         WHERE action_id=? AND state='sending'`).run(state, receiptId, failureCode, now, now, row.actionId);
      if (updated.changes !== 1)
        return false;
      this.audit(row.subject, row.actorUserId, `action_${state}`, {
        actionId: row.actionId,
        capability: row.capabilityId,
        operation: row.operation,
        resourceId: row.resourceId,
        receiptId,
        failureCode
      }, now);
      return true;
    })();
  }
  cancelAction(token, actorUserId, chatId, now) {
    return this.db.transaction(() => {
      const row = this.action(token);
      if (row == null)
        return { ok: false, reason: "missing" };
      if (row.actorUserId !== actorUserId || row.chatId !== chatId) {
        return { ok: false, reason: "actor" };
      }
      if (row.state !== "previewed")
        return { ok: false, reason: "used" };
      if (now > row.expiresAt) {
        this.finishWithoutSend(row, "expired", "expired", now);
        return { ok: false, reason: "expired" };
      }
      this.finishWithoutSend(row, "cancelled", null, now);
      return { ok: true, state: "cancelled" };
    })();
  }
  validateResource(resource) {
    if (!RESOURCE_ID2.test(resource.id))
      throw new Error("invalid resource id");
    const label = resource.label.trim();
    if (label.length === 0 || label.length > 120)
      throw new Error("invalid resource label");
    if (!["memory", "google", "sql", "meta", "gads", "telegram", "image", "browser"].includes(resource.connector)) {
      throw new Error("unknown resource connector");
    }
    if (resource.capabilityIds.length === 0)
      throw new Error("resource needs a capability");
    for (const capabilityId of resource.capabilityIds) {
      const definition = this.catalog[capabilityId];
      if (definition == null || !definition.delegable || !definition.requiresResource || definition.adapter !== resource.connector)
        throw new Error(`invalid resource capability: ${capabilityId}`);
    }
    for (const [key, value] of Object.entries(resource.config)) {
      if (SECRET_KEY.test(key))
        throw new Error("secret values must not be stored in a resource");
      if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
        throw new Error("resource config values must be scalar");
      }
      if (typeof value === "string" && /^(?:bearer|basic)\s/i.test(value)) {
        throw new Error("secret values must not be stored in a resource");
      }
    }
    safeJson(resource.config);
  }
  validateGrants(subject, grants) {
    const resources = new Map(this.listResources().map((resource) => [resource.id, resource]));
    for (const grant of grants) {
      const definition = this.catalog[grant.capabilityId];
      if (grant.capabilityId === "*" || definition == null || !definition.delegable) {
        throw new Error(`unknown or nondelegable capability: ${grant.capabilityId}`);
      }
      if (definition.namedPersonOnly && !/^user:[1-9]\d{0,15}$/.test(subject)) {
        throw new Error("integration management is only for one named person");
      }
      if (isSharedSubject(subject) && (!definition.sharedAllowed || definition.requiresConfirmation)) {
        throw new Error("write capabilities are not allowed in shared conversations");
      }
      if (grant.trusted === true) {
        if (!/^user:\d+$/.test(subject))
          throw new Error("trust is only for one named person");
        if (!definition.requiresConfirmation)
          throw new Error("capability never asks for confirmation");
      }
      if (!definition.requiresResource) {
        if (grant.resourceId != null)
          throw new Error("capability does not accept a resource");
        continue;
      }
      if (grant.resourceId == null)
        throw new Error("capability requires a resource");
      const resource = resources.get(grant.resourceId);
      if (resource == null || resource.connector !== definition.adapter || !resource.capabilityIds.includes(grant.capabilityId))
        throw new Error("resource does not grant this capability");
    }
  }
  resourceVersions(grants) {
    return JSON.stringify([...new Set(grants.flatMap((g) => g.resourceId ? [g.resourceId] : []))].sort().map((id) => {
      const row = this.db.query("SELECT revision FROM corporate_resources WHERE resource_id=? AND active=1").get(id);
      return [id, row?.revision ?? null];
    }));
  }
  createAgentAccessPreview(input, now) {
    if (!isInstalledAgentSubject(input.subject) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId))
      throw new Error("invalid agent request");
    const definition = this.catalog[input.grant.capabilityId];
    if (definition?.kind !== "read" || !definition.requiresResource || !input.grant.resourceId)
      throw new Error("agent requests require one read-only resource");
    const key = input.subject + "/" + input.requestId;
    const requestJson = safeJson(input.grant);
    return this.db.transaction(() => {
      const old = this.db.query("SELECT token,expires_at AS expiresAt,agent_request_json AS requestJson FROM corporate_policy_previews WHERE agent_request_id=?").get(key);
      if (old) {
        if (old.requestJson !== requestJson)
          throw new Error("request ID already used for another resource");
        return { token: old.token, expiresAt: old.expiresAt };
      }
      const preview = this.createPolicyPreview({
        subject: input.subject,
        requestedBy: this.primaryOwnerId,
        expiresAt: input.expiresAt,
        proposedGrants: [...this.resolve(input.subject).grants, input.grant]
      }, now);
      this.db.query("UPDATE corporate_policy_previews SET agent_request_id=?,agent_request_json=? WHERE token=?").run(key, requestJson, preview.token);
      this.audit(input.subject, input.subject, "agent_access_requested", { grant: input.grant }, now);
      return { token: preview.token, expiresAt: preview.expiresAt };
    })();
  }
  agentAccessStatus(token, subject, now) {
    const row = this.preview(token);
    if (!row?.agentRequestId || row.subject !== subject)
      return { state: "missing" };
    return {
      state: row.state === "pending" && row.expiresAt <= now ? "expired" : row.state,
      expiresAt: row.expiresAt,
      ...row.agentMessageJson ? { message: JSON.parse(row.agentMessageJson) } : {}
    };
  }
  isAgentAccessPreview(token) {
    return !!this.preview(token)?.agentRequestId;
  }
  withdrawAgentAccess(token, subject, now) {
    const row = this.preview(token);
    if (row?.agentRequestId && row.subject === subject && row.state === "pending") {
      this.resolvePreview(token, "cancelled", now);
      this.audit(subject, subject, "agent_access_withdrawn", {}, now);
    }
  }
  createAgentOwnerPreview(input, now) {
    if (!isInstalledAgentSubject(input.subject))
      throw new Error("invalid installed agent");
    const preview = this.createPolicyPreview(input, now);
    this.db.query("UPDATE corporate_policy_previews SET agent_request_id=?,agent_request_json=? WHERE token=?").run("owner/" + preview.token, safeJson(input.proposedGrants), preview.token);
    return preview;
  }
  revokeAgentAccess(subject, now) {
    if (!isInstalledAgentSubject(subject))
      throw new Error("invalid agent subject");
    this.db.transaction(() => {
      this.db.query(`INSERT INTO corporate_policies(subject,version,grants_json,updated_at) VALUES(?,1,'[]',?)
        ON CONFLICT(subject) DO UPDATE SET version=corporate_policies.version+1,grants_json='[]',updated_at=excluded.updated_at`).run(subject, now);
      this.db.query(`UPDATE corporate_policy_previews SET state='cancelled',resolved_at=? WHERE subject=? AND state='pending'`).run(now, subject);
      this.audit(subject, "host:org", "agent_access_revoked", { reason: "connection_removed" }, now);
    })();
  }
  hasAgentResourceGrant(subject, grant) {
    if (!isInstalledAgentSubject(subject) || !this.resolve(subject).grants.some((g) => g.capabilityId === grant.capabilityId && g.resourceId === grant.resourceId))
      return false;
    const row = this.db.query(`SELECT resource_versions_json AS versions FROM corporate_policy_previews
      WHERE subject=? AND state='approved' AND base_version=? ORDER BY resolved_at DESC LIMIT 1`).get(subject, this.resolve(subject).version - 1);
    if (!row?.versions)
      return false;
    const approved = JSON.parse(row.versions).find(([id]) => id === grant.resourceId);
    return JSON.stringify(approved ? [approved] : []) === this.resourceVersions([grant]);
  }
  claimAgentAccessNotice(token, subject) {
    return this.db.query(`UPDATE corporate_policy_previews SET agent_message_json='{"sending":true}'
      WHERE token=? AND subject=? AND agent_request_id IS NOT NULL AND state='pending' AND agent_message_json IS NULL`).run(token, subject).changes === 1;
  }
  bindAgentAccessMessage(token, subject, message) {
    if (message.chatId !== this.primaryOwnerId || !Number.isSafeInteger(message.messageId) || message.messageId < 1)
      throw new Error("invalid owner message");
    const row = this.preview(token);
    if (!row?.agentRequestId || row.subject !== subject || row.state !== "pending")
      throw new Error("agent request not pending");
    const json = JSON.stringify(message);
    if (row.agentMessageJson && row.agentMessageJson !== '{"sending":true}' && row.agentMessageJson !== json)
      throw new Error("owner message already bound");
    this.db.query(`UPDATE corporate_policy_previews SET agent_message_json=? WHERE token=? AND (agent_message_json IS NULL OR agent_message_json='{"sending":true}')`).run(json, token);
  }
  validAgentMessage(row, message) {
    if (!row.agentRequestId)
      return true;
    if (!row.agentMessageJson || !message)
      return false;
    const bound = JSON.parse(row.agentMessageJson);
    return bound.chatId === this.primaryOwnerId && message.chatId === bound.chatId && message.messageId === bound.messageId;
  }
  preview(token) {
    return this.db.query(`SELECT token,subject,base_version AS baseVersion,grants_json AS grantsJson,
              requested_by AS requestedBy,expires_at AS expiresAt,state,
              resource_versions_json AS resourceVersionsJson,agent_request_id AS agentRequestId,
              agent_request_json AS agentRequestJson,agent_message_json AS agentMessageJson
       FROM corporate_policy_previews WHERE token=?`).get(token);
  }
  action(token) {
    return this.db.query(`SELECT action_id AS actionId,token,subject,actor_user_id AS actorUserId,
              chat_id AS chatId,policy_version AS policyVersion,
              capability_id AS capabilityId,operation,resource_id AS resourceId,
              arguments_json AS argumentsJson,payload_json AS payloadJson,
              payload_sha256 AS payloadSha256,state,expires_at AS expiresAt,
              receipt_id AS receiptId
       FROM corporate_actions WHERE token=?`).get(token);
  }
  finishWithoutSend(row, state, failureCode, now) {
    this.db.query(`UPDATE corporate_actions SET state=?,failure_code=?,completed_at=?,updated_at=?
       WHERE action_id=? AND state='previewed'`).run(state, failureCode, now, now, row.actionId);
    this.audit(row.subject, row.actorUserId, `action_${state}`, {
      actionId: row.actionId,
      capability: row.capabilityId,
      operation: row.operation,
      resourceId: row.resourceId,
      failureCode
    }, now);
  }
  resolvePreview(token, state, now) {
    this.db.query(`UPDATE corporate_policy_previews SET state=?,resolved_at=?
       WHERE token=? AND state='pending'`).run(state, now, token);
  }
  audit(subject, actorUserId, eventType, metadata, now) {
    this.db.query(`INSERT INTO corporate_capability_audit(
         subject,actor_user_id,event_type,metadata_json,created_at
       ) VALUES(?,?,?,?,?)`).run(subject, actorUserId, eventType, safeJson(metadata), now);
  }
}
// modules/telegram-corporate/resource-sheets.ts
var SHEET_KEY = /^sheet\.([A-Za-z0-9_-]{10,256})$/;
function allowedSheets(resource) {
  const result = [];
  for (const [key, value] of Object.entries(resource.config)) {
    const match = SHEET_KEY.exec(key);
    if (match == null)
      continue;
    const label = typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 120) : match[1];
    result.push({ spreadsheetId: match[1], label });
  }
  return result.sort((left, right) => left.label.localeCompare(right.label));
}

// modules/telegram-corporate/agent-access.ts
function agentAccessDecision(dbPath, owner, token, decision, context) {
  const store = new CapabilityStore(dbPath, { primaryOwnerId: owner });
  if (!store.isAgentAccessPreview(token))
    return null;
  if (context.chatType !== "private" || context.chatId !== owner || context.userId !== owner)
    return { ok: false, reason: "actor" };
  return decision === "approve" ? store.approvePolicyPreview(token, context.userId, Date.now(), context) : { ...store.cancelPolicyPreview(token, context.userId, Date.now(), context), state: "cancelled" };
}
function sheetResource(store, input) {
  if (typeof input !== "string" || input.length > 500)
    throw new Error("invalid resource");
  const sheetId = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/[^\s]*)?$/.exec(input)?.[1] ?? input;
  const candidates = store.listResources().filter((resource) => resource.connector === "google" && resource.capabilityIds.includes("google.sheets.read") && allowedSheets(resource).length === 1 && (resource.id === input || allowedSheets(resource)[0].spreadsheetId === sheetId));
  if (candidates.length !== 1)
    throw new Error("This spreadsheet is not registered as a separate resource by its owner.");
  return candidates[0];
}
async function agentAccess(input, options) {
  const now = options.now ?? Date.now, store = options.store;
  const resource = sheetResource(store, input.resource);
  const grant = { capabilityId: "google.sheets.read", resourceId: resource.id };
  const allowed = () => store.hasAgentResourceGrant(input.subject, grant);
  if (input.op === "status" || input.op === "cancel") {
    if (input.op === "cancel" && input.token)
      store.withdrawAgentAccess(input.token, input.subject, now());
    const status = input.token ? store.agentAccessStatus(input.token, input.subject, now()) : { state: "missing" };
    return { state: status.state, allowed: allowed(), resource: resource.id };
  }
  if (input.op === "request") {
    if (allowed())
      return { state: "approved", allowed: true, resource: resource.id };
    const preview = store.createAgentAccessPreview({ subject: input.subject, grant, requestId: input.requestId, expiresAt: now() + 60 * 60 * 1000 }, now());
    const status = store.agentAccessStatus(preview.token, input.subject, now());
    let notified = !!status.message?.messageId;
    if (status.state === "pending" && store.claimAgentAccessNotice(preview.token, input.subject)) {
      const source = input.sourceName.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 120);
      const messageId = await options.send(`${source} \u043F\u0440\u043E\u0441\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u0442\u0430\u0431\u043B\u0438\u0446\u0456 \xAB${resource.label}\xBB.

\u0414\u043E\u0437\u0432\u0456\u043B: \u043B\u0438\u0448\u0435 \u0447\u0438\u0442\u0430\u0442\u0438 \u0446\u044E \u0442\u0430\u0431\u043B\u0438\u0446\u044E, \u0443 \u0432\u0441\u0456\u0445 \u0441\u0435\u0441\u0456\u044F\u0445 \u0446\u044C\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430. \u0406\u043D\u0448\u0456 \u0444\u0430\u0439\u043B\u0438 \u0442\u0430 \u0440\u0435\u0434\u0430\u0433\u0443\u0432\u0430\u043D\u043D\u044F \u0437\u0430\u043B\u0438\u0448\u0430\u044E\u0442\u044C\u0441\u044F \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u043C\u0438. \u0422\u0432\u043E\u0457 \u043F\u0440\u0430\u0432\u0430 \u043D\u0435 \u0437\u043C\u0456\u043D\u044F\u0442\u044C\u0441\u044F.

\u041D\u0430\u0434\u0430\u0442\u0438 \u0434\u043E\u0441\u0442\u0443\u043F?`, preview.token, preview.expiresAt, input.subject);
      store.bindAgentAccessMessage(preview.token, input.subject, { chatId: options.ownerChatId, messageId });
      notified = true;
    }
    return { state: status.state, allowed: false, notified, token: preview.token, expiresAt: preview.expiresAt, resource: resource.id };
  }
  if (input.op !== "read")
    throw new Error("invalid access operation");
  if (!allowed())
    return { state: "denied", allowed: false, resource: resource.id, message: "Request access from the resource owner. Only the human owner can approve it in Telegram." };
  if (typeof input.range !== "string" || input.range.length > 200 || /[\r\n\0]/.test(input.range))
    throw new Error("invalid range");
  const response = await options.adapter.execute({
    capability: grant.capabilityId,
    operation: "get",
    resource,
    arguments: { spreadsheetId: allowedSheets(resource)[0].spreadsheetId, range: input.range },
    verified: { jobId: "agent-resource-read", actorUserId: input.subject, subject: input.subject, chatId: options.ownerChatId }
  }, AbortSignal.timeout(45000));
  if (!allowed())
    return { state: "denied", allowed: false, message: "Access changed while the spreadsheet was being read." };
  if (!response.ok)
    return { state: "unavailable", allowed: true, code: response.code, message: "The owner approved access, but the Google connection could not read the table. Check the resource owner\u2019s Google connection." };
  if (response.data.length > 50000)
    return { state: "too_large", allowed: true, message: "The connected provider returned too much data. Use a smaller table or a connection that supports cell ranges." };
  return { state: "ready", allowed: true, data: response.data, resource: resource.id };
}
// modules/telegram-corporate/adapters/google.ts
import { join as join4 } from "path";
import { Database as Database3 } from "bun:sqlite";

// modules/telegram-corporate/adapters/command.ts
var OUTPUT_LIMIT = 256 * 1024;
var TERMINATION_GRACE_MS = 100;
async function bounded(stream, limitBytes = OUTPUT_LIMIT) {
  if (stream == null)
    return { value: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder;
  let output = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done)
        break;
      bytes += next.value.byteLength;
      if (bytes > limitBytes)
        truncated = true;
      if (!truncated)
        output += decoder.decode(next.value, { stream: true });
    }
    if (!truncated)
      output += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return {
    value: truncated ? JSON.stringify({ incomplete: true, reason: "command_capture_limit", limitBytes }) : output,
    truncated
  };
}
var runBoundedCommand = async (spec, signal) => {
  if (signal.aborted)
    return { exitCode: 130, stdout: "", stderr: "" };
  let child;
  try {
    child = Bun.spawn(spec.argv, {
      cwd: spec.cwd,
      detached: true,
      env: spec.env,
      stdin: spec.stdin == null ? "ignore" : new TextEncoder().encode(spec.stdin),
      stdout: "pipe",
      stderr: "pipe"
    });
  } catch {
    return { exitCode: 127, stdout: "", stderr: "" };
  }
  let forceKill;
  const killCommandTree = (signal2) => {
    if (process.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
      try {
        process.kill(-child.pid, signal2);
        return;
      } catch {}
    }
    try {
      child.kill(signal2);
    } catch {}
  };
  const terminate = () => {
    killCommandTree("SIGTERM");
    if (forceKill === undefined) {
      forceKill = setTimeout(() => {
        killCommandTree("SIGKILL");
      }, TERMINATION_GRACE_MS);
    }
  };
  signal.addEventListener("abort", terminate, { once: true });
  let timeout;
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => {
      terminate();
      resolve(124);
    }, spec.timeoutMs);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      Promise.race([child.exited, timedOut]),
      bounded(child.stdout, Number.isSafeInteger(spec.maxOutputBytes) && spec.maxOutputBytes > 0 ? Math.min(spec.maxOutputBytes, 1024 * 1024) : OUTPUT_LIMIT),
      bounded(child.stderr)
    ]);
    return {
      exitCode: signal.aborted ? 130 : exitCode,
      stdout: signal.aborted ? "" : stdout.value,
      stderr: signal.aborted ? "" : stderr.value,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated
    };
  } catch {
    return { exitCode: 1, stdout: "", stderr: "" };
  } finally {
    if (timeout !== undefined)
      clearTimeout(timeout);
    if (forceKill !== undefined)
      clearTimeout(forceKill);
    signal.removeEventListener("abort", terminate);
  }
};

// modules/telegram-corporate/resource-folders.ts
var FOLDER_KEY = /^folder\.([A-Za-z0-9_-]{10,256})$/;
var DRIVE_ID = /^[A-Za-z0-9_-]{10,256}$/;
function allowedFolders(resource) {
  if (resource.connector !== "google")
    return [];
  const result = [];
  for (const [key, value] of Object.entries(resource.config)) {
    const match = FOLDER_KEY.exec(key);
    if (match == null)
      continue;
    const label = typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 120) : match[1];
    result.push({ folderId: match[1], label });
  }
  return result.sort((left, right) => left.label.localeCompare(right.label));
}
var PARENTS_TTL_MS = 10 * 60 * 1000;
var NEGATIVE_TTL_MS = 60 * 1000;
var MAX_DEPTH = 8;

class DriveFolderIndex {
  home;
  run;
  account;
  parentsCache = new Map;
  constructor(options) {
    this.home = options.home;
    this.account = options.account;
    this.run = options.run ?? runBoundedCommand;
  }
  async membership(fileId, folderIds, signal) {
    if (!DRIVE_ID.test(fileId) || folderIds.length === 0)
      return "outside";
    const targets = new Set(folderIds.filter((id) => DRIVE_ID.test(id)));
    if (targets.size === 0)
      return "outside";
    if (targets.has(fileId))
      return "inside";
    const seen = new Set([fileId]);
    let frontier = [fileId];
    let degraded = false;
    for (let depth = 0;depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const node of frontier) {
        if (signal.aborted)
          return "unknown";
        const parents = await this.parents(node, signal);
        if (parents == null) {
          degraded = true;
          continue;
        }
        for (const parent of parents) {
          if (targets.has(parent))
            return "inside";
          if (seen.has(parent))
            continue;
          seen.add(parent);
          next.push(parent);
        }
      }
      frontier = next;
    }
    return degraded ? "unknown" : "outside";
  }
  async parents(id, signal) {
    const cached = this.parentsCache.get(id);
    if (cached != null && cached.expiresAt > Date.now())
      return cached.value;
    const params = JSON.stringify({
      fileId: id,
      fields: "id,parents,trashed",
      supportsAllDrives: true
    });
    const result = await this.run({
      argv: [
        `${this.home}/bin/gog`,
        "--no-input",
        "--json",
        "--enable-commands=api,api.drive.files.get",
        "api",
        "call",
        "drive",
        "v3",
        "files.get",
        "--params",
        params
      ],
      cwd: this.home,
      env: {
        HOME: this.home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GOG_ACCOUNT: this.account
      },
      timeoutMs: 20000
    }, signal);
    if (result.exitCode !== 0) {
      this.parentsCache.set(id, { value: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
      return null;
    }
    let parents;
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed.id !== id)
        throw new Error("unexpected response");
      if (parsed.trashed === true)
        parents = [];
      else
        parents = Array.isArray(parsed.parents) ? parsed.parents.filter((p) => typeof p === "string" && DRIVE_ID.test(p)) : [];
    } catch {
      this.parentsCache.set(id, { value: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
      return null;
    }
    this.parentsCache.set(id, { value: parents, expiresAt: Date.now() + PARENTS_TTL_MS });
    return parents;
  }
}

// modules/telegram-corporate/adapters/slides.ts
import { Database as Database2 } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
var SHARE_EMAIL = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
function exactKeys2(args, keys) {
  return Object.keys(args).length === keys.length && keys.every((key) => Object.hasOwn(args, key));
}
function text(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value) && !value.startsWith("-");
}
function textMarkdown(value) {
  if (typeof value !== "string" || !/[\p{L}\p{N}]/u.test(value) || value.length > 1e4 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    return false;
  return !/!\s*\[|<|:fa[srbld]?-/i.test(value) && !/(?:^|\n)\s*(?:`{3,}|~{3,})\s*mermaid\b/i.test(value);
}
function uncertainCreation() {
  return {
    ok: false,
    code: "uncertain",
    message: "\u0421\u0442\u0430\u0442\u0443\u0441 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u0457 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E; \u0441\u043F\u0435\u0440\u0448\u0443 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u043D\u044E \u0434\u0456\u044E."
  };
}
function disabledApi(stderr) {
  return /Slides API is not enabled for this OAuth project/i.test(stderr) ? { ok: false, code: "failed", message: "Google Slides API \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E \u0432 Google Cloud \u043F\u0440\u043E\u0454\u043A\u0442\u0456 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F. \u0410\u0434\u043C\u0456\u043D\u0456\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443 \u0446\u044C\u043E\u0433\u043E \u043F\u0440\u043E\u0454\u043A\u0442\u0443 \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u043E \u0432\u0432\u0456\u043C\u043A\u043D\u0443\u0442\u0438 Google Slides API. \u041F\u043E\u0432\u0442\u043E\u0440\u043D\u0438\u0439 \u0432\u0445\u0456\u0434 \u0432 \u0430\u043A\u0430\u0443\u043D\u0442 \u0446\u044C\u043E\u0433\u043E \u043D\u0435 \u0432\u0438\u043F\u0440\u0430\u0432\u0438\u0442\u044C." } : null;
}

class SlidesAdapter {
  home;
  run;
  createdSlideIds;
  constructor(options) {
    this.home = options.home;
    this.run = options.run ?? runBoundedCommand;
    this.createdSlideIds = options.createdSlideIds ?? ((resourceId) => {
      let db;
      try {
        db = new Database2(join(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
        return createdGoogleSlideIds(db, resourceId);
      } catch {
        return [];
      } finally {
        db?.close();
      }
    });
  }
  async execute(request, signal) {
    if (signal.aborted)
      return { ok: false, code: "unavailable" };
    const account = request.resource.config.account;
    if (request.resource.connector !== "google" || !text(account, 254) || !account.includes("@")) {
      return { ok: false, code: "invalid" };
    }
    if (request.capability === "google.slides.read" && request.operation === "get") {
      return this.get(request, account, signal);
    }
    if (request.capability === "google.slides.write" && request.operation === "create") {
      return this.create(request, account, signal);
    }
    return { ok: false, code: "invalid", message: "\u0414\u043B\u044F Slides \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0456 \u043B\u0438\u0448\u0435 get(presentationId, slideId?) \u0442\u0430 create(title, markdown)." };
  }
  command(account, command, args, readonly = false) {
    return {
      argv: [
        join(this.home, "bin", "gog"),
        "--no-input",
        "--json",
        ...readonly ? ["--readonly"] : [],
        ...command === "slides.create-from-markdown" ? ["--select=file"] : [],
        `--enable-commands-exact=${command}`,
        ...command.split("."),
        ...args
      ],
      cwd: this.home,
      env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 60000
    };
  }
  async get(request, account, signal) {
    const id = request.arguments.presentationId;
    const hasSlide = Object.hasOwn(request.arguments, "slideId");
    const slideId = request.arguments.slideId;
    if (!exactKeys2(request.arguments, hasSlide ? ["presentationId", "slideId"] : ["presentationId"]) || typeof id !== "string" || !GOOGLE_FILE_ID.test(id) || hasSlide && (typeof slideId !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_:-]{0,255}$/.test(slideId))) {
      return { ok: false, code: "invalid", message: "\u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D presentationId; \u0434\u043E\u0434\u0430\u0439 slideId \u0437\u0456 \u0441\u043F\u0438\u0441\u043A\u0443 \u0441\u043B\u0430\u0439\u0434\u0456\u0432, \u0449\u043E\u0431 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u0438 \u0439\u043E\u0433\u043E \u0442\u0435\u043A\u0441\u0442." };
    }
    let created = [];
    try {
      created = this.createdSlideIds(request.resource.id);
    } catch {}
    if (!Object.hasOwn(request.resource.config, `slide.${id}`) && !Object.hasOwn(request.resource.config, `file.${id}`) && !created.some((value) => GOOGLE_FILE_ID.test(value) && value === id)) {
      return { ok: false, code: "invalid", message: "\u041F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u044F \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u044F\u0432\u043D\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 \u0444\u0430\u0439\u043B\u0456\u0432 \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443." };
    }
    try {
      const command = hasSlide ? this.command(account, "slides.read-slide", [id, slideId], true) : this.command(account, "slides.list-slides", [id], true);
      const result = await this.run(command, signal);
      if (result.exitCode === 0)
        return { ok: true, data: result.stdout };
      const blocked = disabledApi(result.stderr);
      if (blocked != null)
        return blocked;
      return {
        ok: false,
        code: [124, 130].includes(result.exitCode) ? "unavailable" : "failed",
        message: "Google Slides \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432 \u0447\u0438\u0442\u0430\u043D\u043D\u044F \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E\u0457 \u043F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u0457."
      };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }
  async create(request, account, signal) {
    const { title, markdown } = request.arguments;
    if (request.resource.config.allowCreate !== true) {
      return { ok: false, code: "invalid", message: "\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u0439 \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 \u044F\u0432\u043D\u043E\u0433\u043E allowCreate=true \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443." };
    }
    if (!exactKeys2(request.arguments, ["title", "markdown"]) || !text(title, 512) || !textMarkdown(markdown)) {
      return { ok: false, code: "invalid", message: "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 title (\u0434\u043E 512 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432) \u0442\u0430 \u0442\u0435\u043A\u0441\u0442\u043E\u0432\u0438\u0439 markdown (\u0434\u043E 10000 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432), \u0431\u0435\u0437 \u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u044C, HTML, \u0456\u043A\u043E\u043D\u043E\u043A \u0447\u0438 Mermaid. \u0406\u043D\u0448\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u0437\u0430\u0431\u043E\u0440\u043E\u043D\u0435\u043D\u0456." };
    }
    const recipient = request.resource.config.createShareEmail;
    if (recipient !== undefined && (!text(recipient, 254) || recipient.indexOf("@") > 64 || !SHARE_EMAIL.test(recipient))) {
      return { ok: false, code: "invalid", message: "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 createShareEmail \u0443 \u0434\u043E\u0432\u0456\u0440\u0435\u043D\u0438\u0445 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F\u0445 \u0440\u0435\u0441\u0443\u0440\u0441\u0443. \u041F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u044E \u043D\u0435 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043E." };
    }
    let directory;
    let launched = false;
    try {
      directory = await mkdtemp(join(tmpdir(), "corporate-slides-"));
      const input = join(directory, "deck.md");
      await writeFile(input, markdown, { mode: 384, flag: "wx" });
      if (signal.aborted)
        return { ok: false, code: "unavailable" };
      launched = true;
      const result = await this.run(this.command(account, "slides.create-from-markdown", [
        title,
        "--content-file",
        input,
        "--mmdc="
      ]), signal);
      if (result.exitCode !== 0)
        return disabledApi(result.stderr) ?? uncertainCreation();
      let receipt;
      try {
        const parsed = JSON.parse(result.stdout);
        const ids = [parsed.presentationId, parsed.id, parsed.presentation?.presentationId, parsed.file?.id].filter((value) => value !== undefined);
        if (ids.length === 0 || !ids.every((value) => typeof value === "string" && GOOGLE_FILE_ID.test(value)) || new Set(ids).size !== 1)
          return uncertainCreation();
        receipt = ids[0];
      } catch {
        return uncertainCreation();
      }
      if (typeof receipt !== "string" || !GOOGLE_FILE_ID.test(receipt))
        return uncertainCreation();
      let shared = false;
      if (recipient !== undefined && !signal.aborted) {
        try {
          const share = await this.run(this.command(account, "drive.share", [
            receipt,
            "--to",
            "user",
            "--email",
            recipient,
            "--role",
            "writer"
          ]), signal);
          shared = share.exitCode === 0;
        } catch {}
      }
      const sharingFailed = recipient !== undefined && !shared;
      return {
        ok: true,
        receiptId: receipt,
        ...sharingFailed ? { warningCode: "recipient_share_failed" } : {},
        data: JSON.stringify({
          presentationId: receipt,
          presentationUrl: `https://docs.google.com/presentation/d/${receipt}/edit`,
          title,
          ...recipient !== undefined ? { recipientSharing: { status: shared ? "granted" : "not_confirmed", role: "writer" } } : {},
          ...sharingFailed ? { warning: "\u041F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u044E \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043E, \u0430\u043B\u0435 \u0434\u043E\u0441\u0442\u0443\u043F \u043E\u0434\u0435\u0440\u0436\u0443\u0432\u0430\u0447\u0443 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F; \u0437\u0431\u0435\u0440\u0435\u0436\u0438 ID \u0442\u0430 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u0434\u043E\u0441\u0442\u0443\u043F \u043E\u043A\u0440\u0435\u043C\u043E." } : {}
        })
      };
    } catch {
      return launched ? uncertainCreation() : { ok: false, code: "unavailable" };
    } finally {
      if (directory != null)
        await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// modules/telegram-corporate/adapters/docs-write.ts
import { join as join2 } from "path";
function uncertainAppend() {
  return {
    ok: false,
    code: "uncertain",
    message: "\u0421\u0442\u0430\u0442\u0443\u0441 \u0434\u043E\u043F\u0438\u0441\u0443\u0432\u0430\u043D\u043D\u044F \u0434\u043E \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0434\u0456\u044E \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E: \u0441\u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u043A\u0456\u043D\u0435\u0446\u044C \u0446\u044C\u043E\u0433\u043E \u0436 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430, \u0449\u043E\u0431 \u043D\u0435 \u043F\u0440\u043E\u0434\u0443\u0431\u043B\u044E\u0432\u0430\u0442\u0438 \u0437\u0432\u0456\u0442."
  };
}

class DocsWriteAdapter {
  home;
  run;
  createdDocumentIds;
  authorizeFile;
  constructor(options) {
    this.home = options.home;
    this.run = options.run ?? runBoundedCommand;
    this.createdDocumentIds = options.createdDocumentIds ?? (() => []);
    this.authorizeFile = options.authorizeFile;
  }
  async execute(request, signal) {
    if (signal.aborted)
      return { ok: false, code: "unavailable" };
    const account = request.resource.config.account;
    if (request.resource.connector !== "google" || request.capability !== "google.docs.write" || request.operation !== "append" || typeof account !== "string" || account.length > 254 || account.startsWith("-") || !/^[^\s@]+@[^\s@]+$/.test(account)) {
      return { ok: false, code: "invalid" };
    }
    const { docId } = request.arguments;
    const field = Object.hasOwn(request.arguments, "text") ? "text" : "content";
    const text2 = request.arguments[field];
    if (Object.keys(request.arguments).length !== 2 || !Object.hasOwn(request.arguments, "docId") || !Object.hasOwn(request.arguments, field) || typeof docId !== "string" || !GOOGLE_FILE_ID.test(docId) || docId.startsWith("-") || typeof text2 !== "string" || text2.trim().length === 0 || text2.length > (field === "content" ? 1e5 : 1e4) || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text2)) {
      return { ok: false, code: "invalid", message: "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u0435 \u043B\u0438\u0448\u0435 append \u0437 docId \u0442\u0430 \u0437\u0432\u0438\u0447\u0430\u0439\u043D\u0438\u043C text \u0434\u043E 10000 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432. \u0417\u0430\u043C\u0456\u043D\u0430, \u0444\u043E\u0440\u043C\u0430\u0442\u0443\u0432\u0430\u043D\u043D\u044F, \u0448\u043B\u044F\u0445\u0438 \u0442\u0430 \u0456\u043D\u0448\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u0437\u0430\u0431\u043E\u0440\u043E\u043D\u0435\u043D\u0456." };
    }
    if (this.authorizeFile) {
      try {
        const denial = await this.authorizeFile(request, account, signal);
        if (denial != null)
          return { ok: false, code: "invalid", message: denial };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    } else if (!Object.hasOwn(request.resource.config, `doc.${docId}`) && !this.createdDocumentIds(request.resource.id).includes(docId)) {
      return { ok: false, code: "invalid", message: "\u0426\u0435\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u044F\u0432\u043D\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 doc.<id> \u043F\u043E\u0442\u043E\u0447\u043D\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443." };
    }
    try {
      const result = await this.run({
        argv: [
          join2(this.home, "bin", "gog"),
          "--no-input",
          "--json",
          "--enable-commands-exact=docs.write",
          "docs",
          "write",
          docId,
          "--append",
          ...field === "content" ? ["--file", "-"] : [`--text=${text2}`]
        ],
        cwd: this.home,
        env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
        timeoutMs: 60000,
        ...field === "content" ? { stdin: text2 } : {}
      }, signal);
      if (result.exitCode !== 0)
        return uncertainAppend();
      const receipt = JSON.parse(result.stdout);
      if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt) || receipt.documentId !== docId || receipt.append !== true || receipt.requests !== 1 || !Number.isSafeInteger(receipt.index) || receipt.index < 1 || receipt.dry_run === true || receipt.queued === true || Object.hasOwn(receipt, "error")) {
        return uncertainAppend();
      }
      return {
        ok: true,
        receiptId: receipt.documentId,
        data: JSON.stringify({
          documentId: receipt.documentId,
          documentUrl: `https://docs.google.com/document/d/${receipt.documentId}/edit`,
          append: true,
          requests: 1,
          index: receipt.index
        })
      };
    } catch {
      return uncertainAppend();
    }
  }
}

// modules/telegram-corporate/adapters/sheets-batch.ts
var record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var object = (fields, required = []) => (value) => record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => Object.hasOwn(fields, key) && fields[key](value[key]));
var integer = (min, max) => (value) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
var string = (max) => (value) => typeof value === "string" && value.length <= max && !value.includes("\x00");
var oneOf = (...values) => (value) => typeof value === "string" && values.includes(value);
var boolean = (value) => typeof value === "boolean";
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var array = (check, max) => (value) => Array.isArray(value) && value.length > 0 && value.length <= max && value.every(check);
var index = integer(0, 1e6);
var sheetId = integer(0, 2147483647);
var LOCAL_FUNCTIONS = new Set(("SUM SUMIF SUMIFS SUMPRODUCT COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS AVERAGE AVERAGEIF AVERAGEIFS " + "MIN MAX MEDIAN ROUND ROUNDUP ROUNDDOWN FLOOR CEILING ABS MOD POWER SQRT INT PRODUCT " + "IF IFS IFERROR IFNA AND OR NOT TRUE FALSE ISBLANK ISNUMBER ISTEXT ISERROR ISNA " + "INDEX MATCH XMATCH XLOOKUP VLOOKUP HLOOKUP LOOKUP FILTER SORT SORTN UNIQUE QUERY " + "TRIM CLEAN LOWER UPPER PROPER TEXT VALUE DATE TIME DATEVALUE TIMEVALUE YEAR MONTH DAY HOUR MINUTE SECOND " + "WEEKDAY WEEKNUM ISOWEEKNUM EDATE EOMONTH TODAY NOW NETWORKDAYS WORKDAY DAYS DATEDIF " + "ARRAYFORMULA SUBTOTAL SPLIT JOIN TEXTJOIN CONCAT CONCATENATE LEFT RIGHT MID LEN FIND SEARCH SUBSTITUTE REPLACE " + "REGEXMATCH REGEXEXTRACT REGEXREPLACE TRANSPOSE ROW ROWS COLUMN COLUMNS SEQUENCE").split(" "));
function safeFormula(value) {
  const code = value.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, "");
  const calls = /([\p{L}_][\p{L}\p{N}_.]*)\s*\(/gu;
  if (/[\[\]\\\0]/.test(code) || [...code.matchAll(calls)].some((match) => !LOCAL_FUNCTIONS.has(match[1].toUpperCase())))
    return false;
  const remainder = code.replace(calls, "(").replace(/[\p{L}_][\p{L}\p{N}_.]*!/gu, "!").replace(/\b(?:TRUE|FALSE)\b/gi, "").replace(/\b[A-Z]{1,3}\$?[1-9]\d*\b/gi, "").replace(/\b[A-Z]{1,3}\b(?=\s*:)/gi, "").replace(/:\s*\$?[A-Z]{1,3}\b/gi, ":").replace(/\b\d+(?:\.\d*)?(?:E[+-]?\d+)?\b/gi, "");
  return !/[\p{L}\p{Cf}_]/u.test(remainder);
}
function validSheetsValues(values) {
  return array(array((value) => value === null || boolean(value) || finite(value) || string(1e4)(value) && (!/^\s*[=+@-]/.test(value) || safeFormula(value)), 1000), 1000)(values);
}
function hasOnlySheetsLiteralPrefixErrors(values) {
  let blockedLiteral = false;
  const otherwiseValid = array(array((value) => {
    if (validSheetsValues([[value]]))
      return true;
    if (string(1e4)(value) && /^\s*[@+-]/.test(value) && !/[()]/.test(value)) {
      blockedLiteral = true;
      return true;
    }
    return false;
  }, 1000), 1000)(values);
  return otherwiseValid && blockedLiteral;
}
var color = object(Object.fromEntries(["red", "green", "blue", "alpha"].map((key) => [
  key,
  (value) => finite(value) && Number(value) >= 0 && Number(value) <= 1
])));
var colorStyle = (value) => object({ rgbColor: color, themeColor: oneOf("TEXT", "BACKGROUND", "ACCENT1", "ACCENT2", "ACCENT3", "ACCENT4", "ACCENT5", "ACCENT6", "LINK") })(value) && Object.keys(value).length === 1;
var border = object({ style: oneOf("NONE", "DOTTED", "DASHED", "SOLID", "SOLID_MEDIUM", "SOLID_THICK", "DOUBLE"), color, colorStyle }, ["style"]);
var format = object({
  backgroundColor: color,
  backgroundColorStyle: colorStyle,
  textFormat: object({
    foregroundColor: color,
    foregroundColorStyle: colorStyle,
    fontFamily: string(100),
    fontSize: integer(1, 400),
    bold: boolean,
    italic: boolean,
    strikethrough: boolean,
    underline: boolean
  }),
  numberFormat: object({ type: oneOf("TEXT", "NUMBER", "PERCENT", "CURRENCY", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"), pattern: string(200) }, ["type"]),
  horizontalAlignment: oneOf("LEFT", "CENTER", "RIGHT"),
  verticalAlignment: oneOf("TOP", "MIDDLE", "BOTTOM"),
  wrapStrategy: oneOf("OVERFLOW_CELL", "CLIP", "WRAP"),
  textDirection: oneOf("LEFT_TO_RIGHT", "RIGHT_TO_LEFT"),
  textRotation: object({ angle: integer(-90, 90), vertical: boolean }),
  borders: object({ top: border, bottom: border, left: border, right: border }),
  padding: object({ top: integer(0, 100), bottom: integer(0, 100), left: integer(0, 100), right: integer(0, 100) })
});
var enteredValue = (value) => object({
  stringValue: string(1e4),
  numberValue: finite,
  boolValue: boolean,
  formulaValue: (value2) => typeof value2 === "string" && value2.length <= 1e4 && value2.startsWith("=") && safeFormula(value2)
})(value) && Object.keys(value).length === 1;
var cell = object({ userEnteredValue: enteredValue, userEnteredFormat: format, note: string(2000) });
var cellFields = (value) => typeof value === "string" && value.length > 0 && value.length <= 1000 && value.split(",").every((field) => /^(?:userEnteredValue|note|userEnteredFormat(?:\.[A-Za-z]+)*)$/.test(field));
var gridRange = (value) => object({ sheetId, startRowIndex: index, endRowIndex: index, startColumnIndex: integer(0, 18278), endColumnIndex: integer(1, 18278) }, ["sheetId", "endRowIndex", "endColumnIndex"])(value) && Number(value.endRowIndex) > Number(value.startRowIndex ?? 0) && Number(value.endColumnIndex) > Number(value.startColumnIndex ?? 0);
var dimensionRange = (value) => object({ sheetId, dimension: oneOf("ROWS", "COLUMNS"), startIndex: index, endIndex: index }, ["sheetId", "dimension", "endIndex"])(value) && Number(value.endIndex) > Number(value.startIndex ?? 0) && (value.dimension !== "COLUMNS" || Number(value.endIndex) <= 18278);
var gridProperties = object({ rowCount: integer(1, 1e6), columnCount: integer(1, 18278), frozenRowCount: index, frozenColumnCount: integer(0, 18278), hideGridlines: boolean });
var sheetProperties = object({ sheetId, title: (value) => string(100)(value) && value.trim().length > 0, gridProperties, tabColor: color, tabColorStyle: colorStyle }, ["sheetId"]);
var sheetFields = (value) => typeof value === "string" && value.length > 0 && value.length <= 500 && value.split(",").every((field) => /^(?:title|tabColor|tabColorStyle|gridProperties(?:\.(?:rowCount|columnCount|frozenRowCount|frozenColumnCount|hideGridlines))?)$/.test(field));
var REQUESTS = {
  repeatCell: object({ range: gridRange, cell, fields: cellFields }, ["range", "cell", "fields"]),
  updateCells: (value) => object({
    start: object({ sheetId, rowIndex: index, columnIndex: integer(0, 18277) }, ["sheetId"]),
    range: gridRange,
    rows: array(object({ values: array(cell, 1000) }, ["values"]), 1000),
    fields: cellFields
  }, ["rows", "fields"])(value) && Object.hasOwn(value, "start") !== Object.hasOwn(value, "range"),
  updateDimensionProperties: object({ range: dimensionRange, properties: object({ pixelSize: integer(1, 2000) }, ["pixelSize"]), fields: oneOf("pixelSize") }, ["range", "properties", "fields"]),
  autoResizeDimensions: object({ dimensions: dimensionRange }, ["dimensions"]),
  updateSheetProperties: object({ properties: sheetProperties, fields: sheetFields }, ["properties", "fields"]),
  addSheet: (value) => object({ properties: sheetProperties }, ["properties"])(value) && Object.hasOwn(value.properties, "title"),
  mergeCells: object({ range: gridRange, mergeType: oneOf("MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS") }, ["range", "mergeType"]),
  unmergeCells: object({ range: gridRange }, ["range"]),
  updateBorders: object({ range: gridRange, top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border }, ["range"]),
  copyPaste: object({ source: gridRange, destination: gridRange, pasteType: oneOf("PASTE_FORMAT"), pasteOrientation: oneOf("NORMAL", "TRANSPOSE") }, ["source", "destination", "pasteType"])
};
function validSheetsBatch(requests) {
  return array((value) => record(value) && Object.keys(value).length === 1 && Object.entries(value).every(([key, body]) => Object.hasOwn(REQUESTS, key) && REQUESTS[key](body)), 100)(requests) && JSON.stringify(requests).length <= 11000;
}

// modules/telegram-corporate/adapters/drive-files.ts
import { randomUUID as randomUUID2 } from "crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "fs";
import { dirname, join as join3 } from "path";
import { tmpdir as tmpdir2 } from "os";
var MAX_FILE_BYTES = 12 * 1024 * 1024;
var MAX_PAGE_SIZE = 10;
var PUBLISH_FILE = `
import json, os, stat, sys
workspace, device, inode, source, name, limit = sys.argv[1:]
directory = source_fd = target_fd = None
created = published = False
try:
    directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    def same_workspace():
        opened, path = os.fstat(directory), os.lstat(workspace)
        return (stat.S_ISDIR(path.st_mode) and not stat.S_ISLNK(path.st_mode)
                and opened.st_dev == path.st_dev == int(device)
                and opened.st_ino == path.st_ino == int(inode))
    if not same_workspace(): raise ValueError()
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    before = os.fstat(source_fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= int(limit): raise ValueError()
    with os.fdopen(source_fd, 'rb') as stream:
        source_fd = None
        data = stream.read(int(limit) + 1)
        after = os.fstat(stream.fileno())
    if len(data) != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns): raise ValueError()
    target_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    created = True
    with os.fdopen(target_fd, 'wb') as stream:
        target_fd = None
        stream.write(data)
    if not same_workspace(): raise ValueError()
    published = True
    print(json.dumps({'bytes': len(data)}))
except Exception:
    sys.exit(1)
finally:
    if created and not published:
        try: os.unlink(name, dir_fd=directory)
        except OSError: pass
    for fd in (target_fd, source_fd, directory):
        if fd is not None: os.close(fd)
`;
var EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx"
};
var EXPORTS = {
  "application/vnd.google-apps.document": "docx",
  "application/vnd.google-apps.spreadsheet": "xlsx",
  "application/vnd.google-apps.presentation": "pptx"
};
var invalid = (message) => ({ ok: false, code: "invalid", message });
function pageName(value) {
  let name = value.slice(0, 100);
  while (JSON.stringify(name).length > 102)
    name = name.slice(0, -1);
  return name;
}
function stagedFile(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_FILE_BYTES)
    throw new Error("invalid staged file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size)
      throw new Error("staged file changed");
    const head = Buffer.alloc(16);
    return { size: info.size, head: head.subarray(0, readSync(fd, head, 0, head.length, 0)) };
  } finally {
    closeSync(fd);
  }
}

class DriveFilesAdapter {
  options;
  constructor(options) {
    this.options = options;
  }
  async execute(request, signal) {
    const account = request.resource.config.account;
    if (typeof account !== "string" || !account.includes("@") || /[\r\n\0]/.test(account))
      return invalid("\u041D\u0435 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u0438\u0439 Google-\u0430\u043A\u0430\u0443\u043D\u0442 \u0440\u0435\u0441\u0443\u0440\u0441\u0443.");
    const args = request.arguments;
    const run = (method, params) => this.options.run({
      argv: [
        join3(this.options.home, "bin/gog"),
        "--no-input",
        "--json",
        "--readonly",
        `--enable-commands-exact=api.call,api.drive.${method.toLowerCase()}`,
        "api",
        "call",
        "drive",
        "v3",
        method,
        "--params",
        JSON.stringify(params)
      ],
      cwd: this.options.home,
      env: { HOME: this.options.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 30000
    }, signal);
    if (request.operation === "list") {
      if (Object.keys(args).some((key) => !["folderId", "max", "cursor"].includes(key)) || typeof args.folderId !== "string" || !GOOGLE_FILE_ID.test(args.folderId) || args.max !== undefined && (!Number.isSafeInteger(args.max) || Number(args.max) < 1 || Number(args.max) > 100) || args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(args.cursor)))
        return invalid("list \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 folderId, \u043D\u0435\u043E\u0431\u043E\u0432\u02BC\u044F\u0437\u043A\u043E\u0432\u043E max (1\u2013100) \u0456 cursor.");
      const folders = allowedFolders(request.resource).map((folder) => folder.folderId);
      const membership = await new DriveFolderIndex({ home: this.options.home, account, run: this.options.run }).membership(args.folderId, folders, signal);
      if (membership !== "inside")
        return invalid("\u0422\u0435\u043A\u0430 \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u0430\u0431\u043E \u0457\u0457 \u043D\u0430\u043B\u0435\u0436\u043D\u0456\u0441\u0442\u044C \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0430.");
      const pageSize = Math.min(Number(args.max ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE);
      const response = await run("files.list", {
        q: `'${args.folderId}' in parents and trashed = false`,
        pageSize,
        ...args.cursor ? { pageToken: args.cursor } : {},
        fields: "nextPageToken,files(id,name,mimeType,size,parents,trashed)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      if (response.exitCode !== 0 || response.stdoutTruncated || signal.aborted)
        return { ok: false, code: "unavailable" };
      try {
        const value = JSON.parse(response.stdout);
        if (!Array.isArray(value.files) || value.files.length > pageSize || value.nextPageToken !== undefined && (typeof value.nextPageToken !== "string" || value.nextPageToken.length > 2048 || /[\x00-\x1f\x7f]/.test(value.nextPageToken)))
          throw new Error("invalid page");
        const files = value.files.map((file2) => {
          if (typeof file2.id !== "string" || !GOOGLE_FILE_ID.test(file2.id) || file2.trashed === true || !Array.isArray(file2.parents) || !file2.parents.includes(args.folderId) || typeof file2.name !== "string" || typeof file2.mimeType !== "string" || file2.mimeType.length > 128 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file2.mimeType) || file2.size !== undefined && (typeof file2.size !== "string" || !/^\d{1,20}$/.test(file2.size)))
            throw new Error("invalid scoped file");
          const name = pageName(file2.name);
          return { id: file2.id, name, ...name !== file2.name ? { nameTruncated: true } : {}, mimeType: file2.mimeType, size: file2.size ?? null };
        });
        return { ok: true, data: JSON.stringify({ folderId: args.folderId, files, nextCursor: value.nextPageToken ?? null, incomplete: Boolean(value.nextPageToken) }) };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    }
    if (request.operation !== "download" || Object.keys(args).length !== 1 || typeof args.fileId !== "string" || !GOOGLE_FILE_ID.test(args.fileId)) {
      return invalid("download \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 \u043B\u0438\u0448\u0435 fileId; \u0448\u043B\u044F\u0445 \u0432\u0438\u0437\u043D\u0430\u0447\u0430\u0454 \u0441\u0438\u0441\u0442\u0435\u043C\u0430.");
    }
    const workspace = request.verified.workspace;
    let identity;
    try {
      const root = this.options.workspaceRoot ?? join3(this.options.home, "corporate-workspaces");
      if (typeof workspace !== "string" || dirname(workspace) !== root || !/^[a-f0-9]{64}$/.test(workspace.slice(root.length + 1)))
        throw new Error("invalid workspace");
      const before = lstatSync(workspace, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(workspace) !== join3(realpathSync(root), workspace.slice(root.length + 1)))
        throw new Error("invalid workspace");
      const fd = openSync(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(fd, { bigint: true });
        if (info.dev !== before.dev || info.ino !== before.ino)
          throw new Error("workspace changed");
        identity = { device: String(info.dev), inode: String(info.ino) };
      } finally {
        closeSync(fd);
      }
    } catch {
      return invalid("\u041D\u0435\u043C\u0430\u0454 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E\u0457 \u0440\u043E\u0431\u043E\u0447\u043E\u0457 \u0442\u0435\u043A\u0438 \u0446\u0456\u0454\u0457 \u0441\u0435\u0441\u0456\u0457; \u0444\u0430\u0439\u043B \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043E.");
    }
    const denial = await this.options.authorizeFile(request, account, signal);
    if (denial)
      return invalid(denial);
    const metadata = await run("files.get", { fileId: args.fileId, fields: "id,name,mimeType,size,trashed", supportsAllDrives: true });
    if (metadata.exitCode !== 0 || metadata.stdoutTruncated || signal.aborted)
      return { ok: false, code: "unavailable" };
    let file;
    try {
      file = JSON.parse(metadata.stdout);
      if (file.id !== args.fileId || typeof file.name !== "string" || typeof file.mimeType !== "string" || file.trashed)
        throw new Error("invalid metadata");
    } catch {
      return { ok: false, code: "unavailable" };
    }
    const format2 = EXPORTS[file.mimeType];
    if (!format2 && (!/^\d+$/.test(String(file.size)) || Number(file.size) > MAX_FILE_BYTES))
      return invalid("\u0424\u0430\u0439\u043B \u0437\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u0430\u0431\u043E \u0439\u043E\u0433\u043E \u0440\u043E\u0437\u043C\u0456\u0440 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E (\u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C 12 \u041C\u0411).");
    if (file.mimeType.startsWith("application/vnd.google-apps.") && !format2)
      return invalid("\u0426\u0435\u0439 \u0442\u0438\u043F Google-\u0444\u0430\u0439\u043B\u0430 \u043D\u0435 \u043F\u0456\u0434\u0442\u0440\u0438\u043C\u0443\u0454 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F; \u0441\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439\u0441\u044F \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u043D\u0438\u043C \u043A\u043E\u043D\u0435\u043A\u0442\u043E\u0440\u043E\u043C.");
    const temp = mkdtempSync(join3(tmpdir2(), "corporate-drive-"));
    const download = join3(temp, format2 ? `download.${format2}` : "download");
    try {
      const response = await this.options.run({
        argv: [
          "/usr/bin/prlimit",
          `--fsize=${MAX_FILE_BYTES}:${MAX_FILE_BYTES}`,
          "--",
          join3(this.options.home, "bin/gog"),
          "--no-input",
          "--json",
          "--readonly",
          "--enable-commands-exact=drive.download",
          "drive",
          "download",
          args.fileId,
          "--out",
          download,
          ...format2 ? ["--format", format2] : []
        ],
        cwd: this.options.home,
        env: { HOME: this.options.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
        timeoutMs: 60000
      }, signal);
      if (response.exitCode !== 0 || signal.aborted)
        return { ok: false, code: "unavailable" };
      let source = download;
      let info = stagedFile(source);
      const heif = info.head.subarray(4, 8).toString("ascii") === "ftyp" && ["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(info.head.subarray(8, 12).toString("ascii"));
      if (heif) {
        const conversionFailure = () => ({
          ok: false,
          code: "unavailable",
          message: "\u0424\u0430\u0439\u043B HEIF \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E, \u0430\u043B\u0435 \u043A\u043E\u043D\u0432\u0435\u0440\u0442\u0435\u0440 HEIF\u2192JPEG \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u0439 \u0430\u0431\u043E \u043D\u0435 \u0437\u043C\u0456\u0433 \u0431\u0435\u0437\u043F\u0435\u0447\u043D\u043E \u043E\u0431\u0440\u043E\u0431\u0438\u0442\u0438 \u0444\u043E\u0442\u043E. \u0426\u0435 \u043D\u0435 \u043F\u043E\u043C\u0438\u043B\u043A\u0430 \u0434\u043E\u0441\u0442\u0443\u043F\u0443 \u0434\u043E Google; \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0430 \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0430 \u043A\u043E\u043D\u0432\u0435\u0440\u0442\u0435\u0440\u0430 \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0456."
        });
        const converted = join3(temp, "converted.jpg");
        const conversion = await this.options.run({
          argv: [
            "/usr/bin/prlimit",
            `--fsize=${MAX_FILE_BYTES}:${MAX_FILE_BYTES}`,
            "--as=536870912:536870912",
            "--cpu=20:20",
            "--",
            join3(this.options.home, "bin/heic-to-jpg"),
            download,
            converted
          ],
          cwd: this.options.home,
          env: { HOME: this.options.home, PATH: "/usr/local/bin:/usr/bin:/bin" },
          timeoutMs: 30000
        }, signal);
        if (conversion.exitCode !== 0 || signal.aborted)
          return conversionFailure();
        try {
          info = stagedFile(converted);
          if (info.head.subarray(0, 3).toString("hex") !== "ffd8ff")
            return conversionFailure();
        } catch {
          return conversionFailure();
        }
        source = converted;
      }
      const name = `drive-${randomUUID2()}.${heif ? "jpg" : format2 ?? EXTENSIONS[file.mimeType] ?? "bin"}`;
      const target = join3(workspace, name);
      const publication = await runBoundedCommand({
        argv: ["python3", "-c", PUBLISH_FILE, workspace, identity.device, identity.inode, source, name, String(MAX_FILE_BYTES)],
        cwd: this.options.home,
        env: { HOME: this.options.home, PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeoutMs: 1e4
      }, signal);
      if (publication.exitCode !== 0 || signal.aborted)
        return { ok: false, code: "unavailable" };
      const published = JSON.parse(publication.stdout);
      if (published.bytes !== info.size)
        return { ok: false, code: "unavailable" };
      return { ok: true, data: JSON.stringify({
        fileId: file.id,
        name: file.name.slice(0, 300),
        mimeType: heif ? "image/jpeg" : file.mimeType,
        ...heif ? { conversion: "heif-to-jpeg" } : {},
        path: target,
        bytes: info.size,
        instruction: "Open this local file with Read or the appropriate file skill. This is a download, not delivery to Telegram."
      }) };
    } catch {
      return { ok: false, code: "unavailable" };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

// modules/telegram-corporate/adapters/google.ts
var REQUIRED_ARGUMENTS = {
  "google.sheets.read:get": ["spreadsheetId", "range"],
  "google.sheets.read:read_format": ["spreadsheetId", "range"],
  "google.sheets.read:read_layout": ["spreadsheetId", "range"],
  "google.sheets.write:update_cells": ["spreadsheetId", "range", "values"],
  "google.sheets.write:create": ["title"],
  "google.sheets.write:add_tab": ["spreadsheetId", "tabName"],
  "google.sheets.write:batch_update": ["spreadsheetId", "requests"],
  "google.docs.read:get": ["docId"],
  "google.docs.write:replace": ["docId", "content"],
  "google.docs.write:append": ["docId", "content"],
  "google.docs.write:create": ["title"],
  "google.drive.read:get": ["fileId"],
  "google.drive.share:share": ["fileId", "email", "role"],
  "google.gmail.read:get": ["messageId"],
  "google.calendar.read:get": ["eventId"],
  "google.contacts.read:get": ["resourceName"],
  "google.tasks.read:get": ["tasklistId", "taskId"],
  "google.tasks.write:complete": ["tasklistId", "taskId"]
};
var CREATE_SHARE_EMAIL = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
function exactKeys3(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index2) => key === expected[index2]);
}
function text2(value, max = 2000, allowLeadingDash = false) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\0\r\n]/.test(value) || !allowLeadingDash && value.startsWith("-"))
    return null;
  return value;
}
function boundedInt(value, fallback, maximum) {
  if (value == null)
    return fallback;
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum ? Number(value) : null;
}
function optionalFlag(args, flag, value, max = 200) {
  if (value == null)
    return true;
  const valid = text2(value, max);
  if (valid == null)
    return false;
  args.push(flag, valid);
  return true;
}

class GoogleAdapter {
  slides;
  docsWrite;
  driveFiles;
  home;
  run;
  createdSheetIds;
  createdSheetFiles;
  createdDocumentFiles;
  folderIndexes = new Map;
  constructor(options) {
    this.home = options.home;
    this.run = options.run ?? runBoundedCommand;
    this.driveFiles = new DriveFilesAdapter({ home: this.home, workspaceRoot: options.workspaceRoot, run: this.run, authorizeFile: (request, account, signal) => this.fileDenial(request, account, signal) });
    this.slides = new SlidesAdapter({ home: this.home, run: this.run });
    this.docsWrite = new DocsWriteAdapter({
      home: this.home,
      run: this.run,
      createdDocumentIds: (resourceId) => this.createdDocumentFiles(resourceId).map((file) => file.id),
      authorizeFile: (request, account, signal) => this.fileDenial(request, account, signal)
    });
    this.createdSheetIds = options.createdSheetIds ?? ((resourceId) => {
      let db;
      try {
        db = new Database3(join4(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
        return createdGoogleSheetIds(db, resourceId);
      } catch {
        return [];
      } finally {
        db?.close();
      }
    });
    this.createdSheetFiles = (resourceId) => {
      if (options.createdSheetIds != null) {
        return options.createdSheetIds(resourceId).filter((id) => GOOGLE_FILE_ID.test(id)).map((id) => ({ id, label: id, kind: "sheet" }));
      }
      let db;
      try {
        db = new Database3(join4(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
        return createdGoogleSheetFiles(db, resourceId);
      } catch {
        return [];
      } finally {
        db?.close();
      }
    };
    this.createdDocumentFiles = (resourceId) => {
      let db;
      try {
        db = new Database3(join4(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
        return createdGoogleDocFiles(db, resourceId);
      } catch {
        return [];
      } finally {
        db?.close();
      }
    };
  }
  async execute(request, signal) {
    if (request.resource.connector !== "google")
      return { ok: false, code: "invalid" };
    if (request.capability === "google.slides.read" || request.capability === "google.slides.write") {
      return this.slides.execute(request, signal);
    }
    if (request.capability === "google.docs.write") {
      if (request.resource.config.docsAppendOnly === true && request.operation !== "append") {
        return { ok: false, code: "invalid", message: "\u0426\u0435\u0439 \u0440\u043E\u0431\u043E\u0447\u0438\u0439 \u0440\u0435\u0441\u0443\u0440\u0441 \u0434\u043E\u0437\u0432\u043E\u043B\u044F\u0454 \u043B\u0438\u0448\u0435 \u0434\u043E\u043F\u0438\u0441\u0443\u0432\u0430\u043D\u043D\u044F; \u043D\u0430\u044F\u0432\u043D\u0438\u0439 \u0432\u043C\u0456\u0441\u0442 \u0456 \u041A\u0420\u0406 \u043D\u0435 \u0437\u0430\u043C\u0456\u043D\u044E\u044E\u0442\u044C\u0441\u044F." };
      }
      if (request.operation === "append")
        return this.docsWrite.execute(request, signal);
    }
    const account = text2(request.resource.config.account, 254);
    const service = this.service(request.capability);
    if (account == null || !account.includes("@") || service == null) {
      return { ok: false, code: "invalid" };
    }
    if (request.capability === "google.drive.read" && ["list", "download"].includes(request.operation))
      return this.driveFiles.execute(request, signal);
    const denial = await this.spreadsheetDenial(request, account, signal) ?? await this.shareDenial(request, account, signal) ?? await this.fileDenial(request, account, signal);
    if (denial != null)
      return { ok: false, code: "invalid", message: denial };
    const operation = this.operationArgs(request);
    if (operation == null) {
      return {
        ok: false,
        code: "invalid",
        message: this.argumentDenial(request)
      };
    }
    const isSheetCreate = request.capability === "google.sheets.write" && request.operation === "create";
    const isSheetMetadata = request.capability === "google.sheets.read" && request.operation === "metadata";
    const isSheetReadFormat = request.capability === "google.sheets.read" && request.operation === "read_format";
    const isSheetLayout = request.capability === "google.sheets.read" && request.operation === "read_layout";
    const isSheetBatch = request.capability === "google.sheets.write" && request.operation === "batch_update";
    const isDocRead = request.capability === "google.docs.read" && request.operation === "get";
    const configuredRecipient = isSheetCreate ? request.resource.config.createShareEmail : undefined;
    const recipient = configuredRecipient === undefined ? null : text2(configuredRecipient, 254);
    if (configuredRecipient !== undefined && (recipient == null || recipient.indexOf("@") > 64 || !CREATE_SHARE_EMAIL.test(recipient))) {
      return { ok: false, code: "invalid", message: "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0430 \u0430\u0434\u0440\u0435\u0441\u0430 createShareEmail \u0443 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F\u0445 \u0440\u0435\u0441\u0443\u0440\u0441\u0443. \u0422\u0430\u0431\u043B\u0438\u0446\u044E \u043D\u0435 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043E." };
    }
    if (request.capability === "google.drive.read" && request.operation === "search") {
      if (signal.aborted)
        return { ok: false, code: "unavailable" };
      return this.searchRegisteredFiles(request);
    }
    const stdin = isSheetBatch ? JSON.stringify({ requests: request.arguments.requests, includeSpreadsheetInResponse: false }) : request.capability === "google.docs.write" && (request.operation === "replace" || request.operation === "append") && typeof request.arguments.content === "string" ? request.arguments.content : undefined;
    const command = {
      argv: [
        join4(this.home, "bin", "gog"),
        "--no-input",
        "--json",
        ...isSheetBatch ? ["--enable-commands-exact=api.call,api.sheets.spreadsheets.batchupdate"] : isSheetLayout ? ["--readonly", "--enable-commands-exact=api.call,api.sheets.spreadsheets.get"] : isSheetMetadata ? ["--readonly", "--enable-commands-exact=sheets.metadata"] : isSheetReadFormat ? ["--readonly", "--enable-commands-exact=sheets.read-format"] : [`--enable-commands=${service}`],
        isSheetBatch || isSheetLayout ? "api" : service,
        ...operation
      ],
      cwd: this.home,
      env: {
        HOME: this.home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GOG_ACCOUNT: account
      },
      timeoutMs: 60000,
      ...stdin == null ? {} : { stdin },
      ...isDocRead ? { maxOutputBytes: 1024 * 1024 } : {}
    };
    const result = await this.run(command, signal);
    const isWrite = request.capability.endsWith(".write") || request.capability.endsWith(".send") || request.capability === "google.drive.share";
    if (result.exitCode === 0) {
      if (result.stdoutTruncated === true) {
        return { ok: false, code: isWrite ? "uncertain" : "failed", message: isWrite ? "\u0414\u0456\u044F \u043C\u043E\u0433\u043B\u0430 \u0432\u0438\u043A\u043E\u043D\u0430\u0442\u0438\u0441\u044C, \u0430\u043B\u0435 Google \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043D\u0435\u043F\u043E\u0432\u043D\u0438\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0437\u0430\u043F\u0438\u0441 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E; \u0441\u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u0439\u043E\u0433\u043E \u0441\u0442\u0430\u043D." : "Google \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043D\u0435\u043F\u043E\u0432\u043D\u0438\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0447\u0435\u0440\u0435\u0437 \u043B\u0456\u043C\u0456\u0442 \u043E\u0431\u0441\u044F\u0433\u0443. \u0417\u043C\u0435\u043D\u0448 \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D \u0447\u0438\u0442\u0430\u043D\u043D\u044F \u0430\u0431\u043E \u0437\u0430\u043F\u0438\u0442; \u0446\u0435 \u043D\u0435 \u0434\u043E\u043A\u0430\u0437 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u043E\u0441\u0442\u0456 \u0434\u0430\u043D\u0438\u0445." };
      }
      if (isSheetMetadata)
        return this.sheetMetadata(request, result.stdout);
      if (isSheetLayout) {
        try {
          const data = JSON.parse(result.stdout);
          if (data.spreadsheetId !== request.arguments.spreadsheetId || !Array.isArray(data.sheets) || data.sheets.length === 0 || data.sheets.some((sheet) => !Number.isSafeInteger(sheet?.properties?.sheetId) || Number(sheet.properties.sheetId) < 0 || typeof sheet.properties.title !== "string"))
            throw new Error("incomplete");
          if (result.stdout.length > 12000)
            return { ok: false, code: "failed", message: "\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D \u043E\u0444\u043E\u0440\u043C\u043B\u0435\u043D\u043D\u044F. \u0417\u0432\u0443\u0437\u044C read_layout; \u0446\u0435 \u043D\u0435 \u0434\u043E\u043A\u0430\u0437 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u043E\u0441\u0442\u0456 \u0444\u043E\u0440\u043C\u0430\u0442\u0443\u0432\u0430\u043D\u043D\u044F." };
        } catch {
          return { ok: false, code: "failed", message: "Google \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043D\u0435\u043F\u043E\u0432\u043D\u0456 \u043C\u0435\u0442\u0430\u0434\u0430\u043D\u0456 \u043E\u0444\u043E\u0440\u043C\u043B\u0435\u043D\u043D\u044F; \u0440\u043E\u0437\u043C\u0456\u0440\u0438 \u0442\u0430 \u0437\u0430\u043A\u0440\u0456\u043F\u043B\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0456." };
        }
      }
      if (isDocRead)
        return this.docPage(request, result.stdout);
      let receiptId = isWrite && !isSheetBatch ? this.receipt(result.stdout) : undefined;
      if (isSheetBatch) {
        try {
          const data = JSON.parse(result.stdout);
          if (data.spreadsheetId !== request.arguments.spreadsheetId || !Array.isArray(data.replies) || data.replies.length !== request.arguments.requests.length)
            throw new Error("incomplete");
          receiptId = data.spreadsheetId;
        } catch {
          return { ok: false, code: "uncertain", message: "\u0417\u043C\u0456\u043D\u0438 \u043C\u043E\u0433\u043B\u0438 \u0432\u0438\u043A\u043E\u043D\u0430\u0442\u0438\u0441\u044C, \u0430\u043B\u0435 \u043F\u043E\u0432\u043D\u0438\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0442\u0430\u0431\u043B\u0438\u0446\u0456 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 batch_update \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E; \u043F\u0435\u0440\u0435\u0432\u0456\u0440 read_format/read_layout." };
        }
      }
      if (isSheetCreate && (receiptId == null || !GOOGLE_FILE_ID.test(receiptId))) {
        return { ok: false, code: "uncertain", message: "\u0422\u0430\u0431\u043B\u0438\u0446\u044F \u043C\u043E\u0433\u043B\u0430 \u0431\u0443\u0442\u0438 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u0430, \u0430\u043B\u0435 \u0457\u0457 ID \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E." };
      }
      if (isSheetCreate && recipient != null && receiptId != null) {
        let shared = false;
        if (!signal.aborted) {
          try {
            const share = await this.run({
              ...command,
              argv: [
                join4(this.home, "bin", "gog"),
                "--no-input",
                "--json",
                "--enable-commands-exact=drive.share",
                "drive",
                "share",
                receiptId,
                "--to",
                "user",
                "--email",
                recipient,
                "--role",
                "writer"
              ]
            }, signal);
            shared = share.exitCode === 0 && share.stdoutTruncated !== true;
          } catch {}
        }
        return {
          ok: true,
          receiptId,
          warningCode: shared ? undefined : "recipient_share_failed",
          data: JSON.stringify({
            ...JSON.parse(result.stdout),
            recipientSharing: { status: shared ? "granted" : "not_confirmed", role: "writer" },
            ...!shared ? {
              warning: "\u0422\u0430\u0431\u043B\u0438\u0446\u044E \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043E, \u0430\u043B\u0435 \u0434\u043E\u0441\u0442\u0443\u043F \u043F\u043E\u0433\u043E\u0434\u0436\u0435\u043D\u043E\u043C\u0443 \u043E\u0434\u0435\u0440\u0436\u0443\u0432\u0430\u0447\u0443 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F; \u0437\u0431\u0435\u0440\u0435\u0436\u0438 \u0446\u0435\u0439 ID \u0442\u0430 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u0434\u043E\u0441\u0442\u0443\u043F \u043E\u043A\u0440\u0435\u043C\u043E."
            } : {}
          })
        };
      }
      if (request.capability === "google.docs.write" && request.operation === "create" && (receiptId == null || !GOOGLE_FILE_ID.test(receiptId))) {
        return { ok: false, code: "uncertain", message: "\u0414\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u043C\u0456\u0433 \u0431\u0443\u0442\u0438 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u0438\u0439, \u0430\u043B\u0435 \u0439\u043E\u0433\u043E ID \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E." };
      }
      if (request.capability === "google.docs.write" && request.operation === "replace") {
        const verdict = await this.verifyDocumentBody(String(request.arguments.docId), String(request.arguments.content), account, signal);
        if (verdict !== "match") {
          return {
            ok: false,
            code: "uncertain",
            message: verdict === "mismatch" ? "\u0417\u0430\u043F\u0438\u0441 \u0432\u0438\u043A\u043E\u043D\u0430\u043D\u043E, \u0430\u043B\u0435 \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0430 \u0435\u043A\u0441\u043F\u043E\u0440\u0442\u043E\u043C \u043F\u043E\u043A\u0430\u0437\u0430\u043B\u0430 \u0456\u043D\u0448\u0438\u0439 \u0432\u043C\u0456\u0441\u0442 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430. " + "\u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0437\u0430\u043F\u0438\u0441 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E \u2014 \u0441\u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442." : "\u0417\u0430\u043F\u0438\u0441 \u0432\u0438\u043A\u043E\u043D\u0430\u043D\u043E, \u0430\u043B\u0435 \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0438\u0442\u0438 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0435\u043A\u0441\u043F\u043E\u0440\u0442\u043E\u043C \u043D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F. " + "\u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0437\u0430\u043F\u0438\u0441 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E \u2014 \u0441\u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442."
          };
        }
      }
      return {
        ok: true,
        data: result.stdout,
        receiptId
      };
    }
    if (isWrite && (result.exitCode === 124 || isSheetBatch && result.exitCode === 130))
      return { ok: false, code: "uncertain" };
    if (result.exitCode === 130)
      return { ok: false, code: "unavailable" };
    if (result.exitCode === 124)
      return { ok: false, code: "unavailable" };
    return {
      ok: false,
      code: "failed",
      message: this.failureMessage(result.exitCode, result.stderr)
    };
  }
  failureMessage(exitCode, stderr) {
    const scrubbed = (stderr ?? "").replace(/[\w.+-]+@[\w.-]+\.\w+/g, "<email>").replace(/\/[\w./-]*\/(gog|home|claude)[\w./-]*/g, "<path>").replace(/\b(ya29|1\/\/|AIza)[\w.-]+/g, "<token>").split(`
`).map((line) => line.trim()).filter((line) => line.length > 0).join("; ").slice(0, 300);
    return scrubbed.length > 0 ? `Google CLI \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043F\u043E\u043C\u0438\u043B\u043A\u0443 (\u043A\u043E\u0434 ${exitCode}): ${scrubbed}` : `Google CLI \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043F\u043E\u043C\u0438\u043B\u043A\u0443 (\u043A\u043E\u0434 ${exitCode}) \u0431\u0435\u0437 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u043D\u044F.`;
  }
  argumentDenial(request) {
    const required = REQUIRED_ARGUMENTS[`${request.capability}:${request.operation}`];
    const supplied = Object.keys(request.arguments ?? {}).sort().join(", ") || "\u2014";
    const base = `\u0417\u0430\u043F\u0438\u0442 \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u043D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u0457 ` + `${request.capability}/${request.operation}. \u041D\u0430\u0434\u0430\u043D\u043E: ${supplied}.`;
    if (request.capability === "google.docs.read" && request.operation === "get") {
      return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D docId; \u043D\u0435\u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u043E offset (\u0446\u0456\u043B\u0435 \u043D\u0435\u0432\u0456\u0434'\u0454\u043C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E) \u0410\u0411\u041E query (\u0442\u0435\u043A\u0441\u0442 \u0434\u043B\u044F \u043F\u043E\u0448\u0443\u043A\u0443).`;
    }
    if (request.capability === "google.sheets.read" && request.operation === "metadata") {
      return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D spreadsheetId; \u043D\u0435\u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u0438\u0439 offset \u2014 \u0446\u0456\u043B\u0435 \u043D\u0435\u0432\u0456\u0434'\u0454\u043C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E \u0437 nextOffset \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u043D\u044C\u043E\u0457 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456.`;
    }
    if (request.capability === "google.sheets.write" && ["batch_update", "update_cells"].includes(request.operation)) {
      const { arguments: args } = request;
      const spreadsheetId = text2(args.spreadsheetId, 256);
      const literalGuidance = request.operation === "update_cells" && exactKeys3(args, ["spreadsheetId", "range", "values"]) && spreadsheetId != null && GOOGLE_FILE_ID.test(spreadsheetId) && text2(args.range, 512) != null && hasOnlySheetsLiteralPrefixErrors(args.values) && JSON.stringify(args.values).length <= 1e4 ? " update_cells \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0454 USER_ENTERED: \u043F\u043E\u0447\u0430\u0442\u043A\u043E\u0432\u0456 =, +, -, @, \u043D\u0430\u0432\u0456\u0442\u044C \u043F\u0456\u0441\u043B\u044F \u043F\u0440\u043E\u0431\u0456\u043B\u0456\u0432, \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u044F\u044E\u0442\u044C\u0441\u044F \u044F\u043A \u043F\u043E\u0442\u0435\u043D\u0446\u0456\u0439\u043D\u0456 \u0444\u043E\u0440\u043C\u0443\u043B\u0438. \u042F\u043A\u0449\u043E \u043F\u043E\u0442\u0440\u0456\u0431\u0435\u043D \u0441\u0430\u043C\u0435 \u0431\u0443\u043A\u0432\u0430\u043B\u044C\u043D\u0438\u0439 \u0442\u0435\u043A\u0441\u0442, \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439 batch_update \u0437 updateCells \u0442\u0430 userEnteredValue.stringValue, \u044F\u043A\u0449\u043E \u0446\u044F \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u044F \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0430 \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443. \u0417\u0431\u0435\u0440\u0435\u0436\u0438 \u0442\u043E\u0447\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F. \u041D\u0435 \u0432\u0438\u0434\u0430\u043B\u044F\u0439 \u0456 \u043D\u0435 \u0437\u0430\u043C\u0456\u043D\u044E\u0439 \u0441\u0438\u043C\u0432\u043E\u043B\u0438 \u0437\u0430\u0440\u0430\u0434\u0438 \u043F\u0440\u043E\u0445\u043E\u0434\u0436\u0435\u043D\u043D\u044F \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0438." : "";
      return `${base} \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0443: ${required?.join(", ")}.${literalGuidance} \u0414\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0456 \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u0457 \u0437 \u0434\u0430\u043D\u0438\u043C\u0438/\u043E\u0444\u043E\u0440\u043C\u043B\u0435\u043D\u043D\u044F\u043C \u0456 \u0437\u0432\u0438\u0447\u0430\u0439\u043D\u0456 \u0444\u043E\u0440\u043C\u0443\u043B\u0438 \u0437 A1-\u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F\u043C\u0438. \u0417\u043E\u0432\u043D\u0456\u0448\u043D\u0456 \u0434\u0436\u0435\u0440\u0435\u043B\u0430, IMAGE/IMPORT*, \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F-\u0444\u0443\u043D\u043A\u0446\u0456\u0457, \u043D\u0435\u0432\u0456\u0434\u043E\u043C\u0456 \u0444\u0443\u043D\u043A\u0446\u0456\u0457 \u0442\u0430 \u0456\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0456 \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D\u0438/\u0432\u0438\u0440\u0430\u0437\u0438 \u043D\u0435 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456; \u0434\u043B\u044F \u0456\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u043E\u0433\u043E \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D\u0443 \u0432\u043A\u0430\u0436\u0438 \u044F\u0432\u043D\u0456 A1-\u043A\u043E\u043E\u0440\u0434\u0438\u043D\u0430\u0442\u0438. \u0424\u043E\u0440\u043C\u0443\u043B\u0438 \u043D\u0435 \u043F\u0435\u0440\u0435\u0442\u0432\u043E\u0440\u044E\u044E\u0442\u044C\u0441\u044F \u043D\u0430 \u0442\u0435\u043A\u0441\u0442. \u041B\u0456\u043C\u0456\u0442 JSON \u2014 11000 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432 \u0434\u043B\u044F batch_update, 10000 \u0434\u043B\u044F values.`;
    }
    if (required == null)
      return `${base} \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u043F\u0435\u0440\u0435\u043B\u0456\u043A \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432 \u0446\u0456\u0454\u0457 \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u0457.`;
    return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 \u0440\u0456\u0432\u043D\u043E \u0442\u0430\u043A\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438: ${required.join(", ")}. ` + `\u041F\u043E\u0432\u0442\u043E\u0440\u0438 \u0437\u0430\u043F\u0438\u0442, \u0432\u043A\u0430\u0437\u0430\u0432\u0448\u0438 \u0457\u0445 \u0443\u0441\u0456 \u0439 \u043D\u0435 \u0434\u043E\u0434\u0430\u044E\u0447\u0438 \u0456\u043D\u0448\u0438\u0445.`;
  }
  async spreadsheetDenial(request, account, signal) {
    if (!["google.sheets.read", "google.sheets.write"].includes(request.capability))
      return null;
    if (request.capability === "google.sheets.write" && request.operation === "create") {
      return request.resource.config.allowCreate === true ? null : `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0442\u0430\u0431\u043B\u0438\u0446\u044C \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id} \u043D\u0435 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E (\u043F\u043E\u0442\u0440\u0456\u0431\u043D\u043E allowCreate=true).`;
    }
    const sheets = [
      ...allowedSheets(request.resource),
      ...this.createdSheetIds(request.resource.id).filter((id) => GOOGLE_FILE_ID.test(id)).map((spreadsheetId) => ({ spreadsheetId, label: "Created by this resource" }))
    ];
    const folders = allowedFolders(request.resource);
    if (sheets.length === 0 && folders.length === 0) {
      return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id} \u043D\u0435 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 ` + "\u0442\u0430\u0431\u043B\u0438\u0446\u044C (sheet.<spreadsheetId>) \u0430\u0431\u043E \u0442\u0435\u043A (folder.<folderId>); \u0434\u043E\u0441\u0442\u0443\u043F \u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439.";
    }
    const requested = request.arguments.spreadsheetId;
    if (requested == null)
      return null;
    if (typeof requested !== "string") {
      return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: spreadsheetId \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u0440\u044F\u0434\u043A\u043E\u043C.`;
    }
    if (sheets.some((sheet) => sheet.spreadsheetId === requested))
      return null;
    if (folders.length > 0) {
      const membership = await this.folderMembership(requested, folders.map((folder) => folder.folderId), account, signal);
      if (membership === "inside")
        return null;
      if (membership === "unknown") {
        return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u043D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0438\u0442\u0438, \u0447\u0438 \u0442\u0430\u0431\u043B\u0438\u0446\u044F ${requested} \u043B\u0435\u0436\u0438\u0442\u044C \u0443 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456\u0439 ` + "\u0442\u0435\u0446\u0456 (Google Drive \u043D\u0435 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0432). \u0421\u043F\u0440\u043E\u0431\u0443\u0439 \u0449\u0435 \u0440\u0430\u0437 \u043F\u0456\u0437\u043D\u0456\u0448\u0435; \u0434\u043E\u0441\u0442\u0443\u043F \u043F\u043E\u043A\u0438 \u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439.";
      }
    }
    const known = [
      ...sheets.map((sheet) => `${sheet.spreadsheetId} "${sheet.label}"`),
      ...folders.map((folder) => `\u0442\u0435\u043A\u0430 ${folder.folderId} "${folder.label}"`)
    ].join("; ");
    return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0442\u0430\u0431\u043B\u0438\u0446\u044F ${requested} \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0443 \u0440\u0435\u0441\u0443\u0440\u0441 ` + `${request.resource.id} ("${request.resource.label}"). ` + `\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u0456 \u0442\u0430\u0431\u043B\u0438\u0446\u0456 \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443: ${known}.`;
  }
  static SHARE_ROLES = new Set(["reader", "writer"]);
  static SHARE_EMAIL = /^[^\s@<>,;"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  async shareDenial(request, account, signal) {
    if (request.capability !== "google.drive.share")
      return null;
    if (request.operation !== "share") {
      return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u044F ${request.operation} \u043D\u0435 \u043F\u0456\u0434\u0442\u0440\u0438\u043C\u0443\u0454\u0442\u044C\u0441\u044F \u0434\u043B\u044F google.drive.share.`;
    }
    const role = request.arguments.role;
    if (typeof role !== "string" || !GoogleAdapter.SHARE_ROLES.has(role)) {
      return '\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0440\u043E\u043B\u044C \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 "reader" \u0430\u0431\u043E "writer". ' + "\u041F\u0435\u0440\u0435\u0434\u0430\u0447\u0430 \u043F\u0440\u0430\u0432 \u0432\u043B\u0430\u0441\u043D\u0438\u043A\u0430 (owner) \u0437\u0430\u0431\u043E\u0440\u043E\u043D\u0435\u043D\u0430 \u2014 \u0446\u0435 \u043D\u0435\u0437\u0432\u043E\u0440\u043E\u0442\u043D\u0430 \u0434\u0456\u044F.";
    }
    const email = request.arguments.email;
    if (typeof email !== "string" || !GoogleAdapter.SHARE_EMAIL.test(email)) {
      return "\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: email \u043E\u0442\u0440\u0438\u043C\u0443\u0432\u0430\u0447\u0430 \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u043E\u0434\u043D\u043E\u044E \u043A\u043E\u0440\u0435\u043A\u0442\u043D\u043E\u044E \u0430\u0434\u0440\u0435\u0441\u043E\u044E.";
    }
    const requested = request.arguments.fileId;
    if (typeof requested !== "string" || !GOOGLE_FILE_ID.test(requested)) {
      return "\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: fileId \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u043C \u0456\u0434\u0435\u043D\u0442\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440\u043E\u043C \u0444\u0430\u0439\u043B\u0430 Google.";
    }
    const explicit = new Set([
      ...allowedSheets(request.resource).map((sheet) => sheet.spreadsheetId),
      ...this.permittedDriveFiles(request.resource).map((file) => file.id)
    ]);
    const folders = allowedFolders(request.resource);
    if (explicit.size === 0 && folders.length === 0) {
      return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id} \u043D\u0435 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 ` + "\u0444\u0430\u0439\u043B\u0456\u0432 \u0430\u0431\u043E \u0442\u0435\u043A; \u0432\u0438\u0434\u0430\u0447\u0430 \u0434\u043E\u0441\u0442\u0443\u043F\u0443 \u0437\u0430\u043A\u0440\u0438\u0442\u0430.";
    }
    if (explicit.has(requested))
      return null;
    if (folders.length > 0) {
      const membership = await this.folderMembership(requested, folders.map((folder) => folder.folderId), account, signal);
      if (membership === "inside")
        return null;
      if (membership === "unknown") {
        return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u043D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0438\u0442\u0438, \u0447\u0438 \u0444\u0430\u0439\u043B ${requested} \u043B\u0435\u0436\u0438\u0442\u044C \u0443 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456\u0439 ` + "\u0442\u0435\u0446\u0456 (Google Drive \u043D\u0435 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0432). \u0414\u043E\u0441\u0442\u0443\u043F \u043D\u0435 \u0432\u0438\u0434\u0430\u043D\u043E; \u0441\u043F\u0440\u043E\u0431\u0443\u0439 \u043F\u0456\u0437\u043D\u0456\u0448\u0435.";
      }
    }
    return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0444\u0430\u0439\u043B ${requested} \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0443 \u0440\u0435\u0441\u0443\u0440\u0441 ${request.resource.id} ` + `("${request.resource.label}"), \u0442\u043E\u043C\u0443 \u0432\u0438\u0434\u0430\u0442\u0438 \u043D\u0430 \u043D\u044C\u043E\u0433\u043E \u0434\u043E\u0441\u0442\u0443\u043F \u043D\u0435 \u043C\u043E\u0436\u043D\u0430.`;
  }
  folderMembership(fileId, folderIds, account, signal) {
    let index2 = this.folderIndexes.get(account);
    if (index2 == null) {
      index2 = new DriveFolderIndex({ home: this.home, account, run: this.run });
      this.folderIndexes.set(account, index2);
    }
    return index2.membership(fileId, folderIds, signal);
  }
  async fileDenial(request, account, signal) {
    if (!["google.docs.read", "google.docs.write", "google.drive.read"].includes(request.capability)) {
      return null;
    }
    const docsOnly = request.capability === "google.docs.read" || request.capability === "google.docs.write";
    if (request.capability === "google.docs.write" && request.operation === "create") {
      return request.resource.config.allowCreate === true ? null : `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0456\u0432 \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id} \u043D\u0435 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E (\u043F\u043E\u0442\u0440\u0456\u0431\u043D\u043E allowCreate=true).`;
    }
    const files = docsOnly ? [...allowedGoogleFiles(request.resource, "doc"), ...this.createdDocumentFiles(request.resource.id)] : this.permittedDriveFiles(request.resource);
    const folders = allowedFolders(request.resource);
    if (files.length === 0 && folders.length === 0) {
      return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id} \u043D\u0435 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 ` + `\u0444\u0430\u0439\u043B\u0456\u0432 (${docsOnly ? "doc.<docId>" : "sheet.<id>, doc.<id> \u0430\u0431\u043E file.<id>"}); \u0434\u043E\u0441\u0442\u0443\u043F \u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439.`;
    }
    if (!docsOnly && request.operation === "search")
      return null;
    const field = docsOnly ? "docId" : "fileId";
    const requested = request.arguments[field];
    if (requested == null)
      return null;
    if (typeof requested !== "string")
      return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: ${field} \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u0440\u044F\u0434\u043A\u043E\u043C.`;
    if (files.some((file) => file.id === requested))
      return null;
    if (GOOGLE_FILE_ID.test(requested) && folders.length > 0) {
      const membership = await new DriveFolderIndex({ home: this.home, account, run: this.run }).membership(requested, folders.map((folder) => folder.folderId), signal);
      if (membership === "inside")
        return null;
      if (membership === "unknown")
        return "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0438\u0442\u0438 \u043D\u0430\u043B\u0435\u0436\u043D\u0456\u0441\u0442\u044C \u0444\u0430\u0439\u043B\u0430 \u0434\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E\u0457 \u0442\u0435\u043A\u0438. \u0414\u043E\u0441\u0442\u0443\u043F \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E; \u0441\u043F\u0440\u043E\u0431\u0443\u0439 \u043F\u0456\u0437\u043D\u0456\u0448\u0435.";
    }
    return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: ${field} \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 \u0444\u0430\u0439\u043B\u0456\u0432 \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id}. ` + "\u0412\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439 \u043B\u0438\u0448\u0435 \u044F\u0432\u043D\u043E \u0437\u0430\u0440\u0435\u0454\u0441\u0442\u0440\u043E\u0432\u0430\u043D\u0438\u0439 ID; \u0434\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u0456\u043D\u0448\u0438\u0445 \u0444\u0430\u0439\u043B\u0456\u0432 \u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439.";
  }
  async verifyDocumentBody(docId, expected, account, signal) {
    if (!GOOGLE_FILE_ID.test(docId))
      return "unknown";
    const result = await this.run({
      argv: [
        join4(this.home, "bin", "gog"),
        "--no-input",
        "--enable-commands=docs,docs.cat",
        "docs",
        "cat",
        docId
      ],
      cwd: this.home,
      env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 30000
    }, signal);
    if (result.exitCode !== 0 || result.stdoutTruncated === true)
      return "unknown";
    const normalise = (value) => value.replace(/\s+/g, " ").trim();
    const actual = normalise(result.stdout);
    const wanted = normalise(expected);
    if (wanted.length === 0)
      return "unknown";
    if (actual === wanted)
      return "match";
    return "mismatch";
  }
  permittedDriveFiles(resource) {
    const files = new Map(allowedGoogleFiles(resource).map((file) => [file.id, file]));
    for (const file of this.createdSheetFiles(resource.id)) {
      if (!files.has(file.id))
        files.set(file.id, file);
    }
    for (const file of this.createdDocumentFiles(resource.id)) {
      if (!files.has(file.id))
        files.set(file.id, file);
    }
    let db;
    try {
      db = new Database3(join4(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
      for (const file of createdGoogleSlideFiles(db, resource.id)) {
        if (!files.has(file.id))
          files.set(file.id, file);
      }
    } catch {} finally {
      db?.close();
    }
    return [...files.values()];
  }
  searchRegisteredFiles(request) {
    const query = request.arguments.query.trim().toLowerCase();
    const max = Number(request.arguments.max ?? 20);
    const matches = this.permittedDriveFiles(request.resource).filter((file) => query === "*" || file.id.toLowerCase().includes(query) || file.label.toLowerCase().includes(query));
    const files = [];
    for (const file of matches.slice(0, max)) {
      const entry = { id: file.id, name: file.label, kind: file.kind };
      if (JSON.stringify([...files, entry]).length > 8000)
        break;
      files.push(entry);
    }
    return {
      ok: true,
      data: JSON.stringify({
        source: "registered-resource-allowlist",
        files,
        truncated: files.length < matches.length,
        note: 'Matches configured files and successful creations by this resource, not live Drive metadata. Use query "*" to list permitted files.'
      })
    };
  }
  docPage(request, raw) {
    const args = request.arguments;
    if (raw.length <= 12000 && !Object.hasOwn(args, "offset") && !Object.hasOwn(args, "query"))
      return { ok: true, data: raw };
    let offset = Number(args.offset ?? 0);
    let found;
    if (typeof args.query === "string") {
      const query = args.query.trim();
      const match = raw.search(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
      found = match >= 0;
      offset = found ? Math.max(0, match - 1000) : raw.length;
    }
    if (offset > raw.length)
      return { ok: false, code: "invalid", message: "offset \u043F\u043E\u0437\u0430 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u043E\u043C; \u043F\u043E\u0447\u043D\u0438 \u0437 offset=0." };
    if (/[\uD800-\uDBFF]/.test(raw[offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(raw[offset] ?? "")) {
      if (typeof args.query === "string")
        offset--;
      else
        return { ok: false, code: "invalid", message: "offset \u0440\u043E\u0437\u0434\u0456\u043B\u044F\u0454 Unicode-\u0441\u0438\u043C\u0432\u043E\u043B; \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439 nextOffset \u0437 \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u043D\u044C\u043E\u0457 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0438." };
    }
    let end = Math.min(raw.length, offset + 8000);
    const page = () => {
      if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(raw[end] ?? ""))
        end--;
      return JSON.stringify({
        docId: args.docId,
        offset,
        text: raw.slice(offset, end),
        totalCharacters: raw.length,
        nextOffset: end < raw.length ? end : null,
        truncated: end < raw.length,
        ...found === undefined ? {} : { found },
        note: "\u0426\u0435 \u0444\u0440\u0430\u0433\u043C\u0435\u043D\u0442 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430; \u043F\u0440\u043E\u0434\u043E\u0432\u0436 get \u0437 nextOffset \u0430\u0431\u043E \u0437\u043D\u0430\u0439\u0434\u0438 \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0438\u0439 \u0431\u043B\u043E\u043A \u0447\u0435\u0440\u0435\u0437 query. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0437\u0430\u043F\u0438\u0441."
      });
    };
    let data = page();
    while (data.length > 1e4) {
      end = offset + Math.floor((end - offset) / 2);
      data = page();
    }
    return { ok: true, data };
  }
  sheetMetadata(request, raw) {
    try {
      const value = JSON.parse(raw);
      if (value.spreadsheetId !== request.arguments.spreadsheetId || !Array.isArray(value.sheets) || value.sheets.length === 0)
        throw new Error("incomplete");
      const tabs = value.sheets.map((sheet) => {
        const title = sheet?.properties?.title;
        const sheetId2 = sheet?.properties?.sheetId === undefined ? 0 : sheet.properties.sheetId;
        const rowCount = sheet?.properties?.gridProperties?.rowCount ?? null;
        const columnCount = sheet?.properties?.gridProperties?.columnCount ?? null;
        const frozenRowCount = sheet?.properties?.gridProperties?.frozenRowCount ?? 0;
        const frozenColumnCount = sheet?.properties?.gridProperties?.frozenColumnCount ?? 0;
        if (typeof title !== "string" || title.length === 0 || title.length > 512 || !Number.isSafeInteger(sheetId2) || Number(sheetId2) < 0 || rowCount !== null && (!Number.isSafeInteger(rowCount) || Number(rowCount) < 1) || !Number.isSafeInteger(frozenRowCount) || Number(frozenRowCount) < 0 || !Number.isSafeInteger(frozenColumnCount) || Number(frozenColumnCount) < 0 || columnCount !== null && (!Number.isSafeInteger(columnCount) || Number(columnCount) < 1))
          throw new Error("incomplete");
        return { title, sheetId: sheetId2, rowCount, columnCount, frozenRowCount, frozenColumnCount };
      });
      const offset = Number(request.arguments.offset ?? 0);
      if (offset >= tabs.length)
        return { ok: false, code: "invalid", message: `offset \u043F\u043E\u0437\u0430 \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0432\u043A\u043B\u0430\u0434\u043E\u043A (${tabs.length}); \u043F\u043E\u0432\u0442\u043E\u0440\u0438 metadata \u0437 offset=0.` };
      const sheets = [];
      for (const tab of tabs.slice(offset)) {
        if (JSON.stringify([...sheets, tab]).length > 7000)
          break;
        sheets.push(tab);
      }
      const nextOffset = offset + sheets.length < tabs.length ? offset + sheets.length : null;
      return { ok: true, data: JSON.stringify({
        spreadsheetId: value.spreadsheetId,
        offset,
        totalSheets: tabs.length,
        sheets,
        truncated: nextOffset !== null,
        nextOffset,
        note: "\u0426\u0435 \u043B\u0438\u0448\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0438 \u0442\u0430 \u043C\u0435\u0436\u0456 \u0441\u0456\u0442\u043A\u0438, \u043D\u0435 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u043D\u0456 \u0440\u044F\u0434\u043A\u0438. \u0427\u0438\u0442\u0430\u0439 \u0442\u043E\u0447\u043D\u0443 \u0432\u043A\u043B\u0430\u0434\u043A\u0443 \u0447\u0435\u0440\u0435\u0437 get; \u0434\u043B\u044F \u0434\u0430\u0442\u0438 \u0441\u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u0432\u0443\u0437\u044C\u043A\u0438\u0439 \u0441\u0442\u043E\u0432\u043F\u0435\u0446\u044C \u0434\u0430\u0442, \u043F\u043E\u0442\u0456\u043C \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 \u0440\u044F\u0434\u043A\u0438. \u0417\u0430 \u043D\u0430\u044F\u0432\u043D\u043E\u0441\u0442\u0456 nextOffset \u043F\u0440\u043E\u0434\u043E\u0432\u0436 metadata; \u0447\u0430\u0441\u0442\u043A\u043E\u0432\u0438\u0439 \u043F\u0435\u0440\u0435\u0433\u043B\u044F\u0434 \u043D\u0435 \u0434\u043E\u0432\u043E\u0434\u0438\u0442\u044C \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0441\u0442\u044C \u0434\u0430\u043D\u0438\u0445."
      }) };
    } catch {
      return { ok: false, code: "failed", message: "Google \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043D\u0435\u043F\u043E\u0432\u043D\u0456 \u0430\u0431\u043E \u043D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0456 \u043C\u0435\u0442\u0430\u0434\u0430\u043D\u0456 \u0442\u0430\u0431\u043B\u0438\u0446\u0456. \u0421\u043F\u0438\u0441\u043E\u043A \u0432\u043A\u043B\u0430\u0434\u043E\u043A \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E; \u043D\u0435 \u0440\u043E\u0431\u0438 \u0432\u0438\u0441\u043D\u043E\u0432\u043E\u043A \u043F\u0440\u043E \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0441\u0442\u044C \u0434\u0430\u043D\u0438\u0445." };
    }
  }
  service(capability2) {
    const match = /^google\.(gmail|calendar|drive|docs|sheets|contacts|tasks|analytics|search_console)\.read$/.exec(capability2);
    if (match != null)
      return match[1] === "search_console" ? "searchconsole" : match[1];
    const writes = {
      "google.gmail.send": "gmail",
      "google.calendar.write": "calendar",
      "google.sheets.write": "sheets",
      "google.docs.write": "docs",
      "google.contacts.write": "contacts",
      "google.tasks.write": "tasks",
      "google.drive.share": "drive"
    };
    return writes[capability2] ?? null;
  }
  operationArgs(request) {
    const args = request.arguments;
    if (request.capability === "google.sheets.write" && request.operation === "batch_update") {
      if (!exactKeys3(args, ["spreadsheetId", "requests"]) || typeof args.spreadsheetId !== "string" || !GOOGLE_FILE_ID.test(args.spreadsheetId) || !validSheetsBatch(args.requests))
        return null;
      return [
        "call",
        "sheets",
        "v4",
        "spreadsheets.batchUpdate",
        "--params",
        JSON.stringify({ spreadsheetId: args.spreadsheetId }),
        "--body",
        "@/dev/stdin",
        "--scope",
        "https://www.googleapis.com/auth/spreadsheets",
        "--allow-write",
        "--force"
      ];
    }
    if (request.capability === "google.sheets.write" && request.operation === "create") {
      if (!exactKeys3(args, ["title"]))
        return null;
      const title = text2(args.title, 512);
      return title == null ? null : ["create", title];
    }
    if (request.capability === "google.sheets.write" && request.operation === "add_tab") {
      if (!exactKeys3(args, ["spreadsheetId", "tabName"]))
        return null;
      const spreadsheetId = text2(args.spreadsheetId, 256);
      const tabName = text2(args.tabName, 512);
      return spreadsheetId == null || tabName == null || !GOOGLE_FILE_ID.test(spreadsheetId) ? null : ["add-tab", spreadsheetId, tabName];
    }
    if (request.capability === "google.gmail.send" && request.operation === "send") {
      const allowed = ["to", "subject", "body", "cc", "bcc"];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      const to = text2(args.to, 2000);
      const subject = text2(args.subject, 998, true);
      const body = text2(args.body, 1e4, true);
      if (to == null || subject == null || body == null)
        return null;
      const result = ["send", "--to", to, "--subject", subject, "--body", body];
      if (!optionalFlag(result, "--cc", args.cc, 2000) || !optionalFlag(result, "--bcc", args.bcc, 2000))
        return null;
      return result;
    }
    if (request.capability === "google.calendar.write") {
      const calendarId = text2(request.resource.config.calendarId ?? "primary", 254);
      if (calendarId == null)
        return null;
      if (request.operation === "create") {
        const allowed = ["summary", "from", "to", "attendee", "description", "withMeet"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          return null;
        const summary = text2(args.summary, 998, true);
        const from = text2(args.from, 64);
        const to = text2(args.to, 64);
        if (summary == null || from == null || to == null)
          return null;
        const result = ["create", calendarId, "--summary", summary, "--from", from, "--to", to];
        if (!optionalFlag(result, "--attendee", args.attendee, 2000) || !optionalFlag(result, "--description", args.description, 4000))
          return null;
        if (args.withMeet === true)
          result.push("--with-meet");
        else if (args.withMeet != null && args.withMeet !== false)
          return null;
        return result;
      }
      if (request.operation === "update") {
        const allowed = ["eventId", "summary", "from", "to", "attendee", "description", "withMeet"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          return null;
        const eventId = text2(args.eventId, 512);
        if (eventId == null)
          return null;
        const result = ["update", calendarId, eventId];
        if (!optionalFlag(result, "--summary", args.summary, 998) || !optionalFlag(result, "--from", args.from, 64) || !optionalFlag(result, "--to", args.to, 64) || !optionalFlag(result, "--attendee", args.attendee, 2000) || !optionalFlag(result, "--description", args.description, 4000))
          return null;
        if (args.withMeet === true)
          result.push("--with-meet");
        else if (args.withMeet != null && args.withMeet !== false)
          return null;
        return result.length > 3 ? result : null;
      }
      return null;
    }
    if (request.capability === "google.sheets.write" && request.operation === "update_cells") {
      if (!exactKeys3(args, ["spreadsheetId", "range", "values"]))
        return null;
      const spreadsheetId = text2(args.spreadsheetId, 256);
      const range = text2(args.range, 512);
      if (spreadsheetId == null || range == null || !GOOGLE_FILE_ID.test(spreadsheetId) || !validSheetsValues(args.values))
        return null;
      const valuesJson = JSON.stringify(args.values);
      if (valuesJson.length > 1e4)
        return null;
      return ["update", spreadsheetId, range, "--values-json", valuesJson, "--input", "USER_ENTERED"];
    }
    if (request.capability === "google.contacts.write") {
      const allowed = ["resourceName", "given", "family", "email", "phone"];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      if (request.operation !== "create" && request.operation !== "update")
        return null;
      const result = [request.operation];
      if (request.operation === "update") {
        const resourceName = text2(args.resourceName, 512);
        if (resourceName == null)
          return null;
        result.push(resourceName);
      } else if (args.resourceName != null)
        return null;
      if (!optionalFlag(result, "--given", args.given, 512) || !optionalFlag(result, "--family", args.family, 512) || !optionalFlag(result, "--email", args.email, 512) || !optionalFlag(result, "--phone", args.phone, 128))
        return null;
      return result.length > (request.operation === "update" ? 2 : 1) ? result : null;
    }
    if (request.capability === "google.tasks.write") {
      if (request.operation === "create") {
        const allowed = ["tasklistId", "title", "due", "notes"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          return null;
        const tasklistId = text2(args.tasklistId, 512);
        const title = text2(args.title, 1024, true);
        if (tasklistId == null || title == null)
          return null;
        const result = ["add", tasklistId, "--title", title];
        if (!optionalFlag(result, "--due", args.due, 64) || !optionalFlag(result, "--notes", args.notes, 4000))
          return null;
        return result;
      }
      if (request.operation === "update") {
        const allowed = ["tasklistId", "taskId", "title", "due", "notes"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          return null;
        const tasklistId = text2(args.tasklistId, 512);
        const taskId = text2(args.taskId, 512);
        if (tasklistId == null || taskId == null)
          return null;
        const result = ["update", tasklistId, taskId];
        if (!optionalFlag(result, "--title", args.title, 1024) || !optionalFlag(result, "--due", args.due, 64) || !optionalFlag(result, "--notes", args.notes, 4000))
          return null;
        return result.length > 3 ? result : null;
      }
      if (request.operation === "complete" && exactKeys3(args, ["tasklistId", "taskId"])) {
        const tasklistId = text2(args.tasklistId, 512);
        const taskId = text2(args.taskId, 512);
        return tasklistId == null || taskId == null ? null : ["done", tasklistId, taskId];
      }
      return null;
    }
    if (request.capability === "google.gmail.read") {
      if (request.operation === "search") {
        if (!exactKeys3(args, Object.hasOwn(args, "max") ? ["query", "max"] : ["query"]))
          return null;
        const query = text2(args.query, 2000);
        const max = boundedInt(args.max, 10, 50);
        return query != null && max != null ? ["search", query, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["messageId"])) {
        const id = text2(args.messageId, 256);
        return id == null ? null : ["get", id];
      }
      return null;
    }
    if (request.capability === "google.calendar.read") {
      const calendarId = text2(request.resource.config.calendarId ?? "primary", 254);
      if (calendarId == null)
        return null;
      if (request.operation === "list") {
        const allowed = ["from", "to", "max"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          return null;
        const result = ["events", calendarId];
        const max = boundedInt(args.max, 20, 100);
        if (max == null || !optionalFlag(result, "--from", args.from) || !optionalFlag(result, "--to", args.to))
          return null;
        result.push("--max", String(max));
        return result;
      }
      if (request.operation === "get" && exactKeys3(args, ["eventId"])) {
        const eventId = text2(args.eventId, 512);
        return eventId == null ? null : ["event", calendarId, eventId];
      }
      return null;
    }
    if (request.capability === "google.drive.share" && request.operation === "share") {
      if (!exactKeys3(args, ["fileId", "email", "role"]))
        return null;
      const fileId = text2(args.fileId, 256);
      const email = text2(args.email, 254);
      const role = typeof args.role === "string" && GoogleAdapter.SHARE_ROLES.has(args.role) ? args.role : null;
      if (fileId == null || email == null || role == null)
        return null;
      if (!GOOGLE_FILE_ID.test(fileId) || !GoogleAdapter.SHARE_EMAIL.test(email))
        return null;
      return ["share", fileId, "--to", "user", "--email", email, "--role", role];
    }
    if (request.capability === "google.drive.read") {
      if (request.operation === "search") {
        if (!exactKeys3(args, Object.hasOwn(args, "max") ? ["query", "max"] : ["query"]))
          return null;
        const query = text2(args.query, 2000);
        const max = boundedInt(args.max, 20, 100);
        return query != null && max != null ? ["search", query, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["fileId"])) {
        const fileId = text2(args.fileId, 256);
        return fileId == null ? null : ["get", fileId];
      }
      return null;
    }
    if (request.capability === "google.docs.write") {
      if (request.operation === "create") {
        if (!exactKeys3(args, ["title"]))
          return null;
        const title = text2(args.title, 512);
        return title == null ? null : ["create", title];
      }
      if (request.operation === "replace" || request.operation === "append") {
        if (!exactKeys3(args, ["docId", "content"]))
          return null;
        const docId = text2(args.docId, 256);
        const content = args.content;
        if (docId == null || !GOOGLE_FILE_ID.test(docId))
          return null;
        if (typeof content !== "string" || content.length === 0 || content.length > 1e5) {
          return null;
        }
        return request.operation === "append" ? ["write", docId, "--file", "-", "--append"] : ["write", docId, "--file", "-", "--replace"];
      }
      return null;
    }
    if (request.capability === "google.docs.read" && request.operation === "get") {
      if (Object.keys(args).some((k) => !["docId", "offset", "query"].includes(k)) || Object.hasOwn(args, "offset") && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0) || Object.hasOwn(args, "query") && (text2(args.query, 200) == null || !String(args.query).trim()) || Object.hasOwn(args, "offset") && Object.hasOwn(args, "query"))
        return null;
      const docId = text2(args.docId, 256);
      return docId == null ? null : ["cat", docId, "--max-bytes=2097152"];
    }
    if (request.capability === "google.sheets.read" && request.operation === "metadata") {
      if (!exactKeys3(args, Object.hasOwn(args, "offset") ? ["spreadsheetId", "offset"] : ["spreadsheetId"]))
        return null;
      const spreadsheetId = text2(args.spreadsheetId, 256);
      const offset = Object.hasOwn(args, "offset") ? args.offset : 0;
      return spreadsheetId == null || !GOOGLE_FILE_ID.test(spreadsheetId) || !Number.isSafeInteger(offset) || Number(offset) < 0 ? null : ["metadata", spreadsheetId];
    }
    if (request.capability === "google.sheets.read" && request.operation === "read_format") {
      if (!exactKeys3(args, ["spreadsheetId", "range"]))
        return null;
      const spreadsheetId = text2(args.spreadsheetId, 256);
      const range = text2(args.range, 512);
      return spreadsheetId == null || range == null || !GOOGLE_FILE_ID.test(spreadsheetId) ? null : ["read-format", spreadsheetId, range, "--effective"];
    }
    if (request.capability === "google.sheets.read" && request.operation === "read_layout") {
      if (!exactKeys3(args, ["spreadsheetId", "range"]))
        return null;
      const spreadsheetId = text2(args.spreadsheetId, 256);
      const range = text2(args.range, 512);
      if (spreadsheetId == null || range == null || !GOOGLE_FILE_ID.test(spreadsheetId))
        return null;
      return ["call", "sheets", "v4", "spreadsheets.get", "--params", JSON.stringify({
        spreadsheetId,
        ranges: [range],
        fields: "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)),data(startRow,startColumn,rowMetadata(pixelSize,hiddenByUser),columnMetadata(pixelSize,hiddenByUser)))"
      }), "--scope", "https://www.googleapis.com/auth/spreadsheets.readonly"];
    }
    if (request.capability === "google.sheets.read" && request.operation === "get" && exactKeys3(args, ["spreadsheetId", "range"])) {
      const spreadsheetId = text2(args.spreadsheetId, 256);
      const range = text2(args.range, 512);
      return spreadsheetId == null || range == null ? null : ["get", spreadsheetId, range];
    }
    if (request.capability === "google.contacts.read") {
      if (request.operation === "search") {
        if (!exactKeys3(args, Object.hasOwn(args, "max") ? ["query", "max"] : ["query"]))
          return null;
        const query = text2(args.query, 1000);
        const max = boundedInt(args.max, 10, 50);
        return query != null && max != null ? ["search", query, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["resourceName"])) {
        const resourceName = text2(args.resourceName, 512);
        return resourceName == null ? null : ["get", resourceName];
      }
      return null;
    }
    if (request.capability === "google.tasks.read") {
      if (request.operation === "list") {
        if (!exactKeys3(args, Object.hasOwn(args, "max") ? ["tasklistId", "max"] : ["tasklistId"]))
          return null;
        const tasklistId = text2(args.tasklistId, 512);
        const max = boundedInt(args.max, 20, 100);
        return tasklistId != null && max != null ? ["list", tasklistId, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["tasklistId", "taskId"])) {
        const tasklistId = text2(args.tasklistId, 512);
        const taskId = text2(args.taskId, 512);
        return tasklistId == null || taskId == null ? null : ["get", tasklistId, taskId];
      }
      return null;
    }
    if (request.capability === "google.analytics.read" && request.operation === "report") {
      const allowed = ["property", "startDate", "endDate", "metrics", "dimensions", "limit"];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      const property = text2(args.property ?? request.resource.config.property, 128);
      const startDate = text2(args.startDate, 32);
      const endDate = text2(args.endDate, 32);
      const metrics = text2(args.metrics, 1000);
      const dimensions = args.dimensions == null ? null : text2(args.dimensions, 1000);
      const limit = boundedInt(args.limit, 100, 1000);
      if (property == null || startDate == null || endDate == null || metrics == null || limit == null)
        return null;
      const result = ["report", property, "--start-date", startDate, "--end-date", endDate, "--metrics", metrics, "--limit", String(limit)];
      if (dimensions != null)
        result.push("--dimensions", dimensions);
      return result;
    }
    if (request.capability === "google.search_console.read" && request.operation === "report") {
      const allowed = ["siteUrl", "startDate", "endDate", "dimensions", "limit"];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      const siteUrl = text2(args.siteUrl ?? request.resource.config.siteUrl, 2000);
      const startDate = text2(args.startDate, 32);
      const endDate = text2(args.endDate, 32);
      const dimensions = text2(args.dimensions, 1000);
      const limit = boundedInt(args.limit, 100, 1000);
      if (siteUrl == null || startDate == null || endDate == null || dimensions == null || limit == null)
        return null;
      return ["query", siteUrl, "--start-date", startDate, "--end-date", endDate, "--dimensions", dimensions, "--limit", String(limit)];
    }
    return null;
  }
  receipt(raw) {
    try {
      const value = JSON.parse(raw);
      for (const key of ["id", "eventId", "resourceName", "taskId", "spreadsheetId", "documentId"]) {
        if (typeof value[key] === "string" && value[key].length <= 512) {
          return value[key];
        }
      }
      const file = value.file;
      if (file != null && typeof file.id === "string" && GOOGLE_FILE_ID.test(file.id))
        return file.id;
    } catch {}
    return;
  }
}
export {
  agentAccessDecision,
  agentAccess,
  GoogleAdapter,
  CapabilityStore
};

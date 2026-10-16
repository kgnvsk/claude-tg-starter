// @bun
// modules/telegram-corporate/capability-store.ts
import { Database as Database2 } from "bun:sqlite";
import { createHash as createHash4, randomUUID as randomUUID2 } from "crypto";
import { readFileSync as readFileSync2 } from "fs";
import { isAbsolute as isAbsolute2 } from "path";
import { userInfo } from "os";

// modules/telegram-corporate/resource-control.ts
import { isIP } from "net";
import { createHash } from "crypto";
var FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;
var ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
var CONNECTOR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var LABEL_CONTROLS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
var INSTAGRAM_RIGHTS = ["instagram.read", "instagram.publish", "instagram.comments.reply", "instagram.direct.send"];
var TELEGRAM_GROUP_RIGHTS = ["telegram.group.read", "telegram.message.send"];
var FACEBOOK_RIGHTS = ["facebook.page.read", "facebook.page.publish", "facebook.page.comments.reply", "facebook.page.messages.send"];
var YOUTUBE_RIGHTS = ["youtube.read", "youtube.update", "youtube.comments.reply", "youtube.upload"];
var META_RIGHTS = ["meta.ads.read", "meta.insights.read", "meta.ads.write"];
var BUSINESS_CAPABILITIES = {
  sheet: [["google.sheets.read"], ["google.sheets.write"]],
  doc: [["google.docs.read", "google.drive.read"], ["google.docs.write", "google.drive.share"]],
  slide: [["google.slides.read", "google.drive.read"], ["google.slides.write", "google.drive.share"]],
  file: [["google.drive.read"], ["google.drive.share"]],
  folder: [
    ["google.drive.read", "google.docs.read", "google.sheets.read", "google.slides.read"],
    ["google.drive.share", "google.drive.write", "google.docs.write", "google.sheets.write", "google.slides.write"]
  ],
  drive: [
    ["google.drive.read", "google.sheets.read", "google.docs.read", "google.slides.read"],
    ["google.drive.write", "google.drive.share", "google.sheets.write", "google.docs.write", "google.slides.write"]
  ],
  mailbox: [["google.gmail.read"], ["google.gmail.send", "google.gmail.modify"]],
  calendar: [["google.calendar.read"], ["google.calendar.write"]],
  contacts: [["google.contacts.read"], ["google.contacts.write"]],
  tasks: [["google.tasks.read"], ["google.tasks.write"]]
};
function exactFields(input, fields) {
  return Object.keys(input).length === fields.length && Object.keys(input).every((key) => fields.includes(key));
}
function searchSite(value) {
  if (typeof value !== "string" || value.length > 2000 || /[\x00-\x20\x7f]/.test(value))
    return false;
  if (/^sc-domain:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(value))
    return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash && url.toString() === value;
  } catch {
    return false;
  }
}
function fixedScope(resource, current, labelKey, allowed, derived = []) {
  if (current) {
    const oldKeys = Object.keys(current.config).sort(), newKeys = Object.keys(resource.config).sort();
    if (current.connector !== resource.connector || JSON.stringify(oldKeys) !== JSON.stringify(newKeys) || oldKeys.some((key) => key !== labelKey && !derived.includes(key) && current.config[key] !== resource.config[key]) || current.capabilityIds.some((id) => !allowed.includes(id))) {
      throw new Error("existing resource scope cannot be replaced through chat");
    }
  }
  return resource;
}
function resourceFromControl(input, current, businessMcp) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.id))
    throw new Error("invalid resource id");
  if (input.action === "revoke") {
    if (Object.keys(input).some((key) => !["action", "id"].includes(key)) || !current)
      throw new Error("invalid resource revocation");
    return null;
  }
  if (input.action !== "register" || typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 120 || LABEL_CONTROLS.test(input.label))
    throw new Error("invalid business resource");
  const label = input.label.trim();
  if (input.connector === "google" && ["analytics_property", "search_site"].includes(input.kind)) {
    const metric = input;
    const target = metric.kind === "analytics_property" ? "propertyId" : "siteUrl";
    if (!exactFields(metric, ["action", "id", "label", "connector", "kind", "account", "access", target]) || metric.access !== "read" || typeof metric.account !== "string" || metric.account.length > 254 || !ACCOUNT.test(metric.account)) {
      throw new Error("invalid metrics resource");
    }
    const config2 = { account: metric.account };
    if (metric.kind === "analytics_property") {
      if (typeof metric.propertyId !== "string" || !/^[1-9]\d{0,29}$/.test(metric.propertyId))
        throw new Error("invalid analytics property");
      config2.property = metric.propertyId;
    } else {
      if (!searchSite(metric.siteUrl))
        throw new Error("invalid search property");
      config2.siteUrl = metric.siteUrl;
    }
    const rights = [metric.kind === "analytics_property" ? "google.analytics.read" : "google.search_console.read"];
    return fixedScope({ id: input.id, label, connector: "google", capabilityIds: rights, config: config2 }, current, null, rights);
  }
  if (input.connector !== "google") {
    let resource2;
    let labelKey = null;
    if (input.connector === "sql" && input.kind === "bigquery_project" && input.access === "read" && exactFields(input, ["action", "id", "label", "connector", "kind", "projectId", "access"]) && typeof input.projectId === "string" && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId)) {
      resource2 = {
        id: input.id,
        label,
        connector: "sql",
        capabilityIds: ["sql.read"],
        config: { engine: "bigquery", project: input.projectId, maxRows: 1000, maximumBytesBilled: 1e9 }
      };
    } else if (input.connector === "sql" && input.kind === "sqlite_profile" && input.access === "read" && exactFields(input, ["action", "id", "label", "connector", "kind", "profile", "access"]) && typeof input.profile === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(input.profile)) {
      resource2 = {
        id: input.id,
        label,
        connector: "sql",
        capabilityIds: ["sql.read"],
        config: { engine: "sqlite", profile: input.profile, maxRows: 1000 }
      };
    } else if (input.connector === "vercel" && input.kind === "hosting" && input.access === "read_write" && exactFields(input, ["action", "id", "label", "connector", "kind", "access", ..."scope" in input ? ["scope"] : []]) && (input.scope == null || typeof input.scope === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(input.scope))) {
      resource2 = { id: input.id, label, connector: "vercel", capabilityIds: ["site.publish"], config: {
        projectPrefix: `corp-${createHash("sha256").update(input.id).digest("hex").slice(0, 16)}-`,
        ...input.scope == null ? {} : { scope: input.scope }
      } };
    } else if (input.connector === "meta" && input.kind === "ad_account" && (exactFields(input, ["action", "id", "label", "connector", "kind", "accountId"]) || exactFields(input, ["action", "id", "label", "connector", "kind", "accountId", "access"]) && ["read", "read_write"].includes(input.access ?? "")) && /^act_\d{4,30}$/.test(input.accountId)) {
      labelKey = `account.${input.accountId}`;
      resource2 = { id: input.id, label, connector: "meta", capabilityIds: [
        "meta.ads.read",
        "meta.insights.read",
        ...input.access === "read_write" ? ["meta.ads.write"] : []
      ], config: { [labelKey]: label } };
    } else if (input.connector === "gads" && input.kind === "customer" && exactFields(input, ["action", "id", "label", "connector", "kind", "customerId"]) && /^\d{6,12}$/.test(input.customerId)) {
      labelKey = `customer.${input.customerId}`;
      resource2 = { id: input.id, label, connector: "gads", capabilityIds: ["google.ads.read"], config: { [labelKey]: label } };
    } else if (input.connector === "browser" && input.kind === "origin" && exactFields(input, ["action", "id", "label", "connector", "kind", "origin"]) && typeof input.origin === "string" && input.origin.length <= 2048) {
      let url;
      try {
        url = new URL(input.origin);
      } catch {
        throw new Error("invalid browser origin");
      }
      if (url.protocol !== "https:" || url.origin !== input.origin || url.username || url.password || isIP(url.hostname) || !url.hostname.includes(".") || url.hostname.endsWith(".") || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal") || url.hostname.endsWith(".localhost"))
        throw new Error("invalid browser origin");
      labelKey = "origin.1";
      resource2 = { id: input.id, label, connector: "browser", capabilityIds: ["browser.read"], config: { [labelKey]: url.origin } };
    } else if (input.connector === "memory" && input.kind === "company" && exactFields(input, ["action", "id", "label", "connector", "kind"])) {
      resource2 = { id: input.id, label, connector: "memory", capabilityIds: ["memory.company.read"], config: { corporateKey: "company" } };
    } else if (input.connector === "image" && input.kind === "generator" && exactFields(input, ["action", "id", "label", "connector", "kind"])) {
      resource2 = { id: input.id, label, connector: "image", capabilityIds: ["image.generate"], config: {} };
    } else if (input.connector === "telegram" && input.kind === "group" && exactFields(input, ["action", "id", "label", "connector", "kind", "chatId", "access"]) && /^-\d{5,20}$/.test(input.chatId) && ["read", "read_write"].includes(input.access)) {
      labelKey = `group.${input.chatId}`;
      resource2 = {
        id: input.id,
        label,
        connector: "telegram",
        capabilityIds: input.access === "read_write" ? [...TELEGRAM_GROUP_RIGHTS] : ["telegram.group.read"],
        config: { source: "static", [labelKey]: label }
      };
    } else if (input.connector === "telegram" && input.kind === "channel" && exactFields(input, ["action", "id", "label", "connector", "kind", "chatId"]) && /^-100\d{5,17}$/.test(input.chatId)) {
      labelKey = `channel.${input.chatId}`;
      resource2 = {
        id: input.id,
        label,
        connector: "telegram",
        capabilityIds: ["telegram.channel.post"],
        config: { source: "static", [labelKey]: label }
      };
    } else if (input.connector === "instagram" && input.kind === "account" && exactFields(input, ["action", "id", "label", "connector", "kind", "businessId", "access"]) && typeof input.businessId === "string" && /^\d{5,30}$/.test(input.businessId) && ["read", "read_write"].includes(input.access)) {
      labelKey = `account.${input.businessId}`;
      resource2 = {
        id: input.id,
        label,
        connector: "instagram",
        capabilityIds: input.access === "read_write" ? [...INSTAGRAM_RIGHTS] : ["instagram.read"],
        config: { [labelKey]: label }
      };
    } else if (input.connector === "facebook" && input.kind === "page" && exactFields(input, ["action", "id", "label", "connector", "kind", "pageId", "access"]) && typeof input.pageId === "string" && /^\d{5,30}$/.test(input.pageId) && ["read", "read_write"].includes(input.access)) {
      labelKey = `page.${input.pageId}`;
      resource2 = {
        id: input.id,
        label,
        connector: "facebook",
        capabilityIds: input.access === "read_write" ? [...FACEBOOK_RIGHTS] : ["facebook.page.read"],
        config: { [labelKey]: label }
      };
    } else if (input.connector === "youtube" && input.kind === "channel" && exactFields(input, ["action", "id", "label", "connector", "kind", "account", "channelId", "access"]) && typeof input.account === "string" && ACCOUNT.test(input.account) && typeof input.channelId === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(input.channelId) && ["read", "read_write"].includes(input.access)) {
      labelKey = `channel.${input.channelId}`;
      resource2 = {
        id: input.id,
        label,
        connector: "youtube",
        capabilityIds: input.access === "read_write" ? [...YOUTUBE_RIGHTS] : ["youtube.read"],
        config: { account: input.account, [labelKey]: label }
      };
    } else if (input.connector === "mcp" && input.kind === "connector" && "profile" in input && exactFields(input, ["action", "id", "label", "connector", "kind", "profile"]) && typeof input.profile === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.profile)) {
      const binding = businessMcp?.(input.profile);
      if (!binding)
        throw new Error("publish a separate business MCP profile before granting it");
      resource2 = { id: input.id, label, connector: "mcp", capabilityIds: ["connector.use"], config: { ...binding } };
    } else if (input.connector === "mcp" && input.kind === "connector" && "name" in input && exactFields(input, ["action", "id", "label", "connector", "kind", "name"]) && typeof input.name === "string" && CONNECTOR_NAME.test(input.name)) {
      labelKey = `connector.${input.name}`;
      resource2 = { id: input.id, label, connector: "mcp", capabilityIds: ["connector.use"], config: { [labelKey]: label } };
    } else if (input.connector === "recall" && input.kind === "recorder" && exactFields(input, ["action", "id", "label", "connector", "kind"])) {
      resource2 = { id: input.id, label, connector: "recall", capabilityIds: ["meeting.record"], config: {} };
    } else
      throw new Error("invalid business resource");
    return fixedScope(resource2, current, labelKey, resource2.connector === "telegram" ? input.kind === "channel" ? ["telegram.channel.post"] : TELEGRAM_GROUP_RIGHTS : resource2.connector === "instagram" ? INSTAGRAM_RIGHTS : resource2.connector === "facebook" ? FACEBOOK_RIGHTS : resource2.connector === "youtube" ? YOUTUBE_RIGHTS : resource2.connector === "meta" ? META_RIGHTS : resource2.capabilityIds);
  }
  if (typeof input.kind !== "string" || !Object.hasOwn(BUSINESS_CAPABILITIES, input.kind) || !["read", "read_write"].includes(input.access) || typeof input.account !== "string" || input.account.length > 254 || !ACCOUNT.test(input.account)) {
    throw new Error("invalid business resource");
  }
  const kind = input.kind;
  const extra = kind === "sheet" ? "spreadsheetId" : ["doc", "slide", "file", "folder"].includes(kind) ? "fileId" : kind === "calendar" ? "calendarId" : null;
  const fields = ["action", "id", "label", "connector", "kind", "account", "access", ...extra ? [extra] : []];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new Error("invalid business resource fields");
  const value = extra ? input[extra] : undefined;
  if (extra === "calendarId" ? typeof value !== "string" || value.length > 254 || !/^(?:primary|[A-Za-z0-9._@#%-]{3,254})$/.test(value) : extra != null && (typeof value !== "string" || !FILE_ID.test(value))) {
    throw new Error("invalid business resource target");
  }
  const config = { account: input.account };
  const targetKey = extra === "spreadsheetId" ? `sheet.${value}` : extra === "fileId" ? `${kind}.${value}` : null;
  if (targetKey) {
    config.allowCreate = kind === "folder" && input.access === "read_write";
    config[targetKey] = label;
  } else if (extra === "calendarId")
    config.calendarId = value;
  else if (kind === "drive") {
    config.allFiles = true;
    config.allowCreate = input.access === "read_write";
  }
  const [read, write] = BUSINESS_CAPABILITIES[kind];
  const capabilityIds = [...read, ...input.access === "read_write" ? write : []];
  const resource = { id: input.id, label, connector: "google", capabilityIds, config };
  return fixedScope(resource, current, targetKey, [...read, ...write], ["drive", "folder"].includes(kind) ? ["allowCreate"] : []);
}

// modules/telegram-corporate/business-mcp-profiles.ts
import { Database } from "bun:sqlite";
import { createHash as createHash2, randomUUID } from "crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, normalize, relative } from "path";
var ALIAS = /^[a-z][a-z0-9_-]{0,63}$/;
var TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
var MAX_PROFILE = 96 * 1024;
var MAX_DISCOVERY = 11000;
var businessMcpInventory = (d) => JSON.stringify({
  account: d.account,
  scope: d.scope,
  tools: d.tools.map((t) => ({ name: t.name, effect: t.effect }))
});
var businessMcpDescription = (d, tool) => JSON.stringify({ account: d.account, scope: d.scope, tool });
var SCHEMA = "CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, alias TEXT NOT NULL, digest TEXT NOT NULL, descriptor TEXT NOT NULL, pins TEXT NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER); CREATE UNIQUE INDEX IF NOT EXISTS one_active_alias ON publications(alias) WHERE active=1;";
var invalid = () => {
  throw new Error("business_mcp_profile_unavailable");
};
var plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
var text = (x, max) => typeof x === "string" && x.length > 0 && x.length <= max && !/[\x00-\x1f\x7f]/.test(x);
function canonicalMcp(value) {
  const sort = (v) => Array.isArray(v) ? v.map(sort) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
function exact(value, required, optional = []) {
  if (required.some((k) => !Object.hasOwn(value, k)) || Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k)))
    invalid();
}
function pathOf(value) {
  if (!text(value, 2048) || !isAbsolute(value) || normalize(value) !== value || realpathSync(value) !== value)
    invalid();
  return value;
}
function directory(path, privateOnly = false) {
  pathOf(path);
  const st = lstatSync(path), uid = process.getuid?.();
  const sharedTemporaryParent = !privateOnly && st.uid === 0 && (st.mode & 512) !== 0;
  if (!st.isDirectory() || st.isSymbolicLink() || !sharedTemporaryParent && st.mode & (privateOnly ? 63 : 18) || (privateOnly ? st.uid !== uid : st.uid !== uid && st.uid !== 0))
    invalid();
}
function secureParents(path) {
  for (let p = dirname(path);; p = dirname(p)) {
    directory(p);
    if (p === dirname(p))
      break;
  }
}
function identity(st) {
  return [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.uid, st.mode, st.nlink].join(":");
}
function file(path, limit, privateOnly = false) {
  pathOf(path);
  secureParents(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > limit || st.mode & (privateOnly ? 63 : 18) || (privateOnly ? st.uid !== process.getuid?.() : st.uid !== process.getuid?.() && st.uid !== 0))
      invalid();
    const data = readFileSync(fd), after = lstatSync(path);
    if (data.length > limit || identity(after) !== identity(st))
      invalid();
    return { data, identity: identity(st) };
  } finally {
    closeSync(fd);
  }
}
function boundedSchema(value, depth = 0) {
  if (!plain(value) || depth > 12 || JSON.stringify(value).length > 16384)
    invalid();
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description", "title"]);
  if (Object.keys(value).some((k) => !allowed.has(k)) || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(value.type))
    invalid();
  if (value.type === "object") {
    if (!plain(value.properties) || value.additionalProperties !== false || Object.keys(value.properties).length > 64)
      invalid();
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((k) => typeof k !== "string" || !Object.hasOwn(value.properties, k))))
      invalid();
    for (const [key, schema] of Object.entries(value.properties)) {
      if (!TOOL.test(key) || ["__proto__", "constructor", "prototype"].includes(key))
        invalid();
      boundedSchema(schema, depth + 1);
    }
  } else if (value.type === "array") {
    if (!Number.isSafeInteger(value.maxItems) || value.maxItems < 0 || value.maxItems > 1000)
      invalid();
    boundedSchema(value.items, depth + 1);
  } else if (value.type === "string" && (!Number.isSafeInteger(value.maxLength) || value.maxLength < 0 || value.maxLength > 200000))
    invalid();
}

class BusinessMcpRegistry {
  home;
  root;
  accounts;
  path;
  verified = new Map;
  constructor(home) {
    this.home = home;
    this.root = join(home, ".local/state/novsky-business-mcp");
    this.accounts = join(this.root, "accounts");
    this.path = join(this.root, "registry.sqlite");
  }
  prepareDirectories() {
    directory(this.home);
    secureParents(join(this.home, ".local"));
    for (const path of [join(this.home, ".local"), join(this.home, ".local/state"), this.root, this.accounts]) {
      try {
        mkdirSync(path, { mode: 448 });
      } catch (e) {
        if (e.code !== "EEXIST")
          throw e;
      }
      directory(path, path === this.root || path === this.accounts);
    }
  }
  open(write = false) {
    directory(this.home);
    if (write) {
      this.prepareDirectories();
      try {
        const fd = openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
        closeSync(fd);
      } catch (e) {
        if (e.code !== "EEXIST")
          throw e;
      }
    }
    directory(this.root, true);
    directory(this.accounts, true);
    secureParents(this.path);
    const st = lstatSync(this.path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.mode & 63 || st.size > 8 * 1024 * 1024)
      invalid();
    const db = new Database(this.path, write ? { readwrite: true } : { readonly: true });
    db.exec("PRAGMA busy_timeout=1000");
    if (write)
      db.exec(SCHEMA);
    return db;
  }
  validate(value) {
    if (!plain(value))
      return invalid();
    exact(value, ["alias", "label", "account", "scope", "command", "args", "cwd", "home", "files", "tools"], ["environmentFile"]);
    if (typeof value.alias !== "string" || !ALIAS.test(value.alias) || !text(value.label, 120) || !text(value.account, 120) || !text(value.scope, 500) || !Array.isArray(value.args) || value.args.length > 16 || value.args.some((a) => !text(a, 2048)) || !Array.isArray(value.files) || value.files.length > 32 || !Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 32 || Buffer.byteLength(JSON.stringify(value)) > MAX_PROFILE)
      invalid();
    pathOf(value.command);
    directory(value.home, true);
    directory(value.cwd, true);
    const relHome = relative(this.accounts, value.home), relCwd = relative(value.home, value.cwd);
    if (!relHome || relHome.startsWith("..") || isAbsolute(relHome) || relCwd.startsWith("..") || isAbsolute(relCwd))
      invalid();
    if (!(lstatSync(value.command).mode & 73))
      invalid();
    for (const path of value.files)
      pathOf(path);
    if (value.args.some((arg) => isAbsolute(arg) && !value.files.includes(arg)))
      invalid();
    if (value.environmentFile !== undefined) {
      const p = pathOf(value.environmentFile), rel = relative(value.home, p);
      if (!rel || rel.startsWith("..") || isAbsolute(rel))
        invalid();
      this.readEnvironment(p);
    }
    const names = new Set;
    for (const tool of value.tools) {
      if (!plain(tool))
        invalid();
      exact(tool, ["name", "description", "inputSchema", "outputSchema", "effect"], ["receiptPath"]);
      if (typeof tool.name !== "string" || !TOOL.test(tool.name) || names.has(tool.name) || !text(tool.description, 500) || !["read", "write"].includes(tool.effect))
        invalid();
      names.add(tool.name);
      boundedSchema(tool.inputSchema);
      boundedSchema(tool.outputSchema);
      if (tool.inputSchema.type !== "object" || tool.outputSchema.type !== "object")
        invalid();
      if (tool.effect === "write" && (!Array.isArray(tool.receiptPath) || tool.receiptPath.length < 1 || tool.receiptPath.length > 8 || tool.receiptPath.some((k) => typeof k !== "string" || !TOOL.test(k) || ["__proto__", "constructor", "prototype"].includes(k))))
        invalid();
      if (tool.effect === "read" && tool.receiptPath !== undefined)
        invalid();
      if (businessMcpDescription(value, tool).length > MAX_DISCOVERY)
        invalid();
    }
    if (businessMcpInventory(value).length > MAX_DISCOVERY)
      invalid();
    return JSON.parse(JSON.stringify(value));
  }
  readEnvironment(path) {
    if (!path)
      return {};
    const value = JSON.parse(file(path, 32768, true).data.toString());
    if (!plain(value) || Object.keys(value).length > 32)
      invalid();
    for (const [key, v] of Object.entries(value)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || /^(?:HOME|PATH|SHELL|ENV|BASH_ENV|NODE_.+|BUN_.+|LD_.+|DYLD_.+|PYTHON.+|CLAUDE.+|CODEX.+|XDG_.+|SSL_CERT_.+|OPENSSL_.+|NPM_.+)$/.test(key) || typeof v !== "string" || v.length > 8192 || /[\0\r\n]/.test(v))
        invalid();
    }
    return value;
  }
  publish(value) {
    this.prepareDirectories();
    const descriptor = this.validate(value);
    const pins = [...new Set([descriptor.command, ...descriptor.files, ...descriptor.environmentFile ? [descriptor.environmentFile] : []])].map((path) => {
      const result = file(path, path === descriptor.environmentFile ? 32768 : 256 * 1024 * 1024, path === descriptor.environmentFile);
      return { path, identity: result.identity, sha256: createHash2("sha256").update(result.data).digest("hex") };
    });
    const digest = createHash2("sha256").update(canonicalMcp({ descriptor, pins })).digest("hex");
    const db = this.open(true);
    try {
      return db.transaction(() => {
        const existing = db.query("SELECT id,revision,digest FROM publications WHERE alias=? AND active=1").get(descriptor.alias);
        if (existing) {
          if (existing.digest !== digest)
            throw new Error("disable the previous publication before publishing a different profile");
          return { profile: descriptor.alias, profileId: existing.id, profileRevision: existing.revision, contractSha256: digest };
        }
        const count = db.query("SELECT count(*) n,coalesce(max(revision),0)+1 r FROM publications").get();
        if (count.n >= 256)
          invalid();
        const id = randomUUID();
        db.query("INSERT INTO publications(id,revision,alias,digest,descriptor,pins,active,created_at) VALUES(?,?,?,?,?,?,1,?)").run(id, count.r, descriptor.alias, digest, canonicalMcp(descriptor), canonicalMcp(pins), Date.now());
        return { profile: descriptor.alias, profileId: id, profileRevision: count.r, contractSha256: digest };
      }).immediate();
    } finally {
      db.close();
    }
  }
  disable(id) {
    const db = this.open(true);
    try {
      return db.query("UPDATE publications SET active=0,retired_at=? WHERE id=? AND active=1").run(Date.now(), id).changes > 0;
    } finally {
      db.close();
    }
  }
  binding(alias) {
    try {
      if (!ALIAS.test(alias))
        return null;
      const db = this.open();
      try {
        const row = db.query("SELECT id,revision,digest FROM publications WHERE alias=? AND active=1").get(alias);
        return row ? { profile: alias, profileId: row.id, profileRevision: row.revision, contractSha256: row.digest } : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }
  resolve(resource) {
    try {
      if (resource.connector !== "mcp")
        return null;
      const c = resource.config;
      if (Object.keys(c).sort().join(",") !== "contractSha256,profile,profileId,profileRevision")
        return null;
      const db = this.open();
      let row;
      try {
        row = db.query("SELECT descriptor,pins FROM publications WHERE id=? AND revision=? AND alias=? AND digest=? AND active=1").get(c.profileId, c.profileRevision, c.profile, c.contractSha256);
      } finally {
        db.close();
      }
      if (!row)
        return null;
      const descriptor = this.validate(JSON.parse(row.descriptor)), pins = JSON.parse(row.pins);
      if (createHash2("sha256").update(canonicalMcp({ descriptor, pins })).digest("hex") !== c.contractSha256)
        return null;
      for (const pin of pins) {
        const st = lstatSync(pin.path);
        if (identity(st) !== pin.identity)
          return null;
        if (this.verified.get(pin.path) !== pin.identity) {
          const actual = file(pin.path, 256 * 1024 * 1024);
          if (actual.identity !== pin.identity || createHash2("sha256").update(actual.data).digest("hex") !== pin.sha256)
            return null;
          this.verified.set(pin.path, pin.identity);
        }
      }
      return { ...c, descriptor, pins };
    } catch {
      return null;
    }
  }
}
function businessMcpResource(resource) {
  return resource?.connector === "mcp" && typeof resource.config.profileId === "string";
}

// modules/telegram-corporate/resource-google-files.ts
var GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;
function createdGoogleSheetIds(db, resourceId) {
  return createdGoogleIds(db, resourceId, "google.sheets.write");
}
function createdGoogleSheetFiles(db, resourceId) {
  return createdGoogleFiles(db, resourceId, "google.sheets.write", "sheet");
}
function createdGoogleDocFiles(db, resourceId) {
  return createdGoogleFiles(db, resourceId, "google.docs.write", "doc");
}
var CURRENT_CREATION = `FROM corporate_actions a
 JOIN corporate_resources r ON r.resource_id=a.resource_id
 WHERE a.resource_id=? AND a.operation='create' AND a.state='succeeded' AND a.receipt_id IS NOT NULL
 AND r.active=1 AND r.connector='google' AND json_extract(r.config_json,'$.allowCreate')=1
 AND CASE WHEN json_valid(a.payload_json) THEN json_type(a.payload_json,'$.resourceRevision')='integer'
   AND json_extract(a.payload_json,'$.resourceRevision')=r.revision ELSE 0 END`;
function createdGoogleIds(db, resourceId, capability) {
  const rows = db.query(`SELECT DISTINCT a.receipt_id AS id ${CURRENT_CREATION} AND a.capability_id=? ORDER BY a.receipt_id`).all(resourceId, capability);
  return rows.flatMap((row) => typeof row.id === "string" && GOOGLE_FILE_ID.test(row.id) ? [row.id] : []);
}
function createdGoogleFileAllowed(db, resourceId, id, docsOnly = false, includeSheets = true) {
  if (!GOOGLE_FILE_ID.test(id))
    return false;
  return db.query(`SELECT 1 ${CURRENT_CREATION} AND a.receipt_id=?
    AND a.capability_id IN ('google.docs.write'${docsOnly ? "" : ", 'google.slides.write'"}${!docsOnly && includeSheets ? ", 'google.sheets.write'" : ""}) LIMIT 1`).get(resourceId, id) != null;
}
function createdGoogleFiles(db, resourceId, capability, kind) {
  const rows = db.query(`SELECT a.receipt_id AS id,a.arguments_json AS argumentsJson ${CURRENT_CREATION}
     AND a.capability_id=? ORDER BY a.rowid DESC LIMIT 60`).all(resourceId, capability);
  const files = new Map;
  for (const row of rows) {
    if (!GOOGLE_FILE_ID.test(row.id) || files.has(row.id))
      continue;
    let title;
    try {
      title = JSON.parse(row.argumentsJson).title;
    } catch {}
    files.set(row.id, { id: row.id, kind, label: typeof title === "string" ? title.slice(0, 120) : row.id });
  }
  return [...files.values()];
}
function wholeDrive(resource) {
  return resource.connector === "google" && resource.config.allFiles === true;
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
  return createdGoogleIds(db, resourceId, "google.slides.write");
}
function createdGoogleSlideFiles(db, resourceId) {
  return createdGoogleFiles(db, resourceId, "google.slides.write", "slide");
}

// modules/telegram-corporate/group-action.ts
import { createHash as createHash3 } from "crypto";

// modules/telegram-corporate/capabilities.ts
var RESOURCE_CONNECTORS = Object.freeze([
  "memory",
  "google",
  "sql",
  "meta",
  "gads",
  "telegram",
  "image",
  "browser",
  "vercel",
  "instagram",
  "facebook",
  "youtube",
  "mcp",
  "recall"
]);
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
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "site.publish": capability("site.publish", {
    kind: "write",
    adapter: "vercel",
    operations: ["deploy"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "google.gmail.read": capability("google.gmail.read", {
    kind: "read",
    adapter: "google",
    operations: ["search", "get", "labels", "attachment"],
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
  "google.drive.write": capability("google.drive.write", {
    kind: "write",
    adapter: "google",
    operations: ["create_folder", "upload"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
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
    operations: ["replace", "append", "create", "insert_image", "update"],
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
    operations: ["create", "insert_image", "edit"],
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
    operations: ["send", "draft"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.gmail.modify": capability("google.gmail.modify", {
    kind: "write",
    adapter: "google",
    operations: ["create_label", "modify", "archive", "trash"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.calendar.write": capability("google.calendar.write", {
    kind: "write",
    adapter: "google",
    operations: ["create", "update", "delete"],
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
    operations: ["create", "update", "delete"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "google.tasks.write": capability("google.tasks.write", {
    kind: "write",
    adapter: "google",
    operations: ["create", "update", "complete", "delete"],
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
    operations: ["list_campaigns", "list_adsets", "list_ads", "get"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "meta.ads.write": capability("meta.ads.write", {
    kind: "write",
    adapter: "meta",
    operations: ["set_status", "set_budget"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
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
    operations: ["send", "edit"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "telegram.channel.post": capability("telegram.channel.post", {
    kind: "outbound",
    adapter: "telegram",
    operations: ["post", "edit"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "instagram.read": capability("instagram.read", {
    kind: "read",
    adapter: "instagram",
    operations: ["media", "comments", "insights"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "instagram.publish": capability("instagram.publish", {
    kind: "outbound",
    adapter: "instagram",
    operations: ["image", "reel", "carousel", "story", "stage_media"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "instagram.comments.reply": capability("instagram.comments.reply", {
    kind: "outbound",
    adapter: "instagram",
    operations: ["reply"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "instagram.direct.send": capability("instagram.direct.send", {
    kind: "outbound",
    adapter: "instagram",
    operations: ["send"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "facebook.page.read": capability("facebook.page.read", {
    kind: "read",
    adapter: "facebook",
    operations: ["posts", "comments"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "facebook.page.publish": capability("facebook.page.publish", {
    kind: "outbound",
    adapter: "facebook",
    operations: ["post", "photo"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "facebook.page.comments.reply": capability("facebook.page.comments.reply", {
    kind: "outbound",
    adapter: "facebook",
    operations: ["reply"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "facebook.page.messages.send": capability("facebook.page.messages.send", {
    kind: "outbound",
    adapter: "facebook",
    operations: ["send"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "youtube.read": capability("youtube.read", {
    kind: "read",
    adapter: "youtube",
    operations: ["videos", "comments", "transcript"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "youtube.update": capability("youtube.update", {
    kind: "outbound",
    adapter: "youtube",
    operations: ["details"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "youtube.comments.reply": capability("youtube.comments.reply", {
    kind: "outbound",
    adapter: "youtube",
    operations: ["reply"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "youtube.upload": capability("youtube.upload", {
    kind: "outbound",
    adapter: "youtube",
    operations: ["upload"],
    sharedAllowed: false,
    requiresResource: true,
    requiresConfirmation: true
  }),
  "telegram.group.read": capability("telegram.group.read", {
    kind: "read",
    adapter: "telegram",
    operations: ["history", "get_message"],
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
  "connector.use": capability("connector.use", {
    kind: "write",
    adapter: "mcp",
    operations: ["use"],
    sharedAllowed: true,
    requiresResource: true,
    requiresConfirmation: false
  }),
  "meeting.record": capability("meeting.record", {
    kind: "outbound",
    adapter: "recall",
    operations: ["join", "status", "transcript", "leave"],
    sharedAllowed: true,
    requiresResource: true,
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
function resolveSubject(input) {
  if (input.chatType === "private")
    return `user:${input.userId}`;
  if (input.chatType === "supergroup" && input.isTopicMessage === true && input.threadId != null)
    return `topic:${input.chatId}:${input.threadId}`;
  return `group:${input.chatId}`;
}
function isSharedSubject(subject) {
  return subject.startsWith("group:") || subject.startsWith("topic:");
}
var AGENT_DEFAULT_SUBJECT = "agent:default";
function isInstalledAgentSubject(subject) {
  const match = /^agent:installed:[A-Za-z0-9_-]{1,100}:([1-9]\d{0,18})$/.exec(subject);
  return match !== null && BigInt(match[1]) <= 9223372036854775807n;
}
function isValidSubject(subject) {
  return subject === AGENT_DEFAULT_SUBJECT || isInstalledAgentSubject(subject) || /^user:\d+$/.test(subject) || /^group:-?\d+$/.test(subject) || /^topic:-?\d+:\d+$/.test(subject);
}
function expandFullAccess(catalog, resources) {
  const grants = [];
  for (const definition of Object.values(catalog)) {
    if (!definition.delegable || definition.namedPersonOnly)
      continue;
    if (!definition.requiresResource) {
      grants.push({ capabilityId: definition.id, resourceId: null });
      continue;
    }
    for (const resource of resources) {
      if (resource.connector === definition.adapter && resource.capabilityIds.includes(definition.id))
        grants.push({ capabilityId: definition.id, resourceId: resource.id });
    }
  }
  return grants.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId) || (left.resourceId ?? "").localeCompare(right.resourceId ?? ""));
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
  return `corporate-group-action:${sourceJobId}:${createHash3("sha256").update(groupActionJson(request)).digest("hex")}`;
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
var MANAGERS_ABOVE_DIR = "/etc/novsky/managers";
var AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
var APPROVER = /^[1-9]\d{0,19}$/;
function managersAboveFromFile() {
  try {
    const value = JSON.parse(readFileSync2(`${MANAGERS_ABOVE_DIR}/${userInfo().username}.json`, "utf8"));
    const ids = value.managersAbove;
    return Array.isArray(ids) && ids.every((id) => typeof id === "string" && AGENT_ID.test(id)) ? ids : null;
  } catch {
    return null;
  }
}
var SECRET_KEY = /token|secret|password|credential|authorization|cookie|api.?key|private.?key/i;
var RESOURCE_ID2 = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var SCHEMA2 = `
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

CREATE TABLE IF NOT EXISTS corporate_policy_pins (
  subject TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(subject, resource_key)
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

CREATE TABLE IF NOT EXISTS corporate_business_messages (
  token TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  message_id INTEGER NOT NULL
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

-- Codex K289-P2-1: a company chat's storage epoch must see a right taken away and given back between two of its turns.
-- Each write that loses a grant, its trust or the chat authorization, or changes or deactivates a resource, logs its
-- scope here; growth is not logged.
CREATE TABLE IF NOT EXISTS corporate_rights_narrowings (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL);

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
  isSuperadmin;
  managersAbove;
  businessMcp;
  constructor(path, options) {
    this.primaryOwnerId = options.primaryOwnerId;
    this.catalog = options.catalog ?? CAPABILITY_CATALOG;
    this.isSuperadmin = options.isSuperadmin ?? (() => false);
    this.managersAbove = options.managersAbove ?? managersAboveFromFile;
    this.businessMcp = options.businessMcp;
    this.db = new Database2(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.exec(SCHEMA2);
    this.db.transaction(() => {
      const columns = new Set(this.db.query("PRAGMA table_info(corporate_policy_previews)").all().map((c) => c.name));
      for (const name of ["resource_versions_json", "agent_request_id", "agent_request_json", "agent_message_json", "conversation_json", "branch_json"]) {
        if (!columns.has(name))
          this.db.exec(`ALTER TABLE corporate_policy_previews ADD COLUMN ${name} TEXT`);
      }
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS corporate_agent_request ON corporate_policy_previews(agent_request_id)");
      if (!this.db.query("PRAGMA table_info(corporate_policies)").all().some((c) => c.name === "chat_authorized")) {
        this.db.exec("ALTER TABLE corporate_policies ADD COLUMN chat_authorized INTEGER NOT NULL DEFAULT 0");
      }
    })();
    if (!this.db.query("PRAGMA table_info(corporate_resources)").all().some((column) => column.name === "revision")) {
      this.db.exec("ALTER TABLE corporate_resources ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
  }
  narrowingSeq() {
    return this.db.query("SELECT coalesce(max(seq),0) AS seq FROM corporate_rights_narrowings").get().seq;
  }
  narrowedSince(seq, scopes) {
    return this.db.query("SELECT 1 FROM corporate_rights_narrowings WHERE seq>? AND scope IN (SELECT value FROM json_each(?)) LIMIT 1").get(seq, JSON.stringify(scopes)) != null;
  }
  logNarrowing(scope) {
    this.db.query("INSERT INTO corporate_rights_narrowings(scope) VALUES (?)").run(scope);
  }
  notePolicyWrite(subject, before, grants, chatAuthorized) {
    const kept = (old) => grants.some((grant) => grant.capabilityId === old.capabilityId && (grant.resourceId ?? null) === (old.resourceId ?? null) && (old.trusted !== true || grant.trusted === true));
    if (before.chatAuthorized === true && !chatAuthorized || !before.grants.every(kept))
      this.logNarrowing(`subject:${subject}`);
  }
  isVerifiedSuperadmin(actorUserId) {
    return actorUserId !== this.primaryOwnerId && /^[1-9]\d{0,19}$/.test(actorUserId) && this.isSuperadmin(actorUserId);
  }
  businessAdministrator(actorUserId) {
    return actorUserId === this.primaryOwnerId || this.isVerifiedSuperadmin(actorUserId);
  }
  businessSubjectAllowed(actorUserId, subject) {
    return this.businessAdministrator(actorUserId) && (actorUserId === this.primaryOwnerId || subject !== `user:${this.primaryOwnerId}`);
  }
  businessResourceVisible(actorUserId, resource) {
    if (actorUserId === this.primaryOwnerId)
      return true;
    return resource.connector !== "memory" || resource.config.corporateKey === "company" || resource.config.corporateKey === `user:${actorUserId}`;
  }
  businessResources(actorUserId) {
    if (!this.businessAdministrator(actorUserId))
      return [];
    return this.listResources().filter((resource) => this.businessResourceVisible(actorUserId, resource));
  }
  registerResource(resource, actorUserId, now) {
    if (!this.businessAdministrator(actorUserId)) {
      throw new Error("only the owner or a superadministrator can register a resource");
    }
    if (!this.businessResourceVisible(actorUserId, resource))
      throw new Error("owner private resource");
    this.validateResource(resource);
    const capabilityIds = [...new Set(resource.capabilityIds)].sort();
    this.db.transaction(() => {
      const before = this.db.query(`SELECT label,connector,capability_ids_json AS capabilityIdsJson,config_json AS configJson,active
        FROM corporate_resources WHERE resource_id=?`).get(resource.id);
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
      if (before && (before.label !== resource.label.trim() || before.connector !== resource.connector || before.active !== 1 || before.capabilityIdsJson !== safeJson(capabilityIds) || before.configJson !== safeJson(resource.config))) {
        this.logNarrowing(`resource:${resource.id}`);
        this.db.query("UPDATE corporate_actions SET state='cancelled',failure_code='resource_changed',updated_at=?,completed_at=? WHERE resource_id=? AND state='previewed'").run(now, now, resource.id);
      }
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
    if (!this.businessAdministrator(actorUserId))
      throw new Error("only the owner or a superadministrator can preview a resource");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      throw new Error("invalid resource preview expiry");
    return this.db.transaction(() => {
      const current = typeof input?.id === "string" ? this.resourceForControl(input.id) : null;
      if (current && !this.businessResourceVisible(actorUserId, current))
        throw new Error("owner private resource");
      const resource = resourceFromControl(input, current, (alias) => this.businessMcp?.binding(alias) ?? null);
      if (resource && !this.businessResourceVisible(actorUserId, resource))
        throw new Error("owner private resource");
      if (resource)
        this.validateResource(resource);
      const token = randomUUID2(), baseRevision = this.resourceRevision(input.id);
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
    if (!this.businessAdministrator(actor) || row.requestedBy !== actor)
      return { ok: false, reason: "actor" };
    if (row.state !== state)
      return { ok: false, reason: "used" };
    const reason = now > row.expiresAt ? "expired" : this.resourceRevision(row.resourceId) !== row.baseRevision ? "stale" : null;
    if (!reason)
      return null;
    this.db.query("UPDATE corporate_resource_previews SET state=?,resolved_at=? WHERE token=?").run(reason, now, row.token);
    return { ok: false, reason };
  }
  resourcePreviewDisplay(token) {
    const row = this.resourcePreview(token);
    return row ? { label: row.resourceJson ? JSON.parse(row.resourceJson).label : this.getResource(row.resourceId)?.label ?? row.resourceId, revoke: row.resourceJson == null } : null;
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
        this.logNarrowing(`resource:${row.resourceId}`);
        this.audit("resource", actor, "resource_revoked", { resourceId: row.resourceId }, now);
      }
      for (const policy of this.db.query("SELECT subject,version,grants_json AS grantsJson FROM corporate_policies").all()) {
        const grants = JSON.parse(policy.grantsJson);
        const retained = grants.filter((grant) => grant.resourceId !== row.resourceId || resource?.capabilityIds.includes(grant.capabilityId));
        if (retained.length === grants.length)
          continue;
        this.db.query("UPDATE corporate_policies SET version=version+1,grants_json=?,updated_at=? WHERE subject=?").run(safeJson(retained), now, policy.subject);
        this.logNarrowing(`subject:${policy.subject}`);
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
      return { subject, version: row.version, grants: this.activeGrants(row), ...row.chatAuthorized === 1 ? { chatAuthorized: true } : {} };
    const fallback = subject === AGENT_DEFAULT_SUBJECT || isInstalledAgentSubject(subject) ? null : this.policyRow(AGENT_DEFAULT_SUBJECT);
    if (fallback == null)
      return { subject, version: 0, grants: [] };
    return { subject, version: 0, grants: this.activeGrants(fallback).filter((grant) => !this.catalog[grant.capabilityId]?.namedPersonOnly), inheritedFrom: AGENT_DEFAULT_SUBJECT };
  }
  integrationAuthorizationKey(identity2) {
    if (identity2.chatType !== "private" || !/^[1-9]\d{0,15}$/.test(identity2.userId) || identity2.chatId !== identity2.userId)
      return null;
    if (identity2.userId === this.primaryOwnerId)
      return `owner:${identity2.userId}`;
    if (this.isVerifiedSuperadmin(identity2.userId))
      return `superadmin:${identity2.userId}`;
    const subject = `user:${identity2.userId}`;
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
      if (subject !== `user:${actorUserId}`)
        return { ...policy, grants: [] };
      if (actorUserId === this.primaryOwnerId || this.isVerifiedSuperadmin(actorUserId)) {
        return { ...policy, version: Math.max(1, policy.version), grants: [
          ...expandFullAccess(this.catalog, this.businessResources(actorUserId)),
          { capabilityId: "integrations.manage", resourceId: null }
        ] };
      }
      return policy;
    }
    if (policy.chatAuthorized)
      return policy;
    if (actorUserId === this.primaryOwnerId) {
      return { ...policy, grants: policy.grants.filter((grant) => this.catalog[grant.capabilityId]?.sharedAllowed === true) };
    }
    const actor = this.resolve(`user:${actorUserId}`);
    return { ...policy, grants: policy.grants.filter((grant) => this.catalog[grant.capabilityId]?.sharedAllowed === true && actor.grants.some((personal) => personal.capabilityId === grant.capabilityId && personal.resourceId === grant.resourceId)) };
  }
  policyRow(subject) {
    return this.db.query(`SELECT version,grants_json AS grantsJson,chat_authorized AS chatAuthorized
       FROM corporate_policies WHERE subject=?`).get(subject);
  }
  activeGrants(row) {
    const grants = JSON.parse(row.grantsJson);
    const activeResources = new Set(this.listResources().map((resource) => resource.id));
    return grants.filter((grant) => grant.resourceId == null || activeResources.has(grant.resourceId));
  }
  createPolicyPreview(input, now) {
    if (!this.businessSubjectAllowed(input.requestedBy, input.subject)) {
      throw new Error("only the owner or a superadministrator can create a business policy preview");
    }
    if (!isValidSubject(input.subject))
      throw new Error("invalid policy subject");
    if (input.conversation && (input.requestedBy !== this.primaryOwnerId || input.conversation.userId !== this.primaryOwnerId || !["group", "supergroup"].includes(input.conversation.chatType) || !/^-[1-9]\d{0,19}$/.test(input.conversation.chatId) || resolveSubject(input.conversation) !== input.subject))
      throw new Error("rule must name the verified owner conversation");
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw new Error("policy preview expiry must be in the future");
    }
    const visibleResources = new Set(this.businessResources(input.requestedBy).map((resource) => resource.id));
    const requested = sortedUniqueGrants(input.proposedGrants);
    if (input.requestedBy !== this.primaryOwnerId && requested.some((grant) => grant.resourceId != null && !visibleResources.has(grant.resourceId)))
      throw new Error("owner private resource");
    const protectedGrants = input.requestedBy === this.primaryOwnerId ? [] : this.resolve(input.subject).grants.filter((grant) => grant.resourceId != null && !visibleResources.has(grant.resourceId));
    const proposedGrants = sortedUniqueGrants([...requested, ...protectedGrants]);
    const pinned = this.pinnedBy(input.subject, this.changedKeys(this.ownGrants(input.subject), proposedGrants));
    if (pinned)
      throw new Error(`branch_pinned:${pinned}: a manager agent above set this access; change it there`);
    this.validateGrants(input.subject, proposedGrants, !!input.conversation || this.resolve(input.subject).chatAuthorized === true);
    const baseVersion = this.resolve(input.subject).version;
    const token = randomUUID2();
    this.db.transaction(() => {
      this.db.query(`INSERT INTO corporate_policy_previews(
           token,subject,base_version,grants_json,requested_by,expires_at,state,created_at,resource_versions_json,conversation_json
         ) VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(token, input.subject, baseVersion, safeJson(proposedGrants), input.requestedBy, input.expiresAt, now, this.resourceVersions(proposedGrants), input.conversation ? safeJson({ chatId: input.conversation.chatId, threadId: input.conversation.threadId ?? null, messageId: null }) : null);
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
  branchPins(subject) {
    const above = this.managersAbove();
    const pins = this.db.query(`SELECT resource_key AS resourceKey,pinned_by AS pinnedBy,confirmed_by AS confirmedBy,created_at AS createdAt
      FROM corporate_policy_pins WHERE subject=? ORDER BY resource_key`).all(subject);
    return above == null ? pins : pins.filter((pin) => above.includes(pin.pinnedBy));
  }
  ownGrants(subject) {
    const row = this.policyRow(subject);
    return row == null ? [] : this.activeGrants(row);
  }
  changedKeys(before, after) {
    const keyed = (grants) => {
      const map = new Map;
      for (const grant of sortedUniqueGrants(grants)) {
        const key = grant.resourceId ?? "*";
        map.set(key, [...map.get(key) ?? [], `${grant.capabilityId}${grant.trusted ? "+trusted" : ""}`]);
      }
      return map;
    };
    const left = keyed(before), right = keyed(after);
    return new Set([...left.keys(), ...right.keys()].filter((key) => (left.get(key) ?? []).join() !== (right.get(key) ?? []).join()));
  }
  pinnedBy(subject, keys, allowed = new Set) {
    return this.branchPins(subject).find((pin) => keys.has(pin.resourceKey) && !allowed.has(pin.pinnedBy))?.pinnedBy ?? null;
  }
  dropLapsedPins(subject, now) {
    const read = this.managersAbove();
    if (read == null)
      return;
    const above = new Set(read);
    const lapsed = this.db.query("SELECT resource_key AS resourceKey,pinned_by AS pinnedBy FROM corporate_policy_pins WHERE subject=?").all(subject).filter((pin) => !above.has(pin.pinnedBy));
    for (const pin of lapsed) {
      this.db.query("DELETE FROM corporate_policy_pins WHERE subject=? AND resource_key=? AND pinned_by=?").run(subject, pin.resourceKey, pin.pinnedBy);
      this.audit(subject, pin.pinnedBy, "branch_pin_lapsed", pin, now);
    }
  }
  branchCaller(managerId) {
    const above = this.managersAbove() ?? [];
    const index = above.indexOf(managerId);
    if (!AGENT_ID.test(managerId) || index < 0)
      throw new Error("the manager agent is not above this agent");
    return new Set(above.slice(0, index + 1));
  }
  branchPreview(subject, grants, change, expiresAt, now) {
    if (!isValidSubject(subject))
      throw new Error("invalid policy subject");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      throw new Error("policy preview expiry must be in the future");
    if (change.approvers.length < 1 || !change.approvers.every((id) => APPROVER.test(id)))
      throw new Error("a branch change needs its approvers");
    const baseVersion = this.resolve(subject).version;
    const token = randomUUID2();
    this.db.transaction(() => {
      this.db.query(`INSERT INTO corporate_policy_previews(token,subject,base_version,grants_json,requested_by,expires_at,state,created_at,resource_versions_json,branch_json)
         VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(token, subject, baseVersion, safeJson(grants), `agent:${change.managerId}`, expiresAt, now, this.resourceVersions(grants), safeJson(change));
      this.audit(subject, `agent:${change.managerId}`, `branch_${change.kind === "set" ? "policy" : "release"}_previewed`, {
        tokenHash: token.slice(0, 8),
        managerId: change.managerId,
        resourceKeys: change.resourceKeys,
        grants
      }, now);
    })();
    return { token, subject, baseVersion, proposedVersion: baseVersion + 1, proposedGrants: grants, expiresAt };
  }
  createBranchPolicyPreview(input, now) {
    const allowed = this.branchCaller(input.managerId);
    const keys = new Set(input.resourceKeys);
    if (keys.size < 1 || [...keys].some((key) => key !== "*" && !RESOURCE_ID2.test(key)))
      throw new Error("invalid resource keys");
    if (input.grants.some((grant) => !keys.has(grant.resourceId ?? "*")))
      throw new Error("a grant is outside the changed resources");
    const higher = this.pinnedBy(input.subject, keys, allowed);
    if (higher)
      throw new Error(`branch_pinned:${higher}: a manager agent above set this access; only it can change it`);
    const current = this.ownGrants(input.subject);
    const grants = sortedUniqueGrants([...current.filter((grant) => !keys.has(grant.resourceId ?? "*")), ...input.grants]);
    this.validateGrants(input.subject, grants, this.resolve(input.subject).chatAuthorized === true);
    return this.branchPreview(input.subject, grants, { kind: "set", managerId: input.managerId, approvers: [...new Set(input.approvers)], resourceKeys: [...keys] }, input.expiresAt, now);
  }
  createBranchReleasePreview(input, now) {
    const allowed = this.branchCaller(input.managerId);
    const keys = new Set(input.resourceKeys);
    const higher = this.pinnedBy(input.subject, keys, allowed);
    if (higher)
      throw new Error(`branch_pinned:${higher}: a manager agent above set this access; only it can release it`);
    return this.branchPreview(input.subject, this.ownGrants(input.subject), { kind: "release", managerId: input.managerId, approvers: [...new Set(input.approvers)], resourceKeys: [...keys] }, input.expiresAt, now);
  }
  approveBranchPreview(token, actorUserId, now) {
    return this.db.transaction(() => {
      const row = this.preview(token);
      const change = row?.branchJson ? JSON.parse(row.branchJson) : null;
      if (row == null || change == null)
        return { ok: false, reason: "missing" };
      if (!change.approvers.includes(actorUserId))
        return { ok: false, reason: "actor" };
      if (row.state !== "pending")
        return { ok: false, reason: "used" };
      if (now > row.expiresAt) {
        this.resolvePreview(token, "expired", now);
        return { ok: false, reason: "expired" };
      }
      let allowed;
      try {
        allowed = this.branchCaller(change.managerId);
      } catch {
        this.resolvePreview(token, "stale", now);
        return { ok: false, reason: "stale" };
      }
      const keys = new Set(change.resourceKeys);
      if (this.resolve(row.subject).version !== row.baseVersion || this.pinnedBy(row.subject, keys, allowed) || row.resourceVersionsJson !== this.resourceVersions(JSON.parse(row.grantsJson))) {
        this.resolvePreview(token, "stale", now);
        return { ok: false, reason: "stale" };
      }
      let version = row.baseVersion;
      if (change.kind === "set") {
        const before = this.resolve(row.subject);
        const chatAuthorized = before.chatAuthorized === true;
        version = row.baseVersion + 1;
        const written = row.baseVersion === 0 ? this.db.query(`INSERT INTO corporate_policies(subject,version,grants_json,updated_at,chat_authorized) VALUES(?,?,?,?,?)`).run(row.subject, version, row.grantsJson, now, chatAuthorized ? 1 : 0) : this.db.query(`UPDATE corporate_policies SET version=?,grants_json=?,updated_at=? WHERE subject=? AND version=?`).run(version, row.grantsJson, now, row.subject, row.baseVersion);
        if (written.changes !== 1) {
          this.resolvePreview(token, "stale", now);
          return { ok: false, reason: "stale" };
        }
        this.notePolicyWrite(row.subject, before, JSON.parse(row.grantsJson), chatAuthorized);
        for (const key of keys) {
          this.db.query(`INSERT INTO corporate_policy_pins(subject,resource_key,pinned_by,confirmed_by,created_at) VALUES(?,?,?,?,?)
            ON CONFLICT(subject,resource_key) DO UPDATE SET pinned_by=excluded.pinned_by,confirmed_by=excluded.confirmed_by,created_at=excluded.created_at`).run(row.subject, key, change.managerId, actorUserId, now);
        }
      } else {
        for (const key of keys) {
          this.db.query("DELETE FROM corporate_policy_pins WHERE subject=? AND resource_key=?").run(row.subject, key);
        }
      }
      this.resolvePreview(token, "approved", now);
      this.audit(row.subject, actorUserId, change.kind === "set" ? "branch_policy_approved" : "branch_pins_released", {
        managerId: change.managerId,
        resourceKeys: change.resourceKeys,
        baseVersion: row.baseVersion,
        version,
        grants: JSON.parse(row.grantsJson)
      }, now);
      return { ok: true, version };
    })();
  }
  cancelBranchPreview(token, actorUserId, now) {
    return this.db.transaction(() => {
      const row = this.preview(token);
      const change = row?.branchJson ? JSON.parse(row.branchJson) : null;
      if (row == null || change == null)
        return { ok: false, reason: "missing" };
      if (!change.approvers.includes(actorUserId))
        return { ok: false, reason: "actor" };
      if (row.state !== "pending")
        return { ok: false, reason: "used" };
      this.resolvePreview(token, "cancelled", now);
      this.audit(row.subject, actorUserId, "branch_change_cancelled", { managerId: change.managerId, resourceKeys: change.resourceKeys }, now);
      return { ok: true };
    })();
  }
  isBranchPreview(token) {
    return !!this.preview(token)?.branchJson;
  }
  branchSummary() {
    const subjects = this.db.query("SELECT subject FROM corporate_policies UNION SELECT subject FROM corporate_policy_pins ORDER BY subject").all().map((row) => row.subject);
    return {
      resources: this.listResources().map(({ id, label, connector, capabilityIds }) => ({ id, label, connector, capabilityIds })),
      policies: subjects.map((subject) => ({
        subject,
        grants: this.ownGrants(subject),
        pins: this.branchPins(subject).map(({ resourceKey, pinnedBy }) => ({ resourceKey, pinnedBy }))
      }))
    };
  }
  bindPolicyMessage(token, message) {
    const row = this.preview(token);
    if (!row?.conversationJson || row.state !== "pending" || !Number.isSafeInteger(message.messageId) || message.messageId <= 0)
      return false;
    const context = JSON.parse(row.conversationJson);
    if (context.messageId != null || context.chatId !== message.chatId || context.threadId !== (message.threadId ?? null))
      return false;
    return this.db.query("UPDATE corporate_policy_previews SET conversation_json=? WHERE token=? AND state='pending' AND conversation_json=?").run(safeJson({ ...context, messageId: message.messageId }), token, row.conversationJson).changes === 1;
  }
  bindBusinessMessage(token, message) {
    const preview = this.preview(token) ?? this.resourcePreview(token);
    if (!preview || preview.state !== "pending" || !this.businessAdministrator(preview.requestedBy) || !Number.isSafeInteger(message.messageId) || message.messageId <= 0 || !/^-?[1-9]\d{0,19}$/.test(message.chatId) || message.threadId != null && (!message.chatId.startsWith("-") || !Number.isSafeInteger(message.threadId) || message.threadId <= 0) || !message.chatId.startsWith("-") && message.chatId !== preview.requestedBy)
      return false;
    return this.db.query("INSERT OR IGNORE INTO corporate_business_messages(token,actor,chat_id,thread_id,message_id) VALUES(?,?,?,?,?)").run(token, preview.requestedBy, message.chatId, message.threadId ?? null, message.messageId).changes === 1;
  }
  businessMessageMatches(token, message) {
    const row = this.db.query("SELECT actor,chat_id AS chatId,thread_id AS threadId,message_id AS messageId FROM corporate_business_messages WHERE token=?").get(token);
    return row == null ? null : row.actor === message.userId && row.chatId === message.chatId && row.threadId === (message.threadId ?? null) && row.messageId === message.messageId;
  }
  policyTokenForMessage(message) {
    return this.db.query(`SELECT token FROM corporate_policy_previews WHERE state='pending'
      AND requested_by=? AND json_valid(conversation_json)
      AND json_extract(conversation_json,'$.chatId')=? AND json_extract(conversation_json,'$.messageId')=?
      AND json_extract(conversation_json,'$.threadId') IS ?`).get(this.primaryOwnerId, message.chatId, message.messageId, message.threadId ?? null)?.token ?? null;
  }
  policyPreviewDisplay(token) {
    const row = this.preview(token);
    return row ? { subject: row.subject, grants: JSON.parse(row.grantsJson) } : null;
  }
  isConversationPolicyPreview(token) {
    return !!this.preview(token)?.conversationJson;
  }
  approvePolicyPreview(token, actorUserId, now, message) {
    return this.db.transaction(() => {
      const row = this.preview(token);
      if (row == null)
        return { ok: false, reason: "missing" };
      if (!this.businessSubjectAllowed(actorUserId, row.subject) || actorUserId !== row.requestedBy) {
        return { ok: false, reason: "actor" };
      }
      if (!this.validAgentMessage(row, message))
        return { ok: false, reason: "actor" };
      if (!this.validConversationMessage(row, message))
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
      if (this.pinnedBy(row.subject, this.changedKeys(this.ownGrants(row.subject), grants))) {
        this.resolvePreview(token, "stale", now);
        return { ok: false, reason: "stale" };
      }
      const before = this.resolve(row.subject);
      const chatAuthorized = !!row.conversationJson || before.chatAuthorized === true;
      this.validateGrants(row.subject, grants, chatAuthorized);
      const version = row.baseVersion + 1;
      if (row.baseVersion === 0) {
        this.db.query(`INSERT INTO corporate_policies(subject,version,grants_json,updated_at,chat_authorized)
           VALUES(?,?,?,?,?)`).run(row.subject, version, row.grantsJson, now, chatAuthorized ? 1 : 0);
      } else {
        const update = this.db.query(`UPDATE corporate_policies SET version=?,grants_json=?,updated_at=?,chat_authorized=?
           WHERE subject=? AND version=?`).run(version, row.grantsJson, now, chatAuthorized ? 1 : 0, row.subject, row.baseVersion);
        if (update.changes !== 1) {
          this.resolvePreview(token, "stale", now);
          return { ok: false, reason: "stale" };
        }
      }
      this.notePolicyWrite(row.subject, before, grants, chatAuthorized);
      this.resolvePreview(token, "approved", now);
      this.audit(row.subject, actorUserId, "policy_approved", {
        baseVersion: row.baseVersion,
        version,
        grants
      }, now);
      this.dropLapsedPins(row.subject, now);
      return { ok: true, version };
    })();
  }
  cancelPolicyPreview(token, actorUserId, now, message) {
    return this.db.transaction(() => {
      const row = this.preview(token);
      if (row == null)
        return { ok: false, reason: "missing" };
      if (!this.businessSubjectAllowed(actorUserId, row.subject) || actorUserId !== row.requestedBy) {
        return { ok: false, reason: "actor" };
      }
      if (!this.validAgentMessage(row, message))
        return { ok: false, reason: "actor" };
      if (!this.validConversationMessage(row, message))
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
    const actor = actorUserId === this.primaryOwnerId ? this.resolveForActor(`user:${actorUserId}`, actorUserId) : this.resolve(`user:${actorUserId}`);
    const group = this.resolve(groupSubject);
    return actor.grants.some((grant) => grant.capabilityId === request.capability && grant.resourceId === request.resourceId) && group.grants.some((grant) => grant.capabilityId === readId && grant.resourceId === request.resourceId) ? group.version : null;
  }
  delegatedMetaActionAuthorized(input) {
    const key = this.integrationAuthorizationKey({ chatType: "private", chatId: input.chatId, userId: input.actorUserId });
    const args = input.arguments;
    return key !== null && input.subject === `user:${input.actorUserId}` && input.chatId === input.actorUserId && input.operation === "meta.run" && input.resourceId === "delegated:meta" && input.groupOrigin == null && this.integrationAuthorizationKey({ chatType: "private", chatId: input.chatId, userId: input.actorUserId }) === key && args != null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).sort().join(",") === "args,authorizationKey,confirmationToken,connectionKey" && Array.isArray(args.args) && args.args.length > 0 && args.args.every((value) => typeof value === "string") && args.authorizationKey === key && typeof args.connectionKey === "string" && args.connectionKey.trim().length > 0 && typeof args.confirmationToken === "string" && args.confirmationToken.trim().length > 0;
  }
  createActionPreview(input, now) {
    if (input.subject !== `user:${input.actorUserId}` || input.chatId !== input.actorUserId || input.expiresAt <= now || input.workspace != null && (typeof input.workspace !== "string" || !isAbsolute2(input.workspace)))
      throw new Error("write previews require the verified private actor");
    const policy = this.resolveForActor(input.subject, input.actorUserId);
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
      resourceRevision: this.resourceRevision(input.resourceId),
      arguments: JSON.parse(argumentsJson),
      ...input.originJobId ? { originJobId: input.originJobId } : {},
      ...groupOrigin ? { groupOrigin } : {},
      ...input.workspace ? { workspace: input.workspace } : {}
    };
    const payloadJson = canonicalJson(payload);
    const payloadSha256 = createHash4("sha256").update(payloadJson).digest("hex");
    const { groupOrigin: _unfrozenOrigin, ...ordinaryInput } = input;
    const action = {
      actionId: randomUUID2(),
      token: randomUUID2(),
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
      if (row.state === "cancelled" && row.failureCode === "resource_changed")
        return { ok: false, reason: "stale" };
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
      if (createHash4("sha256").update(row.payloadJson).digest("hex") !== row.payloadSha256) {
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
      const policy = this.resolveForActor(row.subject, actorUserId);
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
          ...payload.groupOrigin ? { groupOrigin: payload.groupOrigin } : {},
          ...typeof payload.workspace === "string" ? { workspace: payload.workspace } : {}
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
    if (businessMcpResource(resource) && !this.businessMcp?.resolve(resource))
      throw new Error("business MCP publication changed or is unavailable");
    if (!RESOURCE_ID2.test(resource.id))
      throw new Error("invalid resource id");
    const label = resource.label.trim();
    if (label.length === 0 || label.length > 120)
      throw new Error("invalid resource label");
    if (!RESOURCE_CONNECTORS.includes(resource.connector)) {
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
  validateGrants(subject, grants, chatAuthorized = false) {
    const resources = new Map(this.listResources().map((resource) => [resource.id, resource]));
    for (const grant of grants) {
      const definition = this.catalog[grant.capabilityId];
      if (grant.capabilityId === "*" || definition == null || !definition.delegable) {
        throw new Error(`unknown or nondelegable capability: ${grant.capabilityId}`);
      }
      if (definition.namedPersonOnly && !/^user:[1-9]\d{0,15}$/.test(subject)) {
        throw new Error("integration management is only for one named person");
      }
      const chatWrite = chatAuthorized && isSharedSubject(subject) && definition.requiresResource && definition.requiresConfirmation && grant.trusted === true;
      if (isSharedSubject(subject) && (!definition.sharedAllowed || definition.requiresConfirmation) && !chatWrite) {
        throw new Error("write capabilities are not allowed in shared conversations");
      }
      if (grant.trusted === true) {
        if (!/^user:\d+$/.test(subject) && !chatWrite)
          throw new Error("trust is only for one named person or an owner-confirmed chat rule");
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
  validConversationMessage(row, message) {
    if (!row.conversationJson)
      return true;
    if (!message || row.requestedBy !== this.primaryOwnerId)
      return false;
    const bound = JSON.parse(row.conversationJson);
    return Number.isSafeInteger(bound.messageId) && bound.messageId > 0 && bound.chatId === message.chatId && bound.messageId === message.messageId && (bound.threadId ?? null) === (message.threadId ?? null);
  }
  preview(token) {
    return this.db.query(`SELECT token,subject,base_version AS baseVersion,grants_json AS grantsJson,
              requested_by AS requestedBy,expires_at AS expiresAt,state,
              resource_versions_json AS resourceVersionsJson,agent_request_id AS agentRequestId,
              agent_request_json AS agentRequestJson,agent_message_json AS agentMessageJson,conversation_json AS conversationJson,
              branch_json AS branchJson
       FROM corporate_policy_previews WHERE token=?`).get(token);
  }
  action(token) {
    return this.db.query(`SELECT action_id AS actionId,token,subject,actor_user_id AS actorUserId,
              chat_id AS chatId,policy_version AS policyVersion,
              capability_id AS capabilityId,operation,resource_id AS resourceId,
              arguments_json AS argumentsJson,payload_json AS payloadJson,
              payload_sha256 AS payloadSha256,state,expires_at AS expiresAt,
              receipt_id AS receiptId,failure_code AS failureCode
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
// modules/telegram-corporate/agent-access.ts
import { homedir } from "os";
import { dirname as dirname2, join as join2 } from "path";

// modules/telegram-corporate/branch-access.ts
import { Database as Database3 } from "bun:sqlite";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
var run = promisify(execFile);
var USER_ID = /^[1-9]\d{0,19}$/;
var TTL_MS = 10 * 60000;
function accessPreviewState(dbPath, token) {
  try {
    const db = new Database3(dbPath, { readonly: true });
    try {
      return db.query("SELECT state FROM access_branch_previews WHERE token=?").get(token)?.state ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
var NOTICE_BUSY_MS = 10 * 60000;
function branchDecision(options, token, decision, context) {
  const inAccessFile = accessPreviewState(options.dbPath, token) != null;
  if (!inAccessFile && !options.store.isBranchPreview(token))
    return null;
  if (context.chatType !== "private" || context.chatId !== context.userId || !USER_ID.test(context.userId))
    return { ok: false, reason: "actor" };
  if (!inAccessFile) {
    return decision === "approve" ? options.store.approveBranchPreview(token, context.userId, Date.now()) : { ...options.store.cancelBranchPreview(token, context.userId, Date.now()), state: "cancelled" };
  }
  try {
    execFileSync(options.script, ["branch-confirm", options.accessPath, options.ownerChatId, context.userId, token, decision], { timeout: 15000, maxBuffer: 4096, stdio: "pipe" });
    return decision === "approve" ? { ok: true } : { ok: true, state: "cancelled" };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (/^BRANCH_ACTOR:/m.test(stderr))
      return { ok: false, reason: "actor" };
    if (!/^ACCESS_STALE:/m.test(stderr))
      return { ok: false, reason: "uncertain" };
    const state = accessPreviewState(options.dbPath, token);
    return { ok: false, reason: state === "stale" ? "stale" : state === "pending" ? "expired" : "used" };
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
  const branch = branchDecision({
    store,
    dbPath,
    ownerChatId: owner,
    accessPath: join2(dirname2(dbPath), "access.json"),
    script: join2(homedir(), "bin/access-update")
  }, token, decision, context);
  if (branch)
    return branch;
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
import { mkdirSync as mkdirSync3, rmSync as rmSync3 } from "fs";
import { randomBytes as randomBytes3 } from "crypto";
import { basename as basename2, join as join8 } from "path";
import { Database as Database5 } from "bun:sqlite";

// modules/telegram-corporate/action-summary.ts
function htmlText(html) {
  return html.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<br\s*\/?>/gi, `
`).replace(/<\/(p|div|li|h[1-6]|tr|table|blockquote|section|article)\s*>/gi, `
`).replace(/<li\b[^>]*>/gi, "\u2022 ").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d{1,7});/g, (_, code) => String.fromCodePoint(Number(code) <= 1114111 ? Number(code) : 65533)).replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => String.fromCodePoint(parseInt(code, 16) <= 1114111 ? parseInt(code, 16) : 65533)).replace(/&amp;/gi, "&").split(`
`).map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim()).filter((line, index, lines) => line !== "" || index > 0 && lines[index - 1] !== "").join(`
`).trim();
}

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
    return { exitCode: 130, stdout: "", stderr: "", started: false };
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
var MAX_DEPTH = 8;

class DriveFolderIndex {
  home;
  run;
  account;
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
      return null;
    }
    return parents;
  }
}

// modules/telegram-corporate/adapters/slides.ts
import { Database as Database4 } from "bun:sqlite";
import { randomBytes as randomBytes2 } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join as join5 } from "path";

// modules/telegram-corporate/adapters/public-image-url.ts
function publicImageUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f]/.test(value))
    return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port !== "" && url.port !== "443" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(url.hostname))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

// modules/telegram-corporate/adapters/drive-folders.ts
import { mkdirSync as mkdirSync2, rmSync } from "fs";
import { randomBytes } from "crypto";
import { basename, join as join4 } from "path";

// modules/telegram-corporate/adapters/workspace-file.ts
import { createHash as createHash5 } from "crypto";
import { closeSync as closeSync2, constants as constants2, fstatSync as fstatSync2, lstatSync as lstatSync2, openSync as openSync2, readSync, realpathSync as realpathSync2, writeSync } from "fs";
import { dirname as dirname3, isAbsolute as isAbsolute3, join as join3, resolve, sep } from "path";
function streamWorkspaceFile(workspace, file2, maxBytes, copy) {
  if (!workspace || !isAbsolute3(workspace) || isAbsolute3(file2) || file2.split("/").includes(".."))
    return null;
  let fd, out;
  try {
    const root = realpathSync2(workspace), path = realpathSync2(resolve(root, file2));
    const before = lstatSync2(path);
    if (!path.startsWith(root + sep) || !before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maxBytes)
      return null;
    fd = openSync2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
    const opened = fstatSync2(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== before.size)
      return null;
    if (copy)
      out = openSync2(copy.target, "wx", 384);
    const hash = createHash5("sha256"), chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
    let size = 0, head = Buffer.alloc(0);
    for (let count = readSync(fd, chunk, 0, chunk.length, null);count > 0; count = readSync(fd, chunk, 0, chunk.length, null)) {
      size += count;
      if (size > before.size)
        return null;
      if (head.length < 16)
        head = Buffer.concat([head, chunk.subarray(0, Math.min(count, 16 - head.length))]);
      hash.update(chunk.subarray(0, count));
      if (out !== undefined)
        writeSync(out, chunk, 0, count);
    }
    const after = fstatSync2(fd), sha256 = hash.digest("hex");
    if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      return null;
    if (copy && sha256 !== copy.expected)
      return null;
    return { sha256, size, head };
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      closeSync2(fd);
    if (out !== undefined)
      closeSync2(out);
  }
}
function workspaceIdentity(workspaceRoot, workspace) {
  try {
    if (typeof workspace !== "string" || dirname3(workspace) !== workspaceRoot || !/^[a-f0-9]{64}$/.test(workspace.slice(workspaceRoot.length + 1)))
      return null;
    const before = lstatSync2(workspace, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory() || realpathSync2(workspace) !== join3(realpathSync2(workspaceRoot), workspace.slice(workspaceRoot.length + 1)))
      return null;
    const fd = openSync2(workspace, constants2.O_RDONLY | constants2.O_DIRECTORY | constants2.O_NOFOLLOW);
    try {
      const info = fstatSync2(fd, { bigint: true });
      return info.dev === before.dev && info.ino === before.ino ? { device: String(info.dev), inode: String(info.ino) } : null;
    } finally {
      closeSync2(fd);
    }
  } catch {
    return null;
  }
}
var PUBLISH_FOLDER = `
import json, os, re, stat, sys
workspace, device, inode, folder, limit = sys.argv[1:]
spec = json.loads(sys.stdin.read())
# Any script's letters and digits (a letter's attachment is often \xAB\u0414\u043E\u0433\u043E\u0432\u0456\u0440.pdf\xBB), never a slash or a leading dot.
NAME = re.compile(r'^[^\\W_][\\w .()-]{0,120}$')
directory = target = None
opened = {}
created = []
total = 0
try:
    if not NAME.match(folder): raise ValueError()
    directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    def same_workspace():
        mine, path = os.fstat(directory), os.lstat(workspace)
        return (stat.S_ISDIR(path.st_mode) and not stat.S_ISLNK(path.st_mode)
                and mine.st_dev == path.st_dev == int(device) and mine.st_ino == path.st_ino == int(inode))
    if not same_workspace(): raise ValueError()
    os.mkdir(folder, 0o700, dir_fd=directory)
    created.append((directory, folder, True))
    target = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
    opened[''] = target
    for item in spec['files']:
        parts = item['name'].split('/')
        if not 1 <= len(parts) <= 2 or not all(NAME.match(part) for part in parts): raise ValueError()
        parent = opened['']
        if len(parts) == 2:
            if parts[0] not in opened:
                os.mkdir(parts[0], 0o700, dir_fd=parent)
                created.append((parent, parts[0], True))
                opened[parts[0]] = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            parent = opened[parts[0]]
        source = os.open(item['source'], os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(source)
            if not stat.S_ISREG(info.st_mode) or info.st_size <= 0: raise ValueError()
            total += info.st_size
            if total > int(limit): raise ValueError()
            out = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            created.append((parent, parts[-1], False))
            try:
                copied = 0
                while True:
                    chunk = os.read(source, 8 * 1024 * 1024)
                    if not chunk: break
                    os.write(out, chunk)
                    copied += len(chunk)
                if copied != info.st_size: raise ValueError()
            finally: os.close(out)
        finally: os.close(source)
    if not same_workspace(): raise ValueError()
    print(json.dumps({'bytes': total, 'files': len(spec['files'])}))
    created = []
except Exception:
    sys.exit(1)
finally:
    for parent, name, is_dir in reversed(created):
        try: os.rmdir(name, dir_fd=parent) if is_dir else os.unlink(name, dir_fd=parent)
        except OSError: pass
    for fd in list(opened.values()) + [directory]:
        if fd is not None:
            try: os.close(fd)
            except OSError: pass
`;
async function publishFolder(options) {
  const identity2 = workspaceIdentity(options.workspaceRoot, options.workspace);
  if (identity2 == null || options.files.length === 0)
    return null;
  const result = await runBoundedCommand({
    argv: ["python3", "-c", PUBLISH_FOLDER, options.workspace, identity2.device, identity2.inode, options.folder, String(options.limitBytes)],
    cwd: options.home,
    env: { HOME: options.home, PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeoutMs: 120000,
    stdin: JSON.stringify({ files: options.files })
  }, options.signal);
  if (result.exitCode !== 0 || options.signal.aborted)
    return null;
  try {
    return JSON.parse(result.stdout).files === options.files.length ? join3(options.workspace, options.folder) : null;
  } catch {
    return null;
  }
}

// modules/telegram-corporate/adapters/drive-folders.ts
var MAX_DRIVE_UPLOAD_BYTES = 1024 ** 3;
var FOLDER = "application/vnd.google-apps.folder";
var invalid2 = (message) => ({ ok: false, code: "invalid", message });
var cancelled = () => ({ ok: false, code: "failed", message: "\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0441\u043A\u0430\u0441\u043E\u0432\u0430\u043D\u043E \u0434\u043E \u0437\u0430\u043F\u0438\u0441\u0443 \u0432 Google; \u0442\u0435\u043A\u0443 \u043D\u0435 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043E." });
function parsed(result) {
  if (result.exitCode !== 0 || result.stdoutTruncated)
    return null;
  try {
    const value = JSON.parse(result.stdout);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
async function nativeCreationParent(options, request, signal) {
  if (signal.aborted)
    return { ok: false, result: { ok: false, code: "unavailable" } };
  const roots = allowedFolders(request.resource).map((folder) => folder.folderId);
  const whole = wholeDrive(request.resource);
  const fail = (message) => ({ ok: false, result: invalid2(message) });
  if (request.resource.config.allowCreate !== true && roots.length === 0)
    return fail("\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0444\u0430\u0439\u043B\u0456\u0432 \u043D\u0435 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0435 \u0446\u0438\u043C \u0440\u0435\u0441\u0443\u0440\u0441\u043E\u043C.");
  const parent = request.arguments.parentId ?? (!whole && roots.length === 1 ? roots[0] : undefined);
  if (parent === undefined)
    return roots.length > 0 && !whole ? fail("\u0412\u043A\u0430\u0436\u0438 parentId \u043E\u0434\u043D\u0456\u0454\u0457 \u0437 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 \u0442\u0435\u043A.") : { ok: true };
  if (typeof parent !== "string" || !(GOOGLE_FILE_ID.test(parent) || whole && parent === "root"))
    return fail("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 parentId.");
  if (!whole) {
    try {
      const membership = await new DriveFolderIndex({ ...options, account: String(request.resource.config.account) }).membership(parent, roots, signal);
      if (membership !== "inside" || signal.aborted)
        return fail("Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432, \u0449\u043E \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u0430 \u0442\u0435\u043A\u0430 \u043D\u0430\u043B\u0435\u0436\u0438\u0442\u044C \u0446\u044C\u043E\u043C\u0443 \u0440\u0435\u0441\u0443\u0440\u0441\u0443. \u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u043B\u043E\u0441\u044F.");
    } catch {
      return { ok: false, result: { ok: false, code: "unavailable", message: "Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432 \u0434\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u043E\u0457 \u0442\u0435\u043A\u0438. \u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u043B\u043E\u0441\u044F." } };
    }
  }
  return { ok: true, parentId: parent === "root" && whole ? undefined : parent };
}
async function nativeParentReadback(options, account, id, parentId, signal) {
  try {
    const result = await options.run({
      argv: [
        join4(options.home, "bin/gog"),
        "--no-input",
        "--json",
        "--readonly",
        "--enable-commands-exact=api.call,api.drive.files.get",
        "api",
        "call",
        "drive",
        "v3",
        "files.get",
        "--params",
        JSON.stringify({ fileId: id, fields: "id,parents,trashed", supportsAllDrives: true }),
        "--scope",
        "https://www.googleapis.com/auth/drive.metadata.readonly"
      ],
      cwd: options.home,
      env: { HOME: options.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 30000
    }, signal);
    const data = parsed(result);
    return !signal.aborted && data?.id === id && data.trashed === false && Array.isArray(data.parents) && data.parents.length === 1 && data.parents[0] === parentId;
  } catch {
    return false;
  }
}

class DriveFoldersAdapter {
  options;
  constructor(options) {
    this.options = options;
  }
  async execute(request, signal) {
    if (request.operation === "upload")
      return this.upload(request, signal);
    const { name } = request.arguments;
    let { parentId } = request.arguments;
    const whole = wholeDrive(request.resource);
    if (request.operation !== "create_folder" || Object.keys(request.arguments).some((key) => !["name", "parentId"].includes(key)) || typeof name !== "string" || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(name) || !(typeof parentId === "string" && (GOOGLE_FILE_ID.test(parentId) || whole && parentId === "root"))) {
      return invalid2(whole ? '\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0442\u0435\u043A\u0438 \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 name (1\u2013200 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432) \u0456 parentId \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u043E\u0457 \u0442\u0435\u043A\u0438 ("root" \u2014 \u043A\u043E\u0440\u0456\u043D\u044C \u0414\u0438\u0441\u043A\u0430).' : "\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0442\u0435\u043A\u0438 \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 name (1\u2013200 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432) \u0456 parentId \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E\u0457 \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u043E\u0457 \u0442\u0435\u043A\u0438. \u0412\u0456\u0437\u044C\u043C\u0438 \u0457\u0457 ID \u0437 \u0440\u043E\u0431\u043E\u0447\u0438\u0445 \u0440\u0435\u0441\u0443\u0440\u0441\u0456\u0432; \u043A\u043E\u0440\u0456\u043D\u044C \u043E\u0441\u043E\u0431\u0438\u0441\u0442\u043E\u0433\u043E \u0414\u0438\u0441\u043A\u0430 \u043D\u0435 \u043F\u0456\u0434\u0441\u0442\u0430\u0432\u043B\u044F\u0439.");
    }
    const account = request.resource.config.account;
    if (typeof account !== "string" || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(account) || account.length > 254) {
      return invalid2("\u0414\u043B\u044F \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u043D\u0435 \u0432\u0438\u0431\u0440\u0430\u043D\u0438\u0439 Google-\u0430\u043A\u0430\u0443\u043D\u0442. \u0414\u043E\u043F\u043E\u043C\u043E\u0436\u0438 \u0432\u043B\u0430\u0441\u043D\u0438\u043A\u0443 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0438 \u0440\u043E\u0431\u043E\u0447\u0438\u0439 Google \u0456 \u0432\u043A\u0430\u0437\u0430\u0442\u0438 \u0439\u043E\u0433\u043E \u0434\u043B\u044F \u0446\u0456\u0454\u0457 \u0442\u0435\u043A\u0438.");
    }
    const roots = allowedFolders(request.resource).map((folder) => folder.folderId);
    if (!roots.length && !whole)
      return invalid2("\u0412\u043B\u0430\u0441\u043D\u0438\u043A \u0449\u0435 \u043D\u0435 \u043D\u0430\u0434\u0430\u0432 \u0440\u043E\u0431\u043E\u0447\u0443 \u0442\u0435\u043A\u0443 \u0434\u043B\u044F \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0432\u043A\u043B\u0430\u0434\u0435\u043D\u0438\u0445 \u0442\u0435\u043A. \u041F\u043E\u043F\u0440\u043E\u0441\u0438 \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F \u043D\u0430 \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0443 \u0442\u0435\u043A\u0443 \u0439 \u0434\u043E\u043F\u043E\u043C\u043E\u0436\u0438 \u0432\u043B\u0430\u0441\u043D\u0438\u043A\u0443 \u043D\u0430\u0434\u0430\u0442\u0438 \u0446\u0456\u0439 \u0433\u0440\u0443\u043F\u0456 \u043F\u0440\u0430\u0432\u043E \u0441\u0442\u0432\u043E\u0440\u044E\u0432\u0430\u0442\u0438 \u0432 \u043D\u0456\u0439 \u0442\u0435\u043A\u0438.");
    if (signal.aborted)
      return cancelled();
    const run2 = (method, params, body) => this.options.run({
      argv: [
        join4(this.options.home, "bin/gog"),
        "--no-input",
        "--json",
        ...body ? [] : ["--readonly"],
        `--enable-commands-exact=api.call,api.drive.${method.toLowerCase()}`,
        "api",
        "call",
        "drive",
        "v3",
        method,
        "--params",
        JSON.stringify({ ...params, supportsAllDrives: true }),
        "--scope",
        body ? "https://www.googleapis.com/auth/drive" : "https://www.googleapis.com/auth/drive.metadata.readonly",
        ...body ? ["--body", "@/dev/stdin", "--allow-write", "--force"] : []
      ],
      cwd: this.options.home,
      env: { HOME: this.options.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 30000,
      ...body ? { stdin: JSON.stringify(body) } : {}
    }, signal);
    try {
      if (!whole) {
        const membership = await new DriveFolderIndex({ home: this.options.home, account, run: this.options.run }).membership(parentId, roots, signal);
        if (signal.aborted)
          return cancelled();
        if (membership === "unknown")
          return { ok: false, code: "unavailable", message: "Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432 \u0440\u043E\u0437\u0442\u0430\u0448\u0443\u0432\u0430\u043D\u043D\u044F \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u043E\u0457 \u0442\u0435\u043A\u0438; \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u043B\u043E\u0441\u044F. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0441\u0442\u0430\u043D \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F Google \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u0442\u0430 \u043F\u043E\u0432\u0442\u043E\u0440\u0438 \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0443 \u0434\u043E\u0441\u0442\u0443\u043F\u0443." };
        if (membership !== "inside")
          return invalid2("\u0411\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u0430 \u0442\u0435\u043A\u0430 \u043F\u043E\u0437\u0430 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u043C \u0440\u043E\u0431\u043E\u0447\u0438\u043C \u0440\u0435\u0441\u0443\u0440\u0441\u043E\u043C. \u041E\u0431\u0435\u0440\u0438 \u0442\u0435\u043A\u0443 \u0437 \u043D\u0430\u0434\u0430\u043D\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u0430\u0431\u043E \u0434\u043E\u043F\u043E\u043C\u043E\u0436\u0438 \u0432\u043B\u0430\u0441\u043D\u0438\u043A\u0443 \u043D\u0430\u0434\u0430\u0442\u0438 \u0434\u043E\u0441\u0442\u0443\u043F \u0441\u0430\u043C\u0435 \u0434\u043E \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u043E\u0457 \u0442\u0435\u043A\u0438.");
      }
      const parent = parsed(await run2("files.get", { fileId: parentId, fields: "id,mimeType,trashed,capabilities(canAddChildren)" }));
      if (whole && parentId === "root" && typeof parent?.id === "string" && GOOGLE_FILE_ID.test(parent.id))
        parentId = parent.id;
      if (signal.aborted)
        return cancelled();
      if (!parent || parent.id !== parentId || typeof parentId !== "string")
        return { ok: false, code: "unavailable", message: "Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432 \u0434\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u043E\u0457 \u0442\u0435\u043A\u0438; \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u043B\u043E\u0441\u044F. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0432\u0445\u0456\u0434 \u0440\u043E\u0431\u043E\u0447\u043E\u0433\u043E \u0430\u043A\u0430\u0443\u043D\u0442\u0430 \u0439 \u0434\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u0446\u044C\u043E\u0433\u043E \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F." };
      if (parent.mimeType !== FOLDER || parent.trashed !== false)
        return invalid2("\u0411\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u0430 \u0442\u0435\u043A\u0430 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0430 \u044F\u043A \u0447\u0438\u043D\u043D\u0430 \u0442\u0435\u043A\u0430 Google \u0414\u0438\u0441\u043A\u0430. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F: \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0430 \u0442\u0435\u043A\u0430, \u044F\u043A\u0430 \u043D\u0435 \u043F\u0435\u0440\u0435\u0431\u0443\u0432\u0430\u0454 \u0432 \u043A\u043E\u0448\u0438\u043A\u0443.");
      const permissions = parent.capabilities;
      if (!permissions || typeof permissions !== "object" || !("canAddChildren" in permissions) || permissions.canAddChildren !== true)
        return invalid2("\u041F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0439 Google-\u0430\u043A\u0430\u0443\u043D\u0442 \u043D\u0435 \u043C\u0430\u0454 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E\u0433\u043E \u043F\u0440\u0430\u0432\u0430 \u0441\u0442\u0432\u043E\u0440\u044E\u0432\u0430\u0442\u0438 \u0432 \u0446\u0456\u0439 \u0442\u0435\u0446\u0456. \u0414\u043E\u043F\u043E\u043C\u043E\u0436\u0438 \u0432\u043B\u0430\u0441\u043D\u0438\u043A\u0443 \u043D\u0430\u0434\u0430\u0442\u0438 \u0446\u044C\u043E\u043C\u0443 \u0430\u043A\u0430\u0443\u043D\u0442\u0443 \u043F\u0440\u0430\u0432\u043E \u0434\u043E\u0434\u0430\u0432\u0430\u0442\u0438 \u0444\u0430\u0439\u043B\u0438, \u043F\u043E\u0442\u0456\u043C \u043F\u043E\u0432\u0442\u043E\u0440\u0438 \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0443.");
    } catch {
      return { ok: false, code: "unavailable", message: "\u041F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0430 Google \u043D\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0430\u0441\u044F; \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u043B\u043E\u0441\u044F. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0441\u0442\u0430\u043D \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u0442\u0430 \u043F\u043E\u0432\u0442\u043E\u0440\u0438 \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0443 \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u043E\u0457 \u0442\u0435\u043A\u0438." };
    }
    if (signal.aborted)
      return cancelled();
    let id;
    try {
      const result = await run2("files.create", { fields: "id" }, { name, mimeType: FOLDER, parents: [parentId] });
      if (result.started === false)
        return cancelled();
      const created = parsed(result);
      if (typeof created?.id === "string" && GOOGLE_FILE_ID.test(created.id))
        id = created.id;
      if (id && !signal.aborted) {
        const file2 = parsed(await run2("files.get", { fileId: id, fields: "id,name,mimeType,parents,trashed" }));
        if (!signal.aborted && file2?.id === id && file2.name === name && file2.mimeType === FOLDER && file2.trashed === false && Array.isArray(file2.parents) && file2.parents.length === 1 && file2.parents[0] === parentId) {
          return { ok: true, receiptId: id, data: JSON.stringify({ id, name, parentId, url: `https://drive.google.com/drive/folders/${id}` }) };
        }
      }
    } catch {}
    return { ok: false, code: "uncertain", message: "\u0417\u0430\u043F\u0438\u0442 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043F\u0435\u0440\u0435\u0434\u0430\u043D\u043E Google, \u0430\u043B\u0435 \u0442\u0435\u043A\u0443 \u043D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0438. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F: \u0441\u043F\u0435\u0440\u0448\u0443 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 " + (id ? `\u0442\u0435\u043A\u0443 https://drive.google.com/drive/folders/${id}` : `\u0432\u043C\u0456\u0441\u0442 \u0431\u0430\u0442\u044C\u043A\u0456\u0432\u0441\u044C\u043A\u043E\u0457 \u0442\u0435\u043A\u0438 https://drive.google.com/drive/folders/${parentId}`) + " \u0447\u0435\u0440\u0435\u0437 \u0447\u0438\u0442\u0430\u043D\u043D\u044F \u0414\u0438\u0441\u043A\u0430 \u0439 \u043F\u043E\u0432\u0456\u0434\u043E\u043C \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0435\u043D\u0438\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442." };
  }
  async upload(request, signal) {
    const args = request.arguments;
    const whole = wholeDrive(request.resource);
    const parent = args.parentId ?? (whole ? "root" : undefined);
    const nativeTypes = { doc: "application/vnd.google-apps.document", sheet: "application/vnd.google-apps.spreadsheet", slides: "application/vnd.google-apps.presentation" };
    if (Object.keys(args).some((key) => !["file", "parentId", "name", "sha256", "convertTo"].includes(key)) || args.convertTo !== undefined && (typeof args.convertTo !== "string" || !Object.hasOwn(nativeTypes, args.convertTo)) || typeof args.file !== "string" || !args.file || args.file.length > 512 || args.name != null && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 200 || /[\x00-\x1f\x7f-\x9f/]/.test(args.name)) || typeof parent !== "string" || !(GOOGLE_FILE_ID.test(parent) || whole && parent === "root") || typeof args.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.sha256)) {
      return invalid2("\u0417\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 file (\u0448\u043B\u044F\u0445 \u0443 \u0440\u043E\u0431\u043E\u0447\u0456\u0439 \u043F\u0430\u043F\u0446\u0456 \u0440\u043E\u0437\u043C\u043E\u0432\u0438) \u0456 parentId \u0442\u0435\u043A\u0438 Google \u0414\u0438\u0441\u043A\u0430" + (whole ? " (\u0430\u0431\u043E \u0431\u0435\u0437 \u043D\u044C\u043E\u0433\u043E \u2014 \u0443 \u043A\u043E\u0440\u0456\u043D\u044C \u0414\u0438\u0441\u043A\u0430)" : " \u0437 \u043D\u0430\u0434\u0430\u043D\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443") + "; name \u2014 \u043D\u0435\u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u0430 \u043D\u0430\u0437\u0432\u0430 \u0444\u0430\u0439\u043B\u0430 \u043D\u0430 \u0414\u0438\u0441\u043A\u0443.");
    }
    const account = request.resource.config.account;
    if (typeof account !== "string" || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(account) || account.length > 254) {
      return invalid2("\u0414\u043B\u044F \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u043D\u0435 \u0432\u0438\u0431\u0440\u0430\u043D\u0438\u0439 Google-\u0430\u043A\u0430\u0443\u043D\u0442. \u0414\u043E\u043F\u043E\u043C\u043E\u0436\u0438 \u0432\u043B\u0430\u0441\u043D\u0438\u043A\u0443 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0438 \u0440\u043E\u0431\u043E\u0447\u0438\u0439 Google.");
    }
    if (!whole) {
      const roots = allowedFolders(request.resource).map((folder2) => folder2.folderId);
      if (!roots.length)
        return invalid2("\u0412\u043B\u0430\u0441\u043D\u0438\u043A \u0449\u0435 \u043D\u0435 \u043D\u0430\u0434\u0430\u0432 \u0440\u043E\u0431\u043E\u0447\u0443 \u0442\u0435\u043A\u0443 Google \u0414\u0438\u0441\u043A\u0430 \u0434\u043B\u044F \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F \u0444\u0430\u0439\u043B\u0456\u0432.");
      const membership = await new DriveFolderIndex({ home: this.options.home, account, run: this.options.run }).membership(parent, roots, signal);
      if (membership === "unknown")
        return { ok: false, code: "unavailable", message: "Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432 \u0440\u043E\u0437\u0442\u0430\u0448\u0443\u0432\u0430\u043D\u043D\u044F \u0442\u0435\u043A\u0438; \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u043B\u043E\u0441\u044F." };
      if (membership !== "inside")
        return invalid2("\u0422\u0435\u043A\u0430 \u043F\u043E\u0437\u0430 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u043C \u0440\u043E\u0431\u043E\u0447\u0438\u043C \u0440\u0435\u0441\u0443\u0440\u0441\u043E\u043C; \u0444\u0430\u0439\u043B \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043E.");
    }
    const folder = join4(this.options.home, ".cache", "corporate-drive-upload", randomBytes(8).toString("hex"));
    try {
      mkdirSync2(folder, { recursive: true, mode: 448 });
      const name = typeof args.name === "string" ? args.name.trim() : basename(args.file);
      const copy = join4(folder, basename(args.file).replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(-120) || "file");
      const workspace = request.verified.workspace;
      if (streamWorkspaceFile(workspace, args.file, MAX_DRIVE_UPLOAD_BYTES, { target: copy, expected: args.sha256 }) == null) {
        return invalid2("\u0424\u0430\u0439\u043B \u0437\u043C\u0456\u043D\u0438\u0432\u0441\u044F \u043F\u0456\u0441\u043B\u044F \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F \u0430\u0431\u043E \u043D\u0435 \u043D\u0430\u043B\u0435\u0436\u0438\u0442\u044C \u0446\u0456\u0439 \u0440\u043E\u0437\u043C\u043E\u0432\u0456. \u041D\u0456\u0447\u043E\u0433\u043E \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043E; \u043F\u0456\u0434\u0433\u043E\u0442\u0443\u0439 \u043D\u043E\u0432\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F.");
      }
      if (signal.aborted)
        return { ok: false, code: "failed", message: "\u0417\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F \u0441\u043A\u0430\u0441\u043E\u0432\u0430\u043D\u043E \u0434\u043E \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0456 \u0432 Google; \u0444\u0430\u0439\u043B \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043E." };
      const result = await this.options.run({
        argv: [
          join4(this.options.home, "bin/gog"),
          "--no-input",
          "--json",
          "--enable-commands-exact=drive.upload",
          "drive",
          "upload",
          copy,
          "--parent",
          parent,
          "--name",
          name,
          ...args.convertTo === undefined ? [] : [`--convert-to=${args.convertTo}`]
        ],
        cwd: this.options.home,
        env: { HOME: this.options.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
        timeoutMs: 900000
      }, signal);
      if (result.started === false)
        return { ok: false, code: "failed", message: "\u0417\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F \u0441\u043A\u0430\u0441\u043E\u0432\u0430\u043D\u043E \u0434\u043E \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0456 \u0432 Google; \u0444\u0430\u0439\u043B \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043E." };
      const created = parsed(result);
      const id = typeof created?.id === "string" ? created.id : typeof created?.file?.id === "string" ? created.file.id : null;
      if (id != null && GOOGLE_FILE_ID.test(id)) {
        const file2 = created?.file != null && typeof created.file === "object" ? created.file : created;
        if (args.convertTo !== undefined && file2?.mimeType !== nativeTypes[String(args.convertTo)]) {
          return { ok: false, code: "uncertain", receiptId: id, message: "\u0424\u0430\u0439\u043B \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u0438\u0439, \u0430\u043B\u0435 \u043F\u0435\u0440\u0435\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043D\u0430 \u0444\u043E\u0440\u043C\u0430\u0442 Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0446\u0435\u0439 \u0444\u0430\u0439\u043B, \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0443\u0439 \u0439\u043E\u0433\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E." };
        }
        return { ok: true, receiptId: id, data: JSON.stringify({
          id,
          name,
          parentId: parent,
          ...args.convertTo === undefined ? {} : { convertedTo: args.convertTo, mimeType: file2?.mimeType },
          url: `https://drive.google.com/file/d/${id}/view`
        }) };
      }
      return { ok: false, code: "uncertain", message: "Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0439\u043E\u0433\u043E \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E: \u0441\u043F\u0435\u0440\u0448\u0443 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u0442\u0435\u043A\u0443 " + (parent === "root" ? "\u0432 \u043A\u043E\u0440\u0435\u043D\u0456 \u0414\u0438\u0441\u043A\u0430" : `https://drive.google.com/drive/folders/${parent}`) + " \u0447\u0435\u0440\u0435\u0437 \u043F\u043E\u0448\u0443\u043A \u0414\u0438\u0441\u043A\u0430." };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

// modules/telegram-corporate/adapters/slides-edit.ts
var object = (v) => v != null && typeof v === "object" && !Array.isArray(v);
var id = (v) => typeof v === "string" && /^[A-Za-z0-9_][A-Za-z0-9_:-]{0,255}$/.test(v);
var newId = (v) => id(v) && v.length >= 5 && v.length <= 50;
var text2 = (v, max) => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
var number = (v, low, high) => typeof v === "number" && Number.isFinite(v) && v >= low && v <= high;
var keys = (v, allowed) => Object.keys(v).every((key) => allowed.includes(key));
function slideEdits(presentation, changes) {
  if (!object(presentation))
    return null;
  const slides = presentation.slides === undefined ? [] : presentation.slides;
  if (!Array.isArray(slides) || slides.length > 500 || !Array.isArray(changes) || changes.length === 0 || changes.length > 100 || JSON.stringify(changes).length > 1e5)
    return null;
  const objects = new Map;
  const pages = [];
  const collect = (items, page, depth = 0) => {
    if (items == null)
      return true;
    if (!Array.isArray(items) || items.length > 1000 || depth > 6 || objects.size > 5000)
      return false;
    for (const item of items) {
      if (!object(item) || !id(item.objectId) || objects.has(item.objectId))
        return false;
      objects.set(item.objectId, { kind: item.shape != null ? "shape" : "element", page });
      if (object(item.elementGroup) && !collect(item.elementGroup.children, page, depth + 1))
        return false;
    }
    return true;
  };
  for (const page of slides) {
    if (!object(page) || !id(page.objectId) || objects.has(page.objectId))
      return null;
    objects.set(page.objectId, { kind: "slide", page: page.objectId });
    pages.push(page.objectId);
    if (!collect(page.pageElements, page.objectId))
      return null;
  }
  const requests = [];
  for (const change of changes) {
    if (!object(change) || typeof change.type !== "string")
      return null;
    const target = id(change.objectId) ? objects.get(change.objectId) : undefined;
    switch (change.type) {
      case "text": {
        if (!keys(change, ["type", "objectId", "text"]) || target?.kind !== "shape" || !text2(change.text, 20000))
          return null;
        requests.push({ deleteText: { objectId: change.objectId, textRange: { type: "ALL" } } });
        if (change.text !== "")
          requests.push({ insertText: { objectId: change.objectId, insertionIndex: 0, text: change.text } });
        break;
      }
      case "replace_text": {
        if (!keys(change, ["type", "find", "text", "matchCase", "slideIds"]) || !text2(change.find, 1000) || !change.find || !text2(change.text, 20000) || change.matchCase !== undefined && typeof change.matchCase !== "boolean" || !Array.isArray(change.slideIds) || change.slideIds.length === 0 || change.slideIds.length > 100 || change.slideIds.some((value) => !id(value) || objects.get(value)?.kind !== "slide"))
          return null;
        requests.push({ replaceAllText: {
          containsText: { text: change.find, matchCase: change.matchCase === true },
          replaceText: change.text,
          pageObjectIds: change.slideIds
        } });
        break;
      }
      case "style": {
        if (!keys(change, ["type", "objectId", "fontSize", "fontFamily", "bold", "italic", "underline", "color"]) || target?.kind !== "shape")
          return null;
        const style = {};
        if (change.fontSize !== undefined) {
          if (!number(change.fontSize, 1, 400))
            return null;
          style.fontSize = { magnitude: change.fontSize, unit: "PT" };
        }
        if (change.fontFamily !== undefined) {
          if (!text2(change.fontFamily, 100) || !change.fontFamily.trim() || /[\r\n]/.test(change.fontFamily))
            return null;
          style.fontFamily = change.fontFamily;
        }
        for (const field of ["bold", "italic", "underline"])
          if (change[field] !== undefined) {
            if (typeof change[field] !== "boolean")
              return null;
            style[field] = change[field];
          }
        if (change.color !== undefined) {
          if (typeof change.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(change.color))
            return null;
          const rgb = [1, 3, 5].map((start) => parseInt(change.color.slice(start, start + 2), 16) / 255);
          style.foregroundColor = { opaqueColor: { rgbColor: { red: rgb[0], green: rgb[1], blue: rgb[2] } } };
        }
        if (!Object.keys(style).length)
          return null;
        requests.push({ updateTextStyle: { objectId: change.objectId, textRange: { type: "ALL" }, style, fields: Object.keys(style).join(",") } });
        break;
      }
      case "transform": {
        if (!keys(change, ["type", "objectId", "xPt", "yPt", "scaleX", "scaleY"]) || target == null || target.kind === "slide" || !number(change.xPt, -2000, 2000) || !number(change.yPt, -2000, 2000) || !number(change.scaleX, 0.01, 100) || !number(change.scaleY, 0.01, 100))
          return null;
        requests.push({ updatePageElementTransform: { objectId: change.objectId, applyMode: "ABSOLUTE", transform: {
          scaleX: change.scaleX,
          scaleY: change.scaleY,
          shearX: 0,
          shearY: 0,
          translateX: change.xPt,
          translateY: change.yPt,
          unit: "PT"
        } } });
        break;
      }
      case "add_slide": {
        if (!keys(change, ["type", "objectId", "index", "layout"]) || !newId(change.objectId) || objects.has(change.objectId) || !Number.isInteger(change.index) || !number(change.index, 0, pages.length) || typeof change.layout !== "string" || !["BLANK", "TITLE", "TITLE_AND_BODY", "TITLE_ONLY", "SECTION_HEADER", "SECTION_TITLE_AND_DESCRIPTION", "ONE_COLUMN_TEXT", "CAPTION_ONLY"].includes(change.layout))
          return null;
        requests.push({ createSlide: { objectId: change.objectId, insertionIndex: change.index, slideLayoutReference: { predefinedLayout: change.layout } } });
        objects.set(change.objectId, { kind: "slide", page: change.objectId });
        pages.splice(Number(change.index), 0, change.objectId);
        break;
      }
      case "add_text": {
        if (!keys(change, ["type", "objectId", "slideId", "text", "xPt", "yPt", "widthPt", "heightPt"]) || !newId(change.objectId) || objects.has(change.objectId) || !id(change.slideId) || objects.get(change.slideId)?.kind !== "slide" || !text2(change.text, 20000) || !change.text || !number(change.xPt, -2000, 2000) || !number(change.yPt, -2000, 2000) || !number(change.widthPt, 1, 2000) || !number(change.heightPt, 1, 2000))
          return null;
        requests.push({ createShape: { objectId: change.objectId, shapeType: "TEXT_BOX", elementProperties: {
          pageObjectId: change.slideId,
          size: { width: { magnitude: change.widthPt, unit: "PT" }, height: { magnitude: change.heightPt, unit: "PT" } },
          transform: { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: change.xPt, translateY: change.yPt, unit: "PT" }
        } } }, { insertText: { objectId: change.objectId, insertionIndex: 0, text: change.text } });
        objects.set(change.objectId, { kind: "shape", page: change.slideId });
        break;
      }
      case "delete": {
        if (!keys(change, ["type", "objectId"]) || target == null)
          return null;
        requests.push({ deleteObject: { objectId: change.objectId } });
        objects.delete(String(change.objectId));
        if (target.kind === "slide") {
          pages.splice(pages.indexOf(String(change.objectId)), 1);
          for (const [key, value] of objects)
            if (value.page === change.objectId)
              objects.delete(key);
        }
        break;
      }
      default:
        return null;
    }
  }
  return requests.length > 0 && requests.length <= 200 ? requests : null;
}

// modules/telegram-corporate/adapters/slides.ts
var SHARE_EMAIL = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
function exactKeys2(args, keys2) {
  return Object.keys(args).length === keys2.length && keys2.every((key) => Object.hasOwn(args, key));
}
function text3(value, max) {
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
  authorizePresentation;
  constructor(options) {
    this.home = options.home;
    this.run = options.run ?? runBoundedCommand;
    this.authorizePresentation = options.authorizePresentation;
    this.createdSlideIds = options.createdSlideIds ?? ((resourceId) => {
      let db;
      try {
        db = new Database4(join5(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
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
    if (request.resource.connector !== "google" || !text3(account, 254) || !account.includes("@")) {
      return { ok: false, code: "invalid" };
    }
    if (request.capability === "google.slides.read" && request.operation === "get") {
      return this.get(request, account, signal);
    }
    if (request.capability === "google.slides.write" && request.operation === "create") {
      return this.create(request, account, signal);
    }
    if (request.capability === "google.slides.write" && request.operation === "insert_image") {
      return this.insertImage(request, account, signal);
    }
    if (request.capability === "google.slides.write" && request.operation === "edit")
      return this.edit(request, account, signal);
    return { ok: false, code: "invalid", message: "\u0414\u043B\u044F Slides \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0456 \u043B\u0438\u0448\u0435 get(presentationId, slideId?) \u0442\u0430 create(title, markdown)." };
  }
  async edit(request, account, signal) {
    const { presentationId, changes } = request.arguments;
    if (!exactKeys2(request.arguments, ["presentationId", "changes"]) || typeof presentationId !== "string" || !GOOGLE_FILE_ID.test(presentationId) || !Array.isArray(changes) || !changes.length || changes.length > 100 || JSON.stringify(changes).length > 1e5) {
      return { ok: false, code: "invalid", message: "\u0420\u0435\u0434\u0430\u0433\u0443\u0432\u0430\u043D\u043D\u044F \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 presentationId \u0456 changes (1\u2013100): text, replace_text, style, transform, add_slide, add_text \u0430\u0431\u043E delete." };
    }
    const denial = await this.presentationDenial(request, presentationId, account, signal);
    if (denial != null)
      return denial;
    if (signal.aborted)
      return { ok: false, code: "unavailable" };
    const command = (method, body) => ({
      argv: [
        join5(this.home, "bin/gog"),
        "--no-input",
        "--json",
        ...body == null ? ["--readonly"] : [],
        `--enable-commands-exact=api.call,api.slides.${method.toLowerCase()}`,
        "api",
        "call",
        "slides",
        "v1",
        method,
        "--params",
        JSON.stringify({ presentationId, ...body == null ? { fields: "presentationId,revisionId,slides(objectId,pageElements(objectId,shape,image,elementGroup))" } : {} }),
        "--scope",
        "https://www.googleapis.com/auth/presentations",
        ...body == null ? [] : ["--body", "@/dev/stdin", "--allow-write", "--force"]
      ],
      cwd: this.home,
      env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 60000,
      ...body == null ? {} : { stdin: JSON.stringify(body) }
    });
    let requests, revision;
    try {
      const result = await this.run(command("presentations.get"), signal);
      if (result.exitCode !== 0 || result.stdoutTruncated)
        return { ok: false, code: "unavailable" };
      const before = JSON.parse(result.stdout);
      if (before?.presentationId !== presentationId || typeof before.revisionId !== "string" || !before.revisionId || before.revisionId.length > 1000)
        return { ok: false, code: "unavailable" };
      const compiled = slideEdits(before, changes);
      if (compiled == null)
        return { ok: false, code: "invalid", message: "\u041D\u0435\u043F\u0456\u0434\u0442\u0440\u0438\u043C\u0430\u043D\u0430 \u0437\u043C\u0456\u043D\u0430 \u0430\u0431\u043E \u0435\u043B\u0435\u043C\u0435\u043D\u0442 \u043D\u0435 \u043D\u0430\u043B\u0435\u0436\u0438\u0442\u044C \u0446\u0456\u0439 \u043F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u0457. \u0421\u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0438\u0439 \u0441\u043B\u0430\u0439\u0434; \u0436\u043E\u0434\u043D\u0438\u0445 \u0437\u043C\u0456\u043D \u043D\u0435 \u0432\u043D\u0435\u0441\u0435\u043D\u043E." };
      requests = compiled;
      revision = before.revisionId;
    } catch {
      return { ok: false, code: "unavailable" };
    }
    if (signal.aborted)
      return { ok: false, code: "unavailable" };
    const uncertain = () => ({
      ok: false,
      code: "uncertain",
      receiptId: presentationId,
      message: "\u0420\u0435\u0434\u0430\u0433\u0443\u0432\u0430\u043D\u043D\u044F \u0441\u043B\u0430\u0439\u0434\u0456\u0432 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0446\u044E \u043F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u044E \u043F\u0435\u0440\u0435\u0434 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E\u044E \u0434\u0456\u0454\u044E; \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E\u0433\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0443 \u043D\u0435\u043C\u0430\u0454."
    });
    try {
      const result = await this.run(command("presentations.batchUpdate", { requests, writeControl: { requiredRevisionId: revision } }), signal);
      if (result.started === false)
        return { ok: false, code: "failed", message: "\u0420\u0435\u0434\u0430\u0433\u0443\u0432\u0430\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0430\u043B\u043E\u0441\u044F." };
      if (result.exitCode !== 0 || result.stdoutTruncated)
        return uncertain();
      const receipt = JSON.parse(result.stdout);
      if (receipt?.presentationId !== presentationId || !Array.isArray(receipt.replies) || receipt.replies.length !== requests.length || receipt.error !== undefined || receipt.dry_run === true || receipt.queued === true)
        return uncertain();
      return { ok: true, receiptId: presentationId, data: JSON.stringify({
        presentationId,
        changes: changes.length,
        requests: requests.length,
        presentationUrl: `https://docs.google.com/presentation/d/${presentationId}/edit`
      }) };
    } catch {
      return uncertain();
    }
  }
  async insertImage(request, account, signal) {
    const args = request.arguments;
    const { presentationId, slideId, imageUrl, widthPt, heightPt, xPt = 0, yPt = 0 } = args;
    const uri = publicImageUrl(imageUrl);
    if (Object.keys(args).some((key) => !["presentationId", "slideId", "imageUrl", "widthPt", "heightPt", "xPt", "yPt"].includes(key)) || typeof presentationId !== "string" || !GOOGLE_FILE_ID.test(presentationId) || typeof slideId !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_:-]{0,255}$/.test(slideId) || uri == null || ![widthPt, heightPt].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 2000) || ![xPt, yPt].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2000)) {
      return { ok: false, code: "invalid", message: "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 presentationId, slideId, imageUrl \u043F\u0443\u0431\u043B\u0456\u0447\u043D\u043E\u0433\u043E HTTPS-\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u043D\u044F, widthPt \u0456 heightPt. \u041F\u0440\u0438\u0432\u0430\u0442\u043D\u0438\u0439 \u0444\u0430\u0439\u043B \u0441\u0430\u043C \u043D\u0435 \u043F\u0443\u0431\u043B\u0456\u043A\u0443\u044E." };
    }
    const denial = await this.presentationDenial(request, presentationId, account, signal);
    if (denial != null)
      return denial;
    if (signal.aborted)
      return { ok: false, code: "unavailable" };
    const uncertain = () => ({ ok: false, code: "uncertain", message: "\u0412\u0441\u0442\u0430\u0432\u043A\u0430 \u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0430. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0446\u0435\u0439 \u0436\u0435 \u0441\u043B\u0430\u0439\u0434; \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0432\u0430\u0442\u0438 \u0432\u0441\u0442\u0430\u0432\u043A\u0443 \u043D\u0435 \u043C\u043E\u0436\u043D\u0430." });
    try {
      const result = await this.run(this.command(account, "slides.insert-image", [
        presentationId,
        slideId,
        `--url=${uri}`,
        `--width=${widthPt}`,
        `--height=${heightPt}`,
        `--x=${xPt}`,
        `--y=${yPt}`,
        "--unit=PT"
      ]), signal);
      if (result.exitCode !== 0)
        return disabledApi(result.stderr) ?? uncertain();
      const receipt = JSON.parse(result.stdout);
      if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt) || receipt.presentationId !== presentationId || receipt.slideObjectId !== slideId || typeof receipt.imageObjectId !== "string" || !/^img_\d+$/.test(receipt.imageObjectId) || receipt.dry_run === true || receipt.queued === true || Object.hasOwn(receipt, "error"))
        return uncertain();
      return {
        ok: true,
        receiptId: receipt.imageObjectId,
        data: JSON.stringify({
          presentationId,
          slideId,
          imageObjectId: receipt.imageObjectId,
          presentationUrl: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          imageInserted: true
        })
      };
    } catch {
      return uncertain();
    }
  }
  command(account, command, args, readonly = false) {
    return {
      argv: [
        join5(this.home, "bin", "gog"),
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
    const id2 = request.arguments.presentationId;
    const hasSlide = Object.hasOwn(request.arguments, "slideId");
    const slideId = request.arguments.slideId;
    if (!exactKeys2(request.arguments, hasSlide ? ["presentationId", "slideId"] : ["presentationId"]) || typeof id2 !== "string" || !GOOGLE_FILE_ID.test(id2) || hasSlide && (typeof slideId !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_:-]{0,255}$/.test(slideId))) {
      return { ok: false, code: "invalid", message: "\u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D presentationId; \u0434\u043E\u0434\u0430\u0439 slideId \u0437\u0456 \u0441\u043F\u0438\u0441\u043A\u0443 \u0441\u043B\u0430\u0439\u0434\u0456\u0432, \u0449\u043E\u0431 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u0438 \u0439\u043E\u0433\u043E \u0442\u0435\u043A\u0441\u0442." };
    }
    const denial = await this.presentationDenial(request, id2, account, signal);
    if (denial != null)
      return denial;
    try {
      const command = hasSlide ? this.command(account, "slides.read-slide", [id2, slideId], true) : this.command(account, "slides.list-slides", [id2], true);
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
  async presentationDenial(request, id2, account, signal) {
    if (this.authorizePresentation) {
      try {
        const denial = await this.authorizePresentation(request, id2, account, signal);
        return denial == null ? null : { ok: false, code: "invalid", message: denial };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    }
    let created = [];
    try {
      created = this.createdSlideIds(request.resource.id);
    } catch {}
    return Object.hasOwn(request.resource.config, `slide.${id2}`) || Object.hasOwn(request.resource.config, `file.${id2}`) || created.some((value) => GOOGLE_FILE_ID.test(value) && value === id2) ? null : { ok: false, code: "invalid", message: "\u041F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u044F \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u044F\u0432\u043D\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 \u0444\u0430\u0439\u043B\u0456\u0432 \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443." };
  }
  async createInFolder(title, markdown, parentId, account, signal) {
    const sections = markdown.split(/^\s*---+\s*$/m).map((value) => value.trim()).filter(Boolean);
    if (sections.length === 0 || sections.length > 50)
      return { ok: false, code: "invalid", message: "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u043E \u0432\u0456\u0434 1 \u0434\u043E 50 \u0441\u043B\u0430\u0439\u0434\u0456\u0432, \u0440\u043E\u0437\u0434\u0456\u043B\u0435\u043D\u0438\u0445 ---." };
    let receipt;
    let launched = false;
    const uncertain = () => ({ ...uncertainCreation(), ...receipt ? { receiptId: receipt } : {} });
    const api = (service, method, params, body) => this.run({
      argv: [
        join5(this.home, "bin/gog"),
        "--no-input",
        "--json",
        ...body == null ? ["--readonly"] : [],
        `--enable-commands-exact=api.call,api.${service}.${method.toLowerCase()}`,
        "api",
        "call",
        service,
        service === "drive" ? "v3" : "v1",
        method,
        "--params",
        JSON.stringify(params),
        "--scope",
        service === "drive" ? "https://www.googleapis.com/auth/drive" : "https://www.googleapis.com/auth/presentations",
        ...body == null ? [] : ["--body", "@/dev/stdin", "--allow-write", "--force"]
      ],
      cwd: this.home,
      env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 60000,
      ...body == null ? {} : { stdin: JSON.stringify(body) }
    }, signal);
    const decode = (result) => {
      if (result.exitCode !== 0 || result.stdoutTruncated)
        throw new Error("incomplete provider response");
      return JSON.parse(result.stdout);
    };
    try {
      if (signal.aborted)
        return { ok: false, code: "unavailable" };
      launched = true;
      const result = await api("drive", "files.create", { fields: "id", supportsAllDrives: true }, { name: title, mimeType: "application/vnd.google-apps.presentation", parents: [parentId] });
      if (result.started === false)
        return { ok: false, code: "unavailable" };
      const created = decode(result);
      if (typeof created?.id !== "string" || !GOOGLE_FILE_ID.test(created.id))
        return uncertain();
      receipt = created.id;
      if (!await nativeParentReadback({ home: this.home, run: this.run }, account, receipt, parentId, signal))
        return uncertain();
      const before = decode(await api("slides", "presentations.get", { presentationId: receipt, fields: "presentationId,slides(objectId)" }));
      if (before?.presentationId !== receipt || before.slides != null && !Array.isArray(before.slides))
        return uncertain();
      const requests = [];
      for (const slide of before.slides ?? []) {
        if (typeof slide?.objectId !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_:-]{0,255}$/.test(slide.objectId))
          return uncertain();
        requests.push({ deleteObject: { objectId: slide.objectId } });
      }
      const expected = sections.map((section, index) => {
        const id2 = "corp_" + randomBytes2(10).toString("hex");
        const lines = section.split(`
`);
        const heading = /^#{1,6}\s+/.test(lines[0]) ? lines.shift().replace(/^#{1,6}\s+/, "") : `${title} \u2014 ${index + 1}`;
        const body = lines.join(`
`).trim() || heading;
        requests.push({ createSlide: { objectId: id2, slideLayoutReference: { predefinedLayout: "BLANK" } } });
        for (const [suffix, text4, y, height, size] of [["title", heading, 25, 55, 26], ["body", body, 100, 270, 16]]) {
          const objectId = id2 + "_" + suffix;
          requests.push({ createShape: { objectId, shapeType: "TEXT_BOX", elementProperties: {
            pageObjectId: id2,
            size: { width: { magnitude: 640, unit: "PT" }, height: { magnitude: height, unit: "PT" } },
            transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: y, unit: "PT" }
          } } }, { insertText: { objectId, text: text4 } }, { updateTextStyle: {
            objectId,
            textRange: { type: "ALL" },
            style: { fontSize: { magnitude: size, unit: "PT" }, ...suffix === "title" ? { bold: true } : {} },
            fields: suffix === "title" ? "fontSize,bold" : "fontSize"
          } });
        }
        return id2;
      });
      if (signal.aborted)
        return uncertain();
      const populated = decode(await api("slides", "presentations.batchUpdate", { presentationId: receipt }, { requests }));
      if (populated?.presentationId !== receipt || !Array.isArray(populated.replies) || populated.replies.length !== requests.length)
        return uncertain();
      const after = decode(await api("slides", "presentations.get", { presentationId: receipt, fields: "presentationId,slides(objectId)" }));
      if (after?.presentationId !== receipt || !Array.isArray(after.slides) || after.slides.length !== expected.length || after.slides.some((slide, index) => slide?.objectId !== expected[index]))
        return uncertain();
      return { ok: true, receiptId: receipt, data: "{}" };
    } catch {
      return launched ? uncertain() : { ok: false, code: "unavailable" };
    }
  }
  async create(request, account, signal) {
    const { title, markdown } = request.arguments;
    if (!exactKeys2(request.arguments, ["title", "markdown", ...Object.hasOwn(request.arguments, "parentId") ? ["parentId"] : []]) || !text3(title, 512) || !textMarkdown(markdown)) {
      return { ok: false, code: "invalid", message: "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 title (\u0434\u043E 512 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432) \u0442\u0430 \u0442\u0435\u043A\u0441\u0442\u043E\u0432\u0438\u0439 markdown (\u0434\u043E 10000 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432), \u0431\u0435\u0437 \u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u044C, HTML, \u0456\u043A\u043E\u043D\u043E\u043A \u0447\u0438 Mermaid. \u0406\u043D\u0448\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u0437\u0430\u0431\u043E\u0440\u043E\u043D\u0435\u043D\u0456." };
    }
    const creation = await nativeCreationParent({ home: this.home, run: this.run }, request, signal);
    if (!creation.ok)
      return creation.result;
    const recipient = request.resource.config.createShareEmail;
    if (recipient !== undefined && (!text3(recipient, 254) || recipient.indexOf("@") > 64 || !SHARE_EMAIL.test(recipient))) {
      return { ok: false, code: "invalid", message: "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 createShareEmail \u0443 \u0434\u043E\u0432\u0456\u0440\u0435\u043D\u0438\u0445 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F\u0445 \u0440\u0435\u0441\u0443\u0440\u0441\u0443. \u041F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0446\u0456\u044E \u043D\u0435 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043E." };
    }
    let directory2;
    let launched = false;
    try {
      let receipt;
      if (creation.parentId != null) {
        const made = await this.createInFolder(title, markdown, creation.parentId, account, signal);
        if (!made.ok)
          return made;
        receipt = made.receiptId;
      } else {
        directory2 = await mkdtemp(join5(tmpdir(), "corporate-slides-"));
        const input = join5(directory2, "deck.md");
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
        const parsed2 = JSON.parse(result.stdout);
        const ids = [parsed2.presentationId, parsed2.id, parsed2.presentation?.presentationId, parsed2.file?.id].filter((value) => value !== undefined);
        if (result.stdoutTruncated || ids.length === 0 || !ids.every((value) => typeof value === "string" && GOOGLE_FILE_ID.test(value)) || new Set(ids).size !== 1)
          return uncertainCreation();
        receipt = ids[0];
      }
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
      if (directory2 != null)
        await rm(directory2, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// modules/telegram-corporate/adapters/docs-write.ts
import { join as join6 } from "path";
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
    if (request.resource.connector !== "google" || request.capability !== "google.docs.write" || !["append", "insert_image", "update"].includes(request.operation) || typeof account !== "string" || account.length > 254 || account.startsWith("-") || !/^[^\s@]+@[^\s@]+$/.test(account)) {
      return { ok: false, code: "invalid" };
    }
    if (request.operation === "insert_image")
      return this.insertImage(request, account, signal);
    if (request.operation === "update")
      return this.update(request, account, signal);
    const { docId } = request.arguments;
    const field = Object.hasOwn(request.arguments, "text") ? "text" : "content";
    const text4 = request.arguments[field];
    if (Object.keys(request.arguments).length !== 2 || !Object.hasOwn(request.arguments, "docId") || !Object.hasOwn(request.arguments, field) || typeof docId !== "string" || !GOOGLE_FILE_ID.test(docId) || docId.startsWith("-") || typeof text4 !== "string" || text4.trim().length === 0 || text4.length > (field === "content" ? 1e5 : 1e4) || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text4)) {
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
          join6(this.home, "bin", "gog"),
          "--no-input",
          "--json",
          "--enable-commands-exact=docs.write",
          "docs",
          "write",
          docId,
          "--append",
          ...field === "content" ? ["--file", "-"] : [`--text=${text4}`]
        ],
        cwd: this.home,
        env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
        timeoutMs: 60000,
        ...field === "content" ? { stdin: text4 } : {}
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
  async update(request, account, signal) {
    const args = request.arguments;
    const { docId, text: text4, index, replaceRange, at, occurrence, matchCase, markdown } = args;
    const range = typeof replaceRange === "string" && /^(\d{1,8}):(\d{1,8})$/.exec(replaceRange);
    const bounded2 = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
    const validInt = (value, max) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max;
    if (Object.keys(args).some((key) => !["docId", "text", "index", "replaceRange", "at", "occurrence", "matchCase", "markdown"].includes(key)) || typeof docId !== "string" || !GOOGLE_FILE_ID.test(docId) || !bounded2(text4, 1e5) || [index, replaceRange, at].filter((value) => value !== undefined).length > 1 || index !== undefined && !validInt(index, 1e7) || replaceRange !== undefined && (!range || !validInt(Number(range[1]), 1e7) || Number(range[2]) <= Number(range[1]) || Number(range[2]) > 1e7) || at !== undefined && !bounded2(at, 1e4) || occurrence !== undefined && (at === undefined || !validInt(occurrence, 1e4)) || matchCase !== undefined && (at === undefined || typeof matchCase !== "boolean") || markdown !== undefined && typeof markdown !== "boolean" || markdown === true && /!\s*\[|<|(?:^|\n)\s*(?:`{3,}|~{3,})\s*mermaid\b/i.test(String(text4))) {
      return { ok: false, code: "invalid", message: "\u041E\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F: docId, text \u0442\u0430 \u043D\u0435 \u0431\u0456\u043B\u044C\u0448\u0435 \u043E\u0434\u043D\u043E\u0433\u043E \u043C\u0456\u0441\u0446\u044F \u2014 index, replaceRange START:END \u0430\u0431\u043E at (\u0442\u043E\u0447\u043D\u0438\u0439 \u0442\u0435\u043A\u0441\u0442). \u0414\u043B\u044F at \u043C\u043E\u0436\u043B\u0438\u0432\u0456 occurrence \u0456 matchCase; markdown \u2014 \u0444\u043E\u0440\u043C\u0430\u0442\u0443\u0432\u0430\u043D\u043D\u044F \u0442\u0435\u043A\u0441\u0442\u0443. \u0417\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u043D\u044F \u0434\u043E\u0434\u0430\u0432\u0430\u0439 \u043E\u043A\u0440\u0435\u043C\u043E\u044E insert_image." };
    }
    if (request.resource.config.docsAppendOnly === true)
      return { ok: false, code: "invalid", message: "\u0414\u043B\u044F \u0446\u044C\u043E\u0433\u043E \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E \u043B\u0438\u0448\u0435 \u0434\u043E\u043F\u0438\u0441\u0443\u0432\u0430\u043D\u043D\u044F." };
    try {
      if (this.authorizeFile) {
        const denial = await this.authorizeFile(request, account, signal);
        if (denial != null)
          return { ok: false, code: "invalid", message: denial };
      } else if (!Object.hasOwn(request.resource.config, `doc.${docId}`) && !this.createdDocumentIds(request.resource.id).includes(docId)) {
        return { ok: false, code: "invalid", message: "\u0426\u0435\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u043D\u0430\u0434\u0430\u043D\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443." };
      }
    } catch {
      return { ok: false, code: "unavailable" };
    }
    if (signal.aborted)
      return { ok: false, code: "unavailable" };
    const uncertain = () => ({
      ok: false,
      code: "uncertain",
      receiptId: docId,
      message: "\u0420\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0440\u0435\u0434\u0430\u0433\u0443\u0432\u0430\u043D\u043D\u044F \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0446\u0435\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u043F\u0435\u0440\u0435\u0434 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u044E \u0434\u0456\u0454\u044E; \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0432\u0430\u0442\u0438 \u0432\u0441\u0442\u0430\u0432\u043A\u0443 \u043D\u0435 \u043C\u043E\u0436\u043D\u0430."
    });
    try {
      const result = await this.run({
        argv: [
          join6(this.home, "bin/gog"),
          "--no-input",
          "--json",
          "--enable-commands-exact=docs.update",
          "docs",
          "update",
          docId,
          "--file",
          "-",
          ...index === undefined ? [] : [`--index=${index}`],
          ...replaceRange === undefined ? [] : [`--replace-range=${replaceRange}`],
          ...at === undefined ? [] : [`--at=${at}`],
          ...occurrence === undefined ? [] : [`--occurrence=${occurrence}`],
          ...matchCase === true ? ["--match-case"] : [],
          ...markdown === true ? ["--markdown"] : []
        ],
        cwd: this.home,
        env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
        timeoutMs: 60000,
        stdin: text4
      }, signal);
      if (result.started === false)
        return { ok: false, code: "failed", message: "\u0420\u0435\u0434\u0430\u0433\u0443\u0432\u0430\u043D\u043D\u044F \u043D\u0435 \u043F\u043E\u0447\u0430\u043B\u043E\u0441\u044F." };
      if (result.exitCode !== 0 || result.stdoutTruncated)
        return uncertain();
      const receipt = JSON.parse(result.stdout);
      const replacing = at !== undefined || replaceRange !== undefined;
      if (!receipt || receipt.documentId !== docId || !validInt(receipt.requests, 1e4) || !validInt(receipt.index, 1e7) || receipt.dry_run === true || receipt.queued === true || receipt.error !== undefined || index !== undefined && receipt.index !== index || replacing && (receipt.replaced !== true || !validInt(receipt.replaceRange?.start, 1e7) || !validInt(receipt.replaceRange?.end, 1e7) || receipt.replaceRange.end <= receipt.replaceRange.start) || range && (receipt.replaceRange?.start !== Number(range[1]) || receipt.replaceRange?.end !== Number(range[2])) || markdown === true !== (receipt.markdown === true))
        return uncertain();
      return { ok: true, receiptId: docId, data: JSON.stringify({
        documentId: docId,
        index: receipt.index,
        requests: receipt.requests,
        replaced: replacing,
        markdown: markdown === true,
        documentUrl: `https://docs.google.com/document/d/${docId}/edit`
      }) };
    } catch {
      return uncertain();
    }
  }
  async insertImage(request, account, signal) {
    const args = request.arguments;
    const { docId, imageUrl, widthPt, heightPt } = args;
    const uri = publicImageUrl(imageUrl);
    if (Object.keys(args).some((key) => !["docId", "imageUrl", "widthPt", "heightPt"].includes(key)) || typeof docId !== "string" || !GOOGLE_FILE_ID.test(docId) || docId.startsWith("-") || uri == null || widthPt !== undefined && (typeof widthPt !== "number" || !Number.isFinite(widthPt) || widthPt <= 0 || widthPt > 1200) || heightPt !== undefined && (typeof heightPt !== "number" || !Number.isFinite(heightPt) || heightPt <= 0 || heightPt > 1200)) {
      return { ok: false, code: "invalid", message: "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 docId \u0442\u0430 imageUrl \u0432\u0436\u0435 \u043F\u0443\u0431\u043B\u0456\u0447\u043D\u043E\u0433\u043E HTTPS-\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u043D\u044F. widthPt/heightPt \u2014 \u0432\u0456\u0434 0 \u0434\u043E 1200 \u043F\u0443\u043D\u043A\u0442\u0456\u0432. \u041F\u0440\u0438\u0432\u0430\u0442\u043D\u0438\u0439 \u0444\u0430\u0439\u043B \u0441\u0430\u043C \u043D\u0435 \u043F\u0443\u0431\u043B\u0456\u043A\u0443\u044E." };
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
      return { ok: false, code: "invalid", message: "\u0414\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445 \u0444\u0430\u0439\u043B\u0456\u0432 \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443." };
    }
    if (signal.aborted)
      return { ok: false, code: "unavailable" };
    const uncertain = () => ({ ok: false, code: "uncertain", message: "\u0412\u0441\u0442\u0430\u0432\u043A\u0430 \u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u043D\u044F \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0430. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u043A\u0456\u043D\u0435\u0446\u044C \u0446\u044C\u043E\u0433\u043E \u0436 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430; \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0432\u0430\u0442\u0438 \u0432\u0441\u0442\u0430\u0432\u043A\u0443 \u043D\u0435 \u043C\u043E\u0436\u043D\u0430." });
    try {
      const result = await this.run({
        argv: [
          join6(this.home, "bin", "gog"),
          "--no-input",
          "--json",
          "--enable-commands-exact=docs.insert-image",
          "docs",
          "insert-image",
          docId,
          `--url=${uri}`,
          "--at=end",
          `--width=${widthPt ?? 468}`,
          ...heightPt === undefined ? [] : [`--height=${heightPt}`]
        ],
        cwd: this.home,
        env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
        timeoutMs: 60000
      }, signal);
      if (result.exitCode !== 0)
        return uncertain();
      const receipt = JSON.parse(result.stdout);
      if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt) || receipt.documentId !== docId || receipt.url !== uri || receipt.requests !== 1 || !Number.isSafeInteger(receipt.atIndex) || receipt.atIndex < 1 || receipt.dry_run === true || receipt.queued === true || receipt.fallbackLink === true || Object.hasOwn(receipt, "error") || Object.hasOwn(receipt, "uploadedFileId"))
        return uncertain();
      return {
        ok: true,
        receiptId: docId,
        data: JSON.stringify({
          documentId: docId,
          documentUrl: `https://docs.google.com/document/d/${docId}/edit`,
          imageInserted: true,
          atIndex: receipt.atIndex
        })
      };
    } catch {
      return uncertain();
    }
  }
}

// modules/telegram-corporate/adapters/sheets-batch.ts
var record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var object2 = (fields, required = []) => (value) => record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => Object.hasOwn(fields, key) && fields[key](value[key]));
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
var color = object2(Object.fromEntries(["red", "green", "blue", "alpha"].map((key) => [
  key,
  (value) => finite(value) && Number(value) >= 0 && Number(value) <= 1
])));
var colorStyle = (value) => object2({ rgbColor: color, themeColor: oneOf("TEXT", "BACKGROUND", "ACCENT1", "ACCENT2", "ACCENT3", "ACCENT4", "ACCENT5", "ACCENT6", "LINK") })(value) && Object.keys(value).length === 1;
var border = object2({ style: oneOf("NONE", "DOTTED", "DASHED", "SOLID", "SOLID_MEDIUM", "SOLID_THICK", "DOUBLE"), color, colorStyle }, ["style"]);
var format = object2({
  backgroundColor: color,
  backgroundColorStyle: colorStyle,
  textFormat: object2({
    foregroundColor: color,
    foregroundColorStyle: colorStyle,
    fontFamily: string(100),
    fontSize: integer(1, 400),
    bold: boolean,
    italic: boolean,
    strikethrough: boolean,
    underline: boolean
  }),
  numberFormat: object2({ type: oneOf("TEXT", "NUMBER", "PERCENT", "CURRENCY", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"), pattern: string(200) }, ["type"]),
  horizontalAlignment: oneOf("LEFT", "CENTER", "RIGHT"),
  verticalAlignment: oneOf("TOP", "MIDDLE", "BOTTOM"),
  wrapStrategy: oneOf("OVERFLOW_CELL", "CLIP", "WRAP"),
  textDirection: oneOf("LEFT_TO_RIGHT", "RIGHT_TO_LEFT"),
  textRotation: object2({ angle: integer(-90, 90), vertical: boolean }),
  borders: object2({ top: border, bottom: border, left: border, right: border }),
  padding: object2({ top: integer(0, 100), bottom: integer(0, 100), left: integer(0, 100), right: integer(0, 100) })
});
var enteredValue = (value) => object2({
  stringValue: string(1e4),
  numberValue: finite,
  boolValue: boolean,
  formulaValue: (value2) => typeof value2 === "string" && value2.length <= 1e4 && value2.startsWith("=") && safeFormula(value2)
})(value) && Object.keys(value).length === 1;
var cell = object2({ userEnteredValue: enteredValue, userEnteredFormat: format, note: string(2000) });
var cellFields = (value) => typeof value === "string" && value.length > 0 && value.length <= 1000 && value.split(",").every((field) => /^(?:userEnteredValue|note|userEnteredFormat(?:\.[A-Za-z]+)*)$/.test(field));
var gridRange = (value) => object2({ sheetId, startRowIndex: index, endRowIndex: index, startColumnIndex: integer(0, 18278), endColumnIndex: integer(1, 18278) }, ["sheetId", "endRowIndex", "endColumnIndex"])(value) && Number(value.endRowIndex) > Number(value.startRowIndex ?? 0) && Number(value.endColumnIndex) > Number(value.startColumnIndex ?? 0);
var dimensionRange = (value) => object2({ sheetId, dimension: oneOf("ROWS", "COLUMNS"), startIndex: index, endIndex: index }, ["sheetId", "dimension", "endIndex"])(value) && Number(value.endIndex) > Number(value.startIndex ?? 0) && (value.dimension !== "COLUMNS" || Number(value.endIndex) <= 18278);
var gridProperties = object2({ rowCount: integer(1, 1e6), columnCount: integer(1, 18278), frozenRowCount: index, frozenColumnCount: integer(0, 18278), hideGridlines: boolean });
var sheetProperties = object2({ sheetId, title: (value) => string(100)(value) && value.trim().length > 0, hidden: boolean, gridProperties, tabColor: color, tabColorStyle: colorStyle }, ["sheetId"]);
var sheetFields = (value) => typeof value === "string" && value.length > 0 && value.length <= 500 && value.split(",").every((field) => /^(?:title|hidden|tabColor|tabColorStyle|gridProperties(?:\.(?:rowCount|columnCount|frozenRowCount|frozenColumnCount|hideGridlines))?)$/.test(field));
var chartData = object2({ sourceRange: object2({ sources: array(gridRange, 10) }, ["sources"]) }, ["sourceRange"]);
var chartType = oneOf("BAR", "LINE", "AREA", "COLUMN", "SCATTER", "COMBO", "STEPPED_AREA");
var basicChart = object2({
  chartType,
  legendPosition: oneOf("BOTTOM_LEGEND", "LEFT_LEGEND", "RIGHT_LEGEND", "TOP_LEGEND", "NO_LEGEND"),
  axis: array(object2({ position: oneOf("BOTTOM_AXIS", "LEFT_AXIS", "RIGHT_AXIS"), title: string(500) }, ["position"]), 3),
  domains: array(object2({ domain: chartData, reversed: boolean }, ["domain"]), 3),
  series: array(object2({ series: chartData, targetAxis: oneOf("LEFT_AXIS", "RIGHT_AXIS", "BOTTOM_AXIS"), type: chartType, color, colorStyle }, ["series"]), 50),
  headerCount: integer(0, 10),
  stackedType: oneOf("NOT_STACKED", "STACKED", "PERCENT_STACKED"),
  interpolateNulls: boolean,
  compareMode: oneOf("DATUM", "CATEGORY")
}, ["chartType", "domains", "series"]);
var pieChart = object2({
  domain: chartData,
  series: chartData,
  legendPosition: oneOf("BOTTOM_LEGEND", "LEFT_LEGEND", "RIGHT_LEGEND", "TOP_LEGEND", "NO_LEGEND", "LABELED_LEGEND"),
  pieHole: (value) => finite(value) && Number(value) >= 0 && Number(value) <= 1,
  threeDimensional: boolean
}, ["domain", "series"]);
var chartSpec = (value) => object2({
  title: string(500),
  subtitle: string(500),
  altText: string(1000),
  basicChart,
  pieChart,
  backgroundColor: color
}, [])(value) && Object.hasOwn(value, "basicChart") !== Object.hasOwn(value, "pieChart");
var chartPosition = (value) => object2({
  newSheet: (value2) => value2 === true,
  overlayPosition: object2({
    anchorCell: object2({ sheetId, rowIndex: index, columnIndex: integer(0, 18277) }, ["sheetId"]),
    offsetXPixels: integer(-5000, 5000),
    offsetYPixels: integer(-5000, 5000),
    widthPixels: integer(1, 5000),
    heightPixels: integer(1, 5000)
  }, ["anchorCell"])
})(value) && Object.hasOwn(value, "newSheet") !== Object.hasOwn(value, "overlayPosition");
var dimensionProperties = object2({ pixelSize: integer(1, 2000), hiddenByUser: boolean });
var dimensionUpdate = (value) => object2({
  range: dimensionRange,
  properties: dimensionProperties,
  fields: (value2) => typeof value2 === "string" && value2.split(",").every((key) => ["pixelSize", "hiddenByUser"].includes(key))
}, ["range", "properties", "fields"])(value) && Object.keys(value.properties).sort().join(",") === value.fields.split(",").sort().join(",");
var REQUESTS = {
  repeatCell: object2({ range: gridRange, cell, fields: cellFields }, ["range", "cell", "fields"]),
  updateCells: (value) => object2({
    start: object2({ sheetId, rowIndex: index, columnIndex: integer(0, 18277) }, ["sheetId"]),
    range: gridRange,
    rows: array(object2({ values: array(cell, 1000) }, ["values"]), 1000),
    fields: cellFields
  }, ["rows", "fields"])(value) && Object.hasOwn(value, "start") !== Object.hasOwn(value, "range"),
  updateDimensionProperties: dimensionUpdate,
  autoResizeDimensions: object2({ dimensions: dimensionRange }, ["dimensions"]),
  updateSheetProperties: object2({ properties: sheetProperties, fields: sheetFields }, ["properties", "fields"]),
  addSheet: (value) => object2({ properties: sheetProperties }, ["properties"])(value) && Object.hasOwn(value.properties, "title"),
  deleteSheet: object2({ sheetId }, ["sheetId"]),
  addChart: object2({ chart: object2({ spec: chartSpec, position: chartPosition }, ["spec", "position"]) }, ["chart"]),
  mergeCells: object2({ range: gridRange, mergeType: oneOf("MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS") }, ["range", "mergeType"]),
  unmergeCells: object2({ range: gridRange }, ["range"]),
  updateBorders: object2({ range: gridRange, top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border }, ["range"]),
  copyPaste: object2({ source: gridRange, destination: gridRange, pasteType: oneOf("PASTE_FORMAT"), pasteOrientation: oneOf("NORMAL", "TRANSPOSE") }, ["source", "destination", "pasteType"])
};
function validSheetsBatch(requests) {
  return array((value) => record(value) && Object.keys(value).length === 1 && Object.entries(value).every(([key, body]) => Object.hasOwn(REQUESTS, key) && REQUESTS[key](body)), 100)(requests) && JSON.stringify(requests).length <= 11000;
}

// modules/telegram-corporate/adapters/drive-files.ts
import { randomUUID as randomUUID3 } from "crypto";
import { closeSync as closeSync3, constants as constants3, fstatSync as fstatSync3, lstatSync as lstatSync3, mkdtempSync, openSync as openSync3, readSync as readSync2, realpathSync as realpathSync3, rmSync as rmSync2 } from "fs";
import { dirname as dirname4, join as join7 } from "path";
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
var invalid3 = (message) => ({ ok: false, code: "invalid", message });
function pageName(value) {
  let name = value.slice(0, 100);
  while (JSON.stringify(name).length > 102)
    name = name.slice(0, -1);
  return name;
}
function stagedFile(path) {
  const before = lstatSync3(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_FILE_BYTES)
    throw new Error("invalid staged file");
  const fd = openSync3(path, constants3.O_RDONLY | constants3.O_NOFOLLOW | constants3.O_NONBLOCK);
  try {
    const info = fstatSync3(fd);
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size)
      throw new Error("staged file changed");
    const head = Buffer.alloc(16);
    return { size: info.size, head: head.subarray(0, readSync2(fd, head, 0, head.length, 0)) };
  } finally {
    closeSync3(fd);
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
      return invalid3("\u041D\u0435 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u0438\u0439 Google-\u0430\u043A\u0430\u0443\u043D\u0442 \u0440\u0435\u0441\u0443\u0440\u0441\u0443.");
    const args = request.arguments;
    const run2 = (method, params) => this.options.run({
      argv: [
        join7(this.options.home, "bin/gog"),
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
      const whole = wholeDrive(request.resource);
      if (Object.keys(args).some((key) => !["folderId", "max", "cursor"].includes(key)) || typeof args.folderId !== "string" || !(GOOGLE_FILE_ID.test(args.folderId) || whole && args.folderId === "root") || args.max !== undefined && (!Number.isSafeInteger(args.max) || Number(args.max) < 1 || Number(args.max) > 100) || args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(args.cursor)))
        return invalid3("list \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 folderId, \u043D\u0435\u043E\u0431\u043E\u0432\u02BC\u044F\u0437\u043A\u043E\u0432\u043E max (1\u2013100) \u0456 cursor.");
      let folderId = args.folderId;
      if (!whole) {
        const folders = allowedFolders(request.resource).map((folder) => folder.folderId);
        const membership = await new DriveFolderIndex({ home: this.options.home, account, run: this.options.run }).membership(folderId, folders, signal);
        if (membership !== "inside")
          return invalid3("\u0422\u0435\u043A\u0430 \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0434\u043E \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u0430\u0431\u043E \u0457\u0457 \u043D\u0430\u043B\u0435\u0436\u043D\u0456\u0441\u0442\u044C \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0430.");
      } else if (folderId === "root") {
        const root = await run2("files.get", { fileId: "root", fields: "id" });
        try {
          const id2 = root.exitCode === 0 && !root.stdoutTruncated ? JSON.parse(root.stdout).id : null;
          if (typeof id2 !== "string" || !GOOGLE_FILE_ID.test(id2))
            throw new Error("root");
          folderId = id2;
        } catch {
          return { ok: false, code: "unavailable" };
        }
      }
      const pageSize = Math.min(Number(args.max ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE);
      const response = await run2("files.list", {
        q: `'${folderId}' in parents and trashed = false`,
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
        const files = value.files.map((file3) => {
          if (typeof file3.id !== "string" || !GOOGLE_FILE_ID.test(file3.id) || file3.trashed === true || !Array.isArray(file3.parents) || !file3.parents.includes(folderId) || typeof file3.name !== "string" || typeof file3.mimeType !== "string" || file3.mimeType.length > 128 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file3.mimeType) || file3.size !== undefined && (typeof file3.size !== "string" || !/^\d{1,20}$/.test(file3.size)))
            throw new Error("invalid scoped file");
          const name = pageName(file3.name);
          return { id: file3.id, name, ...name !== file3.name ? { nameTruncated: true } : {}, mimeType: file3.mimeType, size: file3.size ?? null };
        });
        return { ok: true, data: JSON.stringify({ folderId, files, nextCursor: value.nextPageToken ?? null, incomplete: Boolean(value.nextPageToken) }) };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    }
    if (request.operation !== "download" || Object.keys(args).length !== 1 || typeof args.fileId !== "string" || !GOOGLE_FILE_ID.test(args.fileId)) {
      return invalid3("download \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 \u043B\u0438\u0448\u0435 fileId; \u0448\u043B\u044F\u0445 \u0432\u0438\u0437\u043D\u0430\u0447\u0430\u0454 \u0441\u0438\u0441\u0442\u0435\u043C\u0430.");
    }
    const workspace = request.verified.workspace;
    let identity2;
    try {
      const root = this.options.workspaceRoot ?? join7(this.options.home, "corporate-workspaces");
      if (typeof workspace !== "string" || dirname4(workspace) !== root || !/^[a-f0-9]{64}$/.test(workspace.slice(root.length + 1)))
        throw new Error("invalid workspace");
      const before = lstatSync3(workspace, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory() || realpathSync3(workspace) !== join7(realpathSync3(root), workspace.slice(root.length + 1)))
        throw new Error("invalid workspace");
      const fd = openSync3(workspace, constants3.O_RDONLY | constants3.O_DIRECTORY | constants3.O_NOFOLLOW);
      try {
        const info = fstatSync3(fd, { bigint: true });
        if (info.dev !== before.dev || info.ino !== before.ino)
          throw new Error("workspace changed");
        identity2 = { device: String(info.dev), inode: String(info.ino) };
      } finally {
        closeSync3(fd);
      }
    } catch {
      return invalid3("\u041D\u0435\u043C\u0430\u0454 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E\u0457 \u0440\u043E\u0431\u043E\u0447\u043E\u0457 \u0442\u0435\u043A\u0438 \u0446\u0456\u0454\u0457 \u0441\u0435\u0441\u0456\u0457; \u0444\u0430\u0439\u043B \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043E.");
    }
    const denial = await this.options.authorizeFile(request, account, signal);
    if (denial)
      return invalid3(denial);
    const metadata = await run2("files.get", { fileId: args.fileId, fields: "id,name,mimeType,size,trashed", supportsAllDrives: true });
    if (metadata.exitCode !== 0 || metadata.stdoutTruncated || signal.aborted)
      return { ok: false, code: "unavailable" };
    let file2;
    try {
      file2 = JSON.parse(metadata.stdout);
      if (file2.id !== args.fileId || typeof file2.name !== "string" || typeof file2.mimeType !== "string" || file2.trashed)
        throw new Error("invalid metadata");
    } catch {
      return { ok: false, code: "unavailable" };
    }
    const format2 = EXPORTS[file2.mimeType];
    if (!format2 && (!/^\d+$/.test(String(file2.size)) || Number(file2.size) > MAX_FILE_BYTES))
      return invalid3("\u0424\u0430\u0439\u043B \u0437\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u0430\u0431\u043E \u0439\u043E\u0433\u043E \u0440\u043E\u0437\u043C\u0456\u0440 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E (\u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C 12 \u041C\u0411).");
    if (file2.mimeType.startsWith("application/vnd.google-apps.") && !format2)
      return invalid3("\u0426\u0435\u0439 \u0442\u0438\u043F Google-\u0444\u0430\u0439\u043B\u0430 \u043D\u0435 \u043F\u0456\u0434\u0442\u0440\u0438\u043C\u0443\u0454 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F; \u0441\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439\u0441\u044F \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u043D\u0438\u043C \u043A\u043E\u043D\u0435\u043A\u0442\u043E\u0440\u043E\u043C.");
    const temp = mkdtempSync(join7(tmpdir2(), "corporate-drive-"));
    const download = join7(temp, format2 ? `download.${format2}` : "download");
    try {
      const response = await this.options.run({
        argv: [
          "/usr/bin/prlimit",
          `--fsize=${MAX_FILE_BYTES}:${MAX_FILE_BYTES}`,
          "--",
          join7(this.options.home, "bin/gog"),
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
        const converted = join7(temp, "converted.jpg");
        const conversion = await this.options.run({
          argv: [
            "/usr/bin/prlimit",
            `--fsize=${MAX_FILE_BYTES}:${MAX_FILE_BYTES}`,
            "--as=536870912:536870912",
            "--cpu=20:20",
            "--",
            join7(this.options.home, "bin/heic-to-jpg"),
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
      const name = `drive-${randomUUID3()}.${heif ? "jpg" : format2 ?? EXTENSIONS[file2.mimeType] ?? "bin"}`;
      const target = join7(workspace, name);
      const publication = await runBoundedCommand({
        argv: ["python3", "-c", PUBLISH_FILE, workspace, identity2.device, identity2.inode, source, name, String(MAX_FILE_BYTES)],
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
        fileId: file2.id,
        name: file2.name.slice(0, 300),
        mimeType: heif ? "image/jpeg" : file2.mimeType,
        ...heif ? { conversion: "heif-to-jpeg" } : {},
        path: target,
        bytes: info.size,
        instruction: "Open this local file with Read or the appropriate file skill. This is a download, not delivery to Telegram."
      }) };
    } catch {
      return { ok: false, code: "unavailable" };
    } finally {
      rmSync2(temp, { recursive: true, force: true });
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
  "google.gmail.read:labels": [],
  "google.gmail.modify:create_label": ["name"],
  "google.gmail.modify:archive": ["threadIds"],
  "google.gmail.modify:trash": ["threadIds"],
  "google.calendar.read:get": ["eventId"],
  "google.contacts.read:get": ["resourceName"],
  "google.tasks.read:get": ["tasklistId", "taskId"],
  "google.tasks.write:complete": ["tasklistId", "taskId"]
};
var GMAIL_EXACT = {
  "google.gmail.read:labels": "gmail.labels.list",
  "google.gmail.modify:create_label": "gmail.labels.create",
  "google.gmail.modify:modify": "gmail.labels.modify",
  "google.gmail.modify:archive": "gmail.labels.modify",
  "google.gmail.modify:trash": "gmail.labels.modify"
};
var GMAIL_THREAD_ID = /^[A-Za-z0-9]{6,64}$/;
var GMAIL_THREADS_PER_CALL = 50;
function gmailThreadIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > GMAIL_THREADS_PER_CALL)
    return null;
  if (!value.every((id2) => typeof id2 === "string" && GMAIL_THREAD_ID.test(id2)))
    return null;
  return new Set(value).size === value.length ? value : null;
}
function gmailLabels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10)
    return null;
  const labels = value.map((label) => text4(label, 225));
  return labels.every((label) => label != null && !label.includes(",") && label.trim() === label) ? labels.join(",") : null;
}
var CREATE_SHARE_EMAIL = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
function exactKeys3(value, keys2) {
  const actual = Object.keys(value).sort();
  const expected = [...keys2].sort();
  return actual.length === expected.length && actual.every((key, index2) => key === expected[index2]);
}
function text4(value, max = 2000, allowLeadingDash = false) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\0\r\n]/.test(value) || !allowLeadingDash && value.startsWith("-"))
    return null;
  return value;
}
function letter(value, max) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\x00"))
    return null;
  return value.replace(/\r\n?/g, `
`);
}
var MAX_ATTACHMENTS = 10;
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
var SHA256 = /^[a-f0-9]{64}$/;
function boundedInt(value, fallback, maximum) {
  if (value == null)
    return fallback;
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum ? Number(value) : null;
}
function googleRejection(stderr) {
  const body = stderr.search(/\{\s*"error"\s*:/);
  if (body >= 0) {
    try {
      const { code, message } = JSON.parse(stderr.slice(body, stderr.lastIndexOf("}") + 1)).error;
      if (Number.isSafeInteger(code))
        return { status: code, message: typeof message === "string" ? message : "" };
    } catch {}
  }
  const line = /(?:Google API error \((\d{3})\b[^)]*\)|googleapi: Error (\d{3})):\s*(.*)/.exec(stderr);
  return line == null ? null : { status: Number(line[1] ?? line[2]), message: line[3] };
}
var SIGN_IN_FAILURE = /^No auth for [\w:.-]+ |\btoken source: get token for \S+: read token: |\boauth2: (?:"invalid_grant"|"invalid_client"|token expired and refresh token is not set)|Secret not found in keyring \(refresh token missing\)/m;
function googleSignInFailure(stderr) {
  return googleRejection(stderr)?.status === 401 || SIGN_IN_FAILURE.test(stderr);
}
function signInRefused(stderr) {
  return {
    ok: false,
    code: "failed",
    failureCode: "google_auth_no_write",
    message: `Google \u043D\u0435 \u043F\u0440\u0438\u0439\u043D\u044F\u0432 \u0432\u0445\u0456\u0434 \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443, \u0442\u043E\u043C\u0443 \u0437\u0430\u043F\u0438\u0441 \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u0432\u0441\u044F: \xAB${scrub(stderr)}\xBB. ` + "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u043E \u0437\u0430\u043D\u043E\u0432\u043E \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0438 Google \u0434\u043B\u044F \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443; \u0434\u043E \u0442\u043E\u0433\u043E \u0437\u0430\u043F\u0438\u0441 \u043D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439."
  };
}
function scrub(value) {
  return value.replace(/[\w.+-]+@[\w.-]+\.\w+/g, "<email>").replace(/\/[\w./-]*\/(gog|home|claude)[\w./-]*/g, "<path>").replace(/\b(ya29|1\/\/|AIza)[\w.-]+/g, "<token>").split(`
`).map((line) => line.trim()).filter((line) => line.length > 0).join("; ").slice(0, 300);
}
function optionalFlag(args, flag, value, max = 200) {
  if (value == null)
    return true;
  const valid = text4(value, max);
  if (valid == null)
    return false;
  args.push(flag, valid);
  return true;
}

class GoogleAdapter {
  slides;
  docsWrite;
  driveFiles;
  driveFolders;
  home;
  run;
  workspaceRoot;
  createdSheetIds;
  allowDbSheetHistory;
  createdSheetFiles;
  createdDocumentFiles;
  folderIndexes = new Map;
  constructor(options) {
    this.home = options.home;
    this.allowDbSheetHistory = options.createdSheetIds == null;
    this.run = options.run ?? runBoundedCommand;
    this.workspaceRoot = options.workspaceRoot ?? join8(options.home, "corporate-workspaces");
    this.driveFolders = new DriveFoldersAdapter({ home: this.home, run: this.run });
    this.driveFiles = new DriveFilesAdapter({ home: this.home, workspaceRoot: options.workspaceRoot, run: this.run, authorizeFile: (request, account, signal) => this.fileDenial(request, account, signal) });
    this.slides = new SlidesAdapter({
      home: this.home,
      run: this.run,
      authorizePresentation: (request, presentationId, account, signal) => this.fileDenial({
        ...request,
        capability: "google.drive.read",
        operation: "get",
        arguments: { fileId: presentationId }
      }, account, signal)
    });
    this.docsWrite = new DocsWriteAdapter({
      home: this.home,
      run: this.run,
      createdDocumentIds: (resourceId) => this.createdDocumentFiles(resourceId).map((file2) => file2.id),
      authorizeFile: (request, account, signal) => this.fileDenial(request, account, signal)
    });
    this.createdSheetIds = options.createdSheetIds ?? ((resourceId) => {
      let db;
      try {
        db = new Database5(join8(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
        return createdGoogleSheetIds(db, resourceId);
      } catch {
        return [];
      } finally {
        db?.close();
      }
    });
    this.createdSheetFiles = (resourceId) => {
      if (options.createdSheetIds != null) {
        return options.createdSheetIds(resourceId).filter((id2) => GOOGLE_FILE_ID.test(id2)).map((id2) => ({ id: id2, label: id2, kind: "sheet" }));
      }
      let db;
      try {
        db = new Database5(join8(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
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
        db = new Database5(join8(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
        return createdGoogleDocFiles(db, resourceId);
      } catch {
        return [];
      } finally {
        db?.close();
      }
    };
  }
  preparePreview(request) {
    if (request.capability === "google.drive.write" && request.operation === "upload") {
      const file2 = request.arguments?.file;
      if (typeof file2 !== "string" || file2.length === 0 || file2.length > 512)
        return { ok: false, message: '\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: "file" \u2014 \u0448\u043B\u044F\u0445 \u0434\u043E \u0444\u0430\u0439\u043B\u0430 \u0432 \u0440\u043E\u0431\u043E\u0447\u0456\u0439 \u043F\u0430\u043F\u0446\u0456 \u0446\u0456\u0454\u0457 \u0440\u043E\u0437\u043C\u043E\u0432\u0438.' };
      const pinned2 = streamWorkspaceFile(request.verified.workspace, file2, MAX_DRIVE_UPLOAD_BYTES);
      if (pinned2 == null)
        return { ok: false, message: `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0444\u0430\u0439\u043B\u0443 \xAB${file2}\xBB \u043D\u0435\u043C\u0430\u0454 \u0432 \u0440\u043E\u0431\u043E\u0447\u0456\u0439 \u043F\u0430\u043F\u0446\u0456 \u0446\u0456\u0454\u0457 \u0440\u043E\u0437\u043C\u043E\u0432\u0438, \u0430\u0431\u043E \u0432\u0456\u043D \u043F\u043E\u0440\u043E\u0436\u043D\u0456\u0439, \u0437\u043C\u0456\u043D\u044E\u0454\u0442\u044C\u0441\u044F \u0447\u0438 \u0431\u0456\u043B\u044C\u0448\u0438\u0439 \u0437\u0430 1 \u0413\u0411.` };
      if (request.arguments.sha256 != null && request.arguments.sha256 !== pinned2.sha256) {
        return { ok: false, message: "\u0424\u0430\u0439\u043B \u0437\u043C\u0456\u043D\u0438\u0432\u0441\u044F \u043F\u0456\u0441\u043B\u044F \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F. \u041D\u0456\u0447\u043E\u0433\u043E \u043D\u0435 \u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043E; \u043F\u0456\u0434\u0433\u043E\u0442\u0443\u0439 \u043D\u043E\u0432\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F." };
      }
      return { ok: true, arguments: { ...request.arguments, sha256: pinned2.sha256 } };
    }
    if (request.capability !== "google.gmail.send")
      return { ok: true, arguments: request.arguments };
    let letterArgs = request.arguments;
    if (letterArgs.html != null) {
      const plain2 = typeof letterArgs.html === "string" ? htmlText(letterArgs.html) : "";
      if (plain2 === "")
        return { ok: false, message: "\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: HTML-\u0432\u0435\u0440\u0441\u0456\u044F \u043B\u0438\u0441\u0442\u0430 \u043D\u0435 \u043C\u0456\u0441\u0442\u0438\u0442\u044C \u0442\u0435\u043A\u0441\u0442\u0443." };
      letterArgs = { ...letterArgs, body: plain2 };
    }
    if (letterArgs.attachments == null)
      return { ok: true, arguments: letterArgs };
    const pinned = this.attachments({ ...request, arguments: letterArgs }, null);
    if (typeof pinned === "string")
      return { ok: false, message: pinned };
    const { sha256: _given, ...args } = letterArgs;
    return { ok: true, arguments: { ...args, sha256: pinned } };
  }
  attachments(request, folder) {
    const files = request.arguments.attachments;
    if (!Array.isArray(files) || files.length < 1 || files.length > MAX_ATTACHMENTS || files.some((file2) => typeof file2 !== "string" || file2.length === 0 || file2.length > 512)) {
      return `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: "attachments" \u2014 \u0446\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u0432\u0456\u0434 1 \u0434\u043E ${MAX_ATTACHMENTS} \u0448\u043B\u044F\u0445\u0456\u0432 \u0434\u043E \u0444\u0430\u0439\u043B\u0456\u0432 \u0443 \u0440\u043E\u0431\u043E\u0447\u0456\u0439 \u043F\u0430\u043F\u0446\u0456 \u0446\u0456\u0454\u0457 \u0440\u043E\u0437\u043C\u043E\u0432\u0438.`;
    }
    const expected = request.arguments.sha256;
    if (folder != null && (!Array.isArray(expected) || expected.length !== files.length || expected.some((hash) => typeof hash !== "string" || !SHA256.test(hash))))
      return this.argumentDenial(request);
    const workspace = request.verified.workspace;
    const result = [];
    let total = 0;
    for (const [index2, file2] of files.entries()) {
      let target;
      if (folder != null) {
        mkdirSync3(join8(folder, String(index2)), { mode: 448 });
        target = join8(folder, String(index2), basename2(file2).replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(-120) || "file");
      }
      const pinned = streamWorkspaceFile(workspace, file2, MAX_ATTACHMENT_BYTES, target == null ? undefined : { target, expected: expected[index2] });
      if (pinned == null) {
        return folder != null ? "\u0424\u0430\u0439\u043B \u0437\u043C\u0456\u043D\u0438\u0432\u0441\u044F \u043F\u0456\u0441\u043B\u044F \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F \u0430\u0431\u043E \u043D\u0435 \u043D\u0430\u043B\u0435\u0436\u0438\u0442\u044C \u0446\u0456\u0439 \u0440\u043E\u0437\u043C\u043E\u0432\u0456. \u041B\u0438\u0441\u0442 \u043D\u0435 \u043D\u0430\u0434\u0456\u0441\u043B\u0430\u043D\u043E; \u043F\u0456\u0434\u0433\u043E\u0442\u0443\u0439 \u043D\u043E\u0432\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F." : `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0444\u0430\u0439\u043B\u0443 \xAB${file2}\xBB \u043D\u0435\u043C\u0430\u0454 \u0432 \u0440\u043E\u0431\u043E\u0447\u0456\u0439 \u043F\u0430\u043F\u0446\u0456 \u0446\u0456\u0454\u0457 \u0440\u043E\u0437\u043C\u043E\u0432\u0438, \u0430\u0431\u043E \u0432\u0456\u043D \u043F\u043E\u0440\u043E\u0436\u043D\u0456\u0439, \u0437\u043C\u0456\u043D\u044E\u0454\u0442\u044C\u0441\u044F \u0447\u0438 \u0431\u0456\u043B\u044C\u0448\u0438\u0439 \u0437\u0430 25 \u041C\u0411.`;
      }
      total += pinned.size;
      if (total > MAX_ATTACHMENT_BYTES)
        return "\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0432\u043A\u043B\u0430\u0434\u0435\u043D\u043D\u044F \u0440\u0430\u0437\u043E\u043C \u0431\u0456\u043B\u044C\u0448\u0456 \u0437\u0430 25 \u041C\u0411 \u2014 \u043B\u0456\u043C\u0456\u0442 Gmail. \u0412\u0435\u043B\u0438\u043A\u0438\u0439 \u0444\u0430\u0439\u043B \u0434\u0430\u0439 \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F\u043C (\u043D\u0430\u043F\u0440\u0438\u043A\u043B\u0430\u0434, \u0437 Google \u0414\u0438\u0441\u043A\u0430).";
      result.push(target ?? pinned.sha256);
    }
    if (folder == null && expected != null && JSON.stringify(expected) !== JSON.stringify(result)) {
      return "\u0424\u0430\u0439\u043B \u0437\u043C\u0456\u043D\u0438\u0432\u0441\u044F \u043F\u0456\u0441\u043B\u044F \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F. \u041B\u0438\u0441\u0442 \u043D\u0435 \u043D\u0430\u0434\u0456\u0441\u043B\u0430\u043D\u043E; \u043F\u0456\u0434\u0433\u043E\u0442\u0443\u0439 \u043D\u043E\u0432\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F.";
    }
    return result;
  }
  async execute(request, signal) {
    if (request.resource.connector !== "google")
      return { ok: false, code: "invalid" };
    if (request.capability === "google.drive.write")
      return this.driveFolders.execute(request, signal);
    if (request.capability === "google.slides.read" || request.capability === "google.slides.write") {
      return this.slides.execute(request, signal);
    }
    if (request.capability === "google.docs.write") {
      if (request.resource.config.docsAppendOnly === true && request.operation !== "append") {
        return { ok: false, code: "invalid", message: "\u0426\u0435\u0439 \u0440\u043E\u0431\u043E\u0447\u0438\u0439 \u0440\u0435\u0441\u0443\u0440\u0441 \u0434\u043E\u0437\u0432\u043E\u043B\u044F\u0454 \u043B\u0438\u0448\u0435 \u0434\u043E\u043F\u0438\u0441\u0443\u0432\u0430\u043D\u043D\u044F; \u043D\u0430\u044F\u0432\u043D\u0438\u0439 \u0432\u043C\u0456\u0441\u0442 \u0456 \u041A\u0420\u0406 \u043D\u0435 \u0437\u0430\u043C\u0456\u043D\u044E\u044E\u0442\u044C\u0441\u044F." };
      }
      if (["append", "insert_image", "update"].includes(request.operation))
        return this.docsWrite.execute(request, signal);
    }
    const account = text4(request.resource.config.account, 254);
    const service = this.service(request.capability);
    if (account == null || !account.includes("@") || service == null) {
      return { ok: false, code: "invalid" };
    }
    if (request.capability === "google.drive.read" && ["list", "download"].includes(request.operation))
      return this.driveFiles.execute(request, signal);
    if (request.capability === "google.gmail.read" && request.operation === "attachment")
      return this.mailAttachment(request, account, signal);
    const denial = await this.spreadsheetDenial(request, account, signal) ?? await this.shareDenial(request, account, signal) ?? await this.fileDenial(request, account, signal);
    if (denial != null)
      return { ok: false, code: "invalid", message: denial };
    const operation = this.operationArgs(request);
    if (operation == null) {
      return {
        ok: false,
        code: "invalid",
        failureCode: "google_arguments_no_write",
        message: this.argumentDenial(request) + " \u0417\u0430\u043F\u0438\u0442 \u0434\u043E \u0441\u0435\u0440\u0432\u0456\u0441\u0443 \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u0432\u0441\u044F; \u0432\u0438\u043F\u0440\u0430\u0432 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u0456 \u043F\u0440\u043E\u0434\u043E\u0432\u0436\u0443\u0439."
      };
    }
    const isSheetCreate = request.capability === "google.sheets.write" && request.operation === "create";
    const isNativeCreate = isSheetCreate || request.capability === "google.docs.write" && request.operation === "create";
    const creation = isNativeCreate ? await nativeCreationParent({ home: this.home, run: this.run }, request, signal) : { ok: true, parentId: undefined };
    if (!creation.ok)
      return creation.result;
    const isSheetMetadata = request.capability === "google.sheets.read" && request.operation === "metadata";
    const isSheetReadFormat = request.capability === "google.sheets.read" && request.operation === "read_format";
    const isSheetLayout = request.capability === "google.sheets.read" && request.operation === "read_layout";
    const isSheetBatch = request.capability === "google.sheets.write" && request.operation === "batch_update";
    const isSheetUpdate = request.capability === "google.sheets.write" && request.operation === "update_cells";
    const isDocRead = request.capability === "google.docs.read" && request.operation === "get";
    const gmailExact = GMAIL_EXACT[`${request.capability}:${request.operation}`];
    const configuredRecipient = isSheetCreate ? request.resource.config.createShareEmail : undefined;
    const recipient = configuredRecipient === undefined ? null : text4(configuredRecipient, 254);
    if (configuredRecipient !== undefined && (recipient == null || recipient.indexOf("@") > 64 || !CREATE_SHARE_EMAIL.test(recipient))) {
      return { ok: false, code: "invalid", message: "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0430 \u0430\u0434\u0440\u0435\u0441\u0430 createShareEmail \u0443 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F\u0445 \u0440\u0435\u0441\u0443\u0440\u0441\u0443. \u0422\u0430\u0431\u043B\u0438\u0446\u044E \u043D\u0435 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043E." };
    }
    if (request.capability === "google.drive.read" && request.operation === "search") {
      if (signal.aborted)
        return { ok: false, code: "unavailable" };
      return wholeDrive(request.resource) ? this.searchWholeDrive(request, account, signal) : this.searchRegisteredFiles(request);
    }
    if (isSheetUpdate && request.arguments.range.includes("!")) {
      const invalidRange = {
        ok: false,
        code: "invalid",
        failureCode: "sheet_range_invalid_no_write",
        message: "\u0412\u043A\u043B\u0430\u0434\u043A\u0443 \u0430\u0431\u043E \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E. \u0417\u0430\u043F\u0438\u0441 \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u0432\u0441\u044F."
      };
      const unavailable = {
        ok: false,
        code: "unavailable",
        failureCode: "sheet_preflight_unavailable_no_write",
        message: "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0438\u0442\u0438 \u0432\u043A\u043B\u0430\u0434\u043A\u0443 \u043F\u0435\u0440\u0435\u0434 \u0437\u0430\u043F\u0438\u0441\u043E\u043C. \u0417\u0430\u043F\u0438\u0441 \u043D\u0435 \u043F\u043E\u0447\u0438\u043D\u0430\u0432\u0441\u044F; \u0441\u043F\u0440\u043E\u0431\u0443\u0439 \u043F\u0456\u0437\u043D\u0456\u0448\u0435."
      };
      try {
        if (signal.aborted)
          return unavailable;
        const spreadsheetId = request.arguments.spreadsheetId;
        const probe = await this.run({
          argv: [
            join8(this.home, "bin", "gog"),
            "--no-input",
            "--json",
            "--readonly",
            "--enable-commands-exact=api.call,api.sheets.spreadsheets.get",
            "api",
            "call",
            "sheets",
            "v4",
            "spreadsheets.get",
            "--params",
            JSON.stringify({
              spreadsheetId,
              ranges: [request.arguments.range],
              fields: "spreadsheetId,sheets(properties(sheetId,title))"
            }),
            "--scope",
            "https://www.googleapis.com/auth/spreadsheets.readonly"
          ],
          cwd: this.home,
          env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
          timeoutMs: 30000
        }, signal);
        if (probe.exitCode !== 0) {
          return /unable to parse range/i.test(probe.stderr) ? invalidRange : googleSignInFailure(probe.stderr) ? signInRefused(probe.stderr) : unavailable;
        }
        if (probe.stdoutTruncated === true)
          return unavailable;
        const metadata = JSON.parse(probe.stdout);
        if (metadata.spreadsheetId !== spreadsheetId || !Array.isArray(metadata.sheets) || metadata.sheets.length > 1)
          return unavailable;
        if (metadata.sheets.length === 0)
          return invalidRange;
      } catch {
        return unavailable;
      }
    }
    const stdin = isSheetBatch ? JSON.stringify({ requests: request.arguments.requests, includeSpreadsheetInResponse: false }) : request.capability === "google.docs.write" && (request.operation === "replace" || request.operation === "append") && typeof request.arguments.content === "string" ? request.arguments.content : undefined;
    const command = {
      argv: [
        join8(this.home, "bin", "gog"),
        "--no-input",
        "--json",
        ...gmailExact != null ? [`--enable-commands-exact=${gmailExact}`, "--gmail-no-send"] : isSheetBatch ? ["--enable-commands-exact=api.call,api.sheets.spreadsheets.batchupdate"] : isSheetLayout ? ["--readonly", "--enable-commands-exact=api.call,api.sheets.spreadsheets.get"] : isSheetMetadata ? ["--readonly", "--enable-commands-exact=sheets.metadata"] : isSheetReadFormat ? ["--readonly", "--enable-commands-exact=sheets.read-format"] : [`--enable-commands=${service}`],
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
    if (isNativeCreate && creation.parentId != null) {
      if (isSheetCreate) {
        command.argv = [
          join8(this.home, "bin/gog"),
          "--no-input",
          "--json",
          "--enable-commands-exact=api.call,api.drive.files.create",
          "api",
          "call",
          "drive",
          "v3",
          "files.create",
          "--params",
          JSON.stringify({ fields: "id,name,mimeType,parents,webViewLink", supportsAllDrives: true }),
          "--body",
          "@/dev/stdin",
          "--scope",
          "https://www.googleapis.com/auth/drive",
          "--allow-write",
          "--force"
        ];
        command.stdin = JSON.stringify({ name: request.arguments.title, mimeType: "application/vnd.google-apps.spreadsheet", parents: [creation.parentId] });
      } else
        command.argv.push("--parent", creation.parentId);
    }
    let attachmentFolder = null;
    if (request.capability === "google.gmail.send" && request.arguments.attachments != null) {
      attachmentFolder = join8(this.home, ".cache", "corporate-gmail", randomBytes3(8).toString("hex"));
      mkdirSync3(attachmentFolder, { recursive: true, mode: 448 });
      const copies = this.attachments(request, attachmentFolder);
      if (typeof copies === "string") {
        rmSync3(attachmentFolder, { recursive: true, force: true });
        return { ok: false, code: "invalid", message: copies };
      }
      command.argv.push(...copies.flatMap((file2) => ["--attach", file2]));
      command.timeoutMs = 180000;
    }
    const result = await this.run(command, signal).finally(() => {
      if (attachmentFolder != null)
        rmSync3(attachmentFolder, { recursive: true, force: true });
    });
    const isWrite = request.capability.endsWith(".write") || request.capability.endsWith(".send") || request.capability === "google.drive.share" || request.capability === "google.gmail.modify";
    if (result.exitCode === 0) {
      if (request.capability === "google.calendar.read" && request.operation === "list" && !result.stdoutTruncated) {
        try {
          const page = JSON.parse(result.stdout);
          if (!Array.isArray(page.events) || page.nextPageToken != null && typeof page.nextPageToken !== "string")
            throw new Error("invalid calendar page");
          const { nextPageToken, ...data } = page;
          return { ok: true, data: JSON.stringify({ ...data, hasMore: typeof nextPageToken === "string" && nextPageToken.length > 0 }) };
        } catch {
          return { ok: false, code: "failed", message: "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u0438 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u044C \u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u044F. \u041D\u0435 \u0440\u043E\u0431\u0438 \u0432\u0438\u0441\u043D\u043E\u0432\u043A\u0443, \u0449\u043E \u043F\u043E\u0434\u0456\u0439 \u043D\u0435\u043C\u0430\u0454." };
        }
      }
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
      if (gmailExact === "gmail.labels.modify")
        return this.threadLabelResult(result.stdout);
      let receiptId = isWrite && !isSheetBatch ? this.receipt(result.stdout) : undefined;
      if (isNativeCreate && creation.parentId != null && (receiptId == null || !await nativeParentReadback({ home: this.home, run: this.run }, account, receiptId, creation.parentId, signal))) {
        return {
          ok: false,
          code: "uncertain",
          ...receiptId ? { receiptId } : {},
          message: "\u0421\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043F\u0435\u0440\u0435\u0434\u0430\u043D\u043E Google, \u0430\u043B\u0435 \u0444\u0430\u0439\u043B \u0443 \u043F\u043E\u0433\u043E\u0434\u0436\u0435\u043D\u0456\u0439 \u0442\u0435\u0446\u0456 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E. \u041D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F; \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u043D\u0456\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442."
        };
      }
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
                join8(this.home, "bin", "gog"),
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
    if (result.exitCode === 130 && result.started === false)
      return { ok: false, code: "unavailable" };
    if (isWrite && (result.exitCode === 124 || result.exitCode === 130))
      return { ok: false, code: "uncertain" };
    const atomicSheetWrite = request.capability === "google.sheets.write" && ["update_cells", "add_tab", "batch_update"].includes(request.operation);
    const rejection = atomicSheetWrite ? googleRejection(result.stderr ?? "") : null;
    if (rejection?.status === 400 || rejection?.status === 404) {
      return {
        ok: false,
        code: "failed",
        failureCode: "provider_rejected_no_write",
        message: `Google \u0432\u0456\u0434\u0445\u0438\u043B\u0438\u0432 \u0437\u0430\u043F\u0438\u0442 (HTTP ${rejection.status}) \u0456 \u043D\u0456\u0447\u043E\u0433\u043E \u043D\u0435 \u0437\u043C\u0456\u043D\u0438\u0432: \xAB${scrub(rejection.message)}\xBB. ` + "\u0412\u0438\u043F\u0440\u0430\u0432 \u0437\u0430\u043F\u0438\u0442 \u0437\u0430 \u0446\u0438\u043C \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u043D\u044F\u043C; \u0431\u0435\u0437 \u0437\u043C\u0456\u043D \u0439\u043E\u0433\u043E \u043D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439."
      };
    }
    const signInExpired = isWrite && googleSignInFailure(result.stderr ?? "");
    if (atomicSheetWrite && signInExpired)
      return signInRefused(result.stderr ?? "");
    if (isWrite) {
      return { ok: false, code: "uncertain", message: `${this.failureMessage(result.exitCode, result.stderr)} ` + "\u0417\u0430\u043F\u0438\u0441 \u043C\u0456\u0433 \u0432\u0438\u043A\u043E\u043D\u0430\u0442\u0438\u0441\u044F: \u043D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0439 \u0439\u043E\u0433\u043E \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E, \u0441\u043F\u0435\u0440\u0448\u0443 \u043F\u0435\u0440\u0435\u0432\u0456\u0440 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442." + (signInExpired ? " \u0421\u0445\u043E\u0436\u0435, \u0432\u0445\u0456\u0434 Google \u0434\u043B\u044F \u0446\u044C\u043E\u0433\u043E \u0440\u0435\u0441\u0443\u0440\u0441\u0443 \u043F\u0440\u043E\u0441\u0442\u0440\u043E\u0447\u0435\u043D\u043E \u0430\u0431\u043E \u0432\u0456\u0434\u043A\u043B\u0438\u043A\u0430\u043D\u043E: \u043C\u043E\u0436\u0435 \u0437\u043D\u0430\u0434\u043E\u0431\u0438\u0442\u0438\u0441\u044F \u0437\u0430\u043D\u043E\u0432\u043E \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0438 Google." : "") };
    }
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
  threadLabelResult(stdout) {
    try {
      const results = JSON.parse(stdout).results;
      if (!Array.isArray(results) || results.length === 0 || !results.every((row) => typeof row?.threadId === "string" && typeof row.success === "boolean"))
        throw new Error("shape");
      const failed = results.filter((row) => !row.success);
      if (failed.length === 0)
        return { ok: true, data: JSON.stringify({ changedThreads: results.length }) };
      return { ok: false, code: "failed", message: `\u0417\u043C\u0456\u043D\u0435\u043D\u043E ${results.length - failed.length} \u0437 ${results.length} \u043B\u0438\u0441\u0442\u0456\u0432. ` + `\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F: ${failed.slice(0, 10).map((row) => `${row.threadId} (${scrub(String(row.error ?? "")).slice(0, 120) || "\u0431\u0435\u0437 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u043D\u044F"})`).join("; ")}. ` + "\u041F\u043E\u0432\u0442\u043E\u0440\u0438 \u043B\u0438\u0448\u0435 \u0434\u043B\u044F \u0446\u0438\u0445 \u043B\u0438\u0441\u0442\u0456\u0432, \u044F\u043A\u0449\u043E \u043F\u0440\u0438\u0447\u0438\u043D\u0430 \u0443\u0441\u0443\u043D\u0435\u043D\u0430." };
    } catch {
      return { ok: false, code: "uncertain", message: "Google \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0432 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0437\u043C\u0456\u043D\u0438 \u044F\u0440\u043B\u0438\u043A\u0456\u0432. \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u043B\u0438\u0441\u0442\u0438 \u043F\u043E\u0448\u0443\u043A\u043E\u043C, \u043F\u0435\u0440\u0448 \u043D\u0456\u0436 \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0432\u0430\u0442\u0438." };
    }
  }
  failureMessage(exitCode, stderr) {
    const scrubbed = scrub(stderr ?? "");
    return scrubbed.length > 0 ? `Google CLI \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043F\u043E\u043C\u0438\u043B\u043A\u0443 (\u043A\u043E\u0434 ${exitCode}): ${scrubbed}` : `Google CLI \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043F\u043E\u043C\u0438\u043B\u043A\u0443 (\u043A\u043E\u0434 ${exitCode}) \u0431\u0435\u0437 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u043D\u044F.`;
  }
  argumentDenial(request) {
    const required = REQUIRED_ARGUMENTS[`${request.capability}:${request.operation}`];
    const supplied = Object.keys(request.arguments ?? {}).sort().join(", ") || "\u2014";
    const base = `\u0417\u0430\u043F\u0438\u0442 \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u043D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u0457 ` + `${request.capability}/${request.operation}. \u041D\u0430\u0434\u0430\u043D\u043E: ${supplied}.`;
    if (request.capability === "google.calendar.write") {
      return `${base} \u0414\u043B\u044F create \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 summary, from, to; \u0434\u043B\u044F update \u2014 eventId \u0456 \u0437\u043C\u0456\u043D\u0435\u043D\u0456 \u043F\u043E\u043B\u044F. from/to \u2014 \u0447\u0430\u0441 \u0456\u0437 \u0447\u0430\u0441\u043E\u0432\u0438\u043C \u0437\u043C\u0456\u0449\u0435\u043D\u043D\u044F\u043C. \u041D\u0435 start/end/title. \u041D\u0435\u043E\u0431\u043E\u0432\u2019\u044F\u0437\u043A\u043E\u0432\u0456: description, attendee, withMeet. \u041D\u0435 \u0434\u043E\u0434\u0430\u0432\u0430\u0439 \u0433\u043E\u0441\u0442\u0435\u0439 \u0431\u0435\u0437 \u043F\u0440\u044F\u043C\u043E\u0433\u043E \u043F\u0440\u043E\u0445\u0430\u043D\u043D\u044F.`;
    }
    if (request.capability === "google.docs.read" && request.operation === "get") {
      return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D docId; \u043D\u0435\u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u043E offset (\u0446\u0456\u043B\u0435 \u043D\u0435\u0432\u0456\u0434'\u0454\u043C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E) \u0410\u0411\u041E query (\u0442\u0435\u043A\u0441\u0442 \u0434\u043B\u044F \u043F\u043E\u0448\u0443\u043A\u0443).`;
    }
    if (request.capability === "google.sheets.read" && request.operation === "metadata") {
      return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D spreadsheetId; \u043D\u0435\u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u0438\u0439 offset \u2014 \u0446\u0456\u043B\u0435 \u043D\u0435\u0432\u0456\u0434'\u0454\u043C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E \u0437 nextOffset \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u043D\u044C\u043E\u0457 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456.`;
    }
    if (request.capability === "google.sheets.write" && ["batch_update", "update_cells"].includes(request.operation)) {
      const { arguments: args } = request;
      const spreadsheetId = text4(args.spreadsheetId, 256);
      const literalGuidance = request.operation === "update_cells" && exactKeys3(args, ["spreadsheetId", "range", "values"]) && spreadsheetId != null && GOOGLE_FILE_ID.test(spreadsheetId) && text4(args.range, 512) != null && hasOnlySheetsLiteralPrefixErrors(args.values) && JSON.stringify(args.values).length <= 1e4 ? " update_cells \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0454 USER_ENTERED: \u043F\u043E\u0447\u0430\u0442\u043A\u043E\u0432\u0456 =, +, -, @, \u043D\u0430\u0432\u0456\u0442\u044C \u043F\u0456\u0441\u043B\u044F \u043F\u0440\u043E\u0431\u0456\u043B\u0456\u0432, \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u044F\u044E\u0442\u044C\u0441\u044F \u044F\u043A \u043F\u043E\u0442\u0435\u043D\u0446\u0456\u0439\u043D\u0456 \u0444\u043E\u0440\u043C\u0443\u043B\u0438. \u042F\u043A\u0449\u043E \u043F\u043E\u0442\u0440\u0456\u0431\u0435\u043D \u0441\u0430\u043C\u0435 \u0431\u0443\u043A\u0432\u0430\u043B\u044C\u043D\u0438\u0439 \u0442\u0435\u043A\u0441\u0442, \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439 batch_update \u0437 updateCells \u0442\u0430 userEnteredValue.stringValue, \u044F\u043A\u0449\u043E \u0446\u044F \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u044F \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0430 \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443. \u0417\u0431\u0435\u0440\u0435\u0436\u0438 \u0442\u043E\u0447\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F. \u041D\u0435 \u0432\u0438\u0434\u0430\u043B\u044F\u0439 \u0456 \u043D\u0435 \u0437\u0430\u043C\u0456\u043D\u044E\u0439 \u0441\u0438\u043C\u0432\u043E\u043B\u0438 \u0437\u0430\u0440\u0430\u0434\u0438 \u043F\u0440\u043E\u0445\u043E\u0434\u0436\u0435\u043D\u043D\u044F \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0438." : "";
      return `${base} \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0443: ${required?.join(", ")}.${literalGuidance} \u0414\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0456 \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u0457 \u0437 \u0434\u0430\u043D\u0438\u043C\u0438/\u043E\u0444\u043E\u0440\u043C\u043B\u0435\u043D\u043D\u044F\u043C \u0456 \u0437\u0432\u0438\u0447\u0430\u0439\u043D\u0456 \u0444\u043E\u0440\u043C\u0443\u043B\u0438 \u0437 A1-\u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F\u043C\u0438. \u0417\u043E\u0432\u043D\u0456\u0448\u043D\u0456 \u0434\u0436\u0435\u0440\u0435\u043B\u0430, IMAGE/IMPORT*, \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F-\u0444\u0443\u043D\u043A\u0446\u0456\u0457, \u043D\u0435\u0432\u0456\u0434\u043E\u043C\u0456 \u0444\u0443\u043D\u043A\u0446\u0456\u0457 \u0442\u0430 \u0456\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0456 \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D\u0438/\u0432\u0438\u0440\u0430\u0437\u0438 \u043D\u0435 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456; \u0434\u043B\u044F \u0456\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u043E\u0433\u043E \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D\u0443 \u0432\u043A\u0430\u0436\u0438 \u044F\u0432\u043D\u0456 A1-\u043A\u043E\u043E\u0440\u0434\u0438\u043D\u0430\u0442\u0438. \u0424\u043E\u0440\u043C\u0443\u043B\u0438 \u043D\u0435 \u043F\u0435\u0440\u0435\u0442\u0432\u043E\u0440\u044E\u044E\u0442\u044C\u0441\u044F \u043D\u0430 \u0442\u0435\u043A\u0441\u0442. \u041B\u0456\u043C\u0456\u0442 JSON \u2014 11000 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432 \u0434\u043B\u044F batch_update, 10000 \u0434\u043B\u044F values.`;
    }
    if (request.capability === "google.gmail.modify" && request.operation === "modify") {
      return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 threadIds (1\u2013${GMAIL_THREADS_PER_CALL} \u0456\u0434\u0435\u043D\u0442\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440\u0456\u0432 \u043B\u0438\u0441\u0442\u0456\u0432 \u0437 gmail search) \u0456 \u0445\u043E\u0447\u0430 \u0431 \u043E\u0434\u043D\u0435 \u0437 add \u0430\u0431\u043E remove \u2014 \u043C\u0430\u0441\u0438\u0432\u0438 \u043D\u0430\u0437\u0432 \u0447\u0438 ID \u044F\u0440\u043B\u0438\u043A\u0456\u0432 \u0431\u0435\u0437 \u043A\u043E\u043C.`;
    }
    if (required?.includes("threadIds")) {
      return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D \u043B\u0438\u0448\u0435 threadIds: \u043C\u0430\u0441\u0438\u0432 \u0456\u0437 1\u2013${GMAIL_THREADS_PER_CALL} \u0456\u0434\u0435\u043D\u0442\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440\u0456\u0432 \u043B\u0438\u0441\u0442\u0456\u0432 \u0437 google.gmail.read/search, \u0431\u0435\u0437 \u043F\u043E\u0432\u0442\u043E\u0440\u0456\u0432.`;
    }
    if (required?.length === 0)
      return `${base} \u0426\u044F \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u044F \u043D\u0435 \u043F\u0440\u0438\u0439\u043C\u0430\u0454 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432.`;
    if (required == null)
      return `${base} \u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u043F\u0435\u0440\u0435\u043B\u0456\u043A \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432 \u0446\u0456\u0454\u0457 \u043E\u043F\u0435\u0440\u0430\u0446\u0456\u0457.`;
    return `${base} \u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 \u0440\u0456\u0432\u043D\u043E \u0442\u0430\u043A\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438: ${required.join(", ")}. ` + `\u041F\u043E\u0432\u0442\u043E\u0440\u0438 \u0437\u0430\u043F\u0438\u0442, \u0432\u043A\u0430\u0437\u0430\u0432\u0448\u0438 \u0457\u0445 \u0443\u0441\u0456 \u0439 \u043D\u0435 \u0434\u043E\u0434\u0430\u044E\u0447\u0438 \u0456\u043D\u0448\u0438\u0445.`;
  }
  async spreadsheetDenial(request, account, signal) {
    if (!["google.sheets.read", "google.sheets.write"].includes(request.capability))
      return null;
    if (request.capability === "google.sheets.write" && request.operation === "create") {
      return request.resource.config.allowCreate === true || allowedFolders(request.resource).length > 0 ? null : `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0442\u0430\u0431\u043B\u0438\u0446\u044C \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id} \u043D\u0435 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E (\u043F\u043E\u0442\u0440\u0456\u0431\u043D\u043E allowCreate=true).`;
    }
    if (wholeDrive(request.resource)) {
      const requested2 = request.arguments.spreadsheetId;
      return requested2 == null || typeof requested2 === "string" && GOOGLE_FILE_ID.test(requested2) ? null : "\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: spreadsheetId \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u043C \u0456\u0434\u0435\u043D\u0442\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440\u043E\u043C \u0442\u0430\u0431\u043B\u0438\u0446\u0456 Google.";
    }
    const sheets = [
      ...allowedSheets(request.resource),
      ...(allowedFolders(request.resource).length > 0 ? [] : this.createdSheetIds(request.resource.id)).filter((id2) => GOOGLE_FILE_ID.test(id2)).map((spreadsheetId) => ({ spreadsheetId, label: "Created by this resource" }))
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
    if (wholeDrive(request.resource))
      return null;
    const explicit = new Set([
      ...allowedSheets(request.resource).map((sheet) => sheet.spreadsheetId),
      ...this.permittedDriveFiles(request.resource).map((file2) => file2.id)
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
      return request.resource.config.allowCreate === true || allowedFolders(request.resource).length > 0 ? null : `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0456\u0432 \u0434\u043B\u044F \u0440\u0435\u0441\u0443\u0440\u0441\u0443 ${request.resource.id} \u043D\u0435 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E (\u043F\u043E\u0442\u0440\u0456\u0431\u043D\u043E allowCreate=true).`;
    }
    if (wholeDrive(request.resource)) {
      const field2 = docsOnly ? "docId" : "fileId";
      const requested2 = request.arguments[field2];
      return requested2 == null || typeof requested2 === "string" && GOOGLE_FILE_ID.test(requested2) ? null : `\u0412\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: ${field2} \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u043C \u0456\u0434\u0435\u043D\u0442\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440\u043E\u043C \u0444\u0430\u0439\u043B\u0430 Google.`;
    }
    const files = docsOnly ? [...allowedGoogleFiles(request.resource, "doc"), ...allowedFolders(request.resource).length > 0 ? [] : this.createdDocumentFiles(request.resource.id)] : this.permittedDriveFiles(request.resource);
    const folders = allowedFolders(request.resource);
    const exactId = request.arguments[docsOnly ? "docId" : "fileId"];
    if (folders.length === 0 && typeof exactId === "string" && GOOGLE_FILE_ID.test(exactId)) {
      let db;
      try {
        db = new Database5(join8(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
        if (createdGoogleFileAllowed(db, request.resource.id, exactId, docsOnly, this.allowDbSheetHistory))
          return null;
      } catch {} finally {
        db?.close();
      }
    }
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
    if (files.some((file2) => file2.id === requested))
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
        join8(this.home, "bin", "gog"),
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
    const files = new Map(allowedGoogleFiles(resource).map((file2) => [file2.id, file2]));
    if (allowedFolders(resource).length > 0)
      return [...files.values()];
    for (const file2 of this.createdSheetFiles(resource.id)) {
      if (!files.has(file2.id))
        files.set(file2.id, file2);
    }
    for (const file2 of this.createdDocumentFiles(resource.id)) {
      if (!files.has(file2.id))
        files.set(file2.id, file2);
    }
    let db;
    try {
      db = new Database5(join8(this.home, ".claude/channels/telegram/messages.db"), { readonly: true });
      for (const file2 of createdGoogleSlideFiles(db, resource.id)) {
        if (!files.has(file2.id))
          files.set(file2.id, file2);
      }
    } catch {} finally {
      db?.close();
    }
    return [...files.values()];
  }
  async mailAttachment(request, account, signal) {
    const args = request.arguments;
    const messageId = text4(args.messageId, 64), attachmentId = text4(args.attachmentId, 4096);
    const name = args.name == null ? "attachment" : text4(args.name, 200);
    if (Object.keys(args).some((key) => !["messageId", "attachmentId", "name"].includes(key)) || messageId == null || !GMAIL_THREAD_ID.test(messageId) || attachmentId == null || !/^[A-Za-z0-9_-]+$/.test(attachmentId) || name == null || name.includes("/") || name.startsWith(".")) {
      return { ok: false, code: "invalid", message: "attachment \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 messageId \u0456 attachmentId (\u0437 google.gmail.read/get), \u043D\u0435\u043E\u0431\u043E\u0432\u02BC\u044F\u0437\u043A\u043E\u0432\u043E name \u2014 \u043D\u0430\u0437\u0432\u0443 \u0444\u0430\u0439\u043B\u0430." };
    }
    const workspace = request.verified.workspace;
    if (workspaceIdentity(this.workspaceRoot, workspace) == null) {
      return { ok: false, code: "invalid", message: "\u0420\u043E\u0431\u043E\u0447\u0430 \u043F\u0430\u043F\u043A\u0430 \u0446\u0456\u0454\u0457 \u0440\u043E\u0437\u043C\u043E\u0432\u0438 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0430; \u0432\u043A\u043B\u0430\u0434\u0435\u043D\u043D\u044F \u043D\u0435 \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u043E." };
    }
    const folder = join8(this.home, ".cache", "corporate-gmail", randomBytes3(8).toString("hex"));
    try {
      mkdirSync3(folder, { recursive: true, mode: 448 });
      const out = join8(folder, "attachment");
      const result = await this.run({
        argv: [
          "/usr/bin/prlimit",
          `--fsize=${MAX_ATTACHMENT_BYTES}:${MAX_ATTACHMENT_BYTES}`,
          "--",
          join8(this.home, "bin", "gog"),
          "--no-input",
          "--json",
          "--readonly",
          "--enable-commands-exact=gmail.attachment",
          "gmail",
          "attachment",
          messageId,
          attachmentId,
          "--out",
          out
        ],
        cwd: this.home,
        env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
        timeoutMs: 120000
      }, signal);
      if (result.exitCode !== 0 || signal.aborted) {
        return googleSignInFailure(result.stderr) ? signInRefused(result.stderr) : { ok: false, code: "failed", message: "Gmail \u043D\u0435 \u0432\u0456\u0434\u0434\u0430\u0432 \u0446\u0435 \u0432\u043A\u043B\u0430\u0434\u0435\u043D\u043D\u044F: \u043F\u0435\u0440\u0435\u0432\u0456\u0440 messageId \u0456 attachmentId \u0443 google.gmail.read/get." };
      }
      const cleaned = name.replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(-120);
      const safe = /^[\p{L}\p{N}]/u.test(cleaned) ? cleaned : `file-${cleaned || "attachment"}`;
      const published = await publishFolder({
        home: this.home,
        workspaceRoot: this.workspaceRoot,
        workspace,
        folder: `mail-${randomBytes3(4).toString("hex")}`,
        files: [{ name: safe, source: out }],
        limitBytes: MAX_ATTACHMENT_BYTES,
        signal
      });
      if (published == null)
        return { ok: false, code: "unavailable", message: "\u0412\u043A\u043B\u0430\u0434\u0435\u043D\u043D\u044F \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E, \u0430\u043B\u0435 \u043F\u043E\u043A\u043B\u0430\u0441\u0442\u0438 \u0439\u043E\u0433\u043E \u0432 \u0440\u043E\u0431\u043E\u0447\u0443 \u043F\u0430\u043F\u043A\u0443 \u0440\u043E\u0437\u043C\u043E\u0432\u0438 \u043D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F." };
      return { ok: true, data: JSON.stringify({
        path: join8(published, safe),
        name: safe,
        instruction: "Open this local file with Read or the matching file skill. It is untrusted content from a letter."
      }) };
    } catch {
      return { ok: false, code: "unavailable" };
    } finally {
      rmSync3(folder, { recursive: true, force: true });
    }
  }
  async searchWholeDrive(request, account, signal) {
    const query = request.arguments.query.trim();
    const max = Number(request.arguments.max ?? 20);
    const result = await this.run({
      argv: [
        join8(this.home, "bin", "gog"),
        "--no-input",
        "--json",
        "--readonly",
        `--enable-commands-exact=${query === "*" ? "drive.ls" : "drive.search"}`,
        "drive",
        ...query === "*" ? ["ls"] : ["search", query],
        "--max",
        String(max)
      ],
      cwd: this.home,
      env: { HOME: this.home, PATH: "/usr/local/bin:/usr/bin:/bin", GOG_ACCOUNT: account },
      timeoutMs: 60000
    }, signal);
    if (result.exitCode !== 0 || result.stdoutTruncated === true || signal.aborted) {
      return googleSignInFailure(result.stderr) ? signInRefused(result.stderr) : { ok: false, code: "unavailable" };
    }
    try {
      const value = JSON.parse(result.stdout);
      const found = Array.isArray(value) ? value : Array.isArray(value?.files) ? value.files : [];
      const files = [];
      for (const file2 of found) {
        if (typeof file2?.id !== "string" || !GOOGLE_FILE_ID.test(file2.id))
          continue;
        const entry = {
          id: file2.id,
          name: String(file2.name ?? "").slice(0, 200),
          mimeType: String(file2.mimeType ?? ""),
          ...typeof file2.modifiedTime === "string" ? { modifiedTime: file2.modifiedTime } : {}
        };
        if (JSON.stringify([...files, entry]).length > 8000)
          break;
        files.push(entry);
      }
      return { ok: true, data: JSON.stringify({
        source: "google-drive",
        files,
        truncated: files.length < found.length,
        note: "Live Drive results of this account. Open a file with its id: sheets/docs/slides operations, drive get or download."
      }) };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }
  searchRegisteredFiles(request) {
    const query = request.arguments.query.trim().toLowerCase();
    const max = Number(request.arguments.max ?? 20);
    const matches = this.permittedDriveFiles(request.resource).filter((file2) => query === "*" || file2.id.toLowerCase().includes(query) || file2.label.toLowerCase().includes(query));
    const files = [];
    for (const file2 of matches.slice(0, max)) {
      const entry = { id: file2.id, name: file2.label, kind: file2.kind };
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
      "google.gmail.modify": "gmail",
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
      if (!exactKeys3(args, ["title", ...Object.hasOwn(args, "parentId") ? ["parentId"] : []]))
        return null;
      const title = text4(args.title, 512);
      return title == null ? null : ["create", title];
    }
    if (request.capability === "google.sheets.write" && request.operation === "add_tab") {
      if (!exactKeys3(args, ["spreadsheetId", "tabName"]))
        return null;
      const spreadsheetId = text4(args.spreadsheetId, 256);
      const tabName = text4(args.tabName, 512);
      return spreadsheetId == null || tabName == null || !GOOGLE_FILE_ID.test(spreadsheetId) ? null : ["add-tab", spreadsheetId, tabName];
    }
    if (request.capability === "google.gmail.send" && (request.operation === "send" || request.operation === "draft")) {
      const allowed = ["to", "subject", "body", "cc", "bcc", "html", "replyToMessageId", "attachments", "sha256"];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      const to = text4(args.to, 2000);
      const subject = text4(args.subject, 998, true);
      const body = letter(typeof args.html === "string" ? htmlText(args.html) : args.body, 50000);
      if (to == null || subject == null || body == null)
        return null;
      const result = [...request.operation === "draft" ? ["drafts", "create"] : ["send"], "--to", to, "--subject", subject, "--body", body];
      if (!optionalFlag(result, "--cc", args.cc, 2000) || !optionalFlag(result, "--bcc", args.bcc, 2000))
        return null;
      if (args.html != null) {
        const html = letter(args.html, 1e5);
        if (html == null)
          return null;
        result.push("--body-html", html);
      }
      if (args.replyToMessageId != null) {
        const id2 = text4(args.replyToMessageId, 64);
        if (id2 == null || !GMAIL_THREAD_ID.test(id2))
          return null;
        result.push("--reply-to-message-id", id2);
      }
      if (args.attachments == null !== (args.sha256 == null))
        return null;
      return result;
    }
    if (request.capability === "google.calendar.write") {
      const calendarId = text4(request.resource.config.calendarId ?? "primary", 254);
      if (calendarId == null)
        return null;
      if (request.operation === "create") {
        const allowed = ["summary", "from", "to", "attendee", "description", "withMeet"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          return null;
        const summary = text4(args.summary, 998, true);
        const from = text4(args.from, 64);
        const to = text4(args.to, 64);
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
        const eventId = text4(args.eventId, 512);
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
      if (request.operation === "delete") {
        if (Object.keys(args).some((key) => !["eventId", "summary"].includes(key)))
          return null;
        const eventId = text4(args.eventId, 512);
        if (eventId == null || !/^[A-Za-z0-9_@.-]+$/.test(eventId) || args.summary != null && text4(args.summary, 998, true) == null)
          return null;
        return ["delete", calendarId, eventId, "--force"];
      }
      return null;
    }
    if (request.capability === "google.sheets.write" && request.operation === "update_cells") {
      if (!exactKeys3(args, ["spreadsheetId", "range", "values"]))
        return null;
      const spreadsheetId = text4(args.spreadsheetId, 256);
      const range = text4(args.range, 512);
      if (spreadsheetId == null || range == null || !GOOGLE_FILE_ID.test(spreadsheetId) || !validSheetsValues(args.values))
        return null;
      const valuesJson = JSON.stringify(args.values);
      if (valuesJson.length > 1e4)
        return null;
      return ["update", spreadsheetId, range, "--values-json", valuesJson, "--input", "USER_ENTERED"];
    }
    if (request.capability === "google.contacts.write") {
      if (request.operation === "delete") {
        const resourceName = exactKeys3(args, ["resourceName"]) ? text4(args.resourceName, 512) : null;
        return resourceName == null || !/^people\/[A-Za-z0-9_-]{1,200}$/.test(resourceName) ? null : ["delete", resourceName, "--force"];
      }
      const allowed = ["resourceName", "given", "family", "email", "phone"];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      if (request.operation !== "create" && request.operation !== "update")
        return null;
      const result = [request.operation];
      if (request.operation === "update") {
        const resourceName = text4(args.resourceName, 512);
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
        const tasklistId = text4(args.tasklistId, 512);
        const title = text4(args.title, 1024, true);
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
        const tasklistId = text4(args.tasklistId, 512);
        const taskId = text4(args.taskId, 512);
        if (tasklistId == null || taskId == null)
          return null;
        const result = ["update", tasklistId, taskId];
        if (!optionalFlag(result, "--title", args.title, 1024) || !optionalFlag(result, "--due", args.due, 64) || !optionalFlag(result, "--notes", args.notes, 4000))
          return null;
        return result.length > 3 ? result : null;
      }
      if (request.operation === "complete" && exactKeys3(args, ["tasklistId", "taskId"])) {
        const tasklistId = text4(args.tasklistId, 512);
        const taskId = text4(args.taskId, 512);
        return tasklistId == null || taskId == null ? null : ["done", tasklistId, taskId];
      }
      if (request.operation === "delete" && exactKeys3(args, ["tasklistId", "taskId"])) {
        const tasklistId = text4(args.tasklistId, 512);
        const taskId = text4(args.taskId, 512);
        return tasklistId == null || taskId == null ? null : ["delete", tasklistId, taskId, "--force"];
      }
      return null;
    }
    if (request.capability === "google.gmail.modify") {
      if (request.operation === "create_label") {
        if (!exactKeys3(args, ["name"]))
          return null;
        const name = text4(args.name, 225);
        return name == null || name.trim() !== name ? null : ["labels", "create", name];
      }
      const allowed = request.operation === "modify" ? ["threadIds", "add", "remove"] : ["threadIds"];
      if (!["modify", "archive", "trash"].includes(request.operation) || Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      const threadIds = gmailThreadIds(args.threadIds);
      if (threadIds == null)
        return null;
      if (request.operation === "archive")
        return ["labels", "modify", ...threadIds, "--remove", "INBOX"];
      if (request.operation === "trash")
        return ["labels", "modify", ...threadIds, "--add", "TRASH", "--remove", "INBOX"];
      const add = args.add == null ? null : gmailLabels(args.add);
      const remove = args.remove == null ? null : gmailLabels(args.remove);
      if (args.add != null && add == null || args.remove != null && remove == null || add == null && remove == null)
        return null;
      return ["labels", "modify", ...threadIds, ...add == null ? [] : ["--add", add], ...remove == null ? [] : ["--remove", remove]];
    }
    if (request.capability === "google.gmail.read") {
      if (request.operation === "labels")
        return exactKeys3(args, []) ? ["labels", "list"] : null;
      if (request.operation === "search") {
        if (!exactKeys3(args, Object.hasOwn(args, "max") ? ["query", "max"] : ["query"]))
          return null;
        const query = text4(args.query, 2000);
        const max = boundedInt(args.max, 10, 50);
        return query != null && max != null ? ["search", query, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["messageId"])) {
        const id2 = text4(args.messageId, 256);
        return id2 == null ? null : ["get", id2];
      }
      return null;
    }
    if (request.capability === "google.calendar.read") {
      const calendarId = text4(request.resource.config.calendarId ?? "primary", 254);
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
        const eventId = text4(args.eventId, 512);
        return eventId == null ? null : ["event", calendarId, eventId];
      }
      return null;
    }
    if (request.capability === "google.drive.share" && request.operation === "share") {
      if (!exactKeys3(args, ["fileId", "email", "role"]))
        return null;
      const fileId = text4(args.fileId, 256);
      const email = text4(args.email, 254);
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
        const query = text4(args.query, 2000);
        const max = boundedInt(args.max, 20, 100);
        return query != null && max != null ? ["search", query, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["fileId"])) {
        const fileId = text4(args.fileId, 256);
        return fileId == null ? null : ["get", fileId];
      }
      return null;
    }
    if (request.capability === "google.docs.write") {
      if (request.operation === "create") {
        if (!exactKeys3(args, ["title", ...Object.hasOwn(args, "parentId") ? ["parentId"] : []]))
          return null;
        const title = text4(args.title, 512);
        return title == null ? null : ["create", title];
      }
      if (request.operation === "replace" || request.operation === "append") {
        if (!exactKeys3(args, ["docId", "content"]))
          return null;
        const docId = text4(args.docId, 256);
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
      if (Object.keys(args).some((k) => !["docId", "offset", "query"].includes(k)) || Object.hasOwn(args, "offset") && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0) || Object.hasOwn(args, "query") && (text4(args.query, 200) == null || !String(args.query).trim()) || Object.hasOwn(args, "offset") && Object.hasOwn(args, "query"))
        return null;
      const docId = text4(args.docId, 256);
      return docId == null ? null : ["cat", docId, "--max-bytes=2097152"];
    }
    if (request.capability === "google.sheets.read" && request.operation === "metadata") {
      if (!exactKeys3(args, Object.hasOwn(args, "offset") ? ["spreadsheetId", "offset"] : ["spreadsheetId"]))
        return null;
      const spreadsheetId = text4(args.spreadsheetId, 256);
      const offset = Object.hasOwn(args, "offset") ? args.offset : 0;
      return spreadsheetId == null || !GOOGLE_FILE_ID.test(spreadsheetId) || !Number.isSafeInteger(offset) || Number(offset) < 0 ? null : ["metadata", spreadsheetId];
    }
    if (request.capability === "google.sheets.read" && request.operation === "read_format") {
      if (!exactKeys3(args, ["spreadsheetId", "range"]))
        return null;
      const spreadsheetId = text4(args.spreadsheetId, 256);
      const range = text4(args.range, 512);
      return spreadsheetId == null || range == null || !GOOGLE_FILE_ID.test(spreadsheetId) ? null : ["read-format", spreadsheetId, range, "--effective"];
    }
    if (request.capability === "google.sheets.read" && request.operation === "read_layout") {
      if (!exactKeys3(args, ["spreadsheetId", "range"]))
        return null;
      const spreadsheetId = text4(args.spreadsheetId, 256);
      const range = text4(args.range, 512);
      if (spreadsheetId == null || range == null || !GOOGLE_FILE_ID.test(spreadsheetId))
        return null;
      return ["call", "sheets", "v4", "spreadsheets.get", "--params", JSON.stringify({
        spreadsheetId,
        ranges: [range],
        fields: "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)),data(startRow,startColumn,rowMetadata(pixelSize,hiddenByUser),columnMetadata(pixelSize,hiddenByUser)))"
      }), "--scope", "https://www.googleapis.com/auth/spreadsheets.readonly"];
    }
    if (request.capability === "google.sheets.read" && request.operation === "get" && exactKeys3(args, ["spreadsheetId", "range"])) {
      const spreadsheetId = text4(args.spreadsheetId, 256);
      const range = text4(args.range, 512);
      return spreadsheetId == null || range == null ? null : ["get", spreadsheetId, range];
    }
    if (request.capability === "google.contacts.read") {
      if (request.operation === "search") {
        if (!exactKeys3(args, Object.hasOwn(args, "max") ? ["query", "max"] : ["query"]))
          return null;
        const query = text4(args.query, 1000);
        const max = boundedInt(args.max, 10, 50);
        return query != null && max != null ? ["search", query, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["resourceName"])) {
        const resourceName = text4(args.resourceName, 512);
        return resourceName == null ? null : ["get", resourceName];
      }
      return null;
    }
    if (request.capability === "google.tasks.read") {
      if (request.operation === "list") {
        if (!exactKeys3(args, Object.hasOwn(args, "max") ? ["tasklistId", "max"] : ["tasklistId"]))
          return null;
        const tasklistId = text4(args.tasklistId, 512);
        const max = boundedInt(args.max, 20, 100);
        return tasklistId != null && max != null ? ["list", tasklistId, "--max", String(max)] : null;
      }
      if (request.operation === "get" && exactKeys3(args, ["tasklistId", "taskId"])) {
        const tasklistId = text4(args.tasklistId, 512);
        const taskId = text4(args.taskId, 512);
        return tasklistId == null || taskId == null ? null : ["get", tasklistId, taskId];
      }
      return null;
    }
    if (request.capability === "google.analytics.read" && request.operation === "report") {
      const allowed = ["property", "startDate", "endDate", "metrics", "dimensions", "limit"];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        return null;
      const property = text4(args.property ?? request.resource.config.property, 128);
      if (request.resource.config.property != null && property !== text4(request.resource.config.property, 128))
        return null;
      const startDate = text4(args.startDate, 32);
      const endDate = text4(args.endDate, 32);
      const metrics = text4(args.metrics, 1000);
      const dimensions = args.dimensions == null ? null : text4(args.dimensions, 1000);
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
      const siteUrl = text4(args.siteUrl ?? request.resource.config.siteUrl, 2000);
      if (request.resource.config.siteUrl != null && siteUrl !== text4(request.resource.config.siteUrl, 2000))
        return null;
      const startDate = text4(args.startDate, 32);
      const endDate = text4(args.endDate, 32);
      const dimensions = text4(args.dimensions, 1000);
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
      for (const key of ["id", "draftId", "eventId", "resourceName", "taskId", "spreadsheetId", "documentId"]) {
        if (typeof value[key] === "string" && value[key].length <= 512) {
          return value[key];
        }
      }
      const file2 = value.file;
      if (file2 != null && typeof file2.id === "string" && GOOGLE_FILE_ID.test(file2.id))
        return file2.id;
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

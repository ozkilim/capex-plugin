#!/usr/bin/env node
// Deterministically generate a synthetic JS project used as the benchmark
// fixture. No randomness -> reproducible token/cost numbers across runs.
//
// The project is shaped to exercise exactly the patterns CAPEX optimizes:
//   - many files import a shared `logger`        -> Search beats Grep+Read
//   - `computeTotal` is defined + called widely  -> one batched Edit beats N
//   - service files are padded with doc comments -> signatures_only beats full read
//
// Usage: node make-fixture.js <destDir>
import fs from "node:fs";
import path from "node:path";

const dest = path.resolve(process.argv[2] || path.join(process.cwd(), "fixture-out"));
// Optional: generate N extra modules under src/mod/ to scale the repo up.
// Each module imports `logger` and calls `computeTotal`, so a larger N means
// more Search matches and more rename sites — the regime where CAPEX should win.
const modArgIdx = process.argv.indexOf("--modules");
const MODULES = modArgIdx >= 0 ? Number(process.argv[modArgIdx + 1]) || 0 : 0;

function w(rel, body) {
  const abs = path.join(dest, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body.replace(/^\n/, ""));
}

// Padding so files are non-trivial and signatures_only is a real win.
function banner(title) {
  return `/* ${"-".repeat(60)}
 * ${title}
 * Part of the demo billing/orders service. The body of each function
 * is intentionally verbose so that reading full files costs materially
 * more tokens than reading exported signatures only.
 * ${"-".repeat(60)} */\n`;
}

w("package.json", `\n{
  "name": "bench-fixture",
  "version": "1.0.0",
  "type": "module",
  "private": true
}\n`);

w("README.md", `\n# Bench fixture\nSynthetic project for the CAPEX A/B benchmark. Do not edit by hand.\n`);

w("src/util/logger.js", `
${banner("logger")}
export const logger = {
  info: (...a) => console.log("[info]", ...a),
  warn: (...a) => console.warn("[warn]", ...a),
  error: (...a) => console.error("[error]", ...a),
};
export function withPrefix(prefix) {
  return {
    info: (...a) => logger.info(prefix, ...a),
    warn: (...a) => logger.warn(prefix, ...a),
    error: (...a) => logger.error(prefix, ...a),
  };
}
`);

w("src/util/money.js", `
${banner("money helpers")}
import { logger } from "./logger.js";

// Core helper that several services call.
export function computeTotal(items, taxRate = 0) {
  logger.info("computeTotal", items.length, "items");
  const subtotal = items.reduce((acc, it) => acc + it.price * it.qty, 0);
  const tax = subtotal * taxRate;
  return Math.round((subtotal + tax) * 100) / 100;
}
export function formatUSD(n) {
  return "$" + Number(n).toFixed(2);
}
export function applyDiscount(total, pct) {
  return Math.round(total * (1 - pct / 100) * 100) / 100;
}
`);

const services = {
  "orders.js": `
${banner("orders service")}
import { logger } from "../util/logger.js";
import { computeTotal, formatUSD } from "../util/money.js";

export function createOrder(customer, items) {
  logger.info("createOrder", customer.id);
  const total = computeTotal(items, 0.08);
  return { customer, items, total, label: formatUSD(total) };
}
export function refundOrder(order) {
  logger.warn("refundOrder", order.customer.id);
  return { ...order, refunded: true };
}
export function summarize(order) {
  return order.customer.name + " owes " + formatUSD(order.total);
}
`,
  "cart.js": `
${banner("cart service")}
import { logger } from "../util/logger.js";
import { computeTotal, applyDiscount } from "../util/money.js";

export function cartTotal(cart) {
  logger.info("cartTotal", cart.id);
  const total = computeTotal(cart.lines, 0.08);
  return applyDiscount(total, cart.discountPct || 0);
}
export function addLine(cart, line) {
  cart.lines.push(line);
  return cart;
}
`,
  "invoice.js": `
${banner("invoice service")}
import { computeTotal } from "../util/money.js";

export function buildInvoice(account, lineItems) {
  const total = computeTotal(lineItems, account.taxRate);
  return { account: account.id, total, due: true };
}
export function markPaid(invoice) {
  return { ...invoice, due: false };
}
`,
  "users.js": `
${banner("users service")}
import { logger } from "../util/logger.js";

export function createUser(name, email) {
  logger.info("createUser", email);
  return { id: cryptoId(), name, email };
}
export function deactivate(user) {
  logger.warn("deactivate", user.id);
  return { ...user, active: false };
}
function cryptoId() {
  return Math.abs(Date.now() ^ 0x9e3779b9).toString(16);
}
`,
  "reporting.js": `
${banner("reporting service")}
import { logger } from "../util/logger.js";
import { formatUSD } from "../util/money.js";

export function dailyReport(orders) {
  logger.info("dailyReport", orders.length);
  const gross = orders.reduce((a, o) => a + o.total, 0);
  return { count: orders.length, gross, label: formatUSD(gross) };
}
export function topCustomer(orders) {
  return orders.slice().sort((a, b) => b.total - a.total)[0] || null;
}
`,
};
for (const [name, body] of Object.entries(services)) w("src/services/" + name, body);

// A couple of models without logger, as noise so Search has to discriminate.
w("src/models/customer.js", `
${banner("customer model")}
export function Customer(id, name) {
  return { id, name, createdAt: 0 };
}
export function isVip(customer) {
  return customer.lifetimeSpend > 10000;
}
`);
w("src/models/product.js", `
${banner("product model")}
export function Product(sku, price) {
  return { sku, price, qty: 0 };
}
`);

w("src/index.js", `
${banner("entrypoint")}
import { logger } from "./util/logger.js";
import { createOrder } from "./services/orders.js";
import { cartTotal } from "./services/cart.js";

logger.info("boot");
export { createOrder, cartTotal };
`);

// Scale-up modules. Verbose bodies so full-file reads cost materially more
// than signatures, and computeTotal/logger appear in every one.
for (let i = 0; i < MODULES; i++) {
  const id = String(i).padStart(3, "0");
  w(`src/mod/mod${id}.js`, `
${banner("generated module " + id)}
import { logger } from "../util/logger.js";
import { computeTotal, formatUSD } from "../util/money.js";

export function handle${id}(items) {
  logger.info("handle${id}", items.length);
  const total = computeTotal(items, 0.0${(i % 9) + 1});
  return { id: "${id}", total, label: formatUSD(total) };
}
export function aux${id}(x) {
  // padding to make full reads expensive relative to signatures_only
  const scaled = x * ${i + 2};
  const adjusted = scaled - (scaled % 3);
  return adjusted > 0 ? adjusted : 0;
}
export function describe${id}() {
  return "module ${id} computes totals via computeTotal";
}
`);
}

console.log("fixture written to", dest, MODULES ? `(+${MODULES} modules)` : "");

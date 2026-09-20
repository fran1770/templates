/**
 * db.js — Laundry Admin data layer
 * ---------------------------------------------------------------
 * This app is meant to be hosted on GitHub Pages, which only serves
 * static files (no server, no PHP/Node, no SQL server reachable from
 * the browser). So the "database" here is IndexedDB: a real,
 * transactional, indexed database that ships inside every browser.
 *
 * It is deliberately wrapped behind a small class with plain async
 * methods (getOrders, addOrder, updateOrder, ...) so that later, if
 * this grows a real backend (Firebase, Supabase, a Node API), only
 * this file needs to change — nothing in app.js talks to IndexedDB
 * directly.
 *
 * Schema
 * ------
 * Database: LaundryAdminDB (version 1)
 *
 * Store: orders (keyPath: "id")
 *   id                 string (uuid)
 *   orderNo            string   e.g. "OR-0001"      [unique index]
 *   customerName       string                        [index]
 *   contactNumber      string
 *   serviceType        string
 *   weightKg           number
 *   pricePerKilo       number
 *   additionalCharge   number
 *   additionalChargeNote string
 *   totalAmount        number   weightKg*pricePerKilo + additionalCharge
 *   paymentStatus      "unpaid" | "partial" | "paid"
 *   amountPaid         number
 *   cashReceived       number | null   optional, from the checkout change calculator
 *   status             "pending"|"washing"|"drying"|"folding"|"ready"|"claimed"|"cancelled"  [index]
 *   statusHistory      Array<{status, at}>
 *   dateReceived       ISO string
 *   pickupDeadline     ISO string                    [index]
 *   dateClaimed        ISO string | null
 *   notes              string
 *   createdAt          ISO string
 *   updatedAt          ISO string
 *
 * Store: settings (keyPath: "key")
 *   key "general" -> { businessName, currencySymbol, defaultPricePerKilo,
 *                       orderPrefix, orderCounter, theme }
 */

const DB_NAME = "LaundryAdminDB";
const DB_VERSION = 1;
const STORE_ORDERS = "orders";
const STORE_SETTINGS = "settings";

class LaundryDB {
  constructor() {
    this._db = null;
    this._ready = null;
  }

  /** Open (and if needed, create/upgrade) the database. Safe to call many times. */
  init() {
    if (this._ready) return this._ready;

    this._ready = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_ORDERS)) {
          const orders = db.createObjectStore(STORE_ORDERS, { keyPath: "id" });
          orders.createIndex("by_orderNo", "orderNo", { unique: true });
          orders.createIndex("by_status", "status", { unique: false });
          orders.createIndex("by_pickupDeadline", "pickupDeadline", { unique: false });
          orders.createIndex("by_customerName", "customerName", { unique: false });
          orders.createIndex("by_createdAt", "createdAt", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        resolve(this._db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });

    return this._ready;
  }

  _tx(storeName, mode = "readonly") {
    return this._db.transaction(storeName, mode).objectStore(storeName);
  }

  _wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------

  async getSettings() {
    await this.init();
    const existing = await this._wrap(this._tx(STORE_SETTINGS).get("general"));
    if (existing) return existing;

    const defaults = {
      key: "general",
      businessName: "Suds & Co. Laundry",
      currencySymbol: "₱",
      defaultPricePerKilo: 45,
      orderPrefix: "OR",
      orderCounter: 0,
      theme: "light",
    };
    await this._wrap(this._tx(STORE_SETTINGS, "readwrite").put(defaults));
    return defaults;
  }

  async saveSettings(partial) {
    await this.init();
    const current = await this.getSettings();
    const merged = { ...current, ...partial, key: "general" };
    await this._wrap(this._tx(STORE_SETTINGS, "readwrite").put(merged));
    return merged;
  }

  async _nextOrderNo() {
    const settings = await this.getSettings();
    const counter = (settings.orderCounter || 0) + 1;
    await this.saveSettings({ orderCounter: counter });
    const padded = String(counter).padStart(4, "0");
    return `${settings.orderPrefix || "OR"}-${padded}`;
  }

  // ---------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------

  async getAllOrders() {
    await this.init();
    const all = await this._wrap(this._tx(STORE_ORDERS).getAll());
    return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async getOrder(id) {
    await this.init();
    return this._wrap(this._tx(STORE_ORDERS).get(id));
  }

  async addOrder(data) {
    await this.init();
    const now = new Date().toISOString();
    const orderNo = await this._nextOrderNo();

    const order = {
      id: (crypto.randomUUID && crypto.randomUUID()) || `ord_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      orderNo,
      customerName: data.customerName.trim(),
      contactNumber: data.contactNumber?.trim() || "",
      serviceType: data.serviceType || "Wash & Fold",
      weightKg: Number(data.weightKg),
      pricePerKilo: Number(data.pricePerKilo),
      additionalCharge: Number(data.additionalCharge) || 0,
      additionalChargeNote: data.additionalChargeNote?.trim() || "",
      totalAmount: Number(data.totalAmount),
      paymentStatus: data.paymentStatus || "unpaid",
      amountPaid: Number(data.amountPaid) || 0,
      cashReceived: data.cashReceived != null && data.cashReceived !== "" ? Number(data.cashReceived) : null,
      status: "pending",
      statusHistory: [{ status: "pending", at: now }],
      dateReceived: data.dateReceived || now,
      pickupDeadline: data.pickupDeadline,
      dateClaimed: null,
      notes: data.notes?.trim() || "",
      createdAt: now,
      updatedAt: now,
    };

    await this._wrap(this._tx(STORE_ORDERS, "readwrite").add(order));
    return order;
  }

  async updateOrder(id, patch) {
    await this.init();
    const existing = await this.getOrder(id);
    if (!existing) throw new Error("Order not found");

    const updated = {
      ...existing,
      ...patch,
      id: existing.id,
      orderNo: existing.orderNo,
      updatedAt: new Date().toISOString(),
    };

    await this._wrap(this._tx(STORE_ORDERS, "readwrite").put(updated));
    return updated;
  }

  async setOrderStatus(id, newStatus) {
    await this.init();
    const existing = await this.getOrder(id);
    if (!existing) throw new Error("Order not found");

    const now = new Date().toISOString();
    const history = Array.isArray(existing.statusHistory) ? existing.statusHistory.slice() : [];
    history.push({ status: newStatus, at: now });

    const patch = {
      status: newStatus,
      statusHistory: history,
      updatedAt: now,
    };
    if (newStatus === "claimed") patch.dateClaimed = now;
    if (newStatus !== "claimed") patch.dateClaimed = existing.dateClaimed || null;

    const updated = { ...existing, ...patch };
    await this._wrap(this._tx(STORE_ORDERS, "readwrite").put(updated));
    return updated;
  }

  async deleteOrder(id) {
    await this.init();
    await this._wrap(this._tx(STORE_ORDERS, "readwrite").delete(id));
    return true;
  }

  // ---------------------------------------------------------------
  // Backup / restore — since data lives in this one browser only,
  // export/import is the "sync between devices" story for now.
  // ---------------------------------------------------------------

  async exportData() {
    await this.init();
    const orders = await this.getAllOrders();
    const settings = await this.getSettings();
    return {
      _type: "laundry-admin-backup",
      _version: DB_VERSION,
      exportedAt: new Date().toISOString(),
      orders,
      settings,
    };
  }

  async importData(payload) {
    await this.init();
    if (!payload || !Array.isArray(payload.orders)) {
      throw new Error("That file doesn't look like a Laundry Admin backup.");
    }

    const ordersStore = this._tx(STORE_ORDERS, "readwrite");
    await this._wrap(ordersStore.clear());
    for (const order of payload.orders) {
      // eslint-disable-next-line no-await-in-loop
      await this._wrap(this._tx(STORE_ORDERS, "readwrite").put(order));
    }

    if (payload.settings) {
      await this._wrap(this._tx(STORE_SETTINGS, "readwrite").put({ ...payload.settings, key: "general" }));
    }

    return true;
  }

  async clearAll() {
    await this.init();
    await this._wrap(this._tx(STORE_ORDERS, "readwrite").clear());
    await this._wrap(this._tx(STORE_SETTINGS, "readwrite").clear());
    return true;
  }
}

// Single shared instance used across the app.
const db = new LaundryDB();

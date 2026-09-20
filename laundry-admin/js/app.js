/**
 * app.js — Laundry Admin UI logic
 * All persistence goes through the shared `db` instance from db.js.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------
  const STATUS_FLOW = ["pending", "washing", "drying", "folding", "ready", "claimed"];
  const STATUS_LABELS = {
    pending: "Pending",
    washing: "Washing",
    drying: "Drying",
    folding: "Folding",
    ready: "Ready for pickup",
    claimed: "Claimed",
    cancelled: "Cancelled",
  };
  const STATUS_SHORT = {
    pending: "Pending",
    washing: "Washing",
    drying: "Drying",
    folding: "Folding",
    ready: "Ready",
    claimed: "Claimed",
    cancelled: "Cancelled",
  };

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let orders = [];
  let settings = null;
  let currentView = "dashboard";
  let confirmCallback = null;

  let salesPeriod = "day";
  let salesRange = { from: "", to: "" };
  let ordersPeriod = "day";
  let ordersRange = { from: "", to: "" };

  // ---------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // ---------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------
  function money(amount) {
    const symbol = settings?.currencySymbol || "₱";
    const n = Number(amount) || 0;
    return `${symbol}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatDateDisplay(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = new Date();
    const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleString("en-US", opts);
  }

  function toInputLocal(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function isSameLocalDay(isoA, dateB) {
    const a = new Date(isoA);
    return a.getFullYear() === dateB.getFullYear() && a.getMonth() === dateB.getMonth() && a.getDate() === dateB.getDate();
  }

  function humanizeDuration(ms) {
    const abs = Math.abs(ms);
    const mins = Math.round(abs / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? `${days}d ${remHours}h` : `${days}d`;
  }

  function relativeDeadline(order) {
    if (order.status === "claimed") return { text: "Picked up", cls: "rel-done" };
    if (order.status === "cancelled") return { text: "Cancelled", cls: "rel-done" };
    const now = new Date();
    const diff = new Date(order.pickupDeadline) - now;
    if (diff < 0) {
      if (order.status === "ready") return { text: `Late by ${humanizeDuration(diff)}`, cls: "rel-late" };
      return { text: `Overdue by ${humanizeDuration(diff)}`, cls: "rel-overdue" };
    }
    if (diff < 6 * 3600 * 1000) return { text: `Due in ${humanizeDuration(diff)}`, cls: "rel-soon" };
    return { text: `In ${humanizeDuration(diff)}`, cls: "rel-ok" };
  }

  // "Overdue" = still being processed (not ready yet) and past its deadline —
  // a shop-side problem. "Late for pickup" = washed and ready, customer just
  // hasn't collected it yet — a separate, lower-urgency indicator.
  function isProcessingOverdue(order) {
    return !["ready", "claimed", "cancelled"].includes(order.status) && new Date(order.pickupDeadline) < new Date();
  }
  function isLateForPickup(order) {
    return order.status === "ready" && new Date(order.pickupDeadline) < new Date();
  }

  // ---------------------------------------------------------------
  // Date period helpers (day / week / month / custom range) — shared by
  // the dashboard Sales panel and the Orders tab date filter.
  // ---------------------------------------------------------------
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
  function startOfWeek(d) {
    const x = startOfDay(d);
    const day = x.getDay(); // 0 = Sun ... 6 = Sat
    const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
    x.setDate(x.getDate() + diff);
    return x;
  }
  function endOfWeek(d) {
    const s = startOfWeek(d);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return endOfDay(e);
  }
  function startOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setHours(0, 0, 0, 0); return x; }
  function endOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth() + 1, 0); x.setHours(23, 59, 59, 999); return x; }

  // Parses a <input type="date"> value ("YYYY-MM-DD") as a LOCAL date,
  // avoiding the UTC-midnight parsing that plain `new Date(str)` would do.
  function parseDateInput(str) {
    if (!str) return null;
    const [y, m, d] = str.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function toInputDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function getPeriodRange(period, fromStr, toStr) {
    const now = new Date();
    switch (period) {
      case "week":
        return { start: startOfWeek(now), end: endOfWeek(now) };
      case "month":
        return { start: startOfMonth(now), end: endOfMonth(now) };
      case "range": {
        const from = parseDateInput(fromStr) || now;
        const to = parseDateInput(toStr) || now;
        return { start: startOfDay(from), end: endOfDay(to) };
      }
      case "day":
      default:
        return { start: startOfDay(now), end: endOfDay(now) };
    }
  }

  function withinRange(iso, start, end) {
    const t = new Date(iso).getTime();
    return t >= start.getTime() && t <= end.getTime();
  }

  function formatShortDate(date) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function periodLabelText(period, start, end) {
    if (period === "day") return "Today";
    if (period === "week") return `This week · ${formatShortDate(start)} – ${formatShortDate(end)}`;
    if (period === "month") return start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return `${formatShortDate(start)} – ${formatShortDate(end)}`;
  }

  // ---------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------
  const ICONS = {
    success: '<svg viewBox="0 0 24 24"><use href="#icon-check"/></svg>',
    error: '<svg viewBox="0 0 24 24"><use href="#icon-x"/></svg>',
    info: '<svg viewBox="0 0 24 24"><use href="#icon-tag"/></svg>',
  };

  function showToast(message, type = "info") {
    const stack = $("#toast-stack");
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-icon">${ICONS[type] || ICONS.info}</span><span>${escapeHtml(message)}</span>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  // ---------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------
  function setButtonLoading(btn, isLoading) {
    if (!btn) return;
    btn.classList.toggle("is-loading", isLoading);
    btn.disabled = isLoading;
  }

  function skeletonRows(count, cols) {
    let html = "";
    for (let i = 0; i < count; i++) {
      html += "<tr>";
      for (let c = 0; c < cols; c++) {
        html += `<td><span class="skeleton-cell" style="width:${55 + ((i * 13 + c * 17) % 40)}%"></span></td>`;
      }
      html += "</tr>";
    }
    return html;
  }

  // ---------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------
  function openModal(id) {
    $(`#${id}`).hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeModal(id) {
    $(`#${id}`).hidden = true;
    if (!$$(".modal-overlay").some((m) => !m.hidden)) document.body.style.overflow = "";
  }
  function closeAllModals() {
    $$(".modal-overlay").forEach((m) => (m.hidden = true));
    document.body.style.overflow = "";
  }

  function openConfirm({ title, message, confirmLabel = "Confirm", danger = true, onConfirm }) {
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    const btn = $("#confirm-action-btn");
    btn.textContent = confirmLabel;
    btn.className = danger ? "btn btn-danger" : "btn btn-primary";
    confirmCallback = onConfirm;
    openModal("modal-confirm");
  }

  $("#confirm-action-btn").addEventListener("click", async () => {
    const btn = $("#confirm-action-btn");
    if (!confirmCallback) return closeModal("modal-confirm");
    setButtonLoading(btn, true);
    try {
      await confirmCallback();
    } finally {
      setButtonLoading(btn, false);
      closeModal("modal-confirm");
    }
  });

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------
  function switchView(view) {
    currentView = view;
    $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
    $$(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
    $$(".mobile-nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
    if (view === "orders") renderOrdersView();
    if (view === "dashboard") renderDashboard();
    if (view === "settings") fillSettingsForm();
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  // ---------------------------------------------------------------
  // Data refresh
  // ---------------------------------------------------------------
  async function refreshOrders() {
    orders = await db.getAllOrders();
  }

  async function refreshAll(minDelay = 0) {
    await Promise.all([refreshOrders(), minDelay ? sleep(minDelay) : Promise.resolve()]);
    if (currentView === "dashboard") renderDashboard();
    if (currentView === "orders") renderOrdersView();
  }

  // ---------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------
  function renderDashboard() {
    const today = new Date();
    const ordersToday = orders.filter((o) => isSameLocalDay(o.dateReceived, today));
    const readyCount = orders.filter((o) => o.status === "ready").length;
    const overdueCount = orders.filter(isProcessingOverdue).length;
    const lateCount = orders.filter(isLateForPickup).length;

    $("#today-date").textContent = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

    $("#stat-row").innerHTML = `
      <div class="stat-tag accent-suds">
        <span class="stat-label"><svg viewBox="0 0 24 24"><use href="#icon-basket"/></svg>Orders today</span>
        <span class="stat-value">${ordersToday.length}</span>
      </div>
      <div class="stat-tag accent-leaf">
        <span class="stat-label"><svg viewBox="0 0 24 24"><use href="#icon-check"/></svg>Ready for pickup</span>
        <span class="stat-value">${readyCount}</span>
      </div>
      <div class="stat-tag accent-clay">
        <span class="stat-label"><svg viewBox="0 0 24 24"><use href="#icon-alert"/></svg>Overdue</span>
        <span class="stat-value">${overdueCount}</span>
      </div>
      <div class="stat-tag accent-sun">
        <span class="stat-label"><svg viewBox="0 0 24 24"><use href="#icon-clock"/></svg>Late for pickup</span>
        <span class="stat-value">${lateCount}</span>
      </div>
    `;

    renderSalesPanel();

    const attention = orders
      .filter((o) => !["claimed", "cancelled"].includes(o.status) && (isProcessingOverdue(o) || o.status === "ready"))
      .sort((a, b) => new Date(a.pickupDeadline) - new Date(b.pickupDeadline))
      .slice(0, 8);

    $("#attention-list").innerHTML = attention.length
      ? attention.map(ticketRowHtml).join("")
      : `<p class="empty-hint">Nothing urgent right now — new orders and overdue or late pickups will show up here.</p>`;

    const recent = orders.slice(0, 6);
    $("#recent-list").innerHTML = recent.length
      ? recent.map(ticketRowHtml).join("")
      : `<p class="empty-hint">No orders yet. Create the first one to get started.</p>`;

    bindTicketRowClicks();
  }

  async function renderSalesPanel() {
    const statsEl = $("#sales-stats");
    statsEl.innerHTML = `
      <div class="sales-tile is-primary"><span class="st-label">Total sales</span><span class="skeleton-cell" style="height:21px;width:70%"></span></div>
      <div class="sales-tile"><span class="st-label">Orders</span><span class="skeleton-cell" style="height:21px;width:40%"></span></div>
      <div class="sales-tile"><span class="st-label">Customers</span><span class="skeleton-cell" style="height:21px;width:40%"></span></div>
      <div class="sales-tile"><span class="st-label">Avg. per order</span><span class="skeleton-cell" style="height:21px;width:60%"></span></div>
    `;

    await sleep(280);

    const { start, end } = getPeriodRange(salesPeriod, salesRange.from, salesRange.to);
    const filtered = orders.filter((o) => o.status !== "cancelled" && withinRange(o.dateReceived, start, end));
    const total = filtered.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);
    const customerSet = new Set(filtered.map((o) => o.customerName.trim().toLowerCase()));
    const avg = filtered.length ? total / filtered.length : 0;

    $("#sales-period-label").textContent = periodLabelText(salesPeriod, start, end);
    statsEl.innerHTML = `
      <div class="sales-tile is-primary"><span class="st-label">Total sales</span><span class="st-value">${money(total)}</span></div>
      <div class="sales-tile"><span class="st-label">Orders</span><span class="st-value">${filtered.length}</span></div>
      <div class="sales-tile"><span class="st-label">Customers</span><span class="st-value">${customerSet.size}</span></div>
      <div class="sales-tile"><span class="st-label">Avg. per order</span><span class="st-value">${money(avg)}</span></div>
    `;
  }

  $("#sales-period").addEventListener("change", () => {
    salesPeriod = $("#sales-period").value;
    $("#sales-range-fields").hidden = salesPeriod !== "range";
    if (salesPeriod === "range" && !salesRange.from) {
      const todayStr = toInputDate(new Date());
      $("#sales-range-from").value = todayStr;
      $("#sales-range-to").value = todayStr;
      salesRange = { from: todayStr, to: todayStr };
    }
    renderSalesPanel();
  });
  $("#sales-range-apply").addEventListener("click", () => {
    salesRange = { from: $("#sales-range-from").value, to: $("#sales-range-to").value };
    renderSalesPanel();
  });

  function ticketRowHtml(order) {
    const rel = relativeDeadline(order);
    return `
      <div class="ticket-row" data-order-id="${order.id}">
        <div class="tr-main">
          <div class="tr-name">${escapeHtml(order.customerName)}</div>
          <div class="tr-sub">${order.orderNo} · <span class="${rel.cls}">${rel.text}</span></div>
        </div>
        <div class="tr-amount">${money(order.totalAmount)}</div>
      </div>
    `;
  }

  function bindTicketRowClicks() {
    $$(".ticket-row").forEach((row) => {
      row.addEventListener("click", () => openViewModal(row.dataset.orderId));
    });
  }

  // ---------------------------------------------------------------
  // Orders view
  // ---------------------------------------------------------------
  function getFilteredOrders() {
    const search = $("#order-search").value.trim().toLowerCase();
    const statusFilter = $("#status-filter").value;
    const sort = $("#sort-order").value;

    const { start, end } = getPeriodRange(ordersPeriod, ordersRange.from, ordersRange.to);
    let list = orders.filter((o) => withinRange(o.dateReceived, start, end));

    if (statusFilter !== "all") list = list.filter((o) => o.status === statusFilter);

    if (search) {
      list = list.filter((o) =>
        [o.customerName, o.contactNumber, o.orderNo].some((v) => (v || "").toLowerCase().includes(search))
      );
    }

    switch (sort) {
      case "deadline_asc":
        list.sort((a, b) => new Date(a.pickupDeadline) - new Date(b.pickupDeadline));
        break;
      case "created_asc":
        list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        break;
      case "amount_desc":
        list.sort((a, b) => b.totalAmount - a.totalAmount);
        break;
      default:
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    return list;
  }

  $("#orders-period").addEventListener("change", () => {
    ordersPeriod = $("#orders-period").value;
    $("#orders-range-fields").hidden = ordersPeriod !== "range";
    if (ordersPeriod === "range" && !ordersRange.from) {
      const todayStr = toInputDate(new Date());
      $("#orders-range-from").value = todayStr;
      $("#orders-range-to").value = todayStr;
      ordersRange = { from: todayStr, to: todayStr };
    }
    renderOrdersView();
  });
  $("#orders-range-apply").addEventListener("click", () => {
    ordersRange = { from: $("#orders-range-from").value, to: $("#orders-range-to").value };
    renderOrdersView();
  });

  async function renderOrdersView() {
    const tbody = $("#orders-tbody");
    tbody.innerHTML = skeletonRows(5, 8);
    $("#orders-empty").hidden = true;

    await sleep(320); // brief, so the loading state is perceivable

    const list = getFilteredOrders();
    const { start, end } = getPeriodRange(ordersPeriod, ordersRange.from, ordersRange.to);
    $("#orders-count-sub").textContent = `${list.length} order${list.length === 1 ? "" : "s"} · ${periodLabelText(ordersPeriod, start, end)}`;

    if (!list.length) {
      tbody.innerHTML = "";
      $("#orders-empty").hidden = false;
      return;
    }

    $("#orders-empty").hidden = true;
    tbody.innerHTML = list.map(orderRowHtml).join("");

    $$(".orders-table tbody tr").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-row-action]")) return;
        openViewModal(tr.dataset.orderId);
      });
    });
    $$("[data-row-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest("tr").dataset.orderId;
        if (btn.dataset.rowAction === "view") openViewModal(id);
        if (btn.dataset.rowAction === "edit") openOrderModal(id);
        if (btn.dataset.rowAction === "delete") confirmDeleteOrder(id);
      });
    });
  }

  function orderRowHtml(order) {
    const rel = relativeDeadline(order);
    const lateBadge = isLateForPickup(order)
      ? `<span class="badge-late"><svg viewBox="0 0 24 24"><use href="#icon-clock"/></svg>Late</span>`
      : "";
    return `
      <tr data-order-id="${order.id}">
        <td class="cell-order-no">${order.orderNo}</td>
        <td class="cell-customer">
          <div class="cc-name">${escapeHtml(order.customerName)}</div>
          <div class="cc-contact">${escapeHtml(order.contactNumber || "—")}</div>
        </td>
        <td>${Number(order.weightKg).toFixed(1)}</td>
        <td>${money(order.pricePerKilo)}</td>
        <td class="cell-amount">${money(order.totalAmount)}</td>
        <td><div class="status-cell"><span class="badge badge-${order.status}">${STATUS_LABELS[order.status]}</span>${lateBadge}</div></td>
        <td>
          <div class="deadline-cell">
            <span class="dc-date">${formatDateDisplay(order.pickupDeadline)}</span>
            <span class="dc-rel ${rel.cls}">${rel.text}</span>
          </div>
        </td>
        <td class="cell-actions">
          <button class="row-icon-btn" data-row-action="view" aria-label="View"><svg viewBox="0 0 24 24"><use href="#icon-eye"/></svg></button>
          <button class="row-icon-btn" data-row-action="edit" aria-label="Edit"><svg viewBox="0 0 24 24"><use href="#icon-pencil"/></svg></button>
          <button class="row-icon-btn danger" data-row-action="delete" aria-label="Delete"><svg viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
        </td>
      </tr>
    `;
  }

  function confirmDeleteOrder(id) {
    const order = orders.find((o) => o.id === id);
    if (!order) return;
    openConfirm({
      title: "Delete this order?",
      message: `${order.orderNo} for ${order.customerName} will be permanently removed. This can't be undone.`,
      confirmLabel: "Delete order",
      danger: true,
      onConfirm: async () => {
        await db.deleteOrder(id);
        closeAllModals();
        await refreshAll();
        showToast("Order deleted", "success");
      },
    });
  }

  // ---------------------------------------------------------------
  // New / Edit order modal
  // ---------------------------------------------------------------
  const orderForm = $("#order-form");
  const weightInput = $("#f-weight");
  const rateInput = $("#f-rate");
  const extraInput = $("#f-extra");
  const totalPreview = $("#f-total-preview");
  const paymentStatusSelect = $("#f-payment-status");
  const amountPaidInput = $("#f-amount-paid");
  const cashInput = $("#f-cash-received");
  const changePreview = $("#f-change-preview");

  function recalcChange(total) {
    const raw = cashInput.value;
    if (raw === "" || raw === null) {
      changePreview.textContent = "—";
      changePreview.className = "change-display";
      return;
    }
    const cash = parseFloat(raw) || 0;
    const diff = cash - total;
    if (diff < 0) {
      changePreview.textContent = `Short by ${money(-diff)}`;
      changePreview.className = "change-display is-short";
    } else if (diff === 0) {
      changePreview.textContent = "No change due";
      changePreview.className = "change-display is-exact";
    } else {
      changePreview.textContent = money(diff);
      changePreview.className = "change-display is-positive";
    }
  }

  function recalcTotal() {
    const w = parseFloat(weightInput.value) || 0;
    const r = parseFloat(rateInput.value) || 0;
    const e = parseFloat(extraInput.value) || 0;
    const total = w * r + e;
    totalPreview.textContent = money(total);
    recalcChange(total);
    return total;
  }
  [weightInput, rateInput, extraInput, cashInput].forEach((el) => el.addEventListener("input", recalcTotal));

  paymentStatusSelect.addEventListener("change", () => {
    const total = recalcTotal();
    if (paymentStatusSelect.value === "paid") amountPaidInput.value = total.toFixed(2);
    if (paymentStatusSelect.value === "unpaid") amountPaidInput.value = "0";
  });

  $("#deadline-presets").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    $$(".chip", chip.parentElement).forEach((c) => c.classList.remove("is-selected"));
    chip.classList.add("is-selected");

    const base = new Date();
    if (chip.dataset.hours) {
      base.setHours(Number(chip.dataset.hours), 0, 0, 0);
    } else if (chip.dataset.days) {
      base.setDate(base.getDate() + Number(chip.dataset.days));
    }
    $("#f-deadline").value = toInputLocal(base);
  });

  function resetOrderForm() {
    orderForm.reset();
    $("#order-id").value = "";
    $$(".chip", $("#deadline-presets")).forEach((c) => c.classList.remove("is-selected"));

    const now = new Date();
    $("#f-received").value = toInputLocal(now);
    const defaultDeadline = new Date(now.getTime() + 24 * 3600 * 1000);
    $("#f-deadline").value = toInputLocal(defaultDeadline);
    $("#f-rate").value = settings?.defaultPricePerKilo ?? 0;
    $("#f-weight").value = "";
    $("#f-extra").value = "";
    $("#f-cash-received").value = "";
    $("#f-payment-status").value = "unpaid";
    $("#f-amount-paid").value = "0";
    recalcTotal();
  }

  function openOrderModal(orderId = null) {
    resetOrderForm();
    if (orderId) {
      const order = orders.find((o) => o.id === orderId);
      if (!order) return;
      $("#order-modal-title").textContent = `Edit ${order.orderNo}`;
      $("#order-submit-label").textContent = "Save changes";
      $("#order-id").value = order.id;
      $("#f-customer-name").value = order.customerName;
      $("#f-contact").value = order.contactNumber;
      $("#f-service-type").value = order.serviceType;
      $("#f-weight").value = order.weightKg;
      $("#f-rate").value = order.pricePerKilo;
      $("#f-extra").value = order.additionalCharge || "";
      $("#f-extra-note").value = order.additionalChargeNote || "";
      $("#f-received").value = toInputLocal(new Date(order.dateReceived));
      $("#f-deadline").value = toInputLocal(new Date(order.pickupDeadline));
      $("#f-payment-status").value = order.paymentStatus;
      $("#f-amount-paid").value = order.amountPaid;
      $("#f-cash-received").value = order.cashReceived != null ? order.cashReceived : "";
      $("#f-notes").value = order.notes;
      recalcTotal();
    } else {
      $("#order-modal-title").textContent = "New order";
      $("#order-submit-label").textContent = "Save order";
    }
    openModal("modal-order");
    $("#f-customer-name").focus();
  }

  orderForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const customerName = $("#f-customer-name").value.trim();
    const weightKg = parseFloat($("#f-weight").value);
    const pricePerKilo = parseFloat($("#f-rate").value);
    const pickupDeadline = $("#f-deadline").value;
    const dateReceived = $("#f-received").value;

    if (!customerName || !weightKg || weightKg <= 0 || !(pricePerKilo >= 0) || !pickupDeadline || !dateReceived) {
      showToast("Please fill in customer, weight, price per kilo and dates.", "error");
      return;
    }

    const payload = {
      customerName,
      contactNumber: $("#f-contact").value,
      serviceType: $("#f-service-type").value,
      weightKg,
      pricePerKilo,
      additionalCharge: parseFloat($("#f-extra").value) || 0,
      additionalChargeNote: $("#f-extra-note").value,
      totalAmount: recalcTotal(),
      paymentStatus: $("#f-payment-status").value,
      amountPaid: parseFloat($("#f-amount-paid").value) || 0,
      cashReceived: $("#f-cash-received").value === "" ? null : parseFloat($("#f-cash-received").value),
      dateReceived: new Date(dateReceived).toISOString(),
      pickupDeadline: new Date(pickupDeadline).toISOString(),
      notes: $("#f-notes").value,
    };

    const btn = $("#order-submit-btn");
    setButtonLoading(btn, true);
    const orderId = $("#order-id").value;

    try {
      await sleep(450); // perceivable save state
      if (orderId) {
        await db.updateOrder(orderId, payload);
        showToast("Order updated", "success");
      } else {
        await db.addOrder(payload);
        showToast("Order created", "success");
      }
      closeModal("modal-order");
      await refreshAll();
    } catch (err) {
      console.error(err);
      showToast("Something went wrong saving that order.", "error");
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // ---------------------------------------------------------------
  // View order modal (ticket)
  // ---------------------------------------------------------------
  function getNextStatus(current) {
    const idx = STATUS_FLOW.indexOf(current);
    if (idx === -1 || idx === STATUS_FLOW.length - 1) return null;
    return STATUS_FLOW[idx + 1];
  }

  function stepperHtml(order) {
    return STATUS_FLOW.map((s, i) => {
      const currentIdx = STATUS_FLOW.indexOf(order.status);
      let cls = "";
      if (i < currentIdx) cls = "is-done";
      if (i === currentIdx) cls = "is-current";
      const dotContent = i < currentIdx ? '<svg viewBox="0 0 24 24"><use href="#icon-check"/></svg>' : "";
      return `
        <div class="step ${cls}">
          <div class="step-dot">${i > 0 ? '<span class="step-line"></span>' : ""}${dotContent}</div>
          <div class="step-label">${STATUS_SHORT[s]}</div>
        </div>
      `;
    }).join("");
  }

  function ticketHtml(order) {
    const rel = relativeDeadline(order);
    const balance = Math.max(0, order.totalAmount - (order.amountPaid || 0));

    const factsHtml = `
      <div class="ticket-facts">
        <div><div class="ticket-fact-label">Weight</div><div class="ticket-fact-value">${Number(order.weightKg).toFixed(1)} kg</div></div>
        <div><div class="ticket-fact-label">Price/kg</div><div class="ticket-fact-value">${money(order.pricePerKilo)}</div></div>
        <div><div class="ticket-fact-label">Extra</div><div class="ticket-fact-value">${order.additionalCharge ? money(order.additionalCharge) : "—"}</div></div>
        <div><div class="ticket-fact-label">Total</div><div class="ticket-fact-value">${money(order.totalAmount)}</div></div>
      </div>
    `;

    const statusBlock =
      order.status === "cancelled"
        ? `<div class="cancelled-banner"><svg viewBox="0 0 24 24"><use href="#icon-ban"/></svg>This order was cancelled.</div>`
        : `<div class="stepper">${stepperHtml(order)}</div>`;

    const historyHtml = Array.isArray(order.statusHistory) && order.statusHistory.length
      ? `<div class="history-list">${order.statusHistory
          .slice()
          .reverse()
          .map(
            (h) =>
              `<div class="history-item"><span class="history-dot"></span><span class="history-status">${STATUS_LABELS[h.status]}</span><span class="history-time">${formatDateDisplay(h.at)}</span></div>`
          )
          .join("")}</div>`
      : "";

    return `
      <div class="ticket">
        <div class="ticket-top">
          <div class="ticket-head">
            <div>
              <div class="ticket-order-no">${order.orderNo} · ${escapeHtml(order.serviceType)}</div>
              <div class="ticket-name">${escapeHtml(order.customerName)}</div>
              ${order.contactNumber ? `<div class="ticket-contact"><svg viewBox="0 0 24 24"><use href="#icon-phone"/></svg>${escapeHtml(order.contactNumber)}</div>` : ""}
            </div>
            <div class="status-cell">
              <span class="badge badge-${order.status}">${STATUS_LABELS[order.status]}</span>
              ${isLateForPickup(order) ? `<span class="badge-late"><svg viewBox="0 0 24 24"><use href="#icon-clock"/></svg>Late</span>` : ""}
            </div>
          </div>
          ${factsHtml}
        </div>
        <div class="ticket-perf"></div>
        <div class="ticket-bottom">
          ${statusBlock}
          <div class="ticket-dates" style="margin-top:14px;">
            <div class="ticket-date-block">
              <div class="td-label">Received</div>
              <div class="td-value">${formatDateDisplay(order.dateReceived)}</div>
            </div>
            <div class="ticket-date-block align-right">
              <div class="td-label">Pickup deadline</div>
              <div class="td-value">${formatDateDisplay(order.pickupDeadline)} · <span class="${rel.cls}">${rel.text}</span></div>
            </div>
          </div>
          <div class="ticket-dates" style="margin-top:10px;">
            <div class="ticket-date-block">
              <div class="td-label">Payment</div>
              <div class="td-value">${STATUS_LABELS[order.paymentStatus] || order.paymentStatus} ${balance > 0 && order.status !== "cancelled" ? `· ${money(balance)} balance` : ""}</div>
            </div>
            ${order.cashReceived != null ? `<div class="ticket-date-block align-right"><div class="td-label">Cash / change</div><div class="td-value">${money(order.cashReceived)} → ${money(Math.max(0, order.cashReceived - order.totalAmount))} change</div></div>` : ""}
          </div>
          ${order.notes ? `<div class="ticket-note">${escapeHtml(order.notes)}</div>` : ""}
          ${historyHtml ? `<details class="history-toggle"><summary>Status history</summary>${historyHtml}</details>` : ""}
        </div>
      </div>
    `;
  }

  function viewActionsHtml(order) {
    const next = getNextStatus(order.status);
    const canCancel = !["claimed", "cancelled"].includes(order.status);

    let rightButtons = "";
    if (next) {
      const label = next === "claimed" ? "Mark as claimed" : `Mark as ${STATUS_SHORT[next].toLowerCase()}`;
      rightButtons += `<button class="btn btn-primary" id="btn-advance" data-loading-text="Updating…"><svg viewBox="0 0 24 24"><use href="#icon-arrow-right"/></svg>${label}</button>`;
    }

    return `
      <div class="view-actions-row">
        <div class="view-actions-left">
          <button class="btn btn-secondary" id="btn-view-edit"><svg viewBox="0 0 24 24"><use href="#icon-pencil"/></svg>Edit</button>
          <button class="btn btn-ghost" id="btn-view-delete"><svg viewBox="0 0 24 24"><use href="#icon-trash"/></svg>Delete</button>
        </div>
        <div class="view-actions-right">
          ${canCancel ? `<button class="btn btn-ghost" id="btn-view-cancel">Cancel order</button>` : ""}
          ${rightButtons}
        </div>
      </div>
    `;
  }

  let viewingOrderId = null;

  function openViewModal(orderId) {
    viewingOrderId = orderId;
    renderViewModal();
    openModal("modal-view");
  }

  function renderViewModal(justAdvanced = false) {
    const order = orders.find((o) => o.id === viewingOrderId);
    if (!order) return closeModal("modal-view");

    $("#view-modal-title").textContent = `${order.orderNo}`;
    $("#view-modal-body").innerHTML = ticketHtml(order);
    $("#view-modal-actions").innerHTML = viewActionsHtml(order);

    if (justAdvanced) {
      const currentDot = $(".step.is-current .step-dot");
      if (currentDot) currentDot.classList.add("stamp-pop");
    }

    const advanceBtn = $("#btn-advance");
    if (advanceBtn) {
      advanceBtn.addEventListener("click", async () => {
        setButtonLoading(advanceBtn, true);
        try {
          await sleep(350);
          const next = getNextStatus(order.status);
          await db.setOrderStatus(order.id, next);
          await refreshOrders();
          renderViewModal(true);
          if (currentView === "orders") renderOrdersView();
          if (currentView === "dashboard") renderDashboard();
          showToast(next === "claimed" ? "Order claimed — nice work!" : `Marked as ${STATUS_SHORT[next].toLowerCase()}`, "success");
        } finally {
          setButtonLoading(advanceBtn, false);
        }
      });
    }

    const cancelBtn = $("#btn-view-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        openConfirm({
          title: "Cancel this order?",
          message: `${order.orderNo} for ${order.customerName} will be marked cancelled. You can still see it in the list.`,
          confirmLabel: "Cancel order",
          danger: true,
          onConfirm: async () => {
            await db.setOrderStatus(order.id, "cancelled");
            await refreshOrders();
            renderViewModal();
            if (currentView === "orders") renderOrdersView();
            if (currentView === "dashboard") renderDashboard();
            showToast("Order cancelled", "info");
          },
        });
      });
    }

    $("#btn-view-edit").addEventListener("click", () => {
      closeModal("modal-view");
      openOrderModal(order.id);
    });

    $("#btn-view-delete").addEventListener("click", () => {
      closeModal("modal-view");
      confirmDeleteOrder(order.id);
    });
  }

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------
  function updateCurrencyLabels() {
    const symbol = settings?.currencySymbol || "₱";
    ["rate-currency", "extra-currency", "paid-currency"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = symbol;
    });
  }

  function fillSettingsForm() {
    $("#set-business-name").value = settings.businessName;
    $("#set-currency").value = settings.currencySymbol;
    $("#set-default-rate").value = settings.defaultPricePerKilo;
    $("#set-prefix").value = settings.orderPrefix;
  }

  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    setButtonLoading(btn, true);
    try {
      await sleep(350);
      settings = await db.saveSettings({
        businessName: $("#set-business-name").value.trim() || "My Laundry Shop",
        currencySymbol: $("#set-currency").value.trim() || "₱",
        defaultPricePerKilo: parseFloat($("#set-default-rate").value) || 0,
        orderPrefix: $("#set-prefix").value.trim().toUpperCase() || "OR",
      });
      applySettingsToUI();
      showToast("Settings saved", "success");
    } finally {
      setButtonLoading(btn, false);
    }
  });

  function applySettingsToUI() {
    $("#brand-name").textContent = settings.businessName;
    document.title = `${settings.businessName} — Admin`;
    updateCurrencyLabels();
    if (currentView === "orders") renderOrdersView();
    if (currentView === "dashboard") renderDashboard();
  }

  // Export
  $("#btn-export").addEventListener("click", async () => {
    const btn = $("#btn-export");
    setButtonLoading(btn, true);
    try {
      await sleep(300);
      const data = await db.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `laundry-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("Backup downloaded", "success");
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // Import
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      openConfirm({
        title: "Import this backup?",
        message: `This will replace every order currently stored on this device with the ${json.orders?.length ?? 0} orders from this file.`,
        confirmLabel: "Import & replace",
        danger: true,
        onConfirm: async () => {
          await db.importData(json);
          settings = await db.getSettings();
          applySettingsToUI();
          await refreshAll();
          showToast("Backup imported", "success");
        },
      });
    } catch (err) {
      showToast("That file couldn't be read as a backup.", "error");
    } finally {
      e.target.value = "";
    }
  });

  // Reset
  $("#btn-reset").addEventListener("click", () => {
    openConfirm({
      title: "Erase all orders?",
      message: "Every order on this device will be permanently deleted. Export a backup first if you're not sure.",
      confirmLabel: "Erase everything",
      danger: true,
      onConfirm: async () => {
        await db.clearAll();
        settings = await db.getSettings();
        applySettingsToUI();
        await refreshAll();
        showToast("All orders erased", "info");
      },
    });
  });

  // ---------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("laundry-theme", theme);
  }

  $("#theme-toggle").addEventListener("click", async () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    if (settings) settings = await db.saveSettings({ theme: next });
  });

  // ---------------------------------------------------------------
  // Global event delegation
  // ---------------------------------------------------------------
  document.addEventListener("click", (e) => {
    const navBtn = e.target.closest("[data-view]");
    if (navBtn && (navBtn.classList.contains("nav-item") || navBtn.classList.contains("mobile-nav-item"))) {
      switchView(navBtn.dataset.view);
      return;
    }
    if (e.target.closest("[data-action='new-order']")) {
      openOrderModal();
      return;
    }
    if (e.target.closest("[data-view-link]")) {
      switchView(e.target.closest("[data-view-link]").dataset.viewLink);
      return;
    }
    if (e.target.closest("[data-close-modal]")) {
      const overlay = e.target.closest(".modal-overlay");
      if (overlay) closeModal(overlay.id);
      return;
    }
    if (e.target.classList.contains("modal-overlay")) {
      closeModal(e.target.id);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const open = $$(".modal-overlay").find((m) => !m.hidden);
      if (open) closeModal(open.id);
    }
  });

  $("#order-search").addEventListener("input", debounce(() => renderOrdersView(), 250));
  $("#status-filter").addEventListener("change", () => renderOrdersView());
  $("#sort-order").addEventListener("change", () => renderOrdersView());

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function boot() {
    const savedTheme = localStorage.getItem("laundry-theme");
    if (savedTheme) applyTheme(savedTheme);

    await Promise.all([db.init(), sleep(500)]);
    settings = await db.getSettings();
    if (!savedTheme && settings.theme) applyTheme(settings.theme);

    applySettingsToUI();
    await refreshOrders();

    $("#boot-loader").classList.add("is-hiding");
    setTimeout(() => {
      $("#boot-loader").hidden = true;
      $("#app").hidden = false;
    }, 300);

    switchView("dashboard");
  }

  boot();
})();

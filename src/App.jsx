import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, BarChart, Cell,
} from "recharts";
import * as XLSX from "xlsx";
import { SPLASH_MIN_MS } from "./lib/splashTiming.js";

/* ------------------------------------------------------------------ */
/* Constants & helpers                                                 */
/* ------------------------------------------------------------------ */

const MKEY = "bybrand:masters";
const EKEY = "bybrand:entries";

const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_CURRENCIES = [
  { code: "JPY", name: "Yen", base: true },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "Pound" },
  { code: "PLN", name: "Zloty" },
];

// ---- Order-entry (Orders tab) constants ----
const SIZE_SYSTEMS = {
  "letter": ["XXS", "XS", "S", "M", "L", "OS"],
  "eu-even": ["44", "46", "48", "50", "52", "OS"],
  "eu-odd": ["41", "42", "43", "44", "45", "46"],
};
const ITEM_TYPES = ["BL", "JK", "SK", "CO", "PT", "TP", "VT", "OP", "OT"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEFAULT_RATES = { EUR: 165, GBP: 195, USD: 150, PLN: 40, JPY: 1 };

function blankOrderForm() {
  return {
    brandId: "", seasonId: "", delivery: "Aug", item: "BL", model: "",
    fabric: "", color: "", acc1: "", acc2: "", acc3: "", acc4: "",
    imgModel: null, imgFabric: null, imgAcc1: null, imgAcc2: null, imgAcc3: null, imgAcc4: null,
    sizeSystem: "letter", customSizes: "", sizes: {},
    currency: "EUR", exrate: 165, wsp: "", afipcPct: 20, costPct: 45,
    lts: "", note: "", memo: "",
  };
}

const ORDER_IMAGE_FIELDS = ["imgModel", "imgFabric", "imgAcc1", "imgAcc2", "imgAcc3", "imgAcc4"];

// Splits an order-like object into { rest, images }, where images holds only
// the 6 photo fields. Orders are stored without images (in the small, fast
// `orders` array); each order's images live in their own storage key so a
// growing photo library never crowds out other orders' data.
function splitOrderImages(obj) {
  const images = {};
  const rest = { ...obj };
  ORDER_IMAGE_FIELDS.forEach((k) => {
    images[k] = obj[k] || null;
    delete rest[k];
  });
  return { rest, images };
}

async function saveOrderImages(id, images) {
  const hasAny = ORDER_IMAGE_FIELDS.some((k) => images[k]);
  try {
    if (hasAny) {
      await window.storage.set(`order-img:${id}`, JSON.stringify(images), false);
    } else {
      await window.storage.delete(`order-img:${id}`, false);
    }
  } catch (err) { /* best-effort; images are non-critical to save */ }
}

async function loadOrderImages(id) {
  try {
    const r = await window.storage.get(`order-img:${id}`, false);
    if (r && r.value) return JSON.parse(r.value);
  } catch (err) { /* no images saved for this order */ }
  const blank = {};
  ORDER_IMAGE_FIELDS.forEach((k) => (blank[k] = null));
  return blank;
}

function getOrderSizeList(form) {
  if (form.sizeSystem === "custom") {
    return (form.customSizes || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return SIZE_SYSTEMS[form.sizeSystem] || SIZE_SYSTEMS.letter;
}

// Union of every size key used across a set of orders, ordered sensibly:
// known letter sizes first (XXS..OS), then numeric sizes ascending, then
// any leftover custom labels in first-seen order.
const SIZE_LETTER_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "OS"];

// Orders size keys smallest-to-largest: known letter sizes first (XXS..OS),
// then numeric sizes ascending, then any leftover custom labels as-is.
function sortSizeKeys(all) {
  const letters = SIZE_LETTER_ORDER.filter((s) => all.includes(s));
  const numeric = all.filter((s) => !isNaN(Number(s))).sort((a, b) => Number(a) - Number(b));
  const rest = all.filter((s) => !letters.includes(s) && !numeric.includes(s));
  return [...letters, ...numeric, ...rest];
}

// Short brand code for PO numbers: initials of each word for multi-word
// names (e.g. "Bourrienne Paris X" -> "BPX"), or the first 3 letters for a
// single-word name (e.g. "nitto" -> "NIT"). Collisions between brands are
// resolved by the caller.
function brandInitials(name) {
  const words = (String(name || "")).split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words
      .map((w) => (w.match(/[A-Za-z0-9]/) || [""])[0].toUpperCase())
      .join("");
  }
  return (words[0] || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
}

function collectSizeColumns(ordersList) {
  const seen = new Set();
  (ordersList || []).forEach((o) => {
    Object.entries(o.sizes || {}).forEach(([k, v]) => {
      if (Number(v) > 0) seen.add(k);
    });
  });
  return sortSizeKeys(Array.from(seen));
}

function computeOrderTotals(form) {
  const totalUnits = Object.values(form.sizes || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const wsp = Number(form.wsp) || 0;
  const afipcMul = 1 + (Number(form.afipcPct) || 0) / 100;
  const wsplb = wsp * afipcMul;
  const rate = form.currency === "JPY" ? 1 : (Number(form.exrate) || 0);
  const costPerUnitJPY = wsplb * rate;
  const costPct = Number(form.costPct) || 0;
  const rp = costPct > 0 ? Math.round(costPerUnitJPY / (costPct / 100) / 100) * 100 : 0;
  const totalWSP = totalUnits * wsp;
  const totalWSPLB = totalUnits * wsplb;
  const erp = rp * totalUnits;
  const markup = wsp && rate ? rp / wsp / rate : null;
  return { totalUnits, wsplb, totalWSP, totalWSPLB, rp, erp, markup };
}

// Downscales an uploaded image before storing it (persistent storage has a
// 5MB-per-key ceiling, and raw camera photos as base64 blow past that fast).
function resizeImageFile(file, maxDim = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Imported from the original "By Brand" Excel sheet (brand, currency, active).
const SEED_BRANDS = [{"id": "32paradis", "name": "32PARADIS", "currency": "EUR", "active": false}, {"id": "archivio-jm-rivot", "name": "ARCHIVIO JM Rivot", "currency": "EUR", "active": false}, {"id": "bourrienne-paris-x", "name": "BOURRIENNE PARIS X", "currency": "EUR", "active": true}, {"id": "gs-studio", "name": "GS studio", "currency": "EUR", "active": true}, {"id": "ematyte", "name": "EMATYTE", "currency": "EUR", "active": true}, {"id": "faliero-sarti", "name": "Faliero Sarti", "currency": "EUR", "active": false}, {"id": "geoffrey-b-small", "name": "Geoffrey B Small Ⅱ", "currency": "EUR", "active": true}, {"id": "geoffrey-b-small-mens", "name": "Geoffrey B Small Mens", "currency": "EUR", "active": true}, {"id": "geoffrey-b-small-personal", "name": "Geoffrey B Small Personal", "currency": "EUR", "active": true}, {"id": "guidi", "name": "Guidi", "currency": "EUR", "active": true}, {"id": "horisaki", "name": "Horisaki", "currency": "EUR", "active": true}, {"id": "liwan", "name": "LIWAN", "currency": "EUR", "active": true}, {"id": "liwan-towell", "name": "LIWAN  TOWELL", "currency": "EUR", "active": true}, {"id": "geoffrey-b-small-2", "name": "Geoffrey B. Small", "currency": "EUR", "active": true}, {"id": "m-a", "name": "m.a+", "currency": "EUR", "active": true}, {"id": "ma-men-s", "name": "Ma+ Men's", "currency": "EUR", "active": true}, {"id": "ma-personal", "name": "Ma＋personal", "currency": "EUR", "active": true}, {"id": "maria-apron", "name": "Maria Apron", "currency": "EUR", "active": true}, {"id": "maria-turri", "name": "MARIA TURRI", "currency": "EUR", "active": true}, {"id": "maria-turri-2", "name": "MARIA TURRI Ⅱ", "currency": "EUR", "active": true}, {"id": "mirror-in-the-sky", "name": "Mirror in The Sky", "currency": "EUR", "active": true}, {"id": "nanna-pause", "name": "Nanna Pause", "currency": "EUR", "active": true}, {"id": "nitto", "name": "nitto", "currency": "EUR", "active": true}, {"id": "nosapluna", "name": "NOSAPLUNA", "currency": "EUR", "active": true}, {"id": "scha", "name": "scha", "currency": "EUR", "active": true}, {"id": "shoto", "name": "SHOTO", "currency": "EUR", "active": true}, {"id": "stouls", "name": "STOULS", "currency": "EUR", "active": true}, {"id": "boboutic", "name": "Boboutic", "currency": "EUR", "active": true}, {"id": "aehrr", "name": "AEHRR", "currency": "JPY", "active": true}, {"id": "bresciani", "name": "Bresciani", "currency": "JPY", "active": true}, {"id": "corgi", "name": "Corgi", "currency": "JPY", "active": true}, {"id": "kristensen", "name": "Kristensen", "currency": "JPY", "active": true}, {"id": "kristensen-high-summer", "name": "Kristensen High Summer", "currency": "JPY", "active": true}, {"id": "maison-fabre", "name": "Maison Fabre", "currency": "JPY", "active": true}, {"id": "private0204", "name": "Private0204", "currency": "JPY", "active": true}, {"id": "silvana-manetti", "name": "Silvana Manetti", "currency": "JPY", "active": true}, {"id": "stonesstone-zoo", "name": "stonesstone zoo", "currency": "JPY", "active": true}, {"id": "rose-carmine", "name": "Rose Carmine", "currency": "EUR", "active": true}, {"id": "tagliovivo", "name": "tagliovivo", "currency": "JPY", "active": true}, {"id": "the-row", "name": "THE ROW Ⅰ", "currency": "JPY", "active": true}, {"id": "the-row-2", "name": "THE ROW Ⅱ", "currency": "JPY", "active": true}, {"id": "oluhi", "name": "oluhi", "currency": "PLN", "active": true}, {"id": "isabella-stefanelli", "name": "isabella stefanelli", "currency": "GBP", "active": true}, {"id": "mariko-tsuchiyama", "name": "Mariko Tsuchiyama", "currency": "GBP", "active": true}, {"id": "atelier-inscere", "name": "Atelier Inscere", "currency": "EUR", "active": true}, {"id": "maria-la-rosa", "name": "Maria La Rosa", "currency": "EUR", "active": true}, {"id": "rosie-sugden", "name": "Rosie Sugden", "currency": "EUR", "active": true}];

// Imported historical Plan/Actual figures, keyed as `${brandId}|${seasonId}|plan|actual`.
const RAW_SEED_ENTRIES = {"32paradis|2021-FW|plan": {"local": 13800, "rate": 130.0}, "archivio-jm-rivot|2026-SS|plan": {"local": 6464.6465, "rate": 165.0}, "archivio-jm-rivot|2026-SS|actual": {"local": 5560, "rate": 0.0}, "archivio-jm-rivot|2025-SS|plan": {"local": 6464.6465, "rate": 165.0}, "archivio-jm-rivot|2025-SS|actual": {"local": 6410, "rate": 165.0}, "archivio-jm-rivot|2025-FW|plan": {"local": 6545.4545, "rate": 165.0}, "archivio-jm-rivot|2025-FW|actual": {"local": 3080, "rate": 165.0}, "archivio-jm-rivot|2024-FW|plan": {"local": 5729.8276, "rate": 163.0}, "archivio-jm-rivot|2024-FW|actual": {"local": 5830, "rate": 163.0}, "archivio-jm-rivot|2021-FW|plan": {"local": 2725, "rate": 130.0}, "bourrienne-paris-x|2026-SS|actual": {"local": 3919, "rate": 182.0}, "bourrienne-paris-x|2026-FW|plan": {"local": 3088, "rate": 188.0}, "bourrienne-paris-x|2026-FW|actual": {"local": 3088, "rate": 189.0}, "gs-studio|2026-FW|plan": {"local": 470, "rate": 189.0}, "gs-studio|2026-FW|actual": {"local": 2045, "rate": 189.0}, "ematyte|2026-SS|plan": {"local": 3232.3232, "rate": 165.0}, "ematyte|2026-FW|plan": {"local": 3054.5455, "rate": 165.0}, "ematyte|2025-SS|plan": {"local": 3232.3232, "rate": 165.0}, "ematyte|2025-SS|actual": {"local": 3060, "rate": 165.0}, "ematyte|2025-FW|plan": {"local": 4363.6364, "rate": 165.0}, "ematyte|2025-FW|actual": {"local": 5820, "rate": 165.0}, "ematyte|2024-SS|actual": {"local": 6150, "rate": 163.0}, "ematyte|2024-FW|plan": {"local": 5544.9945, "rate": 163.0}, "ematyte|2024-FW|actual": {"local": 3840, "rate": 163.0}, "ematyte|2023-SS|actual": {"local": 900, "rate": 146.5}, "ematyte|2023-FW|plan": {"local": 5603, "rate": 158.500089}, "ematyte|2021-SS|actual": {"local": 2780, "rate": 130.0}, "ematyte|2021-FW|plan": {"local": 3000, "rate": 130.0}, "faliero-sarti|2024-FW|plan": {"local": 6469.1602, "rate": 163.0}, "faliero-sarti|2024-FW|actual": {"local": 650000, "rate": 1.0}, "faliero-sarti|2023-SS|actual": {"local": 13789, "rate": 146.500036}, "faliero-sarti|2023-FW|plan": {"local": 6777, "rate": 158.500074}, "faliero-sarti|2022-FW|plan": {"local": 4979, "rate": 144.5}, "faliero-sarti|2021-FW|plan": {"local": 4576, "rate": 130.0}, "geoffrey-b-small|2023-SS|actual": {"local": 7993, "rate": 146.500063}, "geoffrey-b-small-mens|2022-FW|plan": {"local": 13504, "rate": 144.5}, "geoffrey-b-small-personal|2023-SS|actual": {"local": 3690, "rate": 146.5}, "geoffrey-b-small-personal|2021-FW|plan": {"local": 1134, "rate": 130.0}, "guidi|2021-SS|actual": {"local": 14200, "rate": 130.0}, "horisaki|2025-FW|plan": {"local": 2181.8182, "rate": 165.0}, "horisaki|2024-FW|actual": {"local": 2640, "rate": 163.0}, "liwan|2021-SS|actual": {"local": 2160, "rate": 130.0}, "liwan-towell|2023-SS|actual": {"local": 23945, "rate": 146.500021}, "liwan-towell|2023-FW|plan": {"local": 25945, "rate": 158.500019}, "liwan-towell|2021-SS|actual": {"local": 180, "rate": 130.0}, "geoffrey-b-small-2|2026-SS|plan": {"local": 22564.1026, "rate": 182.0}, "geoffrey-b-small-2|2026-SS|actual": {"local": 15088.125, "rate": 182.0}, "geoffrey-b-small-2|2026-FW|plan": {"local": 29333.3333, "rate": 189.0}, "geoffrey-b-small-2|2026-FW|actual": {"local": 44140, "rate": 189.0}, "geoffrey-b-small-2|2025-SS|plan": {"local": 35555.5556, "rate": 165.0}, "geoffrey-b-small-2|2025-SS|actual": {"local": 35690, "rate": 165.0}, "geoffrey-b-small-2|2025-FW|plan": {"local": 48000, "rate": 165.0}, "geoffrey-b-small-2|2025-FW|actual": {"local": 48000, "rate": 165.0}, "geoffrey-b-small-2|2024-SS|actual": {"local": 20778.125, "rate": 163.0}, "geoffrey-b-small-2|2024-FW|plan": {"local": 27724.9724, "rate": 163.0}, "geoffrey-b-small-2|2024-FW|actual": {"local": 41850.5, "rate": 163.0}, "geoffrey-b-small-2|2023-SS|actual": {"local": 17422, "rate": 146.5}, "geoffrey-b-small-2|2022-FW|plan": {"local": 18251, "rate": 144.5}, "geoffrey-b-small-2|2021-SS|actual": {"local": 38048, "rate": 130.0}, "m-a|2026-SS|plan": {"local": 29090.9091, "rate": 165.0}, "m-a|2026-SS|actual": {"local": 16640, "rate": 182.0}, "m-a|2026-FW|plan": {"local": 4285.7143, "rate": 189.0}, "m-a|2026-FW|actual": {"local": 3900, "rate": 189.0}, "m-a|2025-SS|plan": {"local": 29090.9091, "rate": 165.0}, "m-a|2025-SS|actual": {"local": 27195, "rate": 165.0}, "m-a|2025-FW|plan": {"local": 17706.6667, "rate": 165.0}, "m-a|2025-FW|actual": {"local": 16295, "rate": 165.0}, "m-a|2024-SS|actual": {"local": 32855, "rate": 163.0}, "m-a|2024-FW|plan": {"local": 33269.9668, "rate": 163.0}, "m-a|2024-FW|actual": {"local": 27545, "rate": 163.0}, "m-a|2023-SS|actual": {"local": 21685, "rate": 146.500023}, "m-a|2023-FW|plan": {"local": 9075, "rate": 158.500055}, "m-a|2022-SS|actual": {"local": 69185, "rate": 136.9}, "m-a|2022-FW|plan": {"local": 16980, "rate": 144.5}, "m-a|2021-SS|actual": {"local": 42095, "rate": 130.0}, "m-a|2021-FW|plan": {"local": 90885, "rate": 130.0}, "ma-men-s|2022-FW|plan": {"local": 31900, "rate": 144.5}, "ma-personal|2022-SS|actual": {"local": 2435, "rate": 136.9}, "ma-personal|2021-SS|actual": {"local": 1760, "rate": 130.0}, "ma-personal|2021-FW|plan": {"local": 6095, "rate": 130.0}, "maria-apron|2026-SS|plan": {"local": 2386.3636, "rate": 165.0}, "maria-apron|2026-FW|plan": {"local": 1527.2727, "rate": 165.0}, "maria-apron|2025-SS|plan": {"local": 2386.3636, "rate": 165.0}, "maria-apron|2025-FW|plan": {"local": 2181.8182, "rate": 165.0}, "maria-apron|2024-FW|plan": {"local": 3696.663, "rate": 163.0}, "maria-turri|2026-SS|plan": {"local": 4246.5616, "rate": 165.0}, "maria-turri|2026-SS|actual": {"local": 5000, "rate": 182.0}, "maria-turri|2026-FW|plan": {"local": 4285.7143, "rate": 189.0}, "maria-turri|2026-FW|actual": {"local": 3650, "rate": 189.0}, "maria-turri|2025-SS|plan": {"local": 4246.5616, "rate": 165.0}, "maria-turri|2025-SS|actual": {"local": 4890, "rate": 165.0}, "maria-turri|2025-FW|plan": {"local": 10909.0909, "rate": 165.0}, "maria-turri|2025-FW|actual": {"local": 3160, "rate": 165.0}, "maria-turri|2024-SS|actual": {"local": 4030, "rate": 163.0}, "maria-turri|2024-FW|plan": {"local": 5544.9945, "rate": 163.0}, "maria-turri|2024-FW|actual": {"local": 8940, "rate": 163.0}, "maria-turri|2022-SS|actual": {"local": 9056, "rate": 136.9}, "maria-turri|2022-FW|plan": {"local": 2110, "rate": 144.5}, "maria-turri|2021-SS|actual": {"local": 5270, "rate": 130.0}, "maria-turri|2021-FW|plan": {"local": 16695, "rate": 130.0}, "maria-turri-2|2024-SS|actual": {"local": 2180, "rate": 163.0}, "maria-turri-2|2021-SS|actual": {"local": 4980, "rate": 130.0}, "mirror-in-the-sky|2026-FW|plan": {"local": 4285.7143, "rate": 189.0}, "mirror-in-the-sky|2026-FW|actual": {"local": 4406, "rate": 189.0}, "mirror-in-the-sky|2025-FW|actual": {"local": 3376, "rate": 165.0}, "nanna-pause|2026-FW|plan": {"local": 7142.8571, "rate": 189.0}, "nanna-pause|2026-FW|actual": {"local": 6893, "rate": 189.0}, "nanna-pause|2025-FW|actual": {"local": 5320, "rate": 165.0}, "nitto|2026-SS|plan": {"local": 6086.7692, "rate": 209.3}, "nitto|2026-SS|actual": {"local": 6260, "rate": 182.0}, "nitto|2026-FW|plan": {"local": 7142.8571, "rate": 189.0}, "nitto|2026-FW|actual": {"local": 6203, "rate": 189.0}, "nitto|2025-SS|plan": {"local": 6464.6465, "rate": 165.0}, "nitto|2025-SS|actual": {"local": 7947, "rate": 165.0}, "nitto|2025-FW|plan": {"local": 21818.1818, "rate": 165.0}, "nitto|2025-FW|actual": {"local": 14909, "rate": 165.0}, "nitto|2024-SS|actual": {"local": 2208, "rate": 163.0}, "nitto|2024-FW|plan": {"local": 3696.663, "rate": 163.0}, "nitto|2024-FW|actual": {"local": 6994, "rate": 163.0}, "nosapluna|2026-SS|plan": {"local": 4400.8081, "rate": 165.0}, "nosapluna|2025-SS|plan": {"local": 4400.8081, "rate": 165.0}, "nosapluna|2024-SS|actual": {"local": 3890, "rate": 163.0}, "nosapluna|2024-FW|plan": {"local": 3696.663, "rate": 163.0}, "nosapluna|2024-FW|actual": {"local": 3020, "rate": 163.0}, "scha|2026-SS|plan": {"local": 1431.8182, "rate": 165.0}, "scha|2025-SS|plan": {"local": 1431.8182, "rate": 165.0}, "scha|2025-SS|actual": {"local": 1260, "rate": 165.0}, "scha|2024-SS|actual": {"local": 1350, "rate": 163.0}, "shoto|2026-SS|plan": {"local": 500000.04, "rate": 1.0}, "shoto|2025-SS|plan": {"local": 500000.04, "rate": 1.0}, "shoto|2025-SS|actual": {"local": 1464, "rate": 165.0}, "shoto|2024-SS|actual": {"local": 766500, "rate": 1.0}, "stouls|2026-SS|plan": {"local": 6464.6465, "rate": 165.0}, "stouls|2025-SS|plan": {"local": 6464.6465, "rate": 165.0}, "stouls|2025-SS|actual": {"local": 6132, "rate": 165.0}, "stouls|2025-FW|actual": {"local": 3984, "rate": 165.0}, "stouls|2024-SS|actual": {"local": 5647, "rate": 163.0}, "stouls|2024-FW|plan": {"local": 5544.9945, "rate": 163.0}, "stouls|2024-FW|actual": {"local": 6912, "rate": 163.0}, "stouls|2022-SS|actual": {"local": 5785, "rate": 136.9}, "stouls|2022-FW|plan": {"local": 5695, "rate": 144.5}, "stouls|2021-FW|plan": {"local": 14510, "rate": 130.0}, "boboutic|2026-FW|plan": {"local": 9818.1818, "rate": 165.0}, "boboutic|2026-FW|actual": {"local": 5280, "rate": 189.0}, "boboutic|2025-SS|plan": {"local": 6464.6465, "rate": 165.0}, "boboutic|2025-SS|actual": {"local": 6132, "rate": 165.0}, "boboutic|2025-FW|actual": {"local": 3984, "rate": 165.0}, "boboutic|2024-SS|actual": {"local": 5647, "rate": 163.0}, "boboutic|2024-FW|plan": {"local": 5544.9945, "rate": 163.0}, "boboutic|2024-FW|actual": {"local": 6912, "rate": 163.0}, "boboutic|2022-SS|actual": {"local": 5785, "rate": 136.9}, "boboutic|2022-FW|plan": {"local": 5695, "rate": 144.5}, "boboutic|2021-FW|plan": {"local": 14510, "rate": 130.0}, "aehrr|2026-SS|actual": {"local": 1231500, "rate": 1}, "aehrr|2026-FW|plan": {"local": 810000, "rate": 1}, "aehrr|2026-FW|actual": {"local": 1125905, "rate": 1}, "aehrr|2025-SS|actual": {"local": 324500, "rate": 1}, "aehrr|2025-FW|plan": {"local": 6545.454545454545, "rate": 1}, "aehrr|2025-FW|actual": {"local": 399300.00000000006, "rate": 1}, "bresciani|2026-SS|plan": {"local": 213333.3333333333, "rate": 1}, "bresciani|2026-SS|actual": {"local": 126720, "rate": 1}, "bresciani|2026-FW|plan": {"local": 270000, "rate": 1}, "bresciani|2026-FW|actual": {"local": 231120, "rate": 1}, "bresciani|2025-SS|plan": {"local": 213333.3333333333, "rate": 1}, "bresciani|2025-SS|actual": {"local": 228240, "rate": 1}, "bresciani|2025-FW|actual": {"local": 276840, "rate": 1}, "bresciani|2024-SS|actual": {"local": 200000, "rate": 1}, "bresciani|2024-FW|actual": {"local": 150000, "rate": 1}, "bresciani|2021-SS|actual": {"local": 266400, "rate": 1}, "bresciani|2021-FW|plan": {"local": 517750, "rate": 1}, "corgi|2025-FW|plan": {"local": 216000, "rate": 1}, "corgi|2024-FW|actual": {"local": 210895, "rate": 1}, "corgi|2021-SS|actual": {"local": 266400, "rate": 1}, "corgi|2021-FW|plan": {"local": 517750, "rate": 1}, "kristensen|2026-SS|plan": {"local": 5120000, "rate": 1}, "kristensen|2026-SS|actual": {"local": 5365800, "rate": 1}, "kristensen|2026-FW|plan": {"local": 1890000.0000000002, "rate": 1}, "kristensen|2026-FW|actual": {"local": 1903000, "rate": 1}, "kristensen|2025-SS|plan": {"local": 5120000, "rate": 1}, "kristensen|2025-SS|actual": {"local": 5135900, "rate": 1}, "kristensen|2025-FW|plan": {"local": 3600000, "rate": 1}, "kristensen|2025-FW|actual": {"local": 3619000, "rate": 1}, "kristensen|2024-SS|actual": {"local": 6564250, "rate": 1}, "kristensen|2024-FW|actual": {"local": 3615750, "rate": 1}, "kristensen|2023-SS|actual": {"local": 1756000, "rate": 1}, "kristensen|2023-FW|plan": {"local": 6146500, "rate": 1}, "kristensen|2022-SS|actual": {"local": 3296000, "rate": 1}, "kristensen|2022-FW|plan": {"local": 1972000, "rate": 1}, "kristensen|2021-SS|actual": {"local": 1837450, "rate": 1}, "kristensen|2021-FW|plan": {"local": 6816500, "rate": 1}, "kristensen-high-summer|2026-SS|plan": {"local": 3413333.3333333335, "rate": 1}, "kristensen-high-summer|2026-SS|actual": {"local": 2261050, "rate": 1}, "kristensen-high-summer|2025-SS|plan": {"local": 3413333.3333333335, "rate": 1}, "kristensen-high-summer|2025-SS|actual": {"local": 3402850, "rate": 1}, "kristensen-high-summer|2024-SS|actual": {"local": 1454750, "rate": 1}, "kristensen-high-summer|2023-SS|actual": {"local": 6418000, "rate": 1}, "kristensen-high-summer|2022-SS|actual": {"local": 1590000, "rate": 1}, "kristensen-high-summer|2021-SS|actual": {"local": 2967000, "rate": 1}, "maison-fabre|2021-SS|actual": {"local": 266400, "rate": 1}, "maison-fabre|2021-FW|plan": {"local": 517750, "rate": 1}, "private0204|2026-SS|plan": {"local": 2133333.3333333335, "rate": 1}, "private0204|2026-SS|actual": {"local": 574200, "rate": 1}, "private0204|2026-FW|plan": {"local": 1800000, "rate": 1}, "private0204|2026-FW|actual": {"local": 132000, "rate": 1}, "private0204|2025-SS|plan": {"local": 2133333.3333333335, "rate": 1}, "private0204|2025-SS|actual": {"local": 2170850, "rate": 1}, "private0204|2025-FW|plan": {"local": 1800000, "rate": 1}, "private0204|2025-FW|actual": {"local": 1606000, "rate": 1}, "private0204|2024-SS|actual": {"local": 2012450, "rate": 1}, "private0204|2024-FW|actual": {"local": 1871100, "rate": 1}, "private0204|2023-SS|actual": {"local": 2036000, "rate": 1}, "private0204|2023-FW|plan": {"local": 2024500, "rate": 1}, "private0204|2022-SS|actual": {"local": 3127000, "rate": 1}, "private0204|2022-FW|plan": {"local": 1183000, "rate": 1}, "private0204|2021-SS|actual": {"local": 1928500, "rate": 1}, "private0204|2021-FW|plan": {"local": 2397500, "rate": 1}, "silvana-manetti|2024-FW|plan": {"local": 1848.331490797546, "rate": 1}, "silvana-manetti|2024-FW|actual": {"local": 170400, "rate": 1}, "stonesstone-zoo|2023-SS|actual": {"local": 2370000, "rate": 1}, "stonesstone-zoo|2023-FW|plan": {"local": 347400, "rate": 1}, "stonesstone-zoo|2022-FW|plan": {"local": 1359600, "rate": 1}, "rose-carmine|2023-FW|plan": {"local": 6024, "rate": 158.5}, "rose-carmine|2022-FW|plan": {"local": 2150, "rate": 144.5}, "tagliovivo|2026-SS|plan": {"local": 533333.3333333334, "rate": 1}, "tagliovivo|2026-SS|actual": {"local": 1202300, "rate": 1}, "tagliovivo|2026-FW|plan": {"local": 540000, "rate": 1}, "tagliovivo|2026-FW|actual": {"local": 1885150, "rate": 1}, "tagliovivo|2025-SS|plan": {"local": 533333.3333333334, "rate": 1}, "tagliovivo|2025-SS|actual": {"local": 900900, "rate": 1}, "tagliovivo|2025-FW|plan": {"local": 1080000, "rate": 1}, "tagliovivo|2025-FW|actual": {"local": 583000, "rate": 1}, "tagliovivo|2024-SS|actual": {"local": 1009800, "rate": 1}, "tagliovivo|2024-FW|actual": {"local": 353100.00000000006, "rate": 1}, "tagliovivo|2023-FW|plan": {"local": 2528400, "rate": 1}, "tagliovivo|2021-SS|actual": {"local": 275000, "rate": 1}, "the-row|2026-SS|plan": {"local": 2560000, "rate": 1}, "the-row|2026-SS|actual": {"local": 5537000, "rate": 1}, "the-row|2026-FW|plan": {"local": 2700000, "rate": 1}, "the-row|2026-FW|actual": {"local": 3167500, "rate": 1}, "the-row|2025-SS|plan": {"local": 2560000, "rate": 1}, "the-row|2025-SS|actual": {"local": 2326500, "rate": 1}, "the-row|2025-FW|plan": {"local": 5435100, "rate": 1}, "the-row|2025-FW|actual": {"local": 5435100, "rate": 1}, "the-row|2024-SS|actual": {"local": 3173500, "rate": 1}, "the-row|2024-FW|plan": {"local": 4142572.9537500003, "rate": 1}, "the-row|2024-FW|actual": {"local": 4741500, "rate": 1}, "the-row|2023-SS|actual": {"local": 1941000, "rate": 1}, "the-row|2023-FW|plan": {"local": 3973000, "rate": 1}, "the-row|2022-SS|actual": {"local": 3529000, "rate": 1}, "the-row|2022-FW|plan": {"local": 1656500, "rate": 1}, "the-row|2021-SS|actual": {"local": 857000, "rate": 1}, "the-row|2021-FW|plan": {"local": 920000, "rate": 1}, "the-row-2|2026-SS|plan": {"local": 1706666.6666666667, "rate": 1}, "the-row-2|2026-SS|actual": {"local": 2275500, "rate": 1}, "the-row-2|2026-FW|plan": {"local": 1890000.0000000002, "rate": 1}, "the-row-2|2026-FW|actual": {"local": 1488500, "rate": 1}, "the-row-2|2025-SS|plan": {"local": 1706666.6666666667, "rate": 1}, "the-row-2|2025-SS|actual": {"local": 3861550, "rate": 1}, "the-row-2|2025-FW|actual": {"local": 2760500, "rate": 1}, "the-row-2|2024-SS|actual": {"local": 3180500, "rate": 1}, "the-row-2|2024-FW|plan": {"local": 2108946.231, "rate": 1}, "the-row-2|2024-FW|actual": {"local": 2314500, "rate": 1}, "the-row-2|2023-SS|actual": {"local": 1315000, "rate": 1}, "the-row-2|2023-FW|plan": {"local": 4114000, "rate": 1}, "the-row-2|2022-SS|actual": {"local": 1393500, "rate": 1}, "the-row-2|2022-FW|plan": {"local": 1493000, "rate": 1}, "the-row-2|2021-FW|plan": {"local": 4185000, "rate": 1}, "oluhi|2026-SS|plan": {"local": 17073.1707, "rate": 41.0}, "oluhi|2025-SS|plan": {"local": 17073.1707, "rate": 41.0}, "oluhi|2025-FW|plan": {"local": 4363.6364, "rate": 165.0}, "oluhi|2024-FW|plan": {"local": 3696.663, "rate": 163.0}, "isabella-stefanelli|2026-SS|plan": {"local": 10512.8197, "rate": 195.0}, "isabella-stefanelli|2026-SS|actual": {"local": 7250, "rate": 195.0}, "isabella-stefanelli|2026-FW|plan": {"local": 14727.2727, "rate": 220.0}, "isabella-stefanelli|2026-FW|actual": {"local": 5330, "rate": 220.0}, "isabella-stefanelli|2025-SS|plan": {"local": 10512.8197, "rate": 195.0}, "isabella-stefanelli|2025-SS|actual": {"local": 13369, "rate": 195.0}, "isabella-stefanelli|2025-FW|plan": {"local": 17052.6316, "rate": 190.0}, "isabella-stefanelli|2025-FW|actual": {"local": 13714, "rate": 190.0}, "isabella-stefanelli|2024-SS|actual": {"local": 15189, "rate": 181.94}, "isabella-stefanelli|2024-FW|actual": {"local": 9726, "rate": 190.0}, "isabella-stefanelli|2023-SS|actual": {"local": 12764, "rate": 161.899013}, "isabella-stefanelli|2022-SS|actual": {"local": 16568, "rate": 161.899}, "isabella-stefanelli|2022-FW|plan": {"local": 16684, "rate": 161.899}, "isabella-stefanelli|2021-SS|actual": {"local": 22340, "rate": 150.9644}, "isabella-stefanelli|2021-FW|plan": {"local": 25564, "rate": 150.9644}, "mariko-tsuchiyama|2023-SS|actual": {"local": 3700, "rate": 161.898919}, "mariko-tsuchiyama|2023-FW|plan": {"local": 6000, "rate": 181.94}, "mariko-tsuchiyama|2022-FW|plan": {"local": 1740, "rate": 161.899}, "mariko-tsuchiyama|2021-SS|actual": {"local": 2577, "rate": 150.9644}, "mariko-tsuchiyama|2021-FW|plan": {"local": 3525, "rate": 150.9644}, "atelier-inscere|2025-FW|actual": {"local": 1980, "rate": 165.0}, "rosie-sugden|2025-FW|actual": {"local": 1710, "rate": 190.0}};

function roundTo(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

const SEED_ENTRIES = Object.fromEntries(
  Object.entries(RAW_SEED_ENTRIES).map(([k, v]) => [k, { ...v, local: roundTo(v.local, 0) }])
);

function seedSeasons() {
  const years = [2021, 2022, 2023, 2024, 2025, 2026];
  const list = [];
  years.forEach((y) => {
    ["SS", "FW"].forEach((t) => {
      list.push({ id: `${y}-${t}`, year: y, type: t, label: `${y} ${t}` });
    });
  });
  return list;
}

function seasonOrderValue(s) {
  return s.year * 2 + (s.type === "SS" ? 0 : 1);
}

function sortSeasons(list) {
  return [...list].sort((a, b) => seasonOrderValue(a) - seasonOrderValue(b));
}

function seedMasters() {
  return {
    currencies: DEFAULT_CURRENCIES,
    brands: SEED_BRANDS,
    seasons: seedSeasons(),
  };
}

const fmtJPY = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const r = Math.round(n);
  return r.toLocaleString("ja-JP");
};
const fmtPct = (n, digits = 1) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
};
const fmtNum = (n, digits = 2) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return Number(n).toString();
};

function entryKey(brandId, seasonId, kind) {
  return `${brandId}|${seasonId}|${kind}`;
}

function computeJPY(local, rate, currencyCode) {
  const l = Number(local) || 0;
  if (currencyCode === "JPY") return l;
  const r = Number(rate) || 0;
  return l * r;
}

// Sums Total WSP (local currency) and derives a blended JPY rate from
// registered Orders for a given brand+season. Returns null if there are
// no orders for that combination, so manual Actual entries take over.
function rollupOrdersForBrandSeason(orders, brandId, seasonId) {
  const matches = (orders || []).filter((o) => o.brandId === brandId && o.seasonId === seasonId);
  if (matches.length === 0) return null;
  let local = 0;
  let jpy = 0;
  matches.forEach((o) => {
    const wsp = Number(o.totalWSP) || 0;
    const rate = o.currency === "JPY" ? 1 : (Number(o.exrate) || 0);
    local += wsp;
    jpy += wsp * rate;
  });
  const rate = local ? jpy / local : 0;
  return { local, rate, jpy, count: matches.length };
}

// The store-launch fiscal year runs February -> January.
// Builds the 12 ordered {key, label, monthNum, year} columns for a given fiscal year.
function fiscalMonthColumns(fiscalYear) {
  const cols = [];
  for (let i = 0; i < 12; i++) {
    const monthNum = ((1 + i) % 12) + 1; // 2,3,...,12,1
    const year = monthNum === 1 ? fiscalYear + 1 : fiscalYear;
    cols.push({ key: `${year}-${String(monthNum).padStart(2, "0")}`, label: MONTHS[monthNum - 1], monthNum, year });
  }
  return cols;
}

// Maps an order's LTS (ship month name) to a concrete year+month key, inferring
// the year from the order's season year (January ships are treated as the
// following calendar year, matching the Feb-start fiscal year convention).
function orderMonthKey(order, seasonsById) {
  if (!order.lts) return null;
  const monthNum = MONTHS.indexOf(order.lts) + 1;
  if (monthNum <= 0) return null;
  const season = seasonsById[order.seasonId];
  const seasonYear = season ? season.year : new Date().getFullYear();
  const year = monthNum === 1 ? seasonYear + 1 : seasonYear;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
}

// Splits an order's money into the "Purchase Amount" (Total WSP, what's wired
// to the brand) and the "IPC Amount" (the AF/IPC markup portion on top of it),
// each in local currency and its JPY equivalent — for accounts-payable planning.
function computeOrderMoney(o) {
  const rate = o.currency === "JPY" ? 1 : (Number(o.exrate) || 0);
  const purchaseLocal = Number(o.totalWSP) || 0;
  const ipcLocal = (Number(o.totalWSPLB) || 0) - purchaseLocal;
  return {
    purchaseLocal,
    purchaseJPY: purchaseLocal * rate,
    ipcLocal,
    ipcJPY: ipcLocal * rate,
  };
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function EditableNumber({ value, onCommit, placeholder = "0", align = "right", width = 88, mono = true, round = null, thousands = false }) {
  const format = (v) => {
    if (v === undefined || v === null || v === "") return "";
    return thousands ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(v);
  };
  const [text, setText] = useState(format(value));
  useEffect(() => {
    setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="bbp-input"
      style={{ width, textAlign: align, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
      value={text}
      placeholder={placeholder}
      inputMode="decimal"
      onFocus={() => {
        if (thousands) setText(value === undefined || value === null || value === "" ? "" : String(value));
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() === "") { onCommit(""); return; }
        let n = Number(text.replace(/,/g, ""));
        if (Number.isNaN(n)) n = 0;
        if (round !== null) {
          const f = Math.pow(10, round);
          n = Math.round(n * f) / f;
        }
        onCommit(n);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
    />
  );
}

function Pill({ children, tone = "neutral" }) {
  return <span className={`bbp-pill bbp-pill--${tone}`}>{children}</span>;
}

function Modal({ modal, onClose }) {
  const [values, setValues] = useState({});

  useEffect(() => {
    if (modal && modal.fields) {
      const init = {};
      modal.fields.forEach((f) => { init[f.key] = f.defaultValue || ""; });
      setValues(init);
    } else {
      setValues({});
    }
  }, [modal]);

  if (!modal) return null;

  const handleConfirm = () => {
    if (modal.onConfirm) modal.onConfirm(values);
    onClose();
  };

  return (
    <div className="bbp-modal-overlay" onClick={onClose}>
      <div className="bbp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bbp-modal-title">{modal.title}</div>
        {modal.message && <div className="bbp-modal-message">{modal.message}</div>}
        {modal.fields && modal.fields.map((f, i) => (
          <div key={f.key} className="bbp-modal-field">
            <label>{f.label}</label>
            <input
              autoFocus={i === 0}
              value={values[f.key] || ""}
              placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") handleConfirm(); }}
            />
          </div>
        ))}
        <div className="bbp-modal-actions">
          {modal.type !== "alert" && (
            <button className="bbp-modal-btn bbp-modal-btn--ghost" onClick={onClose}>Cancel</button>
          )}
          <button
            className={`bbp-modal-btn ${modal.danger ? "bbp-modal-btn--danger" : ""}`}
            onClick={handleConfirm}
          >
            {modal.confirmLabel || (modal.type === "alert" ? "OK" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="bbp-splash">
      <div className="bbp-splash-eyebrow">T.O</div>
      <div className="bbp-splash-title">THE BUY</div>
      <div className="bbp-splash-bar"><div className="bbp-splash-bar-fill" /></div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main App                                                             */
/* ------------------------------------------------------------------ */

export default function App() {
  const [masters, setMasters] = useState(null);
  const [entries, setEntries] = useState(null);
  const [orders, setOrders] = useState(null);
  const [launchPlan, setLaunchPlan] = useState(null);
  const [tab, setTab] = useState("home");
  const [seasonId, setSeasonId] = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [loadError, setLoadError] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [modal, setModal] = useState(null);
  const [minSplashDone, setMinSplashDone] = useState(false);
  const saveTimer = useRef(null);
  const firstLoad = useRef(true);
  const fileInputRef = useRef(null);

  // Keeps the splash (with its fade-in + unlock click) on screen for a fixed
  // minimum duration, regardless of how fast data actually loads.
  useEffect(() => {
    const t = setTimeout(() => setMinSplashDone(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  /* ---- load ---- */
  useEffect(() => {
    (async () => {
      let m = null, e = null, o = null, lp = null;
      try {
        const r = await window.storage.get("bybrand:masters");
        if (r && r.value) m = JSON.parse(r.value);
      } catch (err) { /* not found */ }
      try {
        const r = await window.storage.get("bybrand:entries");
        if (r && r.value) e = JSON.parse(r.value);
      } catch (err) { /* not found */ }
      try {
        const r = await window.storage.get("bybrand:orders");
        if (r && r.value) o = JSON.parse(r.value);
      } catch (err) { /* not found */ }
      try {
        const r = await window.storage.get("bybrand:launchplan");
        if (r && r.value) lp = JSON.parse(r.value);
      } catch (err) { /* not found */ }

      if (!m) m = seedMasters();
      if (!e) e = SEED_ENTRIES;
      if (!o) o = [];
      if (!lp) lp = { fiscalYear: new Date().getFullYear(), taxRate: 0.10, events: [], eventValues: {}, salesPlan: {} };

      // One-time migration: older versions stored each order's photos inline
      // (base64) inside the orders array itself. Move any such photos out to
      // their own per-order key so a growing photo library never crowds out
      // other orders' data, and so photos can be stored at higher quality.
      let migrated = false;
      const migratedOrders = [];
      for (const ord of o) {
        const hasInline = ORDER_IMAGE_FIELDS.some((k) => typeof ord[k] === "string" && ord[k].startsWith("data:"));
        if (hasInline) {
          const { rest, images } = splitOrderImages(ord);
          await saveOrderImages(ord.id, images);
          migratedOrders.push(rest);
          migrated = true;
        } else {
          migratedOrders.push(ord);
        }
      }
      if (migrated) {
        o = migratedOrders;
        try { await window.storage.set("bybrand:orders", JSON.stringify(o), false); } catch (err) { /* will retry on next save */ }
      }

      setMasters(m);
      setEntries(e);
      setOrders(o);
      setLaunchPlan(lp);
      const sorted = sortSeasons(m.seasons);
      setSeasonId(sorted[sorted.length - 1]?.id ?? null);
    })().catch(() => setLoadError(true));
  }, []);

  /* ---- save (debounced) ---- */
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = masters !== null && entries !== null && orders !== null && launchPlan !== null ? false : true; return; }
    if (masters === null || entries === null || orders === null || launchPlan === null) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await window.storage.set("bybrand:masters", JSON.stringify(masters), false);
        await window.storage.set("bybrand:entries", JSON.stringify(entries), false);
        await window.storage.set("bybrand:orders", JSON.stringify(orders), false);
        await window.storage.set("bybrand:launchplan", JSON.stringify(launchPlan), false);
        setSaveState("saved");
      } catch (err) {
        setSaveState("idle");
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masters, entries, orders, launchPlan]);

  /* ---- manual backup: export / import ---- */
  const handleExport = useCallback(() => {
    if (!masters || !entries) return;
    const payload = {
      type: "bybrand-backup",
      exportedAt: new Date().toISOString(),
      masters,
      entries,
      orders: orders || [],
      launchPlan: launchPlan || null,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `the-buy-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [masters, entries, orders, launchPlan]);

  const handleImportClick = () => fileInputRef.current && fileInputRef.current.click();

  const handleImportFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !parsed.masters || !parsed.entries) throw new Error("bad shape");
        setModal({
          type: "confirm",
          title: "Restore Backup",
          message: `Restore data from this backup file${parsed.exportedAt ? ` (saved ${new Date(parsed.exportedAt).toLocaleString()})` : ""}? This replaces everything currently on screen.`,
          danger: true,
          confirmLabel: "Restore",
          onConfirm: () => {
            setMasters(parsed.masters);
            setEntries(parsed.entries);
            setOrders(parsed.orders || []);
            setLaunchPlan(parsed.launchPlan || { fiscalYear: new Date().getFullYear(), taxRate: 0.10, events: [], eventValues: {}, salesPlan: {} });
            setImportMsg("Backup restored.");
            setTimeout(() => setImportMsg(""), 4000);
          },
        });
      } catch (err) {
        setModal({ type: "alert", title: "Import Failed", message: "This file could not be read as a The Buy backup." });
      }
    };
    reader.readAsText(file);
  };

  const sortedSeasons = useMemo(() => (masters ? sortSeasons(masters.seasons) : []), [masters]);
  const activeBrands = useMemo(
    () => (masters ? masters.brands.filter((b) => showInactive || b.active) : []),
    [masters, showInactive]
  );
  const currencyMap = useMemo(() => {
    const map = {};
    if (masters) masters.currencies.forEach((c) => (map[c.code] = c));
    return map;
  }, [masters]);

  const setEntry = useCallback((brandId, sId, kind, field, value) => {
    setEntries((prev) => {
      const key = entryKey(brandId, sId, kind);
      const cur = prev[key] || {};
      return { ...prev, [key]: { ...cur, [field]: value } };
    });
  }, []);

  const getEntry = useCallback(
    (brandId, sId, kind) => (entries && entries[entryKey(brandId, sId, kind)]) || {},
    [entries]
  );

  /* ---- derived rows for currently selected season ---- */
  const seasonIdx = sortedSeasons.findIndex((s) => s.id === seasonId);
  const currentSeason = sortedSeasons[seasonIdx];
  const prevYearSeason = currentSeason
    ? sortedSeasons.find((s) => s.type === currentSeason.type && s.year === currentSeason.year - 1)
    : null;

  const rows = useMemo(() => {
    if (!masters || !currentSeason) return [];
    return activeBrands.map((b) => {
      const cur = currencyMap[b.currency] || { code: b.currency };
      let plan = getEntry(b.id, currentSeason.id, "plan");
      if (prevYearSeason && (plan.local === undefined || plan.rate === undefined)) {
        const prevPlan = getEntry(b.id, prevYearSeason.id, "plan");
        plan = {
          ...plan,
          local: plan.local !== undefined ? plan.local : prevPlan.local,
          rate: plan.rate !== undefined ? plan.rate : prevPlan.rate,
        };
      }
      const manualActual = getEntry(b.id, currentSeason.id, "actual");
      const rollup = rollupOrdersForBrandSeason(orders, b.id, currentSeason.id);
      const actual = rollup ? { local: Math.round(rollup.local), rate: rollup.rate } : manualActual;
      const actualSource = rollup ? "orders" : "manual";
      const planJPY = computeJPY(plan.local, cur.code === "JPY" ? 1 : plan.rate, cur.code);
      const actualJPY = rollup ? rollup.jpy : computeJPY(actual.local, cur.code === "JPY" ? 1 : actual.rate, cur.code);

      let yoyActualJPY = null;
      if (prevYearSeason) {
        const prevRollup = rollupOrdersForBrandSeason(orders, b.id, prevYearSeason.id);
        if (prevRollup) {
          yoyActualJPY = prevRollup.jpy;
        } else {
          const pa = getEntry(b.id, prevYearSeason.id, "actual");
          yoyActualJPY = computeJPY(pa.local, cur.code === "JPY" ? 1 : pa.rate, cur.code);
        }
      }
      return { brand: b, currency: cur, plan, actual, actualSource, planJPY, actualJPY, yoyActualJPY };
    });
  }, [masters, activeBrands, currentSeason, prevYearSeason, getEntry, currencyMap, orders]);

  const seasonPlanTotal = rows.reduce((s, r) => s + r.planJPY, 0);
  const seasonActualTotal = rows.reduce((s, r) => s + r.actualJPY, 0);
  const seasonYoyTotal = rows.reduce((s, r) => s + (r.yoyActualJPY || 0), 0);
  const vsPlanTotalPct = seasonPlanTotal ? seasonActualTotal / seasonPlanTotal - 1 : null;
  const yoyTotalPct = seasonYoyTotal ? seasonActualTotal / seasonYoyTotal : null;

  /* ---- dashboard aggregates across all seasons ---- */
  const trend = useMemo(() => {
    if (!masters) return [];
    return sortedSeasons.map((s) => {
      let plan = 0, actual = 0;
      activeBrands.forEach((b) => {
        const cur = currencyMap[b.currency] || { code: b.currency };
        const p = getEntry(b.id, s.id, "plan");
        const a = getEntry(b.id, s.id, "actual");
        plan += computeJPY(p.local, cur.code === "JPY" ? 1 : p.rate, cur.code);
        actual += computeJPY(a.local, cur.code === "JPY" ? 1 : a.rate, cur.code);
      });
      return { label: s.label, Plan: Math.round(plan), Actual: Math.round(actual) };
    });
  }, [masters, sortedSeasons, activeBrands, currencyMap, getEntry]);

  const brandBreakdown = useMemo(() => {
    return rows
      .map((r) => ({ name: r.brand.name, Actual: Math.round(r.actualJPY) }))
      .filter((r) => r.Actual > 0)
      .sort((a, b) => b.Actual - a.Actual);
  }, [rows]);

  /* ---- master editing ---- */
  const addBrand = () => {
    setModal({
      type: "form",
      title: "Add Brand",
      confirmLabel: "Add",
      fields: [{ key: "name", label: "Brand Name", placeholder: "e.g. Studio Nicholson" }],
      onConfirm: (vals) => {
        const name = (vals.name || "").trim();
        if (!name) return;
        setMasters((m) => ({
          ...m,
          brands: [...m.brands, { id: uid(), name, currency: "EUR", active: true }],
        }));
      },
    });
  };
  const updateBrand = (id, patch) => {
    setMasters((m) => ({ ...m, brands: m.brands.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  };
  const removeBrand = (id) => {
    setModal({
      type: "confirm",
      title: "Delete Brand",
      message: "Delete this brand? Any data entered for it will no longer be shown.",
      danger: true,
      confirmLabel: "Delete",
      onConfirm: () => setMasters((m) => ({ ...m, brands: m.brands.filter((b) => b.id !== id) })),
    });
  };
  const addCurrency = () => {
    setModal({
      type: "form",
      title: "Add Currency",
      confirmLabel: "Add",
      fields: [
        { key: "code", label: "Currency Code", placeholder: "e.g. USD" },
        { key: "name", label: "Currency Name", placeholder: "e.g. US Dollar" },
      ],
      onConfirm: (vals) => {
        const code = (vals.code || "").trim().toUpperCase();
        if (!code) return;
        const name = (vals.name || "").trim() || code;
        setMasters((m) => ({ ...m, currencies: [...m.currencies, { code, name }] }));
      },
    });
  };
  const removeCurrency = (code) => {
    if (code === "JPY") return;
    setMasters((m) => ({ ...m, currencies: m.currencies.filter((c) => c.code !== code) }));
  };
  const addSeason = () => {
    const nextYear = sortedSeasons.length ? sortedSeasons[sortedSeasons.length - 1].year : new Date().getFullYear();
    setModal({
      type: "form",
      title: "Add Season",
      confirmLabel: "Add",
      fields: [
        { key: "year", label: "Year", placeholder: String(nextYear), defaultValue: String(nextYear) },
        { key: "type", label: "Season (SS or FW)", placeholder: "SS", defaultValue: "SS" },
      ],
      onConfirm: (vals) => {
        const y = Number(vals.year) || nextYear;
        const t = (vals.type || "SS").toUpperCase() === "FW" ? "FW" : "SS";
        const id = `${y}-${t}`;
        setMasters((m) => {
          if (m.seasons.find((s) => s.id === id)) return m;
          return { ...m, seasons: [...m.seasons, { id, year: y, type: t, label: `${y} ${t}` }] };
        });
        setSeasonId(id);
      },
    });
  };
  const removeSeason = (id) => {
    setModal({
      type: "confirm",
      title: "Delete Season",
      message: "Delete this season? Any data entered for it will no longer be shown.",
      danger: true,
      confirmLabel: "Delete",
      onConfirm: () => setMasters((m) => ({ ...m, seasons: m.seasons.filter((s) => s.id !== id) })),
    });
  };

  if (loadError) {
    return <div className="bbp-root"><div className="bbp-error">Failed to load data. Please reload the page.</div></div>;
  }
  if (!masters || !entries || !orders || !launchPlan || !minSplashDone) {
    return (
      <div className="bbp-root">
        <Style />
        <Splash />
      </div>
    );
  }

  return (
    <div className="bbp-root">
      <Style />
      <aside className="bbp-side">
        <div className="bbp-brandmark" role="button" tabIndex={0} onClick={() => setTab("home")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setTab("home"); }}>
          <div className="bbp-brandmark-eyebrow">T.O</div>
          <div className="bbp-brandmark-title">THE BUY</div>
        </div>
        <nav className="bbp-nav">
          <button className={`bbp-navitem ${tab === "table" ? "is-active" : ""}`} onClick={() => setTab("table")}>
            <span className="bbp-navitem-num">01</span>Purchase Plan
          </button>
          <button className={`bbp-navitem ${tab === "orders" ? "is-active" : ""}`} onClick={() => setTab("orders")}>
            <span className="bbp-navitem-num">02</span>Orders
          </button>
          <button className={`bbp-navitem ${tab === "launch" ? "is-active" : ""}`} onClick={() => setTab("launch")}>
            <span className="bbp-navitem-num">03</span>Launch Plan
          </button>
          <button className={`bbp-navitem ${tab === "payment" ? "is-active" : ""}`} onClick={() => setTab("payment")}>
            <span className="bbp-navitem-num">04</span>Payment Plan
          </button>
          <button className={`bbp-navitem ${tab === "dashboard" ? "is-active" : ""}`} onClick={() => setTab("dashboard")}>
            <span className="bbp-navitem-num">05</span>Dashboard
          </button>
          <button className={`bbp-navitem ${tab === "masters" ? "is-active" : ""}`} onClick={() => setTab("masters")}>
            <span className="bbp-navitem-num">06</span>Setup
          </button>
        </nav>
        <div className="bbp-savebox">
          <span className={`bbp-dot bbp-dot--${saveState}`} />
          {saveState === "saving" ? "Saving…" : "Autosaved"}
        </div>
        <div className="bbp-backupbox">
          <button className="bbp-backupbtn" onClick={handleExport}>Export Backup</button>
          <button className="bbp-backupbtn" onClick={handleImportClick}>Import Backup</button>
          <input ref={fileInputRef} type="file" accept="application/json" onChange={handleImportFile} style={{ display: "none" }} />
          {importMsg && <div className="bbp-importmsg">{importMsg}</div>}
        </div>
      </aside>

      <main className="bbp-main">
        {tab === "home" && <div className="bbp-home" />}
        {tab === "table" && (
          <TablePane
            sortedSeasons={sortedSeasons}
            seasonId={seasonId}
            setSeasonId={setSeasonId}
            currentSeason={currentSeason}
            rows={rows}
            orders={orders}
            seasonPlanTotal={seasonPlanTotal}
            seasonActualTotal={seasonActualTotal}
            vsPlanTotalPct={vsPlanTotalPct}
            yoyTotalPct={yoyTotalPct}
            showInactive={showInactive}
            setShowInactive={setShowInactive}
            setEntry={setEntry}
          />
        )}
        {tab === "orders" && (
          <OrdersPane
            masters={masters}
            sortedSeasons={sortedSeasons}
            orders={orders}
            setOrders={setOrders}
            seasonId={seasonId}
            setSeasonId={setSeasonId}
            setModal={setModal}
          />
        )}
        {tab === "launch" && (
          <LaunchPlanPane
            masters={masters}
            sortedSeasons={sortedSeasons}
            orders={orders}
            launchPlan={launchPlan}
            setLaunchPlan={setLaunchPlan}
            setModal={setModal}
          />
        )}
        {tab === "payment" && (
          <PaymentPlanPane
            masters={masters}
            sortedSeasons={sortedSeasons}
            orders={orders}
            launchPlan={launchPlan}
            setLaunchPlan={setLaunchPlan}
          />
        )}
        {tab === "dashboard" && (
          <DashboardPane
            trend={trend}
            brandBreakdown={brandBreakdown}
            currentSeason={currentSeason}
            sortedSeasons={sortedSeasons}
            seasonId={seasonId}
            setSeasonId={setSeasonId}
          />
        )}
        {tab === "masters" && (
          <MastersPane
            masters={masters}
            addBrand={addBrand}
            updateBrand={updateBrand}
            removeBrand={removeBrand}
            addCurrency={addCurrency}
            removeCurrency={removeCurrency}
            addSeason={addSeason}
            removeSeason={removeSeason}
            sortedSeasons={sortedSeasons}
          />
        )}
      </main>
      <Modal modal={modal} onClose={() => setModal(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table pane                                                           */
/* ------------------------------------------------------------------ */

function TablePane({
  sortedSeasons, seasonId, setSeasonId, currentSeason, rows, orders,
  seasonPlanTotal, seasonActualTotal, vsPlanTotalPct, yoyTotalPct,
  showInactive, setShowInactive, setEntry,
}) {
  const yoyLabel = currentSeason
    ? (
      <>
        <span style={{ textTransform: "lowercase" }}>vs</span>
        {String((currentSeason.year - 1) % 100).padStart(2, "0")}{currentSeason.type}
      </>
    )
    : "YoY";
  return (
    <div className="bbp-pane">
      <header className="bbp-pane-head">
        <div>
          <div className="bbp-eyebrow">Season</div>
          <h1 className="bbp-title">{currentSeason ? currentSeason.label : "—"} Purchase Plan</h1>
        </div>
        <div className="bbp-headctrls">
          <select className="bbp-select" value={seasonId || ""} onChange={(e) => setSeasonId(e.target.value)}>
            {sortedSeasons.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <label className="bbp-check">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show hidden brands
          </label>
        </div>
      </header>

      <div className="bbp-summary">
        <SummaryCard label="Total Plan" value={`¥${fmtJPY(seasonPlanTotal)}`} tone="plan" />
        <SummaryCard label="Total Actual" value={`¥${fmtJPY(seasonActualTotal)}`} tone="actual" />
        <SummaryCard
          label="vs Plan"
          value={fmtPct(vsPlanTotalPct)}
          tone={vsPlanTotalPct === null ? "neutral" : vsPlanTotalPct >= 0 ? "positive" : "negative"}
        />
        <SummaryCard
          label={yoyLabel}
          value={fmtPct(yoyTotalPct)}
          tone={yoyTotalPct === null ? "neutral" : yoyTotalPct >= 1 ? "positive" : "negative"}
        />
      </div>

      <div className="bbp-tablewrap">
        <table className="bbp-table">
          <thead>
            <tr>
              <th className="bbp-th-brand">Brand</th>
              <th>Currency</th>
              <th>Plan<br />Local Amt</th>
              <th>Plan<br />Rate</th>
              <th>Plan<br />JPY</th>
              <th>Plan<br />Share</th>
              <th>Actual<br />Local Amt</th>
              <th>Actual<br />Rate</th>
              <th>Actual<br />JPY</th>
              <th>Actual<br />Share</th>
              <th>vs Plan</th>
              <th>{yoyLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isJPY = r.currency.code === "JPY";
              const planShare = seasonPlanTotal ? r.planJPY / seasonPlanTotal : null;
              const share = seasonActualTotal ? r.actualJPY / seasonActualTotal : null;
              const vsPlan = r.planJPY ? r.actualJPY / r.planJPY - 1 : null;
              const yoy = r.yoyActualJPY ? r.actualJPY / r.yoyActualJPY : null;
              return (
                <tr key={r.brand.id} className={r.brand.active ? "" : "bbp-row--inactive"}>
                  <td className="bbp-td-brand">{r.brand.name}</td>
                  <td className="bbp-td-currency">{r.currency.code}</td>

                  <td>
                    <EditableNumber
                      value={r.plan.local}
                      round={0}
                      thousands
                      width={100}
                      onCommit={(v) => setEntry(r.brand.id, currentSeason.id, "plan", "local", v)}
                    />
                  </td>
                  <td className="bbp-td-rate">
                    {isJPY ? <span className="bbp-fixed">—</span> : (
                      <EditableNumber
                        value={r.plan.rate}
                        width={64}
                        align="center"
                        onCommit={(v) => setEntry(r.brand.id, currentSeason.id, "plan", "rate", v)}
                      />
                    )}
                  </td>
                  <td className="bbp-td-jpy bbp-td-jpy--plan">¥{fmtJPY(r.planJPY)}</td>
                  <td className="bbp-td-num">{fmtPct(planShare)}</td>

                  <td>
                    {r.actualSource === "orders" ? (
                      <span className="bbp-fromorders" title={`Rolled up from ${orders.filter((o) => o.brandId === r.brand.id && o.seasonId === currentSeason.id).length} order(s)`}>
                        {fmtJPY(r.actual.local)}
                        <span className="bbp-fromorders-tag">Orders</span>
                      </span>
                    ) : (
                      <EditableNumber
                        value={r.actual.local}
                        round={0}
                        thousands
                        width={100}
                        onCommit={(v) => setEntry(r.brand.id, currentSeason.id, "actual", "local", v)}
                      />
                    )}
                  </td>
                  <td className="bbp-td-rate">
                    {r.actualSource === "orders" ? (
                      <span className="bbp-fromorders">{r.actual.rate ? r.actual.rate.toFixed(2) : "—"}</span>
                    ) : isJPY ? <span className="bbp-fixed">—</span> : (
                      <EditableNumber
                        value={r.actual.rate}
                        width={64}
                        align="center"
                        onCommit={(v) => setEntry(r.brand.id, currentSeason.id, "actual", "rate", v)}
                      />
                    )}
                  </td>
                  <td className="bbp-td-jpy bbp-td-jpy--actual">¥{fmtJPY(r.actualJPY)}</td>

                  <td className="bbp-td-num">{fmtPct(share)}</td>
                  <td className="bbp-td-num">
                    {vsPlan === null ? "—" : <Pill tone={vsPlan >= 0 ? "positive" : "negative"}>{fmtPct(vsPlan)}</Pill>}
                  </td>
                  <td className="bbp-td-num">
                    {yoy === null ? "—" : <Pill tone={yoy >= 1 ? "positive" : "negative"}>{fmtPct(yoy)}</Pill>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="bbp-td-totallabel">Total</td>
              <td className="bbp-td-jpy bbp-td-jpy--plan">¥{fmtJPY(seasonPlanTotal)}</td>
              <td>100%</td>
              <td colSpan={2}></td>
              <td className="bbp-td-jpy bbp-td-jpy--actual">¥{fmtJPY(seasonActualTotal)}</td>
              <td>100%</td>
              <td>{fmtPct(vsPlanTotalPct)}</td>
              <td>{fmtPct(yoyTotalPct)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }) {
  return (
    <div className={`bbp-card bbp-card--${tone}`}>
      <div className="bbp-card-label">{label}</div>
      <div className="bbp-card-value">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard pane                                                       */
/* ------------------------------------------------------------------ */

const PIE_COLORS = ["#111110"];

function DashboardPane({ trend, brandBreakdown, currentSeason, sortedSeasons, seasonId, setSeasonId }) {
  return (
    <div className="bbp-pane">
      <header className="bbp-pane-head">
        <div>
          <div className="bbp-eyebrow">Overview</div>
          <h1 className="bbp-title">Dashboard</h1>
        </div>
      </header>

      <section className="bbp-chartcard">
        <h2 className="bbp-chartcard-title">Plan vs Actual by Season (¥)</h2>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={trend} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#111110" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#111110" }} axisLine={{ stroke: "#111110" }} tickLine={false} />
            <YAxis tick={{ fontSize: 12, fill: "#111110" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${Math.round(v / 1000000)}M`} />
            <Tooltip formatter={(v) => `¥${fmtJPY(v)}`} contentStyle={{ fontFamily: "var(--font-mono)", fontSize: 12, border: "1px solid #111110", borderRadius: 0 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Plan" fill="#111110" radius={[0, 0, 0, 0]} barSize={18} />
            <Line type="monotone" dataKey="Actual" stroke="#111110" strokeWidth={2.5} dot={{ r: 3, fill: "#111110" }} />
          </ComposedChart>
        </ResponsiveContainer>
      </section>

      <section className="bbp-chartcard">
        <div className="bbp-chartcard-headrow">
          <h2 className="bbp-chartcard-title bbp-chartcard-title--flush">
            {currentSeason ? `${currentSeason.label} Actuals by Brand` : "Actuals by Brand"}
          </h2>
          <select className="bbp-select" value={seasonId || ""} onChange={(e) => setSeasonId(e.target.value)}>
            {sortedSeasons.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        {brandBreakdown.length === 0 ? (
          <div className="bbp-empty">No actuals recorded for this season yet. Enter them from the Purchase Plan tab.</div>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(280, brandBreakdown.length * 30)}>
            <BarChart data={brandBreakdown} layout="vertical" margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
              <CartesianGrid stroke="#111110" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#111110" }} tickFormatter={(v) => `${Math.round(v / 1000000)}M`} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 12, fill: "#111110" }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v) => `¥${fmtJPY(v)}`} contentStyle={{ fontFamily: "var(--font-mono)", fontSize: 12, border: "1px solid #111110", borderRadius: 0 }} />
              <Bar dataKey="Actual" radius={[0, 0, 0, 0]} barSize={14}>
                {brandBreakdown.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Orders pane (feeds Actual figures on the Purchase Plan table)        */
/* ------------------------------------------------------------------ */

function fmt2(n) {
  return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function ImageDropZone({ label, value, onChange }) {
  const [dragOver, setDragOver] = useState(false);
  const handleFile = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const dataUrl = await resizeImageFile(file);
      onChange(dataUrl);
    } catch (err) { /* ignore unreadable file */ }
  };
  return (
    <div
      className={`bbp-imgzone ${dragOver ? "is-drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
    >
      {value ? (
        <>
          <img src={value} className="bbp-imgzone-preview" alt={label} />
          <button type="button" className="bbp-imgzone-remove" onClick={() => onChange(null)}>×</button>
        </>
      ) : (
        <label className="bbp-imgzone-placeholder">
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
          <span>+ {label}</span>
        </label>
      )}
    </div>
  );
}

function OrdersPane({ masters, sortedSeasons, orders, setOrders, seasonId, setSeasonId, setModal }) {
  const [view, setView] = useState("list");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankOrderForm());
  const [filterBrandId, setFilterBrandId] = useState("");
  const [exportBrandId, setExportBrandId] = useState("");
  const [exportSeasonId, setExportSeasonId] = useState("");
  const [visibleCols, setVisibleCols] = useState({
    wsplb: true, erp: true, rp: true, rate: true, cost: true, markup: true, lts: true, memo: true,
  });
  const toggleCol = (key) => setVisibleCols((v) => ({ ...v, [key]: !v[key] }));

  const exportOrders = useMemo(
    () => orders.filter((o) => o.brandId === exportBrandId && o.seasonId === exportSeasonId),
    [orders, exportBrandId, exportSeasonId]
  );
  const [exportImages, setExportImages] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        exportOrders.map(async (o) => [o.id, await loadOrderImages(o.id)])
      );
      if (!cancelled) setExportImages(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [exportOrders]);

  const [listImages, setListImages] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        orders.map(async (o) => [o.id, await loadOrderImages(o.id)])
      );
      if (!cancelled) setListImages(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [orders]);
  const toggleExportCol = (key) => setExportCols((c) => ({ ...c, [key]: !c[key] }));

  // Short, unique per-brand code used in PO numbers (e.g. "BPX"). Collisions
  // (two brands landing on the same code) get a numeric suffix in brand order.
  const brandCodeMap = useMemo(() => {
    const map = {};
    const used = new Set();
    masters.brands.forEach((b) => {
      const base = brandInitials(b.name) || "X";
      let code = base;
      let n = 2;
      while (used.has(code)) { code = `${base}${n}`; n++; }
      used.add(code);
      map[b.id] = code;
    });
    return map;
  }, [masters.brands]);

  // Auto-numbered purchase orders: one counter per brand+season, bumped each
  // time a document is actually issued (Excel/PDF), so re-issuing a revision
  // the same day still gets a distinct, traceable number.
  const [poNumbers, setPoNumbers] = useState({});
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("bybrand:ponumbers", false);
        if (r && r.value) setPoNumbers(JSON.parse(r.value));
      } catch (err) { /* no PO numbers issued yet */ }
    })();
  }, []);
  const poKey = `${exportBrandId}|${exportSeasonId}`;
  const poNextRev = (poNumbers[poKey] || 0) + 1;
  const poNumber = (brandForPo, seasonForPo, rev) => {
    const yy = seasonForPo ? String(seasonForPo.year % 100).padStart(2, "0") : "";
    const code = brandCodeMap[brandForPo?.id] || "";
    return `${yy}${seasonForPo?.type ?? ""}-${code}-${String(rev).padStart(2, "0")}`;
  };
  const issuePoNumber = async () => {
    const updated = { ...poNumbers, [poKey]: poNextRev };
    setPoNumbers(updated);
    try { await window.storage.set("bybrand:ponumbers", JSON.stringify(updated), false); } catch (err) { /* will retry on next issue */ }
    return poNextRev;
  };

  const brandMap = useMemo(() => {
    const m = {};
    masters.brands.forEach((b) => (m[b.id] = b));
    return m;
  }, [masters.brands]);
  const seasonMap = useMemo(() => {
    const m = {};
    sortedSeasons.forEach((s) => (m[s.id] = s));
    return m;
  }, [sortedSeasons]);

  const startNew = () => {
    setEditingId(null);
    const defaultBrandId = masters.brands.find((b) => b.active)?.id || masters.brands[0]?.id || "";
    const brand = brandMap[defaultBrandId];
    const currency = brand ? brand.currency : "EUR";
    setForm({
      ...blankOrderForm(),
      brandId: defaultBrandId,
      seasonId: seasonId || sortedSeasons[0]?.id || "",
      currency,
      exrate: DEFAULT_RATES[currency] || 165,
    });
    setView("form");
  };

  const [lightbox, setLightbox] = useState(null);
  const [loadingEditId, setLoadingEditId] = useState(null);
  const startEdit = async (order) => {
    setLoadingEditId(order.id);
    const images = await loadOrderImages(order.id);
    setEditingId(order.id);
    setForm({ ...blankOrderForm(), ...order, ...images });
    setLoadingEditId(null);
    setView("form");
  };

  const handleBrandChange = (brandId) => {
    const brand = brandMap[brandId];
    const currency = brand ? brand.currency : form.currency;
    setForm((f) => ({ ...f, brandId, currency, exrate: DEFAULT_RATES[currency] || f.exrate }));
  };

  const setSize = (size, qty) => {
    setForm((f) => ({ ...f, sizes: { ...f.sizes, [size]: qty === "" ? "" : Number(qty) } }));
  };

  const totals = computeOrderTotals(form);

  const submitOrder = async () => {
    if (!form.brandId) { setModal({ type: "alert", title: "Missing Brand", message: "Please choose a brand." }); return; }
    if (!form.seasonId) { setModal({ type: "alert", title: "Missing Season", message: "Please choose a season." }); return; }
    if (!form.model.trim()) { setModal({ type: "alert", title: "Missing Model#", message: "Please enter a Model#." }); return; }

    const t = computeOrderTotals(form);
    const id = editingId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { rest, images } = splitOrderImages(form);
    const record = {
      ...rest,
      id,
      totalUnits: t.totalUnits,
      wsplb: t.wsplb,
      totalWSP: t.totalWSP,
      totalWSPLB: t.totalWSPLB,
      rp: t.rp,
      erp: t.erp,
      markup: t.markup,
    };
    await saveOrderImages(id, images);
    setOrders((prev) => {
      if (editingId) return prev.map((o) => (o.id === editingId ? record : o));
      return [...prev, record];
    });
    setView("list");
  };

  const deleteOrder = (id) => {
    setModal({
      type: "confirm",
      title: "Delete Order",
      message: "Delete this order? This also removes it from the Actual figures it fed into.",
      danger: true,
      confirmLabel: "Delete",
      onConfirm: () => {
        setOrders((prev) => prev.filter((o) => o.id !== id));
        saveOrderImages(id, {});
      },
    });
  };

  const visibleOrders = useMemo(
    () => orders.filter((o) => !filterBrandId || o.brandId === filterBrandId),
    [orders, filterBrandId]
  );

  const sizeList = getOrderSizeList(form);

  if (view === "export") {
    const brand = brandMap[exportBrandId];
    const season = seasonMap[exportSeasonId];
    const totals = exportOrders.reduce(
      (acc, o) => ({
        units: acc.units + (o.totalUnits || 0),
        wsp: acc.wsp + (o.totalWSP || 0),
        wsplb: acc.wsplb + (o.totalWSPLB || 0),
        erp: acc.erp + (o.erp || 0),
      }),
      { units: 0, wsp: 0, wsplb: 0, erp: 0 }
    );
    const currencyLabel = exportOrders[0]?.currency || brand?.currency || "EUR";
    const accCols = ["acc1", "acc2", "acc3", "acc4"].filter((key) =>
      exportOrders.some((o) => (o[key] && o[key].trim()) || o["img" + key.charAt(0).toUpperCase() + key.slice(1)])
    );

    const sizeCols = collectSizeColumns(exportOrders);

    const handleDownloadXLSX = async () => {
      const po = poNumber(brand, season, poNextRev);
      const wb = XLSX.utils.book_new();
      const rows = [];
      rows.push([`${season?.label || ""} ${brand?.name || ""} Purchase Order`]);
      rows.push([`PO#: ${po}`]);
      const accHeaders = accCols.map((_, i) => `Acc-${i + 1}`);
      const optHeaders = [
        visibleCols.wsplb && "Total WSP+IPC",
        visibleCols.erp && "TTL ERP",
        visibleCols.rp && "RP",
        visibleCols.rate && "Exchange Rate",
        visibleCols.cost && "Cost %",
        visibleCols.markup && "Mark Up",
      ].filter(Boolean);
      rows.push([
        "#", "Delivery", "Item", "Model#", "Main Fabric", "Color",
        ...accHeaders, ...sizeCols, "Total Units", "WSP", "Total WSP",
        ...optHeaders, "Production Note",
        ...(visibleCols.memo ? ["Internal Memo"] : []),
        ...(visibleCols.lts ? ["LTS"] : []),
      ]);
      exportOrders.forEach((o, i) => {
        const optVals = [
          visibleCols.wsplb && o.totalWSPLB,
          visibleCols.erp && o.erp,
          visibleCols.rp && o.rp,
          visibleCols.rate && o.exrate,
          visibleCols.cost && o.costPct,
          visibleCols.markup && (o.markup ? `${o.markup.toFixed(2)}x` : ""),
        ].filter((v) => v !== false);
        rows.push([
          i + 1, o.delivery, o.item, o.model, o.fabric, o.color,
          ...accCols.map((key) => o[key]),
          ...sizeCols.map((s) => (o.sizes && o.sizes[s]) || 0),
          o.totalUnits, o.wsp, o.totalWSP,
          ...optVals, o.note,
          ...(visibleCols.memo ? [o.memo] : []),
          ...(visibleCols.lts ? [o.lts] : []),
        ]);
      });
      const optBlanks = optHeaders.map(() => "");
      rows.push([
        "", "", "TOTAL", "", "", "", ...accCols.map(() => ""), ...sizeCols.map(() => ""), totals.units, "", totals.wsp,
        ...optBlanks.map((_, i) => (optHeaders[i] === "TTL ERP" ? totals.erp : optHeaders[i] === "Total WSP+IPC" ? totals.wsplb : "")),
        "", ...(visibleCols.memo ? [""] : []), ...(visibleCols.lts ? [""] : []),
      ]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [
        { wch: 4 }, { wch: 9 }, { wch: 5 }, { wch: 16 }, { wch: 24 }, { wch: 16 },
        ...accCols.map(() => ({ wch: 16 })), ...sizeCols.map(() => ({ wch: 6 })), { wch: 9 }, { wch: 8 }, { wch: 10 },
        ...optHeaders.map(() => ({ wch: 10 })), { wch: 24 },
        ...(visibleCols.memo ? [{ wch: 20 }] : []),
        ...(visibleCols.lts ? [{ wch: 6 }] : []),
      ];
      XLSX.utils.book_append_sheet(wb, ws, "Purchase Order");
      const filename = `${po}.xlsx`.replace(/\s+/g, "_");
      await issuePoNumber();
      XLSX.writeFile(wb, filename);
    };

    return (
      <div className="bbp-pane">
        <header className="bbp-pane-head bbp-noprint">
          <div>
            <div className="bbp-eyebrow">Orders</div>
            <h1 className="bbp-title">Export / Print</h1>
          </div>
          <div className="bbp-headctrls">
            <button className="bbp-btn bbp-btn--ghost" onClick={() => setView("list")}>← Back to List</button>
          </div>
        </header>

        <div className="bbp-ordercard bbp-noprint">
          <div className="bbp-ordergrid bbp-ordergrid--3">
            <div className="bbp-field">
              <label>Brand</label>
              <select className="bbp-select" value={exportBrandId} onChange={(e) => setExportBrandId(e.target.value)}>
                {masters.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="bbp-field">
              <label>Season</label>
              <select className="bbp-select" value={exportSeasonId} onChange={(e) => setExportSeasonId(e.target.value)}>
                {sortedSeasons.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="bbp-ordercard bbp-noprint">
          <div className="bbp-colcheckhead">
            <h3>Columns to Include</h3>
            <div className="bbp-colcheckbulk">
              <button
                type="button"
                className="bbp-iconbtn"
                onClick={() => setVisibleCols({ wsplb: true, erp: true, rp: true, rate: true, cost: true, markup: true, lts: true, memo: true })}
              >
                Show All
              </button>
              <button
                type="button"
                className="bbp-iconbtn"
                onClick={() => setVisibleCols({ wsplb: false, erp: false, rp: false, rate: false, cost: false, markup: false, lts: false, memo: false })}
              >
                Hide All
              </button>
            </div>
          </div>
          <div className="bbp-colcheckrow">
            {[
              ["wsplb", "Total WSP+IPC"], ["erp", "TTL ERP"], ["rp", "RP"], ["rate", "Exchange Rate"],
              ["cost", "Cost %"], ["markup", "Mark Up"], ["lts", "LTS"], ["memo", "Internal Memo"],
            ].map(([key, label]) => (
              <label className="bbp-check" key={key}>
                <input type="checkbox" checked={visibleCols[key]} onChange={() => toggleCol(key)} />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="bbp-orderactions bbp-noprint">
          <button className="bbp-btn" onClick={handleDownloadXLSX}>Download Excel (.xlsx)</button>
          <button className="bbp-btn bbp-btn--ghost" onClick={async () => { await issuePoNumber(); window.print(); }}>Save as PDF</button>
        </div>

        <div className="bbp-exportpreview">
          <div className="bbp-exportheader">
            <div className="bbp-exportbrandrow">
              <img className="bbp-exportlogo" src={`${import.meta.env.BASE_URL}logo-to.png`} alt="T.O" />
              <div className="bbp-exportdoctype">Purchase Order</div>
            </div>
            <div className="bbp-exportheader-center">
              <div className="bbp-exportbrand">{brand?.name || "—"}</div>
              <div className="bbp-exportsub">{season?.label || "—"}</div>
            </div>
            <div className="bbp-exportmeta">
              <div>PO#: {poNumber(brand, season, poNextRev)}</div>
              <div>DATE: {new Date().toLocaleDateString("ja-JP")}</div>
              <div>ITEMS: {exportOrders.length}</div>
              <div>TOTAL UNITS: {totals.units}</div>
              <div>TOTAL WSP: {currencyLabel} {fmt2(totals.wsp)}</div>
            </div>
          </div>

          <div className="bbp-exportinfo">
            <div className="bbp-exportinfo-col">
              <div className="bbp-exportinfo-label">Ordered by</div>
              <div>T.O Company</div>
              <div>Contact: Shinya Okazaki</div>
              <div>okazaki@to1981.com</div>
              <div>+81-90-8281-1250</div>
            </div>
            <div className="bbp-exportinfo-col">
              <div className="bbp-exportinfo-label">Ship to</div>
              <div>T.O co., ltd.</div>
              <div>#201 Lotus Coat, 3-11-17 Harimayacho, Kochi, Japan 780-0822</div>
              <div>+81-90-8281-1250</div>
            </div>
            <div className="bbp-exportinfo-col">
              <div className="bbp-exportinfo-label">Shipping / Export</div>
              <div>Contact: Saki Sugimura</div>
              <div>saki@to1981.com</div>
              <div>+81 90 9770 3174</div>
            </div>
            <div className="bbp-exportinfo-col">
              <div className="bbp-exportinfo-label">Courier Accounts</div>
              <div>DHL Account: 588199549</div>
              <div>UPS Account: A9998E</div>
            </div>
          </div>

          {exportOrders.length === 0 ? (
            <div className="bbp-empty">No orders for this brand and season yet.</div>
          ) : (
            <>
              <div className="bbp-ordlist bbp-ordlist--compact">
                {exportOrders.map((o, i) => {
                  const imgs = exportImages[o.id] || {};
                  const wsp = { label: "WSP", value: o.wsp ? `${o.currency === "JPY" ? "¥" : o.currency + " "}${fmt2(o.wsp)}` : "—" };
                  const totalWsp = { label: "Total WSP", value: o.totalWSP ? `${o.currency === "JPY" ? "¥" : o.currency + " "}${fmt2(o.totalWSP)}` : "—" };
                  const numItems = [
                    visibleCols.wsplb && { key: "wsplb", label: "Total WSP+IPC", value: o.totalWSPLB ? `${o.currency === "JPY" ? "¥" : o.currency + " "}${fmt2(o.totalWSPLB)}` : "—" },
                    visibleCols.rp && { key: "rp", label: "RP", value: o.rp ? `¥${fmtJPY(o.rp)}` : "—" },
                    visibleCols.erp && { key: "erp", label: "TTL ERP", value: o.erp ? `¥${fmtJPY(o.erp)}` : "—" },
                    visibleCols.rate && { key: "rate", label: "Rate", value: o.exrate || "—" },
                    visibleCols.cost && { key: "cost", label: "Cost %", value: o.costPct ? `${o.costPct}%` : "—" },
                    visibleCols.markup && { key: "markup", label: "Mark Up", value: o.markup ? `${o.markup.toFixed(2)}x` : "—" },
                  ].filter(Boolean);

                  return (
                    <div className="bbp-ordlcard bbp-ordlcard--compact" key={o.id}>
                      <div className="bbp-ordlcard-photo">
                        <div className="bbp-ordlcard-tag">#{i + 1}</div>
                        <div className="bbp-ordlcard-img">
                          {imgs.imgModel
                            ? <img src={imgs.imgModel} alt="" onClick={() => setLightbox(imgs.imgModel)} />
                            : <div className="bbp-ordlcard-noimg">No Photo</div>}
                        </div>
                      </div>

                      <div className="bbp-ordlcard-body">
                        <div className="bbp-ordlcard-toprow">
                          <div className="bbp-ordlcard-info">
                            <div className="bbp-ordlcard-eyebrow">{o.item}</div>
                            <div className="bbp-ordlcard-modelrow">
                              <span className="bbp-ordlcard-model">{o.model || "—"}</span>
                              <span className="bbp-ordlcard-color">{o.color || "—"}</span>
                            </div>
                            <div className="bbp-ordlcard-fabric">
                              {imgs.imgFabric && <img className="bbp-exportimg-inline" src={imgs.imgFabric} alt="" onClick={() => setLightbox(imgs.imgFabric)} />}
                              {o.fabric || "—"}
                            </div>
                          </div>
                          <div className="bbp-ordlcard-deliv">
                            <div className="bbp-ordlcard-delivitem">
                              <span>Delivery</span>
                              <strong>{o.delivery || "—"}</strong>
                            </div>
                            {visibleCols.lts && (
                              <div className="bbp-ordlcard-delivitem">
                                <span>LTS</span>
                                <strong>{o.lts || "—"}</strong>
                              </div>
                            )}
                          </div>
                        </div>

                        {accCols.length > 0 && (
                          <div className="bbp-ordlcard-accs">
                            {accCols.map((key) => {
                              const imgKey = "img" + key.charAt(0).toUpperCase() + key.slice(1);
                              if (!o[key] && !imgs[imgKey]) return null;
                              return (
                                <div className="bbp-ordlcard-acc" key={key}>
                                  {imgs[imgKey] && <img className="bbp-exportimg-inline" src={imgs[imgKey]} alt="" onClick={() => setLightbox(imgs[imgKey])} />}
                                  {o[key]}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        <div className="bbp-sizechipwrap">
                          <div className="bbp-sizechiprow">
                            {sizeCols.map((s) => {
                              const qty = Number(o.sizes?.[s]) || 0;
                              return (
                                <div className="bbp-sizechip" key={s}>
                                  <span className="bbp-sizechip-label">{s}</span>
                                  <span className="bbp-sizechip-qty">{qty > 0 ? qty : "—"}</span>
                                </div>
                              );
                            })}
                            <div className="bbp-sizechip bbp-sizechip--total">
                              <span className="bbp-sizechip-label">Total</span>
                              <span className="bbp-sizechip-qty">{o.totalUnits || 0}</span>
                            </div>
                          </div>
                          <div className="bbp-ordlcard-wspstack">
                            <div className="bbp-ordlcard-numitem">
                              <span>{wsp.label}</span>
                              <strong>{wsp.value}</strong>
                            </div>
                            <div className="bbp-ordlcard-numitem">
                              <span>{totalWsp.label}</span>
                              <strong>{totalWsp.value}</strong>
                            </div>
                          </div>
                        </div>

                        <div className="bbp-ordlcard-nums bbp-ordlcard-nums--flex">
                          {numItems.map((n) => (
                            <div className="bbp-ordlcard-numitem" key={n.key}>
                              <span>{n.label}</span>
                              <strong>{n.value}</strong>
                            </div>
                          ))}
                        </div>

                        {o.note && <div className="bbp-ordlcard-memo">Note: {o.note}</div>}
                        {visibleCols.memo && o.memo && <div className="bbp-ordlcard-memo">Memo: {o.memo}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="bbp-exporttotals">
                <div>TTL Units: {totals.units}</div>
                <div>Total WSP: {currencyLabel} {fmt2(totals.wsp)}</div>
                {visibleCols.wsplb && <div>Total WSP+IPC: {currencyLabel} {fmt2(totals.wsplb)}</div>}
                {visibleCols.erp && <div className="bbp-exporttotals-main">TTL ERP: ¥{fmtJPY(totals.erp)}</div>}
              </div>
            </>
          )}
        </div>
        {lightbox && (
          <div className="bbp-lightbox" onClick={() => setLightbox(null)}>
            <img src={lightbox} alt="" />
          </div>
        )}
      </div>
    );
  }

  if (view === "form") {
    return (
      <div className="bbp-pane">
        <header className="bbp-pane-head">
          <div>
            <div className="bbp-eyebrow">Orders</div>
            <h1 className="bbp-title">{editingId ? "Edit Order" : "New Order"}</h1>
          </div>
          <div className="bbp-headctrls">
            <button className="bbp-btn bbp-btn--ghost" onClick={() => setView("list")}>← Back to List</button>
          </div>
        </header>

        <section className="bbp-ordercard">
          <h3>Brand &amp; Season</h3>
          <div className="bbp-ordergrid bbp-ordergrid--3">
            <div className="bbp-field">
              <label>Brand</label>
              <select className="bbp-select" value={form.brandId} onChange={(e) => handleBrandChange(e.target.value)}>
                {masters.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="bbp-field">
              <label>Season</label>
              <select className="bbp-select" value={form.seasonId} onChange={(e) => setForm((f) => ({ ...f, seasonId: e.target.value }))}>
                {sortedSeasons.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className="bbp-field">
              <label>Delivery Month</label>
              <select className="bbp-select" value={form.delivery} onChange={(e) => setForm((f) => ({ ...f, delivery: e.target.value }))}>
                {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        </section>

        <section className="bbp-ordercard">
          <h3>Basic Information</h3>
          <div className="bbp-ordergrid bbp-ordergrid--3">
            <div className="bbp-field">
              <label>Item Type</label>
              <select className="bbp-select" value={form.item} onChange={(e) => setForm((f) => ({ ...f, item: e.target.value }))}>
                {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="bbp-field bbp-field--span2">
              <label>Model#</label>
              <div className="bbp-withimg">
                <ImageDropZone label="Photo" value={form.imgModel} onChange={(v) => setForm((f) => ({ ...f, imgModel: v }))} />
                <input className="bbp-textinput" value={form.model} placeholder="e.g. EV12S09" onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
              </div>
            </div>
          </div>
        </section>

        <section className="bbp-ordercard">
          <h3>Fabric &amp; Color</h3>
          <div className="bbp-ordergrid bbp-ordergrid--2">
            <div className="bbp-field">
              <label>Main Fabric</label>
              <div className="bbp-withimg">
                <ImageDropZone label="Photo" value={form.imgFabric} onChange={(v) => setForm((f) => ({ ...f, imgFabric: v }))} />
                <textarea className="bbp-textarea" rows={4} value={form.fabric} placeholder="e.g. 70.200.600 SINUSOIDE" onChange={(e) => setForm((f) => ({ ...f, fabric: e.target.value }))} />
              </div>
            </div>
            <div className="bbp-field">
              <label>Color</label>
              <textarea className="bbp-textarea" rows={4} value={form.color} placeholder="e.g. deep teal, hand wash" onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} />
            </div>
          </div>
        </section>

        <section className="bbp-ordercard">
          <h3>Garment Accessories</h3>
          <div className="bbp-ordergrid bbp-ordergrid--2">
            {["acc1", "acc2", "acc3", "acc4"].map((key, i) => (
              <div className="bbp-field" key={key}>
                <label>Accessories {i + 1}</label>
                <div className="bbp-withimg">
                  <ImageDropZone label="Photo" value={form["img" + key.charAt(0).toUpperCase() + key.slice(1)]} onChange={(v) => setForm((f) => ({ ...f, ["img" + key.charAt(0).toUpperCase() + key.slice(1)]: v }))} />
                  <textarea className="bbp-textarea" rows={3} value={form[key]} placeholder="e.g. Buttons #6983" onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="bbp-ordercard">
          <h3>Pricing</h3>
          <div className="bbp-ordergrid bbp-ordergrid--4">
            <div className="bbp-field">
              <label>WSP ({form.currency})</label>
              <input type="number" className="bbp-textinput" value={form.wsp} placeholder="0" onChange={(e) => setForm((f) => ({ ...f, wsp: e.target.value }))} />
            </div>
            <div className="bbp-field">
              <label>Exchange Rate (¥ per {form.currency})</label>
              <input
                type="number" className="bbp-textinput" value={form.exrate} disabled={form.currency === "JPY"}
                onChange={(e) => setForm((f) => ({ ...f, exrate: e.target.value }))}
              />
            </div>
            <div className="bbp-field">
              <label>IPC (%)</label>
              <input type="number" className="bbp-textinput" value={form.afipcPct} onChange={(e) => setForm((f) => ({ ...f, afipcPct: e.target.value }))} />
            </div>
            <div className="bbp-field">
              <label>Cost Ratio (%)</label>
              <input type="number" className="bbp-textinput" value={form.costPct} onChange={(e) => setForm((f) => ({ ...f, costPct: e.target.value }))} />
            </div>
          </div>
          <div className="bbp-ordergrid bbp-ordergrid--4" style={{ marginTop: 14 }}>
            <div className="bbp-field"><label>Total WSP</label><div className="bbp-computed">{form.currency === "JPY" ? "¥" : ""}{fmtJPY(totals.totalWSP)}</div></div>
            <div className="bbp-field"><label>RP (auto)</label><div className="bbp-computed">¥{fmtJPY(totals.rp)}</div></div>
            <div className="bbp-field"><label>Mark Up (auto)</label><div className="bbp-computed">{totals.markup ? `${totals.markup.toFixed(2)}x` : "—"}</div></div>
            <div className="bbp-field"><label>TTL ERP (auto)</label><div className="bbp-computed">¥{fmtJPY(totals.erp)}</div></div>
          </div>
        </section>

        <section className="bbp-ordercard">
          <h3>Size Range</h3>
          <div className="bbp-ordergrid bbp-ordergrid--3" style={{ marginBottom: 14 }}>
            <div className="bbp-field">
              <label>Size System</label>
              <select className="bbp-select" value={form.sizeSystem} onChange={(e) => setForm((f) => ({ ...f, sizeSystem: e.target.value }))}>
                <option value="letter">Letter (XXS–OS)</option>
                <option value="eu-even">EU Even (44–OS)</option>
                <option value="eu-odd">EU Odd (41–46)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            {form.sizeSystem === "custom" && (
              <div className="bbp-field bbp-field--span2">
                <label>Custom Sizes (comma-separated)</label>
                <input className="bbp-textinput" value={form.customSizes} placeholder="e.g. 38,40,42,44" onChange={(e) => setForm((f) => ({ ...f, customSizes: e.target.value }))} />
              </div>
            )}
          </div>
          <div className="bbp-sizerow">
            {sizeList.map((s) => (
              <div className="bbp-sizecell" key={s}>
                <label>{s}</label>
                <input type="number" min="0" value={form.sizes[s] ?? ""} placeholder="0" onChange={(e) => setSize(s, e.target.value)} />
              </div>
            ))}
            <div className="bbp-sizetotal">Total: {totals.totalUnits}</div>
          </div>
        </section>

        <section className="bbp-ordercard">
          <h3>LTS</h3>
          <div className="bbp-ordergrid bbp-ordergrid--4">
            <div className="bbp-field">
              <label>LTS</label>
              <select className="bbp-select" value={form.lts} onChange={(e) => setForm((f) => ({ ...f, lts: e.target.value }))}>
                <option value="">— Select —</option>
                {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        </section>

        <section className="bbp-ordercard">
          <h3>Notes</h3>
          <div className="bbp-ordergrid bbp-ordergrid--2">
            <div className="bbp-field">
              <label>Production Note</label>
              <textarea className="bbp-textarea" rows={3} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
            <div className="bbp-field">
              <label>Internal Memo</label>
              <textarea className="bbp-textarea" rows={3} value={form.memo} onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))} />
            </div>
          </div>
        </section>

        <div className="bbp-orderactions">
          <button className="bbp-btn" onClick={submitOrder}>{editingId ? "Update Order" : "Register Order"}</button>
          <button className="bbp-btn bbp-btn--ghost" onClick={() => setView("list")}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bbp-pane">
      <header className="bbp-pane-head">
        <div>
          <div className="bbp-eyebrow">Orders</div>
          <h1 className="bbp-title">Order List</h1>
        </div>
        <div className="bbp-headctrls">
          <select className="bbp-select" value={filterBrandId} onChange={(e) => setFilterBrandId(e.target.value)}>
            <option value="">All Brands</option>
            {masters.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button
            className="bbp-btn bbp-btn--ghost"
            onClick={() => {
              setExportBrandId(filterBrandId || masters.brands[0]?.id || "");
              setExportSeasonId(seasonId || sortedSeasons[0]?.id || "");
              setView("export");
            }}
          >
            Export / Print
          </button>
          <button className="bbp-btn" onClick={startNew}>+ New Order</button>
        </div>
      </header>

      {visibleOrders.length === 0 ? (
        <div className="bbp-empty">No orders yet. Register one with “+ New Order”.</div>
      ) : (
        <div className="bbp-ordlist">
          {visibleOrders.map((o) => {
            const imgs = listImages[o.id] || {};
            const orderSizeList = getOrderSizeList(o);
            return (
              <div className="bbp-ordlcard" key={o.id}>
                <div className="bbp-ordlcard-photo">
                  <div className="bbp-ordlcard-tag">・{o.item}</div>
                  <div className="bbp-ordlcard-img">
                    {imgs.imgModel
                      ? <img src={imgs.imgModel} alt="" onClick={() => setLightbox(imgs.imgModel)} />
                      : <div className="bbp-ordlcard-noimg">No Photo</div>}
                  </div>
                </div>

                <div className="bbp-ordlcard-body">
                  <div className="bbp-ordlcard-toprow">
                    <div className="bbp-ordlcard-info">
                      <div className="bbp-ordlcard-eyebrow">
                        {brandMap[o.brandId]?.name || "—"} · {seasonMap[o.seasonId]?.label || "—"}
                      </div>
                      <div className="bbp-ordlcard-model">{o.model || "—"}</div>
                      <div className="bbp-ordlcard-fabric">{o.fabric || "—"}</div>
                      <div className="bbp-ordlcard-color">{o.color || "—"}</div>
                    </div>
                    <div className="bbp-ordlcard-deliv">
                      <div className="bbp-ordlcard-delivitem">
                        <span>Delivery</span>
                        <strong>{o.delivery || "—"}</strong>
                      </div>
                      <div className="bbp-ordlcard-delivitem">
                        <span>LTS</span>
                        <strong>{o.lts || "—"}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="bbp-sizechiprow">
                    {orderSizeList.map((s) => {
                      const qty = Number(o.sizes?.[s]) || 0;
                      return (
                        <div className="bbp-sizechip" key={s}>
                          <span className="bbp-sizechip-label">{s}</span>
                          <span className="bbp-sizechip-qty">{qty > 0 ? qty : "—"}</span>
                        </div>
                      );
                    })}
                    <div className="bbp-sizechip bbp-sizechip--total">
                      <span className="bbp-sizechip-label">Total</span>
                      <span className="bbp-sizechip-qty">{o.totalUnits || 0}</span>
                    </div>
                  </div>

                  <div className="bbp-ordlcard-nums bbp-ordlcard-nums--5">
                    <div className="bbp-ordlcard-numitem">
                      <span>WSP</span>
                      <strong>{o.wsp ? `${o.currency === "JPY" ? "¥" : o.currency + " "}${fmtJPY(o.wsp)}` : "—"}</strong>
                    </div>
                    <div className="bbp-ordlcard-numitem">
                      <span>RP</span>
                      <strong>{o.rp ? `¥${fmtJPY(o.rp)}` : "—"}</strong>
                    </div>
                    <div className="bbp-ordlcard-numitem">
                      <span>Total WSP ({o.currency})</span>
                      <strong>{o.totalWSP ? `${o.currency === "JPY" ? "¥" : o.currency + " "}${fmtJPY(o.totalWSP)}` : "—"}</strong>
                    </div>
                    <div className="bbp-ordlcard-numitem">
                      <span>Total WSP+IPC (JPY)</span>
                      <strong>
                        {o.totalWSPLB
                          ? `¥${fmtJPY(o.totalWSPLB * (o.currency === "JPY" ? 1 : (Number(o.exrate) || 0)))}`
                          : "—"}
                      </strong>
                    </div>
                    <div className="bbp-ordlcard-numitem">
                      <span>Total RP (JPY)</span>
                      <strong>{o.erp ? `¥${fmtJPY(o.erp)}` : "—"}</strong>
                    </div>
                  </div>
                  <div className="bbp-ordlcard-nums bbp-ordlcard-nums--2">
                    <div className="bbp-ordlcard-numitem">
                      <span>Mark up</span>
                      <strong>{o.markup ? `${o.markup.toFixed(2)}x` : "—"}</strong>
                    </div>
                    <div className="bbp-ordlcard-numitem">
                      <span>Cost %</span>
                      <strong>{o.costPct ? `${o.costPct}%` : "—"}</strong>
                    </div>
                  </div>

                  {o.memo && <div className="bbp-ordlcard-memo">{o.memo}</div>}

                  <div className="bbp-orderrowactions">
                    <button className="bbp-iconbtn" onClick={() => startEdit(o)} disabled={loadingEditId === o.id}>
                      {loadingEditId === o.id ? "Loading…" : "Edit"}
                    </button>
                    <button className="bbp-iconbtn" onClick={() => deleteOrder(o.id)}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {lightbox && (
        <div className="bbp-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Launch Plan pane (monthly store-launch plan by brand, fed by Orders) */
/* ------------------------------------------------------------------ */

function LaunchPlanPane({ masters, sortedSeasons, orders, launchPlan, setLaunchPlan, setModal }) {
  const seasonsById = useMemo(() => {
    const m = {};
    sortedSeasons.forEach((s) => (m[s.id] = s));
    return m;
  }, [sortedSeasons]);

  const monthCols = useMemo(() => fiscalMonthColumns(launchPlan.fiscalYear), [launchPlan.fiscalYear]);

  // brandId -> monthKey -> summed TTL ERP from Orders
  const brandMonthMap = useMemo(() => {
    const map = {};
    (orders || []).forEach((o) => {
      const mk = orderMonthKey(o, seasonsById);
      if (!mk) return;
      if (!map[o.brandId]) map[o.brandId] = {};
      map[o.brandId][mk] = (map[o.brandId][mk] || 0) + (Number(o.erp) || 0);
    });
    return map;
  }, [orders, seasonsById]);

  const events = launchPlan.events || [];
  const eventValues = launchPlan.eventValues || {};
  const salesPlan = launchPlan.salesPlan || {};
  const taxRate = launchPlan.taxRate ?? 0.10;
  const activeBrands = masters.brands.filter((b) => b.active);

  const grandTotalForMonth = (monthKey) => {
    let sum = 0;
    activeBrands.forEach((b) => { sum += (brandMonthMap[b.id]?.[monthKey]) || 0; });
    events.forEach((ev) => { sum += Number(eventValues[ev.id]?.[monthKey]) || 0; });
    return sum;
  };

  const rowTotal = (getVal) => monthCols.reduce((s, c) => s + (Number(getVal(c.key)) || 0), 0);

  const setFiscalYear = (y) => setLaunchPlan((lp) => ({ ...lp, fiscalYear: y }));
  const setTaxRate = (v) => setLaunchPlan((lp) => ({ ...lp, taxRate: v }));
  const setSalesPlanValue = (monthKey, v) =>
    setLaunchPlan((lp) => ({ ...lp, salesPlan: { ...lp.salesPlan, [monthKey]: v === "" ? "" : Number(v) } }));
  const setEventValue = (eventId, monthKey, v) =>
    setLaunchPlan((lp) => ({
      ...lp,
      eventValues: { ...lp.eventValues, [eventId]: { ...(lp.eventValues[eventId] || {}), [monthKey]: v === "" ? "" : Number(v) } },
    }));
  const renameEvent = (eventId, name) =>
    setLaunchPlan((lp) => ({ ...lp, events: lp.events.map((ev) => (ev.id === eventId ? { ...ev, name } : ev)) }));
  const addEvent = () => {
    const id = uid();
    setLaunchPlan((lp) => ({
      ...lp,
      events: [...lp.events, { id, name: "New Event" }],
      eventValues: { ...lp.eventValues, [id]: {} },
    }));
  };
  const removeEvent = (eventId) => {
    setModal({
      type: "confirm",
      title: "Delete Event",
      message: "Delete this event row?",
      danger: true,
      confirmLabel: "Delete",
      onConfirm: () =>
        setLaunchPlan((lp) => {
          const nextValues = { ...lp.eventValues };
          delete nextValues[eventId];
          return { ...lp, events: lp.events.filter((ev) => ev.id !== eventId), eventValues: nextValues };
        }),
    });
  };

  const salesPlanTotal = rowTotal((k) => salesPlan[k]);

  return (
    <div className="bbp-pane">
      <header className="bbp-pane-head">
        <div>
          <div className="bbp-eyebrow">Launch Plan</div>
          <h1 className="bbp-title">FY {launchPlan.fiscalYear} Store Launch Plan</h1>
        </div>
        <div className="bbp-headctrls">
          <label className="bbp-check">
            Fiscal Year
            <input
              type="number" className="bbp-textinput" style={{ width: 80, marginLeft: 8 }}
              value={launchPlan.fiscalYear}
              onChange={(e) => setFiscalYear(Number(e.target.value) || launchPlan.fiscalYear)}
            />
          </label>
          <label className="bbp-check">
            Tax Rate
            <input
              type="number" step="0.01" className="bbp-textinput" style={{ width: 64, marginLeft: 8 }}
              value={taxRate}
              onChange={(e) => setTaxRate(Number(e.target.value) || 0)}
            />
          </label>
        </div>
      </header>

      <div className="bbp-tablewrap">
        <table className="bbp-table">
          <thead>
            <tr>
              <th className="bbp-th-brand">{launchPlan.fiscalYear}</th>
              {monthCols.map((c) => <th key={c.key}>{c.label}</th>)}
              <th>Total</th>
              <th>Tax-in</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="bbp-td-brand">Sales Plan</td>
              {monthCols.map((c) => (
                <td key={c.key}>
                  <EditableNumber value={salesPlan[c.key]} round={0} thousands width={90} onCommit={(v) => setSalesPlanValue(c.key, v)} />
                </td>
              ))}
              <td className="bbp-td-jpy bbp-td-jpy--plan">¥{fmtJPY(salesPlanTotal)}</td>
              <td className="bbp-td-jpy bbp-td-jpy--plan">¥{fmtJPY(salesPlanTotal * (1 + taxRate))}</td>
            </tr>
            <tr>
              <td className="bbp-td-brand">vs Plan</td>
              {monthCols.map((c) => {
                const plan = Number(salesPlan[c.key]) || 0;
                const actual = grandTotalForMonth(c.key);
                const pct = plan ? actual / plan - 1 : null;
                return (
                  <td key={c.key} className="bbp-td-num">
                    {pct === null ? "—" : <Pill tone={pct >= 0 ? "positive" : "negative"}>{fmtPct(pct)}</Pill>}
                  </td>
                );
              })}
              <td colSpan={2}></td>
            </tr>

            {events.map((ev) => {
              const total = rowTotal((k) => eventValues[ev.id]?.[k]);
              return (
                <tr key={ev.id}>
                  <td className="bbp-td-brand">
                    <div className="bbp-eventlabel">
                      <span className="bbp-eventtag">Event</span>
                      <input
                        className="bbp-eventname"
                        value={ev.name}
                        onChange={(e) => renameEvent(ev.id, e.target.value)}
                      />
                      <button className="bbp-chipclose" onClick={() => removeEvent(ev.id)}>×</button>
                    </div>
                  </td>
                  {monthCols.map((c) => (
                    <td key={c.key}>
                      <EditableNumber value={eventValues[ev.id]?.[c.key]} round={0} thousands width={90} onCommit={(v) => setEventValue(ev.id, c.key, v)} />
                    </td>
                  ))}
                  <td className="bbp-td-jpy">¥{fmtJPY(total)}</td>
                  <td className="bbp-td-jpy">¥{fmtJPY(total * (1 + taxRate))}</td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={monthCols.length + 3}>
                <button className="bbp-btn bbp-btn--ghost" onClick={addEvent}>+ Add Event</button>
              </td>
            </tr>

            {activeBrands.map((b) => {
              const total = rowTotal((k) => brandMonthMap[b.id]?.[k]);
              return (
                <tr key={b.id}>
                  <td className="bbp-td-brand">{b.name}</td>
                  {monthCols.map((c) => (
                    <td key={c.key} className="bbp-td-jpy">
                      {fmtJPY(brandMonthMap[b.id]?.[c.key] || 0)}
                    </td>
                  ))}
                  <td className="bbp-td-jpy">¥{fmtJPY(total)}</td>
                  <td className="bbp-td-jpy">¥{fmtJPY(total * (1 + taxRate))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payment Plan pane (Purchase Amount & IPC Amount by brand/month,      */
/* for sharing with accounting)                                         */
/* ------------------------------------------------------------------ */

function PaymentPlanPane({ masters, sortedSeasons, orders, launchPlan, setLaunchPlan }) {
  const seasonsById = useMemo(() => {
    const m = {};
    sortedSeasons.forEach((s) => (m[s.id] = s));
    return m;
  }, [sortedSeasons]);

  const monthCols = useMemo(() => fiscalMonthColumns(launchPlan.fiscalYear), [launchPlan.fiscalYear]);
  const activeBrands = masters.brands.filter((b) => b.active);

  // brandId -> monthKey -> { purchaseJPY, ipcJPY }
  const brandMonthMoney = useMemo(() => {
    const map = {};
    (orders || []).forEach((o) => {
      const mk = orderMonthKey(o, seasonsById);
      if (!mk) return;
      const money = computeOrderMoney(o);
      if (!map[o.brandId]) map[o.brandId] = {};
      if (!map[o.brandId][mk]) map[o.brandId][mk] = { purchaseJPY: 0, ipcJPY: 0 };
      map[o.brandId][mk].purchaseJPY += money.purchaseJPY;
      map[o.brandId][mk].ipcJPY += money.ipcJPY;
    });
    return map;
  }, [orders, seasonsById]);

  const setFiscalYear = (y) => setLaunchPlan((lp) => ({ ...lp, fiscalYear: y }));

  const brandRowTotal = (brandId, field) =>
    monthCols.reduce((s, c) => s + (brandMonthMoney[brandId]?.[c.key]?.[field] || 0), 0);

  const monthGrandTotal = (monthKey, field) =>
    activeBrands.reduce((s, b) => s + (brandMonthMoney[b.id]?.[monthKey]?.[field] || 0), 0);

  const monthGrandTotalAll = (monthKey) => monthGrandTotal(monthKey, "purchaseJPY") + monthGrandTotal(monthKey, "ipcJPY");
  const brandRowTotalAll = (brandId) => brandRowTotal(brandId, "purchaseJPY") + brandRowTotal(brandId, "ipcJPY");

  return (
    <div className="bbp-pane">
      <header className="bbp-pane-head">
        <div>
          <div className="bbp-eyebrow">Payment Plan</div>
          <h1 className="bbp-title">FY {launchPlan.fiscalYear} Payments by Brand</h1>
        </div>
        <div className="bbp-headctrls">
          <label className="bbp-check">
            Fiscal Year
            <input
              type="number" className="bbp-textinput" style={{ width: 80, marginLeft: 8 }}
              value={launchPlan.fiscalYear}
              onChange={(e) => setFiscalYear(Number(e.target.value) || launchPlan.fiscalYear)}
            />
          </label>
        </div>
      </header>

      <div className="bbp-tablewrap">
        <table className="bbp-table bbp-table--payment">
          <thead>
            <tr>
              <th className="bbp-th-brand">{launchPlan.fiscalYear}</th>
              <th></th>
              {monthCols.map((c) => <th key={c.key}>{c.label}</th>)}
              <th>Total (¥)</th>
            </tr>
          </thead>
          <tbody>
            {activeBrands.map((b) => (
              <React.Fragment key={b.id}>
                <tr className="bbp-payrow-first">
                  <td className="bbp-td-brand" rowSpan={3}>{b.name}</td>
                  <td className="bbp-td-sublabel">WSP</td>
                  {monthCols.map((c) => (
                    <td key={c.key} className="bbp-td-jpy">{fmtJPY(brandMonthMoney[b.id]?.[c.key]?.purchaseJPY || 0)}</td>
                  ))}
                  <td className="bbp-td-jpy">¥{fmtJPY(brandRowTotal(b.id, "purchaseJPY"))}</td>
                </tr>
                <tr className="bbp-payrow-mid">
                  <td className="bbp-td-sublabel">IPC</td>
                  {monthCols.map((c) => (
                    <td key={c.key} className="bbp-td-jpy">{fmtJPY(brandMonthMoney[b.id]?.[c.key]?.ipcJPY || 0)}</td>
                  ))}
                  <td className="bbp-td-jpy">¥{fmtJPY(brandRowTotal(b.id, "ipcJPY"))}</td>
                </tr>
                <tr className="bbp-payrow-total">
                  <td className="bbp-td-sublabel">TTL</td>
                  {monthCols.map((c) => {
                    const cell = brandMonthMoney[b.id]?.[c.key];
                    const total = (cell?.purchaseJPY || 0) + (cell?.ipcJPY || 0);
                    return <td key={c.key} className="bbp-td-jpy">¥{fmtJPY(total)}</td>;
                  })}
                  <td className="bbp-td-jpy">¥{fmtJPY(brandRowTotalAll(b.id))}</td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr className="bbp-payrow-first">
              <td className="bbp-td-totallabel" colSpan={2}>WSP</td>
              {monthCols.map((c) => (
                <td key={c.key} className="bbp-td-jpy">¥{fmtJPY(monthGrandTotal(c.key, "purchaseJPY"))}</td>
              ))}
              <td className="bbp-td-jpy">¥{fmtJPY(monthCols.reduce((s, c) => s + monthGrandTotal(c.key, "purchaseJPY"), 0))}</td>
            </tr>
            <tr className="bbp-payrow-mid">
              <td className="bbp-td-totallabel" colSpan={2}>IPC</td>
              {monthCols.map((c) => (
                <td key={c.key} className="bbp-td-jpy">¥{fmtJPY(monthGrandTotal(c.key, "ipcJPY"))}</td>
              ))}
              <td className="bbp-td-jpy">¥{fmtJPY(monthCols.reduce((s, c) => s + monthGrandTotal(c.key, "ipcJPY"), 0))}</td>
            </tr>
            <tr className="bbp-payrow-total">
              <td className="bbp-td-totallabel" colSpan={2}>TTL</td>
              {monthCols.map((c) => (
                <td key={c.key} className="bbp-td-jpy">¥{fmtJPY(monthGrandTotalAll(c.key))}</td>
              ))}
              <td className="bbp-td-jpy">¥{fmtJPY(monthCols.reduce((s, c) => s + monthGrandTotalAll(c.key), 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Masters pane                                                         */
/* ------------------------------------------------------------------ */

function MastersPane({
  masters, addBrand, updateBrand, removeBrand,
  addCurrency, removeCurrency, addSeason, removeSeason, sortedSeasons,
}) {
  return (
    <div className="bbp-pane">
      <header className="bbp-pane-head">
        <div>
          <div className="bbp-eyebrow">Setup</div>
          <h1 className="bbp-title">Setup</h1>
        </div>
      </header>

      <section className="bbp-mastersection">
        <div className="bbp-mastersection-head">
          <h2>Brands ({masters.brands.length})</h2>
          <button className="bbp-btn" onClick={addBrand}>+ Add Brand</button>
        </div>
        <div className="bbp-masterlist">
          {masters.brands.map((b) => (
            <div key={b.id} className="bbp-masterrow">
              <input
                className="bbp-input bbp-input--name"
                value={b.name}
                onChange={(e) => updateBrand(b.id, { name: e.target.value })}
              />
              <select className="bbp-select" value={b.currency} onChange={(e) => updateBrand(b.id, { currency: e.target.value })}>
                {masters.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
              <label className="bbp-check">
                <input type="checkbox" checked={b.active} onChange={(e) => updateBrand(b.id, { active: e.target.checked })} />
                Visible
              </label>
              <button className="bbp-btn bbp-btn--ghost" onClick={() => removeBrand(b.id)}>Delete</button>
            </div>
          ))}
        </div>
      </section>

      <section className="bbp-mastersection">
        <div className="bbp-mastersection-head">
          <h2>Currencies ({masters.currencies.length})</h2>
          <button className="bbp-btn" onClick={addCurrency}>+ Add Currency</button>
        </div>
        <div className="bbp-masterlist">
          {masters.currencies.map((c) => (
            <div key={c.code} className="bbp-masterrow">
              <span className="bbp-currencycode">{c.code}</span>
              <span className="bbp-currencyname">{c.name}</span>
              {c.base ? <Pill tone="neutral">Base currency</Pill> : (
                <button className="bbp-btn bbp-btn--ghost" onClick={() => removeCurrency(c.code)}>Delete</button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="bbp-mastersection">
        <div className="bbp-mastersection-head">
          <h2>Seasons ({sortedSeasons.length})</h2>
          <button className="bbp-btn" onClick={addSeason}>+ Add Season</button>
        </div>
        <div className="bbp-masterlist bbp-masterlist--wrap">
          {sortedSeasons.map((s) => (
            <div key={s.id} className="bbp-seasonchip">
              {s.label}
              <button className="bbp-chipclose" onClick={() => removeSeason(s.id)}>×</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                               */
/* ------------------------------------------------------------------ */

function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');

      .bbp-root {
        --bg: #FAFAF8;
        --surface: #FFFFFF;
        --ink: #111110;
        --ink-soft: #111110;
        --line: #111110;
        --accent: #111110;
        --accent-deep: #111110;
        --plan: #111110;
        --actual: #111110;
        --positive: #111110;
        --negative: #111110;
        --font-serif: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        --font-mono: 'Inter', ui-monospace, monospace;

        display: flex;
        min-height: 640px;
        background: var(--bg);
        color: var(--ink);
        font-family: var(--font-sans);
        font-weight: 400;
        border-radius: 0;
        overflow: hidden;
        border: 1px solid var(--line);
        letter-spacing: 0.01em;
      }
      .bbp-loading, .bbp-error { padding: 40px; font-family: var(--font-sans); color: var(--ink-soft); }

      .bbp-splash {
        width: 100%; min-height: 640px; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 18px; background: var(--bg);
        animation: bbp-splash-in ${SPLASH_MIN_MS}ms ease-out;
      }
      .bbp-splash-eyebrow {
        font-family: var(--font-sans); font-size: 10px; letter-spacing: 0.32em; font-weight: 400;
        color: var(--ink-soft);
      }
      .bbp-splash-title {
        font-family: var(--font-sans); font-size: 22px; font-weight: 300; letter-spacing: 0.5em;
        text-transform: uppercase; color: var(--ink); margin-left: 0.5em;
      }
      .bbp-splash-bar { width: 120px; height: 1px; background: var(--line); margin-top: 8px; overflow: hidden; }
      .bbp-splash-bar-fill { width: 30%; height: 100%; background: var(--ink); animation: bbp-splash-sweep 1.2s ease-in-out infinite; }
      @keyframes bbp-splash-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes bbp-splash-sweep {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(450%); }
      }

      .bbp-side {
        width: 232px;
        flex-shrink: 0;
        background: var(--bg);
        color: var(--ink);
        display: flex;
        flex-direction: column;
        padding: 36px 28px;
        border-right: 1px solid var(--line);
      }
      .bbp-brandmark { margin-bottom: 56px; cursor: pointer; }
      .bbp-brandmark-eyebrow {
        font-size: 10px; letter-spacing: 0.22em;
        text-transform: uppercase; color: var(--ink-soft); margin-bottom: 10px; font-weight: 400;
      }
      .bbp-brandmark-title {
        font-family: var(--font-sans); font-size: 18px; font-weight: 300;
        letter-spacing: 0.4em; text-transform: uppercase; margin-left: 0.15em;
      }

      .bbp-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
      .bbp-navitem {
        display: flex; align-items: center; gap: 10px;
        background: transparent; border: none; border-left: 1px solid transparent; color: var(--ink-soft); text-align: left;
        font-family: var(--font-sans); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
        padding: 12px 0 12px 14px; border-radius: 0; cursor: pointer;
        transition: color 0.15s, border-color 0.15s;
      }
      .bbp-navitem-num { font-size: 10px; color: var(--ink-soft); letter-spacing: 0.05em; }
      .bbp-navitem:hover { color: var(--ink); }
      .bbp-navitem.is-active { color: var(--ink); border-left-color: var(--ink); }

      .bbp-savebox {
        display: flex; align-items: center; gap: 8px;
        font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); margin-top: 20px;
      }
      .bbp-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--line); }
      .bbp-dot--saved { background: var(--ink); }
      .bbp-dot--saving { background: var(--ink-soft); animation: bbp-pulse 1s infinite; }
      @keyframes bbp-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

      .bbp-backupbox { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
      .bbp-backupbtn {
        font-family: var(--font-sans); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
        background: transparent; border: 1px solid var(--ink); color: var(--ink);
        padding: 8px 10px; text-align: left; cursor: pointer; border-radius: 0;
      }
      .bbp-backupbtn:hover { background: var(--ink); color: var(--bg); }
      .bbp-importmsg { font-size: 10px; letter-spacing: 0.05em; color: var(--positive); }

      .bbp-main { flex: 1; overflow-y: auto; padding: 44px 56px; background: var(--bg); }
      .bbp-pane { max-width: 1760px; width: 100%; }
      .bbp-pane-head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 32px; flex-wrap: wrap; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
      .bbp-eyebrow { font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 8px; font-weight: 400; }
      .bbp-title { font-family: var(--font-serif); font-size: 26px; font-weight: 400; margin: 0; letter-spacing: 0.01em; }

      .bbp-headctrls { display: flex; align-items: center; gap: 20px; }
      .bbp-select {
        font-family: var(--font-sans); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; padding: 9px 12px; border-radius: 0;
        border: 1px solid var(--line); background: var(--surface); color: var(--ink);
      }
      .bbp-check { display: flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: 0.04em; color: var(--ink-soft); }

      .bbp-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-bottom: 40px; border: 1px solid var(--line); }
      .bbp-card { background: var(--surface); border: none; border-left: 1px solid var(--line); padding: 20px 22px; }
      .bbp-card:first-child { border-left: none; }
      .bbp-card--plan, .bbp-card--actual, .bbp-card--positive, .bbp-card--negative { border-left: 1px solid var(--line); }
      .bbp-card-label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 10px; }
      .bbp-card-value { font-family: var(--font-mono); font-size: 21px; font-weight: 300; letter-spacing: 0.01em; }

      .bbp-tablewrap { background: var(--surface); border: 1px solid var(--line); border-radius: 0; overflow: auto; max-height: 640px; }
      .bbp-table { border-collapse: collapse; width: 100%; font-size: 12px; }
      .bbp-table th, .bbp-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
      .bbp-table thead th {
        font-family: var(--font-sans); font-weight: 400; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--ink-soft); text-align: center; background: var(--bg); line-height: 1.5;
        position: sticky; top: 0; z-index: 3; box-sizing: border-box;
      }
      .bbp-th-brand { text-align: left !important; position: sticky; left: 0; top: 0; background: var(--bg); z-index: 4; }

      .bbp-td-brand { text-align: left; font-weight: 400; position: sticky; left: 0; background: var(--surface); z-index: 1; vertical-align: middle; }
      .bbp-row--inactive .bbp-td-brand { color: var(--ink-soft); font-style: normal; }
      .bbp-td-currency { text-align: center; color: var(--ink-soft); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.05em; }
      .bbp-td-rate { text-align: center; }
      .bbp-td-num { text-align: right; font-family: var(--font-mono); font-weight: 300; }
      .bbp-td-jpy { text-align: right; font-family: var(--font-mono); font-weight: 400; }
      .bbp-td-jpy--plan { color: var(--ink-soft); }
      .bbp-td-jpy--actual { color: var(--ink); }
      .bbp-td-totallabel { text-align: right; font-weight: 500; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); }
      .bbp-fixed { font-family: var(--font-mono); color: var(--ink-soft); padding: 0 6px; font-weight: 300; }

      .bbp-table tfoot td { font-family: var(--font-mono); border-top: 1px solid var(--ink); border-bottom: none; background: var(--bg); }

      .bbp-input {
        border: 1px solid transparent; background: transparent; padding: 4px 6px; border-radius: 0;
        font-size: 12px; font-weight: 300; color: var(--ink); text-align: right;
      }
      .bbp-input:hover { border-bottom: 1px solid var(--line); }
      .bbp-input:focus { outline: none; border-bottom: 1px solid var(--ink); background: transparent; }
      .bbp-input--name { text-align: left; width: 220px; font-weight: 400; }

      .bbp-pill { display: inline-block; padding: 0; border-radius: 0; font-size: 11px; font-family: var(--font-mono); font-weight: 400; background: transparent !important; }
      .bbp-pill--positive { color: var(--positive); }
      .bbp-pill--negative { color: var(--negative); }
      .bbp-pill--neutral { color: var(--ink-soft); }

      .bbp-chartcard { background: var(--surface); border: 1px solid var(--line); border-radius: 0; padding: 28px 30px; margin-bottom: 24px; }
      .bbp-chartcard-title { font-family: var(--font-serif); font-size: 12px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 22px; color: var(--ink-soft); }
      .bbp-chartcard-headrow { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; gap: 16px; }
      .bbp-chartcard-title--flush { margin-bottom: 0; }
      .bbp-empty { color: var(--ink-soft); font-size: 13px; padding: 30px 0; text-align: center; }

      .bbp-mastersection { background: var(--surface); border: 1px solid var(--line); border-radius: 0; padding: 24px 26px; margin-bottom: 20px; }
      .bbp-mastersection-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
      .bbp-mastersection-head h2 { font-family: var(--font-serif); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; margin: 0; font-weight: 500; color: var(--ink-soft); }
      .bbp-masterlist { display: flex; flex-direction: column; gap: 0; max-height: 340px; overflow-y: auto; }
      .bbp-masterlist--wrap { flex-direction: row; flex-wrap: wrap; max-height: none; gap: 10px; }
      .bbp-masterrow { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); }
      .bbp-currencycode { font-family: var(--font-mono); font-weight: 500; width: 48px; letter-spacing: 0.05em; }
      .bbp-currencyname { flex: 1; color: var(--ink-soft); font-size: 12px; }

      .bbp-seasonchip {
        display: flex; align-items: center; gap: 10px; background: var(--surface); border: 1px solid var(--line);
        padding: 8px 12px; border-radius: 0; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.05em;
      }
      .bbp-chipclose { border: none; background: transparent; color: var(--ink-soft); cursor: pointer; font-size: 13px; line-height: 1; font-weight: 300; }

      .bbp-eventlabel { display: flex; align-items: center; gap: 8px; }
      .bbp-eventtag {
        font-size: 8px; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid var(--line);
        padding: 1px 5px; color: var(--ink-soft); flex-shrink: 0;
      }
      .bbp-eventname {
        border: 1px solid transparent; background: transparent; font-size: 12.5px; color: var(--ink);
        padding: 2px 4px; flex: 1; min-width: 100px;
      }
      .bbp-eventname:hover { border-color: var(--line); }
      .bbp-eventname:focus { outline: none; border-color: var(--ink); }

      .bbp-table--payment td, .bbp-table--payment th { font-size: 11px; }
      .bbp-td-sublabel {
        font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
        color: var(--ink-soft); white-space: nowrap;
      }
      .bbp-payrow-first td { border-top: 1px solid var(--ink); border-bottom: 1px dotted var(--line); }
      .bbp-payrow-mid td { border-bottom: 1px dotted var(--line); }
      .bbp-payrow-total td { color: var(--ink); border-bottom: none; }
      .bbp-payrow-total .bbp-td-sublabel { color: var(--ink); }
      .bbp-table tfoot tr.bbp-payrow-first td { border-bottom: 1px dotted var(--line); }
      .bbp-table tfoot tr.bbp-payrow-mid td { border-bottom: 1px dotted var(--line); }
      .bbp-chipclose:hover { color: var(--ink); }

      .bbp-btn {
        font-family: var(--font-sans); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; padding: 10px 18px; border-radius: 0;
        border: 1px solid var(--ink); background: var(--ink); color: var(--bg); cursor: pointer; font-weight: 400;
      }
      .bbp-btn:hover { background: var(--bg); color: var(--ink); }
      .bbp-btn--ghost { background: transparent; color: var(--ink-soft); border: 1px solid var(--line); margin-left: auto; }
      .bbp-btn--ghost:hover { border-color: var(--ink); color: var(--ink); background: transparent; }

      .bbp-modal-overlay {
        position: fixed; inset: 0; background: rgba(17,17,16,0.4);
        display: flex; align-items: center; justify-content: center; z-index: 50;
      }
      .bbp-modal {
        background: var(--surface); border: 1px solid var(--ink); border-radius: 0;
        padding: 28px 28px 22px; width: 340px; max-width: 90%;
      }
      .bbp-modal-title { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 500; margin-bottom: 14px; }
      .bbp-modal-message { font-size: 13px; line-height: 1.6; color: var(--ink-soft); margin-bottom: 18px; }
      .bbp-modal-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
      .bbp-modal-field label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft); }
      .bbp-modal-field input {
        font-family: var(--font-sans); font-size: 13px; padding: 9px 10px; border: 1px solid var(--line);
        border-radius: 0; background: var(--bg); color: var(--ink);
      }
      .bbp-modal-field input:focus { outline: none; border-color: var(--ink); }
      .bbp-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
      .bbp-modal-btn {
        font-family: var(--font-sans); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
        padding: 9px 16px; border-radius: 0; border: 1px solid var(--ink); background: var(--ink); color: var(--bg); cursor: pointer;
      }
      .bbp-modal-btn:hover { opacity: 0.8; }
      .bbp-modal-btn--ghost { background: transparent; color: var(--ink); }
      .bbp-modal-btn--ghost:hover { background: var(--bg); opacity: 1; }
      .bbp-modal-btn--danger { border-color: var(--negative); background: var(--negative); }

      /* Orders tab */
      .bbp-fromorders { font-family: var(--font-mono); display: inline-flex; align-items: center; gap: 6px; }
      .bbp-fromorders-tag {
        font-size: 8px; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid var(--ink);
        padding: 1px 5px; color: var(--ink);
      }
      .bbp-ordercard { background: var(--surface); border: 1px solid var(--line); padding: 20px 22px; margin-bottom: 16px; }
      .bbp-ordercard h3 {
        font-family: var(--font-serif); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
        font-weight: 500; color: var(--ink-soft); margin: 0 0 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line);
      }
      .bbp-ordergrid { display: grid; gap: 16px 20px; }
      .bbp-ordergrid--2 { grid-template-columns: 1fr 1fr; }
      .bbp-ordergrid--3 { grid-template-columns: 1fr 1fr 1fr; }
      .bbp-ordergrid--4 { grid-template-columns: 1fr 1fr 1fr 1fr; }
      .bbp-field { display: flex; flex-direction: column; gap: 6px; }
      .bbp-field--span2 { grid-column: span 2; }
      .bbp-field label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft); }
      .bbp-textinput, .bbp-textarea {
        font-family: var(--font-sans); font-size: 13px; padding: 8px 10px; border: 1px solid var(--line);
        border-radius: 0; background: var(--bg); color: var(--ink); width: 100%; box-sizing: border-box;
      }
      .bbp-textarea { resize: vertical; line-height: 1.5; }
      .bbp-textinput:focus, .bbp-textarea:focus { outline: none; border-color: var(--ink); }
      .bbp-computed {
        font-family: var(--font-mono); font-size: 13px; padding: 8px 10px; border: 1px solid var(--line);
        background: var(--bg); min-height: 34px; box-sizing: border-box;
      }
      .bbp-withimg { display: grid; grid-template-columns: 90px 1fr; gap: 10px; align-items: start; }
      .bbp-imgzone {
        position: relative; border: 1px dashed var(--line); aspect-ratio: 1/1; display: flex;
        align-items: center; justify-content: center; overflow: hidden; background: var(--bg);
      }
      .bbp-imgzone.is-drag { border-color: var(--ink); }
      .bbp-imgzone-placeholder {
        display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
        cursor: pointer; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft);
        text-align: center; padding: 4px;
      }
      .bbp-imgzone-preview { width: 100%; height: 100%; object-fit: cover; }
      .bbp-imgzone-remove {
        position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border: none;
        background: var(--ink); color: var(--bg); font-size: 11px; line-height: 1; cursor: pointer;
      }
      .bbp-sizerow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .bbp-sizecell { display: flex; flex-direction: column; align-items: center; gap: 4px; }
      .bbp-sizecell label { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); }
      .bbp-sizecell input {
        width: 48px; text-align: center; font-family: var(--font-mono); font-size: 12px;
        padding: 6px 4px; border: 1px solid var(--line); background: var(--bg); color: var(--ink);
      }
      .bbp-sizetotal { font-family: var(--font-mono); font-size: 12px; padding: 6px 12px; border: 1px solid var(--line); }
      .bbp-orderactions { display: flex; gap: 10px; margin-top: 4px; margin-bottom: 40px; }
      .bbp-orderrowactions { display: flex; gap: 8px; }
      .bbp-iconbtn {
        font-family: var(--font-sans); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
        background: transparent; border: 1px solid var(--line); color: var(--ink); padding: 5px 9px; cursor: pointer;
      }
      .bbp-iconbtn:hover { border-color: var(--ink); }

      .bbp-ordlist { display: flex; flex-direction: column; gap: 16px; }
      .bbp-ordlcard {
        display: flex; gap: 20px; background: var(--surface); border: 1px solid var(--line); padding: 18px;
      }
      .bbp-ordlcard-photo { width: 160px; flex-shrink: 0; }
      .bbp-ordlcard-tag {
        font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em; color: var(--ink-soft);
        padding-bottom: 6px; margin-bottom: 8px; border-bottom: 1px solid var(--line);
      }
      .bbp-ordlcard-img {
        width: 160px; height: 190px; border: 1px solid var(--line); background: var(--bg);
        display: flex; align-items: center; justify-content: center; overflow: hidden;
      }
      .bbp-ordlcard-img img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
      .bbp-ordlcard-noimg {
        font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft);
      }
      .bbp-ordlcard-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
      .bbp-ordlcard-toprow { display: flex; justify-content: space-between; gap: 16px; }
      .bbp-ordlcard-info { min-width: 0; }
      .bbp-ordlcard-eyebrow {
        font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 4px;
      }
      .bbp-ordlcard-model { font-family: var(--font-serif); font-size: 16px; font-weight: 600; color: var(--ink); }
      .bbp-ordlcard-fabric, .bbp-ordlcard-color { font-size: 12px; color: var(--ink-soft); margin-top: 2px; }
      .bbp-ordlcard-modelrow { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .bbp-ordlcard-modelrow .bbp-ordlcard-color { margin-top: 0; }
      .bbp-ordlcard-deliv { display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; text-align: right; }
      .bbp-ordlcard-delivitem { display: flex; flex-direction: column; gap: 2px; }
      .bbp-ordlcard-delivitem span {
        font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft);
      }
      .bbp-ordlcard-delivitem strong { font-family: var(--font-mono); font-size: 13px; color: var(--ink); }

      .bbp-sizechipwrap { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
      .bbp-ordlcard-wspstack { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
      .bbp-ordlcard-wspstack .bbp-ordlcard-numitem { flex-direction: row; gap: 6px; justify-content: flex-end; align-items: baseline; }
      .bbp-sizechiprow { display: flex; gap: 6px; flex-wrap: wrap; }
      .bbp-sizechip {
        display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 40px;
        border: 1px solid var(--line); padding: 5px 8px; background: var(--bg);
      }
      .bbp-sizechip-label { font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-soft); }
      .bbp-sizechip-qty { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--ink); }
      .bbp-sizechip--total { background: var(--ink); border-color: var(--ink); }
      .bbp-sizechip--total .bbp-sizechip-label, .bbp-sizechip--total .bbp-sizechip-qty { color: var(--bg); }

      .bbp-ordlcard-nums { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
      .bbp-ordlcard-nums--2 { grid-template-columns: repeat(2, 1fr); max-width: 260px; }
      .bbp-ordlcard-nums--5 { grid-template-columns: repeat(5, 1fr); }
      .bbp-ordlcard-numitem { display: flex; flex-direction: column; gap: 2px; }
      .bbp-ordlcard-numitem span {
        font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft);
      }
      .bbp-ordlcard-numitem strong { font-family: var(--font-mono); font-size: 13px; color: var(--ink); }
      .bbp-ordlcard-memo { font-size: 11px; color: var(--ink-soft); font-style: italic; }
      .bbp-ordlcard-nums--flex { display: flex; flex-wrap: wrap; gap: 14px 22px; }
      .bbp-ordlcard-accs { display: flex; flex-wrap: wrap; gap: 10px; }
      .bbp-ordlcard-acc {
        display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-soft);
        border: 1px solid var(--line); padding: 4px 8px 4px 4px; max-width: 220px;
      }
      .bbp-exportimg-inline {
        display: inline-block; width: 22px; height: 22px; object-fit: cover; vertical-align: middle;
        margin-right: 6px; border: 1px solid var(--line); cursor: zoom-in;
      }

      .bbp-lightbox {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.85); display: flex; align-items: center;
        justify-content: center; z-index: 300; cursor: zoom-out; padding: 40px; box-sizing: border-box;
      }
      .bbp-lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5); }

      /* Export/Print: compact card, 5 fit per printed page */
      .bbp-ordlist--compact { gap: 0; }
      .bbp-ordlcard--compact {
        gap: 16px; padding: 13px 0; background: transparent; border: none; border-bottom: 1px solid var(--line);
      }
      .bbp-ordlcard--compact .bbp-ordlcard-photo { width: 76px; }
      .bbp-ordlcard--compact .bbp-ordlcard-tag { font-size: 11px; font-weight: 700; color: var(--ink); padding-bottom: 3px; margin-bottom: 4px; }
      .bbp-ordlcard--compact .bbp-ordlcard-img { width: 76px; height: 92px; }
      .bbp-ordlcard--compact .bbp-ordlcard-body { gap: 6px; }
      .bbp-ordlcard--compact .bbp-ordlcard-eyebrow { font-size: 8px; margin-bottom: 1px; }
      .bbp-ordlcard--compact .bbp-ordlcard-model { font-size: 13px; }
      .bbp-ordlcard--compact .bbp-ordlcard-fabric,
      .bbp-ordlcard--compact .bbp-ordlcard-color { font-size: 10px; margin-top: 0; }
      .bbp-ordlcard--compact .bbp-ordlcard-deliv { gap: 6px; }
      .bbp-ordlcard--compact .bbp-ordlcard-delivitem span { font-size: 7.5px; }
      .bbp-ordlcard--compact .bbp-ordlcard-delivitem strong { font-size: 11px; }
      .bbp-ordlcard--compact .bbp-sizechiprow { gap: 3px; flex-wrap: nowrap; overflow: hidden; flex: 1 1 auto; min-width: 0; }
      .bbp-ordlcard--compact .bbp-sizechip { min-width: 22px; padding: 2px 4px; }
      .bbp-ordlcard--compact .bbp-sizechip-label { font-size: 6px; }
      .bbp-ordlcard--compact .bbp-sizechip-qty { font-size: 9.5px; }
      .bbp-ordlcard--compact .bbp-ordlcard-accs { gap: 6px; }
      .bbp-ordlcard--compact .bbp-ordlcard-acc { font-size: 9px; padding: 2px 6px 2px 2px; }
      .bbp-ordlcard--compact .bbp-exportimg-inline { width: 16px; height: 16px; margin-right: 4px; }
      .bbp-ordlcard--compact .bbp-ordlcard-nums--flex { gap: 6px 16px; }
      .bbp-ordlcard--compact .bbp-ordlcard-numitem span { font-size: 7px; }
      .bbp-ordlcard--compact .bbp-ordlcard-numitem strong { font-size: 10px; }
      .bbp-ordlcard--compact .bbp-ordlcard-memo { font-size: 9px; }

      /* Export / Print preview */
      .bbp-exportpreview { background: var(--surface); border: 1px solid var(--line); padding: 40px 44px; margin-bottom: 40px; }
      .bbp-exportheader {
        display: grid; grid-template-columns: 1fr auto 1fr; align-items: start; gap: 16px;
        border-bottom: 2px solid var(--ink); padding-bottom: 10px; margin-bottom: 12px;
      }
      .bbp-exportheader-center { text-align: center; align-self: end; }
      .bbp-exportbrand { font-family: var(--font-serif); font-size: 14px; font-weight: 400; letter-spacing: 0.01em; color: var(--ink-soft); }
      .bbp-exportsub { font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); margin-top: 2px; }
      .bbp-exportmeta { text-align: right; font-family: var(--font-mono); font-size: 10px; color: var(--ink-soft); line-height: 1.4; }
      .bbp-exportdoctype {
        font-family: var(--font-sans); font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
        text-transform: uppercase; color: var(--ink); margin-top: 4px;
      }
      .bbp-exportbrandrow { display: flex; flex-direction: column; align-items: flex-start; gap: 0; }
      .bbp-exportlogo { height: 22px; width: auto; object-fit: contain; flex-shrink: 0; }
      .bbp-exportinfo {
        display: grid; grid-template-columns: repeat(4, 1fr); gap: 28px;
        margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line);
        font-size: 10.5px; line-height: 1.5; color: var(--ink-soft);
      }
      .bbp-exportinfo-label {
        font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink);
        font-weight: 600; margin-bottom: 3px;
      }
      .bbp-exporttotals {
        display: flex; justify-content: flex-end; gap: 24px; margin-top: 18px; padding-top: 14px;
        border-top: 1px solid var(--ink); font-family: var(--font-mono); font-size: 11px; flex-wrap: wrap;
      }
      .bbp-exporttotals-main { font-weight: 500; }
      .bbp-colcheckrow { display: flex; flex-wrap: wrap; gap: 16px 24px; }
      .bbp-colcheckhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
      .bbp-colcheckhead h3 { margin: 0; padding: 0; border: none; }
      .bbp-colcheckbulk { display: flex; gap: 8px; }

      @media (max-width: 720px) {
        .bbp-root { flex-direction: column; min-height: 0; }
        .bbp-side {
          width: auto; flex-direction: row; align-items: center; padding: 14px 16px;
          border-right: none; border-bottom: 1px solid var(--line); gap: 16px; overflow-x: auto;
        }
        .bbp-brandmark { margin-bottom: 0; flex-shrink: 0; }
        .bbp-brandmark-eyebrow { display: none; }
        .bbp-brandmark-title { font-size: 15px; }
        .bbp-nav { flex-direction: row; flex: none; gap: 4px; }
        .bbp-navitem {
          border-left: none; border-bottom: 1px solid transparent; padding: 6px 8px; font-size: 10px; white-space: nowrap;
        }
        .bbp-navitem.is-active { border-left-color: transparent; border-bottom-color: var(--ink); }
        .bbp-savebox, .bbp-backupbox { display: none; }

        .bbp-main { padding: 20px 16px; }
        .bbp-title { font-size: 20px; }
        .bbp-pane-head { flex-direction: column; align-items: flex-start; }
        .bbp-headctrls { flex-wrap: wrap; width: 100%; gap: 10px; }
        .bbp-summary { grid-template-columns: 1fr 1fr; }

        .bbp-ordergrid--2, .bbp-ordergrid--3, .bbp-ordergrid--4 { grid-template-columns: 1fr; }
        .bbp-field--span2 { grid-column: span 1; }
        .bbp-withimg { grid-template-columns: 1fr; }
        .bbp-imgzone { aspect-ratio: 16/9; }
        .bbp-ordercard { padding: 16px; }
        .bbp-orderactions { flex-direction: column; }
        .bbp-orderactions .bbp-btn { width: 100%; }
        .bbp-sizerow { gap: 8px; }
        .bbp-sizecell input { width: 40px; }

        .bbp-mastersection-head { flex-wrap: wrap; gap: 10px; }
        .bbp-masterrow { flex-wrap: wrap; }
      }

      @page { size: A4; margin: 14mm; }
      @media print {
        .bbp-side, .bbp-noprint { display: none !important; }
        .bbp-main { padding: 0 !important; }
        .bbp-exportpreview { border: none !important; padding: 12mm !important; }
        .bbp-ordlcard { break-inside: avoid; }
      }
    `}</style>
  );
}

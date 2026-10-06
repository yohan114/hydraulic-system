'use strict';
const connection = require('../db');
const money = require('../lib/money');
const finance = require('../lib/finance');
const sql = require('../lib/sql');
const pricingEngine = require('./pricingEngine');

async function loadRateCard() {
    // No ORDER BY on Category — an un-migrated DB may not have that column yet,
    // and Access would throw ("cscript" error). Sort in JS instead.
    const rows = await connection.query('SELECT * FROM RateCard');
    const mapped = rows.map((r) => {
        // Fall back to the legacy single OutsidePrice for pre-tier rows.
        const mid = r.OutsideMid != null ? money.round2(r.OutsideMid) : money.round2(r.OutsidePrice);
        return {
            rateId: r.RateID,
            category: r.Category || 'hose',
            spec: r.Spec,
            sizeCode: r.SizeCode,
            sizeInch: money.num(r.SizeInch),
            label: r.Label,
            unit: r.Unit || 'm',
            ourCost: money.round2(r.OurCost),
            ourPrice: money.round2(r.OurPrice),
            outsideLow: r.OutsideLow != null ? money.round2(r.OutsideLow) : mid,
            outsideMid: mid,
            outsideHigh: r.OutsideHigh != null ? money.round2(r.OutsideHigh) : mid,
        };
    });
    const catRank = { hose: 0, fitting: 1, crimping: 2 };
    mapped.sort((a, b) =>
        (catRank[a.category] ?? 9) - (catRank[b.category] ?? 9) ||
        String(a.spec || '').localeCompare(String(b.spec || '')) ||
        a.sizeInch - b.sizeInch
    );
    return mapped;
}

// Load the rate card but never let a rate-card problem break a comparison.

async function loadRateCardSafe() {
    try {
        return await loadRateCard();
    } catch (e) {
        console.warn('Rate card unavailable (comparison will show your figures only):', e.message);
        return [];
    }
}


function rateCardSet(b) {
    return `Category = ${sql.q(b.category || 'hose')}, Spec = ${sql.q(b.spec)}, SizeCode = ${sql.q(b.sizeCode)}, SizeInch = ${sql.n(b.sizeInch, 0)}, Label = ${sql.q(b.label)}, Unit = ${sql.q(b.unit || 'm')}, OurCost = ${sql.n(b.ourCost, 0)}, OurPrice = ${sql.n(b.ourPrice, 0)}, OutsideLow = ${sql.n(b.outsideLow, 0)}, OutsideMid = ${sql.n(b.outsideMid, 0)}, OutsideHigh = ${sql.n(b.outsideHigh, 0)}, OutsidePrice = ${sql.n(b.outsideMid, 0)}, UpdatedAt = Now()`;
}


function matchLineRate(rates, item) {
    return (
        finance.matchRate(rates, { productName: item.ProductName, specCode: item.SpecificationCode }) ||
        finance.matchFitting(rates, { productName: item.ProductName, description: item.ItemDescription, specCode: item.SpecificationCode })
    );
}

// Per-unit MARKET MID for an invoice line. Every stocked item now carries its own
// market-mid benchmark (Inventory.MarketMid, from the shipment datasheet); use it
// first so every parts line has a market figure. Manual lines with no stock item
// (e.g. a hose or crimping technical charge) fall back to a Rate Card match by size.

function lineMarketMid(rates, item) {
    // Priority-1: an exact outside-company benchmark (what the customer pays
    // elsewhere) overrides the stored datasheet mid for the comparison.
    const outside = pricingEngine.outsideMarketForItem({
        specCode: item.SpecificationCode,
        description: item.ProductName || item.ItemDescription,
        hoseSize: item.Size,
    });
    if (outside && outside.price > 0) return outside.price;
    const mm = money.num(item.MarketMid);
    if (mm > 0) return mm;
    const rate = matchLineRate(rates, item);
    return rate ? money.num(rate.outsideMid) : 0;
}

// Rate Card as a comparison table (per unit) with savings vs mid + margin.

async function getCostComparison() {
    const rates = await loadRateCard();
    return rates.map((r) => {
        const diff = money.round2(r.outsideMid - r.ourPrice);
        const savingsPct = r.outsideMid > 0 ? money.round2((diff / r.outsideMid) * 100) : 0;
        const marginPct = r.ourPrice > 0 ? money.round2(((r.ourPrice - r.ourCost) / r.ourPrice) * 100) : 0;
        return {
            name: r.label,
            category: r.category,
            spec: r.spec,
            size: r.sizeInch,
            unit: r.unit,
            ourCost: r.ourCost,
            ourPrice: r.ourPrice,
            outsideLow: r.outsideLow,
            outsideMid: r.outsideMid,
            outsideHigh: r.outsideHigh,
            diff,
            savingsPct,
            marginPct,
            matched: true,
        };
    });
}


module.exports = { loadRateCard, loadRateCardSafe, rateCardSet, matchLineRate, lineMarketMid, getCostComparison };

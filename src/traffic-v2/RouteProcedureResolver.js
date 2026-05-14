'use strict';

const { normalizeIcao } = require('./utils');

function tokenType(token) {
  const t = String(token || '').trim().toUpperCase();

  if (!t) return 'UNKNOWN';

  // IMPORTANT:
  // DCT must be checked before generic fix/navaid matching,
  // otherwise it gets incorrectly classified as FIX_OR_NAVAID.
  if (t === 'DCT') return 'DIRECT';

  // Examples: MZULO3, CAMRN5, PARCH2, ANU1A
  if (/^[A-Z]{2,6}\d[A-Z]?$/.test(t)) {
    return 'SID_STAR_OR_PROCEDURE';
  }

  // Examples: Y309, Q161, Q108, G633, A555
  if (/^[A-Z]\d{1,4}$/.test(t)) {
    return 'AIRWAY';
  }

  // Examples: ETECK, PELCN, FLRDA, SAGGY, CHIEZ, KALDA, SIE, ANU, SKB
  if (/^[A-Z]{2,5}$/.test(t)) {
    return 'FIX_OR_NAVAID';
  }

  return 'UNKNOWN';
}

class RouteProcedureResolver {
  constructor({ airports, routes, schedules, log } = {}) {
    this.airports = airports;
    this.routes = Array.isArray(routes) ? routes : [];
    this.schedules = Array.isArray(schedules) ? schedules : [];
    this.log = log || (() => {});
  }

  resolveRoute({ origin, dest, route, runway } = {}) {
    const routeText = String(route || '').trim();

    const tokens = routeText
      ? routeText
          .split(/\s+/)
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean)
      : this.fallbackRoute(origin, dest);

    const elements = tokens.map((token, index) => ({
      token,
      index,
      type: tokenType(token),
      status: 'PENDING'
    }));

    const firstProcedure = elements.find(
      (e) => e.type === 'SID_STAR_OR_PROCEDURE'
    );

    const firstAirway = elements.find((e) => e.type === 'AIRWAY');

    const nextTarget =
      elements.find(
        (e) =>
          e.type === 'SID_STAR_OR_PROCEDURE' ||
          e.type === 'FIX_OR_NAVAID' ||
          e.type === 'AIRWAY'
      ) || null;

    const nextFix =
      elements.find((e) => e.type === 'FIX_OR_NAVAID') ||
      firstProcedure ||
      firstAirway ||
      null;

    return {
      origin: normalizeIcao(origin),
      dest: normalizeIcao(dest),
      runway: String(runway || '').toUpperCase(),
      raw: routeText || tokens.join(' '),
      elements,
      firstProcedure: firstProcedure ? firstProcedure.token : null,
      firstAirway: firstAirway ? firstAirway.token : null,
      nextFix: nextFix ? nextFix.token : null,
      nextTarget: nextTarget ? nextTarget.token : null
    };
  }

  fallbackRoute(origin, dest) {
    const o = normalizeIcao(origin);
    const d = normalizeIcao(dest);

    const row = this.routes.find((r) => {
      const rowOrigin = normalizeIcao(
        r.origin || r.from || r.departure || r.dep
      );

      const rowDest = normalizeIcao(
        r.dest || r.destination || r.arrival || r.arr
      );

      return rowOrigin === o && rowDest === d;
    });

    if (row) {
      const text = row.route || row.routing || row.path || '';

      if (text) {
        return text
          .split(/\s+/)
          .map((x) => x.toUpperCase())
          .filter(Boolean);
      }
    }

    // Correct KMCO → KJFK fallback order.
    // Do not jump from MZULO3 straight to Y309.
    if (o === 'KMCO' && d === 'KJFK') {
      return [
        'MZULO3',
        'ETECK',
        'DCT',
        'PELCN',
        'Y309',
        'FLRDA',
        'DCT',
        'SAGGY',
        'DCT',
        'CHIEZ',
        'Q161',
        'KALDA',
        'Q108',
        'SIE',
        'CAMRN5'
      ];
    }

    if (o === 'TAPA' && d === 'TKPK') {
      return ['ANU', 'G633', 'SKB'];
    }

    if (o === 'TKPK' && d === 'TAPA') {
      return ['SKB', 'DCT', 'ANU'];
    }

    return ['DCT'];
  }

  classifyReport(text) {
    const s = String(text || '').toUpperCase();

    const isPosition =
      /\b(PASSING|OVER|CROSSING|ESTABLISHED ON|JOINED|REPORTING|WITH YOU PASSING)\b/.test(
        s
      );

    const isReadback =
      /\b(CLIMB|DESCEND|MAINTAIN|PROCEED|DIRECT|CLEARED|SQUAWK|RUNWAY|CONTACT|TAXI)\b/.test(
        s
      ) && !isPosition;

    return {
      isReadback,
      isPosition
    };
  }

  nextOperationalTarget(routeState = {}) {
    const elements = Array.isArray(routeState.elements)
      ? routeState.elements
      : [];

    // Skip DCT because it is a routing instruction, not a point to report.
    return (
      elements.find(
        (e) =>
          e.status !== 'COMPLETE' &&
          e.type !== 'DIRECT' &&
          e.type !== 'UNKNOWN'
      ) || null
    );
  }

  nextPointAfter(routeState = {}, token) {
    const elements = Array.isArray(routeState.elements)
      ? routeState.elements
      : [];

    const t = String(token || '').toUpperCase();
    const currentIndex = elements.findIndex((e) => e.token === t);

    if (currentIndex < 0) {
      return this.nextOperationalTarget(routeState);
    }

    return (
      elements
        .slice(currentIndex + 1)
        .find(
          (e) =>
            e.status !== 'COMPLETE' &&
            e.type !== 'DIRECT' &&
            e.type !== 'UNKNOWN'
        ) || null
    );
  }

  markTargetComplete(routeState, token) {
    if (!routeState || !Array.isArray(routeState.elements)) {
      return routeState;
    }

    const t = String(token || '').toUpperCase();

    const item = routeState.elements.find((e) => e.token === t);

    if (item) {
      item.status = 'COMPLETE';
    }

    // Keep routeState.nextTarget and nextFix fresh after marking complete.
    const next = this.nextOperationalTarget(routeState);

    routeState.nextTarget = next ? next.token : null;

    const nextFix =
      routeState.elements.find(
        (e) => e.status !== 'COMPLETE' && e.type === 'FIX_OR_NAVAID'
      ) ||
      routeState.elements.find(
        (e) =>
          e.status !== 'COMPLETE' &&
          e.type === 'SID_STAR_OR_PROCEDURE'
      ) ||
      routeState.elements.find(
        (e) => e.status !== 'COMPLETE' && e.type === 'AIRWAY'
      ) ||
      null;

    routeState.nextFix = nextFix ? nextFix.token : null;

    return routeState;
  }
}

module.exports = {
  RouteProcedureResolver,
  tokenType
};

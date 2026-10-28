'use strict';

/* =========================================================
 *  Endstand nach Spielende (alle Spiele, Fernseher und Handy).
 *  Die Werte kommen fertig vom Server (summary() des Spiels);
 *  hier wird nur dargestellt.
 * ========================================================= */

/** Tabelle mit Rang, Spieler und den Spalten des Spiels. */
function endstandHtml(final, { heading } = {}) {
  if (!final) return '';
  const head = final.columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('');
  const rows = final.rows.map((r, i) => `<tr class="${r.tone || ''}">
      <td class="es-rank">${i + 1}.</td>
      <th scope="row"><span class="es-sw" style="--c:${r.color}"></span><span class="es-name">${escapeHtml(r.name)}</span>${r.note ? `<small>${escapeHtml(r.note)}</small>` : ''}</th>
      ${r.cells.map((c, k) => `<td data-label="${escapeHtml(final.columns[k])}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="es-card">
    ${heading ? `<p class="es-kicker">${escapeHtml(heading)}</p>` : ''}
    <h2>${escapeHtml(final.title)}</h2>
    ${final.subtitle ? `<p class="es-sub">${escapeHtml(final.subtitle)}</p>` : ''}
    <div class="es-scroll"><table class="es-table">
      <thead><tr><th></th><th scope="col">Spieler</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

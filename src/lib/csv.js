'use strict';

function csvEscape(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

/**
 * Minimal CSV parser for small administrative imports. Handles quoted fields,
 * escaped quotes, CRLF/LF and comma or semicolon delimiters.
 */
function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const delimiter = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

module.exports = { csvEscape, toCsv, parseCsv };

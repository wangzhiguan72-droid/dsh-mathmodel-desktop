'use strict';

/**
 * Parse CSV text into an array of rows (each row is an array of string fields).
 *
 * Rules:
 *  - Commas separate fields; LF and CRLF separate rows.
 *  - A trailing row terminator does not produce a phantom empty row, but an
 *    empty line is one row containing a single empty field.
 *  - A quoted field may contain commas and line breaks; "" inside a quoted
 *    field represents one literal double quote.
 *  - A quote may only start at the beginning of a field; after its closing
 *    quote only a comma, a row terminator, or end of input is legal.
 *  - Unclosed quote, quote inside an unquoted field, stray character after a
 *    closing quote, and a bare CR outside quotes all throw an Error.
 *  - A non-string argument throws a TypeError.
 *  - Field contents are preserved exactly (no trimming).
 */
function parseCsv(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseCsv expects a string argument');
  }

  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  const n = text.length;

  // True once the current row has consumed any character (field data, a quote
  // or a comma). Each row terminator ends a row, including an empty line.
  let rowInProgress = false;

  const endField = () => {
    row.push(field);
    field = '';
  };

  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    rowInProgress = false;
  };

  while (i < n) {
    const ch = text[i];

    if (ch === '"') {
      // A quote is only legal at the very beginning of a field.
      if (field.length > 0) {
        throw new Error('Quote may only start at the beginning of a field');
      }

      // Opening quote.
      rowInProgress = true;
      i++;
      let closed = false;
      while (i < n) {
        const c = text[i];
        if (c === '"') {
          if (i + 1 < n && text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        field += c;
        i++;
      }
      if (!closed) {
        throw new Error('Unclosed quoted field');
      }

      // After the closing quote only a comma, a row terminator, or end of
      // input is legal.
      if (i < n) {
        const d = text[i];
        if (d === ',') {
          endField();
          i++;
          continue;
        }
        if (d === '\n') {
          endRow();
          i++;
          continue;
        }
        if (d === '\r' && i + 1 < n && text[i + 1] === '\n') {
          endRow();
          i += 2;
          continue;
        }
        if (d === '\r') {
          throw new Error('Bare CR is not allowed');
        }
        throw new Error('Stray character after closing quote');
      }
      continue;
    }

    if (ch === ',') {
      endField();
      rowInProgress = true;
      i++;
      continue;
    }

    if (ch === '\n' || (ch === '\r' && i + 1 < n && text[i + 1] === '\n')) {
      endRow();
      i += ch === '\r' ? 2 : 1;
      continue;
    }

    if (ch === '\r') {
      throw new Error('Bare CR is not allowed');
    }

    field += ch;
    rowInProgress = true;
    i++;
  }

  // Flush a final row that was not terminated by a row terminator.
  if (rowInProgress) {
    endRow();
  }

  return rows;
}

module.exports = { parseCsv };

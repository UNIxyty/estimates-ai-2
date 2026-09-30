'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/client';

/**
 * Minimal spreadsheet viewer over the viewer endpoints:
 *   documents: /api/documents/{id}/sheets|rows (+ rows/{sheet}/{row} provenance and PATCH edit)
 *   files:     /api/files/{id}/view/sheets|rows
 * Worker response shapes are rendered defensively (arrays of cells or objects).
 */
export function DocViewer({
  kind,
  id,
  initialSheet,
  initialRow,
}: {
  kind: 'document' | 'file';
  id: string;
  initialSheet?: string;
  initialRow?: number;
}) {
  const base = kind === 'document' ? `/api/documents/${id}` : `/api/files/${id}/view`;
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string | undefined>(initialSheet);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | undefined>(initialRow);
  const limit = 100;

  useEffect(() => {
    api<any>(`${base}/sheets`)
      .then((r) => {
        const list: any[] = Array.isArray(r) ? r : r.sheets || [];
        const names = list.map((s) => (typeof s === 'string' ? s : s.name ?? String(s.idx)));
        setSheets(names);
        setSheet((cur) => cur ?? names[0]);
      })
      .catch((e: ApiError) => setError(`Viewer unavailable: ${e.message}`));
  }, [base]);

  useEffect(() => {
    if (!sheet) return;
    const qs = new URLSearchParams({ sheet, offset: String(offset), limit: String(limit) });
    if (filter) qs.set('filter', filter);
    api<any>(`${base}/rows?${qs}`)
      .then(setData)
      .catch((e: ApiError) => setError(`Rows unavailable: ${e.message}`));
  }, [base, sheet, offset, filter]);

  const rows: any[] = data ? (Array.isArray(data) ? data : data.rows || []) : [];
  const total: number | undefined = data?.total;
  const rowNum = (r: any, i: number) => (typeof r === 'object' && r && !Array.isArray(r) ? r.row ?? r.row_idx ?? offset + i + 1 : offset + i + 1);
  const cells = (r: any): unknown[] =>
    Array.isArray(r) ? r : Array.isArray(r?.cells) ? r.cells.map((c: any) => (c && typeof c === 'object' ? c.v ?? c.value ?? '' : c)) : Object.values(r ?? {});

  return (
    <section>
      <h3>Viewer</h3>
      {error && <p role="alert">{error}</p>}
      <p>
        <label>
          Sheet{' '}
          <select value={sheet ?? ''} onChange={(e) => { setSheet(e.target.value); setOffset(0); }}>
            {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>{' '}
        <label>Filter <input value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }} /></label>{' '}
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</button>{' '}
        <button type="button" disabled={total !== undefined && offset + limit >= total} onClick={() => setOffset(offset + limit)}>Next</button>{' '}
        {total !== undefined && <small>{offset + 1}–{Math.min(offset + limit, total)} of {total}</small>}
      </p>
      <table>
        <tbody>
          {rows.map((r, i) => {
            const n = rowNum(r, i);
            return (
              <tr key={i} aria-selected={n === selected}>
                <th>
                  {kind === 'document' ? <button type="button" onClick={() => setSelected(n)}>{n}</button> : n}
                </th>
                {cells(r).map((c, j) => <td key={j}>{c === null || c === undefined ? '' : typeof c === 'object' ? JSON.stringify(c) : String(c)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {kind === 'document' && sheet && selected !== undefined && <RowInspector documentId={id} sheet={sheet} row={selected} />}
    </section>
  );
}

function RowInspector({ documentId, sheet, row }: { documentId: string; sheet: string; row: number }) {
  const url = `/api/documents/${documentId}/rows/${encodeURIComponent(sheet)}/${row}`;
  const [prov, setProv] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setProv(null);
    api<{ row: any }>(url).then((r) => setProv(r.row)).catch(() => setMsg('No provenance for this row.'));
  }, [url]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, number | null> = {};
    for (const k of ['qty', 'unit_labour', 'unit_material', 'norm_h_per_unit']) {
      const v = String(f.get(k) ?? '').trim();
      if (v !== '' && v !== String(prov?.[k] ?? '')) body[k] = Number(v);
    }
    try {
      await api(url, { method: 'PATCH', json: body });
      setMsg('Saved — the workbook was recalculated.');
      const r = await api<{ row: any }>(url);
      setProv(r.row);
    } catch (err: any) {
      setMsg(`Save failed: ${err.message}`);
    }
  }

  return (
    <aside>
      <h4>Row {sheet}!{row}</h4>
      {msg && <p role="status">{msg}</p>}
      {prov && (
        <>
          <p>
            {prov.item_text} — source: {prov.price_source}
            {prov.confidence && <> · confidence {prov.confidence}</>} {prov.flags?.length ? <>· flags: {prov.flags.join(', ')}</> : null}
          </p>
          {prov.reason && <p>Reason: {prov.reason}</p>}
          {prov.matched?.length > 0 && (
            <ul>
              {prov.matched.map((m: any, i: number) => (
                <li key={i}>
                  <a href={`/knowledge/${m.file_id}`}>{m.file_name}</a> {m.sheet}!{m.row}: {m.item_text}
                  {m.similarity !== undefined && <> ({m.similarity})</>}
                </li>
              ))}
            </ul>
          )}
          {prov.web && <p>Web: {prov.web.product} {prov.web.unit_price} {prov.web.currency} {prov.web.url && <a href={prov.web.url} rel="noreferrer" target="_blank">source</a>}</p>}
          <form onSubmit={save}>
            {(['qty', 'unit_labour', 'unit_material', 'norm_h_per_unit'] as const).map((k) => (
              <label key={k}>
                {k} <input name={k} type="number" step="any" defaultValue={prov[k] ?? ''} />{' '}
              </label>
            ))}
            <button type="submit">Save row</button>
          </form>
        </>
      )}
    </aside>
  );
}

'use client';

/** design/Message.dc.html (DESIGN.md §5.2): user attachment cards + soft bubble; agent plain text, blocks, footer. */
import { useState, type ReactNode } from 'react';
import { KIND, kindLabel, kindOf, TierCost } from '@/components/ui';
import { useChat } from './context';
import { InlineCard } from './InlineCard';
import { partsToParas, RichText, streamingParts } from './Blocks';
import type { Card, ChatMessage, FileRef, Part, UploadRef } from './types';
import { uploadRole } from './Composer';
import css from './Chat.module.css';

export function UserMessage({ m, uploads, references }: { m: ChatMessage; uploads: Record<string, UploadRef>; references: Record<string, FileRef> }) {
  const { openUpload, openFile } = useChat();
  const chips = [
    ...(m.attachment_ids || []).map((id) => {
      const u = uploads[id];
      return { key: id, name: u?.original_name || 'Attachment', role: uploadRole(u?.original_name || ''), open: () => u && openUpload(id, u.original_name) };
    }),
    ...(m.reference_ids || []).map((id) => {
      const f = references[id];
      return { key: id, name: f?.original_name || 'Reference', role: 'Reference', open: () => openFile(id, f?.original_name) };
    }),
  ];
  const text = m.content || (m.parts || []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
      {chips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: '85%' }}>
          {chips.map((c) => {
            const [, fg, bg] = KIND[kindOf(c.name)];
            return (
              <button key={c.key} type="button" onClick={c.open} className="hv-line"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 8px 8px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', font: 'inherit', color: 'var(--ink)', cursor: 'pointer', textAlign: 'left', minWidth: 0, maxWidth: '100%' }}>
                <span style={{ width: 30, height: 34, flex: 'none', borderRadius: 5, background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 8.5, fontWeight: 600 }}>{kindLabel(c.name)}</span>
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--ink3)' }}>{c.role}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {text && (
        <div style={{ maxWidth: '85%', background: 'var(--bubble)', borderRadius: 18, padding: '10px 16px', fontSize: 15, lineHeight: 1.55, whiteSpace: 'pre-wrap', textWrap: 'pretty', overflowWrap: 'anywhere' } as React.CSSProperties}>{text}</div>
      )}
    </div>
  );
}

/** Plain text of an answer (Copy). */
function plainText(parts: Part[]): string {
  return partsToParas(parts)
    .map((p) => p.items.map((x) => (x.k === 'text' || x.k === 'bold' ? x.t : x.k === 'row' ? (x.sheet ? `${x.sheet} row ${x.row}` : `row ${x.row}`) : x.name)).join(''))
    .join('\n\n');
}

export function AgentMessage({ m, cards, steps, latestDocId, onRetry, showFooter = true, quiet }: {
  m: ChatMessage;
  cards: Card[];
  /** The working-steps block of this message's run segment, if any. */
  steps?: ReactNode;
  latestDocId?: string;
  onRetry?: () => void;
  showFooter?: boolean;
  /** The run's live activity line is showing (thinking / searching): no extra "Writing…" placeholder. */
  quiet?: boolean;
}) {
  const { files } = useChat();
  const [copied, setCopied] = useState(false);
  const parts: Part[] = m.parts || [];
  const textParts: Part[] = m.streaming
    ? streamingParts(m.content || '', latestDocId, (id) => files[id]?.original_name)
    : parts.some((p) => p.type === 'text' || p.type === 'chip') ? parts.filter((p) => p.type === 'text' || p.type === 'chip')
    : m.content ? [{ type: 'text', text: m.content }] : [];
  const hasText = partsToParas(textParts).length > 0;
  const tok = m.tokens || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 15, lineHeight: 1.65, minWidth: 0 }}>
      {steps}
      {hasText && (m.streaming ? <div className={css.streaming} aria-busy="true"><RichText parts={textParts} /></div> : <RichText parts={textParts} />)}
      {m.streaming && !hasText && !steps && !quiet && (
        <span role="status" aria-label="The agent is writing" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}>
          <span className={css.dots} aria-hidden><i /><i /><i /></span><span className={css.shimmer} style={{ fontWeight: 500 }}>Writing…</span>
        </span>
      )}
      {cards.map((c) => <InlineCard key={c.id} card={c} />)}
      {showFooter && !m.streaming && (hasText || cards.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: -4, fontSize: 12, color: 'var(--ink3)', lineHeight: 1 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', height: 26, paddingRight: 8 }}>
            <TierCost tier={m.tier} cost={m.cost_usd} tokensIn={tok.input ?? null} tokensOut={tok.output ?? null} />
          </span>
          <button type="button" className="hv-sunk hv-ink"
            onClick={() => {
              try { navigator.clipboard.writeText(plainText(textParts)); } catch {}
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            style={{ height: 26, padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--ink3)', font: 'inherit', cursor: 'pointer' }}>{copied ? 'Copied' : 'Copy'}</button>
          {onRetry && (
            <button type="button" className="hv-sunk hv-ink" onClick={onRetry}
              style={{ height: 26, padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--ink3)', font: 'inherit', cursor: 'pointer' }}>Retry</button>
          )}
        </div>
      )}
    </div>
  );
}

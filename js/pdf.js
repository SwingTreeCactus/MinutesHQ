/* Builds the minutes PDF on the tablet with jsPDF. Nothing leaves the device here. */
window.buildMinutesPDF = function (m) {
  const A = window.App;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 54, CW = W - 2 * M, FOOT = 36;
  let y = M;
  const INK = [28, 36, 48], MUTE = [91, 102, 117], LINE = [222, 227, 234], ACC = [15, 118, 110];
  const ensure = h => { if (y + h > H - M - FOOT / 2) { doc.addPage(); y = M; } };
  const text = (t, o = {}) => {
    if (!t) return;
    const { size = 10.5, style = 'normal', color = INK, indent = 0, gap = 4, lh = 1.4, width = CW - indent } = o;
    doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(String(t), width).forEach(l => { ensure(size * lh); doc.text(l, M + indent, y + size); y += size * lh; });
    y += gap;
  };
  const rule = (c = LINE, w = 0.75) => { doc.setDrawColor(...c); doc.setLineWidth(w); doc.line(M, y, W - M, y); };
  const label = (t, indent) => text(t.toUpperCase(), { size: 8, style: 'bold', color: MUTE, indent, gap: 1 });

  text(m.meta.title || 'Meeting Minutes', { size: 20, style: 'bold', gap: 2 });
  text([A.fmtLong(m.meta.date), m.meta.location].filter(Boolean).join('  ·  '), { size: 11, color: MUTE, gap: 2 });
  const start = m.meta.startTime ? A.fmtClock(m.meta.startTime) : (m.startedAt ? A.fmtTime(m.startedAt) : '');
  const who = (m.meta.closingPrayer || '').trim();
  const close = m.endedAt ? 'Closing prayer ' + A.fmtTime(m.endedAt) + (who ? ' — ' + who : '') : (who ? 'Closing prayer — ' + who : '');
  text([start && 'Start ' + start, close].filter(Boolean).join('  ·  '), { size: 10, color: MUTE, gap: 8 });
  if (m.present && m.present.length) text('Present: ' + m.present.join(', '), { size: 10, gap: 2 });
  y += 6; rule(ACC, 1.5); y += 16;

  if (m.summary) { text('Summary', { size: 13, style: 'bold', color: ACC, gap: 4 }); text(m.summary, { gap: 10 }); rule(); y += 14; }

  m.items.forEach((it, i) => {
    ensure(70);
    text(`${i + 1}.  ${it.title || 'Untitled item'}`, { size: 13, style: 'bold', gap: 2 });
    if (it.detail) text(it.detail, { size: 9.5, style: 'italic', color: MUTE, indent: 18, gap: 6 });
    let any = false;
    if (it.discussion && it.discussion.trim()) { any = true; label('Discussion', 18); text(it.discussion.trim(), { indent: 18, gap: 7 }); }
    if (it.decision && it.decision.trim()) { any = true; label('Decision', 18); text(it.decision.trim(), { indent: 18, style: 'bold', gap: 7 }); }
    if (it.followUp) {
      any = true; label('Follow-up', 18);
      text([it.task || it.title, (it.assignees && it.assignees.length ? it.assignees.join(', ') : 'Unassigned') + (it.due ? '  ·  due ' + A.fmtDate(it.due, { month: 'short', day: 'numeric', year: 'numeric' }) : '  ·  no due date')].join('\n'), { indent: 18, gap: 7 });
    }
    if (!any) text('No notes recorded.', { size: 9.5, color: MUTE, indent: 18, gap: 6 });
    y += 4; rule(); y += 14;
  });

  const acts = m.items.map((it, i) => ({ n: i + 1, ...it })).filter(it => it.followUp);
  if (acts.length) {
    ensure(80);
    text('Follow-ups', { size: 13, style: 'bold', color: ACC, gap: 6 });
    const cols = [{ w: CW - 250, h: 'Task' }, { w: 150, h: 'Assigned to' }, { w: 100, h: 'Due' }];
    const drawRow = (cells, head) => {
      doc.setFont('helvetica', head ? 'bold' : 'normal'); doc.setFontSize(head ? 9 : 10);
      const wrapped = cells.map((c, j) => doc.splitTextToSize(String(c || ''), cols[j].w - 12));
      const h = Math.max(...wrapped.map(w => w.length)) * 13 + 10; ensure(h);
      if (head) { doc.setFillColor(238, 241, 245); doc.rect(M, y, CW, h, 'F'); }
      doc.setTextColor(...(head ? MUTE : INK));
      let x = M; wrapped.forEach((w, j) => { w.forEach((l, k) => doc.text(l, x + 6, y + 15 + k * 13)); x += cols[j].w; });
      y += h; doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, y, W - M, y);
    };
    drawRow(cols.map(c => c.h), true);
    acts.forEach(a => drawRow([`${a.n}. ${a.task || a.title}`, (a.assignees || []).join(', ') || 'Unassigned', a.due ? A.fmtDate(a.due, { month: 'short', day: 'numeric', year: 'numeric' }) : '—']));
  }

  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTE);
    doc.text([m.meta.title || 'Meeting Minutes', A.fmtDate(m.meta.date)].filter(Boolean).join(' · '), M, H - FOOT);
    doc.text(`Page ${p} of ${n}`, W - M, H - FOOT, { align: 'right' });
  }
  return doc;
};

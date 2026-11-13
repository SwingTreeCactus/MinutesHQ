/* Builds the minutes PDF on the device with jsPDF. Nothing leaves the device here.
   Every style has the same sections in the same order; a style only changes type, color and heading treatment.
   Fonts are jsPDF's built-in ones (Helvetica, Times), so nothing extra is downloaded. */
window.PDF_STYLES = [['modern', 'Modern'], ['classic', 'Classic'], ['plain', 'Plain']];
window.buildMinutesPDF = function (m, styleName) {
  const A = window.App;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 54, CW = W - 2 * M, FOOT = 36;
  const ALL = {
    modern: { font: 'helvetica', ink: [28, 36, 48], mute: [91, 102, 117], line: [222, 227, 234], acc: [15, 118, 110],
      title: 17, center: false, sub: 'normal', rule: 'accent', label: 'caps', labelSize: 7.5, item: 12, section: 'accent', headFill: [238, 241, 245], body: 10.5 },
    classic: { font: 'times', ink: [17, 17, 17], mute: [68, 68, 68], line: [170, 170, 170], acc: [17, 17, 17],
      title: 19, center: true, sub: 'italic', rule: 'double', label: 'italic', labelSize: 11, item: 12.5, section: 'centered', headFill: null, body: 11.5 },
    plain: { font: 'helvetica', ink: [0, 0, 0], mute: [68, 68, 68], line: [190, 190, 190], acc: [0, 0, 0],
      title: 16, center: false, sub: 'normal', rule: 'thin', label: 'bold', labelSize: 10, item: 11.5, section: 'plain', headFill: null, body: 10.5 }
  };
  const st = ALL[styleName] || ALL.modern;
  const F = st.font, INK = st.ink, MUTE = st.mute, LINE = st.line, ACC = st.acc, IND = 18;
  let y = M;

  const ensure = h => { if (y + h > H - M - FOOT / 2) { doc.addPage(); y = M; } };
  const text = (t, o = {}) => {
    if (!t) return;
    const { size = st.body, style = 'normal', color = INK, indent = 0, gap = 3, lh = 1.32, center = false, width = CW - indent } = o;
    doc.setFont(F, style); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(String(t), width).forEach(l => {
      ensure(size * lh);
      if (center) doc.text(l, W / 2, y + size, { align: 'center' }); else doc.text(l, M + indent, y + size);
      y += size * lh;
    });
    y += gap;
  };
  const line = (c, w) => { doc.setDrawColor(...c); doc.setLineWidth(w); doc.line(M, y, W - M, y); };
  /* a label run in at the start of its text: "DISCUSSION  Q3 came in…" (wrapped lines align under the text) */
  const runIn = (t, body, o = {}) => {
    if (!body) return;
    const lab = st.label === 'caps' ? t.toUpperCase() : st.label === 'italic' ? t + '.' : t + ':';
    const ls = st.label === 'caps' ? 'bold' : st.label === 'italic' ? 'italic' : 'bold';
    doc.setFont(F, ls); doc.setFontSize(st.labelSize);
    const lw = doc.getTextWidth(lab) + 6, size = st.body, lh = size * 1.32;
    doc.setFont(F, o.style || 'normal'); doc.setFontSize(size);
    const lines = doc.splitTextToSize(String(body), CW - IND - lw);
    ensure(lh);
    doc.setFont(F, ls); doc.setFontSize(st.labelSize); doc.setTextColor(...(st.label === 'bold' ? INK : MUTE));
    doc.text(lab, M + IND, y + size);
    doc.setFont(F, o.style || 'normal'); doc.setFontSize(size); doc.setTextColor(...INK);
    lines.forEach((l, k) => { if (k) ensure(lh); doc.text(l, M + IND + lw, y + size); y += lh; });
    y += o.gap == null ? 3 : o.gap;
  };
  const section = t => {
    if (st.section === 'centered') return text(t.toUpperCase(), { size: 12, style: 'bold', center: true, gap: 8 });
    if (st.section === 'accent') return text(t, { size: 13, style: 'bold', color: ACC, gap: 6 });
    return text(t, { size: 12, style: 'bold', gap: 6 });
  };
  const fmtDue = d => A.fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });

  /* header */
  text(m.meta.title || 'Meeting Minutes', { size: st.title, style: 'bold', center: st.center, gap: 1 });
  text([A.fmtLong(m.meta.date), m.meta.location].filter(Boolean).join('  ·  '), { size: 10, style: st.sub, color: MUTE, center: st.center, gap: 0 });
  const start = m.meta.startTime ? A.fmtClock(m.meta.startTime) : (m.startedAt ? A.fmtTime(m.startedAt) : '');
  const who = (m.meta.closingPrayer || '').trim();
  const close = m.endedAt ? 'Closing prayer ' + A.fmtTime(m.endedAt) + (who ? ' — ' + who : '') : (who ? 'Closing prayer — ' + who : '');
  const opener = (m.meta.openingPrayer || '').trim();
  text([start && 'Start ' + start, opener && 'Opening prayer — ' + opener, close].filter(Boolean).join('  ·  '), { size: 9.5, color: MUTE, center: st.center, gap: 0 });
  if (m.present && m.present.length) text('Present: ' + m.present.join(', '), { size: 9.5, center: st.center, gap: 0 });
  y += 5;
  if (st.rule === 'double') { line(INK, 0.9); y += 2.5; line(INK, 0.9); y += 12; }
  else if (st.rule === 'thin') { line(INK, 0.75); y += 11; }
  else { line(ACC, 1.5); y += 11; }

  if (m.summary) { section('Summary'); text(m.summary, { gap: 6 }); if (st.rule === 'accent') { line(LINE, 0.5); y += 9; } else y += 4; }

  /* agenda items */
  m.items.forEach((it, i) => {
    ensure(st.item * 1.32 + st.body * 1.32 * 2);
    text(`${i + 1}.  ${it.title || 'Untitled item'}`, { size: st.item, style: 'bold', gap: 1 });
    if (it.detail) text(it.detail, { size: st.body - 1, style: 'italic', color: MUTE, indent: IND, gap: 2 });
    let any = false;
    if (it.discussion && it.discussion.trim()) { any = true; runIn('Discussion', it.discussion.trim()); }
    if (it.decision && it.decision.trim()) { any = true; runIn('Decision', it.decision.trim(), { style: st.label === 'bold' ? 'normal' : 'bold' }); }
    if (it.followUp) {
      any = true;
      runIn('Follow-up', (it.task || it.title) + ' — ' + (it.assignees && it.assignees.length ? it.assignees.join(', ') : 'unassigned') + (it.due ? ', due ' + fmtDue(it.due) : ', no due date'));
    }
    if (!any) text('No notes recorded.', { size: st.body - 1, color: MUTE, indent: IND, gap: 2 });
    y += 3;
    if (st.rule === 'accent') { line(LINE, 0.6); y += 9; } else y += 6;
  });

  /* follow-ups table */
  const acts = m.items.map((it, i) => ({ n: i + 1, ...it })).filter(it => it.followUp);
  if (acts.length) {
    const need = 30 + 23 * (acts.length + 1);
    if (y + Math.min(need, 200) > H - M - FOOT / 2) { doc.addPage(); y = M; } else y += 4;
    section('Follow-ups');
    const cols = [{ w: CW - 250, h: 'Task' }, { w: 150, h: 'Assigned to' }, { w: 100, h: 'Due' }];
    const drawRow = (cells, head) => {
      doc.setFont(F, head ? 'bold' : 'normal'); doc.setFontSize(head ? 9.5 : st.body - 0.5);
      const wrapped = cells.map((c, j) => doc.splitTextToSize(String(c || ''), cols[j].w - 12));
      const h = Math.max(...wrapped.map(w => w.length)) * 13 + 10; ensure(h);
      if (head && st.headFill) { doc.setFillColor(...st.headFill); doc.rect(M, y, CW, h, 'F'); }
      doc.setTextColor(...(head && st.headFill ? MUTE : INK));
      let x = M; wrapped.forEach((w, j) => { w.forEach((l, k) => doc.text(l, x + 6, y + 15 + k * 13)); x += cols[j].w; });
      y += h;
      if (head && !st.headFill) { doc.setDrawColor(...INK); doc.setLineWidth(0.9); } else { doc.setDrawColor(...LINE); doc.setLineWidth(0.5); }
      doc.line(M, y, W - M, y);
    };
    drawRow(cols.map(c => c.h), true);
    acts.forEach(a => drawRow([`${a.n}. ${a.task || a.title}`, (a.assignees || []).join(', ') || 'Unassigned', a.due ? fmtDue(a.due) : '—']));
  }

  /* footer */
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); doc.setFont(F, 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTE);
    doc.text([m.meta.title || 'Meeting Minutes', A.fmtDate(m.meta.date)].filter(Boolean).join(' · '), M, H - FOOT);
    doc.text(`Page ${p} of ${n}`, W - M, H - FOOT, { align: 'right' });
  }
  return doc;
};

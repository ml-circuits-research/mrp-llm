export const CSS = `
.dg-wrap{overflow-x:auto;border:1px solid #cdd9e2;border-radius:8px}
.dgfig{margin:1.2rem 0}
.dgfig figcaption{font-style:italic;text-align:center;margin-top:.4rem}
svg.dg{display:block;min-width:760px;max-width:1100px;width:100%;height:auto;font-family:system-ui,sans-serif;
 --bg:#f7fafc;--zone:#edf2f6;--zone-model:#fbf0e0;--zone-fence:#fbe9e7;--zone-out:#f1f3f5;--box:#ffffff;--box-model:#fff8ec;--box-fence:#fff3f1;--box-tool:#f3f0fa;--box-disk:#eef6ee;--box-wip:#fffdf0;--line:#3d566b;--text:#15283a;--muted:#4f6377;--accent:#0f5f8a;--warn:#a8480f}
@media (prefers-color-scheme:dark){svg.dg{--bg:#12171c;--zone:#1a222a;--zone-model:#2a2218;--zone-fence:#2c1c1b;--zone-out:#171d23;--box:#222c35;--box-model:#31281b;--box-fence:#35211f;--box-tool:#2a2638;--box-disk:#1f2d23;--box-wip:#332f18;--line:#93a8ba;--text:#e6edf3;--muted:#a3b2bf;--accent:#74bde6;--warn:#eba070}}
svg.dg .bgr{fill:var(--bg)}
svg.dg .zone{fill:var(--zone);stroke:var(--line);stroke-width:1;stroke-opacity:.5}
svg.dg .z-model{fill:var(--zone-model)} svg.dg .z-fence{fill:var(--zone-fence);stroke:var(--warn);stroke-dasharray:6 3;stroke-opacity:.9} svg.dg .z-out{fill:var(--zone-out)}
svg.dg .zlabel{fill:var(--muted);font-size:12px;font-weight:600}
svg.dg .node rect{fill:var(--box);stroke:var(--line);stroke-width:1.2}
svg.dg .n-model rect{fill:var(--box-model)} svg.dg .n-fence rect{fill:var(--box-fence);stroke:var(--warn)} svg.dg .n-tool rect{fill:var(--box-tool)} svg.dg .n-disk rect{fill:var(--box-disk)}
svg.dg .n-out rect{fill:var(--box);stroke-dasharray:2 3}
svg.dg .n-gate rect{fill:var(--box);stroke:var(--accent);stroke-width:2.4}
svg.dg .n-wip rect{fill:var(--box-wip);stroke:var(--warn);stroke-width:1.6;stroke-dasharray:7 4}
svg.dg .nt{fill:var(--text);font-size:13px;font-weight:700}
svg.dg .nl{fill:var(--text);font-size:11.5px} svg.dg .nl.muted{fill:var(--muted);font-style:italic}
svg.dg .tl{fill:var(--muted);font-size:11.5px}
svg.dg .edge{fill:none;stroke:var(--line);stroke-width:1.5} svg.dg .edge.dashed{stroke-dasharray:5 4}
svg.dg .ahead{fill:var(--line)}
svg.dg .elabel{fill:var(--muted);font-size:11px;font-style:italic}
svg.dg .boundary{stroke:var(--accent);stroke-width:2.2;stroke-dasharray:3 4}
svg.dg .blabel{fill:var(--accent);font-size:11.5px;font-weight:600}
svg.dg .badge circle{fill:var(--accent)} svg.dg .badge text{fill:var(--bg);font-size:11.5px;font-weight:700}
`;

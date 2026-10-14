/** Stylesheet of the chat page (DS009 "The chat page"): the shell with three vertical tabs, the conversation, the settings cards and the
 * base memory table. Colours come from the shared tokens of server/pages/layout.mjs (light and dark); spacing follows an 8 px grid. */
export const CHAT_STYLE = `
html,body{height:100%}
body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.site-header{flex:none;position:relative;z-index:50}
.app{flex:1;min-height:0;display:grid;grid-template-columns:200px minmax(0,1fr)}
.app>.notice{grid-column:1/-1;margin:8px 16px 0}
.tabs{display:flex;flex-direction:column;gap:4px;padding:16px 8px;border-right:1px solid var(--line);background:var(--panel);overflow-y:auto}
.tab{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;color:var(--muted);padding:8px 16px;border-radius:8px;font-weight:500;cursor:pointer}
.tab svg{width:20px;height:20px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tab:hover{background:var(--soft);color:var(--text)}
.tab[aria-selected=true]{background:var(--soft);color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.tab:focus-visible,.icon-btn:focus-visible,.pill-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.panel{min-width:0;min-height:0;display:flex;flex-direction:column}
.panel[hidden]{display:none}
.scroll-panel{overflow-y:auto;padding:24px}
.scroll-panel>.inner{max-width:880px;width:100%;margin:0 auto}
.scroll-panel h2{margin:0 0 8px;font-size:1.25rem}
.lead{color:var(--muted);font-size:14px;margin:0 0 16px}

/* chat tab */
.chat-head{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:8px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
.chat-head .info{flex:1 1 240px;min-width:0;font-size:14px;overflow-wrap:anywhere}
.chat-head .info b{font-weight:600}
.chat-head .btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chat-head button,.chat-head select{padding:4px 12px;font-size:13px}
.chat-head select{max-width:180px}
.log-wrap{position:relative;flex:1;min-height:0;display:flex}
#log{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:12px;padding:16px 24px;scroll-behavior:auto}
#log>:first-child{margin-top:auto}
.pill-btn{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);border-radius:16px;padding:4px 16px;font-size:13px;background:var(--accent);border-color:var(--accent);color:var(--accent-text);box-shadow:0 2px 8px rgba(0,0,0,.25);z-index:5}
.pill-btn[hidden]{display:none}
.empty{color:var(--muted);text-align:center;margin:auto;max-width:480px}
.msg{max-width:80%;padding:8px 16px;border-radius:16px;border:1px solid var(--line);background:var(--panel);white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.msg.user{align-self:flex-end;background:var(--soft);border-bottom-right-radius:4px}
.msg.assistant{align-self:flex-start;border-bottom-left-radius:4px}
.msg.muted{color:var(--muted);font-style:italic}
.msg.error{border-color:var(--bad)}
.msg.wide{max-width:100%}
.msg .meta{font-size:12px;color:var(--muted);margin-top:4px;white-space:normal}
.msg details{margin-top:4px;white-space:normal}.msg summary{cursor:pointer;color:var(--accent);font-size:13px}
.msg dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 8px;margin:4px 0;font-size:13px}.msg dt{color:var(--muted)}.msg dd{margin:0;overflow-wrap:anywhere}
.msg mark{background:rgba(232,170,40,.38);color:inherit;border-radius:3px;padding:0 1px}
.msg .pending{margin-top:4px}
.composer-wrap{flex:none;padding:8px 24px 16px;background:var(--bg)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}
.chips:empty{display:none}
.chip{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--soft);border-radius:14px;padding:0 4px 0 12px;font-size:13px;max-width:100%}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.chip button{padding:0 8px;border-radius:12px;font-size:14px;line-height:1.4}
.composer{display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:8px}
.composer:focus-within{border-color:var(--accent)}
.composer textarea{flex:1;min-width:0;border:0;background:transparent;resize:none;padding:8px;line-height:24px;height:40px;max-height:136px;outline:0}
.icon-btn{flex:none;width:40px;height:40px;padding:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center}
.icon-btn svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.busy{display:flex;align-items:center;gap:8px;margin:0 8px 8px;font-size:13px;color:var(--muted)}
.busy[hidden]{display:none}
.spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
.composer.busy{background:var(--soft)}
.composer textarea:disabled,.composer button:disabled{cursor:not-allowed}
.composer-hint{font-size:12px;color:var(--muted);margin:4px 8px 0}

/* notes, cards of the coding agent */
.agent-msg{border-color:var(--ok);max-width:100%;align-self:stretch;white-space:normal}
.agent-msg .head{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;font-weight:600}
.agent-msg .status{font-size:13px;color:var(--muted);margin:4px 0}
.agent-msg pre,dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:8px;max-height:240px;overflow:auto;margin:8px 0}
.agent-msg .note{font-size:13px;color:var(--muted);margin:8px 0 0}
.agent-msg ul{margin:4px 0 4px 16px;padding:0;font-size:13px}
.agent-msg .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.agent-msg fieldset,dialog fieldset{border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:8px 16px 16px;min-width:0}
legend{font-size:13px;color:var(--muted);padding:0 4px}
.pill{display:inline-block;font-size:11px;line-height:1.6;padding:0 8px;border-radius:9px;border:1px solid var(--line);color:var(--muted);white-space:nowrap;margin-left:4px}
.pill.ok{border-color:var(--ok);color:var(--ok)}.pill.warn{border-color:var(--bad);color:var(--bad)}.pill.accent{border-color:var(--accent);color:var(--accent)}

/* settings tab */
.card.set{padding:16px 24px;margin:0 0 16px;border-radius:12px}
.card.set h3{margin:0 0 4px;font-size:1rem}
.card.set>p.help{margin:0 0 8px;color:var(--muted);font-size:13px}
.srow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;padding:8px 0;border-top:1px solid var(--line)}
.srow:first-of-type{border-top:0}
.srow .what{flex:1 1 280px;min-width:0}
.srow .what b{display:block;font-weight:600}
.srow .what span{display:block;font-size:13px;color:var(--muted)}
.srow .ctl{flex:0 1 280px;min-width:0;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.srow .ctl select,.srow .ctl input[type=search]{flex:1 1 160px;min-width:0}
.srow input[type=checkbox]{width:20px;height:20px;accent-color:var(--accent)}
.srow.sub{padding-left:24px}
.srow label,label.plain{margin:0;font-weight:inherit}
.state{font-size:13px;color:var(--muted)}.state.ok{color:var(--ok)}.state.bad{color:var(--bad)}
.hint-note{font-size:12px;color:var(--muted);margin:8px 0 0}

/* base memory tab */
.mem-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin:0 0 16px}
.mem-top .spacer{flex:1}
table.mem{width:100%;border-collapse:separate;border-spacing:0;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden;font-size:14px}
table.mem th{text-align:left;font-weight:600;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:8px 16px;background:var(--soft);border-bottom:1px solid var(--line)}
table.mem td{padding:8px 16px;border-top:1px solid var(--line);vertical-align:middle;overflow-wrap:anywhere}
table.mem tbody tr:first-child td{border-top:0}
table.mem td.name{font-weight:600}
table.mem td[data-l=Strategy],table.mem td[data-l=Created]{white-space:nowrap}
table.mem td.acts{white-space:nowrap}
table.mem td.acts button{padding:4px 8px;font-size:12px;margin:0 4px 4px 0}
table.mem tr.current td.name:after{content:' (this session)';font-weight:400;color:var(--ok);font-size:12px}
.msgline{font-size:13px;margin:8px 0;overflow-wrap:anywhere}.msgline.bad{color:var(--bad)}.msgline.ok{color:var(--ok)}
ul.problems{margin:4px 0 4px 16px;padding:0;font-size:13px}

/* dialogs */
dialog{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:16px 24px;width:min(720px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}
dialog::backdrop{background:rgba(0,0,0,.45)}
dialog h2{margin:0 0 8px;font-size:1.1rem}
dialog .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
dialog .row label{margin:0;font-size:13px;color:var(--muted);font-weight:500}
dialog .row input[type=text],dialog .row select{flex:1 1 180px;min-width:0}
dialog textarea{width:100%;min-height:128px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
dialog .actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:16px}
dialog dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:8px 0;font-size:13px}dialog dt{color:var(--muted)}dialog dd{margin:0;overflow-wrap:anywhere}
/* answer feedback: thumbs up and down under an answered turn, and the cause dialog */
.fb{display:flex;gap:4px;align-items:center;margin-top:4px;white-space:normal}
.fb button{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;padding:4px;border-radius:8px;background:transparent;border:1px solid transparent;color:var(--muted);cursor:pointer}
.fb button:hover{border-color:var(--line);color:var(--text)}
.fb button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);background:var(--soft)}
.fb svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.fb .fb-note{font-size:12px;color:var(--muted)}
#fb-dialog{width:min(480px,calc(100vw - 24px))}
#fb-dialog fieldset label{display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:14px;font-weight:400;color:var(--text)}
#fb-dialog fieldset input{margin-top:3px;flex:none}
#fb-dialog textarea{min-height:72px;font-family:inherit;font-size:14px}

@media (max-width:760px){
 .app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
 .tabs{flex-direction:row;justify-content:space-around;gap:4px;padding:4px 8px;border-right:0;border-bottom:1px solid var(--line);overflow:visible}
 .tab{flex:1 1 0;flex-direction:column;gap:0;padding:4px;font-size:12px;justify-content:center;text-align:center}
 .tab[aria-selected=true]{box-shadow:inset 0 -3px 0 var(--accent)}
 .scroll-panel{padding:16px}
 .chat-head{padding:8px 16px}
 #log{padding:16px}
 .composer-wrap{padding:8px 8px 8px}
 .review{margin:0 8px 8px}
 .msg{max-width:94%}
 .srow.sub{padding-left:0}
 .card.set{padding:16px}
 table.mem,table.mem tbody,table.mem tr,table.mem td{display:block}
 table.mem thead{display:none}
 table.mem tr{padding:8px 0;border-top:1px solid var(--line)}
 table.mem tbody tr:first-child{border-top:0}
 table.mem td{border:0;padding:4px 16px;display:flex;gap:8px}
 table.mem td:before{content:attr(data-l);flex:0 0 72px;color:var(--muted);font-size:12px}
 table.mem td.name:before{content:''}
 table.mem td.name{display:block}
 table.mem td.acts{flex-wrap:wrap;white-space:normal}
 table.mem td.acts:before{display:none}
 table.mem td.acts button{flex:none}
 dialog{padding:16px}
 .composer-hint{display:none}
}
/* trace sections (pipeline order) and the server status card */
.trace .tsec{margin:4px 0 4px 10px}
.trace .tsec>summary{font-weight:600;cursor:pointer}
.trace .tsec .actions{display:flex;gap:8px;align-items:center;margin:6px 0}
#status-box h4{margin:14px 0 6px;font-size:14px}
`;

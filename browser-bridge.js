/* Installed before Studio evaluates its host contract; no model runtime or second chat. */
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('harness');
  if (!token || globalThis.openfilmHost) return;
  const endpoint = `${globalThis.__OPENFILM_BRIDGE_ORIGIN__}/page`;
  const pageId = crypto.randomUUID();
  let selection;
  let commandListener;
  let ack;
  let busy = false;
  let mounted = false;
  let count = 0;
  let label;
  let lastSelection;
  const executed = new Set();
  function status(text) { if (label) label.textContent = text; }
  async function send(reference) {
    if (busy) return false;
    busy = true;
    const snapshot = selection ? JSON.stringify(selection) : undefined;
    try {
      const response = await fetch(endpoint, { method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ pageId, ...(snapshot && (snapshot !== lastSelection || reference) ? { selection } : {}),
          ...(reference ? { reference } : {}), ...(ack ? { ack } : {}) }) });
      const result = await response.json();
      if (!response.ok) {
        status(result.code === 'EDITOR_ALREADY_OPEN' ? '请使用已打开的编辑器标签页' : result.code === 'PROJECT_MISMATCH' ? '当前工程未绑定，请从聊天重新打开' : '连接已断开，请从聊天重新打开');
        return false;
      }
      lastSelection = snapshot; ack = undefined;
      count = result.referenceCount;
      status(`${result.binding.harness} · ${count ? `${count} 条引用待助手读取` : '已连接'}`);
      const pending = result.command;
      if (pending && commandListener) {
        if (!executed.has(pending.id)) {
          try { commandListener(pending.command); executed.add(pending.id); ack = { id: pending.id, ok: true }; }
          catch { ack = { id: pending.id, ok: false }; }
        } else ack = { id: pending.id, ok: true };
      }
      return true;
    } catch { status('连接已断开，请从聊天重新打开'); return false; }
    finally { busy = false; }
  }
  // User references are serialized and never silently dropped behind a heartbeat.
  let referenceTurn = Promise.resolve();
  function refer(reference) {
    referenceTurn = referenceTurn.then(async () => {
      while (busy) await new Promise((done) => setTimeout(done, 30));
      await send(reference);
    });
  }
  globalThis.openfilmHost = {
    version: 1, name: 'Harness',
    refer,
    onSelection(next) { selection = next; },
    onCommand(listener) { commandListener = listener; },
  };
  function mount() {
    if (mounted) return; mounted = true;
    const bar = document.createElement('div');
    bar.dataset.studioHostPanel = '';
    bar.setAttribute('aria-label', 'Agent 编辑器连接');
    Object.assign(bar.style, { position: 'fixed', right: '16px', bottom: '12px', zIndex: '1000', display: 'flex',
      alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '10px',
      background: 'var(--bg-panel, #202124)', color: 'var(--text, #eee)', border: '1px solid var(--border, #666)',
      font: '12px system-ui', boxShadow: '0 2px 10px #0003' });
    label = document.createElement('span'); label.setAttribute('role', 'status');
    label.textContent = '正在连接 Agent'; bar.append(label);
    for (const [text, act] of [
      ['引用所选', () => { if (selection) for (const ref of selection.refs.length ? selection.refs : [{ kind: 'time', time: selection.time }]) refer(ref); }],
      ['复制上下文', async () => {
        if (!selection) return;
        try { await navigator.clipboard.writeText(`请读取 OpenFilm 当前工程与选区后继续：\n${JSON.stringify(selection)}`); status('已复制，可粘贴到当前聊天'); }
        catch { status('复制失败，可让助手读取当前编辑器状态'); }
      }],
    ]) {
      const button = document.createElement('button'); button.textContent = text; button.type = 'button';
      Object.assign(button.style, { color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer' });
      button.addEventListener('click', act); bar.append(button);
    }
    document.body.append(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  setInterval(() => void send(), 700);
})();
